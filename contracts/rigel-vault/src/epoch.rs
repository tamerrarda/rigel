//! The round lifecycle: open, auction, close.
//!
//! # Oracle rules under a pull oracle
//!
//! Pyth on NEAR stores a price only when someone pushes a signed update, and it
//! keeps only the newest one. So "the price at expiry" becomes: **the first
//! price whose publish time falls inside `[expiry, expiry + settle_window]`**.
//!
//! - A reading inside the window settles the round (`Settled`), or voids it
//!   when the reading is unusable (`Voided`, every premium refunded).
//! - A reading published after the window means nobody settled in time: the
//!   round is `Unresolved`, no option holder is paid and the premium stays.
//! - From `expiry + unresolved_after` on, `close_round` resolves the round as
//!   `Unresolved` without calling the oracle at all, so no oracle state can
//!   keep a round open forever.
//!
//! Option holders gain from settling inside the window when the option is in
//! the money, and the window is short, so the party with something to lose is
//! the one with every reason to act.
//!
//! Every oracle read is a cross-contract call. Callbacks never panic while
//! they hold someone's NEAR: a failed check refunds instead.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, PromiseError, PromiseOrValue};

use crate::types::{Fill, Phase, PythPrice, RoundOutcome};
use crate::{emit, math, now_secs, storage_cost_since, transfer, RigelVault, RigelVaultExt};

const GAS_ORACLE_READ: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(40);

/// Attached on top of the premium to cover the fill record; refunded unused.
pub const BID_STORAGE_RESERVE: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR

#[ext_contract(ext_pyth)]
pub trait Pyth {
    fn get_price_unsafe(&self, price_identifier: String) -> Option<PythPrice>;
}

#[ext_contract(ext_self)]
pub trait SelfCallbacks {
    fn on_open_price(&mut self, round: u32) -> bool;
    fn on_bid_price(
        &mut self,
        round: u32,
        bidder: AccountId,
        notional: U128,
        max_premium_bps: u32,
        attached: U128,
    ) -> U128;
    fn on_close_price(&mut self, round: u32, bounty_to: AccountId) -> Option<RoundOutcome>;
}

impl RigelVault {
    pub(crate) fn read_price(&self) -> near_sdk::Promise {
        ext_pyth::ext(self.oracle.clone())
            .with_static_gas(GAS_ORACLE_READ)
            .get_price_unsafe(self.price_id.clone())
    }

    pub(crate) fn callbacks(&self) -> ext_self::SelfCallbacksExt {
        ext_self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK)
    }

    /// A reading fresh enough to open a round or accept a bid.
    fn fresh(&self, reading: &Result<Option<PythPrice>, PromiseError>) -> Option<PythPrice> {
        let p = reading.as_ref().ok()?.as_ref()?.clone();
        let now = now_secs() as i64;
        let max_age = self.params.max_staleness as i64;
        if p.publish_time + max_age < now || p.publish_time > now + max_age {
            return None;
        }
        if !math::price_usable(p.price.0, p.conf.0, self.params.max_conf_bps) {
            return None;
        }
        Some(p)
    }

    /// Finalizes the live round as `Unresolved`: nobody is paid, the premium
    /// stays with depositors, the closer gets the bounty.
    fn resolve_unresolved(&mut self, bounty_to: &AccountId, oracle_answered: bool) -> RoundOutcome {
        let s = &self.state;
        let n = math::round_numbers(
            None,
            s.strike,
            s.notional_sold,
            s.locked_at_open,
            s.premium_collected,
            s.shares_snapshot,
            s.params.settle_bounty_bps,
        )
        .unwrap_or_else(|| env::panic_str("round arithmetic"));
        let wclaims = self.finalize_round(RoundOutcome::Unresolved, n.pps, n.assets_after, 0, 0);
        transfer(bounty_to, n.bounty);
        emit(
            "round_unresolved",
            json!({ "round": self.state.round, "premium_retained": U128(self.state.premium_collected), "pps": U128(n.pps), "bounty": U128(n.bounty), "oracle_answered": oracle_answered, "withdrawals_paid": U128(wclaims) }),
        );
        RoundOutcome::Unresolved
    }
}

