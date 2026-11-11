"use client";

import { createContext, useContext } from "react";
import { useWallet, type WalletState } from "./useWallet";
import { useChain, type Chain } from "./useChain";

interface App {
  wallet: WalletState;
  chain: Chain;
}

const Ctx = createContext<App | null>(null);

/** One wallet and one chain poller for every page. */
export function Providers({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const chain = useChain(wallet.accountId);
  return <Ctx.Provider value={{ wallet, chain }}>{children}</Ctx.Provider>;
}

export function useApp(): App {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside Providers");
  return v;
}
