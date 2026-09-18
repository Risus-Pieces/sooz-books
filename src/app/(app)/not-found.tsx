import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Glyph } from '@/components/ui/glyph';
import { NotFoundState } from '@/components/ui/route-states';

/** A record the URL names does not exist (a deleted draft, a mistyped id). Drawn inside the shell. */
export default function AppNotFound() {
  return (
    <NotFoundState
      info="Nothing in these books matches this address. It may have been deleted, or the link may be mistyped."
      className="min-h-[calc(100dvh-140px)]"
      action={
        <Button asChild>
          <Link href="/dashboard">
            <Glyph name="home" />
            Go home
          </Link>
        </Button>
      }
    />
  );
}
