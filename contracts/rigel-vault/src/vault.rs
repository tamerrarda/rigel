//! Depositor side: deposits, the pending queue, and withdrawals.
//!
//! While a round is live the pool is committed, so a deposit waits as a
//! pending deposit (cancellable at any time) and a withdrawal burns its shares
//! at once and is paid at the round's recorded price-per-share when the round
//! finalizes.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::types::{PendingDeposit, PendingWithdraw, Phase};
use crate::{emit, math, now_secs, storage_cost_since, transfer, RigelVault, RigelVaultExt};

#[near]
impl RigelVault {
    /// Deposits `amount` yoctoNEAR. Attach `amount` plus enough for storage
    /// (0.01 NEAR is plenty); the unused part is refunded. Mints shares at once
    /// when no round is live, otherwise queues the deposit. Returns the shares
    /// minted (0 when queued).
    #[payable]
    pub fn deposit(&mut self, amount: U128) -> U128 {
        let start = env::storage_usage();
        let from = env::predecessor_account_id();
        let amount = amount.0;
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= amount, "attach at least the deposit amount");
        self.lazy_finalize();
        require!(
            amount >= self.params.min_deposit.0,
            "below the minimum deposit"
        );
        require!(self.state.last_pps > 0, "the vault is worthless");

        let minted = if self.state.phase == Phase::Idle {
            if let Some(pending) = self.pending_deposits.get(&from).cloned() {
                self.redeem_pending(&from, &pending);
            }
            self.mint(&from, amount)
        } else {
            let round = self.state.round;
            let next = match self.pending_deposits.get(&from) {
                Some(p) if p.round == round => p.amount.0 + amount,
                Some(_) => env::panic_str("redeem the deposit from the last round first"),
                None => amount,
            };
            self.pending_deposits.insert(
                from.clone(),
                PendingDeposit {
                    round,
                    amount: U128(next),
                },
            );
            self.state.pending_deposits_total += amount;
            0
        };

        self.settle_storage(&from, attached - amount, start);
        emit(
            "deposited",
            json!({ "user": from, "round": self.state.round, "amount": U128(amount), "shares_minted": U128(minted), "instant": minted > 0 }),
        );
        U128(minted)
    }

    /// Returns a pending deposit in full. Allowed in every phase.
    pub fn cancel_pending_deposit(&mut self) -> U128 {
        let from = env::predecessor_account_id();
        self.lazy_finalize();
        let pending = self
            .pending_deposits
            .remove(&from)
            .unwrap_or_else(|| env::panic_str("nothing pending"));
        self.state.pending_deposits_total -= pending.amount.0;
        transfer(&from, pending.amount.0);
        emit(
            "deposit_cancelled",
            json!({ "user": from, "round": pending.round, "amount": pending.amount }),
        );
        pending.amount
    }

    /// Turns a pending deposit into shares once no round is live.
    pub fn redeem_shares(&mut self) -> U128 {
        let from = env::predecessor_account_id();
        self.lazy_finalize();
        require!(self.state.phase == Phase::Idle, "a round is live");
        require!(self.state.last_pps > 0, "the vault is worthless");
        let pending = self
            .pending_deposits
            .get(&from)
            .cloned()
            .unwrap_or_else(|| env::panic_str("nothing pending"));
        U128(self.redeem_pending(&from, &pending))
    }

    /// Burns `shares`. Paid at once when no round is live, otherwise queued and
    /// paid at the round's price-per-share when it finalizes. A queued
    /// withdrawal from an earlier, finalized round is paid out in the same call.
    /// Attach 0.01 NEAR for storage; the unused part is refunded.
    #[payable]
    pub fn request_withdraw(&mut self, shares: U128) -> U128 {
        let start = env::storage_usage();
        let from = env::predecessor_account_id();
        let shares = shares.0;
        let attached = env::attached_deposit().as_yoctonear();
        self.lazy_finalize();
        require!(shares > 0, "shares must be positive");
        require!(
            from != env::current_account_id(),
            "the dead shares cannot be withdrawn"
        );
        require!(
            self.token.accounts.get(&from).unwrap_or(0) >= shares,
            "not enough shares"
        );

        let mut paid = 0u128;
        if let Some(existing) = self.pending_withdraws.get(&from).cloned() {
            if self.rounds.contains_key(&existing.round) {
                paid = self.claim_pending_withdraw(&from, &existing);
            }
        }

        let round = self.state.round;
        let instant = if self.state.phase == Phase::Idle {
            let amount = math::assets_for_shares(shares, self.state.last_pps)
                .unwrap_or_else(|| env::panic_str("withdrawal arithmetic"));
            require!(
                amount > 0 || self.state.last_pps == 0,
                "withdrawal rounds to zero"
            );
            self.state.locked_assets -= amount;
            amount
        } else {
            let queued = match self.pending_withdraws.get(&from) {
                Some(p) if p.round == round => p.shares.0 + shares,
                _ => shares,
            };
            self.pending_withdraws.insert(
                from.clone(),
                PendingWithdraw {
                    round,
                    shares: U128(queued),
                },
            );
            self.state.burned_this_round += shares;
            0
        };
        self.burn(&from, shares);

        self.flush_maps();
        let cost = storage_cost_since(start);
        require!(attached >= cost, "attach NEAR for storage");
        transfer(&from, paid + instant + (attached - cost));
        emit(
            "withdraw_requested",
            json!({ "user": from, "round": round, "shares": U128(shares), "paid_now": U128(paid + instant) }),
        );
        U128(paid + instant)
    }

    /// Pays a queued withdrawal whose round has finalized.
    pub fn claim_withdraw(&mut self) -> U128 {
        let from = env::predecessor_account_id();
        self.lazy_finalize();
        let pending = self
            .pending_withdraws
            .get(&from)
            .cloned()
            .unwrap_or_else(|| env::panic_str("nothing pending"));
        let amount = self.claim_pending_withdraw(&from, &pending);
        transfer(&from, amount);
        U128(amount)
    }
}

impl RigelVault {
    fn redeem_pending(&mut self, user: &AccountId, pending: &PendingDeposit) -> u128 {
        self.state.pending_deposits_total -= pending.amount.0;
        self.pending_deposits.remove(user);
        let shares = self.mint(user, pending.amount.0);
        emit(
            "pending_redeemed",
            json!({ "user": user, "round": pending.round, "amount": pending.amount, "shares": U128(shares), "pps": U128(self.state.last_pps) }),
        );
        shares
    }

    fn claim_pending_withdraw(&mut self, user: &AccountId, pending: &PendingWithdraw) -> u128 {
        let record = self
            .rounds
            .get(&pending.round)
            .unwrap_or_else(|| env::panic_str("that round has not finalized"));
        let amount = math::assets_for_shares(pending.shares.0, record.pps.0)
            .unwrap_or_else(|| env::panic_str("withdrawal arithmetic"));
        self.state.withdraw_claimable_total -= amount;
        self.pending_withdraws.remove(user);
        emit(
            "withdraw_claimed",
            json!({ "user": user, "round": pending.round, "shares": pending.shares, "amount": U128(amount), "at": now_secs() }),
        );
        amount
    }

    /// Charges the storage written since `start` against `spare` and refunds the rest.
    fn settle_storage(&mut self, to: &AccountId, spare: u128, start: u64) {
        self.flush_maps();
        let cost = storage_cost_since(start);
        require!(
            spare >= cost,
            "attach NEAR for storage on top of the amount"
        );
        transfer(to, spare - cost);
    }
}
