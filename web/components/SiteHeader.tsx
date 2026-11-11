"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "./Providers";
import { usd } from "@/lib/format";

/** The four pages, in the order a depositor meets them. */
const PAGES = [
  ["/", "Vault"],
  ["/rounds/", "Rounds"],
  ["/claims/", "Claims"],
  ["/positions/", "My positions"],
] as const;

export function SiteHeader() {
  const here = usePathname();
  const { wallet, chain } = useApp();
  const price = chain.price;
  const age = price ? chain.now - price.publish_time : null;

  return (
    <header className="site">
      <Link className="brand" href="/">
        <img src="/rigel-mark.svg" alt="" width={26} height={26} />
        <span>RIGEL</span>
      </Link>
      <nav>
        {PAGES.map(([href, label]) => (
          <Link key={href} href={href} {...(here === href ? { "aria-current": "page" as const } : {})}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="corner spot-corner" title="Median of three exchanges, pushed in Pyth's format">
        <span className="k">NEAR/USD</span>
        <span>{price ? usd(price.price, price.expo) : "–"}</span>
        {age !== null && <em>{age}s ago</em>}
      </div>
      <div className="corner">
        {wallet.accountId ? (
          <button className="ghost" onClick={wallet.signOut} title="Sign out">
            {wallet.accountId}
          </button>
        ) : (
          <button disabled={!wallet.modal} onClick={() => wallet.modal?.show()}>
            Connect wallet
          </button>
        )}
      </div>
    </header>
  );
}
