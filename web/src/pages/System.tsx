import { useRef } from 'react';
import { api } from '../api.ts';
import { Sparkline, Topology } from '../components/topology.tsx';
import { Card, ErrorNote, Icon, StatusBadge } from '../components/ui.tsx';
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

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>System</h1>
          <p className="muted">Live-Zustand aller Services und des Message Brokers (jede Sekunde aktualisiert).</p>
        </div>
        <div className="row">
          <a className="btn ghost" href={RABBITMQ_URL} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} /> RabbitMQ</a>
          <a className="btn ghost" href={JAEGER_URL} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} /> Jaeger</a>
        </div>
      </header>
      <ErrorNote error={status.error} />

      <Card title="Topologie">
        <Topology status={status.data} />
      </Card>

      <div className="grid-2 wide-left">
        <Card title="Work-Queues" actions={<span className="muted small">wartend · in Arbeit · Consumer · Verlauf 60 s</span>}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Queue</th><th className="num">wartend</th><th className="num">in Arbeit</th><th className="num">Consumer</th><th>Verlauf</th></tr></thead>
              <tbody>{work.map(row)}</tbody>
            </table>
          </div>
        </Card>
        <div className="stack">
          <Card title="Services">
            <ul className="service-list">
              {Object.entries(status.data?.services ?? {}).map(([name, service]) => (
                <li key={name}>
                  <span className="grow"><strong>{name}</strong>{service.instance && <span className="muted small mono block">{service.instance}</span>}</span>
                  <StatusBadge status={service.status} />
                </li>
              ))}
              {status.data && <li><span className="grow"><strong>rabbitmq</strong></span><StatusBadge status={status.data.broker} /></li>}
            </ul>
          </Card>
          <Card title="Retry & Dead Letter">
            {problems.length === 0 ? <p className="muted small">Keine Nachrichten in Retry-Queues oder DLQs.</p> : (
              <ul className="service-list">
                {problems.map((queue) => (
                  <li key={queue.name}>
                    <span className="grow mono small">{queue.name}</span>
                    <span className={`chip ${queueKind(queue.name) === 'dlq' ? 'err' : 'warn'}`}>{queue.ready}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">Nachrichten in einer DLQ gehen nicht verloren – nach einem Fix mit <code>scripts/replay-dlq.sh &lt;queue&gt;</code> erneut einspielen.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
