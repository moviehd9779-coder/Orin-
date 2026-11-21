import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Menu,
  X,
  Play,
  Square,
  Trash2,
  Shield,
  Radio,
  Search,
} from 'lucide-react';
import type {
  CdnStateSnapshot,
  LocalSignalPattern,
  OriginChannel,
  OriginType,
} from './types';
import { HlsPlayer, type PlayerTelemetry } from './components/HlsPlayer';
import { EdgeTopologyMap } from './components/EdgeTopologyMap';
import { ManifestInspector } from './components/ManifestInspector';
import { NewOriginModal } from './components/NewOriginModal';

type WorkspaceTab = 'monitor' | 'edges' | 'manifests' | 'origins';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('monitor');
  const [state, setState] = useState<CdnStateSnapshot | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string>('orin-live-01');
  const [selectedPopId, setSelectedPopId] = useState<string>('anycast');
  const [modalOpen, setModalOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [logFilter, setLogFilter] = useState<'all' | 'HIT' | 'SHIELD-HIT' | 'MISS'>('all');
  const [logSearch, setLogSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const [telemetry, setTelemetry] = useState<PlayerTelemetry>({
    currentLevelIndex: -1,
    levels: [],
    bufferLengthSec: 0,
    liveLatencySec: 0,
    isPlaying: false,
    isBuffering: true,
    droppedFrames: 0,
    error: null,
  });

  const fetchState = useCallback(async () => {
    try {
      const resp = await fetch('/api/state', { cache: 'no-store' });
      if (!resp.ok) return;
      const data: CdnStateSnapshot = await resp.json();
      setState(data);
      if (data.channels.length > 0 && !data.channels.some((c) => c.id === selectedChannelId)) {
        setSelectedChannelId(data.channels[0].id);
      }
    } catch {
      // Silent retry on next poll
    }
  }, [selectedChannelId]);

  useEffect(() => {
    fetchState();
    const timer = setInterval(fetchState, 2000);
    return () => clearInterval(timer);
  }, [fetchState]);

  const activeChannel: OriginChannel | null = useMemo(() => {
    if (!state) return null;
    return state.channels.find((c) => c.id === selectedChannelId) || state.channels[0] || null;
  }, [state, selectedChannelId]);

  const handleTelemetry = useCallback((t: PlayerTelemetry) => {
    setTelemetry(t);
  }, []);

  const handleCreateChannel = async (payload: {
    id: string;
    name: string;
    type: OriginType;
    sourceUrl?: string;
    signalPattern?: LocalSignalPattern;
    originShield: boolean;
    manifestTtlMs: number;
    segmentTtlMs: number;
  }) => {
    const resp = await fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || 'Failed to create origin stream.');
    }
    await fetchState();
    setSelectedChannelId(data.id);
    setActiveTab('monitor');
  };

  const handleStartChannel = async (channelId: string) => {
    setActionError(null);
    const resp = await fetch(`/api/channels/${encodeURIComponent(channelId)}/start`, { method: 'POST' });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      setActionError(data.error || 'Could not start origin stream.');
    }
    await fetchState();
  };

  const handleStopChannel = async (channelId: string) => {
    setActionError(null);
    await fetch(`/api/channels/${encodeURIComponent(channelId)}/stop`, { method: 'POST' });
    await fetchState();
  };

  const handleUpdateChannel = async (
    channelId: string,
    patch: Partial<Pick<OriginChannel, 'originShield' | 'manifestTtlMs' | 'segmentTtlMs' | 'signalPattern'>>
  ) => {
    setActionError(null);
    const resp = await fetch(`/api/channels/${encodeURIComponent(channelId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      setActionError(data.error || 'Failed to update channel configuration.');
    }
    await fetchState();
  };

  const handleDeleteChannel = async (channelId: string) => {
    setActionError(null);
    const resp = await fetch(`/api/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      setActionError(data.error || 'Could not delete channel.');
      return;
    }
    await fetchState();
  };

  const handlePurgeEdge = async (popId: string, channelId?: string) => {
    await fetch('/api/cache/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        popId: popId === 'anycast' ? 'iad-01' : popId,
        channelId: channelId || 'all',
      }),
    });
    await fetchState();
  };

  const cacheHitRatio = useMemo(() => {
    if (!state || state.summary.totalRequests === 0) return 0;
    const offloaded = state.summary.edgeHits + state.summary.shieldHits;
    return (offloaded / state.summary.totalRequests) * 100;
  }, [state]);

  const activeVariantLabel = useMemo(() => {
    const lvl = telemetry.levels.find((l) => l.index === telemetry.currentLevelIndex);
    if (!lvl) return 'Auto ABR';
    const kbps = Math.round(lvl.bitrate / 1000);
    return `${lvl.height ? `${lvl.height}p` : `L${lvl.index}`} · ${kbps} kbps`;
  }, [telemetry.levels, telemetry.currentLevelIndex]);

  const filteredLogs = useMemo(() => {
    if (!state) return [];
    return state.logs.filter((entry) => {
      if (logFilter !== 'all' && entry.cacheStatus !== logFilter) return false;
      if (logSearch.trim()) {
        const q = logSearch.trim().toLowerCase();
        return (
          entry.asset.toLowerCase().includes(q) ||
          entry.popId.toLowerCase().includes(q) ||
          entry.channelId.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [state, logFilter, logSearch]);

  const navItems: { id: WorkspaceTab; label: string }[] = [
    { id: 'monitor', label: 'Live Monitor' },
    { id: 'edges', label: 'Edge PoPs' },
    { id: 'manifests', label: 'Manifests' },
    { id: 'origins', label: 'Origins' },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-[#0B111E] text-slate-100">
      {/* Strict 3-Zone Top Navigation Contract */}
      <header className="h-16 px-6 border-b border-slate-800 bg-[#0E1525] flex items-center justify-between gap-8 shrink-0">
        {/* Zone 1: Single-line Brand Wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setMobileNavOpen((o) => !o)}
            aria-label="Toggle channel drawer"
            className="lg:hidden p-2 -ml-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
          >
            {mobileNavOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
          <a
            href="#monitor"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('monitor');
            }}
            className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 font-display"
          >
            Orin CDN
          </a>
        </div>

        {/* Zone 2: 4 Single-line Navigation Links */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`py-5 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  isActive
                    ? 'border-blue-500 text-slate-100'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 Primary Action CTA */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            New Origin Stream
          </button>
        </div>
      </header>

      {/* Mobile Tab Strip (visible on < md) */}
      <div className="md:hidden border-b border-slate-800 bg-[#0E1525] px-4 py-2 flex items-center gap-2 overflow-x-auto">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setActiveTab(item.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === item.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Workspace Body: Left Sidebar + Main Content Viewport */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar (Desktop fixed 256px, Mobile slide-down drawer) */}
        <aside
          className={`${
            mobileNavOpen ? 'block fixed inset-x-0 top-16 z-40 bg-[#0E1525] border-b border-slate-800 max-h-[70vh] overflow-y-auto' : 'hidden'
          } lg:block lg:static lg:w-64 lg:border-r lg:border-slate-800 bg-[#0E1525] shrink-0`}
        >
          <div className="p-4 space-y-6">
            <div>
              <div className="px-2 pb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400">Origin Channels</span>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {state?.channels.length ?? 0}
                </span>
              </div>

              <div className="space-y-1">
                {!state ? (
                  <div className="space-y-2 px-2 py-2">
                    <div className="h-10 bg-slate-800/50 rounded-lg animate-pulse" />
                    <div className="h-10 bg-slate-800/50 rounded-lg animate-pulse" />
                  </div>
                ) : (
                  state.channels.map((ch) => {
                    const isSelected = activeChannel?.id === ch.id;
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={() => {
                          setSelectedChannelId(ch.id);
                          setMobileNavOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-[#161F30] text-slate-100 border border-slate-700'
                            : 'text-slate-300 hover:bg-slate-800/40 border border-transparent'
                        }`}
                      >
                        <div className="text-sm font-medium truncate">{ch.name}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400 truncate">
                          <span>{ch.type === 'local-ffmpeg' ? 'Local ABR' : 'HLS Relay'}</span>
                          <span aria-hidden="true">·</span>
                          <span
                            className={
                              ch.status === 'live'
                                ? 'text-emerald-400'
                                : ch.status === 'starting'
                                  ? 'text-amber-400'
                                  : ch.status === 'error'
                                    ? 'text-red-400'
                                    : 'text-slate-500'
                            }
                          >
                            {ch.status === 'live'
                              ? 'Live'
                              : ch.status === 'starting'
                                ? 'Starting'
                                : ch.status === 'error'
                                  ? 'Error'
                                  : 'Stopped'}
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-slate-800">
              <div className="px-2 pb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400">Edge Delivery PoP</span>
                <span className="text-xs font-mono text-slate-500">
                  {selectedPopId === 'anycast' ? 'Auto' : selectedPopId}
                </span>
              </div>
              <div className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => setSelectedPopId('anycast')}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors flex items-center justify-between cursor-pointer ${
                    selectedPopId === 'anycast'
                      ? 'bg-[#161F30] text-blue-300 font-medium'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                  }`}
                >
                  <span>Global Anycast</span>
                  <span className="font-mono text-slate-500">iad-01</span>
                </button>
                {state?.pops.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedPopId(p.id)}
                    className={`w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors flex items-center justify-between cursor-pointer ${
                      selectedPopId === p.id
                        ? 'bg-[#161F30] text-blue-300 font-medium'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                    }`}
                  >
                    <span className="truncate">{p.city}</span>
                    <span className="font-mono tabular-nums text-slate-500">{p.id}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>

        {/* Main Viewport */}
        <main className="flex-1 min-w-0 p-6 lg:p-8 overflow-y-auto">
          <div className="max-w-6xl mx-auto space-y-6">
            {/* Contextual Breadcrumb Row */}
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="text-xs text-slate-400 flex items-center gap-2">
                <span>Orin CDN</span>
                <span aria-hidden="true">/</span>
                <span>{navItems.find((n) => n.id === activeTab)?.label}</span>
                {activeChannel && (
                  <>
                    <span aria-hidden="true">/</span>
                    <span className="text-slate-200 font-mono">{activeChannel.id}</span>
                  </>
                )}
              </div>

              {actionError && (
                <div className="text-xs text-red-300 bg-red-950/50 border border-red-900/60 px-3 py-1.5 rounded-lg">
                  {actionError}
                </div>
              )}
            </div>

            {/* Tab 1: Live Monitor */}
            {activeTab === 'monitor' && (
              <div className="space-y-6">
                <HlsPlayer
                  channel={activeChannel}
                  selectedPopId={selectedPopId}
                  pops={state?.pops || []}
                  onSelectPop={setSelectedPopId}
                  onPurgeEdge={handlePurgeEdge}
                  onTelemetry={handleTelemetry}
                  onStartChannel={handleStartChannel}
                />

                {/* 4-Column Telemetry KPI Strip */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="bg-[#111827] border border-slate-800 rounded-xl p-4">
                    <div className="text-xs text-slate-400">Active ABR Rendition</div>
                    <div className="mt-1.5 text-lg font-semibold font-mono tabular-nums text-slate-100">
                      {activeVariantLabel}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 tabular-nums">
                      {telemetry.levels.length} variant tiers · {telemetry.droppedFrames} dropped frames
                    </div>
                  </div>

                  <div className="bg-[#111827] border border-slate-800 rounded-xl p-4">
                    <div className="text-xs text-slate-400">Edge Cache Offload</div>
                    <div className="mt-1.5 text-lg font-semibold font-mono tabular-nums text-slate-100">
                      {cacheHitRatio.toFixed(1)}%
                    </div>
                    <div className="mt-1 text-xs text-slate-500 tabular-nums">
                      {state?.summary.edgeHits ?? 0} edge · {state?.summary.shieldHits ?? 0} shield · {state?.summary.originFetches ?? 0} origin
                    </div>
                  </div>

                  <div className="bg-[#111827] border border-slate-800 rounded-xl p-4">
                    <div className="text-xs text-slate-400">Buffer & Live Edge Delay</div>
                    <div className="mt-1.5 text-lg font-semibold font-mono tabular-nums text-slate-100">
                      {telemetry.bufferLengthSec.toFixed(1)}s · {telemetry.liveLatencySec.toFixed(1)}s
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {telemetry.isPlaying ? 'Stream Playing' : telemetry.isBuffering ? 'Buffering' : 'Paused'}
                    </div>
                  </div>

                  <div className="bg-[#111827] border border-slate-800 rounded-xl p-4">
                    <div className="text-xs text-slate-400">Global Edge Bandwidth</div>
                    <div className="mt-1.5 text-lg font-semibold font-mono tabular-nums text-slate-100">
                      {formatBytes(state?.summary.totalBytesServed ?? 0)}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 tabular-nums">
                      {state?.summary.cacheObjectCount ?? 0} cached objects ({formatBytes(state?.summary.cacheMemoryBytes ?? 0)})
                    </div>
                  </div>
                </div>

                {/* Live Segment Delivery Log Table */}
                <section className="bg-[#111827] border border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-100">Edge Segment Delivery Log</h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Live HTTP playlist and MPEG-TS segment requests served across Orin Edge nodes.
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={logSearch}
                          onChange={(e) => setLogSearch(e.target.value)}
                          placeholder="Filter asset or PoP..."
                          aria-label="Filter delivery logs"
                          className="bg-[#0B111E] border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 w-44"
                        />
                      </div>

                      <div className="flex items-center gap-1 p-1 bg-[#0B111E] border border-slate-800 rounded-lg">
                        {(['all', 'HIT', 'SHIELD-HIT', 'MISS'] as const).map((status) => (
                          <button
                            key={status}
                            type="button"
                            onClick={() => setLogFilter(status)}
                            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                              logFilter === status
                                ? 'bg-slate-800 text-slate-100'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {status === 'all' ? 'All' : status}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0E1525]">
                          <th className="py-2.5 px-5">Time</th>
                          <th className="py-2.5 px-4">Edge PoP</th>
                          <th className="py-2.5 px-4">Channel</th>
                          <th className="py-2.5 px-4">HLS Asset</th>
                          <th className="py-2.5 px-4">Cache State</th>
                          <th className="py-2.5 px-4 text-right">Origin RTT</th>
                          <th className="py-2.5 px-5 text-right">Payload</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70 text-xs font-mono tabular-nums">
                        {filteredLogs.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="py-8 px-5 text-center font-sans text-slate-400">
                              No segment requests recorded yet for this filter. Start or play a stream to observe live edge traffic.
                            </td>
                          </tr>
                        ) : (
                          filteredLogs.slice(0, 20).map((row) => (
                            <tr key={row.id} className="hover:bg-slate-800/30 transition-colors">
                              <td className="py-2.5 px-5 text-slate-400 whitespace-nowrap">
                                {formatTime(row.timestamp)}
                              </td>
                              <td className="py-2.5 px-4 text-slate-200 whitespace-nowrap">{row.popId}</td>
                              <td className="py-2.5 px-4 text-slate-300 whitespace-nowrap">{row.channelId}</td>
                              <td className="py-2.5 px-4 text-slate-200 max-w-xs truncate">{row.asset}</td>
                              <td
                                className={`py-2.5 px-4 font-semibold whitespace-nowrap ${
                                  row.cacheStatus === 'HIT'
                                    ? 'text-emerald-400'
                                    : row.cacheStatus === 'SHIELD-HIT'
                                      ? 'text-blue-400'
                                      : 'text-amber-400'
                                }`}
                              >
                                {row.cacheStatus}
                              </td>
                              <td className="py-2.5 px-4 text-right text-slate-300 whitespace-nowrap">
                                {row.latencyMs} ms
                              </td>
                              <td className="py-2.5 px-5 text-right text-slate-300 whitespace-nowrap">
                                {formatBytes(row.bytes)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}

            {/* Tab 2: Edge PoPs */}
            {activeTab === 'edges' && (
              <div className="space-y-6">
                <EdgeTopologyMap
                  pops={state?.pops || []}
                  selectedPopId={selectedPopId}
                  originShieldEnabled={activeChannel?.originShield ?? true}
                  onSelectPop={(popId) => {
                    setSelectedPopId(popId);
                  }}
                />

                <section className="bg-[#111827] border border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-100">Global Edge PoP Cache Matrix</h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Per-region cache utilization, hit ratios, and active edge routing controls.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handlePurgeEdge('all', 'all')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0B111E] hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-slate-400" />
                      <span>Purge All Global PoPs</span>
                    </button>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0E1525]">
                          <th className="py-2.5 px-5">PoP ID</th>
                          <th className="py-2.5 px-4">Location</th>
                          <th className="py-2.5 px-4 text-right">Cached Objects</th>
                          <th className="py-2.5 px-4 text-right">Edge Hits</th>
                          <th className="py-2.5 px-4 text-right">Shield Hits</th>
                          <th className="py-2.5 px-4 text-right">Origin Misses</th>
                          <th className="py-2.5 px-4 text-right">Served</th>
                          <th className="py-2.5 px-4 text-right">Base RTT</th>
                          <th className="py-2.5 px-5 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70 text-xs">
                        {(state?.pops || []).map((pop) => {
                          const isRouted = selectedPopId === pop.id || (selectedPopId === 'anycast' && pop.id === 'iad-01');
                          return (
                            <tr key={pop.id} className="hover:bg-slate-800/30 transition-colors">
                              <td className="py-3 px-5 font-mono font-semibold text-slate-100 whitespace-nowrap">
                                {pop.id}
                              </td>
                              <td className="py-3 px-4 text-slate-300 whitespace-nowrap">
                                {pop.city} · <span className="text-slate-500">{pop.region}</span>
                              </td>
                              <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-300">
                                {pop.cacheEntries}
                              </td>
                              <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-400">
                                {pop.hits}
                              </td>
                              <td className="py-3 px-4 text-right font-mono tabular-nums text-blue-400">
                                {pop.shieldHits}
                              </td>
                              <td className="py-3 px-4 text-right font-mono tabular-nums text-amber-400">
                                {pop.misses}
                              </td>
                              <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-300">
                                {formatBytes(pop.bytesServed)}
                              </td>
                              <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-400">
                                {pop.baseLatencyMs} ms
                              </td>
                              <td className="py-3 px-5 text-right whitespace-nowrap">
                                <div className="inline-flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedPopId(pop.id);
                                      setActiveTab('monitor');
                                    }}
                                    className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors cursor-pointer ${
                                      isRouted
                                        ? 'bg-blue-600/20 border-blue-500/50 text-blue-300'
                                        : 'bg-[#0B111E] border-slate-700 text-slate-300 hover:bg-slate-800'
                                    }`}
                                  >
                                    {isRouted ? 'Active Route' : 'Route Here'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handlePurgeEdge(pop.id, 'all')}
                                    className="px-2.5 py-1 text-xs font-medium rounded bg-[#0B111E] border border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
                                  >
                                    Purge
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}

            {/* Tab 3: Manifest Inspector */}
            {activeTab === 'manifests' && (
              <ManifestInspector channel={activeChannel} selectedPopId={selectedPopId} />
            )}

            {/* Tab 4: Origin Channels */}
            {activeTab === 'origins' && (
              <section className="bg-[#111827] border border-slate-800 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h3 className="text-base font-semibold text-slate-100">Configured Origin Channels</h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Manage local live ABR encoders, external HLS origin relays, Origin Shielding, and cache TTL policies.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setModalOpen(true)}
                    className="px-3.5 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                  >
                    Add Origin Channel
                  </button>
                </div>

                <div className="divide-y divide-slate-800">
                  {(state?.channels || []).map((ch) => (
                    <div key={ch.id} className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex items-center gap-3">
                          <h4 className="text-sm font-semibold text-slate-100">{ch.name}</h4>
                          <span
                            className={`text-xs font-medium ${
                              ch.status === 'live'
                                ? 'text-emerald-400'
                                : ch.status === 'starting'
                                  ? 'text-amber-400'
                                  : ch.status === 'error'
                                    ? 'text-red-400'
                                    : 'text-slate-500'
                            }`}
                          >
                            {ch.status === 'live'
                              ? 'Live'
                              : ch.status === 'starting'
                                ? 'Starting Encoder'
                                : ch.status === 'error'
                                  ? 'Error'
                                  : 'Stopped'}
                          </span>
                        </div>

                        <div className="text-xs text-slate-400 font-mono truncate">
                          {ch.id} · {ch.sourceUrl}
                        </div>

                        {ch.errorMessage && (
                          <div className="text-xs text-red-400">{ch.errorMessage}</div>
                        )}

                        <div className="flex flex-wrap items-center gap-4 pt-1 text-xs text-slate-400 tabular-nums">
                          <span>Manifest TTL: {ch.manifestTtlMs}ms</span>
                          <span aria-hidden="true">·</span>
                          <span>Segment TTL: {ch.segmentTtlMs}ms</span>
                          <span aria-hidden="true">·</span>
                          <span>Shield: {ch.originShield ? 'Enabled' : 'Disabled'}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                        {ch.type === 'local-ffmpeg' && (
                          <select
                            aria-label={`Signal pattern for ${ch.name}`}
                            value={ch.signalPattern || 'testsrc2'}
                            onChange={(e) =>
                              handleUpdateChannel(ch.id, {
                                signalPattern: e.target.value as LocalSignalPattern,
                              })
                            }
                            className="bg-[#0B111E] border border-slate-700 text-slate-200 text-xs rounded-lg px-2.5 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                          >
                            <option value="testsrc2">Test Pattern 2</option>
                            <option value="smptebars">SMPTE Color Bars</option>
                            <option value="mandelbrot">Mandelbrot Motion</option>
                          </select>
                        )}

                        <button
                          type="button"
                          onClick={() => handleUpdateChannel(ch.id, { originShield: !ch.originShield })}
                          className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                            ch.originShield
                              ? 'bg-emerald-950/40 border-emerald-800/70 text-emerald-300'
                              : 'bg-[#0B111E] border-slate-700 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <Shield className="w-3.5 h-3.5" />
                          <span>{ch.originShield ? 'Shield On' : 'Shield Off'}</span>
                        </button>

                        {ch.status === 'stopped' ? (
                          <button
                            type="button"
                            onClick={() => handleStartChannel(ch.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors cursor-pointer"
                          >
                            <Play className="w-3.5 h-3.5" />
                            <span>Start</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleStopChannel(ch.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[#0B111E] border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
                          >
                            <Square className="w-3.5 h-3.5 text-amber-400" />
                            <span>Stop</span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => {
                            setSelectedChannelId(ch.id);
                            setActiveTab('monitor');
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[#0B111E] border border-slate-700 text-blue-300 hover:bg-slate-800 transition-colors cursor-pointer"
                        >
                          <Radio className="w-3.5 h-3.5" />
                          <span>Watch</span>
                        </button>

                        {ch.id !== 'orin-live-01' && (
                          <button
                            type="button"
                            onClick={() => handleDeleteChannel(ch.id)}
                            aria-label={`Delete ${ch.name}`}
                            className="p-2 text-xs rounded-lg bg-[#0B111E] border border-slate-700 text-slate-400 hover:text-red-400 hover:border-red-900/70 transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </main>
      </div>

      <NewOriginModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreate={handleCreateChannel}
      />
    </div>
  );
}
