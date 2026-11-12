// Rigel reporter and keeper as a Cloudflare Worker on a one-minute cron.
//
// Each run pushes NEAR/USD to the price adapter twice, 30 seconds apart, so the
// stored price is never much older than half a minute, and after each push
// opens or closes a round when one is due. Same logic as reporter/src/report.ts,
// which stays the way to run it from a laptop.
//
// Secrets: REPORTER_KEY (ed25519 secret key of NEAR_ACCOUNT, the adapter's
// reporter). Vars: NEAR_ACCOUNT, ADAPTER, VAULT, NEAR_RPC (wrangler.toml).

import { Rpc, signerFrom, type Signer } from "./near";

export interface Env {
  REPORTER_KEY: string;
  NEAR_ACCOUNT: string;
  ADAPTER: string;
  VAULT: string;
  NEAR_RPC: string;
}

const NEAR_USD = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
const EXPO = -8;
const TGAS = 1_000_000_000_000n;
const SECOND_PUSH_AFTER_MS = 30_000;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const sources: Record<string, () => Promise<number>> = {
  binance: async () =>
    Number((await getJson("https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT")).price),
  coinbase: async () =>
    Number((await getJson("https://api.exchange.coinbase.com/products/NEAR-USD/ticker")).price),
  kraken: async () =>
    Number((await getJson("https://api.kraken.com/0/public/Ticker?pair=NEARUSD")).result.NEARUSD.c[0]),
};

/** Median of the sources that answered (at least two), and half their spread. */
async function readMarket(): Promise<{ price: number; conf: number; used: string[] }> {
  const names = Object.keys(sources);
  const results = await Promise.allSettled(Object.values(sources).map((f) => f()));
  const quotes: [string, number][] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && Number.isFinite(r.value) && r.value > 0) quotes.push([names[i], r.value]);
  });
  if (quotes.length < 2) throw new Error(`only ${quotes.length} source(s) answered`);
  const v = quotes.map(([, x]) => x).sort((a, b) => a - b);
  const mid = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return { price: mid, conf: (v[v.length - 1] - v[0]) / 2, used: quotes.map(([n]) => n) };
}

/** One push, then one keeper decision. Nonces are tracked locally within a tick. */
async function tick(env: Env, rpc: Rpc, signer: Signer): Promise<void> {
  const { price, conf, used } = await readMarket();
  const scale = 10 ** -EXPO;
  let { nonce, blockHash } = await rpc.accessKey(signer);
  const send = (receiver: string, method: string, args: unknown, gas: bigint) =>
    rpc.functionCall(signer, ++nonce, blockHash, receiver, method, args, gas);

  const stored = await send(
    env.ADAPTER,
    "push_price",
    {
      price_identifier: NEAR_USD,
      price: {
        price: Math.round(price * scale).toString(),
        conf: Math.max(1, Math.round(conf * scale)).toString(),
        expo: EXPO,
        publish_time: Math.floor(Date.now() / 1000) - 2,
      },
    },
    10n * TGAS,
  );
  console.log(`NEAR/USD ${price.toFixed(4)} ±${conf.toFixed(4)} from ${used.join(",")} stored=${stored}`);

  const e: any = await rpc.view(env.VAULT, "get_epoch");
  const now = Math.floor(Date.now() / 1000);
  let action: string | null = null;
  if (e.phase === "Idle" && now >= Number(e.next_open_at) && BigInt(e.locked_assets) > 0n) action = "open_epoch";
  else if ((e.phase === "Active" || e.outcome_pending) && now >= Number(e.expiry)) action = "close_round";
  else if (e.outcome_pending && BigInt(e.notional_sold) === 0n) action = "close_round"; // empty auction: record the lapse
  if (!action) return;
  try {
    const r = await send(env.VAULT, action, {}, 100n * TGAS);
    console.log(`${action} -> ${JSON.stringify(r)}`);
  } catch (err) {
    console.log(`${action} refused: ${(err as Error).message}`);
  }
}

async function run(env: Env): Promise<void> {
  const rpc = new Rpc(env.NEAR_RPC);
  const signer = await signerFrom(env.NEAR_ACCOUNT, env.REPORTER_KEY);
  const safe = (p: Promise<void>) => p.catch((err) => console.error((err as Error).message));
  await safe(tick(env, rpc, signer));
  await new Promise((r) => setTimeout(r, SECOND_PUSH_AFTER_MS));
  await safe(tick(env, rpc, signer));
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env));
  },
};
