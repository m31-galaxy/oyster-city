import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Oyster City",
  description: "Live London transport in your browser — a TfL Go equivalent.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
