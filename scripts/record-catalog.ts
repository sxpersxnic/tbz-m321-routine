/**
 * Writes web/src/forms/catalog.fixture.json – the catalog as GET /api/v1/catalog returns it for a
 * user with every domain on, built from the manifests in the code. Run after a manifest change:
 *   node scripts/record-catalog.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONNECTIONS_MANIFEST } from '../services/integration-worker/src/manifest.ts';
import { NOTIFICATIONS_MANIFEST } from '../services/notification-service/src/manifest.ts';
import { BUILTIN_MANIFESTS } from '../services/routine-service/src/domain/builtin-manifests.ts';
import { Catalog } from '../services/routine-service/src/domain/catalog.ts';
import { TASKS_MANIFEST } from '../services/task-service/src/manifest.ts';

const catalog = new Catalog([TASKS_MANIFEST, NOTIFICATIONS_MANIFEST, CONNECTIONS_MANIFEST, ...BUILTIN_MANIFESTS]);
const domains = catalog.manifests.map((manifest) => ({ ...manifest, enabled: true }));
writeFileSync(join(import.meta.dirname, '..', 'web', 'src', 'forms', 'catalog.fixture.json'), `${JSON.stringify(domains, null, 2)}\n`);
