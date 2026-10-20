import * as T from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { makeRoute } from "./route.js";

// Willow Lane: the storybook street the Morning Route film plays on.
//
// Built only while the film runs and disposed afterwards. It sits far from
// the Test ground (beyond the camera's far plane), so nothing there needs
// hiding. Static scenery is merged by material into a handful of draw calls
// with vertex colours; the cast (made in Blender, see blender/cast.py) is
// loaded from assets/town and animated procedurally here.

export const ORIGIN = new T.Vector3(1400, 0, 1400);
const SKY = new T.Color("#ecdcc4");
const C = (h) => new T.Color(h);
const PALETTE = {
  grass: C("#9dbd8c"),
  grassDark: C("#94b382"),
  road: C("#c9c2b4"),
  roadEdge: C("#b4ad9f"),
  walk: C("#ece4d2"),
  line: C("#f6efd9"),
  walls: ["#a9c3a6", "#f1dc9a", "#b9d2e3", "#ecc3bd", "#f4f3ee", "#cfe0c3", "#f3d3b0", "#c9d6ea"].map(C),
  roofs: ["#c9714f", "#6f8fa8", "#8a6a5a", "#b55f4c", "#5f7f6a", "#a46b55", "#6f7fa0", "#c08455"].map(C),
  trim: C("#fbf7ee"),
  door: ["#5f7f6a", "#c9714f", "#4f6d8c", "#e0915a", "#7a5a87", "#3f6b6a", "#b55f4c", "#5a6f8f"].map(C),
  glass: C("#9fc2d3"),
  fence: C("#fbf7ee"),
  wood: C("#b98a5e"),
  woodDark: C("#94704b"),
  trunk: C("#8a6a4a"),
  leaves: ["#7fae6f", "#8fbb78", "#6fa06a", "#9cc283", "#a5c98b"].map(C),
  hedge: C("#6f9b62"),
  flowers: ["#f29c8c", "#f6d36b", "#fbf7ee", "#c9a6e0", "#ef8f6f", "#9fc2e8"].map(C),
  stone: C("#c7c2b6"),
  hill: C("#b9cf9f"),
  mailbox: C("#5f7f9f"),
  flag: C("#e05a4a"),
  post: C("#fbf7ee"),
};

// The street, west to east, as ground points (town-local x, z).
const STREET = [
  [-110, 2],
  [-70, 2],
  [-40, 0],
  [-12, -2],
  [16, -2],
  [44, 2],
  [72, 8],
  [100, 10],
  [140, 8],
];
const CREEK_X = -78; // creek crosses the street here (bridge)
const LANE = 2.2; // the van keeps to the right-hand lane (its kerb-side door faces the mailboxes)

function nonIndexed(g) {
  const out = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(out.attributes)) if (k !== "position" && k !== "normal") out.deleteAttribute(k);
  return out;
}

// Collects coloured geometry and merges it into one mesh per material.
class Batch {
  constructor() {
    this.parts = [];
  }
  add(geo, color, matrix) {
    const g = nonIndexed(geo.clone());
    if (matrix) g.applyMatrix4(matrix);
    const n = g.attributes.position.count,
      c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
    g.setAttribute("color", new T.BufferAttribute(c, 3));
    this.parts.push(g);
    return this;
  }
  mesh(material, name) {
    if (!this.parts.length) return null;
    const g = mergeGeometries(this.parts, false);
    this.parts.forEach((p) => p.dispose());
    this.parts = [];
    g.computeBoundingSphere();
    const m = new T.Mesh(g, material);
    m.name = name;
    m.castShadow = m.receiveShadow = true;
    return m;
  }
}

const M4 = (x = 0, y = 0, z = 0, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) => new T.Matrix4().compose(new T.Vector3(x, y, z), new T.Quaternion().setFromEuler(new T.Euler(rx, ry, rz, "YXZ")), new T.Vector3(sx, sy, sz));

