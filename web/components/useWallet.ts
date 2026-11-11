"use client";

import { useEffect, useState } from "react";
import type { WalletSelector } from "@near-wallet-selector/core";
import type { WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { NETWORK, VAULT } from "@/lib/near";

export interface WalletState {
  selector: WalletSelector | null;
  modal: WalletSelectorModal | null;
  accountId: string | null;
  signOut: () => Promise<void>;
}

export function useWallet(): WalletState {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    (async () => {
      const [{ setupWalletSelector }, { setupModal }, mnw, intear] = await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/modal-ui"),
        import("@near-wallet-selector/my-near-wallet"),
        import("@near-wallet-selector/intear-wallet"),
      ]);
      const s = await setupWalletSelector({
        network: NETWORK,
        modules: [mnw.setupMyNearWallet(), intear.setupIntearWallet()],
      });
      const m = setupModal(s, { contractId: VAULT });
      const sub = s.store.observable.subscribe((state) => {
        setAccountId(state.accounts.find((a) => a.active)?.accountId ?? null);
      });
      unsubscribe = () => sub.unsubscribe();
      setSelector(s);
      setModal(m);
    })().catch((e) => console.error("wallet setup failed", e));
    return () => unsubscribe?.();
  }, []);

  const signOut = async () => {
    if (!selector) return;
    const w = await selector.wallet();
    await w.signOut();
  };

  return { selector, modal, accountId, signOut };
}
