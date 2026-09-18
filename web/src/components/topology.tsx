import type { QueueStatus, SystemStatus } from '../types.ts';

interface Node {
  id: string;
  label: string;
  x: number;
  y: number;
  kind?: 'broker' | 'external' | 'client';
}

const W = 156;
const H = 50;

const NODES: Node[] = [
  { id: 'client', label: 'Browser', x: 90, y: 235, kind: 'client' },
  { id: 'gateway', label: 'gateway', x: 270, y: 235 },
  { id: 'identity-service', label: 'identity-service', x: 450, y: 80 },
  { id: 'routine-service', label: 'routine-service', x: 450, y: 235 },
  { id: 'rabbitmq', label: 'RabbitMQ', x: 720, y: 235, kind: 'broker' },
  { id: 'task-service', label: 'task-service', x: 1000, y: 90 },
  { id: 'integration-worker', label: 'integration-worker', x: 1000, y: 235 },
  { id: 'notification-service', label: 'notification-service', x: 1000, y: 380 },
  { id: 'mock-external', label: 'mock-external', x: 1200, y: 235, kind: 'external' },
];

const byId = Object.fromEntries(NODES.map((node) => [node.id, node]));

interface QueueEdge {
  from: string;
  to: string;
  queues: string[];
}

const QUEUE_EDGES: QueueEdge[] = [
  { from: 'rabbitmq', to: 'task-service', queues: ['task-service.actions'] },
  { from: 'rabbitmq', to: 'integration-worker', queues: ['integration-worker.actions'] },
  { from: 'rabbitmq', to: 'notification-service', queues: ['notification-service.actions', 'notification-service.execution-events'] },
  { from: 'rabbitmq', to: 'routine-service', queues: ['routine-service.triggers', 'routine-service.action-results'] },
];

const HTTP_EDGES: Array<[string, string]> = [
  ['client', 'gateway'],
  ['gateway', 'identity-service'],
  ['gateway', 'routine-service'],
  ['integration-worker', 'mock-external'],
];

/** Point where the ray from the node centre towards (dx, dy) leaves the node's rectangle. */
function boundary(node: Node, dx: number, dy: number) {
  const halfWidth = W / 2 + 4;
  const halfHeight = H / 2 + 4;
  const t = Math.min(dx === 0 ? Infinity : halfWidth / Math.abs(dx), dy === 0 ? Infinity : halfHeight / Math.abs(dy));
  return { x: node.x + dx * t, y: node.y + dy * t };
}

function edgePoints(from: Node, to: Node) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return { a: boundary(from, dx, dy), b: boundary(to, -dx, -dy) };
}

function sum(queues: QueueStatus[], names: string[], field: 'ready' | 'consumers') {
  return names.reduce((total, name) => total + (queues.find((queue) => queue.name === name)?.[field] ?? 0), 0);
}

export function Topology({ status }: { status: SystemStatus | undefined }) {
  const isUp = (id: string) => {
    if (!status) return true;
    if (id === 'client') return true;
    if (id === 'rabbitmq') return status.broker === 'up';
    return status.services[id]?.status === 'up';
  };
  const queues = status?.queues ?? [];
  const replicas = queues.find((queue) => queue.name === 'integration-worker.actions')?.consumers ?? 0;
  const dlq = queues.filter((queue) => queue.name.endsWith('.dlq')).reduce((total, queue) => total + queue.ready, 0);

  return (
    // focusable: a horizontally scrolling region is unreachable by keyboard otherwise
    <section className="topology-wrap" tabIndex={0} aria-label="Topology diagram, scrolls horizontally">
      <svg className="topology" viewBox="0 0 1290 460" role="img" aria-label="System topology with queue depths">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-head" />
          </marker>
        </defs>

        {HTTP_EDGES.map(([from, to]) => {
          const { a, b } = edgePoints(byId[from], byId[to]);
          return <line key={`${from}-${to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="edge http" markerEnd="url(#arrow)" />;
        })}
        {/* gateway also routes /tasks and /notifications directly (synchronous) */}
        <path d={`M ${byId.gateway.x} ${byId.gateway.y - H / 2} C 330 10, 800 10, ${byId['task-service'].x - W / 2} ${byId['task-service'].y - 12}`} className="edge http faint" />
        <path d={`M ${byId.gateway.x} ${byId.gateway.y + H / 2} C 330 460, 800 460, ${byId['notification-service'].x - W / 2} ${byId['notification-service'].y + 12}`} className="edge http faint" />

        {QUEUE_EDGES.map((edge) => {
          const { a, b } = edgePoints(byId[edge.from], byId[edge.to]);
          const ready = sum(queues, edge.queues, 'ready');
          const consumers = sum(queues, edge.queues, 'consumers');
          const tone = consumers === 0 && status ? 'err' : ready > 0 ? 'warn' : 'ok';
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g key={edge.to} className={`queue-edge tone-${tone}`}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`edge async ${ready > 0 ? 'flowing' : ''}`} markerEnd="url(#arrow)" />
              <g transform={`translate(${mx}, ${my})`}>
                <rect x={-50} y={-13} width={100} height={26} rx={13} className="edge-label" />
                <text textAnchor="middle" dy="4" className="edge-text">
                  <title>{`${ready} Ready, ${consumers} Consumer`}</title>
                  {ready} · {consumers}×
                </text>
              </g>
            </g>
          );
        })}

        {NODES.map((node) => {
          const up = isUp(node.id);
          const label = node.id === 'integration-worker' && replicas > 0 ? `${node.label} ×${replicas}` : node.label;
          return (
            <g key={node.id} className={`node ${node.kind ?? 'service'} ${up ? 'up' : 'down'}`} transform={`translate(${node.x - W / 2}, ${node.y - H / 2})`}>
              <title>{`${node.label}: ${up ? 'online' : 'offline'}`}</title>
              <rect width={W} height={H} rx={node.kind === 'broker' ? 25 : 10} />
              {/* a cross, not just a red dot: the state has to survive colour blindness */}
              {up
                ? <circle cx={16} cy={H / 2} r={5} className="node-dot" />
                : <path d={`M 12 ${H / 2 - 4.5} l 9 9 M 21 ${H / 2 - 4.5} l -9 9`} className="node-down-mark" />}
              <text x={28} y={H / 2 + 4} className="node-label">{label}</text>
              {node.kind === 'broker' && dlq > 0 && (
                <text x={W / 2} y={H + 18} textAnchor="middle" className="dlq-label">DLQ: {dlq}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span><i className="swatch http" /> HTTP</span>
        <span><i className="swatch async" /> Queue (Ready · Consumer)</span>
        <span><i className="swatch warn" /> Backlog</span>
        <span><i className="swatch err" /> No consumer</span>
      </div>
    </section>
  );
}

export function Sparkline({ values, max }: { values: number[]; max?: number }) {
  const top = Math.max(max ?? 0, ...values, 1);
  const points = values.map((value, index) => `${(index / Math.max(values.length - 1, 1)) * 100},${28 - (value / top) * 26}`).join(' ');
  return (
    <svg className="sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}
