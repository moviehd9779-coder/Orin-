import express from 'express';
import type { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';

type OriginType = 'local-ffmpeg' | 'external-hls';
type LocalSignalPattern = 'testsrc2' | 'smptebars' | 'mandelbrot';

interface ChannelRecord {
  id: string;
  name: string;
  type: OriginType;
  sourceUrl: string;
  signalPattern?: LocalSignalPattern;
  status: 'live' | 'starting' | 'stopped' | 'error';
  errorMessage?: string;
  originShield: boolean;
  manifestTtlMs: number;
  segmentTtlMs: number;
  createdAt: string;
  variants: {
    label: string;
    resolution: string;
    bitrateKbps: number;
  }[];
}

interface EdgePopRecord {
  id: string;
  city: string;
  region: string;
  countryCode: string;
  baseLatencyMs: number;
  coords: { x: number; y: number };
  hits: number;
  shieldHits: number;
  misses: number;
  bytesServed: number;
  lastActiveAt: string | null;
}

interface CacheEntry {
  key: string;
  popId: string;
  channelId: string;
  body: Buffer;
  contentType: string;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
}

interface DeliveryLogEntry {
  id: string;
  timestamp: string;
  popId: string;
  channelId: string;
  asset: string;
  cacheStatus: 'HIT' | 'SHIELD-HIT' | 'MISS';
  statusCode: number;
  latencyMs: number;
  bytes: number;
}

const PORT = Number(process.env.PORT || 3000);
const HLS_BASE_DIR = path.resolve('/tmp/orin-hls');
const MAX_CACHE_BYTES = 96 * 1024 * 1024; // 96 MB LRU cache limit
const MAX_CACHE_ENTRIES = 240;
const MAX_EXTERNAL_FETCH_BYTES = 24 * 1024 * 1024;
const VALID_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

fs.mkdirSync(HLS_BASE_DIR, { recursive: true });

const pops: EdgePopRecord[] = [
  { id: 'iad-01', city: 'Ashburn', region: 'US East', countryCode: 'US', baseLatencyMs: 14, coords: { x: 278, y: 184 }, hits: 0, shieldHits: 0, misses: 0, bytesServed: 0, lastActiveAt: null },
  { id: 'sjc-02', city: 'San Jose', region: 'US West', countryCode: 'US', baseLatencyMs: 56, coords: { x: 162, y: 188 }, hits: 0, shieldHits: 0, misses: 0, bytesServed: 0, lastActiveAt: null },
  { id: 'gru-01', city: 'São Paulo', region: 'South America', countryCode: 'BR', baseLatencyMs: 118, coords: { x: 344, y: 342 }, hits: 0, shieldHits: 0, misses: 0, bytesServed: 0, lastActiveAt: null },
  { id: 'lhr-01', city: 'London', region: 'Europe West', countryCode: 'GB', baseLatencyMs: 74, coords: { x: 472, y: 142 }, hits: 0, shieldHits: 0, misses: 0, bytesServed: 0, lastActiveAt: null },
  { id: 'fra-01', city: 'Frankfurt', region: 'Europe Central', countryCode: 'DE', baseLatencyMs: 82, coords: { x: 506, y: 148 }, hits: 0, shieldHits: 0, misses: 0, bytesServed: 0, lastActiveAt: null },
  { id: 'sin-01', city: 'Singapore', region: 'Asia South', countryCode: 'SG', baseLatencyMs: 146, coords: { x: 760, y: 274 }, hits: 0, shieldHits: 0, misses: 0, bytesServed: 0, lastActiveAt: null },
  { id: 'nrt-01', city: 'Tokyo', region: 'Asia East', countryCode: 'JP', baseLatencyMs: 112, coords: { x: 842, y: 186 }, hits: 0, shieldHits: 0, misses: 0, bytesServed: 0, lastActiveAt: null },
  { id: 'syd-01', city: 'Sydney', region: 'Oceania', countryCode: 'AU', baseLatencyMs: 168, coords: { x: 866, y: 368 }, hits: 0, shieldHits: 0, misses: 0, bytesServed: 0, lastActiveAt: null },
];

const popMap = new Map<string, EdgePopRecord>(pops.map((p) => [p.id, p]));

const channels = new Map<string, ChannelRecord>();
const ffmpegProcesses = new Map<string, ChildProcess>();
const edgeCache = new Map<string, CacheEntry>();
const deliveryLogs: DeliveryLogEntry[] = [];

let totalCacheBytes = 0;
let totalRequests = 0;
let totalEdgeHits = 0;
let totalShieldHits = 0;
let totalOriginFetches = 0;
let totalBytesServed = 0;

function isPrivateOrBlockedIp(ip: string): boolean {
  const cleanIp = ip.toLowerCase();
  if (cleanIp.startsWith('::ffff:')) {
    return isPrivateOrBlockedIp(cleanIp.slice(7));
  }
  if (net.isIPv4(cleanIp)) {
    const parts = cleanIp.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast & reserved
    return false;
  }
  if (net.isIPv6(cleanIp)) {
    if (cleanIp === '::' || cleanIp === '::1') return true;
    if (cleanIp.startsWith('fe80:') || cleanIp.startsWith('fc') || cleanIp.startsWith('fd')) return true;
    if (cleanIp.startsWith('ff')) return true;
    return false;
  }
  return true;
}

async function validateSafeExternalUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid origin URL format.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Origin URL must use http:// or https:// protocol.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Origin URL must not include embedded credentials.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Loopback and internal hostnames are not permitted.');
  }
  if (net.isIP(hostname)) {
    if (isPrivateOrBlockedIp(hostname)) {
      throw new Error('Private or reserved IP addresses are not permitted.');
    }
    return parsed;
  }
  const records = await dns.lookup(hostname, { all: true });
  if (!records.length) {
    throw new Error('Could not resolve origin hostname.');
  }
  for (const rec of records) {
    if (isPrivateOrBlockedIp(rec.address)) {
      throw new Error('Origin hostname resolves to a private or restricted IP address.');
    }
  }
  return parsed;
}

