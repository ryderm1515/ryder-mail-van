import * as T from "three";
import { RAPIER } from "./physics.js";
import { SoftBody } from "./softbody.js";
import { DamageField } from "./deform.js";

// Breakable parts. Each one watches the lattice at its anchor: it separates when
// local deformation passes `disp` metres, or when the velocity change delivered
// near it in a short window passes `kick` m/s (glancing blows snap mirrors off
// without crushing the body).
const PARTS = [
  { label: "Front bumper", pattern: /^Sculpted front impact bumper|^Bumper parking sensor|^Bumper upper parting line/, disp: 0.09, kick: 5.5, mass: 22 },
  { label: "Grille", pattern: /^Grille/, disp: 0.13, kick: 8, mass: 6 },
  { label: "Left headlamp", pattern: /^Convex projector lens|^Projector chrome bowl|^Projector optical center|^Headlamp lens seal|^Swept headlight black bezel|^Corner turn signal/, side: -1, disp: 0.07, kick: 4.5, mass: 3 },
  { label: "Right headlamp", pattern: /^Convex projector lens|^Projector chrome bowl|^Projector optical center|^Headlamp lens seal|^Swept headlight black bezel|^Corner turn signal/, side: 1, disp: 0.07, kick: 4.5, mass: 3 },
  { label: "Hood", bone: "HOOD", disp: 0.27, kick: 11, mass: 38 },
  { label: "Left mirror", bone: "MIRROR_L", disp: 0.1, kick: 3, mass: 3 },
  { label: "Right mirror", bone: "MIRROR_R", disp: 0.1, kick: 3, mass: 3 },
  { label: "Left door", bone: "DOOR_L", disp: 0.26, kick: 10, mass: 42 },
  { label: "Right door", bone: "DOOR_R", disp: 0.26, kick: 10, mass: 42 },
  { label: "Rear bumper", pattern: /^Rear step bumper|^Rear step grip|^Step grip tooth|^Step recess/, end: 1, disp: 0.1, kick: 5.5, mass: 25 },
  { label: "Left tail lamp", pattern: /^Rear lamp domed lens|^Rear lamp recessed surround|^Rear lens flute/, side: -1, disp: 0.07, kick: 4.5, mass: 2 },
  { label: "Right tail lamp", pattern: /^Rear lamp domed lens|^Rear lamp recessed surround|^Rear lens flute/, side: 1, disp: 0.07, kick: 4.5, mass: 2 },
  { label: "Left step", pattern: /^Aluminum running step/, side: -1, disp: 0.1, kick: 6.5, mass: 9 },
  { label: "Right step", pattern: /^Aluminum running step/, side: 1, disp: 0.1, kick: 6.5, mass: 9 },
  { label: "Front left mud flap", pattern: /^Flexible wheel mud flap/, side: -1, end: -1, disp: 0.09, kick: 4, mass: 2 },
  { label: "Front right mud flap", pattern: /^Flexible wheel mud flap/, side: 1, end: -1, disp: 0.09, kick: 4, mass: 2 },
  { label: "Rear left mud flap", pattern: /^Flexible wheel mud flap/, side: -1, end: 1, disp: 0.09, kick: 4, mass: 2 },
  { label: "Rear right mud flap", pattern: /^Flexible wheel mud flap/, side: 1, end: 1, disp: 0.09, kick: 4, mass: 2 },
  ...[0, 1, 2, 3, 4].map((i) => ({
    label: "Shutter slat " + (i + 1),
    bone: "MCH_SLAT_" + String(i).padStart(2, "0"),
    disp: 0.17 + i * 0.03,
    kick: 7.5,
    mass: 8,
  })),
];

const GLASS = [
  { label: "Windshield", pattern: /^Curved panoramic laminated windshield/, disp: 0.075, kick: 7.5, shards: 260 },
  { label: "Left window", bone: "WINDOW_L", disp: 0.13, kick: 5.5, shards: 90 },
  { label: "Right window", bone: "WINDOW_R", disp: 0.13, kick: 5.5, shards: 90 },
];

// Wheels, hubs and the running gear stay rigid; everything else bends with the body.
const RIGID = /^(WHEEL_|MCH_SPIN|MCH_AXLE|HUBCAP|LUG_|MCH_STEER|MCH_DAMPER|DRIVE$)/;

