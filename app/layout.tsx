import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "CodeArchitect AI",
  description: "Interactive architecture graphs, blast-radius analysis and codebase time-machine.",
  authors: [{ name: "Hussain Tak", url: "https://github.com/imhussain001" }],
  creator: "Hussain Tak",
  other: { copyright: "Copyright 2026 Hussain Tak. Licensed under the Apache License 2.0." },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="h-full overflow-hidden font-sans antialiased">{children}</body>
    </html>
  );
}