async function safeFetchExternal(rawUrl: string): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    const validated = await validateSafeExternalUrl(currentUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      const resp = await fetch(validated.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Orin-CDN-Origin-Fetcher/1.0',
        },
      });
      clearTimeout(timeout);

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) {
          throw new Error(`Upstream redirect (${resp.status}) missing Location header.`);
        }
        currentUrl = new URL(location, validated).toString();
        continue;
      }

      if (!resp.ok) {
        throw new Error(`Upstream origin returned HTTP ${resp.status}.`);
      }

      const contentLength = Number(resp.headers.get('content-length') || '0');
      if (contentLength > MAX_EXTERNAL_FETCH_BYTES) {
        throw new Error('Upstream media segment exceeds 24 MB safety limit.');
      }

      const arrayBuf = await resp.arrayBuffer();
      if (arrayBuf.byteLength > MAX_EXTERNAL_FETCH_BYTES) {
        throw new Error('Upstream media segment exceeds 24 MB safety limit.');
      }

      return {
        buffer: Buffer.from(arrayBuf),
        contentType: resp.headers.get('content-type') || 'application/octet-stream',
        finalUrl: validated.toString(),
      };
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }
  throw new Error('Too many upstream redirects.');
}

function getChannelDir(channelId: string): string {
  const resolved = path.resolve(HLS_BASE_DIR, channelId);
  if (!resolved.startsWith(HLS_BASE_DIR + path.sep)) {
    throw new Error('Invalid channel path.');
  }
  return resolved;
}

function stopLocalEncoder(channelId: string): void {
  const proc = ffmpegProcesses.get(channelId);
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
    ffmpegProcesses.delete(channelId);
  }
  const ch = channels.get(channelId);
  if (ch && ch.type === 'local-ffmpeg') {
    ch.status = 'stopped';
  }
}

