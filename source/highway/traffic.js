import * as T from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RAPIER } from "../physics.js";
import { laneOffset, LANES, LANE_W, EDGE_IN, PAVE_OUT } from "./layout.js";

// Interstate traffic: Intelligent Driver Model car-following, MOBIL lane
// changes with turn signals, exits and merges at the interchanges, and wrecks
// that turn a kinematic car into a physical one when something hits it.

const TYPES = {
  sedan: { len: [2.42, 2.42], w: 1.84, h: 1.45, mass: 1500 },
  hatch: { len: [2.1, 2.1], w: 1.78, h: 1.5, mass: 1250 },
  suv: { len: [2.45, 2.45], w: 1.94, h: 1.8, mass: 2100 },
  minivan: { len: [2.55, 2.55], w: 1.98, h: 1.78, mass: 2000 },
  pickup: { len: [2.9, 2.9], w: 2.0, h: 1.9, mass: 2400 },
  boxtruck: { len: [3.85, 3.85], w: 2.5, h: 3.8, mass: 7000 },
  semi: { len: [6.6, 14.45], w: 2.6, h: 4.2, mass: 16000 },
};
const MIX = [
  ["sedan", 0.26], ["suv", 0.2], ["hatch", 0.12], ["pickup", 0.14], ["minivan", 0.1], ["boxtruck", 0.07], ["semi", 0.11],
];
const PAINT = ["#e9ebe8", "#1d1f22", "#9ea4a8", "#5c6166", "#8e1f22", "#22406b", "#2f5e4b", "#c8c2b2", "#3a4552", "#b4502d", "#e2c14d", "#6b7f99", "#f2f2f0", "#2b2d30", "#7a2531"];
const STYLES = {
  cruiser: { v0: [29.5, 32.5], T: 1.4, a: 1.3, b: 2.2, pol: 0.4, thr: 0.25, keepRight: 0.3, sig: [1.6, 2.6], dur: 3.0 },
  speeder: { v0: [35, 40], T: 0.8, a: 2.4, b: 3.4, pol: 0.05, thr: 0.08, keepRight: 0.05, sig: [0.5, 1.1], dur: 1.8 },
  cautious: { v0: [26, 29], T: 1.9, a: 1.0, b: 1.8, pol: 0.7, thr: 0.4, keepRight: 0.5, sig: [2.2, 3.2], dur: 3.6 },
  truck: { v0: [26.5, 29], T: 1.9, a: 0.55, b: 1.6, pol: 0.5, thr: 0.45, keepRight: 0.6, sig: [2.2, 3.0], dur: 4.0 },
};
const PER_DIR = 64,
  AHEAD = 1400,
  BEHIND = 800,
  rand = (a, b) => a + Math.random() * (b - a),
  pick = (list) => {
    let r = Math.random();
    for (const [k, w] of list) if ((r -= w) <= 0) return k;
    return list[0][0];
  };

