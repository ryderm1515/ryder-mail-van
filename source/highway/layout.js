import * as T from "three";
import { Path } from "./path.js";

// The interstate lives far from the test grounds. Everything here is in world
// coordinates. The loop runs counter-clockwise seen from above, so a car going
// +s keeps to the right side (+offset = inside of the loop) and a car going -s
// keeps to the outside (-offset).

export const W0 = new T.Vector3(0, 0, 12000);
export const LANE_W = 3.7;
export const MEDIAN = 10; // centreline to inner edge of each carriageway
export const IN_SHOULDER = 1.5;
export const OUT_SHOULDER = 3.0;
export const LANES = 3;
export const EDGE_IN = MEDIAN + IN_SHOULDER; // 11.5
export const EDGE_OUT = EDGE_IN + LANES * LANE_W; // 22.6
export const PAVE_OUT = EDGE_OUT + OUT_SHOULDER; // 25.6
export const laneOffset = (lane) => EDGE_IN + LANE_W * (LANES - 1 - lane) + LANE_W / 2; // lane 0 = right/slow
export const BRIDGE_Y = 7.6;

// Named areas inside the loop (see zones.js); terrain flattens under them.
export const ZONES = [
  { id: "downtown", name: "Riverside Downtown", x: W0.x - 2780, z: W0.z, r: 430 },
  { id: "industrial", name: "Eastport Industrial", x: W0.x + 2800, z: W0.z, r: 400 },
  { id: "farms", name: "Orchard Fields", x: W0.x - 1250, z: W0.z + 560, r: 380 },
  { id: "farms2", name: "Orchard Fields", x: W0.x + 1300, z: W0.z - 560, r: 380 },
];

const LOOP = [
  [-2600, -1200], [-1300, -1240], [0, -1200], [1300, -1160], [2600, -1200], [3350, -950], [3600, 0], [3350, 950],
  [2600, 1200], [1300, 1250], [0, 1180], [-1300, 1210], [-2600, 1200], [-3350, 950], [-3600, 0], [-3350, -950],
];

