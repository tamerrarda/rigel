"use client";

import { useApp } from "@/components/Providers";
import { Card, ConnectHint, Note, PageHead, Stat, useAction } from "@/components/ui";
import { callVault } from "@/lib/near";
import { near } from "@/lib/format";

export default function ClaimsPage() {
  const { chain, wallet } = useApp();
  const { busy, note, run } = useAction();
  const fills = chain.fills;
  const owed = fills.reduce((s, [, f]) => s + (f.claimed ? 0n : BigInt(f.claimable)), 0n);
  const paid = fills.reduce((s, [, f]) => s + BigInt(f.premium_paid), 0n);

  return (
    <>
      <PageHead title="Claims">
        <p className="sub">What your option fills are owed once their rounds finalize.</p>
      </PageHead>
      <div className="grid">
        <section>
          <Card title="Your fills" aside={wallet.accountId ?? "not connected"}>
            <div className="stats">
              <Stat k="Claimable" v={near(owed)} cap="NEAR, ready now" hot={owed > 0n} />
              <Stat k="Premium paid" v={near(paid)} cap="NEAR, all rounds" />
              <Stat k="Fills" v={fills.length} cap="rounds with a fill" />
            </div>
            {fills.length > 0 ? (
              <table className="table">
                <thead>
                  <tr><th>Round</th><th>Notional</th><th>Premium</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {fills.map(([n, f]) => {
                    const r = chain.rounds.find(([m]) => m === n)?.[1];
                    const status = f.claimed ? "claimed" : !r ? "round live" : BigInt(f.claimable) > 0n ? `${near(f.claimable)} NEAR owed` : "nothing owed";
                    return (
                      <tr key={n}>
                        <td>{n}</td>
                        <td>{near(f.notional, 2)}</td>
                        <td>{near(f.premium_paid)}</td>
                        <td><span className="pill" data-o={!f.claimed && BigInt(f.claimable) > 0n ? "claimable" : undefined}>{status}</span></td>
                        <td>
                          {!f.claimed && BigInt(f.claimable) > 0n && (
                            <button className="small" disabled={busy} onClick={() => run(`Claim round ${n}`, () => callVault(wallet.selector!, "claim_payout", { round: n }))}>
                              Claim
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="body"><p className="sub">No fills for this account.</p></div>
            )}
            <div className="body">
              <ConnectHint />
              <Note note={note} />
            </div>
          </Card>
        </section>
        <section>
          <Card title="How a payout is computed">
            <div className="body">
              <p className="sub">
                The option is cash-settled in NEAR. Above the strike, a fill of <b>N</b> NEAR notional is owed{" "}
                <b>N × (spot − strike) / spot</b> NEAR. It can never exceed the notional, so the pool can always pay it.
              </p>
              <p className="sub">
                A <b>Voided</b> round refunds the premium you paid. <b>Lapsed</b> and <b>Unresolved</b> rounds owe nothing.
                Claims never expire: each one is recomputed from the round&apos;s permanent record.
              </p>
            </div>
          </Card>
        </section>
      </div>
    </>
  );
}
