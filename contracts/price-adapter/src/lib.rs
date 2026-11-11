//! A trusted stand-in for Pyth on NEAR testnet.
//!
//! Pyth on NEAR has not updated since 26 Aug 2026, when its Hermes service
//! began requiring an API key, so there is no live price to read. This
//! contract exposes the same `get_price_unsafe` view, with the same JSON
//! shape, so the vault reads it exactly as it would read Pyth and can be
//! pointed at Pyth again without a code change.
//!
//! **It is trusted.** One reporter account pushes prices, and the vault
//! believes them. The rules below narrow what a reporter can do (no
//! rewriting history, no prices from the future) but do not remove the
//! trust. This is a testnet demo component, not a production oracle.

use near_sdk::json_types::{I64, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

/// How far ahead of block time a publish time may be, in seconds.
const MAX_FUTURE_SKEW: i64 = 10;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Price {
    pub price: I64,
    pub conf: U64,
    pub expo: i32,
    pub publish_time: i64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PriceAdapter {
    reporter: AccountId,
    prices: LookupMap<String, Price>,
}

#[near]
impl PriceAdapter {
    #[init]
    pub fn new(reporter: AccountId) -> Self {
        Self {
            reporter,
            prices: LookupMap::new(b"p"),
        }
    }

    /// Stores a price for `price_identifier` (hex feed id, as in Pyth). Only
    /// the reporter may call it. Like Pyth, an update older than the stored
    /// one is ignored rather than applied; returns whether it was stored.
    pub fn push_price(&mut self, price_identifier: String, price: Price) -> bool {
        require!(
            env::predecessor_account_id() == self.reporter,
            "only the reporter can push"
        );
        require!(price.price.0 > 0, "price must be positive");
        let now = (env::block_timestamp() / 1_000_000_000) as i64;
        require!(
            price.publish_time <= now + MAX_FUTURE_SKEW,
            "publish time is in the future"
        );
        let id = price_identifier.to_ascii_lowercase();
        if let Some(stored) = self.prices.get(&id) {
            if stored.publish_time >= price.publish_time {
                return false;
            }
        }
        near_sdk::log!(
            "price {} {}e{} at {}",
            id,
            price.price.0,
            price.expo,
            price.publish_time
        );
        self.prices.insert(id, price);
        true
    }

    /// The newest stored price, whatever its age. Same shape as Pyth's.
    pub fn get_price_unsafe(&self, price_identifier: String) -> Option<Price> {
        self.prices
            .get(&price_identifier.to_ascii_lowercase())
            .cloned()
    }

    pub fn get_reporter(&self) -> AccountId {
        self.reporter.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const ID: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";

    fn ctx(who: &str, now: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .block_timestamp(now * 1_000_000_000)
            .build());
    }

    fn p(v: i64, t: i64) -> Price {
        Price {
            price: I64(v),
            conf: U64(1),
            expo: -8,
            publish_time: t,
        }
    }

    #[test]
    fn reporter_pushes_and_anyone_reads() {
        ctx("reporter.testnet", 1_000);
        let mut c = PriceAdapter::new("reporter.testnet".parse().unwrap());
        assert!(c.push_price(ID.into(), p(300, 1_000)));
        assert_eq!(c.get_price_unsafe(ID.to_uppercase()), Some(p(300, 1_000)));
    }

    #[test]
    fn older_update_is_ignored() {
        ctx("reporter.testnet", 1_000);
        let mut c = PriceAdapter::new("reporter.testnet".parse().unwrap());
        assert!(c.push_price(ID.into(), p(300, 1_000)));
        assert!(!c.push_price(ID.into(), p(999, 999)));
        assert!(!c.push_price(ID.into(), p(999, 1_000)));
        assert_eq!(c.get_price_unsafe(ID.into()).unwrap().price.0, 300);
    }

    #[test]
    #[should_panic(expected = "only the reporter")]
    fn strangers_cannot_push() {
        ctx("reporter.testnet", 1_000);
        let mut c = PriceAdapter::new("reporter.testnet".parse().unwrap());
        ctx("mallory.testnet", 1_000);
        c.push_price(ID.into(), p(300, 1_000));
    }

    #[test]
    #[should_panic(expected = "in the future")]
    fn future_prices_are_refused() {
        ctx("reporter.testnet", 1_000);
        let mut c = PriceAdapter::new("reporter.testnet".parse().unwrap());
        c.push_price(ID.into(), p(300, 1_011));
    }
}
