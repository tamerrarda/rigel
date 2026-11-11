"use client";

import { useState } from "react";
import type { Epoch } from "@/lib/near";
import { clock, span } from "@/lib/format";
import { useApp } from "./Providers";

/** A card with the uppercase title bar. */
export function Card({ title, aside, children, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <article className={`card ${className ?? ""}`}>
      <h2>
        <span>{title}</span>
        {aside && <em>{aside}</em>}
      </h2>
      {children}
    </article>
  );
}

export function Stat({ k, v, cap, hot }: { k: string; v: React.ReactNode; cap?: React.ReactNode; hot?: boolean }) {
  return (
    <div>
      <span className="k">{k}</span>
      <span className={hot ? "val hot" : "val"}>{v}</span>
      {cap && <span className="cap">{cap}</span>}
    </div>
  );
}

export function PageHead({ title, tag, children, right }: { title: string; tag?: string; children?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="head">
      <div>
        <div className="title-row">
          <h1>{title}</h1>
          {tag && <span className="tag">{tag}</span>}
        </div>
        {children}
      </div>
      {right && <div className="spot">{right}</div>}
    </div>
  );
}

/** What the vault is doing right now, in one line. */
export function phaseFace(e: Epoch, now: number): { label: string; note: string; tone: string } {
  if (e.round === 0) return { label: "Waiting", note: "No round has run yet.", tone: "idle" };
  if (e.phase === "Auction") {
    return { label: "Auction", note: `Premium falling. Ends in ${span(Number(e.auction_end) - now)}.`, tone: "hot" };
  }
  if (e.phase === "Active") {
    const left = Number(e.expiry) - now;
    if (left > 0) return { label: "Option live", note: `Expires in ${span(left)}, at ${clock(e.expiry)}.`, tone: "live" };
    return { label: "Settling", note: `Expired. A price inside the window settles it, until ${clock(e.settle_window_end)}.`, tone: "hot" };
  }
  const wait = Number(e.next_open_at) - now;
  return wait > 0
    ? { label: "Idle", note: `Next round can open in ${span(wait)}.`, tone: "idle" }
    : { label: "Idle", note: "A round can open now; anyone may open it.", tone: "idle" };
}

export function Phase() {
  const { chain } = useApp();
  if (!chain.epoch) return null;
  const f = phaseFace(chain.epoch, chain.now);
  return (
    <div className="phase" data-tone={f.tone}>
      <strong>{f.label}</strong>
      <span>{f.note}</span>
    </div>
  );
}

/** Runs one wallet call at a time and reports what happened. */
export function useAction() {
  const { chain } = useApp();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      setNote({ ok: true, text: `${label}: done` });
    } catch (e) {
      setNote({ ok: false, text: `${label}: ${(e as Error).message}` });
    } finally {
      setBusy(false);
      chain.refresh();
    }
  };
  return { busy, note, run };
}

export function Note({ note }: { note: { ok: boolean; text: string } | null }) {
  if (!note) return null;
  return <p className={note.ok ? "note" : "note bad"}>{note.text}</p>;
}

export function ConnectHint() {
  const { wallet } = useApp();
  if (wallet.accountId) return null;
  return (
    <p className="sub">
      <button className="link" onClick={() => wallet.modal?.show()}>Connect a testnet wallet</button> to act.
    </p>
  );
}
