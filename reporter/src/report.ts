// Rigel reporter and keeper.
//
// Reporter: reads NEAR/USD from three public exchange tickers, takes the
// median, uses half the spread as the confidence interval, and pushes it to
// the price adapter in the same shape Pyth uses.
//
// Keeper (--keeper): after each push, opens a round when one can be opened and
// closes it once it has expired. Both calls are permissionless; the keeper is a
// convenience that keeps the demo moving, never an authority.
//
// Env: NEAR_ACCOUNT (signer, must be the adapter's reporter), ADAPTER, VAULT,
// NEAR_RPC, INTERVAL_SECONDS. The key is read from the near-cli legacy keychain.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, type KeyPairString } from "near-api-js";

const NEAR_USD = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
const EXPO = -8;
const TGAS = 1_000_000_000_000n;

const accountId = process.env.NEAR_ACCOUNT ?? "rigel-demo.testnet";
const adapter = process.env.ADAPTER ?? `oracle.${accountId}`;
const vault = process.env.VAULT ?? `vault.${accountId}`;
const rpc = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const interval = Number(process.env.INTERVAL_SECONDS ?? "20");
const once = process.argv.includes("--once");
const keeper = process.argv.includes("--keeper");

function loadKey(id: string): KeyPairString {
  const file = join(homedir(), ".near-credentials", "testnet", `${id}.json`);
  return JSON.parse(readFileSync(file, "utf8")).private_key as KeyPairString;
}

const account = new Account(accountId, rpc, loadKey(accountId));

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

/** Median of the sources that answered, and half their spread. */
export async function readMarket(): Promise<{ price: number; conf: number; used: string[] }> {
  const results = await Promise.allSettled(Object.values(sources).map((f) => f()));
  const names = Object.keys(sources);
  const quotes: [string, number][] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && Number.isFinite(r.value) && r.value > 0) quotes.push([names[i], r.value]);
  });
  if (quotes.length < 2) throw new Error(`only ${quotes.length} source(s) answered`);
  const values = quotes.map(([, v]) => v).sort((a, b) => a - b);
  const mid = values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
  return { price: mid, conf: (values[values.length - 1] - values[0]) / 2, used: quotes.map(([n]) => n) };
}

async function push(): Promise<void> {
  const { price, conf, used } = await readMarket();
  const scale = 10 ** -EXPO;
  const args = {
    price_identifier: NEAR_USD,
    price: {
      price: Math.round(price * scale).toString(),
      conf: Math.max(1, Math.round(conf * scale)).toString(),
      expo: EXPO,
      publish_time: Math.floor(Date.now() / 1000) - 2,
    },
  };
  const stored = await account.callFunction({ contractId: adapter, methodName: "push_price", args, gas: 10n * TGAS });
  console.log(`${new Date().toISOString()} NEAR/USD ${price.toFixed(4)} ±${conf.toFixed(4)} from ${used.join(",")} stored=${stored}`);
}

async function keep(): Promise<void> {
  const e: any = await account.provider.callFunction({ contractId: vault, method: "get_epoch", args: {} });
  const now = Math.floor(Date.now() / 1000);
  const call = async (methodName: string) => {
    try {
      const r = await account.callFunction({ contractId: vault, methodName, args: {}, gas: 100n * TGAS });
      console.log(`  ${methodName} -> ${JSON.stringify(r)}`);
    } catch (err) {
      console.log(`  ${methodName} refused: ${(err as Error).message.split("\n")[0]}`);
    }
  };
  if (e.phase === "Idle" && now >= Number(e.next_open_at) && BigInt(e.locked_assets) > 0n) {
    await call("open_epoch");
  } else if ((e.phase === "Active" || e.outcome_pending) && now >= Number(e.expiry)) {
    await call("close_round");
  } else if (e.outcome_pending && BigInt(e.notional_sold) === 0n) {
    // An auction that ended empty: closing it records the lapse.
    await call("close_round");
  }
}

async function tick(): Promise<void> {
  try {
    await push();
    if (keeper) await keep();
  } catch (err) {
    console.error(`${new Date().toISOString()} ${(err as Error).message}`);
  }
}

await tick();
if (!once) setInterval(tick, interval * 1000);
