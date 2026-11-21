import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import type { LocalSignalPattern, OriginType } from '../types';

interface NewOriginModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (payload: {
    id: string;
    name: string;
    type: OriginType;
    sourceUrl?: string;
    signalPattern?: LocalSignalPattern;
    originShield: boolean;
    manifestTtlMs: number;
    segmentTtlMs: number;
  }) => Promise<void>;
}

export function NewOriginModal({ open, onClose, onCreate }: NewOriginModalProps) {
  const [type, setType] = useState<OriginType>('local-ffmpeg');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [signalPattern, setSignalPattern] = useState<LocalSignalPattern>('smptebars');
  const [originShield, setOriginShield] = useState(true);
  const [manifestTtlMs, setManifestTtlMs] = useState(1200);
  const [segmentTtlMs, setSegmentTtlMs] = useState(30000);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        id,
        name: name || id,
        type,
        sourceUrl: type === 'external-hls' ? sourceUrl : undefined,
        signalPattern: type === 'local-ffmpeg' ? signalPattern : undefined,
        originShield,
        manifestTtlMs,
        segmentTtlMs,
      });
      setId('');
      setName('');
      setSourceUrl('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create origin stream.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-origin-title"
    >
      <div className="w-full max-w-lg bg-[#111827] border border-slate-700 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <h2 id="new-origin-title" className="text-base font-semibold text-slate-100">
            Configure New Origin Stream
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-950/50 border border-red-800 text-xs text-red-300">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-2">Origin Ingest Mode</label>
            <div className="grid grid-cols-2 gap-2 p-1 bg-[#0B111E] border border-slate-800 rounded-lg">
              <button
                type="button"
                onClick={() => setType('local-ffmpeg')}
                className={`py-2 px-3 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  type === 'local-ffmpeg'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Local ABR Encoder
              </button>
              <button
                type="button"
                onClick={() => setType('external-hls')}
                className={`py-2 px-3 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  type === 'external-hls'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                External HLS Relay
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="origin-id" className="block text-xs font-medium text-slate-300 mb-1.5">
                Channel Slug ID
              </label>
              <input
                id="origin-id"
                type="text"
                required
                placeholder="e.g. sports-feed-02"
                value={id}
                onChange={(e) => setId(e.target.value)}
                className="w-full bg-[#0B111E] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="origin-name" className="block text-xs font-medium text-slate-300 mb-1.5">
                Display Name
              </label>
              <input
                id="origin-name"
                type="text"
                required
                placeholder="e.g. Global Sports Feed"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-[#0B111E] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              />
            </div>
          </div>

          {type === 'local-ffmpeg' ? (
            <div>
              <label htmlFor="signal-pattern" className="block text-xs font-medium text-slate-300 mb-1.5">
                Live Broadcast Signal Generator
              </label>
              <select
                id="signal-pattern"
                value={signalPattern}
                onChange={(e) => setSignalPattern(e.target.value as LocalSignalPattern)}
                className="w-full bg-[#0B111E] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <option value="smptebars">SMPTE HD Color Bars + 440Hz Reference</option>
                <option value="testsrc2">Broadcast Test Pattern + Frame Timecode</option>
                <option value="mandelbrot">Dynamic Mandelbrot Motion Stress Test</option>
              </select>
            </div>
          ) : (
            <div>
              <label htmlFor="origin-url" className="block text-xs font-medium text-slate-300 mb-1.5">
                Origin Master Playlist URL (.m3u8)
              </label>
              <input
                id="origin-url"
                type="url"
                required
                placeholder="https://origin.example.com/live/master.m3u8"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                className="w-full bg-[#0B111E] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              />
              <div className="mt-1.5 flex items-center justify-between text-xs text-slate-400">
                <span>Public HTTPS HLS origin URL</span>
                <button
                  type="button"
                  onClick={() => {
                    setSourceUrl('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
                    if (!id) setId('mux-abr-relay');
                    if (!name) setName('Mux ABR Reference Stream');
                  }}
                  className="text-blue-400 hover:text-blue-300 underline cursor-pointer"
                >
                  Use Mux Reference Stream
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="manifest-ttl" className="block text-xs font-medium text-slate-300 mb-1.5">
                Manifest TTL (ms)
              </label>
              <input
                id="manifest-ttl"
                type="number"
                min={500}
                max={30000}
                step={100}
                value={manifestTtlMs}
                onChange={(e) => setManifestTtlMs(Number(e.target.value))}
                className="w-full bg-[#0B111E] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 font-mono tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="segment-ttl" className="block text-xs font-medium text-slate-300 mb-1.5">
                Segment TTL (ms)
              </label>
              <input
                id="segment-ttl"
                type="number"
                min={2000}
                max={300000}
                step={1000}
                value={segmentTtlMs}
                onChange={(e) => setSegmentTtlMs(Number(e.target.value))}
                className="w-full bg-[#0B111E] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 font-mono tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              />
            </div>
          </div>

          <label className="flex items-center gap-2.5 pt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={originShield}
              onChange={(e) => setOriginShield(e.target.checked)}
              className="w-4 h-4 rounded border-slate-600 bg-[#0B111E] text-blue-600 focus:ring-blue-500"
            />
            <span className="text-xs text-slate-300">
              Enable Origin Shield (iad-shield-01) to coalesce cross-PoP segment fetches
            </span>
          </label>

          <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-[#0B111E] border border-slate-700 rounded-lg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
            >
              {submitting ? 'Provisioning...' : 'Create Origin Stream'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