export class VehicleDamage {
  constructor(scene, rig, physics, vehicle, audio, plainMaterial) {
    Object.assign(this, { scene, rig, physics, vehicle, audio, plainMaterial });
    this.debris = [];
    this.hidden = [];
    this.detached = new Set();
    this.health = { front: 1, rear: 1, left: 1, right: 1, roof: 1 };
    this.base = new Map();
    this.baseNormals = new Map();
    this.lastImpact = 0;
    this.notice = () => {};
    this.level = 0;
    this.meshSpecs = new Map(rig.meshes.map((m, i) => [m, rig.data.meshes[i]]));
    this.v4 = new T.Vector4();
    this.tmp = new T.Vector3();
    vehicle.updateMatrixWorld(true);
    rig.root.updateMatrixWorld(true);
    this.toBody = new T.Matrix4().copy(vehicle.matrixWorld).invert();
    this.buildLattice();
    this.field = new DamageField(this.soft);
    physics.soft = this.soft;
    // Every deformable mesh shares the GPU field; wheels and hubs stay rigid.
    for (const m of rig.meshes) {
      const spec = this.meshSpecs.get(m);
      if (RIGID.test(spec.bone)) {
        m.material = plainMaterial(m.material);
        if (!m.material.userData.explodes) this.field.patchExplode(m.material);
        if (m.castShadow) m.customDepthMaterial = this.field.depthRigid;
        continue;
      }
      if (!m.material.userData.deforms) this.field.patch(m.material);
      if (m.castShadow) m.customDepthMaterial = this.field.depth;
    }
    this.indexRanges();
    this.parts = PARTS.map((p) => ({ ...p, anchor: this.anchorFor(p) })).filter((p) => p.anchor);
    this.glass = GLASS.map((g) => ({ ...g, anchor: this.anchorFor(g), samples: this.samplesFor(g) })).filter(
      (g) => g.anchor,
    );
    this.wheelMounts = physics.wheels.map((w) => new T.Vector3(w[1], 0.1, w[2] * 0.82));
    this.engine = new T.Vector3(-2.15, 0.35, 0);
    this.shards = new ShardField(scene, physics);
    this.shards.onBounce = (p) => audio.tinkle(p);
    this.appliedShape = null;
  }
  buildLattice() {
    // Fit the lattice to the actual van surface in body space.
    const box = new T.Box3(),
      b = new T.Box3();
    for (const m of this.rig.meshes) {
      const spec = this.meshSpecs.get(m);
      // Mirrors stick far out sideways; leaving them out keeps lattice nodes on the body skin.
      if (RIGID.test(spec.bone) || /^MIRROR/.test(spec.bone) || m.material.transparent) continue;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      b.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld).applyMatrix4(this.toBody);
      box.union(b);
    }
    box.expandByScalar(0.06);
    this.box = box;
    const size = box.getSize(new T.Vector3()),
      res = [
        Math.max(8, Math.round(size.x / 0.38) + 1),
        Math.max(5, Math.round(size.y / 0.38) + 1),
        Math.max(5, Math.round(size.z / 0.4) + 1),
      ];
    // Structural zoning. Front is -X, roof is +Y, left is -Z.
    const zone = (p, u, v, w) => {
      const edge = Math.min(w, 1 - w) < 0.12,
        z = { stiffness: 0.5, yield: 0.022, mass: 1, response: 1 };
      if (u < 0.09) Object.assign(z, { stiffness: 0.3, yield: 0.012, response: 1.15 }); // bumper and nose
      else if (u < 0.2) Object.assign(z, { stiffness: 0.42, yield: 0.016, response: 1.05 }); // engine bay crumple zone
      else if (u < 0.36) Object.assign(z, { stiffness: edge && v > 0.35 ? 0.78 : 0.6, yield: 0.03 }); // cab cage and pillars
      else if (u > 0.95) Object.assign(z, { stiffness: 0.36, yield: 0.014, response: 1.1 }); // rear bumper
      else Object.assign(z, { stiffness: 0.48, yield: edge ? 0.026 : 0.019 }); // cargo box panels
      if (v < 0.16) Object.assign(z, { stiffness: 0.92, yield: 0.055, mass: 2.4, response: 0.55 }); // ladder frame
      if (v > 0.9) Object.assign(z, { yield: z.yield * 0.85, response: 1.25 }); // roof skin
      return z;
    };
    this.soft = new SoftBody(box.min, box.max, res, zone);
  }
  indexRanges() {
    this.ranges = [];
    const p = new T.Vector3();
    for (const m of this.rig.meshes) {
      const spec = this.meshSpecs.get(m);
      if (!spec.ranges) continue;
      if (!PARTS.concat(GLASS).some((x) => x.pattern && spec.ranges.some((r) => x.pattern.test(r.object))))
        continue;
      const a = m.geometry.attributes.position.array,
        toBody = new T.Matrix4().multiplyMatrices(this.toBody, m.matrixWorld);
      for (const r of spec.ranges) {
        const box = new T.Box3();
        for (let i = r.start; i < r.start + r.count; i++)
          box.expandByPoint(p.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).applyMatrix4(toBody));
        this.ranges.push({ mesh: m, range: r, box, center: box.getCenter(new T.Vector3()) });
      }
    }
  }
  matching(part) {
    const midX = (this.box.min.x + this.box.max.x) / 2;
    return this.ranges.filter(
      (r) =>
        part.pattern.test(r.range.object) &&
        (!part.side || Math.sign(r.center.z) === part.side) &&
        (!part.end || Math.sign(r.center.x - midX) === part.end),
    );
  }
  anchorFor(part) {
    if (part.bone) {
      const b = this.rig.bones[part.bone];
      if (!b) return null;
      const box = new T.Box3();
      b.pose.traverse((o) => {
        if (!o.isMesh) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld).applyMatrix4(this.toBody));
      });
      return box.isEmpty() ? null : box.getCenter(new T.Vector3());
    }
    const list = this.matching(part);
    if (!list.length) return null;
    const box = new T.Box3();
    for (const r of list) box.union(r.box);
    return box.getCenter(new T.Vector3());
  }
  samplesFor(part) {
    const box = new T.Box3();
    if (part.bone) {
      this.rig.bones[part.bone]?.pose.traverse((o) => {
        if (o.isMesh)
          box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld).applyMatrix4(this.toBody));
      });
    } else for (const r of this.matching(part)) box.union(r.box);
    if (box.isEmpty()) return [];
    const out = [box.getCenter(new T.Vector3())];
    for (let i = 0; i < 8; i++)
      out.push(
        new T.Vector3(
          T.MathUtils.lerp(box.min.x, box.max.x, i & 1 ? 0.85 : 0.15),
          T.MathUtils.lerp(box.min.y, box.max.y, i & 2 ? 0.85 : 0.15),
          T.MathUtils.lerp(box.min.z, box.max.z, i & 4 ? 0.85 : 0.15),
        ),
      );
    return out;
  }
  repair() {
    for (const d of this.debris) {
      this.scene.remove(d.group);
      this.physics.world.removeRigidBody(d.body);
      this.physics.untrack(d.track);
      d.group.traverse((o) => {
        if (o.isMesh) o.geometry.dispose();
      });
    }
    this.debris = [];
    for (const n of this.hidden) n.visible = true;
    this.hidden = [];
    this.detached.clear();
    for (const [m, base] of this.base) {
      m.geometry.attributes.position.array.set(base);
      m.geometry.attributes.position.needsUpdate = true;
      m.geometry.attributes.normal.array.set(this.baseNormals.get(m));
      m.geometry.attributes.normal.needsUpdate = true;
      m.geometry.computeBoundingSphere();
    }
    this.health = { front: 1, rear: 1, left: 1, right: 1, roof: 1 };
    this.level = 0;
    this.soft.reset();
    this.shards.clear();
    this.appliedShape = null;
    this.physics.repair();
  }
  remember(m) {
    if (this.base.has(m)) return;
    this.base.set(m, m.geometry.attributes.position.array.slice());
    this.baseNormals.set(m, m.geometry.attributes.normal.array.slice());
  }
  // Remove a set of ranges from the body mesh and return them as stand-alone meshes.
  cutRanges(list) {
    const pieces = [];
    for (const { mesh: m, range: r } of list) {
      const g = new T.BufferGeometry(),
        a = m.geometry.attributes;
      g.setAttribute("position", new T.BufferAttribute(a.position.array.slice(r.start * 3, (r.start + r.count) * 3), 3));
      g.setAttribute("normal", new T.BufferAttribute(a.normal.array.slice(r.start * 3, (r.start + r.count) * 3), 3));
      const piece = new T.Mesh(g, m.material);
      piece.matrixWorld.copy(m.matrixWorld);
      pieces.push(piece);
      this.remember(m);
      a.position.array.fill(0, r.start * 3, (r.start + r.count) * 3);
      a.position.needsUpdate = true;
    }
    return pieces;
  }
  detach(part) {
    if (this.detached.has(part.label)) return;
    this.rig.root.updateWorldMatrix(true, true);
    let meshes;
    if (part.bone) {
      const pose = this.rig.bones[part.bone]?.pose;
      if (!pose || !pose.visible) return;
      meshes = [];
      pose.traverse((o) => {
        if (o.isMesh && o.visible) meshes.push(o);
      });
      if (!meshes.length) return;
      this.detachMeshes(meshes, part.mass);
      pose.visible = false;
      this.hidden.push(pose);
    } else {
      const pieces = this.cutRanges(this.matching(part));
      if (!pieces.length) return;
      this.detachMeshes(pieces, part.mass);
      for (const p of pieces) p.geometry.dispose();
    }
    this.detached.add(part.label);
  }
  // Kept for wheel separation, which is driven by suspension damage.
  detachBone(name, mass = 20) {
    this.detach({ label: name, bone: name, mass });
  }
  detachMeshes(meshes, mass) {
    const box = new T.Box3();
    for (const m of meshes) {
      m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld));
    }
    const center = box.getCenter(new T.Vector3()),
      size = box.getSize(new T.Vector3());
    if (!Number.isFinite(center.x)) return;
    const group = new T.Group();
    group.position.copy(center);
    this.scene.add(group);
    group.updateMatrixWorld(true);
    const inv = group.matrixWorld.clone().invert(),
      bodyInv = this.vehicle.matrixWorld.clone().invert(),
      toBody = new T.Matrix4();
    for (const m of meshes) {
      const geometry = m.geometry.clone();
      geometry.deleteAttribute("aPart");
      // Bake the crumple into the debris so the part keeps its damage in flight.
      toBody.multiplyMatrices(bodyInv, m.matrixWorld);
      if (m.material.userData.deforms) this.field.bake(geometry, toBody);
      const clone = new T.Mesh(geometry, this.plainMaterial(m.material));
      new T.Matrix4().multiplyMatrices(inv, m.matrixWorld).decompose(clone.position, clone.quaternion, clone.scale);
      clone.castShadow = true;
      clone.receiveShadow = true;
      group.add(clone);
    }
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(center.x, center.y, center.z)
        .setCcdEnabled(true)
        .setLinearDamping(0.12)
        .setAngularDamping(0.18),
    );
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(Math.max(0.05, size.x / 2), Math.max(0.05, size.y / 2), Math.max(0.05, size.z / 2))
        .setMass(mass)
        .setCollisionGroups(0x0002fffe)
        .setFriction(0.6)
        .setRestitution(0.12),
      body,
    );
    const v = this.physics.body.linvel(),
      av = this.physics.body.angvel(),
      offset = center.clone().sub(this.vehicle.position),
      spin = new T.Vector3(av.x, av.y, av.z).cross(offset),
      fling = offset.clone().setY(0).normalize().multiplyScalar(1.2 + Math.random() * 1.6);
    body.setLinvel({ x: v.x + spin.x + fling.x, y: v.y + spin.y + 1.4 + Math.random(), z: v.z + spin.z + fling.z }, true);
    body.setAngvel(
      { x: av.x + (Math.random() - 0.5) * 6, y: av.y + (Math.random() - 0.5) * 6, z: av.z + (Math.random() - 0.5) * 6 },
      true,
    );
    const track = this.physics.track(body);
    this.debris.push({ group, body, track, mass, lastV: null, lastHit: 0 });
    this.audio.tear(center.clone(), mass);
  }
  shatter(g) {
    if (this.detached.has(g.label)) return;
    this.detached.add(g.label);
    this.rig.root.updateWorldMatrix(true, true);
    const sources = [];
    if (g.bone) {
      const pose = this.rig.bones[g.bone]?.pose;
      if (!pose || !pose.visible) return;
      pose.traverse((o) => {
        if (o.isMesh && o.visible) sources.push({ mesh: o, start: 0, count: o.geometry.attributes.position.count });
      });
      pose.visible = false;
      this.hidden.push(pose);
    } else
      for (const r of this.matching(g)) {
        sources.push({ mesh: r.mesh, start: r.range.start, count: r.range.count, cut: r });
      }
    const p = new T.Vector3(),
      d = new T.Vector3(),
      bodyToWorld = this.vehicle.matrixWorld,
      bodyInv = bodyToWorld.clone().invert(),
      v = this.physics.body.linvel(),
      base = new T.Vector3(v.x, v.y, v.z);
    const total = sources.reduce((s, x) => s + x.count, 0);
    for (const s of sources) {
      const a = s.mesh.geometry.attributes.position.array,
        toBody = new T.Matrix4().multiplyMatrices(bodyInv, s.mesh.matrixWorld),
        n = Math.max(6, Math.round((g.shards * s.count) / total));
      for (let k = 0; k < n; k++) {
        const i = s.start + Math.floor(Math.random() * s.count);
        p.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).applyMatrix4(toBody);
        p.add(this.field.field(p, d)).applyMatrix4(bodyToWorld);
        this.shards.spawn(p, base);
      }
    }
    for (const s of sources) if (s.cut) this.cutRanges([s.cut]);
    this.audio.glass(g.anchor.clone().applyMatrix4(bodyToWorld), g.shards / 160);
  }
  impact(event) {
    if (event.severity < 1.1) return;
    const p = event.point || this.vehicle.position;
    this.audio.crash(event.severity, { x: p.x, y: p.y, z: p.z });
    this.onImpact?.(event.severity);
    this.lastImpact = event.time;
    this.notice("Impact · " + Math.round(event.speed * 3.6) + " km/h");
  }
  // Velocity change delivered at a part over the last quarter second.
  kickNear(anchor, now) {
    let sum = 0;
    for (const ev of this.soft.kicks)
      if (now - ev.time <= 0.25) sum += ev.dv * this.soft.influence(ev, anchor.x, anchor.y, anchor.z);
    return sum;
  }
  // Rendering hook: per frame, after physics.
  update(dt = 1 / 60) {
    for (const e of this.physics.consumeImpacts()) this.impact(e);
    const soft = this.soft,
      now = this.physics.elapsed;
    soft.kicks = soft.kicks.filter((k) => now - k.time < 0.3);
    if (soft.version !== this.lastVersion) {
      this.lastVersion = soft.version;
      this.evaluate(now);
    }
    this.field.update(this.vehicle);
    const a = this.physics.alpha;
    for (const d of this.debris) {
      d.track.apply(d.group, a);
      // A sudden velocity change means the part just hit something.
      const v = d.body.linvel();
      if (d.lastV) {
        const dv = Math.hypot(v.x - d.lastV.x, v.y - d.lastV.y, v.z - d.lastV.z);
        if (dv > 2.2 && now - d.lastHit > 0.12) {
          d.lastHit = now;
          this.audio.debrisHit(d.group.position.clone(), dv / 9, d.mass);
        }
      }
      d.lastV = { x: v.x, y: v.y, z: v.z };
    }
    this.shards.update(dt);
  }
  evaluate(now) {
    const soft = this.soft,
      s = this.v4;
    // Collider follows the crushed shape so a folded nose really is shorter.
    const front = soft.facePush(0, -1),
      rear = soft.facePush(0, 1),
      top = soft.facePush(1, 1),
      left = soft.facePush(2, -1),
      right = soft.facePush(2, 1),
      { half, offset } = this.physics.chassisShape,
      shape = {
        half: {
          x: Math.max(1.4, half.x - (front + rear) / 2),
          y: Math.max(0.6, half.y - top / 2),
          z: Math.max(0.5, half.z - (left + right) / 2),
        },
        offset: { x: offset.x + (front - rear) / 2, y: offset.y - top / 2, z: offset.z + (left - right) / 2 },
      };
    if (
      !this.appliedShape ||
      Math.abs(shape.half.x - this.appliedShape.half.x) +
        Math.abs(shape.half.y - this.appliedShape.half.y) +
        Math.abs(shape.half.z - this.appliedShape.half.z) >
        0.015
    ) {
      this.physics.setChassisShape(shape.half, shape.offset);
      this.appliedShape = shape;
    }
    const h = (x) => Math.max(0, 1 - x / 0.7);
    this.health = { front: h(front), rear: h(rear), left: h(left), right: h(right), roof: h(top) };
    this.level = Math.min(1, Math.max(1 - Math.min(...Object.values(this.health)), soft.maxDisp / 1.1));
    // Engine bay intrusion costs power.
    // Radiator, fans and engine sit right behind the nose: crush there costs power.
    soft.sample(this.engine, s);
    this.physics.power = Math.min(
      T.MathUtils.clamp(1 - (Math.hypot(s.x, s.y, s.z) - 0.04) / 0.55, 0.15, 1),
      T.MathUtils.clamp(1 - (front - 0.14) / 0.75, 0.15, 1),
    );
    // Bent mounts damage suspension, add toe and eventually tear the wheel off.
    this.physics.wheels.forEach((w, i) => {
      soft.sample(this.wheelMounts[i], s);
      const target = T.MathUtils.clamp((Math.hypot(s.x, s.y, s.z) - 0.05) / 0.38 + s.w * 0.6, 0, 1),
        current = this.physics.wheelDamage[i];
      if (target > current + 0.02) this.physics.damageWheel(i, target - current);
      if (this.physics.wheelDamage[i] > 0.85 && this.physics.wheelEnabled[i]) {
        this.detachBone("WHEEL_" + w[0], 60);
        this.physics.damageWheel(i, 0, true);
        this.notice(["Front left", "Front right", "Rear left", "Rear right"][i] + " wheel torn off");
      }
    });
    for (const p of this.parts) {
      if (this.detached.has(p.label)) continue;
      soft.sample(p.anchor, s);
      if (Math.hypot(s.x, s.y, s.z) > p.disp || this.kickNear(p.anchor, now) > p.kick) this.detach(p);
    }
    for (const g of this.glass) {
      if (this.detached.has(g.label)) continue;
      let worst = 0;
      for (const q of g.samples) {
        soft.sample(q, s);
        worst = Math.max(worst, Math.hypot(s.x, s.y, s.z) + s.w * 0.4);
      }
      if (worst > g.disp || this.kickNear(g.anchor, now) > g.kick) this.shatter(g);
    }
  }
}

