"use client";

import { useCallback, useEffect, useState } from "react";
import {
  readBidder,
  readEpoch,
  readPosition,
  readPrice,
  readRounds,
  type BidderPosition,
  type Epoch,
  type Position,
  type Price,
  type Round,
} from "@/lib/near";

export interface Chain {
  epoch: Epoch | null;
  rounds: [number, Round][];
  price: Price | null;
  position: Position | null;
  /** The account's fills, newest round first, for every round with a fill. */
  fills: [number, BidderPosition][];
  now: number;
  error: string | null;
  refresh: () => void;
}

const POLL_MS = 5_000;

export function useChain(accountId: string | null): Chain {
  const [epoch, setEpoch] = useState<Epoch | null>(null);
  const [rounds, setRounds] = useState<[number, Round][]>([]);
  const [price, setPrice] = useState<Price | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [fills, setFills] = useState<[number, BidderPosition][]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [e, r, p] = await Promise.all([readEpoch(), readRounds(), readPrice()]);
      setEpoch(e);
      setRounds(r);
      setPrice(p);
      if (accountId) {
        setPosition(await readPosition(accountId));
        const live = e.round > 0 ? [e.round] : [];
        const ids = Array.from(new Set([...live, ...r.map(([n]) => n)]));
        const got = await Promise.all(ids.map(async (n) => [n, await readBidder(n, accountId)] as [number, BidderPosition]));
        setFills(got.filter(([, f]) => BigInt(f.notional) > 0n));
      } else {
        setPosition(null);
        setFills([]);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [accountId]);

  useEffect(() => {
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  return { epoch, rounds, price, position, fills, now, error, refresh: load };
}
