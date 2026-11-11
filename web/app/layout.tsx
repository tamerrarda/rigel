import type { Metadata } from "next";
import "@near-wallet-selector/modal-ui/styles.css";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = {
  title: "Rigel",
  description: "Covered call vaults on NEAR. Deposit NEAR, an on-chain auction prices the option, depositors keep the premium.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div id="sky" aria-hidden />
          <SiteHeader />
          <main>{children}</main>
          <footer className="foot">
            <p>
              Pre-alpha · NEAR testnet · unaudited. Prices come from a trusted reporter publishing the median of three
              exchanges in Pyth&apos;s format, because Pyth on NEAR has not updated since 26 Aug 2026. The vault reads it
              exactly as it would read Pyth.
            </p>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
