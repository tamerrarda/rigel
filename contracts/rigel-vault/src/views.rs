//! Read-only views. These re-derive the lazy transitions so clients never
//! have to reimplement them.

use near_sdk::json_types::{I64, U128, U64};
use near_sdk::{near, AccountId};

use crate::claims::owed;
use crate::types::{BidderPositionView, ConfigView, EpochView, Phase, PositionView, Round};
use crate::{math, now_secs, RigelVault, RigelVaultExt};

#[near]
impl RigelVault {
    pub fn get_epoch(&self) -> EpochView {
        let s = &self.state;
        let now = now_secs();
        let past_auction = s.phase == Phase::Auction && now >= s.auction_end;
        let phase = match (past_auction, s.notional_sold > 0) {
            (true, true) => Phase::Active,
            (true, false) => Phase::Idle,
            _ => s.phase,
        };
        let live = s.phase != Phase::Idle;
        let gap = if s.round == 0 {
            self.params.min_idle_gap
        } else {
            s.params.min_idle_gap
        };
        EpochView {
            round: s.round,
            phase,
            outcome_pending: past_auction,
            opened_at: U64(s.opened_at),
            auction_end: U64(s.auction_end),
            expiry: U64(s.expiry),
            price_expo: s.price_expo,
            strike: I64(s.strike as i64),
            open_spot: I64(s.open_spot as i64),
            notional_offered: U128(s.notional_offered),
            notional_sold: U128(s.notional_sold),
            premium_collected: U128(s.premium_collected),
            current_premium_bps: if s.phase == Phase::Auction {
                math::premium_bps(&s.params, s.opened_at, s.auction_end, now)
            } else {
                0
            },
            locked_assets: U128(s.locked_assets),
            shares_outstanding: U128(self.token.total_supply),
            pending_deposits_total: U128(s.pending_deposits_total),
            last_pps: U128(s.last_pps),
            last_finalize_time: U64(s.last_finalize_time),
            next_open_at: U64(s.last_finalize_time + gap),
            settle_window_end: U64(if live {
                s.expiry + s.params.settle_window
            } else {
                0
            }),
            unresolved_at: U64(if live {
                s.expiry + s.params.unresolved_after
            } else {
                0
            }),
            params: if s.round == 0 {
                self.params.clone()
            } else {
                s.params.clone()
            },
        }
    }

    pub fn get_position(&self, account_id: AccountId) -> PositionView {
        let shares = self.token.accounts.get(&account_id).unwrap_or(0);
        let pending_withdraw = self.pending_withdraws.get(&account_id).cloned();
        let withdraw_claimable = pending_withdraw
            .as_ref()
            .and_then(|w| {
                self.rounds
                    .get(&w.round)
                    .and_then(|r| math::assets_for_shares(w.shares.0, r.pps.0))
            })
            .unwrap_or(0);
        PositionView {
            shares: U128(shares),
            share_value: U128(math::assets_for_shares(shares, self.state.last_pps).unwrap_or(0)),
            pending_deposit: self.pending_deposits.get(&account_id).cloned(),
            pending_withdraw,
            withdraw_claimable: U128(withdraw_claimable),
        }
    }

    pub fn get_round(&self, round: u32) -> Option<Round> {
        self.rounds.get(&round).cloned()
    }

    /// Finalized rounds from `from` (inclusive), newest first, at most `limit`.
    pub fn get_rounds(&self, from: Option<u32>, limit: Option<u32>) -> Vec<(u32, Round)> {
        let top = from.unwrap_or(self.state.round).min(self.state.round);
        let limit = limit.unwrap_or(20).min(100);
        (1..=top)
            .rev()
            .filter_map(|n| self.rounds.get(&n).map(|r| (n, r.clone())))
            .take(limit as usize)
            .collect()
    }

    pub fn get_bidder_position(&self, round: u32, account_id: AccountId) -> BidderPositionView {
        let Some(fill) = self.fills.get(&(round, account_id)) else {
            return BidderPositionView {
                notional: U128(0),
                premium_paid: U128(0),
                claimed: false,
                claimable: U128(0),
            };
        };
        let claimable = self.rounds.get(&round).map(|r| owed(r, fill)).unwrap_or(0);
        BidderPositionView {
            notional: fill.notional,
            premium_paid: fill.premium_paid,
            claimed: fill.claimed,
            claimable: U128(claimable),
        }
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            oracle: self.oracle.clone(),
            price_id: self.price_id.clone(),
            params: self.params.clone(),
        }
    }

    /// The NEAR the contract owes, against which its balance can be checked:
    /// pool, pending deposits, finalized withdrawals, and option holder claims.
    pub fn get_liabilities(&self) -> U128 {
        let s = &self.state;
        let in_round = if s.phase == Phase::Idle {
            0
        } else {
            s.premium_collected
        };
        U128(
            s.locked_assets
                + in_round
                + s.pending_deposits_total
                + s.withdraw_claimable_total
                + s.bidder_claimable_total,
        )
    }
}
