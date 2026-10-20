import * as T from "three";
import { ZONES } from "./layout.js";
export { ZONES };

// Distinct areas inside the interstate loop, so the drive has landmarks:
// a downtown skyline on the west curve, an industrial park on the east curve
// and farmland on the long straights. Simple instanced shapes in the same
// soft storybook palette as Willow Lane; cuboid colliders on every building.

export const zoneAt = (x, z) => ZONES.find((zn) => Math.hypot(x - zn.x, z - zn.z) < zn.r + 260) || null;

function windowTex(rows, cols, lit) {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 128, 256);
  const cw = 128 / cols,
    rh = 256 / rows;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      g.fillStyle = Math.random() < lit ? "#f6dfb0" : "#8e9aa3";
      g.fillRect(i * cw + cw * 0.22, j * rh + rh * 0.24, cw * 0.56, rh * 0.5);
    }
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function stripeTex(a, b) {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = a;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = b;
  for (let i = 0; i < 64; i += 16) g.fillRect(i, 0, 8, 64);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  t.wrapS = t.wrapT = T.RepeatWrapping;
  return t;
}

export function buildZones(hw) {
  const { world, terrain: ter, toon } = hw;
  const group = new T.Group();
  group.name = "Zones";
  world.group.add(group);
  let seed = 31;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const clear = (x, z, r) => ter.distAt(x, z) > r; // keep off roads
  const mats = [];
  const M = (o) => {
    const m = toon(new T.MeshToonMaterial(o));
    mats.push(m);
    return m;
  };
  // Instanced primitive with per-instance colour.
  const inst = (geo, mat, list, shadow = true) => {
    if (!list.length) return;
    const im = new T.InstancedMesh(geo, mat, list.length);
    const m4 = new T.Matrix4(),
      q = new T.Quaternion(),
      up = new T.Vector3(0, 1, 0);
    list.forEach((b, i) => {
      q.setFromAxisAngle(up, b.yaw || 0);
      m4.compose(new T.Vector3(b.x, b.y, b.z), q, new T.Vector3(b.sx, b.sy, b.sz));
      im.setMatrixAt(i, m4);
      im.setColorAt(i, new T.Color(b.c));
    });
    im.castShadow = shadow;
    im.receiveShadow = true;
    group.add(im);
  };
  const box = new T.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const cyl = new T.CylinderGeometry(0.5, 0.5, 1, 18).translate(0, 0.5, 0);
  const prism = (() => {
    // Gable roof: unit footprint, ridge along z, apex at y = 1.
    const sh = new T.Shape([new T.Vector2(-0.5, 0), new T.Vector2(0.5, 0), new T.Vector2(0, 1)]);
    return new T.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
  })();
  const solid = (b, h = b.sy) => world.wall(b.x, b.y + h / 2, b.z, b.sx / 2, h / 2, b.sz / 2, b.yaw || 0);
  const ground = (x, z) => ter.sample(x, z) - 0.4;

  // ---------------------------------------------------------- downtown
  {
    const Z = ZONES[0],
      towers = [],
      roofs = [];
    const walls = ["#efe2cc", "#e7cfb4", "#d9a58a", "#c9d3c2", "#f1e8d8", "#cdbfa8", "#e9c9a3", "#b9c7cf"];
    for (let gx = -6; gx <= 6; gx++)
      for (let gz = -6; gz <= 6; gz++) {
        const x = Z.x + gx * 58 + (rnd() - 0.5) * 8,
          z = Z.z + gz * 58 + (rnd() - 0.5) * 8,
          d = Math.hypot(x - Z.x, z - Z.z) / Z.r;
        if (d > 1 || !clear(x, z, 34)) continue;
        // Taller toward the middle: a readable skyline from the interstate.
        const h = 14 + (1 - d) * (1 - d) * 70 * (0.55 + rnd() * 0.7);
        const w = 22 + rnd() * 16,
          dp = 22 + rnd() * 16,
          y = ground(x, z),
          c = walls[Math.floor(rnd() * walls.length)];
        const b = { x, y, z, sx: w, sy: h, sz: dp, c };
        towers.push(b);
        roofs.push({ x, y: y + h, z, sx: w * 0.55, sy: 2.2 + rnd() * 3, sz: dp * 0.5, c: "#8d8f8c" });
        if (h > 45 && rnd() < 0.5) towers.push({ x, y: y + h, z, sx: w * 0.7, sy: h * 0.25, sz: dp * 0.7, c });
        solid(b);
      }
    const tex = windowTex(16, 4, 0.35);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    inst(box, M({ map: tex }), towers);
    inst(box, M({}), roofs, false);
  }
  // -------------------------------------------------------- industrial
  {
    const Z = ZONES[1],
      sheds = [],
      tanks = [],
      stacks = [],
      bands = [];
    const tints = ["#d7dcd9", "#c5cfd3", "#e0d7c6", "#bfc9c0", "#a9b8c2"];
    for (let i = 0; i < 46; i++) {
      const a = rnd() * Math.PI * 2,
        rr = Math.sqrt(rnd()) * Z.r,
        x = Z.x + Math.cos(a) * rr,
        z = Z.z + Math.sin(a) * rr;
      if (!clear(x, z, 46)) continue;
      const y = ground(x, z),
        yaw = Math.round(rnd() * 2) * (Math.PI / 2) + 0.1;
      const b = { x, y, z, sx: 30 + rnd() * 34, sy: 9 + rnd() * 7, sz: 40 + rnd() * 40, yaw, c: tints[i % tints.length] };
      if (sheds.some((s) => Math.hypot(s.x - x, s.z - z) < 60)) continue;
      sheds.push(b);
      bands.push({ ...b, y: y + b.sy - 0.2, sy: 1.2, sx: b.sx + 0.6, sz: b.sz + 0.6, c: "#e06a4c" });
      solid(b);
    }
    for (let i = 0; i < 14; i++) {
      const x = Z.x + (rnd() - 0.5) * Z.r * 1.4,
        z = Z.z + (rnd() - 0.5) * Z.r * 1.4;
      if (!clear(x, z, 30) || sheds.some((s) => Math.hypot(s.x - x, s.z - z) < 45)) continue;
      const r = 9 + rnd() * 7,
        h = 10 + rnd() * 9,
        b = { x, y: ground(x, z), z, sx: r * 2, sy: h, sz: r * 2, c: rnd() < 0.5 ? "#eeeae2" : "#d9e2e4" };
      tanks.push(b);
      solid({ ...b, sx: r * 1.5, sz: r * 1.5 });
    }
    for (let i = 0; i < 4; i++) {
      const s = sheds[i * 5];
      if (!s) break;
      stacks.push({ x: s.x + 8, y: s.y, z: s.z + 8, sx: 3.2, sy: 42 + i * 6, sz: 3.2, c: "#c95b47" });
      stacks.push({ x: s.x + 8, y: s.y + 30 + i * 6, z: s.z + 8, sx: 3.4, sy: 3, sz: 3.4, c: "#f3efe6" });
    }
    inst(box, M({}), [...sheds, ...bands]);
    inst(cyl, M({}), [...tanks, ...stacks]);
  }
  // ------------------------------------------------------------- farms
  {
    const barns = [],
      roofs = [],
      silos = [],
      fields = [];
    for (const Z of ZONES.slice(2)) {
      // Crop fields: striped quads laid over the terrain.
      for (let i = 0; i < 9; i++) {
        const x = Z.x + (rnd() - 0.5) * Z.r * 1.6,
          z = Z.z + (rnd() - 0.5) * Z.r * 1.6;
        if (!clear(x, z, 70)) continue;
        fields.push({ x, z, w: 70 + rnd() * 60, d: 60 + rnd() * 50, yaw: rnd() * 0.5, k: i % 3 });
      }
      for (let i = 0; i < 3; i++) {
        const x = Z.x + (rnd() - 0.5) * Z.r,
          z = Z.z + (rnd() - 0.5) * Z.r;
        if (!clear(x, z, 40)) continue;
        const y = ground(x, z),
          yaw = rnd() * Math.PI;
        const b = { x, y, z, sx: 14, sy: 7, sz: 22, yaw, c: "#c8553f" };
        barns.push(b);
        roofs.push({ x, y: y + 7, z, sx: 15.5, sy: 5.5, sz: 23, yaw, c: "#5b4a42" });
        solid(b, 12);
        const sx = x + Math.cos(yaw) * 12,
          sz = z - Math.sin(yaw) * 12;
        silos.push({ x: sx, y: ground(sx, sz), z: sz, sx: 6, sy: 16, sz: 6, c: "#e9e4d8" });
        silos.push({ x: sx, y: ground(sx, sz) + 16, z: sz, sx: 6.2, sy: 2.4, sz: 6.2, c: "#a7b3b5" });
        solid({ x: sx, y: ground(sx, sz), z: sz, sx: 5, sy: 18, sz: 5 });
      }
    }
    inst(box, M({}), barns);
    inst(prism, M({}), roofs);
    inst(cyl, M({}), silos);
    const fmats = [stripeTex("#c9b25d", "#b19a49"), stripeTex("#8fae55", "#7a9a45"), stripeTex("#b5884f", "#9c7443")].map((t) => M({ map: t }));
    for (const f of fields) {
      const n = 10,
        g = new T.PlaneGeometry(f.w, f.d, n, n).rotateX(-Math.PI / 2).rotateY(f.yaw);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, ter.sample(f.x + p.getX(i), f.z + p.getZ(i)) + 0.12);
      g.translate(f.x, 0, f.z);
      g.computeVertexNormals();
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (f.w / 12), uv.getY(i) * 2);
      const m = new T.Mesh(g, fmats[f.k]);
      m.receiveShadow = true;
      group.add(m);
    }
  }
  // Mail drop boxes at the zone stops (deliveries pull up beside these).
  {
    const boxes = [],
      tops = [];
    for (const ac of hw.layout.access)
      for (const st of ac.stops) {
        const { x, z } = st.pos,
          y = ground(x, z) + 0.4;
        boxes.push({ x, y, z, sx: 0.9, sy: 1.25, sz: 0.75, yaw: st.yaw, c: "#2d4a8a" });
        tops.push({ x, y: y + 1.25, z, sx: 0.95, sy: 0.18, sz: 0.8, yaw: st.yaw, c: "#f2efe6" });
        world.wall(x, y + 0.7, z, 0.45, 0.7, 0.38, st.yaw);
      }
    inst(box, M({}), [...boxes, ...tops]);
  }
  return group;
}
