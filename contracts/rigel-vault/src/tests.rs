//! Unit tests over the whole lifecycle. Oracle callbacks are driven directly
//! with the reading they would receive. A shadow ledger tracks every yoctoNEAR
//! that enters (attached deposits) and leaves (transfer receipts), and after
//! every step the contract's own liabilities must equal it exactly.

use near_sdk::json_types::{I64, U128, U64};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseError, PromiseOrValue};

use crate::epoch::BID_STORAGE_RESERVE;
use crate::types::{EpochParams, Phase, PythPrice, RoundOutcome, DEAD_SHARES, PRECISION};
use crate::RigelVault;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const STORAGE: u128 = NEAR / 100;
const T0: u64 = 1_800_000_000;
const PRICE_ID: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";

fn vault() -> AccountId {
    "vault.testnet".parse().unwrap()
}
fn alice() -> AccountId {
    "alice.testnet".parse().unwrap()
}
fn bob() -> AccountId {
    "bob.testnet".parse().unwrap()
}
fn carol() -> AccountId {
    "carol.testnet".parse().unwrap()
}
fn keeper() -> AccountId {
    "keeper.testnet".parse().unwrap()
}

fn params() -> EpochParams {
    EpochParams {
        epoch_duration: 3_600,
        auction_duration: 600,
        min_idle_gap: 60,
        strike_bps_otm: 300,
        premium_start_bps: 280,
        premium_floor_bps: 55,
        max_staleness: 60,
        max_conf_bps: 100,
        settle_window: 300,
        unresolved_after: 1_800,
        min_fill: U128(NEAR / 10),
        min_deposit: U128(NEAR),
        settle_bounty_bps: 50,
    }
}

fn price(p: i64, at: u64) -> Result<Option<PythPrice>, PromiseError> {
    Ok(Some(PythPrice {
        price: I64(p),
        conf: U64(1),
        expo: -8,
        publish_time: at as i64,
    }))
}

/// The contract plus the shadow ledger of NEAR it should hold for users.
struct H {
    c: RigelVault,
    now: u64,
    /// Attached deposits minus transfers out, net of storage the contract kept.
    held: i128,
    /// Storage fees the contract kept; not a liability.
    storage_kept: i128,
}

impl H {
    fn new() -> Self {
        let mut h = H {
            c: {
                ctx(&vault(), 0, T0);
                RigelVault::new(
                    "pyth-oracle.testnet".parse().unwrap(),
                    PRICE_ID.into(),
                    params(),
                )
            },
            now: T0,
            held: 0,
            storage_kept: 0,
        };
        h.now = T0 + 120; // past the genesis idle gap
        h
    }

    fn at(&mut self, who: &AccountId, deposit: u128) {
        ctx(who, deposit, self.now);
        self.held += deposit as i128;
    }

    /// Records transfers out and checks the books balance.
    fn settle_books(&mut self) {
        let out: u128 = get_created_receipts()
            .iter()
            .flat_map(|r| r.actions.iter())
            .map(|a| match a {
                MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
                _ => 0,
            })
            .sum();
        self.held -= out as i128;
    }

    fn check_books(&self) {
        assert_eq!(
            self.c.get_liabilities().0 as i128,
            self.held - self.storage_kept,
            "liabilities must equal the NEAR held for users"
        );
    }

    fn deposit(&mut self, who: &AccountId, amount: u128) -> u128 {
        self.at(who, amount + STORAGE);
        let minted = self.c.deposit(U128(amount)).0;
        self.settle_books();
        self.keep_storage();
        minted
    }

    fn open(&mut self, spot: i64) -> bool {
        self.at(&keeper(), 0);
        match self.c.open_epoch() {
            PromiseOrValue::Promise(_) => {}
            PromiseOrValue::Value(v) => return v,
        }
        self.at(&vault(), 0);
        let ok = self
            .c
            .on_open_price(self.c.state.round, price(spot, self.now));
        self.settle_books();
        self.check_books();
        ok
    }

