/**
 * The Infrastructure page's 3D topology: every container of the stack as a rounded block on its service's
 * slab, wired by right-angled routes on a dot-grid floor, live from /system/status. Colour is spent only
 * where it means something – traffic, backlog, failure – everything else is porcelain (light) or graphite
 * (dark), following the app theme. Plain three.js; the React side (topology-3d.tsx) owns labels and panel.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { type ArchLink, type ArchNode, brokerNodes, LINKS, type LinkState, linkState, NODE_BY_ID, NODES, nodeState, ROLES } from '../architecture.ts';
import type { SystemStatus } from '../types.ts';

const TRAFFIC = new THREE.Color('#0a84ff');
const WAITING = new THREE.Color('#ff9f0a');
const DOWN = new THREE.Color('#ff3b30');

interface Palette {
  container: string;
  plinth: string;
  outline: string;
  database: string;
  floor: string;
  http: string;
  queue: string;
  tint: number;
  shadow: number;
  sky: number;
  sun: number;
}

const LIGHT: Palette = { container: '#ffffff', plinth: '#ffffff', outline: '#d8d8de', database: '#f2f2f7', floor: '#c4c4ca', http: '#b8b8bf', queue: '#8e8e93', tint: 0.1, shadow: 0.16, sky: 1.8, sun: 2.1 };
const DARK: Palette = { container: '#5a5a5f', plinth: '#2c2c2f', outline: '#3a3a3d', database: '#65656a', floor: '#2e2e31', http: '#48484a', queue: '#6e6e73', tint: 0.07, shadow: 0.5, sky: 1.2, sun: 1.7 };

const SLAB = 0.16; // slab height
const BLOCK = 0.7; // container edge length
const STEP = 0.95; // distance between containers
const PAD = 0.26; // slab margin around its content
const PER_ROW = 3;
const MAX_DOTS = 40;
const LINE_Y = 0.02;

// ---------------------------------------------------------------- geometry helpers

/** Outline of a rounded rectangle on the floor plane, closed. */
function roundedRect(width: number, depth: number, radius: number, y: number): number[] {
  const shape = new THREE.Shape();
  const x0 = -width / 2;
  const z0 = -depth / 2;
  shape.moveTo(x0 + radius, z0);
  shape.lineTo(x0 + width - radius, z0);
  shape.quadraticCurveTo(x0 + width, z0, x0 + width, z0 + radius);
  shape.lineTo(x0 + width, z0 + depth - radius);
  shape.quadraticCurveTo(x0 + width, z0 + depth, x0 + width - radius, z0 + depth);
  shape.lineTo(x0 + radius, z0 + depth);
  shape.quadraticCurveTo(x0, z0 + depth, x0, z0 + depth - radius);
  shape.lineTo(x0, z0 + radius);
  shape.quadraticCurveTo(x0, z0, x0 + radius, z0);
  return shape.getPoints(6).flatMap((point) => [point.x, y, point.y]);
}

/** Right-angled route through the corners, each corner rounded. */
function route(points: THREE.Vector3[], radius = 0.55): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  let cursor = points[0].clone();
  for (let index = 1; index < points.length - 1; index++) {
    const corner = points[index];
    const incoming = corner.clone().sub(points[index - 1]);
    const outgoing = points[index + 1].clone().sub(corner);
    const r = Math.min(radius, incoming.length() / 2, outgoing.length() / 2);
    const enter = corner.clone().sub(incoming.normalize().multiplyScalar(r));
    const leave = corner.clone().add(outgoing.normalize().multiplyScalar(r));
    if (cursor.distanceTo(enter) > 1e-4) path.add(new THREE.LineCurve3(cursor, enter));
    path.add(new THREE.QuadraticBezierCurve3(enter, corner.clone(), leave));
    cursor = leave;
  }
  path.add(new THREE.LineCurve3(cursor, points[points.length - 1].clone()));
  return path;
}

