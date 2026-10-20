import * as T from "three";

// Node-and-beam deformation lattice for the van body.
//
// The Rapier rigid body still carries the van's momentum, collisions and
// driving. This lattice lives in the body's local frame and models the
// structure itself: every chassis contact injects the velocity change it
// caused into the nodes around the contact points, beams resist with
// region-specific stiffness, and any beam strained past its yield point
// takes a permanent set (plastic flow) with work hardening. The result is
// crumpling that stays bent, folds where the structure is weakest, and
// spreads realistically from the impact point.
//
// Rendering samples the node displacements as a 3D texture (see deform.js),
// so the whole high-poly mesh deforms on the GPU with no per-vertex CPU cost.

const NEIGHBORS = [
  [1, 0, 0, 1],
  [0, 1, 0, 1],
  [0, 0, 1, 1],
  [1, 1, 0, 0.8],
  [1, -1, 0, 0.8],
  [1, 0, 1, 0.8],
  [1, 0, -1, 0.8],
  [0, 1, 1, 0.8],
  [0, 1, -1, 0.8],
  [1, 1, 1, 0.6],
  [1, 1, -1, 0.6],
  [1, -1, 1, 0.6],
  [1, -1, -1, 0.6],
  // Longer "bending" beams keep panels coherent so they fold, not liquefy.
  [2, 0, 0, 0.45],
  [0, 2, 0, 0.45],
  [0, 0, 2, 0.45],
];