export class Traffic {
  constructor({ scene, physics, layout, toon, audio }) {
    this.scene = scene;
    this.physics = physics;
    this.layout = layout;
    this.main = layout.main;
    this.L = layout.main.length;
    this.toon = toon;
    this.audio = audio;
    this.cars = [];
    this.group = new T.Group();
    this.group.name = "Traffic";
    this.meshes = {};
    this.disposables = [];
    this.time = 0;
    this.player = null;
    this.active = false;
    this.tmp = {};
  }
  async load() {
    const gltf = await new Promise((res, rej) => new GLTFLoader().load("assets/highway/cars.glb", res, undefined, rej));
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    // Capacity per type: enough for both directions plus ramps.
    const total = PER_DIR * 2 + 24;
    for (const [type] of MIX) {
      const cap = Math.ceil(total * MIX.find((m) => m[0] === type)[1] * 1.6) + 6;
      const parts = {};
      root.traverse((o) => {
        if (!o.isMesh || !o.name.startsWith(type + "__")) return;
        const part = o.name.split("__")[1].split(".")[0];
        if (parts[part]) return; // one mesh per part
        const g = o.geometry.clone();
        g.applyMatrix4(o.matrixWorld);
        let mat;
        const src = o.material;
        if (part === "body") mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.35 });
        else if (["head", "tail", "brake", "indL", "indR"].includes(part))
          mat = new T.MeshBasicMaterial({ color: part === "head" ? 0xfff6e0 : part === "tail" ? 0x8a1410 : part === "brake" ? 0xff3322 : 0xffa020 });
        else if (part === "glass") mat = new T.MeshStandardMaterial({ color: 0x1d2730, roughness: 0.15, metalness: 0.6 });
        else if (part === "chrome" || part === "rim") mat = new T.MeshStandardMaterial({ color: src.color?.clone() || 0xbbbbbb, metalness: 0.7, roughness: 0.3 });
        else mat = this.toon(new T.MeshToonMaterial({ color: src.color?.clone() || 0x888888 }));
        const im = new T.InstancedMesh(g, mat, cap);
        im.count = 0;
        im.castShadow = !["head", "tail", "brake", "indL", "indR", "glass"].includes(part);
        im.receiveShadow = part === "body" || part === "cargo";
        im.frustumCulled = false;
        if (part === "body") im.instanceColor = new T.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        this.group.add(im);
        this.disposables.push(g, mat);
        parts[part] = im;
      });
      this.meshes[type] = { parts, cap, used: 0, free: [] };
    }
    this.scene.add(this.group);
  }
  // ---------------------------------------------------------------- cars
  slot(type) {
    const m = this.meshes[type];
    if (m.free.length) return m.free.pop();
    if (m.used < m.cap) return m.used++;
    return -1;
  }
  makeCar(type) {
    type = type || pick(MIX);
    const idx = this.slot(type);
    if (idx < 0) return null;
    const truck = type === "boxtruck" || type === "semi";
    const styleName = truck ? "truck" : pick([["cruiser", 0.6], ["speeder", 0.2], ["cautious", 0.2]]);
    const st = STYLES[styleName];
    const spec = TYPES[type];
    const car = {
      type,
      idx,
      spec,
      style: st,
      styleName,
      truck,
      v0: rand(...st.v0),
      color: new T.Color(PAINT[Math.floor(Math.random() * PAINT.length)]),
      dir: 1,
      s: 0,
      v: 25,
      acc: 0,
      lane: 0,
      lat: 0,
      fromLat: 0,
      changeT: 0,
      sig: 0,
      sigT: 0,
      think: Math.random(),
      wreck: null,
      ramp: null,
      exitAt: null,
      pos: new T.Vector3(),
      prev: new T.Vector3(),
      yaw: 0,
      prevYaw: 0,
      pitch: 0,
      brakeOn: false,
    };
    if (truck) car.color.set(type === "semi" ? PAINT[Math.floor(Math.random() * 6)] : "#f0f0ec");
    this.meshes[type].parts.body.setColorAt(idx, car.color);
    this.meshes[type].parts.body.instanceColor.needsUpdate = true;
    // Kinematic body; becomes dynamic in a crash.
    const body = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -500, 0));
    const half = { x: (spec.len[0] + spec.len[1]) / 2, y: spec.h / 2, z: spec.w / 2 };
    const col = this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setTranslation((spec.len[0] - spec.len[1]) / 2, spec.h / 2 + 0.05, 0)
        .setMass(spec.mass)
        .setFriction(0.7)
        .setRestitution(0.05),
      body,
    );
    car.body = body;
    car.collider = col;
    this.cars.push(car);
    return car;
  }
  release(car) {
    const m = this.meshes[car.type];
    for (const im of Object.values(m.parts)) im.setMatrixAt(car.idx, new T.Matrix4().makeScale(0, 0, 0));
    m.free.push(car.idx);
    this.physics.world.removeRigidBody(car.body);
    this.cars.splice(this.cars.indexOf(car), 1);
  }
  // Lateral offset (signed) for a lane coordinate.
  offsetFor(car, lat) {
    const o = EDGE_IN + LANE_W * (LANES - 1 - lat) + LANE_W / 2;
    return o * car.dir;
  }
  progress(car) {
    return car.dir > 0 ? car.s : this.L - car.s;
  }
  // Signed distance ahead from a to b along a's direction of travel, wrapped.
  ahead(dir, sa, sb) {
    let d = (sb - sa) * dir;
    const L = this.L;
    d = ((d % L) + L) % L;
    if (d > L / 2) d -= L;
    return d;
  }
  // -------------------------------------------------------------- spawn
  placeOnMain(car, dir, s, lane) {
    car.dir = dir;
    car.s = this.main.wrap(s);
    car.lane = lane;
    car.lat = lane;
    car.fromLat = lane;
    car.changeT = 0;
    car.sig = 0;
    car.ramp = null;
    car.v = Math.min(car.v0, 24 + Math.random() * 8);
    car.exitAt = null;
    // Some cars plan to take the next exit ahead.
    for (const ic of this.layout.interchanges) {
      const d = this.ahead(dir, car.s, ic.sc);
      if (d > 1400 && d < 4000 && Math.random() < 0.18) car.exitAt = ic;
    }
    this.pose(car, true);
  }
  spawnInitial(ps) {
    for (const dir of [1, -1])
      for (let i = 0; i < PER_DIR; i++) {
        const car = this.makeCar();
        if (!car) continue;
        const lanes = car.truck ? [0, 1] : [0, 1, 2];
        const d = -BEHIND + ((i + Math.random() * 0.8) / PER_DIR) * (AHEAD + BEHIND);
        this.placeOnMain(car, dir, ps + d * dir, lanes[Math.floor(Math.random() * lanes.length)]);
      }
    this.spaceOut();
  }
  // Push apart anything spawned too close in the same lane.
  spaceOut() {
    for (let pass = 0; pass < 3; pass++)
      for (const a of this.cars)
        for (const b of this.cars) {
          if (a === b || a.ramp || b.ramp || a.dir !== b.dir || a.lane !== b.lane) continue;
          const d = this.ahead(a.dir, a.s, b.s);
          if (d >= 0 && d < 30) b.s = this.main.wrap(b.s + 30 * b.dir);
        }
  }
  // Recycle cars that fall out of the window around the player.
  recycle(car, ps) {
    const d = this.ahead(car.dir, ps, car.s);
    if (d > -BEHIND - 60 && d < AHEAD + 60) return;
    if (car.wreck) return;
    // Re-enter at the far edge the player is driving toward (or behind, for slower traffic).
    const front = d < 0;
    const nd = front ? AHEAD - Math.random() * 80 : -BEHIND + Math.random() * 60;
    const lanes = car.truck ? [0, 1] : [0, 1, 2];
    const lane = lanes[Math.floor(Math.random() * lanes.length)];
    const s = this.main.wrap(ps + nd * car.dir);
    // Keep it clear of others in that lane.
    for (const o of this.cars) if (o !== car && !o.ramp && o.dir === car.dir && o.lane === lane && Math.abs(this.ahead(car.dir, s, o.s)) < 40) return;
    car.color.set(PAINT[Math.floor(Math.random() * PAINT.length)]);
    if (!car.truck) {
      this.meshes[car.type].parts.body.setColorAt(car.idx, car.color);
      this.meshes[car.type].parts.body.instanceColor.needsUpdate = true;
    }
    this.placeOnMain(car, car.dir, s, lane);
  }
  // --------------------------------------------------------------- model
  idm(car, v, vl, gap) {
    const st = car.style,
      v0 = car.limit ?? car.v0;
    const free = 1 - Math.pow(Math.max(0, v) / v0, 4);
    if (gap === Infinity) return st.a * free;
    const sStar = 2.5 + Math.max(0, v * st.T + (v * (v - vl)) / (2 * Math.sqrt(st.a * st.b)));
    return Math.max(-9, st.a * (free - (sStar / Math.max(0.5, gap)) ** 2));
  }
  // Nearest thing ahead/behind in a lane of one direction (cars, wrecks, player).
  scan(car, lane, entries) {
    let lead = null,
      leadGap = Infinity,
      foll = null,
      follGap = Infinity;
    for (const e of entries) {
      if (e.car === car) continue;
      if (lane < e.lo - 0.1 || lane > e.hi + 0.1) continue;
      const d = this.ahead(car.dir, car.s, e.s);
      if (d >= 0) {
        const gap = d - car.spec.len[0] - e.rear;
        if (gap < leadGap) (leadGap = gap), (lead = e);
      } else {
        const gap = -d - car.spec.len[1] - e.front;
        if (gap < follGap) (follGap = gap), (foll = e);
      }
    }
    return { lead, leadGap, foll, follGap };
  }
  entriesFor(dir) {
    const list = [];
    for (const c of this.cars) {
      if (c.ramp && !c.ramp.merging) continue;
      if (c.wreck) {
        if (c.wreck.dir !== dir) continue;
        list.push({ car: c, s: c.wreck.s, v: 0, lo: c.wreck.lo, hi: c.wreck.hi, front: 2.5, rear: 2.5 });
        continue;
      }
      if (c.dir !== dir) continue;
      const lo = Math.min(c.lat, Math.round(c.lat)),
        hi = Math.max(c.lat, Math.round(c.lat));
      list.push({ car: c, s: c.s, v: c.v, lo: Math.floor(lo + 0.15), hi: Math.ceil(hi - 0.15), front: c.spec.len[0], rear: c.spec.len[1] });
    }
    const p = this.player;
    if (p && p.onMain && p.dir === dir) list.push({ car: null, s: p.s, v: p.v, lo: p.lo, hi: p.hi, front: 3, rear: 3, player: true });
    return list;
  }
  // ------------------------------------------------------------- update
  step(dt) {
    if (!this.active) return;
    this.time += dt;
    const ents = { 1: this.entriesFor(1), [-1]: this.entriesFor(-1) };
    for (const car of this.cars) {
      car.prev.copy(car.pos);
      car.prevYaw = car.yaw;
      if (car.wreck) continue;
      if (car.ramp) {
        this.stepRamp(car, dt);
        continue;
      }
      const E = ents[car.dir];
      // Exit planning: get to the right lane, then take the ramp.
      if (car.exitAt) {
        const d = this.ahead(car.dir, car.s, car.exitAt.sc);
        if (d < 2600 && car.lane > 0 && !car.changeT && !car.sig) car.wantRight = true;
        if (d < 560 && d > 540 && Math.round(car.lat) === 0) {
          const r = car.exitAt.ramps.find((r) => r.dir === car.dir && r.kind === "off");
          car.ramp = { path: r.path, s: 0, ic: car.exitAt, kind: "off" };
          car.sig = 1;
          car.exitAt = null;
          continue;
        }
        if (d < 300) car.exitAt = null; // missed it
      }
      // Car following in the current lane (and the target lane mid-change).
      const cur = this.scan(car, Math.round(car.lat), E);
      let acc = this.idm(car, car.v, cur.lead ? cur.lead.v : 0, cur.leadGap);
      if (car.changeT > 0) {
        const tgt = this.scan(car, car.lane, E);
        acc = Math.min(acc, this.idm(car, car.v, tgt.lead ? tgt.lead.v : 0, tgt.leadGap));
      }
      // Horn at someone (usually the player) who cut in too close.
      if (acc < -5 && cur.lead?.player && this.time - (car.honked || -9) > 4) {
        car.honked = this.time;
        this.honk(car);
      }
      car.acc = acc;
      car.v = Math.max(0, car.v + acc * dt);
      car.s = this.main.wrap(car.s + car.v * dt * car.dir);
      car.brakeOn = acc < -0.6 || car.v < 1;
      // Lane changes.
      car.think -= dt;
      if (car.changeT > 0) {
        car.changeT = Math.max(0, car.changeT - dt / car.style.dur);
        const k = 1 - car.changeT,
          e = k * k * (3 - 2 * k);
        car.lat = car.fromLat + (car.lane - car.fromLat) * e;
        if (car.changeT === 0) (car.lat = car.lane), (car.sig = 0);
      } else if (car.sig) {
        car.sigT -= dt;
        if (car.sigT <= 0) {
          const target = car.lane + (car.sig < 0 ? 1 : -1);
          if (this.safe(car, target, E)) {
            car.fromLat = car.lat;
            car.lane = target;
            car.changeT = 1;
          } else if (car.sigT < -4) car.sig = 0;
        }
      } else if (car.think <= 0) {
        car.think = 0.7 + Math.random() * 0.8;
        this.consider(car, E, acc);
      }
      this.pose(car);
    }
    this.stepWrecks(dt);
  }
  safe(car, lane, E) {
    if (lane < 0 || lane > (car.truck ? 1 : LANES - 1)) return false;
    const t = this.scan(car, lane, E);
    if (t.leadGap < 4 + car.v * 0.4 || t.follGap < 5) return false;
    if (t.foll) {
      const fa = this.idm(t.foll.car || car, t.foll.v, car.v, t.follGap);
      if (fa < -3.5) return false;
    }
    return true;
  }
  consider(car, E, accCur) {
    const st = car.style;
    let best = 0,
      bestGain = st.thr;
    for (const dl of [-1, 1]) {
      const lane = car.lane + dl;
      if (lane < 0 || lane > (car.truck ? 1 : LANES - 1)) continue;
      const t = this.scan(car, lane, E);
      if (t.leadGap < 6 || t.follGap < 6) continue;
      const accNew = this.idm(car, car.v, t.lead ? t.lead.v : 0, t.leadGap);
      let follLoss = 0;
      if (t.foll && t.foll.car) {
        const old = this.idm(t.foll.car, t.foll.v, 0, Infinity),
          now = this.idm(t.foll.car, t.foll.v, car.v, t.follGap);
        if (now < -3) continue;
        follLoss = old - now;
      }
      let gain = accNew - accCur - st.pol * follLoss;
      gain += dl < 0 ? st.keepRight : -st.keepRight * 0.6; // move right when it costs little
      if (car.wantRight && dl < 0) gain += 2;
      if (car.exitAt && dl > 0) gain -= 3;
      if (gain > bestGain) (bestGain = gain), (best = dl);
    }
    if (best) {
      car.sig = best < 0 ? 1 : -1; // +1 = right indicator
      car.sigT = rand(...st.sig);
      car.wantRight = false;
    }
  }
  // Ramp driving: follow the ramp path with a slower target speed.
  stepRamp(car, dt) {
    const r = car.ramp,
      len = r.path.length;
    const target = r.kind === "off" ? (r.s < len - 140 ? 22 : 12) : Math.min(car.v0, 13 + (r.s / len) * 20);
    let acc = car.style.a * (1 - (car.v / Math.max(1, target)) ** 4);
    // Follow ramp traffic.
    for (const o of this.cars)
      if (o !== car && o.ramp && o.ramp.path === r.path && o.ramp.s > r.s && o.ramp.s - r.s < 60)
        acc = Math.min(acc, this.idm(car, car.v, o.v, o.ramp.s - r.s - 6));
    if (r.kind === "off" && car.v > target) acc = Math.min(acc, -2.2);
    car.v = Math.max(0, car.v + acc * dt);
    car.acc = acc;
    car.brakeOn = acc < -0.6;
    r.s += car.v * dt;
    if (r.kind === "on" && r.s > len - 150) {
      // Merge into lane 0 when the gap allows; hold at the end otherwise.
      car.sig = -1;
      const s = this.main.project(car.pos.x, car.pos.z, car.s).s;
      car.s = s;
      car.lane = 0;
      const E = this.entriesFor(car.dir);
      if (this.safe(car, 0, E) || r.s >= len - 1) {
        car.ramp = null;
        car.lat = 0;
        car.fromLat = 0;
        car.sig = 0;
        car.changeT = 0;
        this.pose(car);
        return;
      }
      if (r.s > len - 25) (car.v = Math.max(0, car.v - 6 * dt)), (r.s = Math.min(r.s, len - 2));
    }
    if (r.kind === "off" && r.s >= len - 1) {
      car.sig = 0;
      // Drive across the bridge toward the neighbourhood, then leave the world.
      car.ramp = { path: r.ic.cross, s: 740 + (car.dir > 0 ? 60 : -60), ic: r.ic, kind: "cross", back: true };
    } else if (r.kind === "cross") {
      r.s -= car.v * dt * 2; // (moved forward above; crossroad cars drive toward s = 0)
      if (r.s < 15) {
        car.ramp = null;
        car.dir = Math.random() < 0.5 ? 1 : -1;
        this.placeOnMain(car, car.dir, (this.player?.s ?? 0) + (AHEAD - Math.random() * 100) * car.dir, car.truck ? 0 : Math.floor(Math.random() * 3));
        return;
      }
    }
    this.poseRamp(car);
  }
  // Spawn a car on an on-ramp near the player now and then.
  feedRamps(ps) {
    if (Math.random() > 0.012) return;
    for (const ic of this.layout.interchanges) {
      if (Math.abs(this.ahead(1, ps, ic.sc)) > 1400) continue;
      const r = ic.ramps.filter((x) => x.kind === "on")[Math.floor(Math.random() * 2)];
      if (this.cars.some((c) => c.ramp && c.ramp.path === r.path && c.ramp.s < 40)) continue;
      // Steal the farthest mainline car.
      let far = null,
        fd = 0;
      for (const c of this.cars) {
        if (c.ramp || c.wreck || c.dir !== r.dir || c.truck) continue;
        const d = Math.abs(this.ahead(c.dir, ps, c.s));
        if (d > fd) (fd = d), (far = c);
      }
      if (!far || fd < 900) continue;
      far.dir = r.dir;
      far.ramp = { path: r.path, s: 0, ic, kind: "on" };
      far.v = 12;
      far.lat = 0;
      far.sig = 0;
      this.poseRamp(far, true);
    }
  }
  // ---------------------------------------------------------------- pose
  pose(car, snap = false) {
    const p = this.main.point(car.s, this.offsetFor(car, car.lat), this.tmp);
    car.pos.set(p.x, 0.12, p.z);
    let yaw = Math.atan2(-p.tz * car.dir, p.tx * car.dir);
    // Lean into the lane change a touch.
    if (car.changeT > 0) yaw += (car.lane - car.fromLat) * car.dir * -0.05 * Math.sin((1 - car.changeT) * Math.PI);
    car.yaw = yaw;
    car.pitch = 0;
    if (snap) car.prev.copy(car.pos), (car.prevYaw = yaw);
    this.kin(car);
  }
  poseRamp(car, snap = false) {
    const r = car.ramp;
    const p = r.path.at(r.s, this.tmp);
    let dx = p.tx,
      dz = p.tz;
    if (r.kind === "cross") (dx = -dx), (dz = -dz);
    const side = r.kind === "cross" ? 1.85 : 0;
    car.pos.set(p.x + -dz * side * 0 + p.nx * side * (r.kind === "cross" ? -1 : 0), p.y + 0.13, p.z + p.nz * side * (r.kind === "cross" ? -1 : 0));
    car.yaw = Math.atan2(-dz, dx);
    car.pitch = Math.atan(p.grade) * (r.kind === "cross" ? -1 : 1);
    if (snap) car.prev.copy(car.pos), (car.prevYaw = car.yaw);
    this.kin(car);
  }
  kin(car) {
    const q = new T.Quaternion().setFromEuler(new T.Euler(0, car.yaw, car.pitch, "YXZ"));
    car.body.setNextKinematicTranslation({ x: car.pos.x, y: car.pos.y, z: car.pos.z });
    car.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
  }
  // -------------------------------------------------------------- wrecks
  wreck(car, by = null) {
    if (car.wreck) return;
    const fwd = new T.Vector3(Math.cos(car.yaw), 0, -Math.sin(car.yaw));
    car.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    car.body.setLinearDamping(0.25);
    car.body.setAngularDamping(0.6);
    car.body.setLinvel({ x: fwd.x * car.v, y: 0, z: fwd.z * car.v }, true);
    car.wreck = { t: 0, s: car.s, dir: car.dir, lo: Math.floor(car.lat), hi: Math.ceil(car.lat) };
    car.sig = 2; // hazards
    car.brakeOn = true;
    car.ramp = null;
  }
  stepWrecks(dt) {
    for (const car of this.cars) {
      if (!car.wreck) continue;
      const w = car.wreck;
      w.t += dt;
      const t = car.body.translation(),
        r = car.body.rotation();
      car.pos.set(t.x, t.y, t.z);
      car.quat = new T.Quaternion(r.x, r.y, r.z, r.w);
      // Where it now blocks the road.
      const pr = this.main.project(t.x, t.z, w.s, 60);
      w.s = pr.s;
      const dir = pr.off >= 0 ? 1 : -1,
        off = Math.abs(pr.off);
      w.dir = dir;
      const lat = LANES - 1 - (off - EDGE_IN - LANE_W / 2) / LANE_W;
      w.lo = Math.floor(lat - 0.5);
      w.hi = Math.ceil(lat + 0.5);
      if (off > PAVE_OUT + 2 || off < EDGE_IN - 3) (w.lo = 9), (w.hi = 9);
    }
  }
  checkContacts() {
    const P = this.physics,
      pp = P.body.translation();
    for (const car of this.cars) {
      const dx = car.pos.x - pp.x,
        dz = car.pos.z - pp.z;
      if (dx * dx + dz * dz > 30 * 30) continue;
      let hit = false;
      P.world.contactPair(P.chassis, car.collider, (m) => {
        if (m.numSolverContacts() || m.numContacts()) hit = true;
      });
      if (hit) this.wreck(car);
    }
    // Chain reactions near the player: wrecks shoving traffic.
    for (const a of this.cars) {
      if (!a.wreck || a.wreck.t > 20) continue;
      for (const b of this.cars) {
        if (b === a || b.wreck) continue;
        const dx = a.pos.x - b.pos.x,
          dz = a.pos.z - b.pos.z;
        if (dx * dx + dz * dz > 22 * 22) continue;
        let hit = false;
        P.world.contactPair(a.collider, b.collider, (m) => {
          if (m.numContacts()) hit = true;
        });
        if (hit) this.wreck(b);
      }
    }
  }
  clearWrecks(ps) {
    for (const car of [...this.cars]) {
      if (!car.wreck || car.wreck.t < 40) continue;
      const pp = this.physics.body.translation();
      if (Math.hypot(car.pos.x - pp.x, car.pos.z - pp.z) < 260) continue;
      // Tow it: back to a kinematic car somewhere out of sight.
      car.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      car.wreck = null;
      car.quat = null;
      car.sig = 0;
      car.dir = Math.random() < 0.5 ? 1 : -1;
      this.placeOnMain(car, car.dir, ps + AHEAD * car.dir, car.truck ? 0 : 1);
    }
  }
  // ---------------------------------------------------------------- audio
  honk(car) {
    const a = this.audio;
    if (!a?.ctx || !a.enabled) return;
    try {
      const c = a.ctx,
        t = c.currentTime,
        g = new GainNode(c, { gain: 0 }),
        f = new BiquadFilterNode(c, { type: "lowpass", frequency: 1800 });
      const base = car.truck ? 220 : 380 + Math.random() * 80;
      for (const m of [1, 1.26]) {
        const o = new OscillatorNode(c, { type: "square", frequency: base * m });
        o.connect(f);
        o.start(t);
        o.stop(t + (car.truck ? 1.1 : 0.55));
      }
      f.connect(g);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(car.truck ? 0.08 : 0.05, t + 0.02);
      g.gain.setValueAtTime(car.truck ? 0.08 : 0.05, t + (car.truck ? 1.0 : 0.45));
      g.gain.linearRampToValueAtTime(0, t + (car.truck ? 1.1 : 0.55));
      a.route(g, { x: car.pos.x, y: 1, z: car.pos.z }, 0.15);
    } catch {}
  }
  // Tyre/wind whoosh for the nearest cars.
  initAudio() {
    const a = this.audio;
    if (!a?.ctx || this.voices) return;
    const c = a.ctx;
    this.voices = [];
    for (let i = 0; i < 6; i++) {
      const src = a.noiseSource(0.7 + i * 0.05),
        bp = new BiquadFilterNode(c, { type: "bandpass", frequency: 700, Q: 0.6 }),
        g = new GainNode(c, { gain: 0 }),
        pan = a.panner();
      src.connect(bp).connect(g).connect(pan).connect(a.occlusion);
      this.voices.push({ g, pan, bp });
    }
  }
  updateAudio(playerPos) {
    const a = this.audio;
    if (!a?.ctx || !a.enabled) return;
    this.initAudio();
    const near = this.cars
      .map((c) => ({ c, d: c.pos.distanceToSquared(playerPos) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, this.voices.length);
    const t = a.ctx.currentTime;
    this.voices.forEach((v, i) => {
      const n = near[i];
      if (!n || !this.active) return v.g.gain.setTargetAtTime(0, t, 0.2);
      const speed = n.c.wreck ? 0 : n.c.v;
      a.place(v.pan, n.c.pos);
      v.g.gain.setTargetAtTime(Math.min(0.5, (speed / 30) ** 2 * (n.c.truck ? 0.5 : 0.28)), t, 0.1);
      v.bp.frequency.setTargetAtTime(300 + speed * 18, t, 0.2);
    });
  }
  // --------------------------------------------------------------- render
  render(alpha) {
    const m = new T.Matrix4(),
      q = new T.Quaternion(),
      e = new T.Euler(),
      p = new T.Vector3(),
      one = new T.Vector3(1, 1, 1),
      zero = new T.Matrix4().makeScale(0, 0, 0);
    const blink = Math.sin(this.time * Math.PI * 2 * 1.5) > 0;
    for (const car of this.cars) {
      const parts = this.meshes[car.type].parts;
      if (car.wreck && car.quat) {
        p.copy(car.pos);
        q.copy(car.quat);
      } else {
        p.lerpVectors(car.prev, car.pos, alpha);
        let dy = car.yaw - car.prevYaw;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        q.setFromEuler(e.set(0, car.prevYaw + dy * alpha, car.pitch, "YXZ"));
      }
      m.compose(p, q, one);
      for (const [name, im] of Object.entries(parts)) {
        let on = true;
        if (name === "brake") on = car.brakeOn;
        else if (name === "indL") on = blink && (car.sig === -1 || car.sig === 2);
        else if (name === "indR") on = blink && (car.sig === 1 || car.sig === 2);
        im.setMatrixAt(car.idx, on ? m : zero);
      }
    }
    for (const t of Object.values(this.meshes))
      for (const im of Object.values(t.parts)) {
        im.count = t.used;
        im.instanceMatrix.needsUpdate = true;
      }
  }
  setActive(on, ps) {
    this.active = on;
    this.group.visible = on;
    if (on && !this.cars.length) this.spawnInitial(ps);
    if (!on)
      for (const car of this.cars)
        if (!car.wreck) car.body.setNextKinematicTranslation({ x: car.pos.x, y: -500, z: car.pos.z });
  }
  dispose() {
    this.scene.remove(this.group);
    for (const c of [...this.cars]) this.physics.world.removeRigidBody(c.body);
    for (const d of this.disposables) d.dispose?.();
  }
}
