/**
 * What runs where – the container landscape of compose.yaml as data, for the Infrastructure page.
 * Positions are on the 3D floor (x = request flow left → right, z = towards the viewer), on a grid so the
 * connections can run at right angles like a circuit diagram.
 * Replica counts are the compose defaults; services behind the broker report their live count
 * through their queue consumers (one consumer per replica and queue).
 */
import type { QueueStatus, SystemStatus } from './types.ts';

export type Role =
  | 'client'
  | 'edge'
  | 'gateway'
  | 'frontend'
  | 'identity'
  | 'service'
  | 'broker'
  | 'worker'
  | 'external'
  | 'tracing';

// Apple system colours – used for the label dots, the panel glyph and a faint tint on the containers
export const ROLES: Record<Role, { label: string; color: string; tint: string }> = {
  client: { label: 'Client', color: '#8e8e93', tint: 'grey' },
  edge: { label: 'Load balancer', color: '#30b0c7', tint: 'teal' },
  gateway: { label: 'API gateway', color: '#007aff', tint: 'sky' },
  frontend: { label: 'Web client', color: '#a2845e', tint: 'orange' },
  identity: { label: 'Identity provider', color: '#af52de', tint: 'violet' },
  service: { label: 'Domain service', color: '#5856d6', tint: 'indigo' },
  broker: { label: 'Message broker', color: '#ff9500', tint: 'orange' },
  worker: { label: 'Worker', color: '#34c759', tint: 'green' },
  external: { label: 'External API', color: '#8e8e93', tint: 'grey' },
  tracing: { label: 'Tracing', color: '#ff2d55', tint: 'pink' },
};

export interface ArchNode {
  id: string;
  label: string;
  role: Role;
  x: number;
  z: number;
  /** Replicas declared in compose.yaml. */
  replicas: number;
  tech: string;
  summary: string;
  /** Its own PostgreSQL container. */
  database?: string;
  /** Queues it consumes. */
  queues?: string[];
  /** Key in SystemStatus.services – absent when nothing probes it. */
  probe?: string;
}

export const NODES: ArchNode[] = [
  { id: 'client', label: 'Browser', role: 'client', x: -13, z: 0, replicas: 1, tech: 'React · oidc-client-ts', summary: 'Runs the web client, signs in with OpenID Connect.' },
  { id: 'edge', label: 'edge', role: 'edge', x: -9.5, z: 0, replicas: 1, tech: 'nginx 1.29', summary: 'The only public port. Spreads requests over the gateway replicas, /auth to Keycloak.' },
  { id: 'gateway', label: 'gateway', role: 'gateway', x: -6, z: 0, replicas: 2, tech: 'Node · Fastify', summary: 'Verifies the token, routes /api to the services, proxies the web client.', probe: 'gateway' },
  { id: 'web', label: 'web', role: 'frontend', x: -6, z: 5.5, replicas: 2, tech: 'nginx · static build', summary: 'Serves the React client.', probe: 'web' },
  { id: 'keycloak', label: 'Keycloak', role: 'identity', x: -6, z: -5.5, replicas: 2, tech: 'Keycloak 26 · jdbc-ping cluster', summary: 'Users, sign-in and tokens for realm "routine". Replicas share sessions.', database: 'keycloak-db', probe: 'keycloak' },
  { id: 'routine-service', label: 'routine-service', role: 'service', x: -1.5, z: 0, replicas: 2, tech: 'Node · Fastify · pg', summary: 'Owns routines, schedules them and orchestrates every run.', database: 'routine-db', queues: ['routine-service.triggers', 'routine-service.action-results'], probe: 'routine-service' },
  { id: 'rabbitmq', label: 'RabbitMQ', role: 'broker', x: 3.5, z: 0, replicas: 3, tech: 'RabbitMQ 4.1 · quorum queues', summary: 'Every queue is replicated over three nodes. Failed messages retry with backoff, then land in a DLQ.' },
  { id: 'task-service', label: 'task-service', role: 'service', x: 8.5, z: -5.5, replicas: 2, tech: 'Node · Fastify · pg', summary: 'Turns actions into tasks and tracks them.', database: 'task-db', queues: ['task-service.actions'], probe: 'task-service' },
  { id: 'integration-worker', label: 'integration-worker', role: 'worker', x: 8.5, z: 0, replicas: 2, tech: 'Node · amqplib', summary: 'Stateless. Calls external HTTP APIs for actions – scale it freely.', database: 'integration-db', queues: ['integration-worker.actions'], probe: 'integration-worker' },
  { id: 'notification-service', label: 'notification-service', role: 'service', x: 8.5, z: 5.5, replicas: 2, tech: 'Node · Fastify · pg', summary: 'Delivers notifications and records run events.', database: 'notification-db', queues: ['notification-service.actions', 'notification-service.execution-events'], probe: 'notification-service' },
  { id: 'mock-external', label: 'mock-external', role: 'external', x: 13, z: 0, replicas: 1, tech: 'Node · Fastify', summary: 'Stands in for third-party APIs. Not part of the platform.', probe: 'mock-external' },
  { id: 'jaeger', label: 'Jaeger', role: 'tracing', x: -1.5, z: -5.5, replicas: 1, tech: 'Jaeger 2 · OpenTelemetry', summary: 'Collects a trace of every request across all services.' },
];

