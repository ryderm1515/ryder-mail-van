import * as T from "three";
const functions = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  atan: Math.atan,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  sqrt: Math.sqrt,
};
export function expression(a, v) {
  const [op, x, y, z] = a;
  switch (op) {
    case "n":
      return x;
    case "v":
      return x === "pi" ? Math.PI : (v[x] ?? 0);
    case "Add":
      return expression(x, v) + expression(y, v);
    case "Sub":
      return expression(x, v) - expression(y, v);
    case "Mult":
      return expression(x, v) * expression(y, v);
    case "Div":
      return expression(x, v) / expression(y, v);
    case "Pow":
      return expression(x, v) ** expression(y, v);
    case "USub":
      return -expression(x, v);
    case "UAdd":
      return expression(x, v);
    case "Gt":
      return expression(x, v) > expression(y, v);
    case "Lt":
      return expression(x, v) < expression(y, v);
    case "LtE":
      return expression(x, v) <= expression(y, v);
    case "GtE":
      return expression(x, v) >= expression(y, v);
    case "if":
      return expression(x, v) ? expression(y, v) : expression(z, v);
    case "call":
      return functions[x](...a.slice(2).map((e) => expression(e, v)));
    default:
      throw Error("Unknown rig operation " + op);
  }
}
const propPath = /pose\.bones\["([^"]+)"\]\["([^"]+)"\]/;
export class VehicleRig {
  constructor(data, bytes, materialFactory) {
    this.data = data;
    this.root = new T.Group();
    this.root.rotation.x = -Math.PI / 2;
    this.bones = {};
    this.values = {};
    this.targets = {};
    this.velocity = {};
    this.controls = [];
    this.meshes = [];
    this.materials = data.materials.map(materialFactory);
    this.overrides = new Set();
    for (const b of data.bones) {
      const rest = new T.Group(),
        pose = new T.Group();
      rest.position.fromArray(b.position);
      rest.quaternion.fromArray(b.quaternion);
      rest.scale.fromArray(b.scale);
      rest.add(pose);
      rest.name = b.name;
      this.bones[b.name] = { rest, pose, data: b };
    }
    for (const b of data.bones)
      (b.parent ? this.bones[b.parent].pose : this.root).add(this.bones[b.name].rest);
    for (const b of data.manifest.controllers)
      for (const p of b.properties) {
        const id = b.name + "|" + p.name;
        this.values[id] = this.targets[id] = p.default;
        this.velocity[id] = 0;
        this.controls.push({ ...p, id, bone: b.name, collections: b.collections });
      }
    for (const m of data.meshes) {
      const g = new T.BufferGeometry();
      g.setAttribute(
        "position",
        new T.BufferAttribute(new Float32Array(bytes, m.positionOffset, m.count * 3).slice(), 3),
      );
      g.setAttribute(
        "normal",
        new T.BufferAttribute(new Float32Array(bytes, m.normalOffset, m.count * 3), 3),
      );
      g.computeBoundingSphere();
      const mesh = new T.Mesh(g, this.materials[m.material]);
      mesh.castShadow = !this.materials[m.material].transparent;
      mesh.receiveShadow = true;
      mesh.userData.bone = m.bone;
      mesh.userData.objects = m.objects;
      this.bones[m.bone].pose.add(mesh);
      this.meshes.push(mesh);
    }
    this.drivers = data.manifest.drivers.map((d) => ({
      ...d,
      refs: d.variables.map((v) => ({
        name: v.name,
        path: v.targets[0].path.match(propPath)?.slice(1).join("|"),
      })),
      bone: d.path.match(/pose\.bones\["([^"]+)"\]\.(location|rotation_euler)/)?.slice(1),
      // The source rig parks the wiper arms standing up on the glass. Real
      // wipers rest flat along the base of the windshield, pointing in: park
      // there and let a sweep lift each arm up the glass and back. The two
      // park at slightly different angles so they stack instead of colliding.
      park: /^pose\.bones\["WIPER_[LR]"\]\.rotation_euler$/.test(d.path) ? (d.expression.trim().startsWith("-") ? -0.9 : 0.86) : 0,
    }));
    this.morphs = (data.morphs || []).map((m) => ({
      ...m,
      delta: new Float32Array(bytes, m.offset, m.count * 3),
      base: this.meshes[m.mesh].geometry.attributes.position.array.slice(
        m.start * 3,
        (m.start + m.count) * 3,
      ),
      last: NaN,
    }));
    this.tmp = new T.Vector3();
    this.q = new T.Quaternion();
    this.q2 = new T.Quaternion();
    this.axis = new T.Vector3(0, 1, 0);
    this.update(0, true);
  }
  // Cab corrections, applied once after the rig is placed in the vehicle
  // (coordinates are in the vehicle's local space).
  fixCab() {
    const host = this.root.parent;
    host.updateMatrixWorld(true);
    const toHost = host.matrixWorld.clone().invert();
    // Steering wheel: the source wheel leans back toward the driver with its
    // lower rim buried in the dash. Stand it up like a car wheel: rim about
    // 25 degrees back from vertical, top leaning away from the driver, hub
    // pulled back off the dash, slightly smaller.
    const sw = this.bones.STEERING_WHEEL;
    if (sw) {
      const { tilt, center, scale } = (this.wheelPose = { tilt: (25 * Math.PI) / 180, center: new T.Vector3(-1.17, 0.66, 0.53), scale: 1 });
      const parent = toHost.clone().multiply(sw.rest.parent.matrixWorld);
      const cur = new T.Quaternion();
      toHost.clone().multiply(sw.rest.matrixWorld).decompose(new T.Vector3(), cur, new T.Vector3());
      // Rotate so the bone's spin axis (local +Y, pointing away from the
      // driver) runs forward and down at `tilt` below horizontal.
      const from = new T.Vector3(0, 1, 0).applyQuaternion(cur),
        to = new T.Vector3(-Math.cos(tilt), -Math.sin(tilt), 0);
      const q = new T.Quaternion().setFromUnitVectors(from, to).multiply(cur);
      const want = new T.Matrix4().compose(center, q, new T.Vector3(scale, scale, scale));
      parent.invert().multiply(want).decompose(sw.rest.position, sw.rest.quaternion, sw.rest.scale);
      // Column shroud from the hub down into the dash, along the spin axis.
      const len = 0.36,
        col = new T.Mesh(new T.CylinderGeometry(0.045, 0.055, len, 20), this.meshes.find((m) => m.userData.bone === "STEERING_WHEEL").material);
      col.position.set(0, (len / 2 + 0.02) / scale, 0);
      col.scale.setScalar(1 / scale);
      col.castShadow = col.receiveShadow = true;
      col.name = "Steering column shroud";
      sw.rest.add(col);
      this.wheelColumn = col;
    }
    // The original column pointed at the old hub; hide it.
    this.hideObjects(/^Steering column$/);
    // Wiper blades: the source blades cross their arms. Turn each blade about
    // the arm tip so it lies along its arm, like a real wiper.
    for (const n of ["WIPER_L", "WIPER_R"]) this.alignBlade(n);
    this.update(0, true);
  }
  // Right-hand drive: mirror the driver's station (seat, wheel, pedals, dash,
  // cluster, console) across the van's centreline so the driver sits on the
  // right like a real mail truck. Doors, windows, wipers and wheels keep their
  // sides. Geometry is reflected in place (winding flipped) and moving parts
  // keep proper rotations, so steering, pedals and the seat still animate the
  // right way round.
  mirrorCab() {
    const host = this.root.parent;
    this.update(0, true);
    host.updateMatrixWorld(true);
    const toHost = host.matrixWorld.clone().invert();
    const S = new T.Matrix4().makeScale(1, 1, -1);
    const keep = /^(MCH_DAMPER|DAMPER|SPRING|ROOT|DRIVE|BODY|CHASSIS|FRAME|DOOR|WINDOW|WIPER|WHEEL|TIRE|HUB|BRAKE_DISC|SUSPENSION|AXLE|SETTINGS|LIGHTING|HEADLIGHT|TAIL|MIRROR|SLIDING|CARGO|SHELF|ROOF|BUMPER|HOOD)/;
    const inCab = (v) => v.x > -2.35 && v.x < -0.05 && v.y > -0.25 && v.y < 1.75 && Math.abs(v.z) < 0.98;
    const hostOf = (o) => toHost.clone().multiply(o.matrixWorld);
    // Bones to move: pivot inside the cab, plus everything hanging off them.
    const moved = new Set();
    for (const b of this.data.bones) {
      const name = b.name,
        bone = this.bones[name];
      if (b.parent && moved.has(b.parent)) {
        moved.add(name);
        continue;
      }
      if (keep.test(name)) continue;
      const p = new T.Vector3().setFromMatrixPosition(hostOf(bone.rest));
      if (inCab(p)) moved.add(name);
    }
    // Driven translations on moved bones are in the bone's own frame; reflect
    // them through the same mirror (Q = R^T S R) so slides go the right way.
    this.mirrorLoc = {};
    for (const name of moved) {
      const R = new T.Matrix4().extractRotation(hostOf(this.bones[name].rest));
      this.mirrorLoc[name] = new T.Matrix3().setFromMatrix4(R.clone().transpose().multiply(S).multiply(R));
    }
    // Target host matrices (orientation kept, pivot reflected), parents first.
    const want = new Map();
    for (const b of this.data.bones) {
      if (!moved.has(b.name)) continue;
      const m = hostOf(this.bones[b.name].rest);
      const t = new T.Vector3().setFromMatrixPosition(m);
      t.z = -t.z;
      m.setPosition(t);
      want.set(b.name, m);
    }
    const perMesh = new Map();
    const reflect = (mesh, from, to, full) => {
      const M = hostOf(mesh),
        A = full ? M.clone().invert().multiply(S).multiply(M) : null;
      const L = new T.Matrix3().setFromMatrix4(M),
        Lin = new T.Matrix3().setFromMatrix4(new T.Matrix4().extractRotation(M).invert().multiply(S).multiply(new T.Matrix4().extractRotation(M)));
      const pos = mesh.geometry.attributes.position,
        nrm = mesh.geometry.attributes.normal,
        v = new T.Vector3();
      for (let i = from; i < to; i++) {
        v.fromBufferAttribute(pos, i);
        full ? v.applyMatrix4(A) : v.applyMatrix3(Lin);
        pos.setXYZ(i, v.x, v.y, v.z);
        v.fromBufferAttribute(nrm, i).applyMatrix3(Lin).normalize();
        nrm.setXYZ(i, v.x, v.y, v.z);
      }
      // Reflection turns triangles inside out; swap two corners of each.
      for (let i = from - (from % 3); i + 2 < to; i += 3)
        for (const a of [pos, nrm]) {
          const x = a.getX(i + 1), y = a.getY(i + 1), z = a.getZ(i + 1);
          a.setXYZ(i + 1, a.getX(i + 2), a.getY(i + 2), a.getZ(i + 2));
          a.setXYZ(i + 2, x, y, z);
        }
      pos.needsUpdate = nrm.needsUpdate = true;
      mesh.geometry.computeBoundingSphere();
      perMesh.set(mesh, { A: full ? A : new T.Matrix4().setFromMatrix3(Lin), Lin, from, to, ranges: [...(perMesh.get(mesh)?.ranges || []), [from, to]] });
    };
    // Static cab trim on unmoved bones (dash, console, mats): reflect in place.
    this.meshes.forEach((mesh, mi) => {
      const bone = mesh.userData.bone;
      if (moved.has(bone) || /^(DOOR|WINDOW|WIPER|WHEEL)/.test(bone)) return;
      const M = hostOf(mesh),
        pos = mesh.geometry.attributes.position,
        v = new T.Vector3();
      for (const r of this.data.meshes[mi].ranges || []) {
        const mn = new T.Vector3(1e9, 1e9, 1e9),
          mx = new T.Vector3(-1e9, -1e9, -1e9);
        for (let i = r.start; i < r.start + r.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(M);
          mn.min(v);
          mx.max(v);
        }
        const c = mn.clone().add(mx).multiplyScalar(0.5);
        if (inCab(c) && mn.z > -0.98 && mx.z < 0.98) reflect(mesh, r.start, r.start + r.count, true);
      }
    });
    // Moving parts: reflect their geometry about their own pivot, then re-seat the bone.
    for (const mesh of this.meshes) if (moved.has(mesh.userData.bone)) reflect(mesh, 0, mesh.geometry.attributes.position.count, false);
    for (const b of this.data.bones) {
      if (!want.has(b.name)) continue;
      const rest = this.bones[b.name].rest;
      rest.parent.updateMatrixWorld(true);
      const parent = hostOf(rest.parent);
      parent.invert().multiply(want.get(b.name)).decompose(rest.position, rest.quaternion, rest.scale);
      rest.updateMatrixWorld(true);
    }
    // Keep morph targets in step with the reflected vertices.
    for (const m of this.morphs) {
      const mesh = this.meshes[m.mesh],
        info = perMesh.get(mesh);
      if (!info) continue;
      const pos = mesh.geometry.attributes.position.array,
        d = (m.delta = m.delta.slice()),
        v = new T.Vector3();
      for (let k = 0; k < m.count; k++) {
        const i = m.start + k;
        if (!info.ranges.some(([a, b]) => i >= a && i < b)) continue;
        v.fromArray(d, k * 3).applyMatrix3(info.Lin).toArray(d, k * 3);
      }
      // The winding flip swapped two corners of every reflected triangle;
      // swap their morph offsets too, or the deformed shape tears apart.
      for (const [a0, b0] of info.ranges)
        for (let i = a0 - (a0 % 3); i + 2 < b0; i += 3) {
          const k1 = i + 1 - m.start,
            k2 = i + 2 - m.start;
          if (k1 < 0 || k2 >= m.count) continue;
          for (let c = 0; c < 3; c++) {
            const t = d[k1 * 3 + c];
            d[k1 * 3 + c] = d[k2 * 3 + c];
            d[k2 * 3 + c] = t;
          }
        }
      m.base = pos.slice(m.start * 3, (m.start + m.count) * 3);
      m.last = NaN;
    }
    this.mirrored = moved;
    this.update(0, true);
  }
  ranges(test) {
    const out = [];
    this.meshes.forEach((m, mi) => {
      for (const r of this.data.meshes[mi].ranges || []) if (test.test(r.object)) out.push({ mesh: m, ...r });
    });
    return out;
  }
  hideObjects(test) {
    for (const r of this.ranges(test)) {
      const a = r.mesh.geometry.attributes.position;
      a.array.fill(0, r.start * 3, (r.start + r.count) * 3);
      a.needsUpdate = true;
    }
  }
  // Principal direction of a vertex range projected on the bone's XZ plane
  // (the wiper sweeps about local Y).
  axisXZ(r) {
    const a = r.mesh.geometry.attributes.position.array;
    let cx = 0,
      cz = 0;
    for (let i = r.start; i < r.start + r.count; i++) (cx += a[i * 3]), (cz += a[i * 3 + 2]);
    cx /= r.count;
    cz /= r.count;
    let xx = 0,
      zz = 0,
      xz = 0;
    for (let i = r.start; i < r.start + r.count; i++) {
      const dx = a[i * 3] - cx,
        dz = a[i * 3 + 2] - cz;
      xx += dx * dx;
      zz += dz * dz;
      xz += dx * dz;
    }
    return { cx, cz, angle: 0.5 * Math.atan2(2 * xz, xx - zz) };
  }
  alignBlade(bone) {
    const mine = (r) => r.mesh.userData.bone === bone;
    const arm = this.ranges(/^Articulated windshield wiper arm/).filter(mine)[0],
      blade = this.ranges(/^Aerodynamic wiper blade/).filter(mine)[0];
    if (!arm || !blade) return;
    const A = this.axisXZ(arm),
      B = this.axisXZ(blade);
    // Smallest turn that makes the two lines parallel.
    let d = A.angle - B.angle;
    while (d > Math.PI / 2) d -= Math.PI;
    while (d < -Math.PI / 2) d += Math.PI;
    const c = Math.cos(d),
      s = Math.sin(d),
      g = blade.mesh.geometry;
    for (const attr of [g.attributes.position, g.attributes.normal]) {
      const a = attr.array,
        pivot = attr === g.attributes.position;
      for (let i = blade.start; i < blade.start + blade.count; i++) {
        const x = a[i * 3] - (pivot ? B.cx : 0),
          z = a[i * 3 + 2] - (pivot ? B.cz : 0);
        // Rotation by d in the x/z plane (atan2(z, x) increases by d).
        a[i * 3] = x * c - z * s + (pivot ? B.cx : 0);
        a[i * 3 + 2] = x * s + z * c + (pivot ? B.cz : 0);
      }
      attr.needsUpdate = true;
    }
    g.computeBoundingSphere();
  }
  set(bone, key, val, manual = false) {
    const id = bone + "|" + key;
    if (!(id in this.targets)) return;
    this.targets[id] = val;
    if (manual) this.overrides.add(id);
  }
  get(b, k) {
    return this.values[b + "|" + k] ?? 0;
  }
  reset() {
    for (const c of this.controls) this.targets[c.id] = c.default;
    this.overrides.clear();
  }
  update(dt, instant = false) {
    for (const c of this.controls) {
      let x = this.values[c.id],
        v = this.velocity[c.id],
        target = this.targets[c.id];
      if (instant || dt === 0) {
        x = target;
        v = 0;
      } else {
        const rate = /Spin|Turns|Travel|cycles|distance|Steer|Reading/.test(c.name) ? 20 : 11;
        const e = Math.exp(-rate * dt),
          delta = x - target;
        x = target + (delta + (v + rate * delta) * dt) * e;
        v = (v - rate * (v + rate * delta) * dt) * e;
      }
      this.values[c.id] = x;
      this.velocity[c.id] = v;
    }
    for (const { pose } of Object.values(this.bones)) {
      pose.position.set(0, 0, 0);
      pose.rotation.set(0, 0, 0);
    }
    for (const d of this.drivers) {
      if (!d.bone) continue;
      const vars = {};
      for (const ref of d.refs) vars[ref.name] = this.values[ref.path] ?? 0;
      let result = expression(d.ast, vars);
      if (d.park) result = d.park - result;
      if (!Number.isFinite(result)) continue;
      const node = this.bones[d.bone[0]].pose;
      if (d.bone[1] === "location" && this.mirrorLoc?.[d.bone[0]]) {
        ((this.locAcc ||= {})[d.bone[0]] ||= new T.Vector3()).setComponent(d.index, result);
        continue;
      }
      (d.bone[1] === "location" ? node.position : node.rotation).setComponent?.(d.index, result);
      if (d.bone[1] === "rotation_euler") node.rotation[["x", "y", "z"][d.index]] = result;
    }
    if (this.locAcc)
      for (const [name, v] of Object.entries(this.locAcc)) this.bones[name].pose.position.copy(v).applyMatrix3(this.mirrorLoc[name]);
    this.root.updateMatrixWorld(true);
    for (const { pose, rest, data } of Object.values(this.bones))
      for (const c of data.constraints) {
        if (c.type !== "DAMPED_TRACK") continue;
        const target = this.bones[c.target];
        if (!target) continue;
        target.pose.getWorldPosition(this.tmp);
        this.tmp.sub(pose.getWorldPosition(new T.Vector3())).normalize();
        rest.getWorldQuaternion(this.q).invert();
        this.tmp.applyQuaternion(this.q);
        pose.quaternion.setFromUnitVectors(this.axis, this.tmp);
        pose.updateMatrixWorld(true);
      }
    const changed = this.morphs.filter(
      (m) => Math.abs(this.get(m.control, m.property) / m.value - m.last) > 1e-5 || !Number.isFinite(m.last),
    );
    if (changed.length) {
      const touched = new Set(changed.map((m) => m.mesh + ":" + m.start));
      for (const m of this.morphs)
        if (touched.has(m.mesh + ":" + m.start)) {
          const at = this.meshes[m.mesh].geometry.attributes.position;
          at.array.set(m.base, m.start * 3);
        }
      for (const m of this.morphs)
        if (touched.has(m.mesh + ":" + m.start)) {
          const at = this.meshes[m.mesh].geometry.attributes.position,
            w = this.get(m.control, m.property) / m.value;
          for (let i = 0; i < m.delta.length; i++) at.array[m.start * 3 + i] += m.delta[i] * w;
          m.last = w;
          at.addUpdateRange(m.start * 3, m.count * 3);
          at.needsUpdate = true;
        }
    }
    for (const m of this.materials) {
      const name = m.userData.source;
      if (!name?.startsWith("ANIM LIGHT")) continue;
      const key = name.split(" • ")[1];
      let value = this.get("LIGHTING", key);
      if (key?.startsWith("Indicator")) value = Math.max(value, this.get("LIGHTING", "Hazards"));
      m.emissiveIntensity = value * (key === "Headlights" ? 3 : 1.4);
    }
  }
}
