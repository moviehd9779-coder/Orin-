import { useEffect, useState } from 'react';
import { RefreshCw, Zap } from 'lucide-react';
import type { OriginChannel } from '../types';

interface ManifestInspectorProps {
  channel: OriginChannel | null;
  selectedPopId: string;
}

interface InspectResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  latencyMs: number;
}

export function ManifestInspector({ channel, selectedPopId }: ManifestInspectorProps) {
  const [targetPath, setTargetPath] = useState<string>('master.m3u8');
  const [variantOptions, setVariantOptions] = useState<string[]>(['master.m3u8']);
  const [result, setResult] = useState<InspectResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchManifest = async (assetPath: string) => {
    if (!channel) return;
    setLoading(true);
    setError(null);
    const url = assetPath.startsWith('/cdn/')
      ? assetPath
      : `/cdn/${selectedPopId}/${channel.id}/${assetPath}`;
    const start = performance.now();
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      const text = await resp.text();
      const latencyMs = Math.round(performance.now() - start);
      const headers: Record<string, string> = {};
      for (const key of [
        'x-orin-pop',
        'x-cache',
        'x-origin-shield',
        'x-origin-latency-ms',
        'cache-control',
        'age',
        'content-type',
      ]) {
        const v = resp.headers.get(key);
        if (v !== null) headers[key] = v;
      }

      setResult({
        url,
        status: resp.status,
        headers,
        body: text,
        latencyMs,
      });

      // Extract child .m3u8 links if inspecting master.m3u8
      if (url.endsWith('master.m3u8') && resp.ok) {
        const discovered = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && l.includes('.m3u8'));
        setVariantOptions(['master.m3u8', ...Array.from(new Set(discovered))]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect manifest.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setTargetPath('master.m3u8');
    setVariantOptions(['master.m3u8']);
    if (channel && channel.status !== 'stopped') {
      fetchManifest('master.m3u8');
    } else {
      setResult(null);
    }
  }, [channel?.id, channel?.status, selectedPopId]);

  if (!channel) {
    return (
      <div className="bg-[#111827] border border-slate-800 rounded-xl p-8 text-center text-sm text-slate-400">
        Select an Origin Channel to inspect its live HLS playlists and Edge CDN headers.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-[#111827] border border-slate-800 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div>
            <h3 className="text-base font-semibold text-slate-100">Live HLS Manifest & Edge Header Inspector</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Inspect raw M3U8 playlists and real-time Edge PoP response headers directly from the CDN node.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              aria-label="Select playlist file"
              value={targetPath}
              onChange={(e) => {
                setTargetPath(e.target.value);
                fetchManifest(e.target.value);
              }}
              className="bg-[#0B111E] border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 max-w-xs truncate"
            >
              {variantOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => fetchManifest(targetPath)}
              disabled={loading || channel.status === 'stopped'}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Fetch Live</span>
            </button>

            <button
              type="button"
              onClick={async () => {
                await fetchManifest(targetPath);
                await fetchManifest(targetPath);
              }}
              disabled={loading || channel.status === 'stopped'}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0B111E] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded-lg disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              <span>Test Warm Hit</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-950/40 border border-red-900/60 text-xs text-red-300">
            {error}
          </div>
        )}

        {channel.status === 'stopped' ? (
          <div className="py-12 text-center text-sm text-slate-400">
            Origin channel is stopped. Start the channel to inspect live manifests.
          </div>
        ) : result ? (
          <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* HTTP Edge Response Headers */}
            <div className="lg:col-span-5 bg-[#0B111E] border border-slate-800 rounded-lg p-4">
              <div className="flex items-center justify-between pb-2.5 mb-3 border-b border-slate-800">
                <span className="text-xs font-semibold text-slate-200">Edge Response Headers</span>
                <span className="text-xs font-mono tabular-nums text-slate-400">
                  HTTP {result.status} · {result.latencyMs}ms
                </span>
              </div>
              <dl className="space-y-2.5 text-xs font-mono">
                {Object.entries(result.headers).map(([key, value]) => (
                  <div key={key} className="flex items-start justify-between gap-4">
                    <dt className="text-slate-400 shrink-0">{key}</dt>
                    <dd
                      className={`text-right break-all ${
                        key === 'x-cache'
                          ? value === 'HIT'
                            ? 'text-emerald-400 font-semibold'
                            : value === 'SHIELD-HIT'
                              ? 'text-blue-400 font-semibold'
                              : 'text-amber-400 font-semibold'
                          : 'text-slate-200'
                      }`}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* Raw M3U8 Playlist Output */}
            <div className="lg:col-span-7 bg-[#0B111E] border border-slate-800 rounded-lg p-4 overflow-hidden">
              <div className="flex items-center justify-between pb-2.5 mb-3 border-b border-slate-800">
                <span className="text-xs font-semibold text-slate-200">Playlist Payload</span>
                <span className="text-xs font-mono text-slate-400 truncate max-w-xs">{result.url}</span>
              </div>
              <pre className="text-xs font-mono text-slate-300 leading-relaxed overflow-x-auto max-h-96 whitespace-pre">
                {result.body}
              </pre>
            </div>
          </div>
        ) : (
          <div className="py-12 text-center text-xs text-slate-400">Loading manifest...</div>
        )}
      </div>
    </div>
  );
}
