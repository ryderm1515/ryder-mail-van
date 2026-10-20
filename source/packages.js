import * as T from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

// Parcels in the cargo bay: plain kraft boxes and white poly mailers (no
// branding). They sit on the folding shelves and in a pile by the bulkhead.
// Fold a shelf up and its parcels hop, spin and pop out of existence one by
// one ("delivered"); fold it back down and they bounce back in.

const KRAFT = [0xc59a63, 0xb98d57, 0xcfa673],
  TAPE = 0xdcc49a,
  BAG = [0xf3f2ee, 0xeceae4];

const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const back = (x) => {
  x = Math.min(1, Math.max(0, x));
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};

export class Packages {
  constructor({ rig, vehicle, toon, audio }) {
    this.rig = rig;
    this.vehicle = vehicle;
    this.toon = toon;
    this.audio = audio;
    this.group = new T.Group();
    this.group.name = "Parcels";
    this.items = [];
    this.groups = {};
    this.puffs = [];
    this.mats = {};
    this.disposables = [];
    this.vel = new T.Vector3();
    this.lastVel = null;
    this.sway = new T.Vector3();
    this.swayV = new T.Vector3();
  }
  mat(color) {
    if (!this.mats[color]) {
      const m = this.toon(new T.MeshToonMaterial({ color }));
      this.mats[color] = m;
      this.disposables.push(m);
    }
    return this.mats[color];
  }
  geo(g) {
    this.disposables.push(g);
    return g;
  }
  box(w, h, d, r) {
    const g = new T.Group();
    const body = new T.Mesh(this.geo(new RoundedBoxGeometry(w, h, d, 2, Math.min(0.012, h * 0.2))), this.mat(KRAFT[Math.floor(r() * KRAFT.length)]));
    const tape = new T.Mesh(this.geo(new T.BoxGeometry(w + 0.004, 0.003, Math.min(0.055, d * 0.3))), this.mat(TAPE));
    tape.position.y = h / 2;
    const tapeSide = new T.Mesh(this.geo(new T.BoxGeometry(0.003, h * 0.35, Math.min(0.055, d * 0.3))), this.mat(TAPE));
    tapeSide.position.set(w / 2, h / 2 - h * 0.175, 0);
    const tapeSide2 = tapeSide.clone();
    tapeSide2.position.x = -w / 2;
    // A blank shipping label.
    const label = new T.Mesh(this.geo(new T.BoxGeometry(w * 0.32, 0.002, d * 0.26)), this.mat(0xfbfbf8));
    label.position.set(w * 0.2, h / 2 + 0.002, -d * 0.24);
    g.add(body, tape, tapeSide, tapeSide2, label);
    return { obj: g, h };
  }
  bag(w, d, r) {
    // A soft, slightly lumpy poly mailer.
    const h = 0.05 + r() * 0.03;
    const geo = new RoundedBoxGeometry(w, h, d, 4, h * 0.45);
    const p = geo.attributes.position,
      v = new T.Vector3(),
      s = r() * 10;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const n = Math.sin(v.x * 23 + s) * Math.cos(v.z * 19 - s) * 0.006 + Math.sin(v.x * 51 + v.z * 37) * 0.002;
      v.y += v.y > 0 ? n : -n * 0.3;
      // Pillow: thicker in the middle.
      v.y *= 1 + 0.35 * (1 - Math.min(1, (Math.abs(v.x) / (w / 2)) ** 2 + (Math.abs(v.z) / (d / 2)) ** 2));
      p.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const g = new T.Group();
    g.add(new T.Mesh(this.geo(geo), this.mat(BAG[Math.floor(r() * BAG.length)])));
    // The fold-over flap seam.
    const seam = new T.Mesh(this.geo(new T.BoxGeometry(0.004, 0.002, d * 0.92)), this.mat(0xd9d8d2));
    seam.position.set(w / 2 - 0.035, h * 0.6, 0);
    g.add(seam);
    return { obj: g, h: h * 1.2 };
  }
  // Shelf top surface in the van's frame, from the rubber liner mesh.
  surface(bone) {
    const meshes = this.rig.meshes.filter((m) => m.userData.bone === bone && /nonslip/i.test(m.material.userData?.source || ""));
    if (!meshes.length) return null;
    const inv = this.vehicle.matrixWorld.clone().invert(),
      box = new T.Box3(),
      v = new T.Vector3();
    for (const m of meshes) {
      const M = m.matrixWorld.clone().premultiply(inv),
        a = m.geometry.attributes.position;
      for (let i = 0; i < a.count; i++) {
        v.fromBufferAttribute(a, i);
        if (v.lengthSq() === 0) continue;
        box.expandByPoint(v.applyMatrix4(M));
      }
    }
    return box.isEmpty() ? null : box;
  }
  place(key, item, x, y, z, yaw, r) {
    item.obj.position.set(x, y + item.h / 2, z);
    item.obj.rotation.y = yaw;
    item.obj.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });
    this.group.add(item.obj);
    const rec = { key, obj: item.obj, h: item.h, home: item.obj.position.clone(), yaw, spin: (r() - 0.5) * 6, delay: 0, state: 1, t: 1, mode: "in" };
    (this.groups[key] ||= []).push(rec);
    this.items.push(rec);
    return rec;
  }
  build() {
    this.vehicle.updateMatrixWorld(true);
    this.rig.update(0, true);
    const r = rng(11);
    for (const key of ["SHELF_L_1", "SHELF_L_2", "SHELF_R_1", "SHELF_R_2"]) {
      const b = this.surface(key);
      if (!b) continue;
      const y = b.max.y + 0.002,
        zc = (b.min.z + b.max.z) / 2,
        depth = b.max.z - b.min.z;
      let x = b.min.x + 0.06;
      while (x < b.max.x - 0.2) {
        const isBag = r() < 0.35,
          w = isBag ? 0.26 + r() * 0.08 : 0.16 + r() * 0.16;
        if (x + w > b.max.x - 0.04) break;
        const d = Math.min(depth - 0.08, isBag ? 0.2 + r() * 0.06 : 0.16 + r() * 0.12);
        const it = isBag ? this.bag(w, d, r) : this.box(w, 0.1 + r() * 0.16, d, r);
        this.place(key, it, x + w / 2, y, zc + (r() - 0.5) * (depth - d - 0.04), (r() - 0.5) * 0.2, r);
        // Now and then a mailer rides on top of a box.
        if (!isBag && r() < 0.3) {
          const top = this.bag(Math.min(0.26, w + 0.06), Math.min(d, 0.2), r);
          this.place(key, top, x + w / 2, y + it.h, zc, (r() - 0.5) * 0.6, r);
        }
        x += w + 0.03 + r() * 0.05;
      }
    }
    // A loose pile on the floor against the bulkhead, passenger corner.
    // In the aisle, tucked against the passenger-side shelving.
    const floor = this.surface("SHELF_L_1"),
      fz = floor ? floor.max.z + 0.02 : -0.42;
    const fx = floor ? floor.min.x + (floor.max.x - floor.min.x) * 0.38 : 0.8;
    const pile = [
      [0.34, 0.24, 0.3, 0, 0],
      [0.28, 0.18, 0.22, 0.36, 0.05],
      [0.22, 0.16, 0.2, 0.06, 0.24],
    ];
    for (const [w, h, d, dx, dz] of pile) {
      const it = this.box(w, h, d, r);
      this.place("FLOOR", it, fx + w / 2 + dx, -0.075, fz + d / 2 + dz, (r() - 0.5) * 0.4, r);
    }
    const top = this.bag(0.3, 0.24, r);
    this.place("FLOOR", top, fx + 0.17, -0.075 + 0.24, fz + 0.16, 0.5, r);
    const lone = this.bag(0.3, 0.22, r);
    this.place("FLOOR", lone, fx + 0.5, -0.075, fz + 0.4, -0.3, r);
    this.vehicle.add(this.group);
    // Shared bits for the "delivered" effect.
    this.ringGeo = this.geo(new T.RingGeometry(0.7, 1, 40));
    this.ringGeo.rotateX(-Math.PI / 2);
    this.fleckGeo = this.geo(new T.PlaneGeometry(0.026, 0.018));
  }
  // A soft ring on the shelf and a few paper flecks drifting up.
  flourish(rec, idx) {
    const c = rec.home.clone();
    const ring = new T.Mesh(this.ringGeo, new T.MeshBasicMaterial({ color: 0xf6ead6, transparent: true, opacity: 0.7, depthWrite: false, side: T.DoubleSide }));
    ring.position.copy(c).setY(c.y - rec.h / 2 + 0.004);
    ring.scale.setScalar(0.05);
    ring.userData = { kind: "ring", life: 0, dur: 0.6 };
    this.group.add(ring);
    this.puffs.push(ring);
    for (let i = 0; i < 6; i++) {
      const m = new T.Mesh(this.fleckGeo, new T.MeshBasicMaterial({ color: i % 2 ? 0xfaf8f2 : 0xd8b27a, transparent: true, depthWrite: false, side: T.DoubleSide }));
      m.position.copy(c);
      const a = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
      m.userData = { kind: "fleck", life: 0, dur: 0.9 + Math.random() * 0.3, v: new T.Vector3(Math.cos(a) * 0.22, 0.35 + Math.random() * 0.2, Math.sin(a) * 0.22), spin: new T.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8) };
      this.group.add(m);
      this.puffs.push(m);
    }
    // A soft rising pluck: each parcel one step up a pentatonic scale, so a
    // whole shelf plays a gentle little arpeggio instead of a beep.
    try {
      const notes = [392, 440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5];
      const f = notes[Math.min(notes.length - 1, idx)];
      const at = c.clone().applyMatrix4(this.vehicle.matrixWorld);
      this.audio?.ping?.({ at, freq: f, dur: 0.32, gain: 0.016, reverb: 0.35 });
      this.audio?.ping?.({ at, freq: f * 2, dur: 0.14, gain: 0.004, reverb: 0.2 });
    } catch {}
  }
  setGroup(key, present) {
    const list = this.groups[key] || [];
    // One after another along the shelf.
    list.forEach((rec, i) => {
      const want = present ? "in" : "out";
      if (rec.mode === want) return;
      rec.mode = want;
      rec.t = 0;
      rec.idx = i;
      rec.fired = false;
      rec.delay = i * (present ? 0.07 : 0.12);
    });
  }
  update(dt, accel = null) {
    for (const key of ["SHELF_L_1", "SHELF_L_2", "SHELF_R_1", "SHELF_R_2"]) {
      const fold = this.rig.get(key, "Fold") || 0;
      if (fold > 0.06 && this.groups[key]?.[0]?.mode === "in") this.setGroup(key, false);
      if (fold < 0.02 && this.groups[key]?.[0]?.mode === "out") this.setGroup(key, true);
    }
    // Floor parcels lean against the van's acceleration (a spring, so they settle).
    if (accel) {
      const k = 40,
        c = 7;
      this.swayV.addScaledVector(this.sway, -k * dt).addScaledVector(this.swayV, -c * dt).addScaledVector(accel, -dt * 0.004);
      this.sway.addScaledVector(this.swayV, dt);
      this.sway.clampLength(0, 0.03);
    }
    for (const rec of this.items) {
      if (rec.delay > 0) {
        rec.delay -= dt;
        continue;
      }
      const o = rec.obj;
      if (rec.mode === "out") {
        if (rec.t >= 1) continue;
        rec.t = Math.min(1, rec.t + dt / 0.85);
        const u = rec.t;
        // Squash, lift off with a little stretch and tilt, then fold away to nothing.
        const squash = u < 0.16 ? Math.sin((u / 0.16) * Math.PI) : 0;
        const lift = ease((u - 0.12) / 0.5) * 0.11 + ease((u - 0.6) / 0.4) * 0.05;
        const vanish = 1 - ease((u - 0.58) / 0.42);
        o.position.copy(rec.home).add(new T.Vector3(0, lift - squash * 0.008, 0));
        o.rotation.set(Math.sin(u * Math.PI) * 0.12, rec.yaw + rec.spin * 0.25 * ease((u - 0.1) / 0.9), Math.sin(u * Math.PI * 1.3) * 0.08);
        const sy = (1 - squash * 0.14 + (u > 0.16 && u < 0.6 ? 0.06 * Math.sin(((u - 0.16) / 0.44) * Math.PI) : 0)) * vanish,
          sxz = (1 + squash * 0.07) * vanish;
        o.scale.set(Math.max(1e-4, sxz), Math.max(1e-4, sy), Math.max(1e-4, sxz));
        if (!rec.fired && u >= 0.62) {
          rec.fired = true;
          this.flourish(rec, rec.idx || 0);
        }
        o.visible = u < 1;
      } else {
        if (rec.t >= 1) {
          if (rec.key === "FLOOR") o.position.copy(rec.home).add(this.sway);
          continue;
        }
        rec.t = Math.min(1, rec.t + dt / 0.6);
        const u = rec.t;
        o.visible = true;
        // Drop back onto the shelf and settle with a small squash.
        const fall = Math.min(1, u / 0.55),
          land = u > 0.55 ? (u - 0.55) / 0.45 : 0;
        const y = (1 - fall * fall) * 0.22;
        o.position.copy(rec.home).add(new T.Vector3(0, y, 0));
        o.rotation.set(0, rec.yaw, 0);
        const grow = ease(u / 0.35);
        const sq = land > 0 ? Math.sin(land * Math.PI) * 0.12 * (1 - land) : 0;
        o.scale.set(grow * (1 + sq * 0.6), grow * (1 - sq), grow * (1 + sq * 0.6));
        if (!rec.fired && u >= 0.55) {
          rec.fired = true;
          try {
            const at = rec.home.clone().applyMatrix4(this.vehicle.matrixWorld);
            this.audio?.ping?.({ at, freq: 196 + (rec.idx || 0) * 12, dur: 0.09, gain: 0.012, type: "triangle", reverb: 0.1 });
          } catch {}
        }
      }
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const m = this.puffs[i],
        d = m.userData;
      d.life += dt;
      const l = Math.min(1, d.life / d.dur);
      if (d.kind === "ring") {
        m.scale.setScalar(0.05 + ease(l) * 0.22);
        m.material.opacity = 0.7 * (1 - l);
      } else {
        m.position.addScaledVector(d.v, dt);
        d.v.y -= dt * 0.35;
        d.v.x *= 1 - dt * 2;
        d.v.z *= 1 - dt * 2;
        m.rotation.x += d.spin.x * dt;
        m.rotation.y += d.spin.y * dt;
        m.rotation.z += d.spin.z * dt;
        m.material.opacity = l < 0.6 ? 1 : 1 - (l - 0.6) / 0.4;
      }
      if (l >= 1) {
        this.group.remove(m);
        m.material.dispose();
        this.puffs.splice(i, 1);
      }
    }
  }
}
