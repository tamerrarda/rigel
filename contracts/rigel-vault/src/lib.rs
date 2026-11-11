//! Rigel: a covered call vault on NEAR.
//!
//! Depositors pool NEAR. Once per round the vault writes a cash-settled call
//! over the pool and sells it in a descending-price auction anyone can bid into.
//! The premium goes to the pool whatever the option does next. Opening and
//! closing a round take no authorization, and the caller of `close_round` cannot
//! choose how the round ends.
//!
//! The oracle rules are built around Pyth's pull model (see `epoch.rs`).

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::FungibleToken;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
};

pub mod claims;
pub mod epoch;
pub mod intents;
pub mod math;
pub mod token;
pub mod types;
pub mod vault;
pub mod views;

use types::{
    EpochParams, Fill, Phase, Round, RoundOutcome, State, DEAD_SHARES, INITIAL_PPS, PRECISION,
};

/// Upper bound on any duration parameter: one year.
const MAX_DURATION: u64 = 31_536_000;
const MAX_BOUNTY_BPS: u32 = 100;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Shares,
    PendingDeposits,
    PendingWithdraws,
    Rounds,
    Fills,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct RigelVault {
    /// The Pyth receiver contract.
    oracle: AccountId,
    /// Pyth price feed id, hex.
    price_id: String,
    /// The wNEAR token accepted by `ft_on_transfer` (`wrap.near`, `wrap.testnet`);
    /// `None` turns the wNEAR bid path off.
    wnear: Option<AccountId>,
    /// Parameters for the next round. There is no setter: a change is a new vault.
    params: EpochParams,
    state: State,
    /// NEP-141 share token.
    token: FungibleToken,
    pending_deposits: LookupMap<AccountId, types::PendingDeposit>,
    pending_withdraws: LookupMap<AccountId, types::PendingWithdraw>,
    rounds: LookupMap<u32, Round>,
    fills: LookupMap<(u32, AccountId), Fill>,
}

#[near]
impl RigelVault {
    /// Deploys a vault. Everything network specific is an argument here.
    #[init]
    pub fn new(
        oracle: AccountId,
        price_id: String,
        params: EpochParams,
        wnear: Option<AccountId>,
    ) -> Self {
        require!(
            oracle != env::current_account_id(),
            "oracle cannot be the vault"
        );
        require!(
            price_id.len() == 64 && price_id.bytes().all(|b| b.is_ascii_hexdigit()),
            "price_id must be 32 bytes of hex"
        );
        validate_params(&params);
        let mut token = FungibleToken::new(StorageKey::Shares);
        token.internal_register_account(&env::current_account_id());
        let now = now_secs();
        let state = State {
            round: 0,
            phase: Phase::Idle,
            params: params.clone(),
            opened_at: 0,
            auction_end: 0,
            expiry: 0,
            price_expo: 0,
            strike: 0,
            open_spot: 0,
            notional_offered: 0,
            notional_sold: 0,
            premium_collected: 0,
            locked_at_open: 0,
            shares_snapshot: 0,
            burned_this_round: 0,
            locked_assets: 0,
            last_pps: INITIAL_PPS,
            last_finalize_time: now,
            pending_deposits_total: 0,
            withdraw_claimable_total: 0,
            bidder_claimable_total: 0,
        };
        emit(
            "initialized",
            json!({ "oracle": oracle, "price_id": price_id, "params": params, "wnear": wnear }),
        );
        Self {
            oracle,
            price_id,
            wnear,
            params,
            state,
            token,
            pending_deposits: LookupMap::new(StorageKey::PendingDeposits),
            pending_withdraws: LookupMap::new(StorageKey::PendingWithdraws),
            rounds: LookupMap::new(StorageKey::Rounds),
            fills: LookupMap::new(StorageKey::Fills),
        }
    }
}

/// Rejects parameter sets under which some promise of the mechanism fails.
pub fn validate_params(p: &EpochParams) {
    for d in [
        p.epoch_duration,
        p.auction_duration,
        p.min_idle_gap,
        p.max_staleness,
        p.settle_window,
        p.unresolved_after,
    ] {
        require!(d > 0 && d <= MAX_DURATION, "duration out of range");
    }
    require!(
        p.auction_duration <= p.epoch_duration / 4,
        "auction must be at most a quarter of the round"
    );
    require!(
        p.unresolved_after > p.settle_window,
        "unresolved_after must exceed settle_window"
    );
    require!(
        p.premium_floor_bps > 0 && p.premium_floor_bps <= p.premium_start_bps,
        "need 0 < premium floor <= premium start"
    );
    require!(
        p.premium_start_bps < 10_000,
        "premium start must be below 100%"
    );
    require!(
        p.strike_bps_otm > 0 && p.strike_bps_otm <= 10_000,
        "strike offset out of range"
    );
    require!(
        p.max_conf_bps > 0 && p.max_conf_bps < p.strike_bps_otm,
        "confidence bound must sit inside the strike offset"
    );
    require!(p.min_fill.0 > 0, "min_fill must be positive");
    require!(
        p.min_deposit.0 > DEAD_SHARES,
        "min_deposit must exceed the dead shares"
    );
    require!(p.settle_bounty_bps <= MAX_BOUNTY_BPS, "bounty above 1%");
}

