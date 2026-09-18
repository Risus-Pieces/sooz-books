/**
 * Stops the local e2e Postgres once the run is over. Playwright ends the web server by killing
 * its process tree, which gives serve.ts no chance to stop the cluster itself. A reused server
 * (E2E_REUSE_SERVER=1) keeps its database.
 */
import { stopCluster } from './local-db';

export default function teardown(): void {
  if (process.env.E2E_REUSE_SERVER === '1') return;
  stopCluster();
}