export function buildLayout() {
  const main = new Path(
    LOOP.map(([x, z]) => [x + W0.x, z + W0.z]),
    { closed: true, step: 2 },
  );
  const interchanges = [];
  const defs = [
    { at: [0, -1200], exit: 12, names: ["Pooler", "Willow Lane"], town: "Willow Lane" },
    { at: [0, 1180], exit: 27, names: ["Statesboro", "Maple Hollow"], town: "Maple Hollow" },
  ];
  for (const d of defs) {
    const sc = main.project(d.at[0] + W0.x, d.at[1] + W0.z).s;
    const c = main.at(sc);
    const P = (ds, off, y) => {
      const p = main.point(sc + ds, off);
      return [p.x, y, p.z];
    };
    // Diamond ramps: (ds, off, y) profiles, mirrored for each direction.
    const prof = [
      [-560, 20.75, 0], [-470, 21.2, 0], [-390, 24.5, 0], [-310, 30, 0.3], [-230, 37, 1.5], [-150, 45, 3.6], [-90, 52, 5.6], [-45, 57, 7.1], [-6, 60, BRIDGE_Y],
    ];
    const offPlus = new Path(prof.map(([a, o, y]) => P(a, o, y)), { step: 1 });
    const onPlus = new Path(prof.map(([a, o, y]) => P(-a, o, y)).reverse(), { step: 1 });
    const offMinus = new Path(prof.map(([a, o, y]) => P(-a, -o, y)), { step: 1 });
    const onMinus = new Path(prof.map(([a, o, y]) => P(a, -o, y)).reverse(), { step: 1 });
    // Crossroad along the normal: u < 0 runs out to the neighbourhood.
    const crossY = (u) => {
      const a = Math.abs(u);
      if (a <= 75) return BRIDGE_Y;
      const k = Math.min(1, (a - 75) / 185);
      return BRIDGE_Y * (1 - k * k * (3 - 2 * k));
    };
    const pts = [];
    for (let u = -740; u <= 520; u += 10) pts.push([c.x + c.nx * u, crossY(u), c.z + c.nz * u]);
    const cross = new Path(pts, { step: 1 });
    const end = { x: c.x + c.nx * -740, z: c.z + c.nz * -740 };
    // Ring roads: both ends of the town street curve back and cross the
    // crossroad 210 m in, so there are no dead ends.
    const O = { x: end.x + 300, z: end.z - 2 };
    const J = cross.at(210),
      jx = J.x - O.x,
      jz = J.z - O.z,
      sz = Math.sign(jz - 2) || 1;
    const W = (pts) => new Path(pts.map(([x, z]) => [O.x + x, O.z + z]), { step: 1 });
    const loops = [
      W([[420, 0], [468, sz * 4], [505, sz * 35], [520, sz * 100], [505, sz * 165], [455, jz - sz * 6], [380, jz], [jx + 9, jz]]),
      W([[-520, 2], [-566, 2 + sz * 3], [-604, sz * 35], [-618, sz * 100], [-604, sz * 165], [-556, jz - sz * 6], [-480, jz], [jx - 9, jz]]),
    ];
    interchanges.push({
      loops,
      ...d,
      sc,
      c,
      ramps: [
        { path: offPlus, dir: 1, kind: "off" },
        { path: onPlus, dir: 1, kind: "on" },
        { path: offMinus, dir: -1, kind: "off" },
        { path: onMinus, dir: -1, kind: "on" },
      ],
      cross,
      crossY,
      // The neighbourhood street meets the crossroad at its local x = -300.
      townOrigin: new T.Vector3(end.x + 300, 0, end.z - 2),
      end,
    });
  }
  // Zone access: a two-way road off the inside shoulder (with a median
  // crossover so both directions can turn in) ending in a ring with stops.
  const access = [];
  for (const zn of ZONES) {
    if (zn.id.startsWith("farms")) continue;
    const pr = main.project(zn.x, zn.z),
      sd = Math.sign(pr.off) || 1,
      R = 110;
    const P = (off) => {
      const p = main.point(pr.s, sd * off);
      return [p.x, p.z];
    };
    const A1 = P(PAVE_OUT + 30),
      ux = zn.x - A1[0],
      uz = zn.z - A1[1],
      ul = Math.hypot(ux, uz);
    const entry = [zn.x - (ux / ul) * R, zn.z - (uz / ul) * R];
    const road = new Path([P(PAVE_OUT - 2), P(PAVE_OUT + 12), A1, [(A1[0] + entry[0]) / 2, (A1[1] + entry[1]) / 2], entry], { step: 1 });
    const ring = new Path(Array.from({ length: 28 }, (_, i) => {
      const a = (i / 28) * Math.PI * 2;
      return [zn.x + Math.cos(a) * R, zn.z + Math.sin(a) * R];
    }), { closed: true, step: 1 });
    const a0 = Math.atan2(-uz, -ux);
    const stops = [0.55, 1.35, 2.15, 2.95, 3.75, 4.55, 5.35].map((k, i) => {
      const a = a0 + k;
      return { num: "Box " + (i + 1), pos: new T.Vector3(zn.x + Math.cos(a) * (R + 7.2), 0, zn.z + Math.sin(a) * (R + 7.2)), yaw: -a };
    });
    access.push({ zone: zn, s: pr.s, sd, road, ring, stops, label: zn.name });
  }
  return { main, interchanges, access };
}

// ------------------------------------------------------------- terrain
// Smooth value noise for hills.
function hash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, z) {
  const xi = Math.floor(x),
    zi = Math.floor(z),
    xf = x - xi,
    zf = z - zi;
  const u = xf * xf * (3 - 2 * xf),
    v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi),
    b = hash(xi + 1, zi),
    c = hash(xi, zi + 1),
    d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, z) {
  let f = 0,
    a = 0.5,
    k = 1;
  for (let i = 0; i < 4; i++) {
    f += a * vnoise(x * k, z * k);
    k *= 2.03;
    a *= 0.5;
  }
  return f;
}