#[near]
impl RigelVault {
    /// Opens the next round: reads the price, sets the strike, starts the
    /// auction. Anyone may call it. Push a fresh Pyth update first. Resolves to
    /// `false` when the reading was unusable or another call got there first.
    pub fn open_epoch(&mut self) -> PromiseOrValue<bool> {
        if self.lazy_finalize() {
            return PromiseOrValue::Value(false);
        }
        self.check_can_open();
        let round = self.state.round;
        PromiseOrValue::Promise(
            self.read_price()
                .then(self.callbacks().on_open_price(round)),
        )
    }

    #[private]
    pub fn on_open_price(
        &mut self,
        round: u32,
        #[callback_result] reading: Result<Option<PythPrice>, PromiseError>,
    ) -> bool {
        if self.state.phase != Phase::Idle || self.state.round != round || !self.can_open() {
            return false;
        }
        let Some(p) = self.fresh(&reading) else {
            emit(
                "open_refused",
                json!({ "round": round + 1, "reason": "no fresh usable price" }),
            );
            return false;
        };
        let spot = i128::from(p.price.0);
        let Some(strike) = math::strike_for(spot, self.params.strike_bps_otm) else {
            return false;
        };
        let now = now_secs();
        let s = &mut self.state;
        s.round = round + 1;
        s.phase = Phase::Auction;
        s.params = self.params.clone();
        s.opened_at = now;
        s.auction_end = now + self.params.auction_duration;
        s.expiry = now + self.params.epoch_duration;
        s.price_expo = p.expo;
        s.strike = strike;
        s.open_spot = spot;
        s.notional_offered = s.locked_assets;
        s.locked_at_open = s.locked_assets;
        s.shares_snapshot = self.token.total_supply;
        s.burned_this_round = 0;
        s.notional_sold = 0;
        s.premium_collected = 0;
        emit(
            "round_opened",
            json!({ "round": s.round, "strike": strike.to_string(), "spot": spot.to_string(), "expo": p.expo, "expiry": U64(s.expiry), "auction_end": U64(s.auction_end), "notional_offered": U128(s.notional_offered) }),
        );
        true
    }

    /// Buys up to `notional` yoctoNEAR of the option at the current auction
    /// premium, refusing anything above `max_premium_bps`. Attach the premium
    /// at that ceiling plus 0.01 NEAR for storage; the difference is refunded.
    /// Refused while the price is at or above the strike. Push a fresh Pyth
    /// update first. Resolves to the notional filled (0 when refused).
    #[payable]
    pub fn bid(&mut self, notional: U128, max_premium_bps: u32) -> PromiseOrValue<U128> {
        let bidder = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        self.lazy_finalize();
        if let Err(reason) = self.check_bid(&bidder, notional.0, max_premium_bps, attached) {
            env::panic_str(reason)
        }
        PromiseOrValue::Promise(self.bid_with_price(bidder, notional, max_premium_bps, attached))
    }

    #[private]
    pub fn on_bid_price(
        &mut self,
        round: u32,
        bidder: AccountId,
        notional: U128,
        max_premium_bps: u32,
        attached: U128,
        #[callback_result] reading: Result<Option<PythPrice>, PromiseError>,
    ) -> U128 {
        match self.try_fill(
            round,
            &bidder,
            notional.0,
            max_premium_bps,
            attached.0,
            &reading,
        ) {
            Ok(filled) => U128(filled),
            Err(reason) => {
                transfer(&bidder, attached.0);
                emit(
                    "bid_refused",
                    json!({ "round": round, "bidder": bidder, "reason": reason }),
                );
                U128(0)
            }
        }
    }

    /// Closes the live round once it has expired. Anyone may call it, and the
    /// outcome depends only on the price data, never on the caller. Inside the
    /// settlement window, push the Pyth update for the expiry first. Resolves
    /// to `None` when there is no price at or after expiry yet.
    pub fn close_round(&mut self) -> PromiseOrValue<Option<RoundOutcome>> {
        let caller = env::predecessor_account_id();
        if self.lazy_finalize() {
            return PromiseOrValue::Value(Some(RoundOutcome::Lapsed));
        }
        require!(self.state.phase == Phase::Active, "no round to close");
        let now = now_secs();
        require!(now >= self.state.expiry, "the round has not expired");
        if now >= self.state.expiry + self.state.params.unresolved_after {
            return PromiseOrValue::Value(Some(self.resolve_unresolved(&caller, false)));
        }
        let round = self.state.round;
        PromiseOrValue::Promise(
            self.read_price()
                .then(self.callbacks().on_close_price(round, caller)),
        )
    }

