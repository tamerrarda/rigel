"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { StarCanvas } from "@/components/StarCanvas";
import { readEpoch, readPrice, readRounds, type Epoch, type Price } from "@/lib/near";
import { near, usd } from "@/lib/format";
import "./landing.css";

const REPO = "https://github.com/tamerrarda/rigel";

const SECTIONS: { id: string; k: string; title: string; body: string; align: "left" | "right" | "center" }[] = [
  {
    id: "trade",
    k: "01 · yield",
    title: "Premium in. Upside capped.",
    body: "Buyers pay you up front and you keep it either way. Above the strike, they get the excess.",
    align: "right",
  },
  {
    id: "auction",
    k: "02 · pricing",
    title: "A falling price, open to everyone.",
    body: "Each round's premium starts high and slides down until someone buys. No quotes, no gatekeepers.",
    align: "left",
  },
  {
    id: "close",
    k: "03 · settlement",
    title: "Expiry has a window, not a judge.",
    body: "The first price published after expiry settles the round. Anyone can trigger it, nobody can steer it.",
    align: "center",
  },
  {
    id: "intents",
    k: "04 · NEAR Intents",
    title: "Built for bids from other chains.",
    body: "The vault takes bids as wNEAR, the token NEAR Intents delivers. Testnet runs that leg live; the app quotes the USDC route from Arbitrum, Solana or Base.",
    align: "right",
  },
  {
    id: "oracle",
    k: "05 · trust",
    title: "One trusted feed, labeled as one.",
    body: "Pyth is down on NEAR, so testnet reads a stand-in in Pyth's format. One deploy argument switches it back.",
    align: "left",
  },
];

function useLive() {
  const [epoch, setEpoch] = useState<Epoch | null>(null);
  const [price, setPrice] = useState<Price | null>(null);
  const [rounds, setRounds] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [e, p, r] = await Promise.all([readEpoch(), readPrice(), readRounds()]);
        if (!live) return;
        setEpoch(e);
        setPrice(p);
        setRounds(r.length);
      } catch {
        /* the page reads fine without live numbers */
      }
    };
    load();
    const id = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return { epoch, price, rounds };
}

export default function Landing() {
  const { epoch, price, rounds } = useLive();
  const pps = epoch ? (Number(BigInt(epoch.last_pps)) / 1e12).toFixed(5) : "–";

  return (
    <div className="landing">
      <StarCanvas />
      <header className="l-top">
        <Link className="l-brand" href="/">
          <img src="/rigel-mark.svg" alt="" width={24} height={24} />
          <span>RIGEL</span>
        </Link>
        <nav className="l-nav">
          <a href={REPO} target="_blank" rel="noreferrer">Code</a>
          <Link className="l-launch" href="/app/">Open the app</Link>
        </nav>
      </header>

      <section className="l-hero l-center">
        <span className="l-kicker">Rigel · covered calls on NEAR</span>
        <h1>Your NEAR underwrites calls. Buyers pay you for it.</h1>
        <p>A covered call on pooled NEAR, auctioned every round. Bids in NEAR or as wNEAR from NEAR Intents, premiums to the pool.</p>
        <div className="l-ctas">
          <Link className="l-launch big" href="/app/">Open the app</Link>
          <a className="l-ghost" href={REPO} target="_blank" rel="noreferrer">Read the code</a>
        </div>

        <dl className="l-live" aria-label="Live from NEAR testnet">
          <div>
            <dt>Round</dt>
            <dd>{epoch ? (epoch.round || "–") : "–"}</dd>
            <small>{epoch ? epoch.phase.toLowerCase() : "reading the chain"}</small>
          </div>
          <div>
            <dt>NEAR/USD</dt>
            <dd>{price ? usd(price.price, price.expo) : "–"}</dd>
            <small>exchange median</small>
          </div>
          <div>
            <dt>Pool</dt>
            <dd>{epoch ? near(epoch.locked_assets, 2) : "–"}</dd>
            <small>NEAR at work</small>
          </div>
          <div>
            <dt>Share price</dt>
            <dd>{pps}</dd>
            <small>{rounds !== null ? `after ${rounds} finished round${rounds === 1 ? "" : "s"}` : "NEAR per share"}</small>
          </div>
        </dl>
        <span className="l-live-note">live from vault.rigel-demo.testnet</span>
      </section>

      {SECTIONS.map((s) => (
        <section className={`l-section l-${s.align}`} id={s.id} key={s.id}>
          <span className="l-kicker">{s.k}</span>
          <h2>{s.title}</h2>
          <p>{s.body}</p>
        </section>
      ))}

      <section className="l-section l-final l-center">
        <h2>Running on NEAR testnet right now.</h2>
        <p>Deposit, bid, or close a round yourself. Pre-alpha, unaudited.</p>
        <div className="l-ctas">
          <Link className="l-launch big" href="/app/">Open the app</Link>
          <a className="l-ghost" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </section>

      <footer className="l-foot">
        Built for NEAR HACKATHON · Apache-2.0 · testnet only
      </footer>
    </div>
  );
}
