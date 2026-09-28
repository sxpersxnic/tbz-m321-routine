/**
 * The domain registry (docs/v2/04-domain-platform.md §4, §5): accepts or rejects the manifests domains
 * register, keeps their heartbeats, and serves the current manifests to the catalog. One transaction
 * per registration with the domain's row locked, so replicas registering at once end up consistent.
 */
import { manifestDigest, validateManifest, withTransaction, type CapabilitySpec, type DomainManifest, type Pool, type Queryable, type TriggerSpec } from '@routine/service-kit';

export type RegistrationOutcome =
  | { kind: 'accepted'; version: number }
  | { kind: 'unchanged' }
  | { kind: 'ignored-older' }
  | { kind: 'rejected'; reason: string };

export interface Registration {
  manifest: unknown;
  digest?: string;
  instance: string;
}

export interface DomainRow {
  domain: string;
  current_version: number | null;
  service: string;
  last_heartbeat_at: Date;
  rejected: { reason: string; manifestVersion: number | null; digest: string | null; service: string | null; instance: string; at: string } | null;
}

/** How many routines use a capability type (as a step) or a trigger type (as their event). */
export type UsageCounter = (type: string, of: 'capability' | 'trigger') => Promise<number>;

// ---------------------------------------------------------------- compatibility (§5, pure)

function capabilityIssues(previous: CapabilitySpec, next: CapabilitySpec): string[] {
  const issues: string[] = [];
  const at = `capability "${next.type}"`;
  if (previous.kind !== next.kind) issues.push(`${at} changed from ${previous.kind} to ${next.kind}`);
  const params = new Map(next.params.map((param) => [param.name, param]));
  for (const param of previous.params) {
    const now = params.get(param.name);
    if (!now) issues.push(`${at}: param "${param.name}" was removed or renamed`);
    else {
      if (now.type !== param.type) issues.push(`${at}: param "${param.name}" changed type from ${param.type} to ${now.type}`);
      if (now.required && !param.required) issues.push(`${at}: param "${param.name}" became required`);
    }
  }
  for (const param of next.params) {
    if (param.required && !previous.params.some((old) => old.name === param.name)) issues.push(`${at}: new param "${param.name}" is required`);
  }
  const outputs = new Map(next.output.map((field) => [field.name, field]));
  for (const field of previous.output) {
    const now = outputs.get(field.name);
    if (!now) issues.push(`${at}: output "${field.name}" was removed`);
    else if (now.type !== field.type) issues.push(`${at}: output "${field.name}" changed type from ${field.type} to ${now.type}`);
  }
  return issues;
}

function triggerIssues(previous: TriggerSpec, next: TriggerSpec): string[] {
  const fields = new Map(next.fields.map((field) => [field.name, field]));
  return previous.fields.flatMap((field) => {
    const now = fields.get(field.name);
    if (!now) return [`trigger "${next.type}": field "${field.name}" was removed`];
    return now.type === field.type ? [] : [`trigger "${next.type}": field "${field.name}" changed type from ${field.type} to ${now.type}`];
  });
}

/**
 * Why `next` can't replace `previous` (expand and contract, 04 §5) – empty when it can. Removing a
 * capability or trigger needs it deprecated in an earlier version and unused; everything else that
 * would break a saved routine (removed/renamed/retyped params and outputs, a param that became
 * required) needs a new capability instead.
 */
