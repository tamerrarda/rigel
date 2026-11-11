//! Shared types. Amounts are yoctoNEAR (`u128`), ratios are basis points
//! (10 000 = 100 %), time is seconds since the Unix epoch, and prices are raw
//! Pyth integers read against the exponent snapshotted when the round opened.

use near_sdk::json_types::{U128, U64};
use near_sdk::near;

/// Scale of the price-per-share. 1e12 keeps rounding loss far below one
/// yoctoNEAR per share while every product still fits in 256 bits.
pub const PRECISION: u128 = 1_000_000_000_000;

/// Basis-point denominator.
pub const BPS: u128 = 10_000;

/// 1 NEAR buys 1 share before any round has finalized.
pub const INITIAL_PPS: u128 = PRECISION;

/// Shares minted to the vault itself on the first deposit, never transferable
/// and never burnable (0.0001 share). They stop the share price from being
/// inflated by donating to an almost empty vault, and they mean the share
/// supply never returns to zero after the first deposit.
pub const DEAD_SHARES: u128 = 100_000_000_000_000_000_000;

/// The live phase of the vault. Round outcomes are not phases: the call that
/// finalizes a round writes its record and returns the vault to `Idle` at once.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Auction,
    Active,
}

/// How a round ended. All four are normal.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoundOutcome {
    /// A valid price was read inside the settlement window.
    Settled,
    /// The auction ended with nothing sold.
    Lapsed,
    /// The price read inside the window was unusable; every premium is refunded.
    Voided,
    /// Nobody settled inside the window. No payout, the premium stays with
    /// depositors, and the oracle is not called at all.
    Unresolved,
}

/// The parameters governing one round, snapshotted when the round opens.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EpochParams {
    /// Seconds from open to expiry.
    pub epoch_duration: u64,
    /// Seconds the auction runs; at most `epoch_duration / 4`.
    pub auction_duration: u64,
    /// Seconds between one round finalizing and the next one opening.
    pub min_idle_gap: u64,
    /// `strike = spot × (10 000 + strike_bps_otm) / 10 000`.
    pub strike_bps_otm: u32,
    /// Premium at the start of the auction, bps of notional.
    pub premium_start_bps: u32,
    /// Premium at the end of the auction, bps of notional; `0 < floor ≤ start`.
    pub premium_floor_bps: u32,
    /// Maximum age of a price used to open a round or to accept a bid.
    pub max_staleness: u64,
    /// Widest confidence interval accepted, bps of the price.
    pub max_conf_bps: u32,
    /// Seconds after expiry during which a price counts as the expiry price.
    pub settle_window: u64,
    /// Seconds after expiry from which `close_round` resolves the round as
    /// `Unresolved` without calling the oracle; `> settle_window`.
    pub unresolved_after: u64,
    /// Smallest bid notional, unless the bid takes everything left.
    pub min_fill: U128,
    /// Smallest deposit; `> DEAD_SHARES`.
    pub min_deposit: U128,
    /// Paid to whoever closes a round, out of premium; at most 100 bps.
    pub settle_bounty_bps: u32,
}

/// A Pyth price as the Pyth receiver contract returns it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PythPrice {
    pub price: near_sdk::json_types::I64,
    pub conf: U64,
    pub expo: i32,
    pub publish_time: i64,
}

/// The vault's running accounting and the live round.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub round: u32,
    pub phase: Phase,
    pub params: EpochParams,
    pub opened_at: u64,
    pub auction_end: u64,
    pub expiry: u64,
    pub price_expo: i32,
    pub strike: i128,
    pub open_spot: i128,
    pub notional_offered: u128,
    pub notional_sold: u128,
    pub premium_collected: u128,
    pub locked_at_open: u128,
    pub shares_snapshot: u128,
    pub burned_this_round: u128,
    /// NEAR attributable to current shareholders.
    pub locked_assets: u128,
    pub last_pps: u128,
    pub last_finalize_time: u64,
    pub pending_deposits_total: u128,
    pub withdraw_claimable_total: u128,
    pub bidder_claimable_total: u128,
}

/// A finalized round. Written once, never rewritten; every late claim is
/// computed from it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Round {
    pub outcome: RoundOutcome,
    pub pps: U128,
    pub strike: near_sdk::json_types::I64,
    pub price_expo: i32,
    pub expiry: U64,
    pub notional_sold: U128,
    pub premium: U128,
    /// 0 unless `Settled`.
    pub settled_spot: near_sdk::json_types::I64,
    /// 0 unless `Settled` above the strike.
    pub payout_total: U128,
}

/// A deposit made while a round is live; it joins the pool when the round ends.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingDeposit {
    pub round: u32,
    pub amount: U128,
}

/// A withdrawal requested while a round is live. The shares are burned at
/// once and paid at that round's recorded price-per-share.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingWithdraw {
    pub round: u32,
    pub shares: U128,
}

/// One bidder's fill in one round.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fill {
    pub notional: U128,
    pub premium_paid: U128,
    pub claimed: bool,
}

/// What `get_epoch` returns. `phase` is the effective phase: an auction past
/// its end with nothing sold already reads `Idle`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EpochView {
    pub round: u32,
    pub phase: Phase,
    pub outcome_pending: bool,
    pub opened_at: U64,
    pub auction_end: U64,
    pub expiry: U64,
    pub price_expo: i32,
    pub strike: near_sdk::json_types::I64,
    pub open_spot: near_sdk::json_types::I64,
    pub notional_offered: U128,
    pub notional_sold: U128,
    pub premium_collected: U128,
    pub current_premium_bps: u32,
    pub locked_assets: U128,
    pub shares_outstanding: U128,
    pub pending_deposits_total: U128,
    pub last_pps: U128,
    pub last_finalize_time: U64,
    pub next_open_at: U64,
    pub settle_window_end: U64,
    pub unresolved_at: U64,
    pub params: EpochParams,
}

/// What `get_position` returns.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionView {
    pub shares: U128,
    /// `shares × last_pps`, indicative.
    pub share_value: U128,
    pub pending_deposit: Option<PendingDeposit>,
    pub pending_withdraw: Option<PendingWithdraw>,
    /// 0 until the round of the pending withdrawal finalizes.
    pub withdraw_claimable: U128,
}

/// What `get_bidder_position` returns; zeroed for an account that never bid.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BidderPositionView {
    pub notional: U128,
    pub premium_paid: U128,
    pub claimed: bool,
    pub claimable: U128,
}

/// What `get_config` returns.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub oracle: near_sdk::AccountId,
    pub price_id: String,
    pub wnear: Option<near_sdk::AccountId>,
    pub params: EpochParams,
}