    fn bid(&mut self, who: &AccountId, notional: u128, max_bps: u32, spot: i64) -> u128 {
        let attach = notional * u128::from(max_bps) / 10_000 + BID_STORAGE_RESERVE;
        self.at(who, attach);
        let _ = self.c.bid(U128(notional), max_bps);
        ctx(&vault(), 0, self.now);
        let filled = self.c.on_bid_price(
            self.c.state.round,
            who.clone(),
            U128(notional),
            max_bps,
            U128(attach),
            price(spot, self.now),
        );
        self.settle_books();
        self.keep_storage();
        filled.0
    }

    fn close(&mut self, reading: Result<Option<PythPrice>, PromiseError>) -> Option<RoundOutcome> {
        self.at(&keeper(), 0);
        let out = match self.c.close_round() {
            PromiseOrValue::Value(v) => v,
            PromiseOrValue::Promise(_) => {
                ctx(&vault(), 0, self.now);
                self.c.on_close_price(self.c.state.round, keeper(), reading)
            }
        };
        self.settle_books();
        self.check_books_after_bounty();
        out
    }

    /// Storage charged by the last call: must be positive-or-zero and at most
    /// the 0.01 NEAR reserve, or the call took (or gave) user money.
    fn keep_storage(&mut self) {
        let kept = self.held - self.c.get_liabilities().0 as i128;
        let charged = kept - self.storage_kept;
        assert!(
            (0..=STORAGE as i128).contains(&charged),
            "storage charge {charged} out of bounds"
        );
        self.storage_kept = kept;
    }

    /// The closer's bounty leaves the pool; it is a transfer like any other.
    fn check_books_after_bounty(&self) {
        self.check_books();
    }
}

fn ctx(who: &AccountId, deposit: u128, now: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(vault())
        .predecessor_account_id(who.clone())
        .signer_account_id(who.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1_000_000))
        .block_timestamp(now * 1_000_000_000)
        .build());
}

const SPOT: i64 = 300_000_000; // 3.00 USD at expo -8
const STRIKE: i64 = 309_000_000;

#[test]
fn first_deposit_mints_one_to_one_minus_dead_shares() {
    let mut h = H::new();
    let minted = h.deposit(&alice(), 100 * NEAR);
    assert_eq!(minted, 100 * NEAR - DEAD_SHARES);
    assert_eq!(h.c.token.total_supply, 100 * NEAR);
    assert_eq!(h.c.state.locked_assets, 100 * NEAR);
}

#[test]
#[should_panic(expected = "below the minimum deposit")]
fn tiny_deposit_is_refused() {
    let mut h = H::new();
    h.deposit(&alice(), NEAR / 2);
}

#[test]
fn open_sets_strike_out_of_the_money() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    assert!(h.open(SPOT));
    let e = h.c.get_epoch();
    assert_eq!(e.round, 1);
    assert_eq!(e.phase, Phase::Auction);
    assert_eq!(e.strike.0, STRIKE);
    assert_eq!(e.notional_offered.0, 100 * NEAR);
    assert_eq!(e.current_premium_bps, 280);
}

#[test]
fn open_refuses_stale_price() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    h.at(&keeper(), 0);
    let _ = h.c.open_epoch();
    h.at(&vault(), 0);
    assert!(!h.c.on_open_price(0, price(SPOT, h.now - 61)));
    assert_eq!(h.c.state.phase, Phase::Idle);
}

#[test]
fn open_refuses_wide_confidence() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    h.at(&keeper(), 0);
    let _ = h.c.open_epoch();
    h.at(&vault(), 0);
    let wide = Ok(Some(PythPrice {
        price: I64(SPOT),
        conf: U64(SPOT as u64 / 50),
        expo: -8,
        publish_time: h.now as i64,
    }));
    assert!(!h.c.on_open_price(0, wide));
}

