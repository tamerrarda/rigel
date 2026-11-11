//! Pure arithmetic: the auction curve, the settlement numbers, and a 256-bit
//! `mul_div`. Nothing here touches the environment, so all of it is unit
//! tested directly.

use crate::types::{EpochParams, BPS, PRECISION};

uint::construct_uint! {
    /// 256-bit unsigned integer for intermediate products.
    pub struct U256(4);
}

/// `a × b / d`, rounded down. `None` when `d` is zero or the result does not
/// fit in 128 bits; the product itself never overflows.
pub fn mul_div(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    let r = U256::from(a) * U256::from(b) / U256::from(d);
    if r > U256::from(u128::MAX) {
        None
    } else {
        Some(r.as_u128())
    }
}

/// The premium in bps at `now`: a straight line from `premium_start_bps` at
/// `opened_at` to `premium_floor_bps` at `auction_end`. 0 outside the window.
pub fn premium_bps(params: &EpochParams, opened_at: u64, auction_end: u64, now: u64) -> u32 {
    if now < opened_at || now >= auction_end {
        return 0;
    }
    let span = u64::from(
        params
            .premium_start_bps
            .saturating_sub(params.premium_floor_bps),
    );
    let duration = auction_end - opened_at;
    let elapsed = now - opened_at;
    let decayed = span * elapsed / duration;
    params.premium_start_bps - decayed as u32
}

/// The premium owed for `filled` notional at `bps`.
pub fn premium_for(filled: u128, bps: u32) -> Option<u128> {
    mul_div(filled, u128::from(bps), BPS)
}

/// The strike for a round opened at `spot`.
pub fn strike_for(spot: i128, strike_bps_otm: u32) -> Option<i128> {
    if spot <= 0 {
        return None;
    }
    let s = mul_div(spot as u128, BPS + u128::from(strike_bps_otm), BPS)?;
    i128::try_from(s).ok()
}

/// The NEAR owed to the holder of `notional` when the option settles at
/// `spot` against `strike`: cash settlement in the collateral asset,
/// `notional × (spot − strike) / spot`. Never more than `notional`.
pub fn payout_for(notional: u128, spot: i128, strike: i128) -> Option<u128> {
    if spot <= strike {
        return Some(0);
    }
    if strike <= 0 {
        return None;
    }
    mul_div(notional, (spot - strike) as u128, spot as u128)
}

/// What a finalizing round does to the pool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoundNumbers {
    pub payout_total: u128,
    pub bounty: u128,
    /// The pool after the round, before withdrawals of this round are paid.
    pub assets_after: u128,
    pub pps: u128,
}

/// The settlement arithmetic. `spot` is `None` for an `Unresolved` round, which
/// pays no option holder. The pool keeps the premium in every case; the bounty
/// is paid out of it.
pub fn round_numbers(
    spot: Option<i128>,
    strike: i128,
    notional_sold: u128,
    locked_at_open: u128,
    premium_collected: u128,
    shares_snapshot: u128,
    bounty_bps: u32,
) -> Option<RoundNumbers> {
    if shares_snapshot == 0 || notional_sold > locked_at_open {
        return None;
    }
    let payout_total = match spot {
        Some(s) => payout_for(notional_sold, s, strike)?,
        None => 0,
    };
    let bounty = mul_div(premium_collected, u128::from(bounty_bps), BPS)?;
    let assets_after = locked_at_open
        .checked_add(premium_collected)?
        .checked_sub(payout_total)?
        .checked_sub(bounty)?;
    let pps = mul_div(assets_after, PRECISION, shares_snapshot)?;
    Some(RoundNumbers {
        payout_total,
        bounty,
        assets_after,
        pps,
    })
}

/// NEAR owed for `shares` at `pps`.
pub fn assets_for_shares(shares: u128, pps: u128) -> Option<u128> {
    mul_div(shares, pps, PRECISION)
}

/// Shares minted for `amount` NEAR at `pps`.
pub fn shares_for_assets(amount: u128, pps: u128) -> Option<u128> {
    mul_div(amount, PRECISION, pps)
}

