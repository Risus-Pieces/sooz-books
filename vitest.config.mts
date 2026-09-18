import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the "@/*" -> src/* alias straight from tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Playwright owns e2e/; vitest must not try to run those specs.
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
  },
});