#[test]
fn second_open_callback_is_a_no_op() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    assert!(h.open(SPOT));
    h.at(&vault(), 0);
    assert!(!h.c.on_open_price(0, price(SPOT, h.now)));
    assert_eq!(h.c.state.round, 1);
}

#[test]
fn bid_fills_at_the_curve_and_refunds_the_rest() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    h.open(SPOT);
    h.now += 300; // halfway: 280 - 112 = 168 bps
    let filled = h.bid(&bob(), 40 * NEAR, 280, SPOT);
    assert_eq!(filled, 40 * NEAR);
    assert_eq!(h.c.state.premium_collected, 40 * NEAR * 168 / 10_000);
    let pos = h.c.get_bidder_position(1, bob());
    assert_eq!(pos.notional.0, 40 * NEAR);
}

#[test]
fn bid_in_the_money_is_refunded_in_full() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    h.open(SPOT);
    let filled = h.bid(&bob(), 40 * NEAR, 280, STRIKE);
    assert_eq!(filled, 0);
    assert_eq!(h.c.state.notional_sold, 0);
}

#[test]
fn bid_above_max_premium_is_refunded() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    h.open(SPOT);
    // bid() is checked again in the callback: let the curve be above max there.
    h.at(&bob(), 40 * NEAR * 280 / 10_000 + BID_STORAGE_RESERVE);
    let attach = 40 * NEAR * 280 / 10_000 + BID_STORAGE_RESERVE;
    ctx(&vault(), 0, h.now);
    let filled = h.c.on_bid_price(
        1,
        bob(),
        U128(40 * NEAR),
        100,
        U128(attach),
        price(SPOT, h.now),
    );
    h.settle_books();
    h.check_books();
    assert_eq!(filled.0, 0);
}

#[test]
fn oversized_bid_takes_what_is_left_and_ends_the_auction() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    h.open(SPOT);
    h.bid(&bob(), 60 * NEAR, 280, SPOT);
    let filled = h.bid(&carol(), 90 * NEAR, 280, SPOT);
    assert_eq!(filled, 40 * NEAR);
    assert_eq!(h.c.state.phase, Phase::Active);
}

#[test]
fn round_with_no_bids_lapses() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    h.open(SPOT);
    h.now += 600;
    h.at(&keeper(), 0);
    assert_eq!(h.c.get_epoch().phase, Phase::Idle);
    assert!(h.c.get_epoch().outcome_pending);
    assert_eq!(h.close(price(SPOT, h.now)), Some(RoundOutcome::Lapsed));
    let r = h.c.get_round(1).unwrap();
    assert_eq!(r.outcome, RoundOutcome::Lapsed);
    assert_eq!(r.pps.0, PRECISION);
}

fn sold_round(h: &mut H) -> u128 {
    h.deposit(&alice(), 100 * NEAR);
    h.open(SPOT);
    h.bid(&bob(), 50 * NEAR, 280, SPOT);
    h.now = h.c.state.expiry;
    h.c.state.premium_collected
}

#[test]
fn close_before_expiry_is_refused() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    h.open(SPOT);
    h.bid(&bob(), 50 * NEAR, 280, SPOT);
    h.now += 700;
    h.at(&keeper(), 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h.c.close_round()));
    assert!(r.is_err());
}

#[test]
fn settled_below_strike_keeps_the_premium() {
    let mut h = H::new();
    let premium = sold_round(&mut h);
    let at = h.now;
    assert_eq!(h.close(price(SPOT, at)), Some(RoundOutcome::Settled));
    let r = h.c.get_round(1).unwrap();
    assert_eq!(r.payout_total.0, 0);
    let bounty = premium * 50 / 10_000;
    assert_eq!(h.c.state.locked_assets, 100 * NEAR + premium - bounty);
    assert!(r.pps.0 > PRECISION);
}

