// Chain access: JSON-RPC views over fetch, and transactions through the
// wallet selector. Nothing here holds a key.

import type { WalletSelector } from "@near-wallet-selector/core";
import { actionCreators } from "@near-wallet-selector/core";

export const NETWORK = "testnet" as const;
export const RPC = process.env.NEXT_PUBLIC_NEAR_RPC ?? "https://test.rpc.fastnear.com";
export const VAULT = process.env.NEXT_PUBLIC_VAULT ?? "vault.rigel-demo.testnet";
export const ORACLE = process.env.NEXT_PUBLIC_ORACLE ?? "oracle.rigel-demo.testnet";
export const PRICE_ID = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
export const EXPLORER = "https://testnet.nearblocks.io";

export const TGAS = 1_000_000_000_000n;
export const YOCTO = 10n ** 24n;

export async function view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "rigel",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) {
    throw new Error(body.error?.data ?? body.result?.error ?? "RPC error");
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as T;
}

export type Phase = "Idle" | "Auction" | "Active";
export type Outcome = "Settled" | "Lapsed" | "Voided" | "Unresolved";

export interface EpochParams {
  epoch_duration: number;
  auction_duration: number;
  min_idle_gap: number;
  strike_bps_otm: number;
  premium_start_bps: number;
  premium_floor_bps: number;
  max_staleness: number;
  max_conf_bps: number;
  settle_window: number;
  unresolved_after: number;
  min_fill: string;
  min_deposit: string;
  settle_bounty_bps: number;
}

export interface Epoch {
  round: number;
  phase: Phase;
  outcome_pending: boolean;
  opened_at: string;
  auction_end: string;
  expiry: string;
  price_expo: number;
  strike: string;
  open_spot: string;
  notional_offered: string;
  notional_sold: string;
  premium_collected: string;
  current_premium_bps: number;
  locked_assets: string;
  shares_outstanding: string;
  pending_deposits_total: string;
  last_pps: string;
  last_finalize_time: string;
  next_open_at: string;
  settle_window_end: string;
  unresolved_at: string;
  params: EpochParams;
}

export interface Round {
  outcome: Outcome;
  pps: string;
  strike: string;
  price_expo: number;
  expiry: string;
  notional_sold: string;
  premium: string;
  settled_spot: string;
  payout_total: string;
}

export interface Position {
  shares: string;
  share_value: string;
  pending_deposit: { round: number; amount: string } | null;
  pending_withdraw: { round: number; shares: string } | null;
  withdraw_claimable: string;
}

export interface BidderPosition {
  notional: string;
  premium_paid: string;
  claimed: boolean;
  claimable: string;
}

export interface Price {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

export const readEpoch = () => view<Epoch>(VAULT, "get_epoch");
export const readRounds = () => view<[number, Round][]>(VAULT, "get_rounds", { limit: 12 });
export const readPosition = (account_id: string) => view<Position>(VAULT, "get_position", { account_id });
export const readBidder = (round: number, account_id: string) =>
  view<BidderPosition>(VAULT, "get_bidder_position", { round, account_id });
export const readPrice = () => view<Price | null>(ORACLE, "get_price_unsafe", { price_identifier: PRICE_ID });

/** Signs and sends one vault call. Resolves once the wallet reports the outcome. */
export async function callVault(
  selector: WalletSelector,
  method: string,
  args: object,
  deposit: bigint = 0n,
  gas: bigint = 150n * TGAS,
) {
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({
    receiverId: VAULT,
    actions: [actionCreators.functionCall(method, args, gas, deposit)],
  });
}
