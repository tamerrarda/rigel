"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { StarCanvas } from "@/components/StarCanvas";
import { readEpoch, readPrice, readRounds, type Epoch, type Price } from "@/lib/near";
import { near, usd } from "@/lib/format";
import "./landing.css";

const REPO = "https://github.com/tamerrarda/rigel";

const SECTIONS: { id: string; k: string; title: string; body: React.ReactNode }[] = [
  {
    id: "trade",
    k: "01 · where the yield comes from",
    title: "Premium in. Upside capped.",
    body: (
      <>
        Your NEAR backs a call that someone else buys. They pay up front, and that payment joins the pool the moment the
        auction ends. If NEAR finishes the round below the strike, nothing else happens. If it finishes above, the buyer
        is paid the excess in NEAR and the pool keeps what it was paid. That is the whole deal: steady income for the
        top of the move.
      </>
    ),
  },
  {
    id: "auction",
    k: "02 · how the call is priced",
    title: "A falling price, open to everyone.",
    body: (
      <>
        Every round opens a Dutch auction. The premium starts at its ceiling and slides toward a floor; the first buyers
        willing to pay it fill, in any size. Nobody quotes the vault a price, and a buyer cannot take an option that is
        already in the money.
      </>
    ),
  },
  {
    id: "close",
    k: "03 · how a round settles",
    title: "Expiry has a window, not a judge.",
    body: (
      <>
        NEAR&apos;s price feeds store a price only when someone publishes one. So Rigel settles on the first price published
        inside a short window after expiry. Anyone can trigger it and nobody can steer it. If nobody does, the round
        closes on its own later, without asking the oracle anything.
      </>
    ),
  },
  {
    id: "intents",
    k: "04 · NEAR Intents",
    title: "USDC on Solana. A bid on NEAR. One message.",
    body: (
      <>
        Buyers do not need to hold NEAR. Through 1Click, USDC on Arbitrum, Solana or Base turns into exactly the wNEAR a
        bid costs and lands in the vault carrying the bid itself. The vault unwraps it and treats it like any other bid,
        sending change and payouts to the buyer&apos;s NEAR account.
      </>
    ),
  },
  {
    id: "oracle",
    k: "05 · what you have to trust",
    title: "One trusted feed, labeled as one.",
    body: (
      <>
        Pyth stopped updating on NEAR in August. Until it is back, this testnet build reads a stand-in that speaks Pyth&apos;s
        exact format and publishes the median of Binance, Coinbase and Kraken. That feed is trusted. The vault contract is
        not, and switching it to Pyth is a deploy argument, not a code change.
      </>
    ),
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

      <section className="l-hero">
        <span className="l-kicker">Rigel · covered calls on NEAR</span>
        <h1>Your NEAR underwrites calls. Buyers on any chain pay you for it.</h1>
        <p>
          Rigel pools NEAR, writes a cash-settled call on it every round and auctions it off. Bids arrive in NEAR, or in
          USDC from other chains through NEAR Intents. Every premium goes to the pool.
        </p>
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
            <small>median of 3 exchanges</small>
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
        <section className="l-section" id={s.id} key={s.id}>
          <span className="l-kicker">{s.k}</span>
          <h2>{s.title}</h2>
          <p>{s.body}</p>
        </section>
      ))}

      <section className="l-section l-final">
        <h2>Running on NEAR testnet right now.</h2>
        <p>A keeper opens a round every few minutes. Deposit, bid, or close one yourself. Pre-alpha and unaudited, so testnet NEAR only.</p>
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
