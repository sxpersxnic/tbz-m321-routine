/** Domain registry (04-domain-platform §4.3, §5): compatibility rules as pure checks, acceptance against a real database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { CapabilitySpec, DomainManifest } from '@routine/service-kit';
import { BUILTIN_MANIFESTS } from '../src/domain/builtin-manifests.ts';
import { applyHeartbeat, applyRegistration, compatibilityIssues, listDomains, staleDomains } from '../src/registry.ts';
import { engineHarness, needsDatabase, type EngineHarness } from './support/engine-harness.ts';

const capability = (type: string, extra: Partial<CapabilitySpec> = {}): CapabilitySpec => ({
  type,
  kind: 'action',
  label: 'Act',
  sentence: 'Act on {thing}',
  description: 'Does a thing.',
  params: [
    { name: 'thing', label: 'Thing', type: 'text', required: true },
    { name: 'note', label: 'Note', type: 'text' },
  ],
  output: [{ name: 'id', label: 'ID', type: 'text' }],
  sideEffects: true,
  since: 1,
  ...extra,
});

/** A fixture domain's manifest; `edit` changes a copy. */
function manifest(domain: string, version = 1, edit: (m: DomainManifest) => void = () => {}): DomainManifest {
  const m: DomainManifest = {
    contract: 1,
    domain,
    manifestVersion: version,
    service: `${domain}-service`,
    name: domain,
    description: 'A test fixture domain.',
    icon: 'bolt',
    tint: 'teal',
    order: 50,
    optional: true,
    prefixes: [domain],
    capabilities: [capability(`${domain}.act`), capability(`${domain}.other`)],
    triggers: [{ type: `${domain}.happened`, label: 'Happened', sentence: 'When it happens', description: 'It happened.', fields: [{ name: 'id', label: 'ID', type: 'text' }], since: 1 }],
  };
  edit(m);
  return m;
}

const unused = async () => 0;

describe('manifest compatibility (04 §5)', () => {
  const check = (edit: (m: DomainManifest) => void, usage = unused) => compatibilityIssues(manifest('fix'), manifest('fix', 2, edit), usage);

  it('allows additions and wording changes', async () => {
    assert.deepEqual(
      await check((m) => {
        m.capabilities.push(capability('fix.new'));
        m.capabilities[0].params.push({ name: 'extra', label: 'Extra', type: 'text' });
        m.capabilities[0].output.push({ name: 'more', label: 'More', type: 'text' });
        m.capabilities[0].label = 'Act now';
        m.capabilities[0].params[0].required = false; // required → optional is fine
        m.triggers?.[0].fields.push({ name: 'at', label: 'At', type: 'date' });
      }),
      [],
    );
  });

  it('refuses what would break a saved routine', async () => {
    const issues = await check((m) => {
      m.capabilities[0].params = [
        { name: 'thing', label: 'Thing', type: 'number', required: true }, // retyped
        { name: 'note', label: 'Note', type: 'text', required: true }, // optional → required
        { name: 'must', label: 'Must', type: 'text', required: true }, // new required
      ];
      m.capabilities[0].output = []; // output removed
      m.capabilities[1] = { ...m.capabilities[1], kind: 'value', sideEffects: false }; // kind changed
      if (m.triggers) m.triggers[0].fields = []; // trigger field removed
    });
    assert.deepEqual(issues, [
      'capability "fix.act": param "thing" changed type from text to number',
      'capability "fix.act": param "note" became required',
      'capability "fix.act": new param "must" is required',
      'capability "fix.act": output "id" was removed',
      'capability "fix.other" changed from action to value',
      'trigger "fix.happened": field "id" was removed',
    ]);
    const withoutThing = await check((m) => {
      m.capabilities[0].params = m.capabilities[0].params.slice(1);
    });
    assert.deepEqual(withoutThing, ['capability "fix.act": param "thing" was removed or renamed']);
  });

  it('removes a capability or trigger only after deprecating it, and only while unused', async () => {
    const removed = (m: DomainManifest) => {
      m.capabilities = m.capabilities.slice(1);
      m.triggers = [];
    };
    assert.deepEqual(await check(removed), [
      'capability "fix.act" was removed without being deprecated first',
      'trigger "fix.happened" was removed without being deprecated first',
    ]);
    const deprecated = manifest('fix', 2, (m) => {
      m.capabilities[0].deprecated = { since: 2, message: 'use fix.other' };
      if (m.triggers) m.triggers[0].deprecated = { since: 2, message: 'gone' };
    });
    assert.deepEqual(await compatibilityIssues(deprecated, manifest('fix', 3, removed), unused), []);
    assert.deepEqual(await compatibilityIssues(deprecated, manifest('fix', 3, removed), async (_type, of) => (of === 'capability' ? 2 : 0)), [
      'capability "fix.act" was removed but 2 routine(s) still use it',
    ]);
  });
});