export async function compatibilityIssues(previous: DomainManifest, next: DomainManifest, usage: UsageCounter): Promise<string[]> {
  const issues: string[] = [];
  const nextCapabilities = new Map(next.capabilities.map((capability) => [capability.type, capability]));
  for (const capability of previous.capabilities) {
    const now = nextCapabilities.get(capability.type);
    if (now) {
      issues.push(...capabilityIssues(capability, now));
      continue;
    }
    if (!capability.deprecated) issues.push(`capability "${capability.type}" was removed without being deprecated first`);
    else {
      const used = await usage(capability.type, 'capability');
      if (used > 0) issues.push(`capability "${capability.type}" was removed but ${used} routine(s) still use it`);
    }
  }
  const nextTriggers = new Map((next.triggers ?? []).map((trigger) => [trigger.type, trigger]));
  for (const trigger of previous.triggers ?? []) {
    const now = nextTriggers.get(trigger.type);
    if (now) {
      issues.push(...triggerIssues(trigger, now));
      continue;
    }
    if (!trigger.deprecated) issues.push(`trigger "${trigger.type}" was removed without being deprecated first`);
    else {
      const used = await usage(trigger.type, 'trigger');
      if (used > 0) issues.push(`trigger "${trigger.type}" was removed but ${used} routine(s) still use it`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------- registration (§4.3)

/** Routines using a type, across all owners – what removing it from a manifest would break. */
function usageIn(db: Queryable): UsageCounter {
  return async (type, of) => {
    const { rows } = await db.query<{ count: number }>(
      of === 'capability'
        ? `SELECT count(*)::int AS count FROM routines WHERE actions @> jsonb_build_array(jsonb_build_object('type', $1::text))`
        : `SELECT count(*)::int AS count FROM routines WHERE trigger->>'event' = $1`,
      [type],
    );
    return rows[0]?.count ?? 0;
  };
}

async function reject(db: Queryable, domain: string, registration: Registration, manifest: Partial<DomainManifest>, digest: string | null, reason: string): Promise<RegistrationOutcome> {
  const rejected = {
    reason,
    manifestVersion: typeof manifest.manifestVersion === 'number' ? manifest.manifestVersion : null,
    digest,
    service: typeof manifest.service === 'string' ? manifest.service : null,
    instance: registration.instance,
    at: new Date().toISOString(),
  };
  await db.query('UPDATE domains SET rejected = $2 WHERE domain = $1', [domain, JSON.stringify(rejected)]);
  return { kind: 'rejected', reason };
}

/** Applies one DomainRegistered (04 §4.3). The digest is recomputed here – a sender's is not trusted. */
export async function applyRegistration(pool: Pool, registration: Registration): Promise<RegistrationOutcome> {
  const raw = (registration.manifest ?? {}) as Partial<DomainManifest>;
  const domain = typeof raw.domain === 'string' && /^[a-z][a-z0-9]*$/.test(raw.domain) ? raw.domain : null;
  const validation = validateManifest(registration.manifest);
  if (!domain) return { kind: 'rejected', reason: `invalid manifest: ${validation.valid ? 'no domain' : validation.errors.join('; ')}` };

  return withTransaction(pool, async (client) => {
    // the row to lock – created by the first registration of a domain, even a rejected one (to show it)
    await client.query(`INSERT INTO domains (domain, service) VALUES ($1, $2) ON CONFLICT (domain) DO NOTHING`, [domain, typeof raw.service === 'string' ? raw.service : 'unknown']);
    const { rows } = await client.query<DomainRow>('SELECT * FROM domains WHERE domain = $1 FOR UPDATE', [domain]);
    const current = rows[0];

    if (!validation.valid) return reject(client, domain, registration, raw, null, `invalid manifest: ${validation.errors.join('; ')}`);
    const manifest = validation.manifest;
    const digest = manifestDigest(manifest);

    // every prefix belongs to exactly one domain
    const { rows: owners } = await client.query<{ domain: string; prefix: string }>(
      `SELECT d.domain, prefix FROM domains d JOIN domain_manifests m ON m.domain = d.domain AND m.manifest_version = d.current_version,
              jsonb_array_elements_text(m.manifest->'prefixes') AS prefix
        WHERE d.domain <> $1 AND prefix = ANY($2)`,
      [domain, manifest.prefixes],
    );
    if (owners.length > 0) return reject(client, domain, registration, manifest, digest, `prefix "${owners[0].prefix}" belongs to domain "${owners[0].domain}"`);

    const heartbeat = () => client.query('UPDATE domains SET last_heartbeat_at = now() WHERE domain = $1', [domain]);
    if (current.current_version !== null) {
      if (manifest.manifestVersion < current.current_version) {
        // an old replica during a rolling update: counts as a heartbeat only
        await heartbeat();
        return { kind: 'ignored-older' };
      }
      const { rows: stored } = await client.query<{ digest: string; manifest: DomainManifest }>(
        'SELECT digest, manifest FROM domain_manifests WHERE domain = $1 AND manifest_version = $2',
        [domain, current.current_version],
      );
      if (manifest.manifestVersion === current.current_version) {
        if (stored[0]?.digest !== digest) {
          return reject(client, domain, registration, manifest, digest, `version ${manifest.manifestVersion} was changed without a new version number`);
        }
        await client.query('UPDATE domains SET last_heartbeat_at = now(), service = $2 WHERE domain = $1', [domain, manifest.service]);
        return { kind: 'unchanged' };
      }
      if (stored[0]) {
        const issues = await compatibilityIssues(stored[0].manifest, manifest, usageIn(client));
        if (issues.length > 0) return reject(client, domain, registration, manifest, digest, `incompatible with version ${current.current_version}: ${issues.join('; ')}`);
      }
    }

    // a version once stored never changes: the same number with other content is refused
    const { rows: inserted } = await client.query<{ digest: string }>(
      `INSERT INTO domain_manifests (domain, manifest_version, digest, manifest) VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain, manifest_version) DO UPDATE SET digest = domain_manifests.digest RETURNING digest`,
      [domain, manifest.manifestVersion, digest, JSON.stringify(manifest)],
    );
    if (inserted[0]?.digest !== digest) {
      return reject(client, domain, registration, manifest, digest, `version ${manifest.manifestVersion} was registered before with other content`);
    }
    await client.query(
      'UPDATE domains SET current_version = $2, service = $3, last_heartbeat_at = now(), rejected = NULL WHERE domain = $1',
      [domain, manifest.manifestVersion, manifest.service],
    );
    return { kind: 'accepted', version: manifest.manifestVersion };
  });
}

/** DomainHeartbeat – any version of a known domain keeps it fresh. Returns false for unknown domains. */
export async function applyHeartbeat(db: Queryable, heartbeat: { domain: string }): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE domains SET last_heartbeat_at = now() WHERE domain = $1 AND current_version IS NOT NULL', [heartbeat.domain]);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------- reading

export interface RegisteredDomain {
  row: DomainRow;
  manifest: DomainManifest | null;
  digest: string | null;
}

/** Every known domain with its current manifest (null while it was never accepted). */
export async function listDomains(db: Queryable): Promise<RegisteredDomain[]> {
  const { rows } = await db.query<DomainRow & { manifest: DomainManifest | null; digest: string | null }>(
    `SELECT d.*, m.manifest, m.digest FROM domains d
       LEFT JOIN domain_manifests m ON m.domain = d.domain AND m.manifest_version = d.current_version
      ORDER BY d.domain`,
  );
  return rows.map(({ manifest, digest, ...row }) => ({ row, manifest, digest }));
}

/** Domains without a heartbeat for `staleAfterMs` (04 §4.4: they still receive commands – queued durably). */
export async function staleDomains(db: Queryable, staleAfterMs: number): Promise<string[]> {
  const { rows } = await db.query<{ domain: string }>(
    `SELECT domain FROM domains WHERE current_version IS NOT NULL AND last_heartbeat_at < now() - make_interval(secs => $1) ORDER BY domain`,
    [staleAfterMs / 1000],
  );
  return rows.map((row) => row.domain);
}
