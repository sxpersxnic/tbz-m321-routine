import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { brokerNodes, LINKS, linkState, NODE_BY_ID, NODES, nodeState, queueStats, ROLES, type Role } from '../architecture.ts';
import type { SystemStatus } from '../types.ts';
import { createTopologyScene, type TopologyScene } from './topology-3d-scene.ts';
import { Icon } from './ui.tsx';
import { StatusIcon } from './visual.tsx';

const ROLE_ICON: Record<Role, string> = {
  client: 'globe',
  edge: 'branch',
  gateway: 'link',
  frontend: 'dashboard',
  identity: 'check',
  service: 'stack',
  broker: 'inbox',
  worker: 'bolt',
  external: 'cloud',
  tracing: 'search',
};

const neighbours = (id: string) => [...new Set(LINKS.filter((link) => link.from === id || link.to === id).map((link) => (link.from === id ? link.to : link.from)))];

const deadLetters = (status: SystemStatus | undefined) =>
  (status?.queues ?? []).filter((queue) => queue.name.endsWith('.dlq')).reduce((total, queue) => total + queue.ready, 0);

const roleColor = (role: Role) => ({ '--c': ROLES[role].color }) as CSSProperties;

/** The Infrastructure page's 3D topology – lazy-loaded, it brings three.js along. */
export default function Topology3D({ status }: { status: SystemStatus | undefined }) {
  const stage = useRef<HTMLDivElement>(null);
  const scene = useRef<TopologyScene | null>(null);
  const labels = useRef(new Map<string, HTMLElement>());
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    if (!stage.current) return;
    const created = createTopologyScene(stage.current, { onSelect: setSelected, onHover: setHovered });
    created.setLabels(labels.current);
    scene.current = created;
    return () => {
      created.dispose();
      scene.current = null;
    };
  }, []);
  useEffect(() => scene.current?.update(status), [status]);
  useEffect(() => scene.current?.select(selected), [selected]);

  const anchor = (id: string) => (element: HTMLElement | null) => {
    if (element) labels.current.set(id, element);
    else labels.current.delete(id);
  };
  const toggle = (id: string) => setSelected((current) => (current === id ? null : id));
  const focused = selected ? new Set([selected, ...neighbours(selected)]) : null;
  const dead = deadLetters(status);

  return (
    <div className="t3d">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape is a shortcut, every label is a real button */}
      <div className="t3d-stage" ref={stage} onKeyDown={(event) => event.key === 'Escape' && setSelected(null)}>
        <div className="t3d-labels">
          {NODES.map((node) => {
            const state = nodeState(node, status);
            return (
              <button
                key={node.id}
                ref={anchor(node.id)}
                type="button"
                className={`t3d-label${state.up ? '' : ' down'}${hovered === node.id ? ' hover' : ''}${focused && !focused.has(node.id) ? ' dim' : ''}`}
                style={state.up ? roleColor(node.role) : undefined}
                aria-pressed={selected === node.id}
                onClick={() => toggle(node.id)}
              >
                <i className="t3d-dot" aria-hidden="true" />
                {node.label}
                {state.slots > 1 && <span className="t3d-count">{state.live < state.slots ? `${state.live}/${state.slots}` : `×${state.slots}`}</span>}
                {!state.up && <span className="sr-only">offline</span>}
              </button>
            );
          })}
          {NODES.filter((node) => node.database).map((node) => (
            <span key={`db:${node.id}`} ref={anchor(`db:${node.id}`)} data-hang="below" className={`t3d-sublabel${focused && !focused.has(node.id) ? ' dim' : ''}`} aria-hidden="true">{node.database}</span>
          ))}
          {LINKS.filter((link) => link.queues).map((link) => {
            const state = linkState(link, status);
            return (
              <span key={`link:${link.to}`} ref={anchor(`link:${link.to}`)} data-hang="below" className={`t3d-chip tone-${state.tone}`} hidden={state.tone === 'ok'}>
                {state.tone === 'err' ? 'No consumer' : `${state.ready} ready`}
              </span>
            );
          })}
          <span ref={anchor('dlq')} data-hang="below" className="t3d-chip tone-err" hidden={dead === 0}>{dead} in DLQ</span>
        </div>
        {selected && <Details id={selected} status={status} onSelect={setSelected} />}
      </div>
      <div className="legend t3d-legend">
        <span><i className="t3d-key traffic" /> Delivery</span>
        <span><i className="t3d-key waiting" /> Waiting</span>
        <span><i className="t3d-key down" /> Offline</span>
        <span><i className="t3d-key http" /> HTTP</span>
        <span className="t3d-hint">Drag to rotate · Scroll to zoom</span>
      </div>
    </div>
  );
}

