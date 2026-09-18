'use client';

import { ErrorState } from '@/components/ui/error-state';
import { themeBootstrapScript } from '@/components/ui/theme';

import './globals.css';

/**
 * The root layout itself failed. This replaces the whole document, so it brings its own <html>,
 * the stylesheet and the stored appearance.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en" suppressHydrationWarning className="antialiased">
      <head>
        <title>Sooz Books</title>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className="grid min-h-dvh place-items-center bg-bg text-label">
        <ErrorState
          title="Sooz Books didn’t load"
          onRetry={retry}
          digest={error.digest}
          secondaryAction={
            // A plain link on purpose: the router may be what failed.
            <a
              href="/dashboard"
              className="inline-flex h-8 items-center rounded-[9px] bg-ctl px-3 text-sm font-medium text-label shadow-ctl max-sm:h-11 max-sm:px-4"
            >
              Go home
            </a>
          }
        />
      </body>
    </html>
  );
}
