<div align="center">

<img src="web/public/rigel-mark.svg" alt="" width="72" />

# Rigel

**A covered call vault on NEAR.**
Deposit NEAR, an on-chain auction discovers what a call over it is worth, and the premium goes to the depositors.

**[rigelfinance.vercel.app](https://rigelfinance.vercel.app)** · [open the app](https://rigelfinance.vercel.app/app/)

`pre-alpha` · `NEAR testnet` · `unaudited` · `Apache-2.0`

</div>

---

Rigel writes a cash-settled call against a pool of NEAR once per round and sells it in a **descending-price
auction that anyone can bid into**. The premium the auction discovers is credited to depositors whatever the
option does next. There is no quote engine and no operator in the exit path: opening and closing a round take no
authorization, and the caller of `close_round` cannot choose how the round ends.

Built for NEAR HACKATHON (Unstoppable DeFi track). **Everything in this repository was written during the
hackathon**, with the oracle rules designed around a pull oracle (see [Oracle rules](#oracle-rules)).

## What it does

1. You deposit NEAR and receive **rcNEAR**, a NEP-141 share of the pool.
2. Each round the vault sells a **call option** over the pool: the right to the part of NEAR's rise past a fixed
   **strike** at a set **expiry**, paid in NEAR.
3. The buyer pays a **premium** up front. It goes to the pool and stays there whatever happens next.
4. At expiry:
   - **below the strike**, the option is worthless; the pool keeps collateral and premium;
   - **above the strike**, the pool pays `notional × (spot − strike) / spot` NEAR out of its collateral, and
     depositors still keep the premium.

The trade is stated as it is: **you earn a premium every round, and in exchange give up the part of a rally past
the strike.** There is no APY anywhere in this repository or the interface.

## How a round works

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Auction: open_epoch(), anyone, after min_idle_gap
    Auction --> Lapsed: auction ends, nothing sold
    Auction --> Active: auction ends with fills, or sold out
    Active --> Settled: close_round(), usable price in the window
    Active --> Voided: close_round(), unusable price in the window
    Active --> Unresolved: close_round(), nobody settled in the window
    Lapsed --> [*]
    Settled --> [*]
    Voided --> [*]
    Unresolved --> [*]
    note right of Idle
        Every outcome writes the round record
        and returns the vault to Idle.
    end note
```

- **Open.** `open_epoch` reads a fresh price (at most `max_staleness` old, confidence interval at most
  `max_conf_bps` wide) and sets `strike = spot × (1 + strike_bps_otm)`. The whole pool is offered.
- **Auction.** The premium falls linearly from `premium_start_bps` to `premium_floor_bps` of notional. `bid` takes
  a `max_premium_bps` ceiling, fills at the current point of the curve, and refunds the difference. Partial fills
  are allowed. A bid is refused while the price is already at or above the strike.
- **Close.** One entry point, `close_round`, dispatches on what the price data says. All four outcomes are normal.

| Outcome | When | Option holders | Depositors |
|---|---|---|---|
| **Settled** | a usable price published in `[expiry, expiry + settle_window]` | paid if above the strike | keep the premium |
| **Lapsed** | the auction ended with nothing sold | nothing | untouched |
| **Voided** | the price in the window is unusable (bad confidence, changed exponent) | premium refunded in full | untouched |
| **Unresolved** | nobody settled inside the window | nothing | keep the premium |

From `expiry + unresolved_after` on, `close_round` resolves the round as `Unresolved` **without calling the oracle
at all**, so no oracle state can keep a round, or anyone's funds, open forever.

Deposits made while a round is live wait as pending deposits (cancellable at any time) and join when the round
ends. Withdrawals requested while a round is live burn their shares at once and are paid at that round's recorded
price-per-share. Every claim is recomputed from a round record that is written once and never rewritten.

## Bidding from another chain (NEAR Intents)

A bidder does not need NEAR. The vault accepts bids paid in **wNEAR through `ft_transfer_call`**, which is exactly
how the [1Click API](https://docs.near-intents.org/) delivers a swap's output to a NEAR contract when the quote
carries a `customRecipientMsg`:

```json
{
  "bid": {
    "notional": "1000000000000000000000000",
    "max_premium_bps": 150,
    "beneficiary": "alice.near"
  }
}
```

So someone holding USDC on Arbitrum, Solana, Base or Ethereum asks 1Click for **exactly** the wNEAR the bid needs
(`EXACT_OUTPUT`), sends USDC to the quote's deposit address, and 1Click delivers the wNEAR to the vault with that
message. In [`intents.rs`](contracts/rigel-vault/src/intents.rs) the vault:

1. checks the bid **before** taking anything; a wrong token, a message that is not a bid, or a bid that would fail
   is returned in full, as NEP-141 requires;
2. keeps the wNEAR and unwraps it with `near_withdraw`;
3. runs the same price read and fill as a native bid. Refunds and any payout go to the **beneficiary**'s NEAR account.

```mermaid
sequenceDiagram
    autonumber
    participant U as Bidder, USDC on Arbitrum
    participant C as 1Click
    participant W as wrap.near
    participant V as rigel-vault
    participant P as price-adapter
    U->>C: quote EXACT_OUTPUT wNEAR, customRecipientMsg = bid
    C-->>U: deposit address
    U->>C: send USDC
    C->>W: ft_transfer_call(vault, amount, msg)
    W->>V: ft_on_transfer(sender, amount, msg)
    alt wrong token, not a bid, or the bid would fail
        V-->>W: unused = amount, returned in full
    else bid accepted
        V->>W: near_withdraw(amount)
        W-->>V: native NEAR
        V->>P: get_price_unsafe
        P-->>V: price
        V-->>U: fill, unused NEAR refunded to the beneficiary
    end
```

**What runs where.** 1Click runs on mainnet only and Rigel is deployed on testnet, so the app does two honest
things: it asks 1Click for a live **dry** quote of the swap leg (real mainnet price and time, nothing moves, no
deposit address), and it performs the delivery leg on testnet itself through `wrap.testnet` with the same call and
the same message. The vault code path is identical; only who makes the final `ft_transfer_call` differs.

## Oracle rules

NEAR's Pyth receiver stores a price only when someone pushes a signed update, and keeps only the newest one. So
"the price at expiry" is defined as **the first price published inside `[expiry, expiry + settle_window]`**:

- A reading published **before** expiry does not close the round (`close_round` resolves to `null`; push a newer
  price and call again).
- A reading published **after** the window means nobody settled in time: `Unresolved`.
- Option holders profit from settling inside the window when the option is in the money, so the party with
  something to lose is the one with every reason to act. A keeper closes rounds anyway; it is a convenience, not an
  authority, and anyone can do its job.

Every oracle read is a cross-contract call with a callback. **Callbacks never panic while they hold someone's
NEAR**: a bid whose checks fail in the callback is refunded in full.

### The price source on testnet, stated plainly

Pyth on NEAR has **not updated since 26 Aug 2026**, the day Pyth's Hermes service began requiring an API key
(`pyth-oracle.near` last `publish_time` is 1787699235; `pyth-oracle.testnet` holds no feeds; `priceoracle.near`
returns `null`). There is no live price to read on NEAR today.

So this deployment reads [`price-adapter`](contracts/price-adapter/src/lib.rs), a small contract that exposes
**Pyth's exact `get_price_unsafe` view and JSON shape**. A reporter pushes the median NEAR/USD of the Binance,
Coinbase and Kraken tickers that answer (at least two), with half their spread as the confidence interval. On this
deployment it runs as a [Cloudflare Worker](keeper/src/index.ts) every minute, where Binance refuses the
connection, so the live median is Coinbase and Kraken. **It is trusted**: the reporter can push
any price. The adapter only narrows what it can do (no rewriting history, nothing from the future). The vault
needs no change to read real Pyth again: its oracle account and feed id are constructor arguments.

## Architecture

```mermaid
flowchart LR
    D["Depositor: NEAR in, rcNEAR out"]
    B["Bidder: pays premium in NEAR"]
    X["Bidder on another chain: USDC on Arbitrum, Solana, Base"]
    OC["1Click swap"]
    V["rigel-vault, one NEAR contract: share token NEP-141, round ledger, Dutch auction, cash settlement"]
    O["price-adapter: Pyth-shaped, testnet stand-in"]
    R["keeper Worker: exchange median, every minute"]
    D -->|"deposit, request_withdraw"| V
    B -->|"bid"| V
    X --> OC
    OC -->|"wNEAR via ft_transfer_call with bid msg"| V
    V -->|"get_price_unsafe, Promise and callback"| O
    R -->|"push_price"| O
    R -.->|"open_epoch, close_round: anyone may call"| V
```

| Path | What |
|---|---|
| [`contracts/rigel-vault`](contracts/rigel-vault/src) | The vault: `epoch.rs` (open, bid, close, oracle callbacks), `intents.rs` (wNEAR bids via `ft_transfer_call`), `vault.rs` (deposits, withdrawals), `claims.rs`, `views.rs`, `token.rs` (NEP-141/145/148), `math.rs` (pure arithmetic, 256-bit `mul_div`) |
| [`contracts/price-adapter`](contracts/price-adapter/src/lib.rs) | Pyth-compatible price store for testnet |
| [`keeper`](keeper/src/index.ts) | Cloudflare Worker on a one-minute cron: pushes NEAR/USD, opens and closes rounds |
| [`reporter`](reporter/src/report.ts) | The same loop as a Node script, for running it from a laptop |
| [`web`](web) | Next.js app: Vault, Rounds, Claims, My positions |

## What's deployed (NEAR testnet)

| Account | What |
|---|---|
| [rigelfinance.vercel.app](https://rigelfinance.vercel.app) | The web app (landing at `/`, app at `/app/`), reading this deployment |
| [`vault.rigel-demo.testnet`](https://testnet.nearblocks.io/address/vault.rigel-demo.testnet) | The vault; accepts wNEAR bids from `wrap.testnet` |
| [`oracle.rigel-demo.testnet`](https://testnet.nearblocks.io/address/oracle.rigel-demo.testnet) | The price adapter; reporter `rigel-demo.testnet` |

**On-chain evidence (testnet).** A full round on the first deployment, settled in the money:

| Step | Transaction |
|---|---|
| Bid, 1 NEAR notional at 1.17 % | [`5BcL3Jk3…`](https://testnet.nearblocks.io/txns/5BcL3Jk3SzTVcpEjtMsEjvJUXsoQi6ytRxfvMZiQRZ93) |
| Keeper closes: **Settled**, spot 3.7888 above strike 3.7845, payout 0.001127 NEAR | round 1 record on the first deployment |
| Option holder claims the payout | [`5QHWg63m…`](https://testnet.nearblocks.io/txns/5QHWg63mTkkaSxpb5BjJuz4F2kGyBB3yrH76ZPD5aD7e) |
| Depositor withdraws 2.0104 NEAR for 2 deposited | [`9wYdStxF…`](https://testnet.nearblocks.io/txns/9wYdStxF7P6JiNMtPukHTaY9DUqmwUY7yaYPWGWcfAs2) |
| On the current deployment: a bid delivered as wNEAR via `ft_transfer_call` (`ft_on_transfer` → `near_withdraw` → price read → `bid_filled`), in one transaction | [`511Qj75D…`](https://testnet.nearblocks.io/txns/511Qj75D8X96rHzr6NbaeRdH59bYuB2uRJyLa6qPSmbi) |

The vault was redeployed between the two to add the wNEAR path, which changed its state layout.

**Every outcome, end to end.** [`reporter/src/e2e.ts`](reporter/src/e2e.ts) drives a second deployment
(`vault.rigel-test.testnet`, `oracle.rigel-test.testnet`, same wasm, 4-minute rounds) where the script itself is the
reporter, so it can publish the prices each outcome needs. All 50 steps passed, over two runs (a network
timeout cut the first one short and the script resumed it). Afterwards every depositor had withdrawn and the
vault's balance still covered its storage and every liability.

| Scenario | Transaction |
|---|---|
| Settled above the strike, closed by a third party who earns the bounty | [`GZ2WjMv4…`](https://testnet.nearblocks.io/txns/GZ2WjMv4yLG75yw4Hynz7n3VpFavRcfHdqAt7uwN4LMi) |
| Option holder claims the payout; a second claim is refused | [`EBuf5CR2…`](https://testnet.nearblocks.io/txns/EBuf5CR2D9agr3D6jNqv4yHxyigF7BfePCLrgG3WgNHQ) |
| Voided: the price in the window has a 1.4 % confidence interval | [`53KMcT4z…`](https://testnet.nearblocks.io/txns/53KMcT4zY3ER4qwKzUGg9eaTM47WSKTECjbeNh8teN7A) |
| Option holder takes the voided premium back | [`AkKCVuv4…`](https://testnet.nearblocks.io/txns/AkKCVuv4eav1YjSM7wtsDN86Z5WypPVuqVjGjcJ7nrPJ) |
| Unresolved: the oracle's price was published after the window | [`AU4agFfQ…`](https://testnet.nearblocks.io/txns/AU4agFfQ2NXAWRQcwqKhQhESuXZsNzityhJDSWxua6gf) |
| Unresolved past `unresolved_after`, without calling the oracle | [`9FXXk7FQ…`](https://testnet.nearblocks.io/txns/9FXXk7FQjXQzpxqXsyenoXV1LmYuQcsh4rEjoYtaHsyQ) |
| Lapsed: an auction that sold nothing | [`5N74UGtz…`](https://testnet.nearblocks.io/txns/5N74UGtzAbT5D3uBr2NSr8GajBDdV7YcnbUtcTcP9osb) |
| Deposit during a round is queued, then cancelled for a full refund | [`iUTGTz7w…`](https://testnet.nearblocks.io/txns/iUTGTz7wYayZwQ3BE1gJhyfH3qhgunWEniAkQEGUwPZ) |
| Withdrawal requested during a round, paid at that round's share price | [`5CesPNwd…`](https://testnet.nearblocks.io/txns/5CesPNwdHk9emA9gcwHSgAwVb5c2bmYX19TACpaqzc2Q) |
| rcNEAR moved with `ft_transfer`, then redeemed by its new holder | [`4THhVVit…`](https://testnet.nearblocks.io/txns/4THhVVitDnLQ51U4ABJWPKLcB3an4Rer5m4ntw6ThcQA) |
| wNEAR with a malformed message comes back in full | [`HYXk9h2X…`](https://testnet.nearblocks.io/txns/HYXk9h2XpumF6wqttZQDiEU7mzcadUkpAWHXo4VPQ7xj) |
| Refused: bid above the bidder's ceiling | [`51mcnZjp…`](https://testnet.nearblocks.io/txns/51mcnZjpu9oYxAofNizYpE2SVW2xKYb6HuDnTRmt2pkT) |
| Refused: bid after the auction | [`C7NMFD7U…`](https://testnet.nearblocks.io/txns/C7NMFD7UnotL11w9jRvJvmkkRXuH6jn88f8ma6Vr2nhV) |
| Refused: closing before expiry | [`Hi95fDNJ…`](https://testnet.nearblocks.io/txns/Hi95fDNJZK45rhYrKPBTRraa3YPXSSdgfh657RQ73P6S) |
| Refused: a price push from an account that is not the reporter | [`5rPdHNBb…`](https://testnet.nearblocks.io/txns/5rPdHNBbw7whUnWcZbmH9gCC8eeqobFjXCfN7yvmjysm) |

Demo parameters, short so a whole round fits in a demo: 20-minute rounds, 5-minute auction falling from 1.50 % to
0.20 % of notional, strike 0.50 % above spot, 2-minute settlement window, `Unresolved` after 10 minutes, 0.5 % of
premium to whoever closes the round.

## Building

Requirements: Rust (stable) with `wasm32-unknown-unknown`, [`cargo-near`](https://github.com/near/cargo-near),
Node 22.18+ and pnpm.

```bash
# contracts
cargo test --workspace                      # unit tests: vault lifecycle + adapter
cd contracts/rigel-vault   && cargo near build non-reproducible-wasm && cd ../..
cd contracts/price-adapter && cargo near build non-reproducible-wasm && cd ../..

# web
pnpm install
cd web && pnpm build                        # static export in web/out
pnpm dev                                    # http://localhost:3000, reads the testnet deployment
```

The web app reads `vault.rigel-demo.testnet` by default; set `NEXT_PUBLIC_VAULT`, `NEXT_PUBLIC_ORACLE` and
`NEXT_PUBLIC_NEAR_RPC` to point it elsewhere.

### Running your own deployment

```bash
near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
near account create-account fund-myself oracle.<you>.testnet '2 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as <you>.testnet network-config testnet sign-with-legacy-keychain send
near account create-account fund-myself vault.<you>.testnet '4 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as <you>.testnet network-config testnet sign-with-legacy-keychain send
near contract deploy oracle.<you>.testnet use-file target/near/price_adapter/price_adapter.wasm with-init-call new json-args '{"reporter":"<you>.testnet"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
near contract deploy vault.<you>.testnet use-file target/near/rigel_vault/rigel_vault.wasm with-init-call new file-args deploy/vault-init.testnet.json prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
near contract call-function as-transaction wrap.testnet storage_deposit json-args '{"account_id":"vault.<you>.testnet","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as <you>.testnet network-config testnet sign-with-legacy-keychain send
NEAR_ACCOUNT=<you>.testnet node reporter/src/report.ts --keeper
```

Or host the keeper instead of running the script (free Workers plan; set the accounts in `keeper/wrangler.toml`):

```sh
cd keeper
npx wrangler login
npx wrangler secret put REPORTER_KEY   # the ed25519:... private key of <you>.testnet
npx wrangler deploy
```

(Edit `oracle` in `deploy/vault-init.testnet.json` to your adapter account first. `wnear` names the token the
vault accepts bids in; set it to `null` to turn the wNEAR path off. The last command registers the vault with
`wrap.testnet` so it can receive wNEAR.)

## Testing

`cargo test --workspace` runs the unit suites. The vault suite drives every oracle callback directly with the
reading it would receive and keeps a **shadow ledger**: every yoctoNEAR attached and every transfer receipt is
tracked, and after every step the contract's own liabilities must equal the NEAR it holds for users, exactly. It
covers all four outcomes, in-the-money bid refusal, stale and wide-confidence prices, the idle gap, duplicate
callbacks, pending deposits and queued withdrawals across rounds, double claims, five consecutive settled rounds
with spots below and above the strike, and the wNEAR path (wrong token, malformed message, refused and underfunded
bids, a failed unwrap, refunds to the beneficiary). Pure arithmetic (`math.rs`) is tested separately, including
solvency for any spot.

## Honest limitations

- **Unaudited, testnet only.**
- **The price source is trusted** on this deployment (see above). The vault is not; it reads whatever account it was
  deployed against, which is public in `get_config`.
- **A closer chooses the moment inside the settlement window**, and so which price inside it settles the round.
  The window is short (2 minutes here) to bound this; a time-weighted average would remove it, but a latest-price
  pull oracle cannot provide one.
- **Storage** for each depositor and bidder record is charged to the caller (attach 0.01 NEAR, unused part
  refunded); round records are paid by the contract's own balance.
- **Cross-chain bids are proven on testnet up to the delivery leg.** The swap leg is a live mainnet dry quote;
  a real 1Click swap needs a mainnet deployment. 1Click marks `customRecipientMsg` experimental, and how much gas its
  `ft_transfer_call` forwards is not documented. The vault's wNEAR path burns about 17 Tgas but reserves gas for its
callbacks, so `ft_on_transfer` needs about 90 Tgas forwarded to it.
- If `near_withdraw` ever failed, the wNEAR would stay in the vault, recorded by an `unwrap_failed` event, with no
  automatic return.
- **Not built yet:** payouts back to the origin chain, multiple vaults, an upgrade path, fuzzing.

## License

Apache-2.0. Fonts in `web/public/fonts` are under the SIL Open Font License (see the license files there).
