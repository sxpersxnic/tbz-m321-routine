import { api } from '../api.ts';
import { relative } from '../format.ts';
import { useNow, usePolling } from '../hooks.ts';
import { Disclosure, StatusBadge } from './ui.tsx';
import { StatusIcon } from './visual.tsx';

/**
 * The domain registry for admins (04 §4, M2-11): which domains registered which manifest version,
 * whether their heartbeat is fresh, why a registration was refused, what their queue is bound to
 * and how many routines use each step and trigger.
 */
export function Registry() {
  const now = useNow(10_000);
  const registry = usePolling(() => api.registry(), 10_000);
  const items = registry.data?.items ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <h2 id="registry">Registry</h2>
        {registry.data && <span className="muted small">{items.filter((item) => item.status === 'up').length}/{items.length} online</span>}
      </div>
      {registry.error && <p className="error-note">{registry.error.message}</p>}
      <ul className="registry" aria-labelledby="registry">
        {items.map((item) => (
          <li key={item.domain}>
            <div className="registry-head">
              <StatusIcon status={item.status} size={22} />
              <span className="grow">
                <strong>{item.name ?? item.domain}</strong>
                <span className="muted small mono block">
                  {[item.domain, item.builtIn ? `${item.service} (built in)` : item.service, item.version !== null && `v${item.version}`].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="muted small" title={item.lastHeartbeatAt}>{item.status !== 'rejected' && `Heartbeat ${relative(item.lastHeartbeatAt, now)}`}</span>
              {item.status !== 'up' && <StatusBadge status={item.status} />}
            </div>
            {item.rejected && (
              <p className="registry-rejected small">
                <strong>{item.rejected.manifestVersion !== null ? `v${item.rejected.manifestVersion} refused` : 'Refused'}</strong> {relative(item.rejected.at, now)}: {item.rejected.reason}
                <span className="muted mono block">{item.rejected.instance}</span>
              </p>
            )}
            {item.version !== null && (
              <Disclosure summary="Details">
                <dl className="registry-details small">
                  <dt>Versions</dt><dd>{item.versions.map((version) => `v${version}`).join(', ')}</dd>
                  <dt>Digest</dt><dd className="mono">{item.digest?.slice(0, 12)}</dd>
                  <dt>Bindings</dt>
                  <dd className="mono">{item.builtIn ? 'In process – no queue' : item.bindings.map((binding) => <span key={binding} className="block">routine.actions → {binding}</span>)}</dd>
                  <dt>Used by</dt>
                  <dd>
                    {Object.entries(item.usage).map(([type, count]) => (
                      <span key={type} className="block"><span className="mono">{type}</span> <span className="muted">{count === 1 ? '1 routine' : `${count} routines`}</span></span>
                    ))}
                  </dd>
                </dl>
              </Disclosure>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
