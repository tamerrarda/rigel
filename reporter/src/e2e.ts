// End-to-end scenarios against a throwaway testnet deployment with short
// rounds, where this script is also the price reporter. It walks every round
// outcome and the user flows around them, and records each transaction hash.
//
// Env: E2E_OWNER (reporter, default rigel-test.testnet), E2E_LP (depositor),
// E2E_BIDDER, NEAR_RPC. Keys come from the near-cli legacy keychain.
// Expects oracle.<owner> and vault.<owner> deployed with deploy-style args and
// a 240 s round, 60 s auction, 60 s window, 120 s unresolved_after.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, actions, type KeyPairString } from "near-api-js";

const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const OWNER = process.env.E2E_OWNER ?? "rigel-test.testnet";
const LP = process.env.E2E_LP ?? "rigel-lp.testnet";
const BIDDER = process.env.E2E_BIDDER ?? "rigel-bidder.testnet";
const ORACLE = `oracle.${OWNER}`;
const VAULT = process.env.E2E_VAULT ?? `vault.${OWNER}`;
const WRAP = "wrap.testnet";
const FEED = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
const OUT = process.env.E2E_OUT ?? "e2e-results.json";

const NEAR = 10n ** 24n;
const milli = (n: number) => (BigInt(n) * NEAR) / 1000n; // n thousandths of a NEAR
const TGAS = 10n ** 12n;

