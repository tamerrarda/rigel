//! Option holder side: what a fill is owed once its round finalizes.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::types::{Fill, Round, RoundOutcome};
use crate::{emit, math, transfer, RigelVault, RigelVaultExt};

/// What a fill is owed under a finalized round.
pub fn owed(round: &Round, fill: &Fill) -> u128 {
    if fill.claimed {
        return 0;
    }
    match round.outcome {
        RoundOutcome::Settled => math::payout_for(
            fill.notional.0,
            i128::from(round.settled_spot.0),
            i128::from(round.strike.0),
        )
        .unwrap_or(0),
        RoundOutcome::Voided => fill.premium_paid.0,
        RoundOutcome::Lapsed | RoundOutcome::Unresolved => 0,
    }
}

#[near]
impl RigelVault {
    /// Pays the caller what their fill in `round` is owed: the cash payout of
    /// a settled round above the strike, or the premium of a voided round.
    pub fn claim_payout(&mut self, round: u32) -> U128 {
        let bidder: AccountId = env::predecessor_account_id();
        let record = self
            .rounds
            .get(&round)
            .cloned()
            .unwrap_or_else(|| env::panic_str("that round has not finalized"));
        let key = (round, bidder.clone());
        let mut fill = self
            .fills
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no fill in that round"));
        let amount = owed(&record, &fill);
        require!(amount > 0, "nothing to claim");
        fill.claimed = true;
        self.fills.insert(key, fill);
        self.state.bidder_claimable_total -= amount;
        transfer(&bidder, amount);
        emit(
            "payout_claimed",
            json!({ "round": round, "bidder": bidder, "amount": U128(amount) }),
        );
        U128(amount)
    }
}
