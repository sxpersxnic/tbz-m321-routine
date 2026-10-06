/**
 * routine-service's internal API, as trigger-service uses it (with its service account).
 */
import type { ServiceTokenProvider } from '@routine/service-kit';
import { routineState, type RoutineState } from './messages.ts';

export interface RoutineClient {
  /** Every event-triggered routine of every owner (`GET /internal/v1/routines?trigger=event`). */
  eventRoutines(): Promise<RoutineState[]>;
}

/**
 * Creates the client.
 *
 * @example
 * const routines = routineClient('http://routine-service:3000', serviceTokenProvider('trigger-service', secret));
 * const states = await routines.eventRoutines();
 */
export function routineClient(baseUrl: string, tokens: ServiceTokenProvider, fetchImpl: typeof fetch = fetch): RoutineClient {
  return {
    async eventRoutines() {
      const response = await fetchImpl(`${baseUrl}/internal/v1/routines?trigger=event`, {
        headers: { authorization: `Bearer ${await tokens.token()}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`routine-service answered HTTP ${response.status} for the event-triggered routines`);
      const body = (await response.json()) as { items?: unknown };
      if (!Array.isArray(body.items)) throw new Error('routine-service answered without items');
      return body.items.map((item) => routineState(item as Record<string, unknown>));
    },
  };
}
