import { useRef } from 'react';
import { api } from '../api.ts';
import { Sparkline, Topology } from '../components/topology.tsx';
import { ErrorNote, Icon, StatusBadge } from '../components/ui.tsx';
import { StatusIcon } from '../components/visual.tsx';
import { JAEGER_URL, RABBITMQ_URL } from '../format.ts';
import { usePolling } from '../hooks.ts';
import type { QueueStatus } from '../types.ts';

const HISTORY = 60;

function queueKind(name: string): 'dlq' | 'retry' | 'work' | 'other' {
  if (name.endsWith('.dlq')) return 'dlq';
  if (name.includes('.retry.')) return 'retry';
  if (name.includes('unrouted')) return 'other';
  return 'work';
}

export function System() {
  // queue depth history (last 60 s), kept only in this browser tab
  const history = useRef(new Map<string, number[]>());
  const status = usePolling(async () => {
    const result = await api.system();
    for (const queue of result.queues) {
      const values = history.current.get(queue.name) ?? [];
      history.current.set(queue.name, [...values, queue.ready].slice(-HISTORY));
    }
    return result;
  }, 1000);

  const queues = status.data?.queues ?? [];
  const work = queues.filter((queue) => queueKind(queue.name) === 'work');
  const problems = queues.filter((queue) => (queueKind(queue.name) === 'dlq' || queueKind(queue.name) === 'retry' || queueKind(queue.name) === 'other') && queue.ready > 0);

  const row = (queue: QueueStatus) => {
    const kind = queueKind(queue.name);
    const noConsumer = kind === 'work' && queue.consumers === 0;
    return (
      <tr key={queue.name} className={noConsumer ? 'row-err' : queue.ready > 0 ? 'row-warn' : ''}>
        <td className="mono">{queue.name}</td>
        <td className="num">{queue.ready}</td>
        <td className="num">{queue.unacked}</td>
        <td className="num">{kind === 'work' ? queue.consumers : '–'}</td>
        <td className="spark-cell"><Sparkline values={history.current.get(queue.name) ?? []} /></td>
      </tr>
    );
  };

  const services = Object.entries(status.data?.services ?? {});
  const up = services.filter(([, service]) => service.status === 'up').length + (status.data?.broker === 'up' ? 1 : 0);
  const totalServices = services.length + (status.data ? 1 : 0);
  const waiting = work.reduce((total, queue) => total + queue.ready, 0);
  const busy = work.reduce((total, queue) => total + queue.unacked, 0);
  const dead = queues.filter((queue) => queueKind(queue.name) === 'dlq').reduce((total, queue) => total + queue.ready, 0);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Under the hood</span>
          <h1>Infrastructure</h1>
          <p className="lede">Independent services, connected through RabbitMQ – live.</p>
        </div>
        <div className="row">
          <a className="btn" href={RABBITMQ_URL} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} /> RabbitMQ</a>
          <a className="btn" href={JAEGER_URL} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} /> Jaeger</a>
        </div>
      </header>
      <ErrorNote error={status.error} onRetry={status.reload} />

      <div className="explain">
        <div>
          <span className="glyph tint-sky" aria-hidden="true"><Icon name="stack" size={18} /></span>
          <span><strong>Microservices</strong><p>Each area is its own service with its own database.</p></span>
        </div>
        <div>
          <span className="glyph tint-violet" aria-hidden="true"><Icon name="inbox" size={18} /></span>
          <span><strong>Message Broker</strong><p>Work waits in queues – if a service goes down, nothing is lost.</p></span>
        </div>
        <div>
          <span className="glyph tint-orange" aria-hidden="true"><Icon name="retry" size={18} /></span>
          <span><strong>Retry & DLQ</strong><p>Failures are retried with backoff; permanent ones end up in the dead letter queue.</p></span>
        </div>
      </div>

      <div className="health">
        <div className="fact">
          <StatusIcon status={up === totalServices ? 'up' : 'down'} size={32} />
          <span><span className="fact-label">Services online</span><span className="fact-value tabular">{status.data ? `${up} of ${totalServices}` : '–'}</span></span>
        </div>
        <div className="fact">
          <span className="glyph tint-violet" aria-hidden="true"><Icon name="inbox" size={18} /></span>
          <span><span className="fact-label">Ready</span><span className="fact-value tabular">{status.data ? waiting : '–'}</span></span>
        </div>
        <div className="fact">
          <span className="glyph tint-sky" aria-hidden="true"><Icon name="bolt" size={18} /></span>
          <span><span className="fact-label">Unacked</span><span className="fact-value tabular">{status.data ? busy : '–'}</span></span>
        </div>
        <div className="fact">
          <span className={`glyph tint-${dead ? 'pink' : 'grey'}`} aria-hidden="true"><Icon name="warning" size={18} /></span>
          <span><span className="fact-label">Dead Letter</span><span className="fact-value tabular">{status.data ? dead : '–'}</span></span>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Topology</h2><span className="live-dot">Live</span></div>
        <Topology status={status.data} />
      </div>

      <div className="grid-2 wide-left">
        <div className="card">
          <div className="card-head"><h2>Queues</h2><span className="muted small">last 60 s</span></div>
          {/* focusable: a horizontally scrolling region is unreachable by keyboard otherwise */}
          <section className="table-wrap" tabIndex={0} aria-label="Queues, scrolls horizontally">
            <table className="table">
              <thead><tr><th>Queue</th><th className="num" title="waiting for a consumer">Ready</th><th className="num" title="delivered, not yet acknowledged">Unacked</th><th className="num">Consumer</th><th>History</th></tr></thead>
              <tbody>{work.map(row)}</tbody>
            </table>
          </section>
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Services</h2></div>
            <ul className="service-list">
              {services.map(([name, service]) => (
                <li key={name}>
                  <StatusIcon status={service.status} size={22} />
                  <span className="grow"><strong>{name}</strong>{service.instance && <span className="muted small mono block">{service.instance}</span>}</span>
                  {service.status !== 'up' && <StatusBadge status={service.status} />}
                </li>
              ))}
              {status.data && (
                <li>
                  <StatusIcon status={status.data.broker} size={22} />
                  <span className="grow"><strong>rabbitmq</strong><span className="muted small block">Message Broker</span></span>
                  {status.data.broker !== 'up' && <StatusBadge status={status.data.broker} />}
                </li>
              )}
            </ul>
          </div>
          <div className="card">
            <div className="card-head"><h2>Retry &amp; Dead Letter</h2></div>
            {problems.length === 0 ? <p className="muted small">Empty</p> : (
              <ul className="service-list">
                {problems.map((queue) => (
                  <li key={queue.name}>
                    <span className="grow mono small">{queue.name}</span>
                    <span className={`chip ${queueKind(queue.name) === 'dlq' ? 'err' : 'warn'}`}>{queue.ready}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small" style={{ marginTop: 10 }}>Replay after a fix: <code>scripts/replay-dlq.sh &lt;queue&gt;</code></p>
          </div>
        </div>
      </div>
    </div>
  );
}
