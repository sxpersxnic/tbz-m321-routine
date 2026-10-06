/**
 * trigger-service's HTTP API (trigger-service.md §3).
 */
import { requireAdmin, requireUser } from '@routine/service-kit';
import type { FastifyInstance } from 'fastify';
import type { Decision } from './matching.ts';

export interface RouteDeps {
  /** Rebuilds the projection from routine-service. */
  resync: () => Promise<{ stored: number; removed: number }>;
  /** The last decisions for one of the owner's routines. */
  decisions: (ownerId: string, routineId: string) => Promise<Decision[]>;
}

/**
 * Registers the routes.
 *
 * @example registerRoutes(app, { resync: () => resync(pool, () => routines.eventRoutines()), decisions: (owner, id) => listDecisions(pool, owner, id) })
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // "Why did this run?" – only the owner's own decisions, so another user's routine reads as empty
  app.get<{ Querystring: { routineId: string } }>(
    '/api/v1/triggers/log',
    {
      schema: {
        querystring: { type: 'object', required: ['routineId'], additionalProperties: false, properties: { routineId: { type: 'string', format: 'uuid' } } },
      },
    },
    async (request) => {
      const user = requireUser(request);
      return { items: await deps.decisions(user.id, request.query.routineId) };
    },
  );

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
