import type { Metadata } from "next";
import "@near-wallet-selector/modal-ui/styles.css";
import "./globals.css";

const DESCRIPTION =
  "A covered call vault on NEAR. Deposit NEAR, an on-chain Dutch auction sells a call on the pool, and the premium goes into the pool. Accepts bids delivered as wNEAR by NEAR Intents.";

export const metadata: Metadata = {
  metadataBase: new URL("https://rigelfinance.vercel.app"),
  title: "Rigel · a covered call vault on NEAR",
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Rigel",
    title: "Rigel · a covered call vault on NEAR",
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1600, height: 900, alt: "Rigel, a covered call vault on NEAR" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Rigel · a covered call vault on NEAR",
    description: DESCRIPTION,
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
