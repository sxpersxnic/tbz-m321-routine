/**
 * trigger-service's HTTP API (trigger-service.md §3).
 */
import { requireAdmin } from '@routine/service-kit';
import type { FastifyInstance } from 'fastify';

export interface RouteDeps {
  /** Rebuilds the projection from routine-service. */
  resync: () => Promise<{ stored: number; removed: number }>;
}

/**
 * Registers the routes.
 *
 * @example registerRoutes(app, { resync: () => resync(pool, () => routines.eventRoutines()) })
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // a service account (installServiceAuth) …
  app.post('/internal/v1/resync', async (request) => {
    const result = await deps.resync();
    request.log.info({ ...result, by: request.caller?.service }, 'subscriptions resynced');
    return result;
  });

  // … or an admin, through the gateway (user tokens never open /internal)
  app.post('/api/v1/triggers/resync', async (request) => {
    const admin = requireAdmin(request);
    const result = await deps.resync();
    request.log.info({ ...result, by: admin.id }, 'subscriptions resynced');
    return result;
  });
}