describe('registry (04 §4.3)', { skip: needsDatabase }, () => {
  let h: EngineHarness;
  before(async () => {
    h = await engineHarness();
  });
  after(async () => {
    await h?.close();
  });
  const register = (m: unknown, instance = 'fixture@1') => applyRegistration(h.pool, { manifest: m, instance });
  const domain = async (name: string) => (await listDomains(h.pool)).find((entry) => entry.row.domain === name);

  it('accepts a first registration, and the same one again as a replica restarting', async () => {
    assert.deepEqual(await register(manifest('alpha')), { kind: 'accepted', version: 1 });
    assert.deepEqual(await register(manifest('alpha'), 'fixture@2'), { kind: 'unchanged' });
    assert.equal((await domain('alpha'))?.row.current_version, 1);
  });

  it('rejects a changed manifest under the same version, keeps the accepted one, and shows why', async () => {
    await register(manifest('beta'));
    const outcome = await register(manifest('beta', 1, (m) => {
      m.name = 'Changed';
    }));
    assert.equal(outcome.kind, 'rejected');
    const entry = await domain('beta');
    assert.equal(entry?.row.current_version, 1);
    assert.equal(entry?.manifest?.name, 'beta');
    assert.match(entry?.row.rejected?.reason ?? '', /version 1 was changed without a new version number/);
    assert.equal(entry?.row.rejected?.instance, 'fixture@1');
  });

  it('accepts a compatible new version and clears an earlier rejection; ignores an older one', async () => {
    await register(manifest('gamma'));
    await register(manifest('gamma', 1, (m) => {
      m.name = 'x';
    }));
    assert.deepEqual(await register(manifest('gamma', 2, (m) => void m.capabilities.push(capability('gamma.more')))), { kind: 'accepted', version: 2 });
    assert.equal((await domain('gamma'))?.row.rejected, null);
    assert.deepEqual(await register(manifest('gamma', 1)), { kind: 'ignored-older' }, 'an old replica during a rolling update');
    assert.equal((await domain('gamma'))?.row.current_version, 2);
  });

  it('rejects an incompatible new version', async () => {
    await register(manifest('delta'));
    const outcome = await register(manifest('delta', 2, (m) => {
      m.capabilities = m.capabilities.slice(1);
    }));
    assert.equal(outcome.kind, 'rejected');
    assert.match(outcome.kind === 'rejected' ? outcome.reason : '', /incompatible with version 1: capability "delta.act" was removed without being deprecated first/);
    assert.equal((await domain('delta'))?.row.current_version, 1);
  });

  it('rejects removing a deprecated capability that routines still use', async () => {
    await register(manifest('epsilon', 1, (m) => {
      m.capabilities[0].deprecated = { since: 1, message: 'old' };
    }));
    await h.pool.query(`INSERT INTO routines (id, owner_id, name, description, trigger, actions) VALUES ($1, $2, 'Uses it', '', '{"type":"manual"}', $3)`, [
      randomUUID(),
      h.ownerId,
      JSON.stringify([{ key: 'a', type: 'epsilon.act', step: 1, params: {} }]),
    ]);
    const outcome = await register(manifest('epsilon', 2, (m) => {
      m.capabilities = m.capabilities.slice(1);
    }));
    assert.match(outcome.kind === 'rejected' ? outcome.reason : '', /"epsilon.act" was removed but 1 routine\(s\) still use it/);
  });

  it('rejects a prefix another domain owns – and shows it although the domain was never accepted', async () => {
    await register(manifest('zeta'));
    const intruder = manifest('eta', 1, (m) => {
      m.prefixes = ['eta', 'zeta'];
      m.capabilities.push(capability('zeta.steal'));
    });
    assert.equal((await register(intruder)).kind, 'rejected');
    const entry = await domain('eta');
    assert.equal(entry?.row.current_version, null);
    assert.match(entry?.row.rejected?.reason ?? '', /prefix "zeta" belongs to domain "zeta"/);
  });

  it('rejects an invalid manifest', async () => {
    const outcome = await register(manifest('theta', 1, (m) => {
      m.capabilities[0].type = 'theta.bad.type';
    }));
    assert.match(outcome.kind === 'rejected' ? outcome.reason : '', /invalid manifest/);
    assert.equal((await register({ nonsense: true })).kind, 'rejected');
  });

  it('ends consistent when two replicas register a new domain at the same time', async () => {
    const outcomes = await Promise.all([register(manifest('iota'), 'iota@1'), register(manifest('iota'), 'iota@2')]);
    assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ['accepted', 'unchanged']);
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM domain_manifests WHERE domain = 'iota'`);
    assert.equal(rows[0].n, 1);
  });

  it('keeps domains fresh with heartbeats and reports stale ones', async () => {
    await register(manifest('kappa'));
    await h.pool.query(`UPDATE domains SET last_heartbeat_at = now() - interval '5 minutes' WHERE domain = 'kappa'`);
    assert.ok((await staleDomains(h.pool, 90_000)).includes('kappa'));
    assert.equal(await applyHeartbeat(h.pool, { domain: 'kappa' }), true);
    assert.ok(!(await staleDomains(h.pool, 90_000)).includes('kappa'));
    assert.equal(await applyHeartbeat(h.pool, { domain: 'nobody' }), false);
  });

  it('accepts the built-in domains', async () => {
    for (const builtin of BUILTIN_MANIFESTS) assert.equal((await register(builtin, 'routine-service@test')).kind, 'accepted', builtin.domain);
  });
});
