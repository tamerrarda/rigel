"use client";

import { useState } from "react";
import { useApp } from "@/components/Providers";
import { Card, ConnectHint, Note, PageHead, Stat, useAction } from "@/components/ui";
import { callVault, TGAS } from "@/lib/near";
import { near, toYocto } from "@/lib/format";

const STORAGE = 10n ** 22n;

export default function PositionsPage() {
  const { chain, wallet } = useApp();
  const { busy, note, run } = useAction();
  const [shares, setShares] = useState("");
  const pos = chain.position;
  const e = chain.epoch;
  const live = !!e && e.phase !== "Idle";
  const sel = wallet.selector!;

  return (
    <>
      <PageHead title="My positions">
        <p className="sub">Your shares in the pool, and anything waiting to enter or leave it.</p>
      </PageHead>
      {!pos ? (
        <Card title="Not connected"><div className="body"><ConnectHint /></div></Card>
      ) : (
        <div className="grid">
          <section>
            <Card title="Shares" aside={wallet.accountId}>
              <div className="stats">
                <Stat k="Shares" v={near(pos.shares)} cap="rcNEAR, NEP-141" />
                <Stat k="Worth" v={near(pos.share_value)} cap="NEAR at the last share price" hot />
              </div>
              <div className="body">
                <p className="sub">
                  {live
                    ? "A round is live: a withdrawal burns the shares now and pays at this round's share price once it ends."
                    : "No round is live: a withdrawal pays out now."}
                </p>
                <label className="field">
                  <span>Shares</span>
                  <input placeholder={`all (${near(pos.shares)})`} value={shares} onChange={(v) => setShares(v.target.value)} inputMode="decimal" />
                </label>
                <button
                  disabled={busy || BigInt(pos.shares) === 0n}
                  onClick={() =>
                    run("Withdraw", async () => {
                      const y = shares.trim() ? toYocto(shares) : BigInt(pos.shares);
                      await callVault(sel, "request_withdraw", { shares: y.toString() }, STORAGE, 50n * TGAS);
                    })
                  }
                >
                  {live ? "Queue withdrawal" : "Withdraw"}
                </button>
              </div>
            </Card>
          </section>
          <section>
            <Card title="Pending deposit">
              <div className="body">
                {pos.pending_deposit ? (
                  <>
                    <p className="sub">
                      <b>{near(pos.pending_deposit.amount)} NEAR</b> made during round {pos.pending_deposit.round}.{" "}
                      {live ? "It joins the pool when the round ends." : "Redeem it for shares now, or cancel it."}
                    </p>
                    <div className="actions">
                      <button className="ghost" disabled={busy} onClick={() => run("Cancel", () => callVault(sel, "cancel_pending_deposit", {}))}>Cancel</button>
                      {!live && <button disabled={busy} onClick={() => run("Redeem", () => callVault(sel, "redeem_shares", {}))}>Redeem shares</button>}
                    </div>
                  </>
                ) : (
                  <p className="sub">None.</p>
                )}
              </div>
            </Card>
            <Card title="Queued withdrawal">
              <div className="body">
                {pos.pending_withdraw ? (
                  <>
                    <p className="sub">
                      <b>{near(pos.pending_withdraw.shares)} shares</b> burned in round {pos.pending_withdraw.round}.{" "}
                      {BigInt(pos.withdraw_claimable) > 0n
                        ? <>Ready: <b>{near(pos.withdraw_claimable)} NEAR</b>.</>
                        : "Paid at that round's share price once it finalizes."}
                    </p>
                    {BigInt(pos.withdraw_claimable) > 0n && (
                      <button disabled={busy} onClick={() => run("Claim withdrawal", () => callVault(sel, "claim_withdraw", {}))}>Claim</button>
                    )}
                  </>
                ) : (
                  <p className="sub">None.</p>
                )}
              </div>
            </Card>
            <Note note={note} />
          </section>
        </div>
      )}
    </>
  );
}
