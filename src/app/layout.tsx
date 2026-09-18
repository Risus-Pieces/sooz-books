import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Public_Sans } from "next/font/google";

import { ThemeProvider, themeBootstrapScript } from "@/components/ui/theme";
import { Toaster } from "@/components/ui/toast";

import "./globals.css";

/**
 * Public Sans for the interface: a humanist face drawn for civic forms, so it stays legible at the
 * 13px the registers run at. IBM Plex Mono carries every figure — a monospaced face is tabular by
 * construction and its slashed zero cannot be confused with an O in an account code.
 */
const sans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
  display: "swap",
});

const figures = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Sooz Books", template: "%s · Sooz Books" },
  description: "Double-entry books for Sooz.",
  applicationName: "Sooz Books",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e9e5dc" },
    { media: "(prefers-color-scheme: dark)", color: "#121417" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The bootstrap script below stamps data-theme on <html> before React hydrates, an attribute the
  // server never rendered — which is exactly the case suppressHydrationWarning exists for.
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sans.variable} ${figures.variable} h-full antialiased`}
    >
      <head>
        {/* Sets the theme attribute ahead of React so the first frame is never the wrong colour. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className="min-h-full">
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
