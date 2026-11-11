"use client";

import { useApp } from "@/components/Providers";
import { Card, PageHead, Phase, Stat } from "@/components/ui";
import { EXPLORER, VAULT, type Round } from "@/lib/near";
import { clock, near, span, usd } from "@/lib/format";

const OUTCOMES: [Round["outcome"], string][] = [
  ["Settled", "A price inside the settlement window decided it. Holders above the strike are paid; the premium stays."],
  ["Lapsed", "The auction ended with nothing sold. No premium, no payout, the pool is untouched."],
  ["Voided", "The price inside the window was unusable. Every premium is refunded in full; the pool is untouched."],
  ["Unresolved", "Nobody settled inside the window. No payout, the premium stays, and the oracle is never called."],
];

export default function RoundsPage() {
  const { chain } = useApp();
  const e = chain.epoch;
  return (
    <>
      <PageHead title="Rounds" tag={e?.round ? `latest: round ${e.round}` : undefined}>
        <Phase />
      </PageHead>
      <div className="grid">
        <section>{e && e.round > 0 && <Timeline />}</section>
        <section>
          <Card title="Four ways a round ends">
            <div className="body">
              {OUTCOMES.map(([o, t]) => (
                <p className="sub" key={o}>
                  <span className="pill" data-o={o.toLowerCase()}>{o}</span> {t}
                </p>
              ))}
              <p className="sub">All four are normal. Two of them pay nobody, and that is a data point, not a failure.</p>
            </div>
          </Card>
        </section>
      </div>
      <History />
    </>
  );
}

function Timeline() {
  const { chain } = useApp();
  const e = chain.epoch!;
  const rows: [string, string, number][] = [
    ["Opened", "strike set from a fresh price", Number(e.opened_at)],
    ["Auction ends", "premium has fallen to its floor", Number(e.auction_end)],
    ["Expiry", "the option's moment", Number(e.expiry)],
    ["Settlement window closes", "a price after this cannot settle", Number(e.expiry) + e.params.settle_window],
    ["Unresolved", "closes without calling the oracle", Number(e.expiry) + e.params.unresolved_after],
  ];
  return (
    <Card title={`Round ${e.round} timeline`}>
      <div className="stats">
        <Stat k="Strike" v={usd(e.strike, e.price_expo)} cap={`opened at ${usd(e.open_spot, e.price_expo)}`} />
        <Stat k="Sold" v={near(e.notional_sold, 2)} cap="NEAR notional" />
        <Stat k="Premium" v={near(e.premium_collected)} cap="NEAR" />
      </div>
      <table className="table">
        <tbody>
          {rows.map(([k, note, t]) => (
            <tr key={k} className={chain.now >= t ? "past" : ""}>
              <td>{k}</td>
              <td>{clock(t)}</td>
              <td className="dim">{chain.now >= t ? "passed" : `in ${span(t - chain.now)}`}</td>
              <td className="dim wrap">{note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function History() {
  const { chain } = useApp();
  return (
    <Card title="Every round, and how it ended" aside={<a href={`${EXPLORER}/address/${VAULT}`} target="_blank" rel="noreferrer">{VAULT}</a>} className="wide">
      {chain.rounds.length === 0 ? (
        <div className="body"><p className="sub">No round has finished yet.</p></div>
      ) : (
        <div className="scroll">
          <table className="table">
            <thead>
              <tr><th>Round</th><th>Outcome</th><th>Expiry</th><th>Strike</th><th>Spot</th><th>Sold</th><th>Premium</th><th>Paid out</th><th>Share price</th></tr>
            </thead>
            <tbody>
              {chain.rounds.map(([n, r]) => (
                <tr key={n}>
                  <td>{n}</td>
                  <td><span className="pill" data-o={r.outcome.toLowerCase()}>{r.outcome}</span></td>
                  <td>{clock(r.expiry)}</td>
                  <td>{usd(r.strike, r.price_expo)}</td>
                  <td>{r.outcome === "Settled" ? usd(r.settled_spot, r.price_expo) : "–"}</td>
                  <td>{near(r.notional_sold, 2)}</td>
                  <td>{near(r.premium)}</td>
                  <td>{near(r.payout_total)}</td>
                  <td>{(Number(BigInt(r.pps)) / 1e12).toFixed(6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
