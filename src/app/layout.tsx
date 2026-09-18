import type { Metadata, Viewport } from "next";

import { ThemeProvider, themeBootstrapScript } from "@/components/ui/theme";
import { Toaster } from "@/components/ui/toast";

import "./globals.css";

/*
  The interface is set in the system face (SF Pro on Apple hardware, the platform face elsewhere),
  so nothing is downloaded and the app reads like the machine it runs on. Figures use the same
  face with tabular numerals, switched on globally in globals.css.
*/

export const metadata: Metadata = {
  title: { default: "Sooz Books", template: "%s · Sooz Books" },
  description: "Double-entry books for Sooz.",
  applicationName: "Sooz Books",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#111113" },
  ],
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The bootstrap script below stamps data-theme on <html> before React hydrates, an attribute the
  // server never rendered — which is exactly the case suppressHydrationWarning exists for.
  return (
    <html lang="en" suppressHydrationWarning className="antialiased">
      <head>
        {/* Sets the theme attribute ahead of React so the first frame is never the wrong colour. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className="min-h-dvh">
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