function startLocalEncoder(channel: ChannelRecord): void {
  stopLocalEncoder(channel.id);

  const channelDir = getChannelDir(channel.id);
  fs.rmSync(channelDir, { recursive: true, force: true });
  for (const v of ['v0', 'v1', 'v2']) {
    fs.mkdirSync(path.join(channelDir, v), { recursive: true });
  }

  channel.status = 'starting';
  channel.errorMessage = undefined;

  const pattern = channel.signalPattern || 'testsrc2';
  const videoInput =
    pattern === 'smptebars'
      ? 'smptehdbars=size=1280x720:rate=25'
      : pattern === 'mandelbrot'
        ? 'mandelbrot=size=1280x720:rate=25'
        : 'testsrc2=size=1280x720:rate=25';

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-re',
    '-f', 'lavfi', '-i', videoInput,
    '-f', 'lavfi', '-i', 'sine=frequency=440:beep_factor=4:sample_rate=48000',
    '-filter_complex',
    '[0:v]split=3[v0][v1in][v2in];[v1in]scale=854:480[v1];[v2in]scale=640:360[v2];[1:a]volume=0.05,asplit=3[a0][a1][a2]',
    '-map', '[v0]', '-map', '[a0]',
    '-map', '[v1]', '-map', '[a1]',
    '-map', '[v2]', '-map', '[a2]',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-g', '50',
    '-keyint_min', '50',
    '-sc_threshold', '0',
    '-b:v:0', '1600k', '-maxrate:v:0', '1800k', '-bufsize:v:0', '3200k',
    '-b:v:1', '850k', '-maxrate:v:1', '950k', '-bufsize:v:1', '1700k',
    '-b:v:2', '420k', '-maxrate:v:2', '500k', '-bufsize:v:2', '840k',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ac', '2',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', 'v:0,a:0 v:1,a:1 v:2,a:2',
    '-hls_segment_filename', path.join(channelDir, 'v%v', 'seg_%05d.ts'),
    path.join(channelDir, 'v%v', 'prog.m3u8'),
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  ffmpegProcesses.set(channel.id, proc);

  let stderrBuf = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString()).slice(-1200);
  });

  // Poll briefly for master.m3u8 readiness
  const pollInterval = setInterval(() => {
    if (!ffmpegProcesses.has(channel.id)) {
      clearInterval(pollInterval);
      return;
    }
    const masterPath = path.join(channelDir, 'master.m3u8');
    const prog0Path = path.join(channelDir, 'v0', 'prog.m3u8');
    if (fs.existsSync(masterPath) && fs.existsSync(prog0Path)) {
      channel.status = 'live';
      clearInterval(pollInterval);
    }
  }, 250);

  proc.on('exit', (code, signal) => {
    clearInterval(pollInterval);
    if (ffmpegProcesses.get(channel.id) === proc) {
      ffmpegProcesses.delete(channel.id);
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        channel.status = 'stopped';
      } else if (code !== 0) {
        channel.status = 'error';
        channel.errorMessage = stderrBuf.trim() || `Encoder exited with code ${code}`;
      } else {
        channel.status = 'stopped';
      }
    }
  });
}

function setCacheEntry(entry: Omit<CacheEntry, 'lastAccessedAt'>): void {
  const existing = edgeCache.get(entry.key);
  if (existing) {
    totalCacheBytes -= existing.body.byteLength;
    edgeCache.delete(entry.key);
  }
  const fullEntry: CacheEntry = { ...entry, lastAccessedAt: Date.now() };
  edgeCache.set(entry.key, fullEntry);
  totalCacheBytes += entry.body.byteLength;

  // LRU eviction
  if (edgeCache.size > MAX_CACHE_ENTRIES || totalCacheBytes > MAX_CACHE_BYTES) {
    const sorted = Array.from(edgeCache.values()).sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    for (const victim of sorted) {
      if (edgeCache.size <= MAX_CACHE_ENTRIES && totalCacheBytes <= MAX_CACHE_BYTES) break;
      edgeCache.delete(victim.key);
      totalCacheBytes -= victim.body.byteLength;
    }
  }
}

function getFreshCacheEntry(key: string): CacheEntry | null {
  const item = edgeCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    totalCacheBytes -= item.body.byteLength;
    edgeCache.delete(key);
    return null;
  }
  item.lastAccessedAt = Date.now();
  return item;
}

function purgeCache(popId?: string, channelId?: string): number {
  let removed = 0;
  for (const [key, entry] of edgeCache.entries()) {
    const matchPop = !popId || entry.popId === popId || (!popId && entry.popId === 'shield');
    const matchChannel = !channelId || entry.channelId === channelId;
    if (matchPop && matchChannel) {
      totalCacheBytes -= entry.body.byteLength;
      edgeCache.delete(key);
      removed++;
    }
  }
  return removed;
}