#[test]
fn settled_above_strike_pays_the_option_holder() {
    let mut h = H::new();
    let premium = sold_round(&mut h);
    let spot = STRIKE * 2; // payout is half the notional
    let at = h.now + 10;
    h.now = at;
    assert_eq!(h.close(price(spot, at)), Some(RoundOutcome::Settled));
    let r = h.c.get_round(1).unwrap();
    assert_eq!(r.payout_total.0, 25 * NEAR);
    let bounty = premium * 50 / 10_000;
    assert_eq!(
        h.c.state.locked_assets,
        100 * NEAR + premium - 25 * NEAR - bounty
    );

    assert_eq!(h.c.get_bidder_position(1, bob()).claimable.0, 25 * NEAR);
    h.at(&bob(), 0);
    assert_eq!(h.c.claim_payout(1).0, 25 * NEAR);
    h.settle_books();
    h.check_books();
    assert_eq!(h.c.get_bidder_position(1, bob()).claimable.0, 0);
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn payout_cannot_be_claimed_twice() {
    let mut h = H::new();
    sold_round(&mut h);
    let at = h.now;
    h.close(price(STRIKE * 2, at));
    h.at(&bob(), 0);
    h.c.claim_payout(1);
    h.at(&bob(), 0);
    h.c.claim_payout(1);
}

#[test]
fn price_before_expiry_does_not_close() {
    let mut h = H::new();
    sold_round(&mut h);
    let at = h.now - 1;
    assert_eq!(h.close(price(STRIKE * 2, at)), None);
    assert_eq!(h.c.state.phase, Phase::Active);
}

#[test]
fn price_after_the_window_resolves_unresolved() {
    let mut h = H::new();
    let premium = sold_round(&mut h);
    h.now += 400;
    let at = h.now;
    assert_eq!(
        h.close(price(STRIKE * 2, at)),
        Some(RoundOutcome::Unresolved)
    );
    let r = h.c.get_round(1).unwrap();
    assert_eq!(r.payout_total.0, 0);
    let bounty = premium * 50 / 10_000;
    assert_eq!(h.c.state.locked_assets, 100 * NEAR + premium - bounty);
    assert_eq!(h.c.get_bidder_position(1, bob()).claimable.0, 0);
}

#[test]
fn past_unresolved_after_the_oracle_is_not_called() {
    let mut h = H::new();
    sold_round(&mut h);
    h.now += 1_800;
    h.at(&keeper(), 0);
    match h.c.close_round() {
        PromiseOrValue::Value(v) => assert_eq!(v, Some(RoundOutcome::Unresolved)),
        PromiseOrValue::Promise(_) => panic!("must not call the oracle"),
    }
    h.settle_books();
    h.check_books();
}

#[test]
fn unusable_price_in_window_voids_and_refunds() {
    let mut h = H::new();
    let premium = sold_round(&mut h);
    let at = h.now + 5;
    h.now = at;
    let bad = Ok(Some(PythPrice {
        price: I64(SPOT),
        conf: U64(SPOT as u64),
        expo: -8,
        publish_time: at as i64,
    }));
    assert_eq!(h.close(bad), Some(RoundOutcome::Voided));
    assert_eq!(h.c.state.locked_assets, 100 * NEAR);
    assert_eq!(h.c.get_bidder_position(1, bob()).claimable.0, premium);
    h.at(&bob(), 0);
    assert_eq!(h.c.claim_payout(1).0, premium);
    h.settle_books();
    h.check_books();
}

#[test]
fn changed_exponent_voids() {
    let mut h = H::new();
    sold_round(&mut h);
    let at = h.now;
    let odd = Ok(Some(PythPrice {
        price: I64(SPOT),
        conf: U64(1),
        expo: -6,
        publish_time: at as i64,
    }));
    assert_eq!(h.close(odd), Some(RoundOutcome::Voided));
}

#[test]
fn deposit_during_round_waits_and_can_be_cancelled() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    h.open(SPOT);
    assert_eq!(h.deposit(&carol(), 10 * NEAR), 0);
    assert_eq!(
        h.c.get_position(carol()).pending_deposit.unwrap().amount.0,
        10 * NEAR
    );
    h.at(&carol(), 0);
    assert_eq!(h.c.cancel_pending_deposit().0, 10 * NEAR);
    h.settle_books();
    h.check_books();
    assert!(h.c.get_position(carol()).pending_deposit.is_none());
}

