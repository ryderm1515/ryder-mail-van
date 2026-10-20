import * as T from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildLayout, buildTerrain, W0, EDGE_IN, LANE_W, LANES, MEDIAN, PAVE_OUT, fbm } from "./layout.js";
import { HighwayWorld } from "./build.js";
import { Traffic } from "./traffic.js";
import { Town } from "../town.js";
import { Gps } from "./gps.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Run } from "./run.js";
import { Cinema } from "../cinema.js";

// Interstate 16: an open-world loop with live traffic, two interchanges and a
// mail-route neighbourhood off each exit.

const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export class Highway {
  constructor({ scene, physics, toon, audio, lights, renderer, persp, ui, damage, actions }) {
    Object.assign(this, { scene, physics, toon, audio, lights, renderer, persp, ui, damage, actions });
    this.active = false;
    this.built = false;
    this.player = { s: 0, onMain: false };
    this.delivered = 0;
    this.time = 0;
  }
  async build(progress = () => {}) {
    if (this.built) return;
    this.layout = buildLayout();
    const towns = this.layout.interchanges.map((ic) => ic.townOrigin);
    this.terrain = buildTerrain(this.layout, towns);
    progress(0.3, "Grading terrain");
    await tick();
    this.world = new HighwayWorld(this.scene, this.physics, this.toon, this.layout, this.terrain);
    this.world.build();
    progress(0.5, "Planting forests");
    await tick();
    await this.trees();
    this.grass();
    this.pavedCells();
    progress(0.65, "Building neighborhoods");
    await tick();
    this.towns = [];
    for (const ic of this.layout.interchanges) {
      const t = new Town(this.scene, this.renderer, { toon: this.toon, origin: ic.townOrigin, openWorld: true });
      await t.build();
      t.group.name = ic.town;
      t.label = ic.town;
      this.towns.push(t);
    }
    progress(0.85, "Starting traffic");
    await tick();
    this.traffic = new Traffic({ scene: this.scene, physics: this.physics, layout: this.layout, toon: this.toon, audio: this.audio });
    await this.traffic.load();
    this.physics.beforeStep = (dt) => this.traffic.active && this.traffic.step(dt);
    this.gps = new Gps(this);
    this.letter = new T.Mesh(new T.BoxGeometry(0.3, 0.02, 0.2), new T.MeshBasicMaterial({ color: 0xfbfaf4 }));
    this.letter.visible = false;
    this.scene.add(this.letter);
    this.setVisible(false);
    this.built = true;
    progress(1, "Ready");
  }
  // Cells of ramp / crossroad pavement so grass never grows through them.
  pavedCells() {
    const set = (this.paved = new Set());
    const C = 2;
    const mark = (x, z, r) => {
      const i0 = Math.floor((x - r) / C), i1 = Math.floor((x + r) / C), j0 = Math.floor((z - r) / C), j1 = Math.floor((z + r) / C);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) set.add(i * 100003 + j);
    };
    for (const ic of this.layout.interchanges) {
      for (const r of ic.ramps) for (let s = 0; s <= r.path.length; s += 1.5) { const p = r.path.at(s); mark(p.x, p.z, 8.5); }
      for (let s = 0; s <= ic.cross.length; s += 1.5) { const p = ic.cross.at(s); mark(p.x, p.z, 10); }
    }
    this.townBoxes = this.layout.interchanges.map((ic) => ic.townOrigin);
  }
  // ------------------------------------------------------------- scenery
  async trees() {
    const kit = await new Promise((res) => new GLTFLoader().load("assets/town/props.glb", (g) => res(g.scene), undefined, () => res(null)));
    const t = this.terrain;
    const kitParts = (name) => {
      const node = kit?.children.find((c) => c.name === name || c.name.startsWith(name + "."));
      if (!node) return null;
      node.updateMatrixWorld(true);
      const list = [];
      node.traverse((o) => o.isMesh && list.push({ geo: o.geometry, mat: o.material, m: o.matrixWorld.clone() }));
      return list;
    };
    const toon = (c) => this.toon(new T.MeshToonMaterial({ color: c }));
    const bark = toon(0x6b4a33);
    // Low-poly forest stock for the bulk of the scenery.
    const trunk = new T.CylinderGeometry(0.16, 0.26, 2.6, 5);
    trunk.translate(0, 1.3, 0);
    const pineTop = mergeGeos([0, 1, 2].map((k) => new T.ConeGeometry(2.3 - k * 0.6, 3.1 - k * 0.4, 6).translate(0, 2.7 + k * 1.8, 0)));
    const blob = mergeGeos([
      new T.IcosahedronGeometry(2.1, 0).translate(0, 3.6, 0),
      new T.IcosahedronGeometry(1.5, 0).translate(1.1, 3.1, 0.4),
      new T.IcosahedronGeometry(1.4, 0).translate(-0.9, 3.3, -0.5),
    ]);
    const kinds = [
      [{ geo: trunk, mat: bark, m: new T.Matrix4() }, { geo: pineTop, mat: toon(0x3d6741), m: new T.Matrix4() }],
      [{ geo: trunk, mat: bark, m: new T.Matrix4() }, { geo: blob, mat: toon(0x5f8a45), m: new T.Matrix4() }],
      [{ geo: trunk, mat: bark, m: new T.Matrix4() }, { geo: blob, mat: toon(0x7f9b47), m: new T.Matrix4() }],
    ];
    // Showpiece trees from the Willow Lane kit, only close to the roads.
    for (const n of ["tree_a", "tree_b"]) {
      const k = kitParts(n);
      if (k) kinds.push(k);
    }
    const lists = kinds.map(() => []);
    const Q = new T.Quaternion(),
      up = new T.Vector3(0, 1, 0);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    let placed = 0;
    for (let i = 0; i < 90000 && placed < 14000; i++) {
      const x = t.X0 + rnd() * t.SIZE_X,
        z = t.Z0 + rnd() * t.SIZE_Z;
      const d = t.distAt(x, z);
      if (d < 26) continue;
      const clump = fbm(x / 180, z / 180);
      if (clump < 0.48 && rnd() > 0.03) continue;
      const h = t.sample(x, z);
      let k;
      if (d < 140 && kinds.length > 3 && rnd() < 0.35) k = 3 + Math.floor(rnd() * (kinds.length - 3));
      else k = clump > 0.6 || h > 28 ? 0 : 1 + Math.floor(rnd() * 2);
      const s = 0.85 + rnd() * 0.75;
      Q.setFromAxisAngle(up, rnd() * 6.28);
      lists[k].push(new T.Matrix4().compose(new T.Vector3(x, h - 0.1, z), Q, new T.Vector3(s, s * (0.9 + rnd() * 0.35), s)));
      placed++;
    }
    this.treeGroup = new T.Group();
    const M = new T.Matrix4();
    lists.forEach((mats, k) => {
      if (!mats.length) return;
      for (const part of kinds[k]) {
        const im = new T.InstancedMesh(part.geo, part.mat, mats.length);
        mats.forEach((m, i) => im.setMatrixAt(i, M.multiplyMatrices(m, part.m)));
        im.computeBoundingSphere();
        im.receiveShadow = true;
        this.treeGroup.add(im);
      }
    });
    this.scene.add(this.treeGroup);
  }
  grass() {
    // Chunky cartoon tufts: a few fat, rounded-looking blades in bright greens.
    const pos = [],
      col = [];
    const base = new T.Color("#4f9a2c"),
      tip = new T.Color("#9fe04a");
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + Math.random() * 0.5,
        r = 0.05 + Math.random() * 0.16,
        x = Math.cos(a) * r,
        z = Math.sin(a) * r;
      const h = 0.22 + Math.random() * 0.3,
        w = 0.07 + Math.random() * 0.04,
        rot = a + Math.PI / 2,
        lean = 0.08 + Math.random() * 0.14;
      const cx = Math.cos(rot) * w,
        cz = Math.sin(rot) * w;
      const mx = x + Math.cos(a) * lean * 0.45,
        mz = z + Math.sin(a) * lean * 0.45;
      const tx = x + Math.cos(a) * lean,
        tz = z + Math.sin(a) * lean;
      // Two-segment blade: wide base, narrower middle, point.
      const A = [x - cx, 0, z - cz], B = [x + cx, 0, z + cz], C2 = [mx - cx * 0.7, h * 0.55, mz - cz * 0.7], D = [mx + cx * 0.7, h * 0.55, mz + cz * 0.7], E = [tx, h, tz];
      pos.push(...A, ...B, ...D, ...A, ...D, ...C2, ...C2, ...D, ...E);
      const t = tip.clone().lerp(new T.Color("#c8ec6a"), Math.random() * 0.4);
      const m = base.clone().lerp(t, 0.55);
      const B3 = [base.r, base.g, base.b], M3 = [m.r, m.g, m.b], T3 = [t.r, t.g, t.b];
      col.push(...B3, ...B3, ...M3, ...B3, ...M3, ...M3, ...M3, ...M3, ...T3);
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new T.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const n = g.attributes.normal;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
    const m = this.toon(new T.MeshToonMaterial({ vertexColors: true, side: T.DoubleSide, color: "#e2dcb4" }));
    this.tufts = new T.InstancedMesh(g, m, 9000);
    this.tufts.instanceColor = new T.InstancedBufferAttribute(new Float32Array(9000 * 3), 3);
    this.tufts.frustumCulled = false;
    this.tufts.count = 0;
    this.tufts.receiveShadow = true;
    this.scene.add(this.tufts);
    this.tuftCenter = null;
  }
  reseedGrass(px, pz) {
    const t = this.terrain,
      M = new T.Matrix4(),
      Q = new T.Quaternion(),
      c = new T.Color();
    let n = 0,
      seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const G = 2.0,
      R = 95;
    const gx = Math.round(px / G),
      gz = Math.round(pz / G);
    for (let i = -R / G; i <= R / G && n < 9000; i++)
      for (let j = -R / G; j <= R / G && n < 9000; j++) {
        const cx = (gx + i) * G,
          cz = (gz + j) * G;
        const h = Math.sin(cx * 12.9898 + cz * 78.233) * 43758.5453;
        const r1 = h - Math.floor(h),
          r2 = (h * 7.13) % 1;
        if (r1 < 0.2) continue;
        const x = cx + (r1 - 0.5) * G,
          z = cz + (Math.abs(r2) - 0.5) * G;
        const pr = this.layout.main.project(x, z, this.player.s, 260);
        const off = Math.abs(pr.off);
        if (off < MEDIAN + 0.5 ? off < 1.2 : off < PAVE_OUT + 2.5) continue;
        if (this.paved?.has(Math.floor(x / 2) * 100003 + Math.floor(z / 2))) continue;
        if (this.townBoxes?.some((o) => x > o.x - 560 && x < o.x + 460 && Math.abs(z - o.z) < 260)) continue;
        const s = 0.8 + r1 * 1.1;
        Q.setFromAxisAngle(new T.Vector3(0, 1, 0), r1 * 9);
        M.compose(new T.Vector3(x, t.sample(x, z), z), Q, new T.Vector3(s, s * (0.8 + r1 * 0.6), s));
        this.tufts.setMatrixAt(n, M);
        c.setRGB(0.88 + r1 * 0.2, 0.95 + r1 * 0.1, 0.85 + r1 * 0.1);
        this.tufts.setColorAt(n, c);
        n++;
      }
    this.tufts.count = n;
    this.tufts.instanceMatrix.needsUpdate = true;
    this.tufts.instanceColor.needsUpdate = true;
    this.tuftCenter = { x: px, z: pz };
  }
  setVisible(on) {
    this.world.group.visible = on;
    if (this.treeGroup) this.treeGroup.visible = on;
    if (this.tufts) this.tufts.visible = on;
    for (const t of this.towns || []) t.group.visible = on;
  }
  // ---------------------------------------------------------------- enter
  spawn() {
    const ic = this.layout.interchanges[0],
      s = ic.sc - 2200;
    const p = this.layout.main.point(s, PAVE_OUT - 1.6);
    const yaw = Math.atan2(p.tz, -p.tx);
    return { position: [p.x, 1.3, p.z], yaw, s };
  }
  enter() {
    this.active = true;
    this.setVisible(true);
    const sp = this.spawn();
    this.player.s = sp.s;
    this.traffic.setActive(true, sp.s);
    // Atmosphere: deep views, light haze, midday sun.
    const sc = this.scene,
      L = this.lights;
    this.saved = {
      fog: sc.fog,
      bg: sc.background?.clone?.(),
      far: this.persp.far,
      near: this.persp.near,
      sunOffset: L.sunOffset.clone(),
      sunI: L.sun.intensity,
      hemiI: L.hemi.intensity,
      hemiC: L.hemi.color.clone(),
      hemiG: L.hemi.groundColor.clone(),
    };
    // Warm storybook haze, matched to the Morning Route.
    sc.fog = new T.Fog(new T.Color("#ead9c2"), 420, 5200);
    sc.background = new T.Color("#ead9c2");
    this.persp.far = 12000;
    this.persp.near = 0.08;
    this.persp.updateProjectionMatrix();
    L.sunOffset.set(-18, 28, 13);
    this.saved.sunC = L.sun.color.clone();
    L.sun.color.set("#ffe2b8");
    L.sun.intensity = 3.1;
    L.hemi.intensity = 1.45;
    L.hemi.color.set("#f6efe4");
    L.hemi.groundColor.set("#6f8452");
    // Soft studio reflections for car paint and glass.
    if (!this.env) {
      const pm = new T.PMREMGenerator(this.renderer);
      this.env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
    }
    this.saved.env = sc.environment;
    sc.environment = this.env;
    if ("environmentIntensity" in sc) (this.saved.envI = sc.environmentIntensity), (sc.environmentIntensity = 0.55);
    this.reseedGrass(sp.position[0], sp.position[2]);
    this.gps.show(true);
    // Run loop: health, score, route and results.
    if (!this.run) {
      this.run = new Run(this);
      const prev = this.damage?.onImpact;
      if (this.damage) this.damage.onImpact = (sev) => (prev?.(sev), this.active && this.run.onImpact(sev));
    }
    this.damage?.repair();
    this.run.start();
    document.getElementById("activity").hidden = true;
    return sp;
  }
  leave() {
    if (!this.active) return;
    this.active = false;
    this.setVisible(false);
    this.traffic.setActive(false);
    const s = this.saved,
      L = this.lights;
    if (s) {
      this.scene.fog = s.fog;
      if (s.bg) this.scene.background = s.bg;
      this.persp.far = s.far;
      this.persp.near = s.near;
      this.persp.updateProjectionMatrix();
      L.sunOffset.copy(s.sunOffset);
      L.sun.intensity = s.sunI;
      if (s.sunC) L.sun.color.copy(s.sunC);
      L.hemi.intensity = s.hemiI;
      L.hemi.color.copy(s.hemiC);
      L.hemi.groundColor.copy(s.hemiG);
    }
    this.mission = null;
    this.run?.stop();
    this.physics.paused = false;
    this.setDebug(false);
    this.gps?.show(false);
    if (s) {
      this.scene.environment = s.env || null;
      if (s.envI != null) this.scene.environmentIntensity = s.envI;
    }
    document.getElementById("activity").hidden = true;
  }
  // ------------------------------------------------------------- missions
  newMission() {
    const lots = [];
    this.towns.forEach((t) => t.lots?.forEach((l) => lots.push({ town: t, lot: l })));
    if (!lots.length) return;
    let pick;
    do pick = lots[Math.floor(Math.random() * lots.length)];
    while (this.mission && pick.lot === this.mission.lot && lots.length > 1);
    const pos = pick.lot.mailbox.clone().add(pick.town.origin);
    this.mission = { ...pick, pos, label: pick.lot.num + " · " + pick.town.label };
    this.hud();
  }
  hud() {}
  // Film-style post (bloom + warm grade + vignette) for every exterior view.
  render(time, camera) {
    if (!this.active || this.postOff) return false;
    if (!this.cinema) this.cinema = new Cinema(this.renderer, this.scene, camera);
    this.cinema.camera = camera;
    this.cinema.grade.uniforms.uStrength.value = 0.4; // lighter than the film: readable while driving
    this.cinema.render(time, { focus: 0 });
    return true;
  }
  // Fresh run from the spawn point.
  restart() {
    const sp = this.spawn();
    this.player.s = sp.s;
    this.traffic.setActive(true, sp.s);
    this.damage?.repair();
    this.physics.teleport(sp.position, sp.yaw);
    this.run.start();
  }
  exit() {
    this.actions?.teleport?.("garage");
  }
  // Dev teleports: towns, exits and the next stop.
  teleports() {
    const go = (x, z, yaw) => () => {
      this.physics.teleport([x, 1.4, z], yaw);
      this.reseedGrass(x, z);
    };
    const list = [];
    for (const t of this.towns) {
      const p = t.route.at(12);
      list.push([t.label, go(p.x, p.z, p.yaw)]);
    }
    for (const ic of this.layout.interchanges) {
      const p = this.layout.main.point(ic.sc - 1500, PAVE_OUT - 1.6),
        a = this.layout.main.at(ic.sc - 1500);
      list.push(["Before exit " + ic.exit, go(p.x, p.z, Math.atan2(a.tz, -a.tx))]);
    }
    list.push([
      "Next stop",
      () => {
        const m = this.mission;
        if (!m) return;
        const R = m.town.route;
        let best = 0,
          bd = 1e9;
        for (let d = 0; d < R.length; d += 1) {
          const q = R.at(d),
            dd = Math.hypot(q.x - m.pos.x, q.z - m.pos.z);
          if (dd < bd) (bd = dd), (best = d);
        }
        const q = R.at(Math.max(0, best - 25));
        go(q.x, q.z, q.yaw)();
      },
    ]);
    return list;
  }
  // Debug overlay: ramps, crossroads, town streets and delivery triggers.
  setDebug(on) {
    if (on && !this.debugGroup) {
      const pts = [];
      const add = (path, step = 4, y = 0.4) => {
        for (let d = 0; d + step <= path.length; d += step) {
          const a = path.at(d),
            b = path.at(d + step);
          pts.push(a.x, (a.y || 0) + y, a.z, b.x, (b.y || 0) + y, b.z);
        }
      };
      for (const ic of this.layout.interchanges) {
        ic.ramps.forEach((r) => add(r.path, 3));
        add(ic.cross, 4);
      }
      this.towns.forEach((t) => add(t.route, 3));
      for (const t of this.towns)
        for (const l of t.lots || []) {
          const c = l.mailbox.clone().add(t.origin);
          for (let i = 0; i < 24; i++) {
            const a0 = (i / 24) * Math.PI * 2,
              a1 = ((i + 1) / 24) * Math.PI * 2;
            pts.push(c.x + Math.cos(a0) * 5.5, 0.3, c.z + Math.sin(a0) * 5.5, c.x + Math.cos(a1) * 5.5, 0.3, c.z + Math.sin(a1) * 5.5);
          }
        }
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.Float32BufferAttribute(pts, 3));
      this.debugGroup = new T.LineSegments(g, new T.LineBasicMaterial({ color: "#ff3d7f", depthTest: false }));
      this.debugGroup.renderOrder = 10;
      this.scene.add(this.debugGroup);
    }
    if (this.debugGroup) this.debugGroup.visible = on;
  }
  waypoint() {
    return this.mission ? { pos: [this.mission.pos.x, 1.2, this.mission.pos.z] } : null;
  }
  deliver(van) {
    const m = this.mission;
    this.delivered++;
    this.letterAnim = { t: 0, from: van.clone().add(new T.Vector3(0, 1.4, 0)), to: m.pos.clone().add(new T.Vector3(0, 1.15, 0)) };
    this.ui?.toast?.("Delivered to " + m.label + ".");
    this.audio?.event?.("success");
    if (this.run?.active) this.run.onDeliver();
    else this.newMission();
  }
  // --------------------------------------------------------------- update
  update(dt, { position, velocity, speed, camera, rotation }) {
    if (!this.active) return;
    this.time += dt;
    const main = this.layout.main;
    // Where the player is relative to the interstate.
    const pr = main.project(position.x, position.z, this.player.s, 120);
    const p = this.player;
    p.s = pr.s;
    const off = Math.abs(pr.off);
    p.onMain = off > MEDIAN - 1 && off < PAVE_OUT + 1.5;
    p.dir = pr.off >= 0 ? 1 : -1;
    const at = main.at(pr.s);
    p.v = (velocity.x * at.tx + velocity.z * at.tz) * p.dir;
    const lat = LANES - 1 - (off - EDGE_IN - LANE_W / 2) / LANE_W;
    p.lo = Math.floor(lat - 0.3);
    p.hi = Math.ceil(lat + 0.3);
    this.traffic.player = p;
    // Keep the window of traffic around the player.
    for (const car of [...this.traffic.cars]) if (!car.ramp && !car.wreck) this.traffic.recycle(car, p.s);
    this.traffic.feedRamps(p.s);
    this.traffic.checkContacts();
    this.traffic.clearWrecks(p.s);
    this.traffic.render(this.physics.alpha);
    this.traffic.updateAudio(position);
    // Sky and grass follow the camera.
    this.world.skyDome.position.copy(camera.position);
    if (this.world.skyTime) this.world.skyTime.value = this.time;
    if (!this.tuftCenter || Math.hypot(position.x - this.tuftCenter.x, position.z - this.tuftCenter.z) > 25) this.reseedGrass(position.x, position.z);
    // Neighbourhood life when close.
    for (const t of this.towns) {
      const d = Math.hypot(position.x - t.origin.x, position.z - t.origin.z);
      t.group.visible = d < 1600;
      if (d < 900) t.update(this.time, { beat: "glide", u: 0.5, t: this.time, van: position.clone(), cam: camera.position.clone() });
    }
    // Mail: pull up beside the mailbox and slow down.
    if (this.mission && !this.letterAnim) {
      const d = Math.hypot(position.x - this.mission.pos.x, position.z - this.mission.pos.z);
      if (d < 5.5 && Math.abs(speed) < 2.5) this.deliver(position);
    }
    if (this.letterAnim) {
      const a = this.letterAnim;
      a.t += dt / 0.9;
      const k = Math.min(1, a.t);
      this.letter.visible = k < 1;
      this.letter.position.lerpVectors(a.from, a.to, k);
      this.letter.position.y += Math.sin(k * Math.PI) * 1.2;
      this.letter.rotation.set(0, k * 6, Math.sin(k * 9) * 0.3);
      if (a.t >= 1.4) this.letterAnim = null;
    }
    this.run?.update(dt, { position, speed });
    if (rotation) this.gps.update(position, new T.Vector3(-1, 0, 0).applyQuaternion(rotation).setY(0).normalize(), speed, this.traffic.cars);
  }
}

function mergeGeos(list) {
  const pos = [],
    nor = [];
  for (const g0 of list) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    g.computeVertexNormals();
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new T.Float32BufferAttribute(nor, 3));
  return g;
}