// Height grid with a distance-to-road field: flat near pavement, rolling
// hills further out.
export function buildTerrain(layout, towns) {
  const X0 = W0.x - 4800,
    Z0 = W0.z - 2900,
    SIZE_X = 9600,
    SIZE_Z = 5800,
    CELL = 24;
  const nx = Math.round(SIZE_X / CELL),
    nz = Math.round(SIZE_Z / CELL);
  const W = nx + 1,
    H = nz + 1;
  const dist = new Float32Array(W * H).fill(1e9);
  const seed = (x, z, r) => {
    const i = Math.round((x - X0) / CELL),
      j = Math.round((z - Z0) / CELL);
    const rr = Math.ceil(r / CELL) + 1;
    for (let dj = -rr; dj <= rr; dj++)
      for (let di = -rr; di <= rr; di++) {
        const a = i + di,
          b = j + dj;
        if (a < 0 || b < 0 || a >= W || b >= H) continue;
        const d = Math.max(0, Math.hypot(X0 + a * CELL - x, Z0 + b * CELL - z) - r);
        const k = b * W + a;
        if (d < dist[k]) dist[k] = d;
      }
  };
  const { main, interchanges } = layout;
  for (let s = 0; s < main.length; s += 12) {
    const p = main.at(s);
    seed(p.x, p.z, 45);
  }
  for (const ic of interchanges) {
    for (const r of ic.ramps) for (let s = 0; s < r.path.length; s += 8) seed(r.path.at(s).x, r.path.at(s).z, 22);
    for (let s = 0; s < ic.cross.length; s += 8) seed(ic.cross.at(s).x, ic.cross.at(s).z, 24);
  }
  for (const ac of layout.access) for (const pth of [ac.road, ac.ring]) for (let s = 0; s < pth.length; s += 6) seed(pth.at(s).x, pth.at(s).z, 20);
  for (const ic of interchanges) for (const lp of ic.loops) for (let s = 0; s < lp.length; s += 8) seed(lp.at(s).x, lp.at(s).z, 20);
  for (const t of towns) for (let x = -650; x <= 560; x += 30) for (let z = -260; z <= 260; z += 30) seed(t.x + x, t.z + z, 30);
  // Chamfer passes to spread the distance field.
  const D1 = CELL,
    D2 = CELL * Math.SQRT2;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      let v = dist[k];
      if (i > 0) v = Math.min(v, dist[k - 1] + D1);
      if (j > 0) v = Math.min(v, dist[k - W] + D1);
      if (i > 0 && j > 0) v = Math.min(v, dist[k - W - 1] + D2);
      if (i < W - 1 && j > 0) v = Math.min(v, dist[k - W + 1] + D2);
      dist[k] = v;
    }
  for (let j = H - 1; j >= 0; j--)
    for (let i = W - 1; i >= 0; i--) {
      const k = j * W + i;
      let v = dist[k];
      if (i < W - 1) v = Math.min(v, dist[k + 1] + D1);
      if (j < H - 1) v = Math.min(v, dist[k + W] + D1);
      if (i < W - 1 && j < H - 1) v = Math.min(v, dist[k + W + 1] + D2);
      if (i > 0 && j < H - 1) v = Math.min(v, dist[k + W - 1] + D2);
      dist[k] = v;
    }
  const heights = new Float32Array(W * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const k = j * W + i,
        x = X0 + i * CELL,
        z = Z0 + j * CELL;
      const d = dist[k];
      const ramp = Math.min(1, Math.max(0, (d - 40) / 380));
      let s = ramp * ramp * (3 - 2 * ramp);
      for (const zn of ZONES) {
        const f = Math.min(1, Math.max(0, (Math.hypot(x - zn.x, z - zn.z) - zn.r) / 300));
        s *= zn.id.startsWith("farms") ? 0.35 + 0.65 * f : f * f * (3 - 2 * f);
      }
      const h = fbm(x / 520, z / 520) * 70 - 20 + fbm(x / 140 + 9, z / 140) * 14;
      // Edge of the map climbs into ridges so the world feels enclosed.
      const ex = Math.max(0, Math.abs(x - W0.x) - 4000) / 800,
        ez = Math.max(0, Math.abs(z - W0.z) - 2300) / 600;
      heights[k] = Math.max(-0.4, s * Math.max(0, h)) + (ex * ex + ez * ez) * 40 * s - (d < 30 ? 0.06 : 0);
    }
  const sample = (x, z) => {
    const fx = (x - X0) / CELL,
      fz = (z - Z0) / CELL;
    const i = Math.max(0, Math.min(W - 2, Math.floor(fx))),
      j = Math.max(0, Math.min(H - 2, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - i)),
      v = Math.min(1, Math.max(0, fz - j));
    const a = heights[j * W + i],
      b = heights[j * W + i + 1],
      c = heights[(j + 1) * W + i],
      d = heights[(j + 1) * W + i + 1];
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  };
  const distAt = (x, z) => {
    const i = Math.max(0, Math.min(W - 1, Math.round((x - X0) / CELL))),
      j = Math.max(0, Math.min(H - 1, Math.round((z - Z0) / CELL)));
    return dist[j * W + i];
  };
  return { X0, Z0, CELL, W, H, nx, nz, heights, dist, sample, distAt, SIZE_X, SIZE_Z };
}