function Details({ id, status, onSelect }: { id: string; status: SystemStatus | undefined; onSelect: (id: string | null) => void }) {
  const node = NODE_BY_ID[id];
  if (!node) return null;
  const role = ROLES[node.role];
  const state = nodeState(node, status);
  const queues = (node.queues ?? []).map((name) => ({ name, ...queueStats(status?.queues ?? [], [name]) }));
  const cluster = node.role === 'broker' ? brokerNodes(status) : [];

  return (
    <aside className="t3d-panel" aria-label={`${node.label} details`}>
      <header>
        <span className={`glyph tint-${role.tint}`} aria-hidden="true"><Icon name={ROLE_ICON[node.role]} size={17} /></span>
        <span className="grow">
          <strong>{node.label}</strong>
          <span className="t3d-role">{role.label}</span>
        </span>
        <button type="button" className="t3d-close" aria-label="Close details" onClick={() => onSelect(null)}><Icon name="x" size={15} /></button>
      </header>
      <p>{node.summary}</p>
      <dl>
        <dt>Status</dt>
        <dd><StatusIcon status={state.up ? 'up' : 'down'} size={16} /> {state.up ? 'Online' : 'Offline'}</dd>
        {node.role !== 'client' && node.role !== 'broker' && (
          <>
            <dt>Replicas</dt>
            <dd className="tabular">{state.live < state.slots ? `${state.live} of ${state.slots} running` : state.slots}</dd>
          </>
        )}
        {state.instance && (
          <>
            <dt>Answered by</dt>
            <dd className="mono">{state.instance}</dd>
          </>
        )}
        {node.database && (
          <>
            <dt>Database</dt>
            <dd><span className="mono">{node.database}</span> · PostgreSQL 17</dd>
          </>
        )}
        <dt>Stack</dt>
        <dd>{node.tech}</dd>
        {node.role === 'broker' && (
          <>
            <dt>Dead letter</dt>
            <dd className="tabular">{deadLetters(status)}</dd>
          </>
        )}
      </dl>
      {cluster.length > 0 && (
        <ul className="t3d-rows">
          {cluster.map((brokerNode) => (
            <li key={brokerNode.name}><StatusIcon status={brokerNode.running ? 'up' : 'down'} size={16} /> <span className="mono">{brokerNode.name}</span></li>
          ))}
        </ul>
      )}
      {queues.length > 0 && (
        <table className="t3d-queues">
          <thead><tr><th>Queue</th><th className="num" title="waiting for a consumer">Ready</th><th className="num" title="delivered, not yet acknowledged">Unacked</th><th className="num" title="deliveries per second">/s</th></tr></thead>
          <tbody>
            {queues.map((queue) => (
              <tr key={queue.name}>
                <td className="mono">{queue.name.replace(`${node.id}.`, '')}</td>
                <td className="num">{queue.ready}</td>
                <td className="num">{queue.unacked}</td>
                <td className="num">{queue.rate ? queue.rate.toFixed(1) : '0'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="t3d-links">
        {neighbours(id).map((other) => (
          <button key={other} type="button" className="t3d-link" style={roleColor(NODE_BY_ID[other]?.role ?? 'client')} onClick={() => onSelect(other)}>
            <i className="t3d-dot" aria-hidden="true" /> {NODE_BY_ID[other]?.label ?? other}
          </button>
        ))}
      </div>
    </aside>
  );
}
