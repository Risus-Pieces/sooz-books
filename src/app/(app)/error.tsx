'use client';

import { ErrorState } from '@/components/ui/error-state';

/**
 * A page inside the app failed to render. The shell (sidebar, tab bar, search) stays, so the owner
 * can retry or go elsewhere; only the page area shows the failure.
 */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorState onRetry={retry} digest={error.digest} className="min-h-[calc(100dvh-140px)]" />;
}
