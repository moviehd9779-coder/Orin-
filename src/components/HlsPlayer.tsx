import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Radio,
  Copy,
  Check,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { EdgePop, OriginChannel } from '../types';

export interface PlayerTelemetry {
  currentLevelIndex: number;
  levels: { index: number; height: number; width: number; bitrate: number }[];
  bufferLengthSec: number;
  liveLatencySec: number;
  isPlaying: boolean;
  isBuffering: boolean;
  droppedFrames: number;
  error: string | null;
}

interface HlsPlayerProps {
  channel: OriginChannel | null;
  selectedPopId: string;
  pops: EdgePop[];
  onSelectPop: (popId: string) => void;
  onPurgeEdge: (popId: string, channelId: string) => Promise<void>;
  onTelemetry: (telemetry: PlayerTelemetry) => void;
  onStartChannel: (channelId: string) => Promise<void>;
}

export function HlsPlayer({
  channel,
  selectedPopId,
  pops,
  onSelectPop,
  onPurgeEdge,
  onTelemetry,
  onStartChannel,
}: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isBuffering, setIsBuffering] = useState(true);
  const [levels, setLevels] = useState<{ index: number; height: number; width: number; bitrate: number }[]>([]);
  const [selectedLevel, setSelectedLevel] = useState<number>(-1);
  const [currentLevelIndex, setCurrentLevelIndex] = useState<number>(-1);
  const [liveLatencySec, setLiveLatencySec] = useState<number>(0);
  const [bufferLengthSec, setBufferLengthSec] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [purging, setPurging] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const relativeStreamPath = channel ? `/cdn/${selectedPopId}/${channel.id}/master.m3u8` : '';
  const fullStreamUrl =
    typeof window !== 'undefined' && relativeStreamPath
      ? `${window.location.origin}${relativeStreamPath}`
      : relativeStreamPath;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !channel || channel.status === 'stopped') {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      setIsBuffering(false);
      setIsPlaying(false);
      return;
    }

    setErrorMsg(null);
    setIsBuffering(true);
    setLevels([]);
    setSelectedLevel(-1);
    setCurrentLevelIndex(-1);

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const streamUrl = `/cdn/${selectedPopId}/${channel.id}/master.m3u8`;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 6,
        maxBufferLength: 12,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 800,
      });

      hlsRef.current = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
        const mapped = data.levels.map((lvl, idx) => ({
          index: idx,
          height: lvl.height || 0,
          width: lvl.width || 0,
          bitrate: lvl.bitrate || 0,
        }));
        setLevels(mapped);
        setIsBuffering(false);
        video.muted = isMuted;
        video.play().catch(() => {
          // Autoplay blocked if unmuted; user can click play
        });
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
        setCurrentLevelIndex(data.level);
      });

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setErrorMsg('Waiting for origin segments or network retry.');
            setTimeout(() => {
              if (hlsRef.current === hls) {
                hls.startLoad();
              }
            }, 1500);
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            setErrorMsg(data.details || 'Playback error encountered.');
            hls.destroy();
          }
        }
      });

      return () => {
        hls.destroy();
        if (hlsRef.current === hls) {
          hlsRef.current = null;
        }
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl;
      video.play().catch(() => {});
    } else {
      setErrorMsg('HLS playback is not supported in this browser.');
    }
  }, [channel?.id, channel?.status, selectedPopId, reloadNonce]);

  // Keep mute synced without reloading stream
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = isMuted;
    }
  }, [isMuted]);

  // Poll video buffer & live latency telemetry at 500ms
  useEffect(() => {
    const timer = setInterval(() => {
      const video = videoRef.current;
      const hls = hlsRef.current;
      if (!video) return;

      let bufLen = 0;
      if (video.buffered.length > 0) {
        const end = video.buffered.end(video.buffered.length - 1);
        bufLen = Math.max(0, end - video.currentTime);
      }
      const latency = hls && typeof hls.latency === 'number' && !Number.isNaN(hls.latency) ? hls.latency : 0;
      const quality = video.getVideoPlaybackQuality?.();
      const dropped = quality ? quality.droppedVideoFrames : 0;

      setBufferLengthSec(bufLen);
      setLiveLatencySec(latency);

      onTelemetry({
        currentLevelIndex: hls ? hls.currentLevel : currentLevelIndex,
        levels,
        bufferLengthSec: bufLen,
        liveLatencySec: latency,
        isPlaying: !video.paused && !video.ended,
        isBuffering,
        droppedFrames: dropped,
        error: errorMsg,
      });
    }, 500);

    return () => clearInterval(timer);
  }, [levels, currentLevelIndex, isBuffering, errorMsg, onTelemetry]);

  const handlePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const handleLevelChange = (levelIdx: number) => {
    setSelectedLevel(levelIdx);
    if (hlsRef.current) {
      hlsRef.current.nextLevel = levelIdx;
    }
  };

  const handleJumpToLive = () => {
    const video = videoRef.current;
    const hls = hlsRef.current;
    if (!video) return;
    if (hls && hls.liveSyncPosition) {
      video.currentTime = hls.liveSyncPosition;
    } else if (video.seekable.length > 0) {
      video.currentTime = video.seekable.end(video.seekable.length - 1);
    }
    video.play().catch(() => {});
  };

  const handleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  };

  const handleCopyUrl = async () => {
    if (!fullStreamUrl) return;
    try {
      await navigator.clipboard.writeText(fullStreamUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      // Fallback ignored
    }
  };

  const handlePurge = async () => {
    if (!channel) return;
    setPurging(true);
    try {
      await onPurgeEdge(selectedPopId, channel.id);
    } finally {
      setPurging(false);
    }
  };

  const activeLevelObj = levels.find((l) => l.index === currentLevelIndex);

  return (
    <section className="bg-[#111827] border border-slate-800 rounded-xl overflow-hidden">
      {/* Control Toolbar above Monitor */}
      <div className="px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            {channel?.status === 'live' && isPlaying && (
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" aria-label="Live stream active" />
            )}
            <h2 className="text-base font-semibold text-slate-100 truncate">
              {channel ? channel.name : 'No Channel Selected'}
            </h2>
          </div>
          {channel && (
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400 tabular-nums">
              <span>{channel.type === 'local-ffmpeg' ? 'Local ABR Origin' : 'External HLS Relay'}</span>
              <span aria-hidden="true">·</span>
              <span>{activeLevelObj ? `${activeLevelObj.height}p (${Math.round(activeLevelObj.bitrate / 1000)} kbps)` : 'Adaptive Bitrate'}</span>
              <span aria-hidden="true">·</span>
              <span>{channel.originShield ? 'Origin Shield On' : 'Origin Shield Off'}</span>
              <span aria-hidden="true">·</span>
              <span>PoP: {selectedPopId === 'anycast' ? 'Anycast (iad-01)' : selectedPopId}</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <label className="sr-only" htmlFor="edge-pop-select">
            Select Edge PoP
          </label>
          <select
            id="edge-pop-select"
            value={selectedPopId}
            onChange={(e) => onSelectPop(e.target.value)}
            className="bg-[#0B111E] border border-slate-700 text-slate-200 text-xs font-medium rounded-lg px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <option value="anycast">Global Anycast (Auto)</option>
            {pops.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {p.city} ({p.baseLatencyMs}ms)
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={handlePurge}
            disabled={!channel || purging}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-[#0B111E] border border-slate-700 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5 text-slate-400" />
            <span>{purging ? 'Purging...' : 'Purge Edge'}</span>
          </button>

          <button
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            disabled={!channel}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-[#0B111E] border border-slate-700 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
            <span>Reconnect</span>
          </button>
        </div>
      </div>

      {/* Video Viewport */}
      <div ref={containerRef} className="relative bg-black aspect-video w-full group">
        <video
          ref={videoRef}
          className="w-full h-full object-contain bg-black"
          playsInline
          muted={isMuted}
          onPlay={() => {
            setIsPlaying(true);
            setIsBuffering(false);
          }}
          onPause={() => setIsPlaying(false)}
          onWaiting={() => setIsBuffering(true)}
          onPlaying={() => setIsBuffering(false)}
        />

        {/* Stopped or Starting Overlay */}
        {channel && channel.status === 'stopped' && (
          <div className="absolute inset-0 bg-[#0B111E]/95 flex flex-col items-center justify-center p-6 text-center">
            <p className="text-sm font-medium text-slate-200">Origin encoder is currently stopped</p>
            <p className="mt-1 text-xs text-slate-400 max-w-md">
              Start the origin pipeline to begin segmenting and publishing live HLS playlists to global Edge PoPs.
            </p>
            <button
              type="button"
              onClick={() => onStartChannel(channel.id)}
              className="mt-4 px-4 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors cursor-pointer"
            >
              Start Origin Stream
            </button>
          </div>
        )}

        {channel && channel.status !== 'stopped' && (isBuffering || errorMsg) && (
          <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center bg-black/45">
            <div className="px-4 py-2.5 rounded-lg bg-[#0B111E]/90 border border-slate-700 text-xs text-slate-200 flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-400" />
              <span>{errorMsg || 'Syncing live HLS segments from Edge PoP...'}</span>
            </div>
          </div>
        )}

        {/* Measured Gradient Scrim Controls */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent pt-10 pb-3.5 px-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePlayPause}
              aria-label={isPlaying ? 'Pause stream' : 'Play stream'}
              className="p-2 rounded-lg bg-slate-900/80 hover:bg-slate-800 text-white border border-white/10 transition-colors cursor-pointer"
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={() => setIsMuted((m) => !m)}
              aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
              className="p-2 rounded-lg bg-slate-900/80 hover:bg-slate-800 text-white border border-white/10 transition-colors cursor-pointer"
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={handleJumpToLive}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900/80 hover:bg-slate-800 text-xs font-medium text-slate-100 border border-white/10 transition-colors tabular-nums cursor-pointer"
            >
              <Radio className="w-3.5 h-3.5 text-emerald-400" />
              <span>Live Edge ({liveLatencySec.toFixed(1)}s)</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-slate-300 tabular-nums hidden sm:inline">
              Buffer {bufferLengthSec.toFixed(1)}s
            </span>

            <select
              aria-label="Select video quality"
              value={selectedLevel}
              onChange={(e) => handleLevelChange(Number(e.target.value))}
              className="bg-slate-900/90 border border-white/15 text-slate-100 text-xs font-mono rounded-lg px-2.5 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <option value={-1}>Auto ABR</option>
              {levels.map((lvl) => (
                <option key={lvl.index} value={lvl.index}>
                  {lvl.height ? `${lvl.height}p` : `Level ${lvl.index}`} ({Math.round(lvl.bitrate / 1000)}k)
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={handleFullscreen}
              aria-label="Toggle fullscreen"
              className="p-2 rounded-lg bg-slate-900/80 hover:bg-slate-800 text-white border border-white/10 transition-colors cursor-pointer"
            >
              <Maximize className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Shareable Edge Playback Endpoint Footer */}
      {channel && (
        <div className="px-5 py-3 bg-[#0E1525] border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <span className="text-xs font-medium text-slate-400 whitespace-nowrap">Edge Playback URL</span>
            <code className="text-xs font-mono text-blue-300 truncate bg-[#0B111E] border border-slate-800 px-2.5 py-1 rounded">
              {fullStreamUrl}
            </code>
          </div>
          <button
            type="button"
            onClick={handleCopyUrl}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#161F30] hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedUrl ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-slate-400" />}
            <span>{copiedUrl ? 'Copied' : 'Copy URL'}</span>
          </button>
        </div>
      )}
    </section>
  );
}
