import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sign in',
};

/**
 * The frame around everything that happens before there is a session. Deliberately unlike the
 * application shell: one centred column on the desk-coloured field, no navigation to a place
 * the visitor cannot go yet.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">{children}</div>
      </main>
      <footer className="pb-8 text-center">
        <p className="text-2xs text-muted-foreground">Sooz Books · double-entry books for Sooz</p>
      </footer>
    </div>
  );
}
