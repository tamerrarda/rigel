"use client";

import { useState } from "react";
import Link from "next/link";
import { useApp } from "@/components/Providers";
import { AuctionCurve } from "@/components/AuctionCurve";
import { IntentsCard } from "@/components/IntentsCard";
import { Card, ConnectHint, Note, PageHead, Phase, Stat, nextAuctionText, useAction } from "@/components/ui";
import { assertAuctionOpen, callVault, TGAS } from "@/lib/near";
import { bps, near, toYocto, usd } from "@/lib/format";

const STORAGE = 10n ** 22n; // 0.01 NEAR, refunded unused

export default function VaultPage() {
  const { chain } = useApp();
  const e = chain.epoch;
  if (!e) return <p className="sub">Reading the vault…</p>;
  const pps = (Number(BigInt(e.last_pps)) / 1e12).toFixed(6);

  return (
    <>
      <PageHead
        title="NEAR covered call vault"
        tag={e.round ? `Round ${e.round}` : undefined}
        right={
          <>
            <span className="k">Price per share</span>
            <span className="big">{pps}</span>
          </>
        }
      >
        <Phase />
      </PageHead>
      {chain.error && <p className="note bad">Chain read failed: {chain.error}</p>}

      <div className="grid">
        <section>
          <RoundCard />
          <TradeCard />
          <Permissionless />
        </section>
        <section>
          <DepositCard />
          <BidCard />
          <IntentsCard />
        </section>
      </div>
    </>
  );
}

function RoundCard() {
  const { chain } = useApp();
  const e = chain.epoch!;
  const live = e.phase !== "Idle";
  const expo = e.price_expo;
  return (
    <Card title="This round" aside={live ? `strike ${bps(e.params.strike_bps_otm)} above open` : "no round live"}>
      <div className="stats">
        <Stat k="Strike" v={live ? usd(e.strike, expo) : "–"} cap={live ? `opened at ${usd(e.open_spot, expo)}` : "set when a round opens"} />
        <Stat k="Sold" v={live ? near(e.notional_sold, 2) : "–"} cap={live ? `of ${near(e.notional_offered, 2)} NEAR offered` : "NEAR notional"} />
        <Stat k="Premium" v={live ? near(e.premium_collected) : "–"} cap="NEAR to depositors" hot={live && BigInt(e.premium_collected) > 0n} />
      </div>
      <div className="stats">
        <Stat k="Pool" v={near(e.locked_assets, 2)} cap="NEAR at work" />
        <Stat k="Waiting" v={near(e.pending_deposits_total, 2)} cap="NEAR joining next round" />
        <Stat k="Shares" v={near(e.shares_outstanding, 2)} cap="rcNEAR outstanding" />
      </div>
      {e.round > 0 && (
        <div className="body">
          <span className="k">Auction</span>
          <AuctionCurve epoch={e} now={chain.now} />
        </div>
      )}
    </Card>
  );
}

function TradeCard() {
  return (
    <Card title="How a round pays out">
      <dl className="rows outcomes">
        <div>
          <dt>NEAR at or below the strike</dt>
          <dd>The call pays nothing. Depositors hold the same NEAR plus the premium.</dd>
        </div>
        <div>
          <dt>NEAR above the strike</dt>
          <dd>
            The buyer receives <b>notional × (spot − strike) / spot</b> NEAR from the pool. The premium still stays.
          </dd>
        </div>
      </dl>
      <div className="body">
        <p className="sub">
          Either way the premium is income for depositors. Its price is any gain NEAR makes beyond the strike that round.
        </p>
      </div>
    </Card>
  );
}

function Permissionless() {
  const { chain, wallet } = useApp();
  const { busy, note, run } = useAction();
  const e = chain.epoch!;
  const ready = !!wallet.selector && !!wallet.accountId;
  const canOpen = e.phase === "Idle" && chain.now >= Number(e.next_open_at) && BigInt(e.locked_assets) > 0n;
  const canClose = (e.phase === "Active" && chain.now >= Number(e.expiry)) || (e.outcome_pending && BigInt(e.notional_sold) === 0n);
  return (
    <Card title="Permissionless" aside={`closer earns ${bps(e.params.settle_bounty_bps)} of premium`}>
      <div className="body">
        <p className="sub">
          Opening and closing a round take no authorization. A keeper does it on a timer; anyone can do it instead, and
          whoever closes a round cannot choose how it ends.
        </p>
        <div className="actions">
          <button className="ghost" disabled={!ready || !canOpen || busy} onClick={() => run("Open round", () => callVault(wallet.selector!, "open_epoch", {}))}>
            Open round
          </button>
          <button className="ghost" disabled={!ready || !canClose || busy} onClick={() => run("Close round", () => callVault(wallet.selector!, "close_round", {}))}>
            Close round
          </button>
        </div>
        <Note note={note} />
      </div>
    </Card>
  );
}