// Ballistic glass shards on one instanced mesh. They tumble, bounce on
// whatever is below them, and settle until the van is repaired.
class ShardField {
  constructor(scene, physics) {
    this.physics = physics;
    this.max = 900;
    const geo = new T.TetrahedronGeometry(0.035, 0);
    geo.scale(1, 0.25, 1.4);
    this.mesh = new T.InstancedMesh(
      geo,
      new T.MeshStandardMaterial({ color: 0xcfe3e1, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.72 }),
      this.max,
    );
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    scene.add(this.mesh);
    this.items = [];
    this.m = new T.Matrix4();
    this.q = new T.Quaternion();
    this.s = new T.Vector3(1, 1, 1);
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }
  spawn(p, base) {
    if (this.items.length >= this.max) return;
    const scale = 0.5 + Math.random() * 1.1;
    this.items.push({
      p: p.clone(),
      v: base
        .clone()
        .multiplyScalar(0.85)
        .add(new T.Vector3((Math.random() - 0.5) * 3.5, Math.random() * 2.8, (Math.random() - 0.5) * 3.5)),
      axis: new T.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      angle: Math.random() * 6.28,
      spin: (Math.random() - 0.5) * 30,
      ground: -Infinity,
      probe: 0,
      rest: false,
      scale,
    });
  }
  groundAt(p) {
    this.ray.origin = { x: p.x, y: p.y + 0.3, z: p.z };
    const hit = this.physics.world.castRay(this.ray, 40, true, undefined, undefined, this.physics.chassis);
    return hit ? p.y + 0.3 - hit.timeOfImpact : 0;
  }
  update(dt) {
    let i = 0;
    for (const s of this.items) {
      if (!s.rest) {
        if ((s.probe -= dt) <= 0) {
          s.ground = this.groundAt(s.p);
          s.probe = 0.12;
        }
        s.v.y -= 9.81 * dt;
        s.v.multiplyScalar(Math.exp(-0.25 * dt));
        s.p.addScaledVector(s.v, dt);
        s.angle += s.spin * dt;
        if (s.p.y < s.ground + 0.006) {
          s.p.y = s.ground + 0.006;
          if (s.v.y < -0.7) this.onBounce?.(s.p);
          if (Math.abs(s.v.y) < 0.6 && s.v.lengthSq() < 0.5) s.rest = true;
          s.v.y = -s.v.y * 0.28;
          s.v.x *= 0.55;
          s.v.z *= 0.55;
          s.spin *= 0.5;
        }
      }
      this.q.setFromAxisAngle(s.axis, s.rest ? Math.round(s.angle / Math.PI) * Math.PI : s.angle);
      this.s.setScalar(s.scale);
      this.m.compose(s.p, this.q, this.s);
      this.mesh.setMatrixAt(i++, this.m);
    }
    this.mesh.count = i;
    if (i) this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() {
    this.items.length = 0;
    this.mesh.count = 0;
  }
}