/// Block time in seconds.
pub(crate) fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

/// Emits a NEP-297 event under the `rigel` standard.
pub(crate) fn emit(event: &str, data: Value) {
    let line = json!({
        "standard": "rigel",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    log!(
        "EVENT_JSON:{}",
        serde_json::to_string(&line).unwrap_or_default()
    );
}

/// yoctoNEAR the storage written since `start` costs. Storage released is not refunded.
pub(crate) fn storage_cost_since(start: u64) -> u128 {
    let grown = env::storage_usage().saturating_sub(start);
    u128::from(grown) * env::storage_byte_cost().as_yoctonear()
}

pub(crate) fn transfer(to: &AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .detach();
    }
}

impl RigelVault {
    /// Applies the lazy end of an auction: past `auction_end`, a round with
    /// fills becomes `Active`, and one without finalizes as `Lapsed`. Returns
    /// whether a round was finalized.
    pub(crate) fn lazy_finalize(&mut self) -> bool {
        if self.state.phase != Phase::Auction || now_secs() < self.state.auction_end {
            return false;
        }
        if self.state.notional_sold > 0 {
            self.state.phase = Phase::Active;
            return false;
        }
        let pps = self.state.last_pps;
        let assets = self.state.locked_at_open;
        let wclaims = self.finalize_round(RoundOutcome::Lapsed, pps, assets, 0, 0);
        emit(
            "round_lapsed",
            json!({ "round": self.state.round, "notional_offered": U128(self.state.notional_offered), "pps": U128(pps), "withdrawals_paid": U128(wclaims) }),
        );
        true
    }

    /// Writes the round record and returns the vault to `Idle`. Returns the NEAR
    /// set aside for withdrawals requested during the round.
    pub(crate) fn finalize_round(
        &mut self,
        outcome: RoundOutcome,
        pps: u128,
        assets_after: u128,
        settled_spot: i128,
        payout_total: u128,
    ) -> u128 {
        let wclaims = math::assets_for_shares(self.state.burned_this_round, pps)
            .unwrap_or_else(|| env::panic_str("withdrawal arithmetic"));
        let locked_after = assets_after
            .checked_sub(wclaims)
            .unwrap_or_else(|| env::panic_str("withdrawals exceed the pool"));
        self.state.withdraw_claimable_total += wclaims;
        self.state.locked_assets = locked_after;
        let record = Round {
            outcome,
            pps: U128(pps),
            strike: near_sdk::json_types::I64(self.state.strike as i64),
            price_expo: self.state.price_expo,
            expiry: self.state.expiry.into(),
            notional_sold: U128(self.state.notional_sold),
            premium: U128(self.state.premium_collected),
            settled_spot: near_sdk::json_types::I64(settled_spot as i64),
            payout_total: U128(payout_total),
        };
        self.rounds.insert(self.state.round, record);
        self.state.last_pps = pps;
        self.state.last_finalize_time = now_secs();
        self.state.phase = Phase::Idle;
        self.state.burned_this_round = 0;
        wclaims
    }

    /// Writes pending collection changes now, so storage growth can be measured.
    pub(crate) fn flush_maps(&mut self) {
        self.pending_deposits.flush();
        self.pending_withdraws.flush();
        self.fills.flush();
    }

    pub(crate) fn total_shares(&self) -> u128 {
        self.token.total_supply
    }

    /// Mints shares for `amount` NEAR at the current price-per-share and adds
    /// the NEAR to the pool. Returns the shares credited to `to`.
    pub(crate) fn mint(&mut self, to: &AccountId, amount: u128) -> u128 {
        let minted = math::shares_for_assets(amount, self.state.last_pps)
            .unwrap_or_else(|| env::panic_str("share arithmetic"));
        require!(minted > 0, "deposit too small for one share unit");
        let credited = if self.total_shares() == 0 {
            let vault = env::current_account_id();
            self.token.internal_deposit(&vault, DEAD_SHARES);
            FtMint {
                owner_id: &vault,
                amount: U128(DEAD_SHARES),
                memo: Some("dead shares"),
            }
            .emit();
            minted
                .checked_sub(DEAD_SHARES)
                .unwrap_or_else(|| env::panic_str("first deposit below the dead shares"))
        } else {
            minted
        };
        require!(credited > 0, "deposit too small for one share unit");
        if !self.token.accounts.contains_key(to) {
            self.token.internal_register_account(to);
        }
        self.token.internal_deposit(to, credited);
        self.state.locked_assets += amount;
        FtMint {
            owner_id: to,
            amount: U128(credited),
            memo: None,
        }
        .emit();
        credited
    }

    pub(crate) fn burn(&mut self, from: &AccountId, shares: u128) {
        self.token.internal_withdraw(from, shares);
        FtBurn {
            owner_id: from,
            amount: U128(shares),
            memo: None,
        }
        .emit();
    }
}

/// Price-per-share scale, re-exported for views and tests.
pub const PPS_PRECISION: u128 = PRECISION;

#[cfg(test)]
mod tests;
