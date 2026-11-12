"use client";

import { useState } from "react";
import { actionCreators } from "@near-wallet-selector/core";
import { useApp } from "./Providers";
import { Card, ConnectHint, Note, nextAuctionText, useAction } from "./ui";
import { assertAuctionOpen, TGAS, VAULT, view } from "@/lib/near";
import { bps, near, toYocto } from "@/lib/format";
import { bidMessage, ORIGINS, previewRoute, WNEAR_TESTNET, type RoutePreview } from "@/lib/intents";

const STORAGE = 10n ** 22n; // the vault's bid storage reserve, refunded unused
const WRAP_STORAGE = 1_250_000_000_000_000_000_000n; // wrap.testnet registration

/** Bid from another chain: 1Click route preview + the testnet delivery leg. */
export function IntentsCard() {
  const { chain, wallet } = useApp();
  const { busy, note, run } = useAction();
  const [amount, setAmount] = useState("1");
  const [origin, setOrigin] = useState(ORIGINS[0].id);
  const [preview, setPreview] = useState<RoutePreview | null>(null);
  const [quotedFor, setQuotedFor] = useState(0n);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const e = chain.epoch;
  if (!e) return null;
  const open = e.phase === "Auction" && chain.now < Number(e.auction_end);
  const maxBps = Math.min(e.params.premium_start_bps, e.current_premium_bps + 10);
  let notional = 0n;
  let wnear = 0n;
  try {
    notional = toYocto(amount);
    wnear = (notional * BigInt(maxBps)) / 10_000n + STORAGE;
  } catch {
    wnear = 0n;
  }
  const beneficiary = wallet.accountId ?? "<your account>";
  const msg = notional > 0n ? bidMessage(notional, maxBps, beneficiary) : "";
  const o = ORIGINS.find((x) => x.id === origin)!;

  const quote = async () => {
    setPreviewing(true);
    setPreview(null);
    setPreviewError(null);
    try {
      setQuotedFor(wnear);
      setPreview(await previewRoute(o, wnear));
    } catch (err) {
      setPreviewError((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const sendOnTestnet = () =>
    run("wNEAR bid", async () => {
      const sel = wallet.selector!;
      await assertAuctionOpen();
      const registered = await view<unknown>(WNEAR_TESTNET, "storage_balance_of", { account_id: wallet.accountId });
      const actions = [
        ...(registered ? [] : [actionCreators.functionCall("storage_deposit", { account_id: wallet.accountId }, 10n * TGAS, WRAP_STORAGE)]),
        actionCreators.functionCall("near_deposit", {}, 10n * TGAS, wnear),
        actionCreators.functionCall("ft_transfer_call", { receiver_id: VAULT, amount: wnear.toString(), msg }, 250n * TGAS, 1n),
      ];
      const w = await sel.wallet();
      await w.signAndSendTransaction({ receiverId: WNEAR_TESTNET, actions });
    });

  return (
    <Card title="Bid from another chain" aside="NEAR Intents">
      <div className="body">
        <p className="sub">
          Hold USDC somewhere else? 1Click swaps it into exactly the wNEAR this bid needs and delivers it to the vault
          with <b>ft_transfer_call</b> and the message below. The vault unwraps it and runs the same bid; refunds and
          any payout go to the beneficiary&apos;s NEAR account.
        </p>
        <label className="field">
          <span>Notional NEAR</span>
          <input value={amount} onChange={(v) => { setAmount(v.target.value); setPreview(null); }} inputMode="decimal" />
        </label>
        <label className="field">
          <span>Pay with</span>
          <select value={origin} onChange={(v) => { setOrigin(v.target.value); setPreview(null); }}>
            {ORIGINS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
        <p className="sub">
          Needs <b>{near(wnear)} wNEAR</b>: the premium at {bps(maxBps)} plus the 0.01 storage reserve, unused part refunded.
        </p>
        <div className="actions">
          <button className="ghost" disabled={previewing || wnear === 0n} onClick={quote}>
            {previewing ? "Quoting…" : "Live route quote"}
          </button>
          <button disabled={!wallet.accountId || !open || busy || wnear === 0n} onClick={sendOnTestnet}>
            Deliver on testnet
          </button>
        </div>
        {preview && (
          <p className="note">
            1Click, mainnet, now: <b>{preview.amountIn}</b> {o.label} buys exactly {near(preview.wnear)} wNEAR in about {preview.timeEstimate}s.
            {preview.atMinimum && (
              <> This route has a minimum above the {near(quotedFor)} wNEAR the bid needed, so the quote is for that minimum.</>
            )}
            {quotedFor !== wnear && (
              <> The premium has moved since: the bid now needs {near(wnear)} wNEAR, so quote again for a current price.</>
            )}
          </p>
        )}
        {previewError && <p className="note bad">Route quote: {previewError}</p>}
        <span className="k" style={{ marginTop: 14 }}>customRecipientMsg</span>
        <pre className="code">{msg}</pre>
        <p className="sub">
          The quote is a live <b>dry</b> quote from 1Click on mainnet: nothing moves, no deposit address is issued. 1Click
          does not run on testnet, so here the delivery leg is made from your wallet through {WNEAR_TESTNET}: the same
          call, the same message, the same code path in the vault.
        </p>
        {!open && <p className="sub">No auction is running right now.{e ? ` The next one ${nextAuctionText(e, chain.now)}.` : ""}</p>}
        <ConnectHint />
        <Note note={note} />
      </div>
    </Card>
  );
}
