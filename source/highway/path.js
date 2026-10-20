// A densely sampled curve through control points ([x, z] or [x, y, z]),
// looked up by arc length. Right normal of the travel direction is (-tz, tx).

function cr(p0, p1, p2, p3, t) {
  const t2 = t * t,
    t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export class Path {
  constructor(points, { closed = false, step = 1 } = {}) {
    const P = points.map((p) => (p.length === 2 ? [p[0], 0, p[1]] : p)),
      n = P.length;
    const get = (i) => (closed ? P[((i % n) + n) % n] : P[Math.max(0, Math.min(n - 1, i))]);
    const raw = [];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = get(i - 1),
        b = get(i),
        c = get(i + 1),
        d = get(i + 2);
      const len = Math.hypot(c[0] - b[0], c[2] - b[2]),
        k = Math.max(2, Math.ceil(len / (step * 0.5)));
      for (let j = 0; j < k; j++) {
        const t = j / k;
        raw.push([cr(a[0], b[0], c[0], d[0], t), cr(a[1], b[1], c[1], d[1], t), cr(a[2], b[2], c[2], d[2], t)]);
      }
    }
    if (!closed) raw.push(P[n - 1].slice());
    // Resample at a fixed step so lookups are O(1).
    const cum = [0];
    for (let i = 1; i < raw.length; i++) cum.push(cum[i - 1] + Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][2] - raw[i - 1][2]));
    let total = cum[cum.length - 1];
    if (closed) total += Math.hypot(raw[0][0] - raw[raw.length - 1][0], raw[0][2] - raw[raw.length - 1][2]);
    this.length = total;
    this.closed = closed;
    this.step = step;
    const N = Math.max(2, Math.round(total / step) + (closed ? 0 : 1));
    this.n = N;
    this.x = new Float32Array(N);
    this.y = new Float32Array(N);
    this.z = new Float32Array(N);
    let j = 0;
    const ext = closed ? [...raw, raw[0]] : raw,
      cumE = closed ? [...cum, total] : cum;
    for (let i = 0; i < N; i++) {
      const s = (i / (closed ? N : N - 1)) * total;
      while (j < cumE.length - 2 && cumE[j + 1] < s) j++;
      const f = Math.min(1, Math.max(0, (s - cumE[j]) / (cumE[j + 1] - cumE[j] || 1)));
      const A = ext[j],
        B = ext[j + 1];
      this.x[i] = A[0] + (B[0] - A[0]) * f;
      this.y[i] = A[1] + (B[1] - A[1]) * f;
      this.z[i] = A[2] + (B[2] - A[2]) * f;
    }
    this.ds = total / (closed ? N : N - 1);
  }
  wrap(s) {
    if (this.closed) return ((s % this.length) + this.length) % this.length;
    return Math.min(this.length, Math.max(0, s));
  }
  // Fills out {x,y,z,tx,tz,nx,nz,heading,curv}.
  at(s, o = {}) {
    s = this.wrap(s);
    const N = this.n,
      u = s / this.ds,
      i = Math.floor(u),
      f = u - i;
    const i0 = this.closed ? i % N : Math.min(N - 1, i),
      i1 = this.closed ? (i + 1) % N : Math.min(N - 1, i + 1);
    o.x = this.x[i0] + (this.x[i1] - this.x[i0]) * f;
    o.y = this.y[i0] + (this.y[i1] - this.y[i0]) * f;
    o.z = this.z[i0] + (this.z[i1] - this.z[i0]) * f;
    const a = this.closed ? (i0 - 2 + N) % N : Math.max(0, i0 - 2),
      b = this.closed ? (i0 + 3) % N : Math.min(N - 1, i0 + 3);
    let tx = this.x[b] - this.x[a],
      tz = this.z[b] - this.z[a];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    o.tx = tx;
    o.tz = tz;
    o.nx = -tz;
    o.nz = tx;
    o.heading = Math.atan2(tz, tx);
    o.grade = (this.y[b] - this.y[a]) / (Math.hypot(this.x[b] - this.x[a], this.z[b] - this.z[a]) || 1);
    return o;
  }
  // Point at arc length s offset sideways by `off` (right positive).
  point(s, off = 0, o = {}) {
    this.at(s, o);
    o.x += o.nx * off;
    o.z += o.nz * off;
    return o;
  }
  // Nearest arc length to (x, z). With a hint, searches a window around it.
  project(x, z, hint = null, window = 400) {
    const N = this.n;
    let best = Infinity,
      bi = 0;
    if (hint == null) {
      for (let i = 0; i < N; i += 4) {
        const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
        if (d < best) (best = d), (bi = i);
      }
      hint = bi * this.ds;
      window = 12;
      best = Infinity;
    }
    const c = Math.round(this.wrap(hint) / this.ds),
      w = Math.ceil(window / this.ds);
    for (let k = -w; k <= w; k++) {
      let i = c + k;
      if (this.closed) i = ((i % N) + N) % N;
      else if (i < 0 || i >= N) continue;
      const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
      if (d < best) (best = d), (bi = i);
    }
    const s = bi * this.ds,
      p = this.at(s);
    const off = (x - p.x) * p.nx + (z - p.z) * p.nz,
      along = (x - p.x) * p.tx + (z - p.z) * p.tz;
    return { s: this.wrap(s + along), off, dist: Math.abs(off) };
  }
}
