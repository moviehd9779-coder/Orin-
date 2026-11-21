import type { EdgePop } from '../types';

interface EdgeTopologyMapProps {
  pops: EdgePop[];
  selectedPopId: string;
  originShieldEnabled: boolean;
  onSelectPop: (popId: string) => void;
}

const ORIGIN_COORDS = { x: 262, y: 196 };
const SHIELD_COORDS = { x: 292, y: 170 };

export function EdgeTopologyMap({
  pops,
  selectedPopId,
  originShieldEnabled,
  onSelectPop,
}: EdgeTopologyMapProps) {
  const activePopId = selectedPopId === 'anycast' ? 'iad-01' : selectedPopId;

  return (
    <div className="bg-[#111827] border border-slate-800 rounded-xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h3 className="text-base font-semibold text-slate-100">Global Origin-to-Edge Routing Topology</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Click any regional Point of Presence to pin live HLS segment delivery to that edge node.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs text-slate-400">
          <span>Origin: us-east-origin</span>
          <span aria-hidden="true">·</span>
          <span>Shield: {originShieldEnabled ? 'iad-shield-01 Active' : 'Direct to Origin'}</span>
        </div>
      </div>

      <div className="relative w-full bg-[#0B111E] border border-slate-800/80 rounded-lg overflow-hidden">
        <svg
          viewBox="0 0 1000 460"
          className="w-full h-auto block select-none"
          role="img"
          aria-label="Global CDN Edge PoP routing map"
        >
          {/* Subtle latitude / longitude grid */}
          <g stroke="#1E293B" strokeWidth="0.6" strokeDasharray="3 4" opacity="0.55">
            <line x1="0" y1="115" x2="1000" y2="115" />
            <line x1="0" y1="230" x2="1000" y2="230" />
            <line x1="0" y1="345" x2="1000" y2="345" />
            <line x1="200" y1="0" x2="200" y2="460" />
            <line x1="400" y1="0" x2="400" y2="460" />
            <line x1="600" y1="0" x2="600" y2="460" />
            <line x1="800" y1="0" x2="800" y2="460" />
          </g>

          {/* Simplified clean geometric landmass silhouettes */}
          <g fill="#162033" stroke="#23314D" strokeWidth="1">
            {/* North America */}
            <path d="M95,110 L180,95 L265,105 L315,135 L290,195 L240,220 L215,245 L175,235 L145,195 L105,160 Z" />
            {/* South America */}
            <path d="M260,265 L325,260 L375,305 L350,375 L310,420 L285,390 L270,320 Z" />
            {/* Europe */}
            <path d="M445,105 L525,95 L560,130 L540,170 L465,175 L445,150 Z" />
            {/* Africa */}
            <path d="M455,195 L535,190 L575,245 L545,355 L495,365 L465,285 L440,235 Z" />
            {/* Asia */}
            <path d="M555,95 L745,85 L865,130 L850,210 L785,260 L725,275 L665,240 L595,220 L555,170 Z" />
            {/* Australia */}
            <path d="M785,320 L875,315 L905,365 L865,405 L795,385 Z" />
          </g>

          {/* Origin -> Shield -> Edge PoP routing arcs */}
          {pops.map((pop) => {
            const isSelected = pop.id === activePopId;
            const source = originShieldEnabled ? SHIELD_COORDS : ORIGIN_COORDS;
            const midX = (source.x + pop.coords.x) / 2;
            const midY = Math.min(source.y, pop.coords.y) - 28;
            return (
              <path
                key={`arc-${pop.id}`}
                d={`M ${source.x} ${source.y} Q ${midX} ${midY} ${pop.coords.x} ${pop.coords.y}`}
                fill="none"
                stroke={isSelected ? '#3B82F6' : '#334155'}
                strokeWidth={isSelected ? 2 : 1}
                strokeDasharray={isSelected ? undefined : '4 4'}
                opacity={isSelected ? 0.95 : 0.65}
              />
            );
          })}

          {/* Origin to Shield link */}
          {originShieldEnabled && (
            <line
              x1={ORIGIN_COORDS.x}
              y1={ORIGIN_COORDS.y}
              x2={SHIELD_COORDS.x}
              y2={SHIELD_COORDS.y}
              stroke="#16A34A"
              strokeWidth="2"
            />
          )}

          {/* Origin Node */}
          <g transform={`translate(${ORIGIN_COORDS.x}, ${ORIGIN_COORDS.y})`}>
            <rect x="-6" y="-6" width="12" height="12" rx="2" fill="#D97706" stroke="#FEF3C7" strokeWidth="1.2" />
            <text x="-12" y="20" textAnchor="end" className="fill-amber-300 text-[11px] font-mono">
              ORIGIN
            </text>
          </g>

          {/* Shield Node */}
          {originShieldEnabled && (
            <g transform={`translate(${SHIELD_COORDS.x}, ${SHIELD_COORDS.y})`}>
              <polygon points="0,-7 7,0 0,7 -7,0" fill="#16A34A" stroke="#DCFCE7" strokeWidth="1.2" />
              <text x="11" y="-6" className="fill-emerald-300 text-[10px] font-mono">
                SHIELD
              </text>
            </g>
          )}

          {/* Edge PoPs */}
          {pops.map((pop) => {
            const isSelected = pop.id === activePopId;
            const totalReqs = pop.hits + pop.shieldHits + pop.misses;
            return (
              <g
                key={pop.id}
                transform={`translate(${pop.coords.x}, ${pop.coords.y})`}
                onClick={() => onSelectPop(pop.id)}
                className="cursor-pointer"
                role="button"
                tabIndex={0}
                aria-label={`Route stream to ${pop.id} ${pop.city}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectPop(pop.id);
                  }
                }}
              >
                {isSelected && (
                  <circle r="13" fill="#3B82F6" opacity="0.2" />
                )}
                <circle
                  r={isSelected ? 6.5 : 5}
                  fill={isSelected ? '#3B82F6' : totalReqs > 0 ? '#16A34A' : '#64748B'}
                  stroke="#F8FAFC"
                  strokeWidth={isSelected ? 1.8 : 1}
                />
                <text
                  x="0"
                  y="-11"
                  textAnchor="middle"
                  className={`text-[11px] font-mono ${isSelected ? 'fill-blue-300 font-semibold' : 'fill-slate-300'}`}
                >
                  {pop.id}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
