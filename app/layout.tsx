import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Johnston-style display face (freeware — see app/fonts/LICENSE.txt).
// Exposed as a CSS variable so globals.css and the map labels can pick it up
// with proper fallbacks.
const tubeFont = localFont({
  src: "./fonts/LondonTube.ttf",
  display: "swap",
  variable: "--font-tube",
});

export const metadata: Metadata = {
  title: "Oyster City",
  description: "Live map of London's Underground, Overground, DLR and trams.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={tubeFont.variable}>
      <body>{children}</body>
    </html>
  );
}