/// Whether a Pyth reading is usable: positive, and a confidence interval no
/// wider than `max_conf_bps` of the price.
pub fn price_usable(price: i64, conf: u64, max_conf_bps: u32) -> bool {
    if price <= 0 {
        return false;
    }
    match mul_div(u128::from(conf), BPS, price as u128) {
        Some(ratio) => ratio <= u128::from(max_conf_bps),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::U128;

    fn params() -> EpochParams {
        EpochParams {
            epoch_duration: 3600,
            auction_duration: 600,
            min_idle_gap: 60,
            strike_bps_otm: 300,
            premium_start_bps: 280,
            premium_floor_bps: 55,
            max_staleness: 60,
            max_conf_bps: 100,
            settle_window: 300,
            unresolved_after: 1800,
            min_fill: U128(1),
            min_deposit: U128(DEAD + 1),
            settle_bounty_bps: 50,
        }
    }
    const DEAD: u128 = crate::types::DEAD_SHARES;
    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    #[test]
    fn mul_div_survives_products_above_u128() {
        let big = 1_000_000 * NEAR; // 1e30
        assert_eq!(mul_div(big, PRECISION, PRECISION), Some(big));
        assert_eq!(mul_div(1, 1, 0), None);
        assert_eq!(mul_div(u128::MAX, 2, 1), None);
    }

    #[test]
    fn curve_runs_from_start_to_floor() {
        let p = params();
        assert_eq!(premium_bps(&p, 1000, 1600, 999), 0);
        assert_eq!(premium_bps(&p, 1000, 1600, 1000), 280);
        assert_eq!(premium_bps(&p, 1000, 1600, 1300), 280 - 112); // half of 225, floored
        assert_eq!(premium_bps(&p, 1000, 1600, 1599), 56);
        assert_eq!(premium_bps(&p, 1000, 1600, 1600), 0);
    }

    #[test]
    fn curve_never_drops_below_floor_inside_window() {
        let p = params();
        for t in 1000..1600 {
            assert!(premium_bps(&p, 1000, 1600, t) >= p.premium_floor_bps);
        }
    }

    #[test]
    fn strike_is_out_of_the_money() {
        assert_eq!(strike_for(1_000_000, 300), Some(1_030_000));
        assert_eq!(strike_for(0, 300), None);
    }

    #[test]
    fn payout_is_zero_at_or_below_strike_and_bounded_above() {
        assert_eq!(payout_for(100 * NEAR, 103, 103), Some(0));
        assert_eq!(payout_for(100 * NEAR, 90, 103), Some(0));
        // spot 206 against strike 103: half the notional.
        assert_eq!(payout_for(100 * NEAR, 206, 103), Some(50 * NEAR));
        // Never above notional, however far the price runs.
        assert!(payout_for(100 * NEAR, i64::MAX as i128, 103).unwrap() < 100 * NEAR);
    }

    #[test]
    fn otm_round_keeps_premium() {
        let n = round_numbers(Some(100), 103, 50 * NEAR, 100 * NEAR, NEAR, 100 * NEAR, 0).unwrap();
        assert_eq!(n.payout_total, 0);
        assert_eq!(n.assets_after, 101 * NEAR);
        assert_eq!(n.pps, PRECISION * 101 / 100);
    }

    #[test]
    fn itm_round_pays_and_keeps_premium() {
        // spot 206, strike 103, 50 NEAR sold: payout 25 NEAR.
        let n =
            round_numbers(Some(206), 103, 50 * NEAR, 100 * NEAR, NEAR, 100 * NEAR, 100).unwrap();
        assert_eq!(n.payout_total, 25 * NEAR);
        assert_eq!(n.bounty, NEAR / 100);
        assert_eq!(n.assets_after, 100 * NEAR + NEAR - 25 * NEAR - NEAR / 100);
    }

    #[test]
    fn unresolved_round_pays_nobody() {
        let n = round_numbers(None, 103, 50 * NEAR, 100 * NEAR, NEAR, 100 * NEAR, 0).unwrap();
        assert_eq!(n.payout_total, 0);
        assert_eq!(n.assets_after, 101 * NEAR);
    }

    #[test]
    fn pool_stays_solvent_for_any_spot() {
        // The pool can always cover the payout: it is bounded by notional_sold,
        // which is bounded by locked_at_open.
        for spot in [1i128, 50, 103, 104, 1_000, 1_000_000, i64::MAX as i128] {
            let n =
                round_numbers(Some(spot), 103, 100 * NEAR, 100 * NEAR, 0, 100 * NEAR, 0).unwrap();
            assert!(n.payout_total <= 100 * NEAR);
        }
    }

    #[test]
    fn share_round_trip_never_creates_value() {
        for pps in [1, PRECISION / 3, PRECISION, PRECISION * 7 / 3] {
            let shares = shares_for_assets(10 * NEAR + 7, pps).unwrap();
            assert!(assets_for_shares(shares, pps).unwrap() <= 10 * NEAR + 7);
        }
    }

    #[test]
    fn price_usability() {
        assert!(price_usable(1000, 10, 100));
        assert!(!price_usable(1000, 11, 100));
        assert!(!price_usable(0, 0, 100));
        assert!(!price_usable(-5, 0, 100));
    }
}