function DepositCard() {
  const { chain, wallet } = useApp();
  const { busy, note, run } = useAction();
  const [amount, setAmount] = useState("1");
  const e = chain.epoch!;
  const live = e.phase !== "Idle";
  const ready = !!wallet.selector && !!wallet.accountId;
  return (
    <Card title="Deposit" aside={`min ${near(e.params.min_deposit, 0)} NEAR`}>
      <div className="body">
        <p className="sub">
          {live
            ? "A round is live, so a deposit waits and joins when it ends. You can cancel it at any time."
            : "No round is live, so a deposit mints shares now."}
        </p>
        <label className="field">
          <span>NEAR</span>
          <input value={amount} onChange={(v) => setAmount(v.target.value)} inputMode="decimal" />
        </label>
        <button
          disabled={!ready || busy}
          onClick={() =>
            run("Deposit", async () => {
              const y = toYocto(amount);
              await callVault(wallet.selector!, "deposit", { amount: y.toString() }, y + STORAGE, 50n * TGAS);
            })
          }
        >
          Deposit
        </button>
        <p className="sub">
          Shares, pending deposits and withdrawals are on <Link href="/app/positions/">My positions</Link>.
        </p>
        <ConnectHint />
        <Note note={note} />
      </div>
    </Card>
  );
}

function BidCard() {
  const { chain, wallet } = useApp();
  const { busy, note, run } = useAction();
  const [amount, setAmount] = useState("1");
  const [slack, setSlack] = useState(10);
  const e = chain.epoch!;
  const open = e.phase === "Auction" && chain.now < Number(e.auction_end);
  const ready = !!wallet.selector && !!wallet.accountId;
  const maxBps = Math.min(e.params.premium_start_bps, e.current_premium_bps + slack);
  let premiumMax = 0n;
  try {
    premiumMax = (toYocto(amount) * BigInt(maxBps)) / 10_000n;
  } catch {
    premiumMax = 0n;
  }
  return (
    <Card title="Buy the call" aside={open ? `premium now ${bps(e.current_premium_bps)}` : "auction closed"}>
      <div className="body">
        <p className="sub">
          Pay the premium now. If NEAR is above the strike at expiry you are paid the difference, in NEAR. Bids are
          refused while the price is already at or above the strike.
        </p>
        <label className="field">
          <span>Notional NEAR</span>
          <input value={amount} onChange={(v) => setAmount(v.target.value)} inputMode="decimal" />
        </label>
        <label className="field">
          <span>Slippage</span>
          <select value={slack} onChange={(v) => setSlack(Number(v.target.value))}>
            <option value={0}>none</option>
            <option value={5}>0.05%</option>
            <option value={10}>0.10%</option>
            <option value={25}>0.25%</option>
          </select>
        </label>
        <p className="sub">
          {open ? (
            <>
              Max premium <b>{bps(maxBps)}</b>, at most <b>{near(premiumMax)} NEAR</b>. Any unused part is refunded.
            </>
          ) : (
            <>
              No auction is running. The next one <b>{nextAuctionText(e, chain.now)}</b>. The keeper opens rounds about
              once a minute; anyone can open one from <i>Permissionless</i> once the idle gap has passed.
            </>
          )}
        </p>
        <button
          disabled={!ready || !open || busy}
          onClick={() =>
            run("Bid", async () => {
              const y = toYocto(amount);
              await assertAuctionOpen();
              await callVault(wallet.selector!, "bid", { notional: y.toString(), max_premium_bps: maxBps }, premiumMax + STORAGE);
            })
          }
        >
          Bid
        </button>
        <p className="sub">
          Your fills and payouts are on <Link href="/app/claims/">Claims</Link>.
        </p>
        <ConnectHint />
        <Note note={note} />
      </div>
    </Card>
  );
}