function rand(i) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export class SoftBody {
  constructor(min, max, res, zoneFn) {
    this.min = min.clone();
    this.max = max.clone();
    this.size = max.clone().sub(min);
    this.res = res;
    const [nx, ny, nz] = res,
      n = nx * ny * nz;
    this.count = n;
    this.rest = new Float32Array(n * 3);
    this.x = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.w = new Float32Array(n);
    this.crush = new Float32Array(n);
    this.kickBuf = new Float32Array(n * 3);
    this.zone = new Array(n);
    const idx = (i, j, k) => i + nx * (j + ny * k);
    this.idx = idx;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const id = idx(i, j, k),
            p = new T.Vector3(
              min.x + (this.size.x * i) / (nx - 1),
              min.y + (this.size.y * j) / (ny - 1),
              min.z + (this.size.z * k) / (nz - 1),
            );
          this.rest.set([p.x, p.y, p.z], id * 3);
          const z = zoneFn(p, i / (nx - 1), j / (ny - 1), k / (nz - 1));
          this.zone[id] = z;
          this.w[id] = 1 / z.mass;
        }
    const a = [],
      b = [],
      stiff = [],
      yieldS = [];
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++)
          for (const [di, dj, dk, s] of NEIGHBORS) {
            const i2 = i + di,
              j2 = j + dj,
              k2 = k + dk;
            if (i2 < 0 || j2 < 0 || k2 < 0 || i2 >= nx || j2 >= ny || k2 >= nz) continue;
            const p = idx(i, j, k),
              q = idx(i2, j2, k2),
              za = this.zone[p],
              zb = this.zone[q],
              jitter = 0.72 + rand(a.length) * 0.56;
            a.push(p);
            b.push(q);
            stiff.push(Math.min(za.stiffness, zb.stiffness) * s * jitter);
            yieldS.push(Math.min(za.yield, zb.yield) * (0.8 + rand(a.length + 999) * 0.4));
          }
    this.beams = a.length;
    this.a = Int32Array.from(a);
    this.b = Int32Array.from(b);
    this.stiffness = Float32Array.from(stiff);
    this.yield0 = Float32Array.from(yieldS);
    this.yieldS = new Float32Array(this.beams);
    this.L0 = new Float32Array(this.beams);
    this.Lorig = new Float32Array(this.beams);
    for (let e = 0; e < this.beams; e++) {
      const p = this.a[e] * 3,
        q = this.b[e] * 3;
      this.Lorig[e] = Math.hypot(
        this.rest[q] - this.rest[p],
        this.rest[q + 1] - this.rest[p + 1],
        this.rest[q + 2] - this.rest[p + 2],
      );
    }
    this.iterations = 6;
    // Tuned so a full-width wall hit crushes roughly 0.1 m at 15 km/h, 0.5 m at
    // 50 km/h and 1 m at 80 km/h, close to linear like real crumple structures.
    this.gain = 1;
    this.hardening = 0.08;
    this.refArea = 6;
    this.maxFocus = 2.6;
    // Per-iteration stiffness so the converged result is independent of iteration count.
    this.kIter = this.stiffness.map((s) => 1 - Math.pow(1 - Math.min(0.98, s), 1 / this.iterations));
    this.kicks = [];
    this.version = 0;
    this.reset();
  }
  reset() {
    this.x.set(this.rest);
    this.prev.set(this.rest);
    this.v.fill(0);
    this.crush.fill(0);
    this.kickBuf.fill(0);
    this.L0.set(this.Lorig);
    this.yieldS.set(this.yield0);
    this.active = false;
    this.quiet = 0;
    this.plasticRate = 0;
    this.pending = false;
    this.maxDisp = 0;
    this.kicks.length = 0;
    this.version++;
  }
  // A contact patch: every solver contact point of one collider pair this step,
  // the push direction (into the body) and the velocity change it caused.
  patch(points, n, dv, time) {
    const u = new T.Vector3(),
      w = new T.Vector3();
    u.copy(Math.abs(n.y) < 0.9 ? T.Object3D.DEFAULT_UP : new T.Vector3(1, 0, 0)).cross(n).normalize();
    w.crossVectors(n, u);
    let d = 0,
      u0 = Infinity,
      u1 = -Infinity,
      w0 = Infinity,
      w1 = -Infinity;
    for (const p of points) {
      d += p.dot(n);
      const a = p.dot(u),
        b = p.dot(w);
      u0 = Math.min(u0, a);
      u1 = Math.max(u1, a);
      w0 = Math.min(w0, b);
      w1 = Math.max(w1, b);
    }
    return {
      n: n.clone(),
      u,
      w,
      d: d / points.length,
      u0,
      u1,
      w0,
      w1,
      margin: 0.24 + Math.min(0.3, dv * 0.015),
      depth: 0.22 + Math.min(0.45, dv * 0.022),
      dv,
      time,
      points: points.map((p) => p.clone()),
    };
  }
  // How strongly a body-space point participates in a contact patch: full
  // inside the footprint, soft at its edges, fading with depth into the body.
  influence(ev, x, y, z) {
    const a = x * ev.u.x + y * ev.u.y + z * ev.u.z,
      b = x * ev.w.x + y * ev.w.y + z * ev.w.z,
      s = x * ev.n.x + y * ev.n.y + z * ev.n.z - ev.d,
      da = Math.max(0, ev.u0 - a, a - ev.u1),
      db = Math.max(0, ev.w0 - b, b - ev.w1),
      edge = Math.exp(-(da * da + db * db) / (ev.margin * ev.margin));
    if (edge < 0.01) return 0;
    return edge * (s <= 0 ? 1 : Math.exp(-s / ev.depth));
  }
  impact(points, n, dv, time) {
    if (dv <= 0 || !points.length) return;
    const ev = this.patch(points, n, dv, time),
      // The same energy through a smaller footprint goes deeper (poles, corners).
      area = (ev.u1 - ev.u0 + 2 * ev.margin) * (ev.w1 - ev.w0 + 2 * ev.margin),
      focus = T.MathUtils.clamp(Math.sqrt(this.refArea / area), 1, this.maxFocus),
      x = this.x,
      prev = this.prev,
      k = this.kickBuf;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3,
        f = this.influence(ev, x[o], x[o + 1], x[o + 2]);
      if (f <= 0) continue;
      const kv = dv * this.gain * focus * f * this.zone[i].response;
      k[o] += ev.n.x * kv;
      k[o + 1] += ev.n.y * kv;
      k[o + 2] += ev.n.z * kv;
      // Nothing passes through the obstacle: anything poking past the contact
      // plane is pressed back onto it.
      const s = x[o] * ev.n.x + x[o + 1] * ev.n.y + x[o + 2] * ev.n.z - ev.d;
      if (s < -0.015) {
        const push = (-s - 0.015) * Math.min(1, f * 1.5);
        for (let c = 0; c < 3; c++) {
          x[o + c] += ev.n.getComponent(c) * push;
          prev[o + c] += ev.n.getComponent(c) * push;
        }
      }
    }
    this.kicks.push(ev);
    this.pending = true;
    this.active = true;
    this.quiet = 0;
    this.version++;
  }
  step(dt) {
    if (!this.active) return;
    const x = this.x,
      v = this.v,
      prev = this.prev,
      w = this.w,
      n = this.count;
    const damp = Math.exp(-5.5 * dt);
    if (this.pending) {
      for (let i = 0; i < n * 3; i++) v[i] += this.kickBuf[i];
      this.kickBuf.fill(0);
      this.pending = false;
    }
    for (let i = 0; i < n * 3; i++) {
      prev[i] = x[i];
      v[i] *= damp;
      x[i] += v[i] * dt;
    }
    const A = this.a,
      B = this.b,
      L0 = this.L0,
      K = this.kIter,
      Lo = this.Lorig,
      Y = this.yieldS,
      crush = this.crush,
      hard = this.hardening;
    let plastic = 0;
    for (let it = 0; it < this.iterations; it++)
      for (let e = 0; e < this.beams; e++) {
        const p = A[e] * 3,
          q = B[e] * 3,
          dx = x[q] - x[p],
          dy = x[q + 1] - x[p + 1],
          dz = x[q + 2] - x[p + 2],
          L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6,
          y = Y[e];
        let rest = L0[e];
        const strain = (L - rest) / rest;
        // Plastic flow inside the solve: a beam can only carry its yield load,
        // so a hard hit folds the structure locally instead of shoving it all.
        if (strain > y || strain < -y) {
          const target = strain > 0 ? L - y * rest : L + y * rest,
            clamped = Math.min(Lo[e] * 1.45, Math.max(Lo[e] * 0.28, target)),
            delta = Math.abs(clamped - rest) / Lo[e];
          rest = L0[e] = clamped;
          Y[e] = y + delta * hard; // work hardening: folded metal resists further folding
          crush[A[e]] += delta * 0.5;
          crush[B[e]] += delta * 0.5;
          plastic += delta;
        }
        const wa = w[A[e]],
          wb = w[B[e]],
          c = (K[e] * (L - rest)) / (L * (wa + wb));
        x[p] += wa * c * dx;
        x[p + 1] += wa * c * dy;
        x[p + 2] += wa * c * dz;
        x[q] -= wb * c * dx;
        x[q + 1] -= wb * c * dy;
        x[q + 2] -= wb * c * dz;
      }
    this.removeDrift();
    let energy = 0,
      maxDisp = 0;
    const rest = this.rest;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let dx = x[o] - rest[o],
        dy = x[o + 1] - rest[o + 1],
        dz = x[o + 2] - rest[o + 2];
      const d = Math.hypot(dx, dy, dz);
      if (d > 1.7) {
        const s = 1.7 / d;
        x[o] = rest[o] + dx * s;
        x[o + 1] = rest[o + 1] + dy * s;
        x[o + 2] = rest[o + 2] + dz * s;
      }
      maxDisp = Math.max(maxDisp, Math.min(d, 1.7));
      for (let c = 0; c < 3; c++) {
        v[o + c] = (x[o + c] - prev[o + c]) / dt;
        energy += v[o + c] * v[o + c];
      }
    }
    this.maxDisp = maxDisp;
    // Plastic flow per second, smoothed: drives the metal groan audio.
    this.plasticRate = this.plasticRate * Math.exp(-10 * dt) + plastic / dt * (1 - Math.exp(-10 * dt));
    this.version++;
    this.quiet = energy / n < 0.0004 && plastic < 1e-5 ? this.quiet + dt : 0;
    if (this.quiet > 0.35) {
      this.active = false;
      this.plasticRate = 0;
      v.fill(0);
    }
  }
  // Remove any rigid translation and rotation the lattice picked up, using the
  // least-damaged nodes as the reference frame. The rigid body already took the
  // momentum, so only true deformation should remain in body space.
  removeDrift() {
    const x = this.x,
      r = this.rest,
      n = this.count;
    let W = 0,
      cx = 0,
      cy = 0,
      cz = 0,
      rx = 0,
      ry = 0,
      rz = 0;
    const wt = this._wt || (this._wt = new Float32Array(n));
    for (let i = 0; i < n; i++) {
      const o = i * 3,
        vv = this.v[o] * this.v[o] + this.v[o + 1] * this.v[o + 1] + this.v[o + 2] * this.v[o + 2],
        ww = Math.exp(-14 * this.crush[i]) / (1 + vv * 4);
      wt[i] = ww;
      W += ww;
      cx += x[o] * ww;
      cy += x[o + 1] * ww;
      cz += x[o + 2] * ww;
      rx += r[o] * ww;
      ry += r[o + 1] * ww;
      rz += r[o + 2] * ww;
    }
    if (W < 1e-6) return;
    cx /= W;
    cy /= W;
    cz /= W;
    rx /= W;
    ry /= W;
    rz /= W;
    // Covariance A = sum w (x - cx)(r - cr)^T, columns stored for Müller's rotation extraction.
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const o = i * 3,
        ww = wt[i],
        px = x[o] - cx,
        py = x[o + 1] - cy,
        pz = x[o + 2] - cz,
        qx = r[o] - rx,
        qy = r[o + 1] - ry,
        qz = r[o + 2] - rz;
      A[0] += ww * px * qx;
      A[1] += ww * py * qx;
      A[2] += ww * pz * qx;
      A[3] += ww * px * qy;
      A[4] += ww * py * qy;
      A[5] += ww * pz * qy;
      A[6] += ww * px * qz;
      A[7] += ww * py * qz;
      A[8] += ww * pz * qz;
    }
    const q = this._q || (this._q = new T.Quaternion()),
      m = this._m || (this._m = new T.Matrix4()),
      c0 = new T.Vector3(),
      c1 = new T.Vector3(),
      c2 = new T.Vector3(),
      a0 = new T.Vector3(A[0], A[1], A[2]),
      a1 = new T.Vector3(A[3], A[4], A[5]),
      a2 = new T.Vector3(A[6], A[7], A[8]),
      omega = new T.Vector3(),
      tmp = new T.Vector3(),
      dq = new T.Quaternion();
    for (let it = 0; it < 8; it++) {
      m.makeRotationFromQuaternion(q);
      m.extractBasis(c0, c1, c2);
      omega
        .copy(tmp.crossVectors(c0, a0))
        .add(tmp.crossVectors(c1, a1))
        .add(tmp.crossVectors(c2, a2));
      const denom = Math.abs(c0.dot(a0) + c1.dot(a1) + c2.dot(a2)) + 1e-9;
      omega.multiplyScalar(1 / denom);
      const angle = omega.length();
      if (angle < 1e-9) break;
      dq.setFromAxisAngle(omega.multiplyScalar(1 / angle), angle);
      q.premultiply(dq).normalize();
    }
    const inv = this._qi || (this._qi = new T.Quaternion());
    inv.copy(q).invert();
    const p = tmp;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      p.set(x[o] - cx, x[o + 1] - cy, x[o + 2] - cz).applyQuaternion(inv);
      x[o] = p.x + rx;
      x[o + 1] = p.y + ry;
      x[o + 2] = p.z + rz;
      p.set(this.prev[o] - cx, this.prev[o + 1] - cy, this.prev[o + 2] - cz).applyQuaternion(inv);
      this.prev[o] = p.x + rx;
      this.prev[o + 1] = p.y + ry;
      this.prev[o + 2] = p.z + rz;
    }
    // Keep the reference rotation fresh each step; drift is small per step.
    q.identity();
  }
  // Trilinear sample of displacement (xyz) and crush (w) at a body-space point.
  sample(p, out) {
    const [nx, ny, nz] = this.res;
    const fx = T.MathUtils.clamp(((p.x - this.min.x) / this.size.x) * (nx - 1), 0, nx - 1),
      fy = T.MathUtils.clamp(((p.y - this.min.y) / this.size.y) * (ny - 1), 0, ny - 1),
      fz = T.MathUtils.clamp(((p.z - this.min.z) / this.size.z) * (nz - 1), 0, nz - 1),
      i0 = Math.min(nx - 2, Math.floor(fx)),
      j0 = Math.min(ny - 2, Math.floor(fy)),
      k0 = Math.min(nz - 2, Math.floor(fz)),
      tx = fx - i0,
      ty = fy - j0,
      tz = fz - k0;
    out.set(0, 0, 0, 0);
    for (let c = 0; c < 8; c++) {
      const di = c & 1,
        dj = (c >> 1) & 1,
        dk = (c >> 2) & 1,
        wgt = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz),
        id = this.idx(i0 + di, j0 + dj, k0 + dk),
        o = id * 3;
      out.x += (this.x[o] - this.rest[o]) * wgt;
      out.y += (this.x[o + 1] - this.rest[o + 1]) * wgt;
      out.z += (this.x[o + 2] - this.rest[o + 2]) * wgt;
      out.w += this.crush[id] * wgt;
    }
    return out;
  }
  // Average inward push of one lattice face, used to shrink the collider and
  // derive per-zone health. axis 0/1/2, side -1 (min face) or 1 (max face).
  facePush(axis, side) {
    const [nx, ny, nz] = this.res,
      counts = [nx, ny, nz],
      fixed = side < 0 ? 0 : counts[axis] - 1;
    let sum = 0,
      m = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          if ([i, j, k][axis] !== fixed) continue;
          const o = this.idx(i, j, k) * 3 + axis;
          sum += (this.x[o] - this.rest[o]) * -side;
          m++;
        }
    return Math.max(0, sum / m);
  }
}
