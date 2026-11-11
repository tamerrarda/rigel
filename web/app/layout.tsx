import type { Metadata } from "next";
import "@near-wallet-selector/modal-ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rigel · covered call vaults on NEAR",
  description: "Deposit NEAR, an on-chain auction prices the call, depositors keep the premium. Bid from any chain through NEAR Intents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
