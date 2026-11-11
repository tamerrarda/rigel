//! Bids paid in wNEAR through `ft_transfer_call`: the path NEAR Intents uses.
//!
//! The 1Click API can deliver a swap's output to a NEAR contract with
//! `ft_transfer_call` and a caller-chosen message (`customRecipientMsg`). So a
//! bidder holding USDC on Base, Arbitrum or Solana can ask 1Click for exactly
//! the wNEAR a bid needs, delivered to this vault with
//!
//! ```json
//! {"bid":{"notional":"<yocto>","max_premium_bps":150,"beneficiary":"<near account>"}}
//! ```
//!
//! and the vault runs the same bid it would for native NEAR.
//!
//! Flow: `ft_on_transfer` checks the bid (cheap, before taking anything), keeps
//! the wNEAR, unwraps it with `near_withdraw`, and on success reads the price
//! and fills or refunds in `on_bid_price`, in native NEAR, to the beneficiary.
//!
//! - A message that is not a bid, a token that is not wNEAR, or a bid that
//!   fails its checks is **returned in full** to the sender, as NEP-141 requires.
//! - The beneficiary receives refunds and any payout. It defaults to the sender.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PromiseError, PromiseOrValue};

use crate::{emit, RigelVault, RigelVaultExt};

const GAS_UNWRAP: Gas = Gas::from_tgas(10);
const GAS_ON_UNWRAPPED: Gas = Gas::from_tgas(70);

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct BidMsg {
    bid: BidArgs,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct BidArgs {
    notional: U128,
    max_premium_bps: u32,
    beneficiary: Option<AccountId>,
}

#[ext_contract(ext_wnear)]
pub trait WrappedNear {
    fn near_withdraw(&mut self, amount: U128);
}

#[ext_contract(ext_intents_self)]
pub trait IntentsCallbacks {
    fn on_unwrapped(
        &mut self,
        round: u32,
        bidder: AccountId,
        notional: U128,
        max_premium_bps: u32,
        amount: U128,
    ) -> bool;
}

/// What `ft_on_transfer` should do with an incoming transfer.
#[derive(Debug, PartialEq, Eq)]
pub enum Inbound {
    /// Return the tokens to the sender, with the reason.
    Return(&'static str),
    /// Keep the tokens and run this bid.
    Bid {
        bidder: AccountId,
        notional: u128,
        max_premium_bps: u32,
    },
}

impl RigelVault {
    /// Decides what to do with a transfer, without side effects.
    pub fn classify_inbound(
        &self,
        token: &AccountId,
        sender: &AccountId,
        amount: u128,
        msg: &str,
    ) -> Inbound {
        if self.wnear.as_ref() != Some(token) {
            return Inbound::Return("only wNEAR is accepted");
        }
        let Ok(m) = serde_json::from_str::<BidMsg>(msg) else {
            return Inbound::Return("message is not a bid");
        };
        let bidder = m.bid.beneficiary.unwrap_or_else(|| sender.clone());
        if let Err(reason) =
            self.check_bid(&bidder, m.bid.notional.0, m.bid.max_premium_bps, amount)
        {
            return Inbound::Return(reason);
        }
        Inbound::Bid {
            bidder,
            notional: m.bid.notional.0,
            max_premium_bps: m.bid.max_premium_bps,
        }
    }
}

#[near]
impl FungibleTokenReceiver for RigelVault {
    /// Receives wNEAR with a bid message. Returns the unused amount: everything
    /// when the transfer is refused, nothing when the bid is taken in.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        self.lazy_finalize();
        match self.classify_inbound(&token, &sender_id, amount.0, &msg) {
            Inbound::Return(reason) => {
                emit(
                    "inbound_returned",
                    json!({ "token": token, "sender": sender_id, "amount": amount, "reason": reason }),
                );
                PromiseOrValue::Value(amount)
            }
            Inbound::Bid {
                bidder,
                notional,
                max_premium_bps,
            } => {
                let round = self.state.round;
                ext_wnear::ext(token)
                    .with_attached_deposit(NearToken::from_yoctonear(1))
                    .with_static_gas(GAS_UNWRAP)
                    .near_withdraw(amount)
                    .then(
                        ext_intents_self::ext(env::current_account_id())
                            .with_static_gas(GAS_ON_UNWRAPPED)
                            .on_unwrapped(round, bidder, U128(notional), max_premium_bps, amount),
                    )
                    .detach();
                PromiseOrValue::Value(U128(0))
            }
        }
    }
}

#[near]
impl RigelVault {
    /// After `near_withdraw`: the wNEAR is now native NEAR in the vault, so the
    /// bid continues exactly as a native one. If unwrapping failed, the wNEAR
    /// is still held by the vault and is recorded in an event for recovery.
    #[private]
    pub fn on_unwrapped(
        &mut self,
        round: u32,
        bidder: AccountId,
        notional: U128,
        max_premium_bps: u32,
        amount: U128,
        #[callback_result] unwrapped: Result<(), PromiseError>,
    ) -> bool {
        if unwrapped.is_err() {
            emit(
                "unwrap_failed",
                json!({ "round": round, "bidder": bidder, "amount": amount }),
            );
            return false;
        }
        emit(
            "intent_bid_received",
            json!({ "round": round, "bidder": bidder, "notional": notional, "amount": amount }),
        );
        self.bid_with_price(bidder, notional, max_premium_bps, amount.0)
            .detach();
        true
    }
}
