import * as T from "three";
import { RAPIER } from "../physics.js";
import { W0, LANE_W, LANES, EDGE_IN, EDGE_OUT, PAVE_OUT, MEDIAN, BRIDGE_Y, fbm } from "./layout.js";

// Builds the interstate scenery and its colliders.

const C = (h) => new T.Color(h);

// Geometry accumulator with vertex colours (one draw call per material).
class Geo {
  constructor(uv = false) {
    this.p = [];
    this.c = [];
    this.uv = uv ? [] : null;
  }
  quad(a, b, c, d, col, uvs) {
    // a b c d: counter-clockwise from above.
    this.p.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) this.c.push(col.r, col.g, col.b);
    if (this.uv) this.uv.push(...(uvs || [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]));
  }
  tri(a, b, c, col) {
    this.p.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.c.push(col.r, col.g, col.b);
    if (this.uv) this.uv.push(0, 0, 1, 0, 1, 1);
  }
  add(geo, col, m) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.applyMatrix4(m);
    const a = g.attributes.position.array;
    for (let i = 0; i < a.length; i++) this.p.push(a[i]);
    const vc = g.attributes.color;
    for (let i = 0; i < a.length / 3; i++) {
      if (vc) this.c.push(vc.getX(i), vc.getY(i), vc.getZ(i));
      else this.c.push(col.r, col.g, col.b);
    }
    if (this.uv) for (let i = 0; i < a.length / 3; i++) this.uv.push(0, 0);
    g.dispose();
  }
  geometry() {
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(this.p, 3));
    g.setAttribute("color", new T.Float32BufferAttribute(this.c, 3));
    if (this.uv) g.setAttribute("uv", new T.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    return g;
  }
}

const M4 = (x = 0, y = 0, z = 0, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) =>
  new T.Matrix4().compose(new T.Vector3(x, y, z), new T.Quaternion().setFromEuler(new T.Euler(rx, ry, rz, "YXZ")), new T.Vector3(sx, sy, sz));

function asphaltTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#4a4d50";
  g.fillRect(0, 0, 256, 256);
  const img = g.getImageData(0, 0, 256, 256),
    d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 26 + (Math.random() < 0.02 ? 18 : 0);
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // Wheel-path wear: two lighter bands.
  g.fillStyle = "rgba(255,255,255,0.035)";
  g.fillRect(40, 0, 40, 256);
  g.fillRect(176, 0, 40, 256);
  // A few tar-sealed cracks.
  g.strokeStyle = "rgba(20,20,22,0.35)";
  g.lineWidth = 1.2;
  for (let k = 0; k < 5; k++) {
    g.beginPath();
    let x = Math.random() * 256,
      y = Math.random() * 256;
    g.moveTo(x, y);
    for (let j = 0; j < 6; j++) g.lineTo((x += (Math.random() - 0.5) * 30), (y += Math.random() * 20));
    g.stroke();
  }
  const t = new T.CanvasTexture(c);
  t.wrapS = t.wrapT = T.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = T.SRGBColorSpace;
  return t;
}

