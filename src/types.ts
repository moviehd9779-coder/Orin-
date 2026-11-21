export type OriginType = 'local-ffmpeg' | 'external-hls';

export type LocalSignalPattern = 'testsrc2' | 'smptebars' | 'mandelbrot';

export interface OriginChannel {
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

export interface EdgePop {
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
  cacheEntries: number;
  lastActiveAt: string | null;
}

export interface DeliveryLogEntry {
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

export interface CdnStateSnapshot {
  channels: OriginChannel[];
  pops: EdgePop[];
  logs: DeliveryLogEntry[];
  summary: {
    totalRequests: number;
    edgeHits: number;
    shieldHits: number;
    originFetches: number;
    totalBytesServed: number;
    cacheMemoryBytes: number;
    cacheObjectCount: number;
  };
}
