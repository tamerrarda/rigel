// NEAR Intents (1Click) route preview, and the testnet stand-in for its last hop.
//
// On mainnet, 1Click swaps the bidder's asset into exactly the wNEAR the bid
// needs and delivers it to the vault with `ft_transfer_call` and our message
// (`customRecipientMsg`). 1Click runs on mainnet only, so this app asks it for a
// live *dry* quote of the swap leg (no deposit address, nothing moves) and, on
// testnet, performs the delivery leg itself through wrap.testnet.

export const ONECLICK = "https://1click.chaindefuser.com/v0";
export const WNEAR_MAINNET = "nep141:wrap.near";
export const WNEAR_TESTNET = "wrap.testnet";

export interface Origin {
  id: string;
  label: string;
  assetId: string;
  decimals: number;
  /** A syntactically valid refund address, needed by dry quotes only. */
  sampleRefund: string;
}

export const ORIGINS: Origin[] = [
  { id: "arb", label: "USDC on Arbitrum", assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6, sampleRefund: "0x1111111111111111111111111111111111111111" },
  { id: "sol", label: "USDC on Solana", assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", decimals: 6, sampleRefund: "So11111111111111111111111111111111111111112" },
  { id: "base", label: "USDC on Base", assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, sampleRefund: "0x1111111111111111111111111111111111111111" },
  { id: "eth", label: "USDC on Ethereum", assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", decimals: 6, sampleRefund: "0x1111111111111111111111111111111111111111" },
];

/** The message the vault's `ft_on_transfer` reads. */
export function bidMessage(notional: bigint, maxPremiumBps: number, beneficiary: string): string {
  return JSON.stringify({ bid: { notional: notional.toString(), max_premium_bps: maxPremiumBps, beneficiary } });
}

export interface RoutePreview {
  amountIn: string;
  timeEstimate: number;
}

/** A live dry quote: how much of `origin` buys exactly `wnear` yoctoNEAR of wNEAR right now. */
export async function previewRoute(origin: Origin, wnear: bigint): Promise<RoutePreview> {
  const res = await fetch(`${ONECLICK}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dry: true,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: origin.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: WNEAR_MAINNET,
      amount: wnear.toString(),
      refundTo: origin.sampleRefund,
      refundType: "ORIGIN_CHAIN",
      recipient: "rigel-vault.near",
      recipientType: "INTENTS",
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.quote) {
    const msg: string = body.message ?? `HTTP ${res.status}`;
    const min = /at least (\d+)/.exec(msg);
    throw new Error(min ? `below this route's minimum (${(Number(min[1]) / 1e24).toFixed(3)} wNEAR)` : msg);
  }
  return { amountIn: body.quote.amountInFormatted, timeEstimate: body.quote.timeEstimate };
}