export const NODE_BY_ID: Record<string, ArchNode> = Object.fromEntries(NODES.map((node) => [node.id, node]));

export interface ArchLink {
  from: string;
  to: string;
  kind: 'http' | 'queue';
  /** Queues carried from the broker to `to`. */
  queues?: string[];
  /** Corners of the route on the floor, [x, z] – straight when absent. */
  via?: Array<[number, number]>;
}

export const LINKS: ArchLink[] = [
  { from: 'client', to: 'edge', kind: 'http' },
  { from: 'edge', to: 'gateway', kind: 'http' },
  { from: 'edge', to: 'keycloak', kind: 'http', via: [[-9.5, -5.5]] }, // sign-in pages under /auth
  { from: 'gateway', to: 'web', kind: 'http' },
  { from: 'gateway', to: 'keycloak', kind: 'http' }, // token keys (JWKS)
  { from: 'gateway', to: 'routine-service', kind: 'http' },
  { from: 'gateway', to: 'task-service', kind: 'http', via: [[-3.75, 0], [-3.75, -2.75], [8.5, -2.75]] },
  { from: 'gateway', to: 'notification-service', kind: 'http', via: [[-3.75, 0], [-3.75, 2.75], [8.5, 2.75]] },
  { from: 'integration-worker', to: 'mock-external', kind: 'http' },
  { from: 'rabbitmq', to: 'routine-service', kind: 'queue', queues: ['routine-service.triggers', 'routine-service.action-results'] },
  { from: 'rabbitmq', to: 'task-service', kind: 'queue', queues: ['task-service.actions'], via: [[3.5, -5.5]] },
  { from: 'rabbitmq', to: 'integration-worker', kind: 'queue', queues: ['integration-worker.actions'] },
  { from: 'rabbitmq', to: 'notification-service', kind: 'queue', queues: ['notification-service.actions', 'notification-service.execution-events'], via: [[3.5, 5.5]] },
];

// ---------------------------------------------------------------- live state

export interface NodeState {
  up: boolean;
  /** Slots to draw: the declared replicas, or more once scaled up. */
  slots: number;
  /** Slots that are running. */
  live: number;
  /** Replica that answered the last health probe. */
  instance?: string;
}

export interface LinkState {
  ready: number;
  unacked: number;
  consumers: number;
  /** Deliveries per second. */
  rate: number;
  tone: 'ok' | 'warn' | 'err';
}

export function queueStats(queues: QueueStatus[], names: string[]) {
  const picked = names.map((name) => queues.find((queue) => queue.name === name)).filter((queue) => queue !== undefined);
  return {
    ready: picked.reduce((total, queue) => total + queue.ready, 0),
    unacked: picked.reduce((total, queue) => total + queue.unacked, 0),
    rate: picked.reduce((total, queue) => total + (queue.rate ?? 0), 0),
    // every replica consumes every one of its queues – the fewest consumers is the replicas that are fully attached
    consumers: picked.length ? Math.min(...picked.map((queue) => queue.consumers)) : 0,
  };
}

export function nodeState(node: ArchNode, status: SystemStatus | undefined): NodeState {
  if (!status) return { up: true, slots: node.replicas, live: node.replicas };
  if (node.role === 'broker') {
    const nodes = status.brokerNodes ?? [];
    const running = nodes.filter((brokerNode) => brokerNode.running).length;
    return { up: status.broker === 'up', slots: Math.max(node.replicas, nodes.length), live: status.broker === 'up' ? running : 0 };
  }
  // the browser is the viewer itself; Jaeger and the edge are not probed – reaching this page proves the edge
  if (!node.probe) return { up: true, slots: node.replicas, live: node.replicas };
  const probed = status.services[node.probe];
  const up = probed?.status === 'up';
  if (node.queues && status.broker === 'up') {
    const { consumers } = queueStats(status.queues, node.queues);
    return { up: up && consumers > 0, slots: Math.max(node.replicas, consumers), live: consumers, instance: probed?.instance };
  }
  return { up, slots: node.replicas, live: up ? node.replicas : 0, instance: probed?.instance };
}

export function linkState(link: ArchLink, status: SystemStatus | undefined): LinkState {
  if (!link.queues || !status) return { ready: 0, unacked: 0, consumers: 0, rate: 0, tone: 'ok' };
  const stats = queueStats(status.queues, link.queues);
  const tone = status.broker === 'up' && stats.consumers === 0 ? 'err' : stats.ready > 0 ? 'warn' : 'ok';
  return { ...stats, tone };
}

/** The broker's own cluster nodes, in the order they are drawn. */
export function brokerNodes(status: SystemStatus | undefined): Array<{ name: string; running: boolean }> {
  const nodes = status?.brokerNodes ?? [];
  if (nodes.length) return nodes.map((node) => ({ name: node.name.replace(/^rabbit@/, ''), running: node.running && status?.broker === 'up' }));
  const up = status ? status.broker === 'up' : true;
  return [1, 2, 3].map((index) => ({ name: `rabbitmq-${index}`, running: up }));
}