#[test]
fn pending_deposit_joins_at_the_new_price_per_share() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    h.open(SPOT);
    h.deposit(&carol(), 10 * NEAR);
    h.bid(&bob(), 50 * NEAR, 280, SPOT);
    h.now = h.c.state.expiry;
    let at = h.now;
    h.close(price(SPOT, at));
    let pps = h.c.state.last_pps;
    h.at(&carol(), 0);
    let shares = h.c.redeem_shares().0;
    h.settle_books();
    h.check_books();
    assert_eq!(shares, 10 * NEAR * PRECISION / pps);
}

#[test]
fn withdrawal_during_round_is_paid_at_the_round_price() {
    let mut h = H::new();
    let shares = h.deposit(&alice(), 100 * NEAR);
    h.open(SPOT);
    h.bid(&bob(), 50 * NEAR, 280, SPOT);
    h.at(&alice(), STORAGE);
    assert_eq!(h.c.request_withdraw(U128(shares / 2)).0, 0);
    h.settle_books();
    h.storage_kept = h.held - h.c.get_liabilities().0 as i128;
    h.check_books();

    h.now = h.c.state.expiry;
    let at = h.now;
    h.close(price(STRIKE * 2, at));
    let r = h.c.get_round(1).unwrap();
    let expected = (shares / 2) * r.pps.0 / PRECISION;
    assert_eq!(h.c.get_position(alice()).withdraw_claimable.0, expected);
    h.at(&alice(), 0);
    assert_eq!(h.c.claim_withdraw().0, expected);
    h.settle_books();
    h.check_books();
}

#[test]
fn idle_withdrawal_is_instant() {
    let mut h = H::new();
    let shares = h.deposit(&alice(), 100 * NEAR);
    h.at(&alice(), STORAGE);
    let paid = h.c.request_withdraw(U128(shares)).0;
    h.settle_books();
    h.check_books();
    assert_eq!(paid, shares);
    assert_eq!(h.c.token.total_supply, DEAD_SHARES);
}

#[test]
fn next_round_waits_for_the_idle_gap() {
    let mut h = H::new();
    sold_round(&mut h);
    let at = h.now;
    h.close(price(SPOT, at));
    h.at(&keeper(), 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h.c.open_epoch())).is_err());
    h.now += 60;
    assert!(h.open(SPOT));
    assert_eq!(h.c.state.round, 2);
}

#[test]
fn many_rounds_keep_the_books() {
    let mut h = H::new();
    h.deposit(&alice(), 100 * NEAR);
    h.deposit(&carol(), 37 * NEAR + 123);
    let spots = [SPOT, STRIKE * 3 / 2, SPOT / 2, STRIKE + 1, SPOT];
    for (i, s) in spots.iter().enumerate() {
        h.now += 61;
        assert!(h.open(SPOT));
        h.now += 100 + i as u64 * 50;
        h.bid(&bob(), 30 * NEAR + i as u128, 280, SPOT);
        h.bid(&carol(), 1_000 * NEAR, 280, SPOT);
        h.now = h.c.state.expiry + 1;
        let at = h.now;
        assert_eq!(h.close(price(*s, at)), Some(RoundOutcome::Settled));
        for who in [bob(), carol()] {
            if h.c
                .get_bidder_position(i as u32 + 1, who.clone())
                .claimable
                .0
                > 0
            {
                h.at(&who, 0);
                h.c.claim_payout(i as u32 + 1);
                h.settle_books();
                h.check_books();
            }
        }
    }
    assert_eq!(h.c.state.bidder_claimable_total, 0);
}