    #[private]
    pub fn on_close_price(
        &mut self,
        round: u32,
        bounty_to: AccountId,
        #[callback_result] reading: Result<Option<PythPrice>, PromiseError>,
    ) -> Option<RoundOutcome> {
        if self.state.phase != Phase::Active || self.state.round != round {
            return None;
        }
        let expiry = self.state.expiry;
        if now_secs() >= expiry + self.state.params.unresolved_after {
            return Some(self.resolve_unresolved(&bounty_to, false));
        }
        let p = reading.ok().flatten()?;
        if p.publish_time < expiry as i64 {
            return None;
        }
        if p.publish_time > (expiry + self.state.params.settle_window) as i64 {
            return Some(self.resolve_unresolved(&bounty_to, true));
        }
        if p.expo != self.state.price_expo
            || !math::price_usable(p.price.0, p.conf.0, self.state.params.max_conf_bps)
        {
            return Some(self.void(round));
        }
        Some(self.settle(&bounty_to, i128::from(p.price.0)))
    }
}

impl RigelVault {
    /// The checks a bid must pass before its NEAR is taken in. Shared by
    /// `bid` (native NEAR) and `ft_on_transfer` (wNEAR, e.g. from NEAR Intents).
    /// Everything is checked again in `on_bid_price` with a fresh price.
    pub(crate) fn check_bid(
        &self,
        bidder: &AccountId,
        notional: u128,
        max_premium_bps: u32,
        attached: u128,
    ) -> Result<(), &'static str> {
        if self.state.phase != Phase::Auction {
            return Err("no auction is running");
        }
        let now = now_secs();
        if now >= self.state.auction_end {
            return Err("the auction has ended");
        }
        if notional == 0 {
            return Err("notional must be positive");
        }
        if *bidder == env::current_account_id() {
            return Err("the vault cannot bid");
        }
        let bps = math::premium_bps(
            &self.state.params,
            self.state.opened_at,
            self.state.auction_end,
            now,
        );
        if bps > max_premium_bps {
            return Err("premium above your maximum");
        }
        let remaining = self.state.notional_offered - self.state.notional_sold;
        if remaining == 0 {
            return Err("sold out");
        }
        let ceiling = max_premium_bps.min(self.state.params.premium_start_bps);
        let premium_max =
            math::premium_for(notional.min(remaining), ceiling).ok_or("premium arithmetic")?;
        if attached < premium_max + BID_STORAGE_RESERVE {
            return Err("attach the premium at your maximum plus 0.01 NEAR");
        }
        Ok(())
    }

    /// Reads the price, then fills or refunds in `on_bid_price`.
    pub(crate) fn bid_with_price(
        &self,
        bidder: AccountId,
        notional: U128,
        max_premium_bps: u32,
        attached: u128,
    ) -> near_sdk::Promise {
        let round = self.state.round;
        self.read_price().then(self.callbacks().on_bid_price(
            round,
            bidder,
            notional,
            max_premium_bps,
            U128(attached),
        ))
    }

    fn can_open(&self) -> bool {
        self.state.phase == Phase::Idle
            && now_secs() >= self.state.last_finalize_time + self.params.min_idle_gap
            && self.token.total_supply > 0
            && self.state.locked_assets >= self.params.min_fill.0
            && self.state.last_pps > 0
    }

    fn check_can_open(&self) {
        require!(self.state.phase == Phase::Idle, "a round is live");
        require!(
            now_secs() >= self.state.last_finalize_time + self.params.min_idle_gap,
            "the idle gap has not elapsed"
        );
        require!(self.token.total_supply > 0, "no shares");
        require!(
            self.state.locked_assets >= self.params.min_fill.0,
            "nothing to offer"
        );
        require!(self.state.last_pps > 0, "the vault is worthless");
    }

    fn try_fill(
        &mut self,
        round: u32,
        bidder: &AccountId,
        notional: u128,
        max_premium_bps: u32,
        attached: u128,
        reading: &Result<Option<PythPrice>, PromiseError>,
    ) -> Result<u128, &'static str> {
        let start = env::storage_usage();
        let now = now_secs();
        if self.state.phase != Phase::Auction
            || self.state.round != round
            || now >= self.state.auction_end
        {
            return Err("the auction is no longer open");
        }
        let p = self.fresh(reading).ok_or("no fresh usable price")?;
        if p.expo != self.state.price_expo {
            return Err("price exponent changed");
        }
        if i128::from(p.price.0) >= self.state.strike {
            return Err("the option is in the money");
        }
        let bps = math::premium_bps(
            &self.state.params,
            self.state.opened_at,
            self.state.auction_end,
            now,
        );
        if bps > max_premium_bps {
            return Err("premium above your maximum");
        }
        let remaining = self.state.notional_offered - self.state.notional_sold;
        let filled = notional.min(remaining);
        if filled == 0 {
            return Err("sold out");
        }
        if filled < self.state.params.min_fill.0 && filled != remaining {
            return Err("below the minimum fill");
        }
        let premium = math::premium_for(filled, bps).ok_or("premium arithmetic")?;
        if premium == 0 {
            return Err("premium rounds to zero");
        }

        let key = (round, bidder.clone());
        let previous = self.fills.get(&key).cloned();
        let mut fill = previous.clone().unwrap_or(Fill {
            notional: U128(0),
            premium_paid: U128(0),
            claimed: false,
        });
        fill.notional = U128(fill.notional.0 + filled);
        fill.premium_paid = U128(fill.premium_paid.0 + premium);
        self.fills.insert(key.clone(), fill);
        self.fills.flush();
        let cost = storage_cost_since(start);
        if attached < premium + cost {
            match previous {
                Some(prev) => self.fills.insert(key, prev),
                None => self.fills.remove(&key),
            };
            return Err("not enough attached for premium and storage");
        }

        self.state.notional_sold += filled;
        self.state.premium_collected += premium;
        if self.state.notional_sold == self.state.notional_offered {
            self.state.phase = Phase::Active;
        }
        transfer(bidder, attached - premium - cost);
        emit(
            "bid_filled",
            json!({ "round": round, "bidder": bidder, "notional": U128(filled), "premium_bps": bps, "premium": U128(premium), "notional_sold_after": U128(self.state.notional_sold) }),
        );
        Ok(filled)
    }

    fn settle(&mut self, bounty_to: &AccountId, spot: i128) -> RoundOutcome {
        let s = &self.state;
        let n = math::round_numbers(
            Some(spot),
            s.strike,
            s.notional_sold,
            s.locked_at_open,
            s.premium_collected,
            s.shares_snapshot,
            s.params.settle_bounty_bps,
        )
        .unwrap_or_else(|| env::panic_str("round arithmetic"));
        self.state.bidder_claimable_total += n.payout_total;
        let wclaims = self.finalize_round(
            RoundOutcome::Settled,
            n.pps,
            n.assets_after,
            spot,
            n.payout_total,
        );
        transfer(bounty_to, n.bounty);
        emit(
            "round_settled",
            json!({ "round": self.state.round, "spot": spot.to_string(), "strike": self.state.strike.to_string(), "payout_total": U128(n.payout_total), "premium": U128(self.state.premium_collected), "pps": U128(n.pps), "bounty": U128(n.bounty), "withdrawals_paid": U128(wclaims) }),
        );
        RoundOutcome::Settled
    }

    fn void(&mut self, round: u32) -> RoundOutcome {
        self.state.bidder_claimable_total += self.state.premium_collected;
        let pps = self.state.last_pps;
        let assets = self.state.locked_at_open;
        let wclaims = self.finalize_round(RoundOutcome::Voided, pps, assets, 0, 0);
        emit(
            "round_voided",
            json!({ "round": round, "premium_refunded": U128(self.state.premium_collected), "pps": U128(pps), "withdrawals_paid": U128(wclaims) }),
        );
        RoundOutcome::Voided
    }
}
