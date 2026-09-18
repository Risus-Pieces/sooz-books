import { defineConfig } from 'vitest/config';

// The test helpers read .env.local but only fill variables that are still unset, so
// blanking the model keys here keeps every import-path test off the network: a funded
// key would otherwise turn each test import into a real, billed, nondeterministic model
// call (import.test.ts went from seconds to 5.5 minutes when the key was funded).
// The one live-model integration test runs only with RUN_AI_INTEGRATION=1.
const liveAi = process.env.RUN_AI_INTEGRATION === '1';

export default defineConfig({
  // Resolves the "@/*" -> src/* alias straight from tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Playwright owns e2e/; vitest must not try to run those specs.
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
    // Most suites hit the live database through the session pooler, capped at 15
    // clients. Three workers holding two connections each leaves room for the dev
    // server and for a second run to overlap without EMAXCONNSESSION.
    maxWorkers: 3,
    env: {
      DB_POOL_MAX: '2',
      ...(liveAi ? {} : { ANTHROPIC_API_KEY: '', AI_GATEWAY_API_KEY: '' }),
    },
  },
});