// Tileable meadow texture: thousands of short blades over soil.
function grassTexture() {
  // Bright cartoon meadow: soft clover blobs and chunky blade ticks.
  const S = 512,
    c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  g.fillStyle = "#4fa636";
  g.fillRect(0, 0, S, S);
  const wrap = (fn) => {
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) fn(dx, dy);
  };
  for (let i = 0; i < 180; i++) {
    const x = Math.random() * S,
      y = Math.random() * S,
      r = 10 + Math.random() * 34,
      light = Math.random() < 0.5;
    g.fillStyle = light ? `rgba(120,200,80,${0.18 + Math.random() * 0.12})` : `rgba(64,128,52,${0.12 + Math.random() * 0.1})`;
    wrap((dx, dy) => {
      g.beginPath();
      g.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      g.fill();
    });
  }
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * S,
      y = Math.random() * S,
      l = 4 + Math.random() * 6,
      a = -Math.PI / 2 + (Math.random() - 0.5) * 0.7,
      t = Math.random();
    g.strokeStyle = t < 0.55 ? `hsl(${96 + Math.random() * 10},${48 + Math.random() * 12}%,${34 + Math.random() * 8}%)` : `hsl(${98 + Math.random() * 10},${55 + Math.random() * 10}%,${46 + Math.random() * 8}%)`;
    g.lineWidth = 1.6 + Math.random() * 1.2;
    g.lineCap = "round";
    wrap((dx, dy) => {
      if (x + dx < -12 || x + dx > S + 12 || y + dy < -12 || y + dy > S + 12) return;
      g.beginPath();
      g.moveTo(x + dx, y + dy);
      g.lineTo(x + dx + Math.cos(a) * l, y + dy + Math.sin(a) * l);
      g.stroke();
    });
  }
  for (let i = 0; i < 90; i++) {
    g.fillStyle = ["#ffffff", "#ffe066", "#ffb3d1"][i % 3];
    const x = Math.random() * S,
      y = Math.random() * S;
    g.beginPath();
    g.arc(x, y, 1.8, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new T.CanvasTexture(c);
  tex.wrapS = tex.wrapT = T.RepeatWrapping;
  tex.anisotropy = 16;
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}
function concreteTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#b9b8b1";
  g.fillRect(0, 0, 256, 256);
  const img = g.getImageData(0, 0, 256, 256),
    d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // Transverse joints every slab, tyre polish in the wheel paths.
  g.fillStyle = "rgba(60,60,60,0.55)";
  g.fillRect(0, 0, 256, 2);
  g.fillRect(0, 128, 256, 2);
  g.fillStyle = "rgba(40,40,40,0.06)";
  g.fillRect(40, 0, 44, 256);
  g.fillRect(172, 0, 44, 256);
  const t = new T.CanvasTexture(c);
  t.wrapS = t.wrapT = T.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = T.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- signs
function signTexture(draw, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  draw(g, w, h);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const GREEN = "#1f6a45",
  FONT = (px, w = 600) => `${w} ${px}px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`;
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function shield(g, cx, cy, s, num) {
  g.save();
  g.translate(cx, cy);
  g.scale(s, s);
  g.beginPath();
  g.moveTo(-50, -46);
  g.quadraticCurveTo(0, -60, 50, -46);
  g.lineTo(50, 0);
  g.quadraticCurveTo(46, 40, 0, 58);
  g.quadraticCurveTo(-46, 40, -50, 0);
  g.closePath();
  g.fillStyle = "#fff";
  g.fill();
  g.save();
  g.clip();
  g.fillStyle = "#1d4fa0";
  g.fillRect(-60, -30, 120, 100);
  g.fillStyle = "#c8262c";
  g.fillRect(-60, -70, 120, 40);
  g.restore();
  g.lineWidth = 5;
  g.strokeStyle = "#fff";
  g.stroke();
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.font = FONT(54, 700);
  g.fillText(String(num), 0, 30);
  g.font = FONT(15, 700);
  g.fillText("INTERSTATE", 0, -38);
  g.restore();
}
function exitSign({ exit, lines, sub, arrow = "", shieldNum = null }) {
  const w = 1024,
    h = 512;
  return signTexture((g) => {
    g.fillStyle = GREEN;
    roundRect(g, 0, 0, w, h, 34);
    g.fill();
    g.lineWidth = 10;
    g.strokeStyle = "#f4f4ef";
    roundRect(g, 14, 14, w - 28, h - 28, 26);
    g.stroke();
    g.fillStyle = "#f4f4ef";
    g.textAlign = "center";
    if (exit) {
      // Exit tab across the top.
      g.font = FONT(48, 700);
      g.fillText("EXIT " + exit, w / 2, 78);
      g.fillRect(60, 100, w - 120, 4);
    }
    if (shieldNum) shield(g, 150, 250, 1.35, shieldNum);
    lines.forEach((l, i) => {
      let px = 96;
      g.font = FONT(px, 600);
      const room = shieldNum ? w - 360 : w - 120;
      while (g.measureText(l).width > room && px > 50) g.font = FONT((px -= 4), 600);
      g.fillText(l, shieldNum ? w / 2 + 80 : w / 2, 210 + i * 104);
    });
    if (sub) {
      g.font = FONT(56, 600);
      g.fillText(sub, w / 2, h - 50);
    }
    if (arrow) {
      g.save();
      g.translate(arrow === "right" ? w - 120 : arrow === "left" ? 120 : w / 2, h - 110);
      g.rotate(arrow === "right" ? -Math.PI / 4 : arrow === "left" ? Math.PI / 4 : 0);
      g.beginPath();
      g.moveTo(0, -60);
      g.lineTo(34, -18);
      g.lineTo(12, -18);
      g.lineTo(12, 50);
      g.lineTo(-12, 50);
      g.lineTo(-12, -18);
      g.lineTo(-34, -18);
      g.closePath();
      g.fill();
      g.restore();
    }
  }, w, h);
}
function speedSign(limit) {
  return signTexture((g, w, h) => {
    g.fillStyle = "#f6f6f2";
    roundRect(g, 0, 0, w, h, 18);
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = "#111";
    roundRect(g, 12, 12, w - 24, h - 24, 12);
    g.stroke();
    g.fillStyle = "#111";
    g.textAlign = "center";
    g.font = FONT(56, 700);
    g.fillText("SPEED", w / 2, 92);
    g.fillText("LIMIT", w / 2, 152);
    g.font = FONT(170, 700);
    g.fillText(String(limit), w / 2, 330);
  }, 256, 360);
}
function mileSign(n) {
  return signTexture((g, w, h) => {
    g.fillStyle = GREEN;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "#fff";
    g.lineWidth = 5;
    g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.font = FONT(34, 700);
    g.fillText("MILE", w / 2, 50);
    g.font = FONT(78, 700);
    g.fillText(String(n), w / 2, 140);
  }, 128, 180);
}

export class HighwayWorld {
  constructor(scene, physics, toon, layout, terrain) {
    this.scene = scene;
    this.physics = physics;
    this.toon = toon;
    this.layout = layout;
    this.terrain = terrain;
    this.group = new T.Group();
    this.group.name = "Interstate";
    this.disposables = [];
    this.colliders = [];
    this.vc = this.mat({ vertexColors: true });
    this.vcDouble = this.mat({ vertexColors: true, side: T.DoubleSide });
  }
  mat(o) {
    const m = this.toon(new T.MeshToonMaterial(o));
    this.disposables.push(m);
    return m;
  }
  mesh(geo, mat, name, shadow = true) {
    const m = new T.Mesh(geo, mat);
    m.name = name;
    m.castShadow = shadow;
    m.receiveShadow = true;
    this.group.add(m);
    this.disposables.push(geo);
    return m;
  }
  wall(x, y, z, hx, hy, hz, yaw) {
    const c = this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(x, y, z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setFriction(0.3)
        .setRestitution(0.1),
    );
    this.colliders.push(c);
  }
  trimesh(geo) {
    const p = geo.attributes.position.array,
      idx = new Uint32Array(p.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    const c = this.physics.world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(p), idx).setFriction(0.95));
    this.colliders.push(c);
  }
  build() {
    const grass = grassTexture();
    const t = this.terrain;
    grass.repeat.set(t.SIZE_X / 9, t.SIZE_Z / 9);
    this.grassMat = this.toon(new T.MeshToonMaterial({ map: grass, vertexColors: true, color: "#e4dcb8" }));
    this.disposables.push(grass, this.grassMat);
    this.sky();
    this.mountains();
    this.ground();
    this.roads();
    this.barriers();
    this.signs();
    this.scene.add(this.group);
  }
  // ---------------------------------------------------------------- sky
  sky() {
    const sun = new T.Vector3(-0.45, 0.62, 0.38).normalize();
    this.sunDir = sun;
    const mat = new T.ShaderMaterial({
      uniforms: { uSun: { value: sun }, uTime: (this.skyTime = { value: 0 }) },
      side: T.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader:
        "varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w * 0.99995; }",
      fragmentShader: `uniform vec3 uSun; uniform float uTime; varying vec3 vDir;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
        float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<5;i++){ s+=a*n(p); p*=2.07; a*=.5; } return s; }
        void main(){
          vec3 d = normalize(vDir);
          float y = clamp(d.y, -0.2, 1.0);
          vec3 horizon = vec3(0.97, 0.86, 0.72), zenith = vec3(0.38, 0.60, 0.86);
          vec3 col = mix(horizon, zenith, pow(smoothstep(0.0, 0.85, y), 0.65));
          col = mix(col, vec3(0.86, 0.8, 0.7), smoothstep(0.02, -0.12, y));
          float s = max(dot(d, uSun), 0.0);
          col += vec3(1.0, 0.86, 0.62) * (pow(s, 8.0) * 0.18 + pow(s, 120.0) * 0.6) + vec3(1.4,1.3,1.1) * smoothstep(0.9993, 0.9997, s) * 4.0;
          // Clouds: fair-weather cumulus on a dome.
          if (y > 0.015) {
            vec2 uv = d.xz / (y + 0.12) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
            float c = fbm(uv * 1.3);
            c = smoothstep(0.52, 0.78, c + fbm(uv * 4.1) * 0.12);
            float lit = 0.88 + 0.12 * fbm(uv * 2.3 + 3.0);
            vec3 cc = mix(vec3(0.72, 0.76, 0.82), vec3(1.0), lit) + vec3(1.0, 0.9, 0.7) * pow(s, 6.0) * 0.25;
            col = mix(col, cc, c * smoothstep(0.015, 0.2, y) * 0.92);
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.disposables.push(mat);
    const dome = new T.Mesh(new T.SphereGeometry(9000, 48, 24), mat);
    dome.frustumCulled = false;
    dome.renderOrder = -2;
    dome.name = "Interstate sky";
    this.skyDome = dome;
    this.group.add(dome);
  }
  mountains() {
    // A ring of ridgelines far away, hazed toward the sky colour.
    const g = new Geo();
    const R0 = 7600,
      seg = 220;
    const near = C("#7d9a92"),
      far = C("#9db4be"),
      snow = C("#e8eef0");
    for (let ring = 0; ring < 2; ring++) {
      const R = R0 + ring * 1300,
        base = ring ? far : near;
      const pts = [];
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const ridge = fbm(Math.cos(a) * 6 + ring * 9, Math.sin(a) * 6) * 1.3;
        const hgt = (ring ? 900 : 620) * Math.pow(Math.max(0, ridge - 0.35), 1.4) + 120 + fbm(a * 20, ring) * 80;
        pts.push([W0.x + Math.cos(a) * R, hgt, W0.z + Math.sin(a) * R * 0.75]);
      }
      for (let i = 0; i < seg; i++) {
        const a = pts[i],
          b = pts[i + 1];
        const fa = [a[0] * 1, -50, a[2]],
          fb = [b[0], -50, b[2]];
        const col = base.clone().offsetHSL(0, 0, (fbm(i * 0.3, ring) - 0.5) * 0.06);
        g.quad(fa, fb, b, a, col);
        if (a[1] > (ring ? 760 : 560)) g.tri([a[0], a[1] - 60, a[2]], [b[0], Math.max(b[1] - 60, a[1] - 60), b[2]], a, snow);
      }
    }
    const m = new T.MeshBasicMaterial({ vertexColors: true, fog: false, side: T.DoubleSide });
    this.disposables.push(m);
    const mesh = this.mesh(g.geometry(), m, "Mountains", false);
    mesh.receiveShadow = false;
    mesh.renderOrder = -1;
  }
  // -------------------------------------------------------------- ground
  ground() {
    const t = this.terrain;
    const geo = new T.PlaneGeometry(t.SIZE_X, t.SIZE_Z, t.nx, t.nz);
    geo.rotateX(-Math.PI / 2);
    geo.translate(t.X0 + t.SIZE_X / 2, 0, t.Z0 + t.SIZE_Z / 2);
    const p = geo.attributes.position,
      col = new Float32Array(p.count * 3);
    const mown = C("#ffffff"),
      field = C("#f2f7e6"),
      wild = C("#d9ebc4"),
      dry = C("#fff3c4"),
      dirt = C("#e8d6b0"),
      cc = new T.Color();
    for (let i = 0; i < p.count; i++) {
      const h = t.heights[i];
      p.setY(i, h);
      const x = p.getX(i),
        z = p.getZ(i),
        d = t.dist[i];
      const n = fbm(x / 60, z / 60),
        n2 = fbm(x / 13 + 4, z / 13);
      cc.copy(d < 50 ? mown : field).lerp(wild, Math.min(1, Math.max(0, (d - 60) / 200)) * 0.7);
      cc.lerp(dry, Math.max(0, n - 0.55) * 1.4);
      cc.multiplyScalar(0.86 + n2 * 0.26);
      // Mown stripes along the verge.
      if (d < 40) cc.multiplyScalar(0.96 + 0.05 * Math.sin((x + z) * 0.35));
      if (h > 60) cc.lerp(dirt, Math.min(0.4, (h - 60) / 200));
      // Farm fields: striped crops in flat patches away from the road.
      const farm = fbm(x / 420 + 31, z / 420 - 7);
      if (d > 120 && h < 12 && farm > 0.62) {
        const rows = Math.sin((x * 0.7 + z * 0.3) * 0.9) > 0 ? 1 : 0;
        const crop = farm > 0.7 ? C("#fff0b0") : C("#e6f5c6");
        cc.lerp(crop, 0.55).multiplyScalar(rows ? 1 : 0.9);
      }
      cc.toArray(col, i * 3);
    }
    geo.setAttribute("color", new T.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const m = this.mesh(geo, this.grassMat, "Terrain", false);
    m.receiveShadow = true;
    // Heightfield collider (column-major, rows along z).
    const H = t.H,
      W = t.W,
      hf = new Float32Array(W * H);
    for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) hf[i * H + j] = t.heights[j * W + i];
    const c = this.physics.world.createCollider(
      RAPIER.ColliderDesc.heightfield(t.nz, t.nx, hf, { x: t.SIZE_X, y: 1, z: t.SIZE_Z })
        .setTranslation(t.X0 + t.SIZE_X / 2, 0, t.Z0 + t.SIZE_Z / 2)
        .setFriction(0.9),
    );
    this.colliders.push(c);
  }
  // ------------------------------------------------------------ pavement
  // Ribbon along a path between two offsets.
  ribbon(geo, path, off0, off1, y, s0, s1, step, col, uvScale = null, dash = 0, gap = 0) {
    const a = {},
      b = {};
    for (let s = s0; s < s1 - 1e-6; s += step) {
      if (dash && (s - s0) % (dash + gap) >= dash) continue;
      const e = Math.min(s1, s + step);
      path.at(s, a);
      const ya = a.y + y;
      const A0 = [a.x + a.nx * off0, ya, a.z + a.nz * off0],
        A1 = [a.x + a.nx * off1, ya, a.z + a.nz * off1];
      path.at(e, b);
      const yb = b.y + y;
      const B0 = [b.x + b.nx * off0, yb, b.z + b.nz * off0],
        B1 = [b.x + b.nx * off1, yb, b.z + b.nz * off1];
      let uvs = null;
      if (uvScale) {
        const u0 = 0,
          u1 = Math.abs(off1 - off0) / uvScale[0],
          v0 = s / uvScale[1],
          v1 = e / uvScale[1];
        uvs = [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1];
      }
      // Winding so the face points up whichever way the offsets run.
      if (off1 > off0) geo.quad(A0, A1, B1, B0, col, uvs);
      else geo.quad(A1, A0, B0, B1, col, uvs);
    }
  }
  roads() {
    const { main, interchanges } = this.layout;
    const tex = asphaltTexture();
    this.disposables.push(tex);
    const asphalt = this.mat({ map: tex, vertexColors: true });
    const pave = new Geo(true),
      paveC = new Geo(true),
      marks = new Geo(),
      phys = new Geo();
    this.slopes = new Geo(true);
    const ctex = concreteTexture();
    this.disposables.push(ctex);
    const concreteMat = this.mat({ map: ctex, vertexColors: true });
    const L = main.length;
    const road = C("#ffffff"),
      shoulder = C("#c9cbc6"),
      white = C("#eeeee6"),
      yellow = C("#e7bd3b");
    // Carriageways: both sides of the centreline.
    for (const side of [1, -1]) {
      const o = (v) => v * side;
      // Alternate asphalt and jointed concrete stretches.
      for (let s0 = 0; s0 < L; s0 += 600) {
        const concrete = fbm(s0 / 2400 + (side > 0 ? 0 : 5), 3.3) > 0.55;
        this.ribbon(concrete ? paveC : pave, main, o(EDGE_IN), o(EDGE_OUT), 0.12, s0, Math.min(L, s0 + 600), 4, road, [LANE_W, 9]);
      }
      // Rumble strips in both shoulders.
      this.ribbon(marks, main, o(EDGE_OUT + 0.35), o(EDGE_OUT + 0.75), 0.115, 0, L, 0.5, C("#6c6e6c"), null, 0.25, 0.35);
      this.ribbon(marks, main, o(EDGE_IN - 0.75), o(EDGE_IN - 0.35), 0.115, 0, L, 0.5, C("#6c6e6c"), null, 0.25, 0.35);
      this.ribbon(pave, main, o(MEDIAN), o(EDGE_IN), 0.11, 0, L, 4, shoulder, [LANE_W, 9]);
      this.ribbon(pave, main, o(EDGE_OUT), o(PAVE_OUT), 0.11, 0, L, 4, shoulder, [LANE_W, 9]);
      // Gravel edge sloping into the grass.
      this.ribbon(pave, main, o(PAVE_OUT), o(PAVE_OUT + 1.2), 0.05, 0, L, 4, C("#d8d1bd"), [LANE_W, 9]);
      // Paint: yellow on the median side, white on the outside, dashed lane lines.
      this.ribbon(marks, main, o(EDGE_IN + 0.05), o(EDGE_IN + 0.2), 0.13, 0, L, 4, yellow);
      this.ribbon(marks, main, o(EDGE_OUT - 0.2), o(EDGE_OUT - 0.05), 0.13, 0, L, 4, white);
      for (let l = 1; l < LANES; l++) {
        const off = EDGE_IN + l * LANE_W;
        this.ribbon(marks, main, o(off - 0.07), o(off + 0.07), 0.13, 0, L, 3, white, null, 3, 9);
      }
    }
    // Ramps and crossroads.
    for (const ic of interchanges) {
      for (const r of ic.ramps) {
        const p = r.path,
          len = p.length;
        this.ribbon(pave, p, -3.2, 3.2, 0.13, 0, len, 2, road, [LANE_W, 9]);
        this.ribbon(pave, p, -4.6, -3.2, 0.12, 0, len, 2, shoulder, [LANE_W, 9]);
        this.ribbon(pave, p, 3.2, 4.6, 0.12, 0, len, 2, shoulder, [LANE_W, 9]);
        this.ribbon(marks, p, 3.0, 3.15, 0.14, 0, len, 2, white);
        this.ribbon(marks, p, -3.15, -3.0, 0.14, 0, len, 2, yellow);
        this.ribbon(phys, p, -4.8, 4.8, 0.12, 0, len, 2, road);
        this.embank(pave, phys, p, 4.6, len);
      }
      const x = ic.cross,
        len = x.length;
      this.ribbon(pave, x, -7.4, 7.4, 0.14, 0, len, 2, road, [LANE_W, 9]);
      this.ribbon(pave, x, -8.6, -7.4, 0.13, 0, len, 2, shoulder, [LANE_W, 9]);
      this.ribbon(pave, x, 7.4, 8.6, 0.13, 0, len, 2, shoulder, [LANE_W, 9]);
      this.ribbon(marks, x, -0.25, -0.1, 0.15, 0, len, 2, yellow);
      this.ribbon(marks, x, 0.1, 0.25, 0.15, 0, len, 2, yellow);
      this.ribbon(marks, x, 3.65, 3.75, 0.15, 0, len, 3, white, null, 3, 9);
      this.ribbon(marks, x, -3.75, -3.65, 0.15, 0, len, 3, white, null, 3, 9);
      this.ribbon(marks, x, 7.2, 7.35, 0.15, 0, len, 2, white);
      this.ribbon(marks, x, -7.35, -7.2, 0.15, 0, len, 2, white);
      this.ribbon(phys, x, -8.8, 8.8, 0.13, 0, len, 2, road);
      this.embank(pave, phys, x, 8.6, len, 740 - 46, 740 + 46);
      this.bridge(ic);
      // Town ring roads (two lanes, kerb lines, dashed centre).
      for (const lp of ic.loops) {
        const L = lp.length;
        this.ribbon(pave, lp, -4.4, 4.4, 0.05, 0, L, 2, road, [LANE_W, 9]);
        this.ribbon(pave, lp, -5.4, -4.4, 0.04, 0, L, 2, shoulder, [LANE_W, 9]);
        this.ribbon(pave, lp, 4.4, 5.4, 0.04, 0, L, 2, shoulder, [LANE_W, 9]);
        this.ribbon(marks, lp, -0.09, 0.09, 0.07, 4, L - 4, 3, yellow, null, 3, 6);
        this.ribbon(marks, lp, 4.0, 4.15, 0.07, 0, L, 2, white);
        this.ribbon(marks, lp, -4.15, -4.0, 0.07, 0, L, 2, white);
      }
    }
    // Zone access roads and rings.
    for (const ac of this.layout.access) {
      for (const lp of [ac.road, ac.ring]) {
        const L = lp.length;
        this.ribbon(pave, lp, -4.6, 4.6, 0.06, 0, L, 2, road, [LANE_W, 9]);
        this.ribbon(pave, lp, -5.6, -4.6, 0.05, 0, L, 2, shoulder, [LANE_W, 9]);
        this.ribbon(pave, lp, 4.6, 5.6, 0.05, 0, L, 2, shoulder, [LANE_W, 9]);
        this.ribbon(marks, lp, -0.09, 0.09, 0.08, lp === ac.road ? 34 : 0, L, 3, yellow, null, 3, 6);
        this.ribbon(marks, lp, 4.2, 4.35, 0.08, lp === ac.road ? 30 : 0, L, 2, white);
        this.ribbon(marks, lp, -4.35, -4.2, 0.08, lp === ac.road ? 30 : 0, L, 2, white);
      }
      // Median crossover pad.
      this.ribbon(pave, this.layout.main, -11.6 , 11.6, 0.125, ac.s - 13, ac.s + 13, 2, shoulder, [LANE_W, 9]);
    }
    const pm = this.mesh(pave.geometry(), asphalt, "Pavement", false);
    pm.receiveShadow = true;
    this.mesh(paveC.geometry(), concreteMat, "Concrete pavement", false).receiveShadow = true;
    this.mesh(this.slopes.geometry(), this.grassMat, "Embankments", false).receiveShadow = true;
    const markMat = this.mat({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.mesh(marks.geometry(), markMat, "Road paint", false);
    this.trimesh(phys.geometry());
  }
  // Grassy embankment sides under an elevated road (skips a span for the bridge opening).
  embank(geo, phys, path, hw, len, skip0 = -1, skip1 = -1) {
    geo = this.slopes;
    const t = this.terrain,
      uv = (p) => [(p[0] - t.X0) / 9, (t.Z0 + t.SIZE_Z - p[2]) / 9];
    const a = {},
      b = {},
      grass = C("#ffffff"),
      step = 4;
    for (let s = 0; s < len - 1e-6; s += step) {
      const e = Math.min(len, s + step);
      if (s + step > skip0 && s < skip1) continue;
      path.at(s, a);
      path.at(e, b);
      if (a.y < 0.25 && b.y < 0.25) continue;
      for (const sd of [-1, 1]) {
        const ra = a.y / 0.45 + 0.5,
          rb = b.y / 0.45 + 0.5; // ~1:2.2 slope
        const A0 = [a.x + a.nx * hw * sd, a.y + 0.1, a.z + a.nz * hw * sd],
          A1 = [a.x + a.nx * (hw + ra) * sd, -0.2, a.z + a.nz * (hw + ra) * sd],
          B0 = [b.x + b.nx * hw * sd, b.y + 0.1, b.z + b.nz * hw * sd],
          B1 = [b.x + b.nx * (hw + rb) * sd, -0.2, b.z + b.nz * (hw + rb) * sd];
        const q = sd > 0 ? [A0, A1, B1, B0] : [A1, A0, B0, B1];
        const u = q.map(uv);
        geo.quad(...q, grass, [...u[0], ...u[1], ...u[2], ...u[0], ...u[2], ...u[3]]);
        phys.quad(A0, A1, B1, B0, grass);
      }
    }
  }
  bridge(ic) {
    const g = new Geo(),
      concrete = C("#b9b8b0"),
      dark = C("#8f8e88"),
      x = ic.cross,
      c = ic.c;
    // Deck underside, parapets with colliders, piers, abutments.
    const sMid = 740;
    const a = {};
    for (let s = sMid - 46; s < sMid + 46; s += 4) {
      const e = s + 4;
      for (const sd of [-1, 1]) {
        x.at(s, a);
        const p0 = [a.x + a.nx * 9.2 * sd, a.y, a.z + a.nz * 9.2 * sd];
        const b = x.at(e);
        const p1 = [b.x + b.nx * 9.2 * sd, b.y, b.z + b.nz * 9.2 * sd];
        // Parapet (box) 0.4 x 1.05
        const mid = [(p0[0] + p1[0]) / 2, a.y + 0.55, (p0[2] + p1[2]) / 2];
        g.add(new T.BoxGeometry(4.05, 1.05, 0.4), concrete, M4(mid[0], mid[1], mid[2], -Math.atan2(b.z - a.z, b.x - a.x)));
        this.wall(mid[0], mid[1], mid[2], 2.02, 0.55, 0.22, -Math.atan2(b.z - a.z, b.x - a.x));
      }
    }
    // Deck slab and girders.
    const p0 = x.at(sMid);
    const yaw = -Math.atan2(p0.tz, p0.tx);
    g.add(new T.BoxGeometry(92, 1.1, 19), concrete, M4(p0.x, BRIDGE_Y - 0.45, p0.z, yaw));
    for (const k of [-6, -2, 2, 6]) {
      const q = [p0.x + p0.nx * k, p0.z + p0.nz * k];
      g.add(new T.BoxGeometry(92, 1.2, 0.8), dark, M4(q[0], BRIDGE_Y - 1.5, q[1], yaw));
    }
    // Piers: in the median and just beyond each shoulder.
    for (const off of [0, PAVE_OUT + 5, -(PAVE_OUT + 5)]) {
      const q = { x: c.x + c.tx * 0 + c.nx * off, z: c.z + c.nz * off };
      for (const k of [-6, 0, 6]) {
        const px = q.x + p0.nx * k * 0 + c.tx * k,
          pz = q.z + c.tz * k;
        g.add(new T.CylinderGeometry(0.55, 0.65, BRIDGE_Y - 2.1, 12), concrete, M4(px, (BRIDGE_Y - 2.1) / 2, pz));
        this.wall(px, 3, pz, 0.6, 3, 0.6, 0);
      }
      g.add(new T.BoxGeometry(1.4, 1.0, 15), concrete, M4(q.x, BRIDGE_Y - 2.4, q.z, -Math.atan2(c.tz, c.tx) + Math.PI / 2));
    }
    // Abutment walls where the embankment meets the span.
    for (const sd of [-1, 1]) {
      const pa = x.at(sMid + sd * 46);
      g.add(new T.BoxGeometry(1.2, BRIDGE_Y, 19.5), dark, M4(pa.x, BRIDGE_Y / 2 - 0.4, pa.z, yaw));
    }
    this.mesh(g.geometry(), this.vc, "Overpass " + ic.exit);
  }
  // ------------------------------------------------------- barriers, poles
  barriers() {
    const { main, interchanges } = this.layout;
    const posts = [],
      railGeo = new Geo(),
      steel = C("#b8bdbf"),
      L = main.length;
    // Gaps for ramp gores on each side.
    const gaps = { 1: [], [-1]: [] };
    for (const ic of interchanges) {
      gaps[1].push([ic.sc - 600, ic.sc + 600]);
      gaps[-1].push([ic.sc - 600, ic.sc + 600]);
    }
    for (const ac of this.layout.access) gaps[ac.sd].push([ac.s - 16, ac.s + 16]);
    const med = this.layout.access.map((ac) => ac.s);
    const inMed = (s) => med.some((m) => Math.abs(((s - m + L / 2) % L + L) % L - L / 2) < 16);
    const inGap = (sd, s) => gaps[sd].some(([a, b]) => {
      const d = ((s - a) % L + L) % L;
      return d < b - a;
    });
    const a = {},
      b = {};
    const STEP = 4;
    for (const sd of [1, -1]) {
      const off = (PAVE_OUT + 0.9) * sd;
      for (let s = 0; s < L; s += STEP) {
        if (inGap(sd, s)) continue;
        main.point(s, off, a);
        main.point(s + STEP, off, b);
        posts.push([a.x, a.z]);
        // W-beam: a vertical strip with a fold.
        for (const [y0, y1] of [[0.55, 0.68], [0.68, 0.8]]) {
          railGeo.quad([a.x, y0, a.z], [b.x, y0, b.z], [b.x, y1, b.z], [a.x, y1, a.z], steel);
        }
        if (s % 20 === 0 && !inGap(sd, s + 10) && !inGap(sd, s + 20)) {
          main.point(s + 10, off, b);
          const yaw = -Math.atan2(b.z - a.z, b.x - a.x) * 0;
          const p = main.at(s + 10);
          this.wall(b.x, 0.6, b.z, 10, 0.5, 0.15, -Math.atan2(p.tz, p.tx));
        }
      }
    }
    // Median cable barrier: posts and three cables.
    const cable = new Geo(),
      cableCol = C("#9aa0a2");
    for (let s = 0; s < L; s += 6) {
      if (inMed(s) || inMed(s + 6) || (s % 24 === 0 && (inMed(s + 12) || inMed(s + 18) || inMed(s + 24)))) continue;
      main.point(s, 0, a);
      main.point(s + 6, 0, b);
      posts.push([a.x, a.z, 1]);
      for (const y of [0.5, 0.7, 0.9]) cable.quad([a.x, y, a.z], [b.x, y, b.z], [b.x, y + 0.025, b.z], [a.x, y + 0.025, a.z], cableCol);
      if (s % 24 === 0) {
        const p = main.at(s + 12);
        this.wall(p.x, 0.6, p.z, 12, 0.6, 0.12, -Math.atan2(p.tz, p.tx));
      }
    }
    const railMat = this.mat({ vertexColors: true, side: T.DoubleSide });
    this.mesh(railGeo.geometry(), railMat, "Guardrail", false);
    this.mesh(cable.geometry(), railMat, "Cable barrier", false);
    // Posts as one instanced mesh.
    const pg = new T.BoxGeometry(0.12, 0.85, 0.16);
    pg.translate(0, 0.42, 0);
    const pi = new T.InstancedMesh(pg, this.mat({ color: 0x8e9497 }), posts.length);
    const m = new T.Matrix4();
    posts.forEach(([x, z], i) => pi.setMatrixAt(i, m.makeTranslation(x, 0, z)));
    pi.castShadow = true;
    this.group.add(pi);
    this.disposables.push(pg);
    // Light poles: twin-arm poles in the median, single poles along every ramp.
    const poles = new Geo(),
      grey = C("#9aa1a3"),
      lamp = C("#eef0ee");
    const arm = (x, z, ax, az, h) => {
      poles.add(new T.BoxGeometry(2.4, 0.12, 0.12), grey, M4(x + ax * 1.15, h, z + az * 1.15, -Math.atan2(az, ax)));
      poles.add(new T.BoxGeometry(0.75, 0.16, 0.36), lamp, M4(x + ax * 2.35, h - 0.1, z + az * 2.35, -Math.atan2(az, ax)));
    };
    for (const ic of interchanges) {
      for (let ds = -700; ds <= 700; ds += 55) {
        const p = main.point(ic.sc + ds, 0.0);
        if (Math.abs(ds) < 60) continue;
        poles.add(new T.CylinderGeometry(0.12, 0.18, 13, 8), grey, M4(p.x, 6.5, p.z));
        for (const sd of [1, -1]) arm(p.x, p.z, p.nx * sd, p.nz * sd, 12.9);
        this.wall(p.x, 2, p.z, 0.22, 2, 0.22, 0);
      }
      for (const r of ic.ramps)
        for (let s = 30; s < r.path.length - 20; s += 50) {
          const p = r.path.point(s, 6.6);
          poles.add(new T.CylinderGeometry(0.1, 0.16, 11, 8), grey, M4(p.x, p.y + 5.5, p.z));
          arm(p.x, p.z, -p.nx, -p.nz, p.y + 10.9);
        }
    }
    this.mesh(poles.geometry(), this.vc, "Light poles");
  }
  // --------------------------------------------------------------- signs
  signs() {
    const { main, interchanges } = this.layout;
    const L = main.length;
    const steel = C("#a5abad");
    const frame = new Geo();
    const panels = [];
    const panel = (tex, w, h, x, y, z, yaw) => {
      const m = (this.signMats ||= new Map()).get(tex) || new T.MeshBasicMaterial({ map: tex, fog: true });
      this.signMats.set(tex, m);
      this.disposables.push(m, tex);
      const mesh = new T.Mesh(new T.PlaneGeometry(w, h), m);
      mesh.position.set(x, y, z);
      mesh.rotation.y = yaw;
      this.group.add(mesh);
      panels.push(mesh);
      // Backing plate.
      frame.add(new T.BoxGeometry(w + 0.1, h + 0.1, 0.08), steel, M4(x, y, z, yaw).multiply(M4(0, 0, -0.06)));
    };
    // A sign faces traffic travelling in `dir` at arc length s.
    const facing = (s, dir) => {
      const p = main.at(s);
      return Math.atan2(-p.tx * dir, -p.tz * dir);
    };
    for (const ic of interchanges) {
      for (const dir of [1, -1]) {
        const side = dir;
        // Overhead gantries at 1 mile and 1/2 mile, a gore sign at the split.
        for (const [dist, sub] of [[1600, "1 MILE"], [800, "1/2 MILE"]]) {
          const s = ic.sc - dir * (dist + 560);
          const yaw = facing(s, dir);
          const a = main.point(s, (MEDIAN - 0.6) * side),
            b = main.point(s, (PAVE_OUT + 1.6) * side);
          // Truss.
          for (const q of [a, b]) {
            frame.add(new T.CylinderGeometry(0.22, 0.26, 7.4, 10), steel, M4(q.x, 3.7, q.z));
            this.wall(q.x, 3.5, q.z, 0.3, 3.5, 0.3, 0);
          }
          const mx = (a.x + b.x) / 2,
            mz = (a.z + b.z) / 2,
            span = Math.hypot(b.x - a.x, b.z - a.z);
          frame.add(new T.BoxGeometry(span, 0.25, 0.25), steel, M4(mx, 7.25, mz, -Math.atan2(b.z - a.z, b.x - a.x)));
          frame.add(new T.BoxGeometry(span, 0.25, 0.25), steel, M4(mx, 4.95, mz, -Math.atan2(b.z - a.z, b.x - a.x)));
          // Diagonal lacing between the chords.
          for (let k = 0; k < span - 1; k += 1.6) {
            const u = k / span,
              px = a.x + (b.x - a.x) * u,
              pz = a.z + (b.z - a.z) * u;
            frame.add(new T.BoxGeometry(0.08, 2.5, 0.08), steel, M4(px, 6.1, pz, -Math.atan2(b.z - a.z, b.x - a.x), 1, 1, 1, 0, (k / 1.6) % 2 ? 0.6 : -0.6));
          }
          // Panels hang just in front of the truss, facing traffic.
          const t0 = main.at(s),
            fx = -t0.tx * dir * 0.45,
            fz = -t0.tz * dir * 0.45;
          const ss = main.point(s, (EDGE_OUT - 2.4) * side);
          panel(exitSign({ exit: ic.exit, lines: ic.names, sub }), 5.4, 2.7, ss.x + fx, 6.1, ss.z + fz, yaw);
          const s2 = main.point(s, (EDGE_IN + 2.7) * side);
          panel(exitSign({ lines: [dir > 0 ? "East" : "West", "Savannah"], shieldNum: 16, arrow: "down" }), 5.4, 2.7, s2.x + fx, 6.1, s2.z + fz, yaw);
        }
        // Gore sign at the exit split.
        const sg = ic.sc - dir * 400;
        const g = main.point(sg, (PAVE_OUT + 4) * side);
        frame.add(new T.CylinderGeometry(0.1, 0.1, 4.2, 8), steel, M4(g.x - 0.8, 2.1, g.z));
        frame.add(new T.CylinderGeometry(0.1, 0.1, 4.2, 8), steel, M4(g.x + 0.8, 2.1, g.z));
        panel(exitSign({ exit: ic.exit, lines: [ic.names[1]], arrow: "right" }), 3.8, 1.9, g.x, 3.4, g.z, facing(sg, dir));
      }
      // Crossroad sign at each ramp terminal.
      const c = ic.cross.at(740 - 80);
      panel(exitSign({ lines: [ic.town, "Next right"], sub: "Mail route" }), 4.6, 2.3, c.x + c.nx * 11, 3.6, c.z + c.nz * 11, Math.atan2(c.tx, c.tz));
    }
    // Speed limits every ~2.5 km, mile markers every mile, both directions.
    for (const dir of [1, -1])
      for (let s = 300, k = 0; s < L; s += 1609, k++) {
        const near = interchanges.some((ic) => Math.abs(((s - ic.sc + L / 2) % L) - L / 2) < 700);
        const p = main.point(s, (PAVE_OUT + 2.2) * dir);
        const yaw = facing(s, dir);
        frame.add(new T.BoxGeometry(0.08, 1.8, 0.08), steel, M4(p.x, 0.9, p.z));
        panel(mileSign(dir > 0 ? k + 1 : 11 - k), 0.5, 0.7, p.x, 1.9, p.z, yaw);
        if (!near && k % 2 === 0) {
          const q = main.point(s + dir * 200, (PAVE_OUT + 2.4) * dir);
          frame.add(new T.BoxGeometry(0.1, 3.0, 0.1), steel, M4(q.x, 1.5, q.z));
          panel((this.speedTex ||= speedSign(70)), 1.2, 1.7, q.x, 3.0, q.z, facing(s + dir * 200, dir));
        }
      }
    this.mesh(frame.geometry(), this.vc, "Sign structures");
  }
  dispose() {
    this.scene.remove(this.group);
    for (const d of this.disposables) d.dispose?.();
    for (const c of this.colliders) this.physics.world.removeCollider(c, false);
  }
}