/** A soft round shadow, drawn once and stretched under every slab. */
function shadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0,0,0,1)');
  gradient.addColorStop(0.45, 'rgba(0,0,0,0.55)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

const FLOOR_VERTEX = /* glsl */ `
  varying vec2 vPlane;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPlane = world.xz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

/** Dot grid, fading out towards the edge of the room. */
const FLOOR_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying vec2 vPlane;
  void main() {
    float distanceToDot = length(fract(vPlane) - 0.5);
    float edge = fwidth(vPlane.x) * 1.2;
    float dot = 1.0 - smoothstep(0.03, 0.03 + edge, distanceToDot);
    float fade = 1.0 - smoothstep(10.0, 17.0, length(vPlane * vec2(0.78, 1.25)));
    gl_FragColor = vec4(uColor, dot * fade);
    #include <colorspace_fragment>
  }`;

// ---------------------------------------------------------------- views

interface NodeView {
  node: ArchNode;
  group: THREE.Group;
  blocks: THREE.Group;
  width: number;
  depth: number;
  slots: number;
  running: boolean[];
  up: boolean;
  lift: number;
  materials: {
    block: THREE.MeshPhysicalMaterial;
    ghost: THREE.MeshPhysicalMaterial;
    badge: THREE.MeshBasicMaterial;
    slab: THREE.MeshStandardMaterial;
    database: THREE.MeshPhysicalMaterial;
    band: THREE.MeshBasicMaterial;
    outline: LineMaterial;
    shadow: THREE.MeshBasicMaterial;
  };
  slab: THREE.Mesh;
  outline: Line2;
  shadow: THREE.Mesh;
  dbOffset: number;
}

interface LinkView {
  link: ArchLink;
  path: THREE.CurvePath<THREE.Vector3>;
  length: number;
  /** Where the route leaves the source slab and reaches the target slab. */
  start: number;
  end: number;
  material: LineMaterial;
  dots?: THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  state: LinkState;
}

export interface TopologyScene {
  update(status: SystemStatus | undefined): void;
  select(id: string | null): void;
  /** Screen-space labels: element per anchor id (node id, `db:<id>`, `link:<to>`, `dlq`). */
  setLabels(labels: Map<string, HTMLElement>): void;
  dispose(): void;
}

export function createTopologyScene(host: HTMLElement, events: { onSelect(id: string | null): void; onHover(id: string | null): void }): TopologyScene {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0); // the stage's CSS background shows through
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.4, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.enablePan = false;
  controls.minZoom = 0.7;
  controls.maxZoom = 3.5;
  controls.minPolarAngle = 0.45;
  controls.maxPolarAngle = 1.2;
  let userMoved = false;
  controls.addEventListener('start', () => {
    userMoved = true;
    zoomGoal = null;
  });

  const sky = new THREE.HemisphereLight(0xffffff, 0xd8d8e0, 2);
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(-5, 12, 8);
  scene.add(sky, sun);

  let palette = LIGHT;
  const lineMaterials: LineMaterial[] = [];
  const blockGeometry = new RoundedBoxGeometry(BLOCK, BLOCK, BLOCK, 4, 0.13);
  const badgeGeometry = new THREE.CircleGeometry(0.075, 24);
  const databaseGeometry = new THREE.CylinderGeometry(0.3, 0.3, 0.62, 48);
  const bandGeometry = new THREE.TorusGeometry(0.302, 0.008, 6, 64);
  const dotGeometry = new THREE.SphereGeometry(0.075, 16, 12);
  const shadowMap = shadowTexture();

  function lineMaterial(color: string, dashed = false) {
    const material = new LineMaterial({ color, linewidth: 1.5, worldUnits: false, transparent: true, dashed, dashSize: 0.16, gapSize: 0.14 });
    lineMaterials.push(material);
    return material;
  }

  // -------------------------------------------------------------- nodes

  const anchors = new Map<string, THREE.Vector3>();
  const nodeViews = new Map<string, NodeView>();
  const pickable: THREE.Object3D[] = [];

  function tag(object: THREE.Object3D, id: string) {
    object.userData.id = id;
    pickable.push(object);
    return object;
  }

  function layout(node: ArchNode, slots: number) {
    const columns = node.role === 'broker' ? slots : Math.min(slots, PER_ROW);
    const rows = Math.ceil(slots / columns);
    const databaseWidth = node.database ? STEP : 0;
    const width = Math.max(node.role === 'client' ? 1.6 : 1.3, columns * STEP + databaseWidth + PAD * 2);
    const depth = Math.max(1.3, rows * STEP + PAD * 2);
    return { columns, rows, width, depth };
  }

  /** (Re)builds the containers and resizes the slab – on first draw and whenever the replica count changes. */
  function build(view: NodeView, slots: number) {
    for (const child of [...view.blocks.children]) {
      pickable.splice(pickable.indexOf(child), 1);
      view.blocks.remove(child);
    }
    const { node } = view;
    const { columns, rows, width, depth } = layout(node, slots);
    view.width = width;
    view.depth = depth;
    view.slots = slots;
    const left = -width / 2 + PAD + STEP / 2;

    if (node.role === 'client') {
      // a display, not a container: the browser is where the user sits
      const screen = new THREE.Mesh(new RoundedBoxGeometry(1.05, 0.7, 0.07, 3, 0.03), view.materials.block);
      screen.position.set(0, SLAB + 0.5, 0);
      screen.rotation.x = -0.12;
      view.blocks.add(tag(screen, node.id));
    } else {
      for (let index = 0; index < slots; index++) {
        const row = Math.floor(index / columns);
        const column = index % columns;
        const block = new THREE.Mesh(blockGeometry, view.materials.block);
        block.position.set(left + column * STEP, SLAB + BLOCK / 2, (row - (rows - 1) / 2) * STEP);
        // role badge on the lid – a hint of colour, like a status light
        const badge = new THREE.Mesh(badgeGeometry, view.materials.badge);
        badge.rotation.x = -Math.PI / 2;
        badge.position.set(0, BLOCK / 2 + 0.002, 0);
        block.add(badge);
        view.blocks.add(tag(block, node.id));
      }
    }

    view.slab.geometry.dispose();
    view.slab.geometry = new RoundedBoxGeometry(width, SLAB, depth, 3, 0.07);
    view.outline.geometry.dispose();
    view.outline.geometry = new LineGeometry().setPositions(roundedRect(width - 0.02, depth - 0.02, 0.1, SLAB + 0.003));
    view.outline.computeLineDistances();
    view.shadow.scale.set(width * 1.35 + 0.9, depth * 1.35 + 0.9, 1);
    view.dbOffset = width / 2 - PAD - STEP / 2;
    view.group.getObjectByName('database')?.position.setX(view.dbOffset);

    anchors.set(node.id, new THREE.Vector3(node.x, SLAB + BLOCK + 0.45, node.z));
    if (node.database) anchors.set(`db:${node.id}`, new THREE.Vector3(node.x + view.dbOffset, 0, node.z + depth / 2 + 0.05));
    if (node.role === 'broker') anchors.set('dlq', new THREE.Vector3(node.x, 0, node.z + depth / 2 + 0.05));
  }

  for (const node of NODES) {
    const group = new THREE.Group();
    group.position.set(node.x, 0, node.z);
    const materials: NodeView['materials'] = {
      block: new THREE.MeshPhysicalMaterial({ roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.35, transparent: true }),
      ghost: new THREE.MeshPhysicalMaterial({ color: DOWN, roughness: 0.3, transparent: true, opacity: 0.22, depthWrite: false }),
      badge: new THREE.MeshBasicMaterial({ color: ROLES[node.role].color, transparent: true }),
      slab: new THREE.MeshStandardMaterial({ roughness: 0.9, transparent: true }),
      database: new THREE.MeshPhysicalMaterial({ roughness: 0.38, clearcoat: 0.6, transparent: true }),
      band: new THREE.MeshBasicMaterial({ transparent: true }),
      outline: lineMaterial(LIGHT.outline, node.role === 'external'),
      shadow: new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: shadowMap, transparent: true, depthWrite: false }),
    };

    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), materials.shadow);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.004;
    shadow.renderOrder = -1;
    group.add(shadow);

    const lifted = new THREE.Group(); // everything that rises on hover
    group.add(lifted);
    const slab = new THREE.Mesh(new THREE.BufferGeometry(), materials.slab);
    slab.position.y = SLAB / 2;
    lifted.add(tag(slab, node.id));
    const outline = new Line2(new LineGeometry(), materials.outline);
    lifted.add(outline);
    const blocks = new THREE.Group();
    lifted.add(blocks);

    if (node.database) {
      const database = new THREE.Group();
      database.name = 'database';
      const cylinder = new THREE.Mesh(databaseGeometry, materials.database);
      cylinder.position.y = SLAB + 0.31;
      database.add(tag(cylinder, node.id));
      for (const y of [0.1, -0.1]) {
        const band = new THREE.Mesh(bandGeometry, materials.band);
        band.rotation.x = Math.PI / 2;
        band.position.y = SLAB + 0.31 + y;
        database.add(band);
      }
      lifted.add(database);
    }

    scene.add(group);
    const view: NodeView = { node, group, blocks, width: 0, depth: 0, slots: 0, running: [], up: true, lift: 0, materials, slab, outline, shadow, dbOffset: 0 };
    view.group.userData.lifted = lifted;
    nodeViews.set(node.id, view);
    build(view, node.replicas);
  }

  const floorUniforms = { uColor: { value: new THREE.Color(LIGHT.floor) } };
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 30),
    new THREE.ShaderMaterial({ uniforms: floorUniforms, vertexShader: FLOOR_VERTEX, fragmentShader: FLOOR_FRAGMENT, transparent: true, depthWrite: false }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.renderOrder = -2;
  scene.add(floor);

  // -------------------------------------------------------------- links

  /** Fraction of the route that lies under the slab at `id`, measured from `fromStart`. */
  function clearance(path: THREE.CurvePath<THREE.Vector3>, id: string, fromStart: boolean) {
    const view = nodeViews.get(id) as NodeView;
    const point = new THREE.Vector3();
    for (let step = 0; step <= 200; step++) {
      const u = fromStart ? step / 200 : 1 - step / 200;
      path.getPointAt(u, point);
      if (Math.abs(point.x - view.node.x) > view.width / 2 + 0.12 || Math.abs(point.z - view.node.z) > view.depth / 2 + 0.12) return u;
    }
    return fromStart ? 0 : 1;
  }

  const linkViews: LinkView[] = LINKS.map((link) => {
    const from = NODE_BY_ID[link.from];
    const to = NODE_BY_ID[link.to];
    const corners = [[from.x, from.z], ...(link.via ?? []), [to.x, to.z]].map(([x, z]) => new THREE.Vector3(x, LINE_Y, z));
    const path = route(corners);
    const material = lineMaterial(link.kind === 'http' ? LIGHT.http : LIGHT.queue, link.kind === 'http');
    const line = new Line2(new LineGeometry().setPositions(path.getSpacedPoints(160).flatMap((point) => [point.x, point.y, point.z])), material);
    line.computeLineDistances();
    scene.add(line);
    const view: LinkView = { link, path, length: path.getLength(), start: clearance(path, link.from, true), end: clearance(path, link.to, false), material, state: linkState(link, undefined) };
    if (link.kind === 'queue') {
      view.dots = new THREE.InstancedMesh(dotGeometry, new THREE.MeshBasicMaterial({ transparent: true }), MAX_DOTS);
      view.dots.count = 0;
      view.dots.frustumCulled = false;
      scene.add(view.dots);
      anchors.set(`link:${link.to}`, path.getPointAt(Math.min(view.start + 1.3 / view.length, 0.5)).setY(0.35));
    }
    return view;
  });

  // -------------------------------------------------------------- theme

  function readPalette(): Palette {
    const match = getComputedStyle(host).backgroundColor.match(/\d+(\.\d+)?/g);
    const [r, g, b] = (match ?? ['255', '255', '255']).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? DARK : LIGHT;
  }

  function paint() {
    palette = readPalette();
    sky.intensity = palette.sky;
    sky.groundColor.set(palette === DARK ? '#101012' : '#d8d8e0');
    sun.intensity = palette.sun;
    floorUniforms.uColor.value.set(palette.floor);
    for (const view of nodeViews.values()) {
      const role = new THREE.Color(ROLES[view.node.role].color);
      view.materials.block.color.set(palette.container).lerp(role, palette.tint);
      view.materials.slab.color.set(palette.plinth);
      view.materials.database.color.set(palette.database);
      view.materials.band.color.set(palette.outline);
    }
    for (const view of linkViews) if (view.link.kind === 'http') view.material.color.set(palette.http);
    restyle();
  }

  // -------------------------------------------------------------- state

  let selected: string | null = null;
  let hovered: string | null = null;

  function restyle() {
    const lit = selected ? new Set([selected, ...LINKS.flatMap((link) => (link.from === selected ? [link.to] : link.to === selected ? [link.from] : []))]) : null;
    for (const view of nodeViews.values()) {
      const opacity = lit && !lit.has(view.node.id) ? 0.3 : 1;
      const { materials } = view;
      for (const material of [materials.block, materials.badge, materials.slab, materials.database, materials.band]) material.opacity = opacity;
      materials.ghost.opacity = 0.22 * opacity;
      materials.shadow.opacity = palette.shadow * opacity * (1 - view.lift * 2.5);
      const active = view.node.id === selected || view.node.id === hovered;
      materials.outline.color.set(!view.up ? DOWN : active ? ROLES[view.node.role].color : palette.outline);
      materials.outline.linewidth = active || !view.up ? 2 : 1.5;
      materials.outline.opacity = opacity;
      view.blocks.children.forEach((block, index) => {
        const running = view.up && (view.running[index] ?? true);
        (block as THREE.Mesh).material = running ? materials.block : materials.ghost;
        const badge = block.children[0];
        if (badge) badge.visible = running;
      });
    }
    for (const view of linkViews) {
      const opacity = selected && view.link.from !== selected && view.link.to !== selected ? 0.2 : 1;
      if (view.link.kind === 'queue') view.material.color.set(view.state.tone === 'err' ? DOWN : view.state.tone === 'warn' ? WAITING : palette.queue);
      view.material.opacity = opacity;
      if (view.dots) view.dots.material.opacity = opacity;
    }
    dirty = true;
  }

  let lastStatus: SystemStatus | undefined;

  function update(status: SystemStatus | undefined) {
    lastStatus = status;
    for (const view of nodeViews.values()) {
      const state = nodeState(view.node, status);
      if (state.slots !== view.slots) build(view, state.slots);
      view.up = state.up;
      // service replicas fail as a count, broker nodes by name
      view.running = view.node.role === 'broker'
        ? brokerNodes(status).map((node) => node.running)
        : Array.from({ length: view.slots }, (_, index) => index < state.live);
    }
    for (const view of linkViews) view.state = linkState(view.link, status);
    restyle();
  }

  const goal = new THREE.Vector3(0, 0.4, 0);
  let zoomGoal: number | null = null;

  function select(id: string | null) {
    const previous = selected;
    selected = id;
    const node = id ? NODE_BY_ID[id] : undefined;
    goal.set(node?.x ?? 0, 0.4, node?.z ?? 0);
    // step in a little on the first selection, back out when it closes
    if (!previous && id) zoomGoal = Math.max(camera.zoom, 1.35);
    if (previous && !id && !userMoved) zoomGoal = 1;
    update(lastStatus);
  }

  // -------------------------------------------------------------- dots

  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();

  /** Returns whether anything is moving, so an idle system costs no frames. */
  function placeDots(view: LinkView, seconds: number): boolean {
    const dots = view.dots;
    if (!dots) return false;
    const { ready, unacked, rate } = view.state;
    const span = view.end - view.start;
    // messages waiting in the queue line up at the broker end – a queue you can see …
    const waiting = Math.min(ready, 16);
    let index = 0;
    for (let i = 0; i < waiting; i++, index++) {
      view.path.getPointAt(view.start + ((i + 0.5) * 0.22) / view.length, point);
      matrix.makeTranslation(point.x, 0.09, point.z);
      dots.setMatrixAt(index, matrix);
      dots.setColorAt(index, WAITING);
    }
    // … and deliveries travel to the consumer, as many as are really moving
    const moving = Math.min(MAX_DOTS - waiting, rate > 0 ? Math.max(2, Math.round(rate * 2)) + Math.min(unacked, 6) : Math.min(unacked, 6));
    const speed = (1.8 + Math.min(rate, 10) * 0.15) / view.length;
    for (let i = 0; i < moving; i++, index++) {
      const t = reducedMotion ? (i + 0.5) / moving : (seconds * speed / span + i / moving) % 1;
      view.path.getPointAt(view.start + t * span, point);
      matrix.makeTranslation(point.x, 0.09, point.z);
      dots.setMatrixAt(index, matrix);
      dots.setColorAt(index, view.state.tone === 'err' ? DOWN : TRAFFIC);
    }
    dots.count = index;
    dots.instanceMatrix.needsUpdate = true;
    if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
    return moving > 0 && !reducedMotion;
  }

  // -------------------------------------------------------------- labels

  let labels = new Map<string, HTMLElement>();
  const projected = new THREE.Vector3();

  function placeLabels() {
    for (const [id, element] of labels) {
      const anchor = anchors.get(id);
      if (!anchor) continue;
      const lifted = nodeViews.get(id)?.lift ?? 0;
      projected.copy(anchor).setY(anchor.y + lifted).project(camera);
      const hidden = Math.abs(projected.x) > 1.05 || Math.abs(projected.y) > 1.05;
      element.style.visibility = hidden ? 'hidden' : '';
      if (hidden) continue;
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      // labels hang above their anchor; database names and the DLQ sit below theirs
      const below = element.dataset.hang === 'below';
      element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, ${below ? '6px' : '-100%'})`;
    }
  }

  // -------------------------------------------------------------- picking

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function pick(event: PointerEvent): string | null {
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const [hit] = raycaster.intersectObjects(pickable, false);
    return (hit?.object.userData.id as string | undefined) ?? null;
  }
  let pressed: { x: number; y: number } | null = null;
  const onPointerDown = (event: PointerEvent) => {
    pressed = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < 5) events.onSelect(pick(event));
    pressed = null;
  };
  const setHovered = (id: string | null) => {
    if (id === hovered) return;
    hovered = id;
    renderer.domElement.style.cursor = id ? 'pointer' : '';
    events.onHover(id);
    restyle();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!event.buttons) setHovered(pick(event));
  };
  const onPointerLeave = () => setHovered(null);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);

  // -------------------------------------------------------------- camera fit

  let width = 1;
  let height = 1;

  /** Frames the whole landscape; portrait screens look down the request flow instead of across it. */
  function fit() {
    const aspect = width / height;
    const [azimuth, elevation] = aspect >= 1 ? [0.38, 0.68] : [-1.25, 1.05];
    const direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
    controls.target.set(0, 0.4, 0);
    goal.copy(controls.target);
    camera.position.copy(controls.target).addScaledVector(direction, 60);
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();
    let halfWidth = 0;
    let halfHeight = 0;
    // fit the slabs themselves (plus label height), not a bounding box – no dead corners
    const corners = [...nodeViews.values()].flatMap(({ node, width: w, depth: d }) =>
      [-1, 1].flatMap((sx) => [-1, 1].flatMap((sz) => [0, 1.9].map((y) => new THREE.Vector3(node.x + (sx * w) / 2, y, node.z + (sz * d) / 2)))),
    );
    for (const corner of corners) {
      const local = corner.applyMatrix4(camera.matrixWorldInverse);
      halfWidth = Math.max(halfWidth, Math.abs(local.x));
      halfHeight = Math.max(halfHeight, Math.abs(local.y));
    }
    const half = Math.max(halfHeight * 1.1, (halfWidth * (aspect >= 1 ? 1.1 : 1.2)) / aspect);
    Object.assign(camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half, zoom: 1 });
  }

  function resize() {
    width = Math.max(host.clientWidth, 1);
    height = Math.max(host.clientHeight, 1);
    renderer.setSize(width, height);
    for (const material of lineMaterials) material.resolution.set(width, height);
    if (userMoved) {
      const half = camera.top;
      Object.assign(camera, { left: -half * (width / height), right: half * (width / height) });
    } else {
      fit();
    }
    camera.updateProjectionMatrix();
    dirty = true;
  }

  // -------------------------------------------------------------- loop

  let dirty = true;
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);

  let visible = true;
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
  });
  intersection.observe(host);

  // follow the app theme (explicit choice or system setting)
  const themeObserver = new MutationObserver(() => requestAnimationFrame(paint));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  const schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => requestAnimationFrame(paint);
  schemeQuery.addEventListener('change', onScheme);

  const timer = new THREE.Timer();
  const right = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const ease = (from: number, to: number, rate: number) => (reducedMotion ? to : from + (to - from) * rate);

  renderer.setAnimationLoop((timestamp) => {
    timer.update(timestamp);
    if (!visible || document.hidden) return;
    const seconds = timer.getElapsed();
    let moving = controls.update(timer.getDelta());

    // with the details panel open on the right, keep the selection left of it
    aim.copy(goal);
    if (selected && width > 720) {
      const worldPerPixel = (camera.right - camera.left) / camera.zoom / width;
      aim.addScaledVector(right.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize(), 190 * worldPerPixel);
    }
    if (controls.target.distanceToSquared(aim) > 1e-5) {
      const before = controls.target.clone();
      controls.target.set(ease(before.x, aim.x, 0.1), ease(before.y, aim.y, 0.1), ease(before.z, aim.z, 0.1));
      camera.position.add(controls.target.clone().sub(before));
      moving = true;
    }
    if (zoomGoal !== null) {
      camera.zoom = ease(camera.zoom, zoomGoal, 0.1);
      camera.updateProjectionMatrix();
      if (Math.abs(camera.zoom - zoomGoal) < 0.002) zoomGoal = null;
      moving = true;
    }
    for (const view of nodeViews.values()) {
      const lift = view.node.id === hovered || view.node.id === selected ? 0.1 : 0;
      if (Math.abs(view.lift - lift) > 1e-3) {
        view.lift = ease(view.lift, lift, 0.18);
        (view.group.userData.lifted as THREE.Group).position.y = view.lift;
        view.materials.shadow.opacity = palette.shadow * view.materials.block.opacity * (1 - view.lift * 2.5);
        moving = true;
      }
    }
    for (const view of linkViews) if (placeDots(view, seconds)) moving = true;

    if (!moving && !dirty) return;
    dirty = false;
    renderer.render(scene, camera);
    placeLabels();
  });

  paint();

  return {
    update,
    select,
    setLabels(next) {
      labels = next;
      dirty = true;
    },
    dispose() {
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      intersection.disconnect();
      themeObserver.disconnect();
      schemeQuery.removeEventListener('change', onScheme);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      controls.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) for (const entry of material) entry.dispose();
        else material?.dispose();
      });
      shadowMap.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