function rewriteExternalPlaylist(playlistText: string, baseUrl: string, popId: string, channelId: string): string {
  const toProxyUrl = (rawRef: string): string => {
    const resolved = new URL(rawRef, baseUrl).toString();
    const token = Buffer.from(resolved, 'utf8').toString('base64url');
    const pathname = new URL(resolved).pathname;
    const ext = pathname.endsWith('.m3u8')
      ? 'playlist.m3u8'
      : pathname.endsWith('.m4s')
        ? 'seg.m4s'
        : pathname.endsWith('.mp4')
          ? 'init.mp4'
          : pathname.endsWith('.aac')
            ? 'seg.aac'
            : 'seg.ts';
    return `/cdn/${popId}/${channelId}/ext/${token}/${ext}`;
  };

  return playlistText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
          try {
            return `URI="${toProxyUrl(uri)}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }
      try {
        return toProxyUrl(trimmed);
      } catch {
        return line;
      }
    })
    .join('\n');
}

function recordDeliveryLog(entry: Omit<DeliveryLogEntry, 'id' | 'timestamp'>): void {
  deliveryLogs.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (deliveryLogs.length > 80) {
    deliveryLogs.length = 80;
  }
}

async function waitForLocalFile(filePath: string, timeoutMs = 4500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.size > 0) return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function bootstrapDefaultChannels(): void {
  const defaultLive: ChannelRecord = {
    id: 'orin-live-01',
    name: 'Orin Global Broadcast 01',
    type: 'local-ffmpeg',
    sourceUrl: 'local://ffmpeg-abr/orin-live-01',
    signalPattern: 'testsrc2',
    status: 'starting',
    originShield: true,
    manifestTtlMs: 1200,
    segmentTtlMs: 30000,
    createdAt: new Date().toISOString(),
    variants: [
      { label: '720p HD', resolution: '1280x720', bitrateKbps: 1696 },
      { label: '480p SD', resolution: '854x480', bitrateKbps: 946 },
      { label: '360p Low', resolution: '640x360', bitrateKbps: 516 },
    ],
  };
  channels.set(defaultLive.id, defaultLive);
  startLocalEncoder(defaultLive);
}

async function startServer(): Promise<void> {
  bootstrapDefaultChannels();

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'orin-cdn', uptimeSec: Math.round(process.uptime()) });
  });

  app.get('/api/state', (_req: Request, res: Response) => {
    const popEntryCounts = new Map<string, number>();
    for (const entry of edgeCache.values()) {
      popEntryCounts.set(entry.popId, (popEntryCounts.get(entry.popId) || 0) + 1);
    }

    res.json({
      channels: Array.from(channels.values()),
      pops: pops.map((p) => ({
        ...p,
        cacheEntries: popEntryCounts.get(p.id) || 0,
      })),
      logs: deliveryLogs,
      summary: {
        totalRequests,
        edgeHits: totalEdgeHits,
        shieldHits: totalShieldHits,
        originFetches: totalOriginFetches,
        totalBytesServed,
        cacheMemoryBytes: totalCacheBytes,
        cacheObjectCount: edgeCache.size,
      },
    });
  });

  app.post('/api/channels', async (req: Request, res: Response) => {
    try {
      const { id, name, type, sourceUrl, signalPattern, originShield, manifestTtlMs, segmentTtlMs } = req.body || {};
      const cleanId = String(id || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');

      if (!VALID_ID_RE.test(cleanId)) {
        res.status(400).json({ error: 'Channel ID must be 2–39 lowercase letters, numbers, or hyphens.' });
        return;
      }
      if (channels.has(cleanId)) {
        res.status(409).json({ error: `Channel "${cleanId}" already exists.` });
        return;
      }
      const cleanName = String(name || cleanId).trim().slice(0, 64);
      if (!cleanName) {
        res.status(400).json({ error: 'Channel name is required.' });
        return;
      }

      const mTtl = Math.min(30000, Math.max(500, Number(manifestTtlMs) || 1200));
      const sTtl = Math.min(300000, Math.max(2000, Number(segmentTtlMs) || 30000));
      const shield = Boolean(originShield ?? true);

      if (type === 'external-hls') {
        const rawUrl = String(sourceUrl || '').trim();
        const validated = await validateSafeExternalUrl(rawUrl);
        const channel: ChannelRecord = {
          id: cleanId,
          name: cleanName,
          type: 'external-hls',
          sourceUrl: validated.toString(),
          status: 'live',
          originShield: shield,
          manifestTtlMs: mTtl,
          segmentTtlMs: sTtl,
          createdAt: new Date().toISOString(),
          variants: [
            { label: 'Origin ABR', resolution: 'Adaptive', bitrateKbps: 0 },
          ],
        };
        channels.set(channel.id, channel);
        res.status(201).json(channel);
        return;
      }

      if (type === 'local-ffmpeg') {
        const pattern: LocalSignalPattern =
          signalPattern === 'smptebars' || signalPattern === 'mandelbrot' ? signalPattern : 'testsrc2';
        const channel: ChannelRecord = {
          id: cleanId,
          name: cleanName,
          type: 'local-ffmpeg',
          sourceUrl: `local://ffmpeg-abr/${cleanId}`,
          signalPattern: pattern,
          status: 'starting',
          originShield: shield,
          manifestTtlMs: mTtl,
          segmentTtlMs: sTtl,
          createdAt: new Date().toISOString(),
          variants: [
            { label: '720p HD', resolution: '1280x720', bitrateKbps: 1696 },
            { label: '480p SD', resolution: '854x480', bitrateKbps: 946 },
            { label: '360p Low', resolution: '640x360', bitrateKbps: 516 },
          ],
        };
        channels.set(channel.id, channel);
        startLocalEncoder(channel);
        res.status(201).json(channel);
        return;
      }

      res.status(400).json({ error: 'Invalid channel type.' });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create origin channel.' });
    }
  });

  app.post('/api/channels/:id/start', (req: Request, res: Response) => {
    const ch = channels.get(req.params.id);
    if (!ch) {
      res.status(404).json({ error: 'Channel not found.' });
      return;
    }
    if (ch.type === 'local-ffmpeg') {
      startLocalEncoder(ch);
    } else {
      ch.status = 'live';
    }
    res.json(ch);
  });

  app.post('/api/channels/:id/stop', (req: Request, res: Response) => {
    const ch = channels.get(req.params.id);
    if (!ch) {
      res.status(404).json({ error: 'Channel not found.' });
      return;
    }
    if (ch.type === 'local-ffmpeg') {
      stopLocalEncoder(ch.id);
    } else {
      ch.status = 'stopped';
    }
    res.json(ch);
  });

  app.patch('/api/channels/:id', (req: Request, res: Response) => {
    const ch = channels.get(req.params.id);
    if (!ch) {
      res.status(404).json({ error: 'Channel not found.' });
      return;
    }
    const { originShield, manifestTtlMs, segmentTtlMs, signalPattern } = req.body || {};
    if (typeof originShield === 'boolean') ch.originShield = originShield;
    if (manifestTtlMs !== undefined) ch.manifestTtlMs = Math.min(30000, Math.max(500, Number(manifestTtlMs) || 1200));
    if (segmentTtlMs !== undefined) ch.segmentTtlMs = Math.min(300000, Math.max(2000, Number(segmentTtlMs) || 30000));
    if (ch.type === 'local-ffmpeg' && (signalPattern === 'testsrc2' || signalPattern === 'smptebars' || signalPattern === 'mandelbrot')) {
      if (ch.signalPattern !== signalPattern) {
        ch.signalPattern = signalPattern;
        if (ch.status === 'live' || ch.status === 'starting') {
          startLocalEncoder(ch);
        }
      }
    }
    res.json(ch);
  });

  app.delete('/api/channels/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (id === 'orin-live-01') {
      res.status(400).json({ error: 'Primary default broadcast channel cannot be deleted.' });
      return;
    }
    const ch = channels.get(id);
    if (!ch) {
      res.status(404).json({ error: 'Channel not found.' });
      return;
    }
    stopLocalEncoder(id);
    purgeCache(undefined, id);
    channels.delete(id);
    if (ch.type === 'local-ffmpeg') {
      const dir = getChannelDir(id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    res.json({ ok: true });
  });

  app.post('/api/cache/purge', (req: Request, res: Response) => {
    const { popId, channelId } = req.body || {};
    const removed = purgeCache(
      typeof popId === 'string' && popId !== 'all' ? popId : undefined,
      typeof channelId === 'string' && channelId !== 'all' ? channelId : undefined
    );
    res.json({ ok: true, purgedObjects: removed });
  });

  // Real Edge CDN HLS Delivery Endpoint
  app.get('/cdn/:popId/:channelId/*', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const rawPop = req.params.popId;
    const channelId = req.params.channelId;
    const rawAssetParam = req.params[0];
    const subPath = String(rawAssetParam || 'master.m3u8');

    const resolvedPopId = rawPop === 'anycast' ? 'iad-01' : rawPop;
    const pop = popMap.get(resolvedPopId);
    if (!pop) {
      res.status(404).json({ error: 'Unknown Edge PoP identifier.' });
      return;
    }

    const channel = channels.get(channelId);
    if (!channel) {
      res.status(404).json({ error: 'Origin channel not found.' });
      return;
    }
    if (channel.status === 'stopped') {
      res.status(503).json({ error: 'Origin channel is currently stopped.' });
      return;
    }

    const cacheKey = `${resolvedPopId}:${channelId}:${subPath}`;
    const shieldKey = `shield:${channelId}:${subPath}`;
    const isPlaylist = subPath.endsWith('.m3u8');
    const ttlMs = isPlaylist ? channel.manifestTtlMs : channel.segmentTtlMs;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'X-Orin-PoP, X-Cache, X-Origin-Shield, X-Origin-Latency-Ms, Age');
    res.setHeader('X-Orin-PoP', resolvedPopId);

    totalRequests++;
    pop.lastActiveAt = new Date().toISOString();

    // 1. Edge PoP Cache Lookup
    const edgeHit = getFreshCacheEntry(cacheKey);
    if (edgeHit) {
      const ageSec = Math.max(0, Math.floor((Date.now() - edgeHit.createdAt) / 1000));
      const latencyMs = Math.max(1, Date.now() - startedAt);
      totalEdgeHits++;
      pop.hits++;
      pop.bytesServed += edgeHit.body.byteLength;
      totalBytesServed += edgeHit.body.byteLength;

      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Origin-Shield', channel.originShield ? 'iad-shield-01 (bypassed)' : 'disabled');
      res.setHeader('X-Origin-Latency-Ms', '0');
      res.setHeader('Age', String(ageSec));
      res.setHeader('Cache-Control', `public, max-age=${Math.max(1, Math.floor(ttlMs / 1000))}`);
      res.setHeader('Content-Type', edgeHit.contentType);

      recordDeliveryLog({
        popId: resolvedPopId,
        channelId,
        asset: subPath.startsWith('ext/') ? subPath.split('/').pop() || 'segment' : subPath,
        cacheStatus: 'HIT',
        statusCode: 200,
        latencyMs,
        bytes: edgeHit.body.byteLength,
      });

      res.status(200).send(edgeHit.body);
      return;
    }

    // 2. Origin Shield Lookup (if enabled)
    if (channel.originShield) {
      const shieldHit = getFreshCacheEntry(shieldKey);
      if (shieldHit) {
        const latencyMs = Math.max(2, Date.now() - startedAt);
        setCacheEntry({
          key: cacheKey,
          popId: resolvedPopId,
          channelId,
          body: shieldHit.body,
          contentType: shieldHit.contentType,
          createdAt: shieldHit.createdAt,
          expiresAt: shieldHit.expiresAt,
        });

        totalShieldHits++;
        pop.shieldHits++;
        pop.bytesServed += shieldHit.body.byteLength;
        totalBytesServed += shieldHit.body.byteLength;

        res.setHeader('X-Cache', 'SHIELD-HIT');
        res.setHeader('X-Origin-Shield', 'iad-shield-01 (HIT)');
        res.setHeader('X-Origin-Latency-Ms', String(latencyMs));
        res.setHeader('Cache-Control', `public, max-age=${Math.max(1, Math.floor(ttlMs / 1000))}`);
        res.setHeader('Content-Type', shieldHit.contentType);

        recordDeliveryLog({
          popId: resolvedPopId,
          channelId,
          asset: subPath.startsWith('ext/') ? subPath.split('/').pop() || 'segment' : subPath,
          cacheStatus: 'SHIELD-HIT',
          statusCode: 200,
          latencyMs,
          bytes: shieldHit.body.byteLength,
        });

        res.status(200).send(shieldHit.body);
        return;
      }
    }

    // 3. Origin Fetch (MISS)
    try {
      let body: Buffer;
      let contentType: string;

      if (channel.type === 'local-ffmpeg') {
        const channelDir = getChannelDir(channelId);
        const safeTarget = path.resolve(channelDir, subPath);
        if (!safeTarget.startsWith(channelDir + path.sep)) {
          res.status(400).json({ error: 'Invalid asset path.' });
          return;
        }

        const exists = fs.existsSync(safeTarget) || (await waitForLocalFile(safeTarget, isPlaylist ? 4500 : 1200));
        if (!exists) {
          res.status(404).json({ error: 'Segment or playlist not yet available.' });
          return;
        }

        body = fs.readFileSync(safeTarget);
        contentType = isPlaylist
          ? 'application/vnd.apple.mpegurl'
          : subPath.endsWith('.ts')
            ? 'video/mp2t'
            : 'application/octet-stream';
      } else {
        // External HLS Origin Relay
        let upstreamUrl = channel.sourceUrl;
        if (subPath.startsWith('ext/')) {
          const parts = subPath.split('/');
          const token = parts[1];
          if (!token) {
            res.status(400).json({ error: 'Missing external asset token.' });
            return;
          }
          upstreamUrl = Buffer.from(token, 'base64url').toString('utf8');
        } else if (subPath !== 'master.m3u8') {
          upstreamUrl = new URL(subPath, channel.sourceUrl).toString();
        }

        const fetched = await safeFetchExternal(upstreamUrl);
        const looksLikeM3u8 =
          subPath.endsWith('.m3u8') ||
          fetched.contentType.toLowerCase().includes('mpegurl') ||
          fetched.buffer.subarray(0, 7).toString('utf8') === '#EXTM3U';

        if (looksLikeM3u8) {
          const rewritten = rewriteExternalPlaylist(
            fetched.buffer.toString('utf8'),
            fetched.finalUrl,
            rawPop,
            channelId
          );
          body = Buffer.from(rewritten, 'utf8');
          contentType = 'application/vnd.apple.mpegurl';
        } else {
          body = fetched.buffer;
          contentType = fetched.contentType;
        }
      }

      const now = Date.now();
      const latencyMs = Math.max(1, now - startedAt);
      totalOriginFetches++;
      pop.misses++;
      pop.bytesServed += body.byteLength;
      totalBytesServed += body.byteLength;

      setCacheEntry({
        key: cacheKey,
        popId: resolvedPopId,
        channelId,
        body,
        contentType,
        createdAt: now,
        expiresAt: now + ttlMs,
      });

      if (channel.originShield) {
        setCacheEntry({
          key: shieldKey,
          popId: 'shield',
          channelId,
          body,
          contentType,
          createdAt: now,
          expiresAt: now + ttlMs,
        });
      }

      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Origin-Shield', channel.originShield ? 'iad-shield-01 (MISS)' : 'disabled');
      res.setHeader('X-Origin-Latency-Ms', String(latencyMs));
      res.setHeader('Cache-Control', `public, max-age=${Math.max(1, Math.floor(ttlMs / 1000))}`);
      res.setHeader('Content-Type', contentType);

      recordDeliveryLog({
        popId: resolvedPopId,
        channelId,
        asset: subPath.startsWith('ext/') ? subPath.split('/').pop() || 'segment' : subPath,
        cacheStatus: 'MISS',
        statusCode: 200,
        latencyMs,
        bytes: body.byteLength,
      });

      res.status(200).send(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upstream origin error.';
      res.status(502).json({ error: msg });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Orin CDN Origin & Edge server listening on http://0.0.0.0:${PORT}`);
  });

  const cleanup = () => {
    for (const id of Array.from(ffmpegProcesses.keys())) {
      stopLocalEncoder(id);
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

startServer().catch((err) => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