const key = (id: string) =>
  JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${id}.json`), "utf8"))
    .private_key as KeyPairString;
const acct = (id: string) => new Account(id, RPC, key(id));
const owner = acct(OWNER);
const lp = acct(LP);
const bidder = acct(BIDDER);

interface Step {
  name: string;
  expect: "ok" | "fail";
  pass: boolean;
  tx?: string;
  value?: unknown;
  events?: string[];
  error?: string;
}
const steps: Step[] = [];
const save = () => writeFileSync(OUT, JSON.stringify(steps, null, 2));
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const now = () => Math.floor(Date.now() / 1000);

/** Sends one function call, never throws, and records what happened. */
async function call(
  name: string,
  who: Account,
  contract: string,
  method: string,
  args: object,
  opts: { deposit?: bigint; gas?: bigint; expect?: "ok" | "fail"; check?: (v: any, ev: string[]) => boolean } = {},
): Promise<{ value: any; events: string[]; ok: boolean }> {
  const expect = opts.expect ?? "ok";
  let r: any;
  try {
    r = await who.signAndSendTransaction({
      receiverId: contract,
      actions: [actions.functionCall(method, args, opts.gas ?? 100n * TGAS, opts.deposit ?? 0n)],
      throwOnFailure: false,
    });
  } catch (e) {
    const step: Step = { name, expect, pass: expect === "fail", error: (e as Error).message.slice(0, 200) };
    steps.push(step);
    save();
    console.log(`${step.pass ? "PASS" : "FAIL"} ${name}: threw ${step.error}`);
    return { value: undefined, events: [], ok: false };
  }
  const tx: string = r.transaction.hash;
  const events: string[] = r.receipts_outcome
    .flatMap((o: any) => o.outcome.logs as string[])
    .filter((l: string) => l.startsWith("EVENT_JSON:"))
    .map((l: string) => {
      const j = JSON.parse(l.slice(11));
      return `${j.event} ${JSON.stringify(j.data?.[0] ?? {})}`;
    });
  const failure = r.status?.Failure;
  let value: any;
  if (typeof r.status?.SuccessValue === "string" && r.status.SuccessValue) {
    value = JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString());
  }
  const ok = !failure;
  const error = failure ? JSON.stringify(failure).match(/"(?:ExecutionError|panic_msg)":"([^"]+)"/)?.[1] ?? JSON.stringify(failure).slice(0, 200) : undefined;
  let pass = expect === "ok" ? ok : !ok;
  if (pass && opts.check) pass = opts.check(value, events);
  steps.push({ name, expect, pass, tx, value, events, error });
  save();
  console.log(`${pass ? "PASS" : "FAIL"} ${name} tx=${tx} value=${JSON.stringify(value)}${error ? ` error=${error}` : ""}`);
  for (const e of events) console.log(`     ${e.slice(0, 220)}`);
  return { value, events, ok };
}

async function view(contract: string, method: string, args: object = {}): Promise<any> {
  // Optimistic: the state a just-executed transaction left behind.
  return owner.provider.callFunction({ contractId: contract, method, args, blockQuery: { finality: "optimistic" } });
}
const epoch = () => view(VAULT, "get_epoch");

/** Pushes a price with the given confidence (in 1e-8 USD) and publish time. */
async function push(name: string, price: number, conf = 100_000) {
  for (let attempt = 1; ; attempt++) {
    const n = steps.length;
    const r = await call(name, owner, ORACLE, "push_price", {
      price_identifier: FEED,
      price: { price: String(Math.round(price * 1e8)), conf: String(conf), expo: -8, publish_time: now() - 1 },
    }, { gas: 10n * TGAS });
    if (r.ok || attempt === 3 || steps[n]?.tx) return r;
    steps.splice(n, 1); // a network error before the transaction landed: try again
    console.log("  .. retrying the push");
    await sleep(2);
  }
}

async function waitUntil(t: number, why: string) {
  const d = t - now();
  if (d > 0) {
    console.log(`  .. waiting ${d}s for ${why}`);
    await sleep(d);
  }
}

async function openRound(label: string, spot: number) {
  const before = (await epoch()).round;
  await push(`${label}: fresh price ${spot}`, spot);
  await call(`${label}: open_epoch`, owner, VAULT, "open_epoch", {}, { check: (v) => v === true });
  for (let i = 0; i < 30; i++) {
    const e = await epoch();
    if (e.round === before + 1 && e.phase === "Auction") return e;
    await sleep(1);
  }
  throw new Error(`${label}: the new round never became visible`);
}

async function main() {
  const from = Number(process.env.E2E_FROM ?? "1");
  const e0 = await epoch();
  if (from === 1 && (e0.phase !== "Idle" || e0.round !== 0)) throw new Error(`start from a fresh vault, got ${e0.phase} round ${e0.round}`);
  if (from > 1 && e0.phase !== "Idle") {
    // Resuming: finish whatever round an earlier, interrupted run left open.
    await waitUntil(Number(e0.expiry) + Number(e0.params.unresolved_after) + 2, "the interrupted round to become closable");
    await call(`resume: close round ${e0.round} left open by the interrupted run`, owner, VAULT, "close_round", {});
  }
  let e: any;
  if (from <= 1) {

  // ---- Access control and setup ------------------------------------------
  await call("a non-reporter cannot push a price", bidder, ORACLE, "push_price", {
    price_identifier: FEED,
    price: { price: "100000000", conf: "1000", expo: -8, publish_time: now() },
  }, { expect: "fail", gas: 10n * TGAS });
  await call("bidder registers for rcNEAR (NEP-145)", bidder, VAULT, "storage_deposit", { account_id: BIDDER, registration_only: true }, { deposit: milli(10) });
  await call("LP deposits 2 NEAR while idle: shares minted at once", lp, VAULT, "deposit", { amount: String(2n * NEAR) }, {
    deposit: 2n * NEAR + milli(10),
    check: (v) => BigInt(v) > 0n,
  });
  await call("LP transfers 0.3 rcNEAR to the bidder (NEP-141)", lp, VAULT, "ft_transfer", { receiver_id: BIDDER, amount: String(milli(300)) }, { deposit: 1n });

  // ---- Round 1: Settled in the money ---------------------------------------
  e = await openRound("R1", 3.5);
  console.log(`  R1 strike ${e.strike} auction_end ${e.auction_end} expiry ${e.expiry}`);
  await call("R1: bid with a ceiling below the current premium is refused", bidder, VAULT, "bid", { notional: String(NEAR), max_premium_bps: 10 }, {
    deposit: milli(30),
    expect: "fail",
  });
  await call("R1: bidder buys 1 NEAR notional", bidder, VAULT, "bid", { notional: String(NEAR), max_premium_bps: 150 }, {
    deposit: milli(30),
    check: (v) => BigInt(v) === NEAR,
  });
  await call("R1: bidder wraps 0.02 NEAR", bidder, WRAP, "near_deposit", {}, { deposit: milli(20), gas: 30n * TGAS });
  await call("R1: wNEAR with a malformed message comes back in full", bidder, WRAP, "ft_transfer_call", {
    receiver_id: VAULT,
    amount: String(milli(20)),
    msg: "not a bid",
  }, { deposit: 1n, gas: 250n * TGAS, check: (v) => v === "0" });
  await call("R1: bidder unwraps it again", bidder, WRAP, "near_withdraw", { amount: String(milli(20)) }, { deposit: 1n, gas: 30n * TGAS });
  await call("R1: LP deposits 1 NEAR during the round: queued", lp, VAULT, "deposit", { amount: String(NEAR) }, {
    deposit: NEAR + milli(10),
    check: (v) => v === "0",
  });
  await call("R1: LP cancels the queued deposit: refunded in full", lp, VAULT, "cancel_pending_deposit", {}, { check: (v) => BigInt(v) === NEAR });
  await call("R1: LP queues 1 NEAR again, to join next round", lp, VAULT, "deposit", { amount: String(NEAR) }, { deposit: NEAR + milli(10) });
  await call("R1: LP requests a withdrawal of 0.5 shares during the round: queued", lp, VAULT, "request_withdraw", { shares: String(milli(500)) }, {
    deposit: milli(10),
    check: (v) => v === "0",
  });
  await waitUntil(Number(e.auction_end) + 2, "the auction to end");
  await push("R1: fresh price after the auction", 3.5);
  await call("R1: bid after the auction is refused", bidder, VAULT, "bid", { notional: String(NEAR), max_premium_bps: 150 }, {
    deposit: milli(30),
    expect: "fail",
  });
  await call("R1: closing before expiry is refused", bidder, VAULT, "close_round", {}, { expect: "fail" });
  await waitUntil(Number(e.expiry) + 2, "expiry");
  await push("R1: price inside the window, above the strike", 3.6);
  await call("R1: a third party closes: Settled, and earns the bounty", bidder, VAULT, "close_round", {}, {
    check: (v, ev) => v === "Settled" && ev.some((x) => x.startsWith("round_settled")),
  });
  await call("R1: option holder claims the cash payout", bidder, VAULT, "claim_payout", { round: e.round }, { check: (v) => BigInt(v) > 0n });
  await call("R1: claiming twice is refused", bidder, VAULT, "claim_payout", { round: e.round }, { expect: "fail" });
  await call("R1: LP collects the queued withdrawal at round 1's share price", lp, VAULT, "claim_withdraw", {}, { check: (v) => BigInt(v) > 0n });
  await call("R1: LP turns the queued deposit into shares", lp, VAULT, "redeem_shares", {}, { check: (v) => BigInt(v) > 0n });
  }

  // ---- Round 2: Voided (unusable price in the window) -----------------------
  e = await epoch();
  await waitUntil(Number(e.next_open_at) + 1, "the idle gap");
  e = await openRound("R2", 3.5);
  await push("R2: fresh price for the bid", 3.5);
  await call("R2: bidder buys 0.5 NEAR notional", bidder, VAULT, "bid", { notional: String(milli(500)), max_premium_bps: 150 }, { deposit: milli(20) });
  await waitUntil(Number(e.expiry) + 2, "expiry");
  await push("R2: price inside the window with a 1.4 % confidence interval", 3.5, 5_000_000);
  await call("R2: close: Voided", owner, VAULT, "close_round", {}, { check: (v) => v === "Voided" });
  await call("R2: option holder takes the premium back", bidder, VAULT, "claim_payout", { round: e.round }, { check: (v) => BigInt(v) > 0n });

  // ---- Round 3: Unresolved, the oracle answered too late --------------------
  e = await epoch();
  await waitUntil(Number(e.next_open_at) + 1, "the idle gap");
  e = await openRound("R3", 3.5);
  await push("R3: fresh price for the bid", 3.5);
  await call("R3: bidder buys 0.5 NEAR notional", bidder, VAULT, "bid", { notional: String(milli(500)), max_premium_bps: 150 }, { deposit: milli(20) });
  await waitUntil(Number(e.expiry) + 2, "expiry");
  await call("R3: close with no price at or after expiry yet: nothing happens", owner, VAULT, "close_round", {}, { check: (v) => v === null });
  await waitUntil(Number(e.expiry) + Number(e.params.settle_window) + 3, "the settlement window to pass");
  await push("R3: first price after the window", 3.6);
  await call("R3: close: Unresolved (premium stays with depositors)", owner, VAULT, "close_round", {}, { check: (v) => v === "Unresolved" });
  await call("R3: option holder has nothing to claim", bidder, VAULT, "claim_payout", { round: e.round }, { expect: "fail" });

  // ---- Round 4: Unresolved without asking the oracle ------------------------
  e = await epoch();
  await waitUntil(Number(e.next_open_at) + 1, "the idle gap");
  e = await openRound("R4", 3.5);
  await push("R4: fresh price for the bid", 3.5);
  await call("R4: bidder buys 0.5 NEAR notional", bidder, VAULT, "bid", { notional: String(milli(500)), max_premium_bps: 150 }, { deposit: milli(20) });
  await waitUntil(Number(e.expiry) + Number(e.params.unresolved_after) + 2, "unresolved_after");
  await call("R4: close past unresolved_after: Unresolved, the oracle is never called", owner, VAULT, "close_round", {}, {
    check: (v, ev) => v === "Unresolved" && ev.some((x) => x.includes('"oracle_answered":false')),
  });

  // ---- Round 5: Lapsed ------------------------------------------------------
  e = await epoch();
  await waitUntil(Number(e.next_open_at) + 1, "the idle gap");
  e = await openRound("R5", 3.5);
  await waitUntil(Number(e.auction_end) + 2, "the auction to end with nothing sold");
  await call("R5: close an empty auction: Lapsed", owner, VAULT, "close_round", {}, { check: (v) => v === "Lapsed" });

  // ---- Exit ------------------------------------------------------------------
  const bShares: string = await view(VAULT, "ft_balance_of", { account_id: BIDDER });
  await call("bidder redeems the transferred rcNEAR while idle: paid at once", bidder, VAULT, "request_withdraw", { shares: bShares }, {
    deposit: milli(10),
    check: (v) => BigInt(v) > 0n,
  });
  const lShares: string = await view(VAULT, "ft_balance_of", { account_id: LP });
  await call("LP withdraws everything while idle: paid at once", lp, VAULT, "request_withdraw", { shares: lShares }, {
    deposit: milli(10),
    check: (v) => BigInt(v) > 0n,
  });
  // Books: the balance must cover storage plus everything the vault owes.
  const liab = BigInt(await view(VAULT, "get_liabilities"));
  const st: any = await owner.provider.viewAccount({ accountId: VAULT });
  const surplus = BigInt(st.amount) - BigInt(st.storage_usage) * 10n ** 19n - liab;
  console.log(`\nliabilities ${liab}, balance ${st.amount}, surplus after storage ${surplus}`);
  steps.push({ name: "books: balance covers storage and every liability", expect: "ok", pass: surplus >= 0n, value: surplus.toString() });
  save();

  const failed = steps.filter((s) => !s.pass);
  console.log(`\n${steps.length - failed.length}/${steps.length} passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name} ${f.error ?? ""}`);
}

main().catch((err) => {
  console.error(err);
  save();
  process.exit(1);
});
