import type { DomainManifest, Pool } from '@routine/service-kit';
import { BUILTIN_MANIFESTS } from './domain/builtin-manifests.ts';
import { Catalog } from './domain/catalog.ts';
import { listDomains } from './registry.ts';

/**
 * The catalog as the registry has it now, read at most every `ttlMs` per replica – a registration
 * on another replica shows up here within that time.
 */
export class CatalogStore {
  #pool: Pool;
  #ttlMs: number;
  #cached: { catalog: Catalog; at: number } | undefined;
  #loading: Promise<Catalog> | undefined;

  constructor(pool: Pool, ttlMs = 5_000) {
    this.#pool = pool;
    this.#ttlMs = ttlMs;
  }

  async get(): Promise<Catalog> {
    if (this.#cached && Date.now() - this.#cached.at < this.#ttlMs) return this.#cached.catalog;
    this.#loading ??= this.#load().finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  /** Forget the cached catalog (after this replica accepted a registration). */
  invalidate(): void {
    this.#cached = undefined;
  }

  async #load(): Promise<Catalog> {
    const domains = (await listDomains(this.#pool)).filter((entry): entry is typeof entry & { manifest: DomainManifest } => entry.manifest !== null);
    // this service's own domains are always there – also in the moment before their startup registration
    const builtins = BUILTIN_MANIFESTS.filter((builtin) => !domains.some((entry) => entry.row.domain === builtin.domain));
    const catalog = new Catalog(
      [...domains.map((entry) => entry.manifest), ...builtins],
      Object.fromEntries(domains.map((entry) => [entry.row.domain, entry.digest ?? ''])),
    );
    this.#cached = { catalog, at: Date.now() };
    return catalog;
  }
}
