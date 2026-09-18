import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Glyph } from '@/components/ui/glyph';
import { NotFoundState } from '@/components/ui/route-states';

export const metadata: Metadata = {
  title: 'Not found',
};

/** An address that matches no page. Drawn without the shell, so it works signed in or out. */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg text-label">
      <NotFoundState
        title="Page not found"
        code="404"
        action={
          <Button asChild>
            <Link href="/dashboard">
              <Glyph name="home" />
              Go home
            </Link>
          </Button>
        }
      />
    </main>
  );
}
