import { Providers } from "@/components/Providers";
import { SiteHeader } from "@/components/SiteHeader";

/** The app shell: one wallet and chain poller, the site header, the footer. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <div id="sky" aria-hidden />
      <SiteHeader />
      <main>{children}</main>
      <footer className="foot">
        <p>
          Pre-alpha · NEAR testnet · unaudited. Prices come from a trusted reporter publishing a median of exchange
          prices in Pyth&apos;s format, because Pyth on NEAR has not updated since 26 Aug 2026. The vault reads it
          exactly as it would read Pyth.
        </p>
      </footer>
    </Providers>
  );
}
