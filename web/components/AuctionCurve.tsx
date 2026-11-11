"use client";

import type { Epoch } from "@/lib/near";
import { bps } from "@/lib/format";

/** The descending premium line, with a marker at the current moment. */
export function AuctionCurve({ epoch, now }: { epoch: Epoch; now: number }) {
  const p = epoch.params;
  const start = Number(epoch.opened_at);
  const end = Number(epoch.auction_end);
  const W = 320;
  const H = 120;
  const pad = 12;
  const y = (v: number) => pad + (1 - v / p.premium_start_bps) * (H - 2 * pad);
  const x = (t: number) => pad + ((t - start) / Math.max(1, end - start)) * (W - 2 * pad);
  const live = epoch.phase === "Auction" && now < end;
  const t = Math.min(Math.max(now, start), end);
  const current = live ? epoch.current_premium_bps : null;

  return (
    <figure className="curve">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Premium falls linearly over the auction">
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="axis" />
        <line x1={x(start)} y1={y(p.premium_start_bps)} x2={x(end)} y2={y(p.premium_floor_bps)} className="line" vectorEffect="non-scaling-stroke" />
        {live && (
          <>
            <line x1={x(t)} y1={pad} x2={x(t)} y2={H - pad} className="now" />
            <circle cx={x(t)} cy={y(epoch.current_premium_bps)} r={4} className="dot" />
          </>
        )}
      </svg>
      <figcaption>
        <span>{bps(p.premium_start_bps)} at open</span>
        <span className="k">{current !== null ? `now ${bps(current)}` : "auction closed"}</span>
        <span>{bps(p.premium_floor_bps)} at close</span>
      </figcaption>
    </figure>
  );
}
