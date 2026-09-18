/**
 * The suite's `test`: Playwright's, plus a watch on the browser. An uncaught exception in a page
 * fails the flow even when every assertion passed — a screen that threw halfway may still have
 * painted the right number. Console errors are recorded on the test as annotations, so a React
 * warning is visible in the report without making the suite hostage to dev-mode noise.
 */
import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

export const test = base.extend<{ pageErrors: void }>({
  pageErrors: [
    async ({ page }, use, testInfo) => {
      const uncaught: string[] = [];
      page.on('pageerror', (error) => uncaught.push(error.message));
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        testInfo.annotations.push({ type: 'console error', description: message.text().slice(0, 500) });
      });
      await use();
      if (uncaught.length > 0) {
        throw new Error(`The page threw ${uncaught.length} uncaught error(s):\n${uncaught.join('\n')}`);
      }
    },
    { auto: true },
  ],
});