// Seeded random so the town is the same every time.
function rng(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

export class Town {
  constructor(scene, renderer, opts = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.toon = opts.toon || ((m) => m);
    this.lights = opts.lights || {};
    this.kitUrl = opts.kitUrl || "assets/town/props.glb";
    this.urls = Object.assign({ neighbor: "assets/town/neighbor.glb", dog: "assets/town/dog.glb", cat: "assets/town/cat.glb", bird: "assets/town/bird.glb" }, opts.urls || {});
    this.timeout = opts.timeout ?? 4000;
    this.group = new T.Group();
    this.group.name = "Willow Lane";
    // Open-world copies sit elsewhere and skip the film's sky, light and fog.
    this.origin = opts.origin ? opts.origin.clone() : ORIGIN.clone();
    this.openWorld = !!opts.openWorld;
    this.group.position.copy(this.origin);
    this.disposables = [];
    this.cast = {};
    this.anchors = {};
    this.time = 0;
    // The street the van drives (world space), keeping to the right-hand lane.
    const base = makeRoute(STREET),
      long = makeRoute([...STREET, [180, 6], [260, 3], [420, 0]]),
      pts = [];
    // The van's path runs on past the last house so it can drive off into the hills.
    for (let d = 0; d <= long.length; d += 4) {
      const p = long.at(d),
        th = Math.PI - p.yaw; // travel direction (cos th, sin th); right-hand normal (-sin th, cos th)
      pts.push([this.origin.x + p.x - Math.sin(th) * LANE, this.origin.z + p.z + Math.cos(th) * LANE]);
    }
    this.street = base;
    this.route = makeRoute(pts);
  }
  get(name) {
    return this.group.getObjectByName(name);
  }
  mat(opts) {
    const m = this.toon(new T.MeshToonMaterial(opts));
    this.disposables.push(m);
    return m;
  }
  async build() {
    const vc = this.mat({ vertexColors: true, side: T.DoubleSide });
    this.vc = vc;
    this.kit = await this.loadKit();
    if (this.disposed) return;
    this.ground(vc);
    this.houses(vc);
    this.greenery(vc);
    this.creek();
    this.props(vc);
    if (!this.openWorld) this.light();
    this.scene.add(this.group);
    if (!this.openWorld) this.atmosphere(true);
    await this.loadCast();
    this.group.updateMatrixWorld(true);
  }
  // ------------------------------------------------------------ scenery
  ground(vc) {
    const b = new Batch();
    if (!this.openWorld) b.add(new T.PlaneGeometry(1800, 1800, 1, 1), PALETTE.grass, M4(0, 0, 0, 0, 1, 1, 1, -Math.PI / 2));
    // Road ribbon with soft edges, sidewalks and a dashed centre line.
    // The visible road runs well past both ends of the van's route so it
    // reaches into the hills instead of starting out of nowhere.
    const s = makeRoute([[-520, 2], [-380, 2], [-250, 2], [-160, 2], ...STREET, [180, 6], [260, 3], [420, 0]]);
    const strip = (half0, half1, y, color, dash = 0) => {
      const g = new T.BufferGeometry(),
        pos = [];
      const step = 2;
      for (let d = 0; d < s.length - step; d += step) {
        if (dash && Math.floor(d / dash) % 2) continue;
        const a = s.at(d),
          c = s.at(d + step);
        const side = (p, h) => {
          const th = Math.PI - p.yaw;
          return [p.x - Math.sin(th) * h, p.z + Math.cos(th) * h];
        };
        const A0 = side(a, half0),
          A1 = side(a, half1),
          B0 = side(c, half0),
          B1 = side(c, half1);
        pos.push(A0[0], y, A0[1], B0[0], y, B0[1], A1[0], y, A1[1], A1[0], y, A1[1], B0[0], y, B0[1], B1[0], y, B1[1]);
      }
      g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      // Faces may wind either way; force normals up.
      const nrm = g.attributes.normal;
      for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
      b.add(g, color);
    };
    strip(-4.4, 4.4, 0.03, PALETTE.road);
    strip(-4.4, -4.0, 0.045, PALETTE.roadEdge);
    strip(4.0, 4.4, 0.045, PALETTE.roadEdge);
    strip(-0.09, 0.09, 0.05, PALETTE.line, 3);
    strip(4.4, 6.6, 0.06, PALETTE.walk);
    strip(-6.6, -4.4, 0.06, PALETTE.walk);
    strip(6.6, 6.75, 0.08, PALETTE.stone);
    strip(-6.75, -6.6, 0.08, PALETTE.stone);
    // Rolling hills on the horizon.
    const r = rng(7);
    for (let i = 0; i < (this.openWorld ? 0 : 14); i++) {
      const a = (i / 14) * Math.PI * 2 + r() * 0.3,
        d = 210 + r() * 60;
      b.add(new T.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), PALETTE.hill.clone().offsetHSL(0, 0, (r() - 0.5) * 0.06), M4(Math.cos(a) * d, -2, Math.sin(a) * d, 0, 50 + r() * 50, 14 + r() * 16, 40 + r() * 30));
    }
    const m = b.mesh(this.mat({ vertexColors: true, side: T.DoubleSide }), "Ground");
    m.castShadow = false;
    this.group.add(m);
  }
  houses(vc) {
    const b = new Batch(),
      glass = new Batch(),
      s = this.street;
    const box = (w, h, d, r = 0.06) => new RoundedBoxGeometry(w, h, d, 1, r);
    const roofGeo = (w, h, d) => {
      const shape = new T.Shape();
      shape.moveTo(-w / 2 - 0.35, 0);
      shape.lineTo(0, h);
      shape.lineTo(w / 2 + 0.35, 0);
      shape.lineTo(w / 2 + 0.35, -0.22);
      shape.lineTo(0, h - 0.3);
      shape.lineTo(-w / 2 - 0.35, -0.22);
      shape.closePath();
      const g = new T.ExtrudeGeometry(shape, { depth: d + 0.7, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 2 });
      g.translate(0, 0, -(d + 0.7) / 2);
      return g;
    };
    // Lots: distance along the street, side (-1 north, +1 south), house number.
    const LOTS = [
      [64, -1, 6],
      [72, 1, 7],
      [90, -1, 9],
      [98, 1, 14],
      [118, 1, 11],
      [128, -1, 16],
      [148, 1, 13],
      [160, -1, 18],
      [180, 1, 15],
      [192, -1, 20],
      [214, -1, 22],
      [222, 1, 17],
    ];
    this.lots = [];
    const r = rng(3);
    LOTS.forEach(([d, side, num], i) => {
      const p = s.at(d),
        th = Math.PI - p.yaw,
        nx = -Math.sin(th),
        nz = Math.cos(th);
      const set = 15 + r() * 3,
        cx = p.x + nx * set * side,
        cz = p.z + nz * set * side;
      const face = Math.atan2(-nx * side, -nz * side); // front faces the street
      const w = 7.5 + r() * 2,
        h = 3.6 + r() * 0.6,
        dp = 6.5 + r() * 1.5,
        two = num % 3 === 2;
      const H = two ? h * 1.55 : h;
      const toWorld = (x, y, z) => M4(cx + x * Math.cos(face) + z * Math.sin(face), y, cz - x * Math.sin(face) + z * Math.cos(face), face);
      const wall = PALETTE.walls[i % PALETTE.walls.length],
        roof = PALETTE.roofs[(i * 3) % PALETTE.roofs.length];
      b.add(box(w, H, dp, 0.12), wall, toWorld(0, H / 2, 0));
      b.add(box(w + 0.3, 0.3, dp + 0.3, 0.08), PALETTE.stone, toWorld(0, 0.15, 0));
      // Three house types share the lot layout: 0 cottage (steep roof, gabled
      // porch, round attic window), 1 two-storey (shutters, side chimney),
      // 2 bungalow (low wide roof, dormer).
      const style = two ? 1 : i % 2 ? 2 : 0;
      const rh = style === 0 ? 3.0 + r() * 0.4 : style === 2 ? 1.9 + r() * 0.3 : 2.3 + r() * 0.4;
      const span = dp, eave = span / 2 + 0.35;
      // Roof: ridge runs along the house width, covering the whole box.
      const R = toWorld(0, H, 0).multiply(M4(0, 0, 0, Math.PI / 2));
      b.add(roofGeo(span, rh, w), roof, R);
      // Solid attic under the roof so the gable ends are closed (no see-through).
      const gable = new T.Shape();
      gable.moveTo(-span / 2 - 0.2, -0.02);
      gable.lineTo(0, rh - 0.12);
      gable.lineTo(span / 2 + 0.2, -0.02);
      gable.closePath();
      const gg = new T.ExtrudeGeometry(gable, { depth: w - 0.02, bevelEnabled: false });
      gg.translate(0, 0, -(w - 0.02) / 2);
      b.add(gg, wall, R);
      // Shingle courses down both slopes.
      const slope = Math.atan2(rh, eave),
        dark = roof.clone().offsetHSL(0, 0, -0.06);
      for (let k = 1; k <= 6; k++) {
        const t = k / 7.2;
        for (const sd of [-1, 1])
          b.add(new T.BoxGeometry(w + 0.62, 0.045, 0.1), dark, toWorld(0, H + rh * t + 0.05, sd * eave * (1 - t)).multiply(M4(0, 0, 0, 0, 1, 1, 1, sd * slope)));
      }
      // Ridge cap.
      b.add(new T.CylinderGeometry(0.11, 0.11, w + 0.75, 8), dark, toWorld(0, H + rh + 0.02, 0).multiply(M4(0, 0, 0, 0, 1, 1, 1, 0, Math.PI / 2)));
      // Chimney: stone stack with a cap.
      const chx = style === 1 ? -w / 2 + 0.6 : w * 0.28,
        chz = style === 1 ? 0 : -dp * 0.15;
      b.add(box(0.85, rh + 1.2, 0.85, 0.06), style === 1 ? C("#b8735a") : PALETTE.stone, toWorld(chx, H + (rh + 1.2) / 2 - 0.2, chz));
      b.add(box(1.05, 0.16, 1.05, 0.04), PALETTE.trim, toWorld(chx, H + rh + 1.0, chz));
      // Lap siding lines across the front.
      const sidingColor = wall.clone().offsetHSL(0, 0, -0.05);
      for (let y = 0.55; y < H - 0.2; y += 0.38) b.add(new T.BoxGeometry(w - 0.1, 0.035, 0.03), sidingColor, toWorld(0, y, dp / 2 + 0.005));
      // Corner boards.
      for (const sx of [-1, 1]) b.add(new T.BoxGeometry(0.16, H, 0.16), PALETTE.trim, toWorld(sx * (w / 2 - 0.04), H / 2, dp / 2 - 0.04));
      if (style === 0) {
        // Round attic window in the side gables.
        for (const sx of [-1, 1]) {
          b.add(new T.CylinderGeometry(0.42, 0.42, 0.1, 20), PALETTE.trim, toWorld(sx * (w / 2 + 0.01), H + rh * 0.38, 0).multiply(M4(0, 0, 0, 0, 1, 1, 1, 0, Math.PI / 2)));
          glass.add(new T.CylinderGeometry(0.32, 0.32, 0.12, 20), PALETTE.glass, toWorld(sx * (w / 2 + 0.02), H + rh * 0.38, 0).multiply(M4(0, 0, 0, 0, 1, 1, 1, 0, Math.PI / 2)));
        }
      }
      if (style === 2) {
        // Dormer on the front slope.
        const dzp = eave * 0.42,
          dy = H + rh * (1 - 0.42) - 0.15;
        b.add(box(1.7, 1.15, 1.4, 0.05), wall, toWorld(w * 0.2, dy + 0.4, dzp));
        b.add(roofGeo(1.7, 0.75, 1.5), roof, toWorld(w * 0.2, dy + 0.95, dzp));
        b.add(box(1.1, 0.8, 0.08, 0.03), PALETTE.trim, toWorld(w * 0.2, dy + 0.42, dzp + 0.71));
        glass.add(box(0.9, 0.6, 0.06, 0.02), PALETTE.glass, toWorld(w * 0.2, dy + 0.42, dzp + 0.75));
      }
      // Front: door, windows with frames, porch roof on posts, steps.
      const fz = dp / 2 + 0.03;
      b.add(box(1.15, 2.1, 0.12, 0.04), PALETTE.door[i % PALETTE.door.length], toWorld(-w * 0.18, 1.2, fz));
      b.add(box(1.35, 2.3, 0.08, 0.03), PALETTE.trim, toWorld(-w * 0.18, 1.25, fz - 0.03));
      b.add(new T.SphereGeometry(0.06, 8, 6), C("#e8c15a"), toWorld(-w * 0.18 + 0.38, 1.15, fz + 0.1));
      const win = (x, y) => {
        b.add(box(1.45, 1.25, 0.1, 0.04), PALETTE.trim, toWorld(x, y, fz - 0.02));
        // Louvred shutters either side.
        for (const sx of [-1, 1]) {
          b.add(box(0.36, 1.2, 0.06, 0.02), PALETTE.door[(i + 3) % PALETTE.door.length], toWorld(x + sx * 0.95, y, fz + 0.01));
          for (let l = -2; l <= 2; l++) b.add(new T.BoxGeometry(0.28, 0.025, 0.03), PALETTE.door[(i + 3) % PALETTE.door.length].clone().offsetHSL(0, 0, -0.08), toWorld(x + sx * 0.95, y + l * 0.2, fz + 0.05));
        }
        glass.add(box(1.2, 1.0, 0.06, 0.02), PALETTE.glass, toWorld(x, y, fz + 0.02));
        b.add(new T.BoxGeometry(0.06, 1.0, 0.08), PALETTE.trim, toWorld(x, y, fz + 0.04));
        b.add(new T.BoxGeometry(1.6, 0.12, 0.25), PALETTE.trim, toWorld(x, y - 0.66, fz + 0.06));
        // Window box with flowers.
        b.add(new T.BoxGeometry(1.3, 0.22, 0.28), PALETTE.wood, toWorld(x, y - 0.82, fz + 0.18));
        for (let k = 0; k < 6; k++) b.add(new T.SphereGeometry(0.1, 6, 4), PALETTE.flowers[(k + i) % PALETTE.flowers.length], toWorld(x - 0.5 + k * 0.2, y - 0.66, fz + 0.2));
      };
      win(w * 0.22, 1.7);
      if (two) {
        win(-w * 0.18, H - 1.3);
        win(w * 0.22, H - 1.3);
      }
      if (style === 0) {
        b.add(roofGeo(w * 0.55, 1.0, 1.9), roof, toWorld(-w * 0.12, 2.7, fz + 0.9));
        const pg = new T.Shape();
        pg.moveTo(-w * 0.275, 0);
        pg.lineTo(0, 0.82);
        pg.lineTo(w * 0.275, 0);
        pg.closePath();
        const pgg = new T.ExtrudeGeometry(pg, { depth: 0.08, bevelEnabled: false });
        b.add(pgg, PALETTE.trim, toWorld(-w * 0.12, 2.7, fz + 1.8));
      } else b.add(box(w * 0.55, 0.16, 1.9, 0.05), PALETTE.trim, toWorld(-w * 0.12, 2.75, fz + 0.9));
      for (const px of [-w * 0.36, w * 0.12]) b.add(new T.CylinderGeometry(0.08, 0.08, 2.6, 10), PALETTE.trim, toWorld(px, 1.4, fz + 1.7));
      b.add(box(w * 0.55, 0.18, 1.9, 0.04), PALETTE.wood, toWorld(-w * 0.12, 0.1, fz + 0.9));
      b.add(box(1.4, 0.16, 0.5, 0.04), PALETTE.stone, toWorld(-w * 0.18, 0.08, fz + 2.1));
      // Path to the sidewalk, picket fence with a gap at the gate.
      const yard = set - dp / 2 - 6.6;
      for (let k = 0, n = Math.floor((set - 7.4 - (fz + 2.6)) / 0.9) + 1; k < n; k++) b.add(new T.CylinderGeometry(0.34, 0.36, 0.05, 10), PALETTE.stone, toWorld(-w * 0.18 + (k % 2 ? 0.07 : -0.07), 0.045, fz + 2.6 + k * 0.9).multiply(new T.Matrix4().makeScale(1.15, 1, 0.85)));
      const fenceZ = set - 6.9 - 0.1;
      if (this.kit) {
        // Picket panels (modelled in Blender), with a gap at the gate.
        const g0 = -w * 0.18;
        for (const [a, bnd] of [
          [-w / 2 - 1.5, g0 - 0.75],
          [g0 + 0.75, w / 2 + 1.5],
        ]) {
          const len = bnd - a,
            n = Math.max(1, Math.round(len / 2)),
            sx = len / (2 * n);
          for (let k = 0; k < n; k++) (this.fenceAt ||= []).push(toWorld(a + (k + 0.5) * 2 * sx, 0, fenceZ).multiply(new T.Matrix4().makeScale(sx, 1, 1)));
          (this.postAt ||= []).push(toWorld(bnd, 0, fenceZ));
        }
        for (const x of [-w / 2 + 0.3, w / 2 - 0.3, w / 2 + 0.6]) (this.bushAt ||= []).push(toWorld(x, 0, fz + 0.7).multiply(new T.Matrix4().makeScale(0.9, 0.9, 0.9)));
      } else for (let x = -w / 2 - 1.5; x <= w / 2 + 1.5; x += 0.42) {
        if (Math.abs(x + w * 0.18) < 0.75) continue;
        b.add(new T.BoxGeometry(0.11, 0.85, 0.05), PALETTE.fence, toWorld(x, 0.43, fenceZ));
        b.add(new T.ConeGeometry(0.075, 0.14, 4), PALETTE.fence, toWorld(x, 0.92, fenceZ));
      }
      if (!this.kit) for (const y of [0.3, 0.62]) for (const hx of [-1, 1]) b.add(new T.BoxGeometry(w / 2 + 1.5 - 0.8, 0.07, 0.04), PALETTE.fence, toWorld(hx * ((w / 2 + 1.5 + 0.75) / 2) - w * 0.18 * 0, y, fenceZ - 0.04));
      // Flower beds along the front.
      for (let k = 0; k < 14; k++) {
        const x = -w / 2 + 0.4 + (k / 13) * (w - 0.8);
        if (Math.abs(x + w * 0.18) < 0.8) continue;
        b.add(new T.SphereGeometry(0.28, 8, 5), PALETTE.hedge, toWorld(x, 0.22, fz + 0.45));
        b.add(new T.SphereGeometry(0.09, 6, 4), PALETTE.flowers[(k * 7 + i) % PALETTE.flowers.length], toWorld(x + 0.08, 0.46, fz + 0.62));
      }
      const gate = new T.Vector3(...toWorld(-w * 0.18, 0, fenceZ).elements.slice(12, 15));
      const porch = new T.Vector3(...toWorld(-w * 0.18, 0.2, fz + 1.2).elements.slice(12, 15));
      const yardSpot = new T.Vector3(...toWorld(w * 0.25, 0, fz + 3).elements.slice(12, 15));
      // Mailbox at the curb, beside the gate.
      const curb = s.at(d),
        mb = new T.Vector3(curb.x + nx * 5.1 * side, 0, curb.z + nz * 5.1 * side);
      this.lots.push({ d, side, num, center: new T.Vector3(cx, 0, cz), face, gate, porch, yard: yardSpot, mailbox: mb, roofTop: H + rh });
    });
    const m = b.mesh(vc, "Houses");
    this.group.add(m);
    const gm = glass.mesh(this.mat({ vertexColors: true, emissive: new T.Color("#3a5a68"), emissiveIntensity: 0.25 }), "Windows");
    gm.castShadow = false;
    this.group.add(gm);
  }
  greenery(vc) {
    const trunks = new Batch(),
      leaves = new Batch(),
      r = rng(11),
      s = this.street;
    const kitTrees = [],
      kitFar = [];
    let far = false;
    const tree = (x, z, size) => {
      if (this.kit) {
        (far ? kitFar : kitTrees).push(M4(x, 0, z, r() * Math.PI * 2, size * 1.05, size * (0.95 + r() * 0.2), size * 1.05));
        return;
      }
      const h = 2.2 * size;
      trunks.add(new T.CylinderGeometry(0.18 * size, 0.26 * size, h, 8), PALETTE.trunk, M4(x, h / 2, z));
      const col = PALETTE.leaves[Math.floor(r() * PALETTE.leaves.length)];
      for (let k = 0; k < 4; k++) {
        const a = r() * Math.PI * 2,
          rr = (0.4 + r() * 0.6) * size;
        leaves.add(new T.IcosahedronGeometry(1, 1), col.clone().offsetHSL(0, 0, (r() - 0.5) * 0.06), M4(x + Math.cos(a) * rr * 0.6, h + (0.8 + r() * 0.9) * size, z + Math.sin(a) * rr * 0.6, r() * 3, (1.1 + r() * 0.5) * size, (1.0 + r() * 0.4) * size, (1.1 + r() * 0.5) * size));
      }
    };
    // Behind and between houses, along the creek, and a far woodland band.
    for (const lot of this.lots) {
      const back = new T.Vector3(Math.sin(lot.face), 0, Math.cos(lot.face)).multiplyScalar(-9);
      tree(lot.center.x + back.x + (r() - 0.5) * 8, lot.center.z + back.z + (r() - 0.5) * 6, 1.2 + r() * 0.6);
      tree(lot.center.x + back.x * 0.2 + Math.cos(lot.face) * 7, lot.center.z + back.z * 0.2 - Math.sin(lot.face) * 7, 0.9 + r() * 0.5);
    }
    for (let z = -60; z <= 60; z += 9) if (Math.abs(z) > 10) tree(CREEK_X + 7 + r() * 5, z + r() * 4, 1.0 + r() * 0.6), tree(CREEK_X - 8 - r() * 5, z + r() * 4, 1.0 + r() * 0.6);
    far = true;
    for (let i = 0; i < 90; i++) {
      const a = r() * Math.PI * 2,
        d = 75 + r() * 80;
      const x = 40 + Math.cos(a) * d * 1.4,
        z = Math.sin(a) * d;
      if (Math.abs(z - this.street.at(Math.max(0, Math.min(this.street.length, x + 110))).z) < 26) continue;
      tree(x, z, 1.2 + r() * 1.2);
    }
    far = false;
    // Street trees between the sidewalk and the houses (gaps at the lots).
    for (let d = 10; d < s.length; d += 17) {
      const p = s.at(d),
        th = Math.PI - p.yaw;
      for (const side of [-1, 1]) {
        if (this.lots.some((l) => Math.abs(l.d - d) < 7 && l.side === side)) continue;
        if (Math.abs(p.x - CREEK_X) < 34) continue; // the opening crane shot flies through here
        tree(p.x - Math.sin(th) * 8.5 * side, p.z + Math.cos(th) * 8.5 * side, 0.85 + r() * 0.3);
      }
    }
    if (this.kit) {
      const a = kitTrees.filter((_, i) => i % 3 !== 2),
        b = kitTrees.filter((_, i) => i % 3 === 2);
      this.instance("tree_a", a);
      this.instance("tree_b", b);
      this.instance("tree_a", kitFar, false);
      this.instance("fence", this.fenceAt || []);
      this.instance("bush", this.bushAt || []);
      return;
    }
    this.group.add(trunks.mesh(vc, "Trunks"));
    // Canopies sway gently in the breeze (vertex shader).
    const lm = this.mat({ vertexColors: true });
    lm.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.windTime = { value: 0 };
      sh.vertexShader = "uniform float uTime;\n" + sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n vec4 wp = modelMatrix * vec4(position,1.0);\n float sway = sin(uTime*0.9 + wp.x*0.15 + wp.z*0.11) * 0.06 * clamp(position.y - 1.5, 0.0, 4.0) / 4.0;\n transformed.x += sway; transformed.z += sway*0.6;");
    };
    this.group.add(leaves.mesh(lm, "Canopies"));
  }
  creek() {
    // A winding ribbon of water crossing under the bridge.
    const pts = [],
      w = 3.2;
    for (let z = -120; z <= 120; z += 2) pts.push([CREEK_X + Math.sin(z * 0.045) * 6, z]);
    const route = makeRoute(pts);
    const pos = [],
      uv = [];
    for (let d = 0; d < route.length - 2; d += 2) {
      const a = route.at(d),
        c = route.at(d + 2);
      const side = (p, h) => [p.x - Math.sin(Math.PI - p.yaw) * h, p.z + Math.cos(Math.PI - p.yaw) * h];
      const A0 = side(a, -w),
        A1 = side(a, w),
        B0 = side(c, -w),
        B1 = side(c, w);
      pos.push(A0[0], 0.05, A0[1], B0[0], 0.05, B0[1], A1[0], 0.05, A1[1], A1[0], 0.05, A1[1], B0[0], 0.05, B0[1], B1[0], 0.05, B1[1]);
      uv.push(0, d, 0, d + 2, 1, d, 1, d, 0, d + 2, 1, d + 2);
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
    this.water = { value: 0 };
    const m = new T.ShaderMaterial({
      uniforms: { uTime: this.water, uFog: { value: SKY } },
      side: T.DoubleSide,
      vertexShader: "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} ",
      fragmentShader: `uniform float uTime; varying vec2 vUv;
        void main(){
          float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
          float flow = sin(vUv.y * 1.3 - uTime * 2.2 + sin(vUv.x * 9.0) * 0.8);
          float glint = smoothstep(0.92, 1.0, sin(vUv.y * 0.7 - uTime * 1.6 + vUv.x * 14.0));
          vec3 deep = vec3(0.47, 0.66, 0.74), shallow = vec3(0.68, 0.83, 0.86);
          vec3 col = mix(shallow, deep, edge * (0.7 + 0.15 * flow));
          col += glint * 0.25 * edge;
          col = mix(vec3(0.62, 0.71, 0.55), col, smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.disposables.push(m);
    const mesh = new T.Mesh(g, m);
    mesh.name = "Creek";
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.creekPath = route;
    // Banks of rounded stones.
    const b = new Batch(),
      r = rng(5);
    for (let d = 0; d < route.length; d += 1.6) {
      const p = route.at(d),
        th = Math.PI - p.yaw;
      for (const sd of [-1, 1]) {
        if (Math.abs(p.z - this.street.at(this.street.length * 0.2).z) < 7 && Math.abs(p.x - CREEK_X) < 9) continue;
        b.add(new T.IcosahedronGeometry(0.35 + r() * 0.3, 0), PALETTE.stone.clone().offsetHSL(0, 0, (r() - 0.5) * 0.08), M4(p.x - Math.sin(th) * (w + 0.1) * sd, 0.08, p.z + Math.cos(th) * (w + 0.1) * sd, r() * 3, 1, 0.55, 1));
      }
    }
    // Wooden bridge where the street crosses.
    const sb = this.street,
      dB = this.bridgeD();
    const pB = sb.at(dB),
      thB = Math.PI - pB.yaw;
    const along = new T.Vector3(Math.cos(thB), 0, Math.sin(thB)),
      across = new T.Vector3(-Math.sin(thB), 0, Math.cos(thB));
    for (let k = -6; k <= 6; k++) {
      const c = new T.Vector3(pB.x, 0.12, pB.z).addScaledVector(along, k * 0.8);
      b.add(new RoundedBoxGeometry(0.72, 0.16, 9.2, 1, 0.04), k % 2 ? PALETTE.wood : PALETTE.woodDark, M4(c.x, c.y, c.z, -thB));
    }
    for (const sd of [-1, 1]) {
      for (let k = -6; k <= 6; k += 2) {
        const c = new T.Vector3(pB.x, 0.6, pB.z).addScaledVector(along, k * 0.8).addScaledVector(across, sd * 4.55);
        b.add(new T.CylinderGeometry(0.1, 0.12, 1.05, 8), PALETTE.woodDark, M4(c.x, c.y, c.z));
      }
      const r0 = new T.Vector3(pB.x, 1.08, pB.z).addScaledVector(across, sd * 4.55);
      b.add(new RoundedBoxGeometry(10.4, 0.14, 0.18, 1, 0.05), PALETTE.wood, M4(r0.x, r0.y, r0.z, -thB));
    }
    this.group.add(b.mesh(this.vc, "Bridge and stones"));
    this.anchors.bridge = new T.Vector3(pB.x, 0, pB.z).add(this.origin);
  }
  bridgeD() {
    // Street distance where it crosses the creek.
    let best = 0,
      bd = 1e9;
    for (let d = 0; d < this.street.length; d += 0.5) {
      const dd = Math.abs(this.street.at(d).x - CREEK_X);
      if (dd < bd) (bd = dd), (best = d);
    }
    return best;
  }
  props(vc) {
    // Mailboxes (one per lot); the stop's mailbox is its own animated group.
    const b = new Batch();
    this.stopLot = this.lots.find((l) => l.num === 14);
    if (this.kit)
      this.instance(
        "mailbox",
        this.lots.filter((l) => l !== this.stopLot).map((l) => M4(l.mailbox.x, 0, l.mailbox.z, l.face)),
      );
    else for (const lot of this.lots) {
      if (lot === this.stopLot) continue;
      const m = lot.mailbox,
        f = lot.face;
      b.add(new T.CylinderGeometry(0.06, 0.07, 1.05, 8), PALETTE.post, M4(m.x, 0.52, m.z));
      b.add(new RoundedBoxGeometry(0.34, 0.36, 0.62, 2, 0.12), PALETTE.mailbox.clone().offsetHSL(lot.num * 0.07, 0, 0), M4(m.x, 1.12, m.z, f));
    }
    // Utility wire on poles where the birds sit (before the stop).
    const s = this.street;
    this.wire = [];
    for (const d of [70, 84]) {
      const p = s.at(d),
        th = Math.PI - p.yaw,
        x = p.x + Math.sin(th) * 7.2,
        z = p.z - Math.cos(th) * 7.2;
      b.add(new T.CylinderGeometry(0.1, 0.13, 5.2, 8), PALETTE.woodDark, M4(x, 2.6, z));
      b.add(new RoundedBoxGeometry(1.2, 0.12, 0.12, 1, 0.04), PALETTE.woodDark, M4(x, 5.0, z, -th));
      this.wire.push(new T.Vector3(x, 4.95, z));
    }
    const wg = new T.TubeGeometry(new T.QuadraticBezierCurve3(this.wire[0], this.wire[0].clone().lerp(this.wire[1], 0.5).add(new T.Vector3(0, -0.45, 0)), this.wire[1]), 24, 0.018, 5);
    b.add(wg, C("#3f4a4a"));
    this.group.add(b.mesh(vc, "Mailboxes and poles"));
    // The stop: mailbox with a hinged door and a pop-up flag.
    const lot = this.stopLot;
    if (this.kit) {
      const src = this.kitPart("mailbox"),
        mbx = src.clone(true);
      mbx.name = "Stop mailbox";
      mbx.position.copy(lot.mailbox);
      mbx.rotation.set(0, lot.face, 0);
      mbx.scale.setScalar(1);
      const find = (p) => {
        let o = null;
        mbx.traverse((c) => !o && c !== mbx && c.name.startsWith(p) && (o = c));
        return o;
      };
      const door = find("door"),
        flag = find("flag");
      mbx.traverse((c) => c.isMesh && (c.castShadow = c.receiveShadow = true));
      this.group.add(mbx);
      this.mailbox = { group: mbx, door, flag, doorRest: door?.rotation.x || 0, flagRest: flag?.rotation.x || 0, kit: true };
      const sp = this.kitPart("sprinkler").clone(true);
      sp.position.copy(lot.yard).add(new T.Vector3(Math.cos(lot.face) * 3, 0, -Math.sin(lot.face) * 3));
      sp.traverse((c) => c.isMesh && (c.castShadow = true));
      this.group.add(sp);
      sp.traverse((c) => !this.sprinklerHead && c !== sp && c.name.startsWith("head") && (this.sprinklerHead = c));
    }
    const mbx = new T.Group();
    if (this.kit) mbx.visible = false;
    mbx.name = "Stop mailbox";
    mbx.position.copy(lot.mailbox);
    mbx.rotation.y = lot.face;
    const blue = this.mat({ color: PALETTE.mailbox }),
      white = this.mat({ color: PALETTE.post }),
      red = this.mat({ color: PALETTE.flag });
    const post = new T.Mesh(new T.CylinderGeometry(0.06, 0.07, 1.05, 8), white);
    post.position.y = 0.52;
    const boxm = new T.Mesh(new RoundedBoxGeometry(0.34, 0.36, 0.62, 2, 0.12), blue);
    boxm.position.y = 1.12;
    const door = new T.Group();
    door.position.set(0, 0.94, 0.31);
    const doorMesh = new T.Mesh(new RoundedBoxGeometry(0.34, 0.36, 0.04, 2, 0.02), blue);
    doorMesh.position.y = 0.18;
    door.add(doorMesh);
    const flag = new T.Group();
    flag.position.set(0.19, 1.05, -0.12);
    const flagMesh = new T.Mesh(new RoundedBoxGeometry(0.03, 0.24, 0.1, 1, 0.01), red);
    flagMesh.position.set(0, 0.0, 0.12);
    const flagArm = new T.Mesh(new T.BoxGeometry(0.02, 0.03, 0.22), red);
    flagArm.position.set(0, 0, 0.06);
    flag.add(flagMesh, flagArm);
    flag.rotation.x = Math.PI / 2; // lowered
    for (const o of [post, boxm, doorMesh, flagMesh, flagArm]) o.castShadow = o.receiveShadow = true;
    mbx.add(post, boxm, door, flag);
    this.group.add(mbx);
    if (!this.kit) this.mailbox = { group: mbx, door, flag };
    // A letter that travels from the van to the mailbox.
    const letter = new T.Mesh(new RoundedBoxGeometry(0.24, 0.02, 0.16, 1, 0.006), this.mat({ color: C("#fbf7ee") }));
    const stamp = new T.Mesh(new T.BoxGeometry(0.05, 0.022, 0.05), red);
    stamp.position.set(0.07, 0.002, 0.04);
    letter.add(stamp);
    letter.visible = false;
    letter.castShadow = true;
    this.group.add(letter);
    this.letter = letter;
    // Sprinkler in the stop's yard.
    const n = 160,
      g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(new Float32Array(n * 3), 3));
    const pm = new T.PointsMaterial({ color: C("#e6f3f8"), size: 0.07, transparent: true, opacity: 0.85, depthWrite: false });
    this.disposables.push(pm);
    this.spray = new T.Points(g, pm);
    this.spray.frustumCulled = false;
    this.spray.name = "Sprinkler";
    this.sprayAt = lot.yard.clone().add(new T.Vector3(Math.cos(lot.face) * 3, 0, -Math.sin(lot.face) * 3));
    this.group.add(this.spray);
    // Stop distance on the van's route: abreast of the mailbox.
    let best = 0,
      bd = 1e9;
    const w = this.route;
    const mbW = lot.mailbox.clone().add(this.origin);
    for (let d = 0; d < w.length; d += 0.1) {
      const p = w.at(d),
        dd = Math.hypot(p.x - mbW.x, p.z - mbW.z);
      if (dd < bd) (bd = dd), (best = d);
    }
    this.stops = [best - 0.9];
    this.anchors.house = lot.center.clone().add(this.origin);
    this.anchors.mailbox = mbW;
    this.anchors.porch = lot.porch.clone().add(this.origin);
    this.anchors.gate = lot.gate.clone().add(this.origin);
    this.anchors.yard = lot.yard.clone().add(this.origin);
    this.anchors.wire = this.wire.map((p) => p.clone().add(this.origin));
  }
  // -------------------------------------------------- Blender prop kit
  async loadKit() {
    const loader = new GLTFLoader();
    const got = await Promise.race([
      new Promise((res) => loader.load(this.kitUrl, (g) => res(g.scene), undefined, () => res(null))),
      new Promise((res) => setTimeout(() => res(null), this.timeout)),
    ]);
    if (!got) return null;
    got.updateMatrixWorld(true);
    got.traverse((m) => {
      if (!m.isMesh) return;
      this.disposables.push(m.geometry);
      for (const mt of [].concat(m.material)) {
        this.disposables.push(mt);
        if (/leaves|bush/i.test(mt.name)) this.sway(mt);
      }
    });
    return got;
  }
  kitPart(name) {
    return this.kit.children.find((c) => c.name === name || c.name.startsWith(name + ".")) || this.kit.children.find((c) => c.name.startsWith(name));
  }
  // Leaves breathe in the breeze (per instance phase).
  sway(mt) {
    mt.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.windTime ||= { value: 0 };
      sh.vertexShader = "uniform float uTime;\n" + sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n#ifdef USE_INSTANCING\n vec3 ip = instanceMatrix[3].xyz;\n#else\n vec3 ip = vec3(0.0);\n#endif\n float sway = sin(uTime * 0.9 + ip.x * 0.15 + ip.z * 0.11) * 0.05 * clamp(position.y - 1.6, 0.0, 3.0) / 3.0;\n transformed.x += sway; transformed.z += sway * 0.6;");
    };
  }
  // One InstancedMesh per mesh of a kit prop.
  instance(name, mats, shadow = true) {
    if (!this.kit || !mats.length) return;
    const root = this.kitPart(name);
    if (!root) return;
    const inv = root.matrixWorld.clone().invert();
    root.traverse((m) => {
      if (!m.isMesh) return;
      const local = inv.clone().multiply(m.matrixWorld),
        im = new T.InstancedMesh(m.geometry, m.material, mats.length);
      mats.forEach((M, i) => im.setMatrixAt(i, M.clone().multiply(local)));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = shadow && !/bush|mailbox/.test(name);
      im.receiveShadow = true;
      im.name = name;
      this.group.add(im);
    });
  }
  // ------------------------------------------------- sky, sun, shafts, dust
  light() {
    const sunDir = new T.Vector3(-36, 26, 20).normalize();
    this.sunDir = sunDir;
    // Gradient sky with a soft sun glow (sits behind everything, no fog).
    const sky = new T.ShaderMaterial({
      uniforms: { uSun: { value: sunDir } },
      side: T.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w * 0.9999; }",
      fragmentShader: `uniform vec3 uSun; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, -0.1, 1.0);
          vec3 horizon = vec3(0.92, 0.62, 0.40), mid = vec3(0.70, 0.62, 0.56), zenith = vec3(0.30, 0.46, 0.68);
          vec3 col = mix(horizon, mid, smoothstep(0.0, 0.18, h));
          col = mix(col, zenith, smoothstep(0.15, 0.75, h));
          float s = max(dot(normalize(vDir), uSun), 0.0);
          col += vec3(1.0, 0.7, 0.42) * (pow(s, 5.0) * 0.45 + pow(s, 50.0) * 0.9) + vec3(1.6, 1.35, 1.0) * smoothstep(0.9985, 0.9993, s) * 6.0;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.disposables.push(sky);
    const dome = new T.Mesh(new T.SphereGeometry(650, 32, 16), sky);
    dome.name = "Sky";
    dome.renderOrder = -1;
    dome.frustumCulled = false;
    this.sky = dome;
    this.scene.add(dome); // follows the camera in world space
    // Light shafts: soft additive beams slanting from the sun through the trees.
    const beam = new T.ShaderMaterial({
      uniforms: { uTime: (this.beamTime = { value: 0 }) },
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      side: T.DoubleSide,
      fog: false,
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `uniform float uTime; varying vec2 vUv;
        void main(){
          float across = smoothstep(0.0, 0.5, vUv.x) * smoothstep(1.0, 0.5, vUv.x);
          float along = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
          float shimmer = 0.75 + 0.25 * sin(uTime * 0.6 + vUv.y * 6.0 + vUv.x * 3.0);
          gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * across * along * shimmer * 0.075, 1.0);
        }`,
    });
    this.disposables.push(beam);
    const r = rng(19),
      lot = this.stopLot,
      q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), sunDir);
    const beams = new T.Group();
    beams.name = "Light shafts";
    const geo = new T.PlaneGeometry(1, 1, 1, 1);
    this.disposables.push(geo);
    for (let i = 0; i < 14; i++) {
      const m = new T.Mesh(geo, beam),
        len = 22 + r() * 14;
      const base = lot.center.clone().add(new T.Vector3((r() - 0.5) * 60, 0, (r() - 0.5) * 40));
      m.scale.set(1.2 + r() * 2.2, len, 1);
      m.quaternion.copy(q).multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), r() * Math.PI));
      m.position.copy(base).addScaledVector(sunDir, len * 0.5).add(new T.Vector3(0, 0.2, 0));
      m.renderOrder = 2;
      beams.add(m);
    }
    this.group.add(beams);
    // Dust motes drifting in the sun around the camera.
    const n = 700,
      pos = new Float32Array(n * 3);
    this.motes = { seeds: Array.from({ length: n }, () => [r(), r(), r(), r()]) };
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(pos, 3));
    const pm = new T.PointsMaterial({ color: new T.Color("#fff1d6"), size: 0.035, transparent: true, opacity: 0.55, depthWrite: false, blending: T.AdditiveBlending });
    this.disposables.push(pm);
    const pts = new T.Points(g, pm);
    pts.frustumCulled = false;
    pts.name = "Dust";
    this.motes.points = pts;
    this.group.add(pts);
  }
  // ------------------------------------------------------------- the cast
  async loadCast() {
    const loader = new GLTFLoader();
    const load = (key) =>
      new Promise((res) => {
        loader.load(
          this.urls[key],
          (g) => res(g.scene),
          undefined,
          () => res(null),
        );
      });
    const timeout = new Promise((res) => setTimeout(() => res("timeout"), this.timeout));
    const all = Promise.all(["neighbor", "dog", "cat", "bird"].map(load));
    const got = await Promise.race([all, timeout]);
    if (got === "timeout") {
      // Keep whatever arrives later out of a disposed town.
      all.then((list) => !this.disposed && this.placeCast(list));
      return;
    }
    this.placeCast(got);
  }
  placeCast([neighbor, dog, cat, bird]) {
    if (this.disposed) return;
    const lot = this.stopLot;
    const prep = (o, name) => {
      if (!o) return null;
      o.name = name;
      o.traverse((m) => {
        if (m.isMesh) {
          m.castShadow = m.receiveShadow = true;
          this.disposables.push(m.geometry);
          for (const mt of [].concat(m.material)) this.disposables.push(mt);
        }
      });
      const part = (n) => o.getObjectByName(n);
      return { root: o, part, rest: {} };
    };
    const face = lot.face; // characters face +z locally (Blender -Y)
    if (neighbor) {
      const c = (this.cast.neighbor = prep(neighbor, "Juniper"));
      neighbor.scale.setScalar(1.15);
      neighbor.position.copy(lot.yard);
      neighbor.rotation.y = face + 0.9;
      this.group.add(neighbor);
    }
    if (dog) {
      const c = (this.cast.dog = prep(dog, "Biscuit"));
      dog.scale.setScalar(1.25);
      dog.position.copy(lot.porch).setY(0.2);
      dog.rotation.y = face;
      this.group.add(dog);
    }
    if (cat) {
      const next = this.lots.find((l) => l.num === 16) || lot;
      const c = (this.cast.cat = prep(cat, "Mochi"));
      cat.scale.setScalar(1.3);
      cat.position.copy(next.porch).setY(0.22);
      cat.rotation.y = next.face;
      this.group.add(cat);
    }
    if (bird) {
      this.cast.birds = [];
      for (let i = 0; i < 4; i++) {
        const o = i ? bird.clone(true) : bird;
        const c = prep(o, "Pip " + i);
        o.traverse((m) => m.isMesh && (m.castShadow = false));
        const t = 0.25 + i * 0.17;
        c.perch = this.wire[0].clone().lerp(this.wire[1], t).add(new T.Vector3(0, -0.45 * 4 * t * (1 - t) + 0.02, 0));
        o.position.copy(c.perch);
        o.scale.setScalar(1.6);
        o.rotation.y = Math.PI / 2 + (i % 2 ? 0.4 : -0.3);
        c.seed = i * 1.7;
        this.group.add(o);
        this.cast.birds.push(c);
      }
    }
  }
  // ---------------------------------------------------------- atmosphere
  atmosphere(on) {
    const sc = this.scene,
      L = this.lights;
    if (on) {
      this.saved = { bg: sc.background?.clone?.(), fog: sc.fog, sun: L.sun && { c: L.sun.color.clone(), i: L.sun.intensity }, hemi: L.hemi && { c: L.hemi.color.clone(), g: L.hemi.groundColor.clone(), i: L.hemi.intensity }, offset: L.sunOffset?.clone() };
      sc.background = SKY.clone();
      sc.fog = new T.Fog(new T.Color("#e9d2b2"), 150, 460);
      if (L.sun) L.sun.color.set("#ffd8a6"), (L.sun.intensity = 3.4);
      if (L.hemi) L.hemi.color.set("#e9ecff"), L.hemi.groundColor.set("#6f8052"), (L.hemi.intensity = 1.4);
      if (L.sunOffset) L.sunOffset.set(-36, 26, 20); // low morning sun, long shadows
      if (L.sun) {
        const c = L.sun.shadow.camera;
        this.saved.shadow = { l: c.left, r: c.right, t: c.top, b: c.bottom, f: c.far, nb: L.sun.shadow.normalBias, bias: L.sun.shadow.bias };
        Object.assign(c, { left: -42, right: 42, top: 42, bottom: -42, far: 140 });
        L.sun.shadow.normalBias = 0.05;
        L.sun.shadow.bias = -0.0004;
        c.updateProjectionMatrix();
      }
    } else if (this.saved) {
      const s = this.saved;
      if (s.bg) sc.background = s.bg;
      sc.fog = s.fog;
      if (L.sun && s.sun) L.sun.color.copy(s.sun.c), (L.sun.intensity = s.sun.i);
      if (L.hemi && s.hemi) L.hemi.color.copy(s.hemi.c), L.hemi.groundColor.copy(s.hemi.g), (L.hemi.intensity = s.hemi.i);
      if (L.sunOffset && s.offset) L.sunOffset.copy(s.offset);
      if (L.sun && s.shadow) {
        const c = L.sun.shadow.camera;
        Object.assign(c, { left: s.shadow.l, right: s.shadow.r, top: s.shadow.t, bottom: s.shadow.b, far: s.shadow.f });
        L.sun.shadow.normalBias = s.shadow.nb;
        L.sun.shadow.bias = s.shadow.bias;
        c.updateProjectionMatrix();
      }
      this.saved = null;
    }
  }
  // --------------------------------------------------------------- update
  // ctx: { van: Vector3 (world), beat: string, u: 0..1, t: film seconds }
  update(t, ctx = {}) {
    this.time = t;
    if (this.windTime) this.windTime.value = t;
    if (this.water) this.water.value = t;
    if (this.beamTime) this.beamTime.value = t;
    if (ctx.cam && this.sky) this.sky.position.copy(ctx.cam);
    if (ctx.cam && this.motes) {
      const c = ctx.cam.clone().sub(this.origin),
        a = this.motes.points.geometry.attributes.position;
      this.motes.seeds.forEach(([x, y, z, w], i) => {
        const R = 9;
        const px = ((((x * 2 - 1) * R + t * 0.12 * (w - 0.3) + Math.sin(t * 0.4 + w * 9) * 0.3 - c.x) % (2 * R)) + 3 * R) % (2 * R) - R;
        const py = ((y * 6 + t * 0.05 * (w - 0.5) + 30) % 6) - 1;
        const pz = ((((z * 2 - 1) * R + Math.cos(t * 0.3 + w * 7) * 0.3 - c.z) % (2 * R)) + 3 * R) % (2 * R) - R;
        a.setXYZ(i, c.x + px, Math.max(0.2, c.y + py - 2), c.z + pz);
      });
      a.needsUpdate = true;
    }
    const beat = ctx.beat || "dawn",
      u = ctx.u ?? 0,
      van = ctx.van ? ctx.van.clone().sub(this.origin) : new T.Vector3(-1e4, 0, 0);
    const sm = (x) => (x = Math.min(1, Math.max(0, x))) * x * (3 - 2 * x);
    const order = ctx.order || ["dawn", "glide", "stop", "delivery", "wave", "charge", "away"],
      bi = order.indexOf(beat);
    const after = (id) => bi > order.indexOf(id);
    const lot = this.stopLot;
    // Mailbox: door opens, letter flies in, door shuts, flag pops up.
    if (this.mailbox) {
      const d = beat === "delivery" ? u : after("delivery") ? 1 : 0;
      let open = sm((d - 0.15) / 0.12) * (1 - sm((d - 0.62) / 0.1)),
        raise = sm((d - 0.7) / 0.08),
        wobble = Math.sin(Math.max(0, d - 0.78) * 30) * 0.12 * Math.exp(-Math.max(0, d - 0.78) * 18);
      if (ctx.mail) {
        // Driven by the carrier's hand in the film.
        open = ctx.mail.open;
        raise = ctx.mail.flag;
        wobble = Math.sin(Math.max(0, ctx.mail.flagT) * 30) * 0.12 * Math.exp(-Math.max(0, ctx.mail.flagT) * 18) * (ctx.mail.flag >= 1 ? 1 : 0);
      }
      if (this.mailbox.kit) {
        if (this.mailbox.door) this.mailbox.door.rotation.x = this.mailbox.doorRest + open * 1.5;
        if (this.mailbox.flag) this.mailbox.flag.rotation.x = this.mailbox.flagRest - raise * (Math.PI / 2) + wobble;
      } else {
        this.mailbox.door.rotation.x = open * 1.45;
        this.mailbox.flag.rotation.x = (Math.PI / 2) * (1 - raise) + wobble;
      }
      const k = sm((d - 0.25) / 0.32);
      this.letter.visible = !ctx.mail && d > 0.22 && d < 0.6;
      if (this.letter.visible && ctx.letterFrom) {
        const from = ctx.letterFrom.clone().sub(this.origin),
          to = lot.mailbox.clone().setY(1.13);
        this.letter.position.lerpVectors(from, to, k).y += Math.sin(k * Math.PI) * 0.35;
        this.letter.rotation.set(0, lot.face + k * 0.4, Math.sin(k * Math.PI) * 0.25);
      }
    }
    if (this.sprinklerHead) this.sprinklerHead.rotation.y = Math.sin(t * 0.8) * 1.1 + Math.PI / 2;
    // Sprinkler arc.
    if (this.spray) {
      const a = this.spray.geometry.attributes.position,
        sweep = Math.sin(t * 0.8) * 1.1,
        p0 = this.sprayAt;
      for (let i = 0; i < a.count; i++) {
        const f = ((i / a.count + t * 0.9) % 1) * 1.0,
          ang = sweep + Math.sin(i * 12.9898) * 0.15,
          dist = f * 3.2;
        a.setXYZ(i, p0.x + Math.cos(ang + lot.face) * dist, p0.y + 0.3 + Math.sin(f * Math.PI) * 1.1, p0.z - Math.sin(ang + lot.face) * dist);
      }
      a.needsUpdate = true;
    }
    const c = this.cast;
    const vanNear = (o, r) => o.position.distanceTo(van) < r;
    // Juniper: watering, then turns and waves at the van.
    if (c.neighbor) {
      const r = c.neighbor.root,
        P = c.neighbor.part;
      const look = Math.atan2(van.x - r.position.x, van.z - r.position.z);
      const w = beat === "wave" ? sm(u / 0.2) : after("wave") ? 1 - sm((ctx.t - (ctx.waveEnd ?? 52)) / 2) : beat === "delivery" ? sm((u - 0.7) / 0.3) * 0.6 : 0;
      r.rotation.y = lerpAngle(lot.face + 0.9, look, w);
      const armL = P("arm_L"),
        armR = P("arm_R"),
        head = P("head"),
        body = P("body");
      const wave = beat === "wave" ? sm(u / 0.15) * (1 - sm((u - 0.85) / 0.15)) : 0;
      if (armL) armL.rotation.set(-0.35 * wave, 0, Math.sign(armL.position.x || 1) * (wave * 1.45 + Math.sin(t * 9) * 0.28 * wave));
      if (armR) armR.rotation.set(-0.35 * (1 - w) + Math.sin(t * 1.3) * 0.05, 0, 0);
      const can = P("can");
      if (can) can.rotation.x = (1 - w) * (0.45 + Math.sin(t * 1.3) * 0.08);
      if (head) head.rotation.set(Math.sin(t * 1.1) * 0.04 - wave * 0.08, 0, Math.sin(t * 0.7) * 0.05 + wave * 0.12);
      if (body) body.position.y = 0.55 * 1 + Math.abs(Math.sin(t * 2.4)) * 0.006;
    }
    // Biscuit: on the porch; trots to the fence when the van stops, sits and wags.
    if (c.dog) {
      const r = c.dog.root,
        P = c.dog.part;
      const go = beat === "stop" ? sm((u - 0.4) / 0.6) : bi > order.indexOf("stop") ? 1 : 0;
      const gate = lot.gate.clone().addScaledVector(new T.Vector3(Math.sin(lot.face), 0, Math.cos(lot.face)), -0.35); // in the gate opening, in view
      const from = lot.porch.clone().setY(0.2);
      r.position.lerpVectors(from, gate.setY(0), go);
      r.position.y = (1 - go) * 0.2;
      const moving = go > 0 && go < 1;
      const toVan = Math.atan2(van.x - r.position.x, van.z - r.position.z);
      const toGate = Math.atan2(gate.x - from.x, gate.z - from.z);
      r.rotation.y = moving ? toGate : go >= 1 ? toVan : lot.face;
      const trot = moving ? 1 : 0,
        ph = t * 11;
      for (const [n, o] of [["leg_FL", 0], ["leg_BR", 0], ["leg_FR", Math.PI], ["leg_BL", Math.PI]]) {
        const leg = P(n);
        if (leg) leg.rotation.x = Math.sin(ph + o) * 0.6 * trot;
      }
      const sit = go >= 1 ? 1 : 0;
      const body = P("body");
      if (body) {
        body.rotation.x = sit * -0.25;
        body.position.y = 0.2 + Math.abs(Math.sin(ph)) * 0.02 * trot - sit * 0.03;
      }
      if (P("leg_BL")) P("leg_BL").rotation.x += sit * 1.0;
      if (P("leg_BR")) P("leg_BR").rotation.x += sit * 1.0;
      const excited = beat === "delivery" || beat === "wave" ? 1 : 0.35;
      if (P("tail")) P("tail").rotation.z = Math.sin(t * (8 + 10 * excited)) * (0.25 + 0.35 * excited);
      if (P("head")) P("head").rotation.set(Math.sin(t * 3) * 0.04, 0, beat === "wave" ? Math.sin(t * 2) * 0.22 : 0);
      if (P("ear_L")) P("ear_L").rotation.x = Math.sin(t * 6) * 0.08 * excited;
      if (P("ear_R")) P("ear_R").rotation.x = Math.sin(t * 6 + 1) * 0.12 * excited;
    }
    // Mochi: head follows the van, tail flicks.
    if (c.cat) {
      const r = c.cat.root,
        P = c.cat.part;
      const want = Math.atan2(van.x - r.position.x, van.z - r.position.z) - r.rotation.y;
      const a = Math.max(-0.9, Math.min(0.9, Math.atan2(Math.sin(want), Math.cos(want))));
      if (P("head")) P("head").rotation.y = vanNear(r, 40) ? a : Math.sin(t * 0.3) * 0.2;
      if (P("tail")) P("tail").rotation.y = Math.sin(t * 1.7) * 0.15 + (Math.sin(t * 5.3) > 0.97 ? 0.3 : 0);
    }
    // Pip and friends: perch, peck, then lift off as the van passes.
    if (c.birds) {
      for (const b of c.birds) {
        const r = b.root,
          P = b.part;
        if (!b.flew && vanNear(r, 13)) b.flew = t + b.seed * 0.12;
        if (t < (b.flew ?? Infinity)) {
          // Rewound: back on the wire.
          if (b.flew && t < b.flew) b.flew = vanNear(r, 13) ? b.flew : null;
          r.position.copy(b.perch);
          r.position.y += Math.max(0, Math.sin(t * 3 + b.seed * 3)) * 0.02;
          if (P("body")) P("body").rotation.x = Math.max(0, Math.sin(t * 2 + b.seed)) > 0.95 ? 0.4 : 0;
          if (P("wing_L")) P("wing_L").rotation.y = 0;
          if (P("wing_R")) P("wing_R").rotation.y = 0;
        } else {
          const f = t - b.flew;
          r.position.copy(b.perch).add(new T.Vector3(Math.sin(b.seed) * f * 3, f * 2.2 + f * f * 0.4, Math.cos(b.seed) * f * 4));
          const flap = Math.sin(t * 38 + b.seed) * 1.1;
          if (P("wing_L")) P("wing_L").rotation.y = flap;
          if (P("wing_R")) P("wing_R").rotation.y = -flap;
          r.visible = f < 8;
        }
      }
    }
  }
  dispose() {
    this.disposed = true;
    this.atmosphere(false);
    this.scene.remove(this.group);
    if (this.sky) this.scene.remove(this.sky), this.sky.geometry.dispose();
    this.group.traverse((o) => {
      if (o.isMesh || o.isPoints) {
        o.geometry?.dispose();
      }
    });
    for (const d of this.disposables) d.dispose?.();
    this.disposables = [];
  }
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}
