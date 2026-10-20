// A drivable path through a list of ground points, sampled by distance.
//
// Centripetal Catmull-Rom through the points (no overshoot at tight corners),
// tabulated densely so `at(s)` is a cheap lookup: position, the van's yaw in
// the same convention as physics.teleport (body nose is local -x), and signed
// curvature for body roll.

const SUB = 160; // table samples per segment

function catmull(p0, p1, p2, p3, t) {
  const d = (a, b) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0,
    t1 = t0 + d(p0, p1),
    t2 = t1 + d(p1, p2),
    t3 = t2 + d(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const lerp = (a, b, ta, tb) => {
    const k = (u - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  };
  const a1 = lerp(p0, p1, t0, t1),
    a2 = lerp(p1, p2, t1, t2),
    a3 = lerp(p2, p3, t2, t3),
    b1 = lerp(a1, a2, t0, t2),
    b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

export function makeRoute(points, { closed = false } = {}) {
  const P = points.map((p) => [p[0], p[1]]);
  const n = P.length;
  const get = (i) => (closed ? P[((i % n) + n) % n] : i < 0 ? [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]] : i >= n ? [2 * P[n - 1][0] - P[n - 2][0], 2 * P[n - 1][1] - P[n - 2][1]] : P[i]);
  const segs = closed ? n : n - 1;
  const xs = [],
    zs = [],
    ss = [];
  let total = 0;
  for (let i = 0; i < segs; i++)
    for (let k = i === 0 ? 0 : 1; k <= SUB; k++) {
      const [x, z] = catmull(get(i - 1), get(i), get(i + 1), get(i + 2), k / SUB);
      if (xs.length) total += Math.hypot(x - xs[xs.length - 1], z - zs[zs.length - 1]);
      xs.push(x);
      zs.push(z);
      ss.push(total);
    }
  const count = xs.length;
  const locate = (s) => {
    let lo = 0,
      hi = count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ss[mid] <= s) lo = mid;
      else hi = mid;
    }
    const span = ss[hi] - ss[lo] || 1;
    return { i: lo, f: Math.min(1, Math.max(0, (s - ss[lo]) / span)) };
  };
  const point = (s) => {
    const { i, f } = locate(s),
      j = Math.min(count - 1, i + 1);
    return [xs[i] + (xs[j] - xs[i]) * f, zs[i] + (zs[j] - zs[i]) * f];
  };
  const heading = (s) => {
    const h = 0.25,
      a = point(Math.max(0, s - h)),
      b = point(Math.min(total, s + h));
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  return {
    length: total,
    closed,
    at(s) {
      s = Math.min(total, Math.max(0, s));
      const [x, z] = point(s),
        th = heading(s);
      const k = 0.6,
        t1 = heading(Math.max(0, s - k)),
        t2 = heading(Math.min(total, s + k));
      let dth = t2 - t1;
      while (dth > Math.PI) dth -= 2 * Math.PI;
      while (dth < -Math.PI) dth += 2 * Math.PI;
      const ds = Math.min(total, s + k) - Math.max(0, s - k) || 1;
      // Nose (local -x) along the travel direction (cos th, sin th):
      // -cos(yaw) = cos th, sin(yaw) = sin th  ->  yaw = PI - th.
      let yaw = Math.PI - th;
      if (yaw > Math.PI) yaw -= 2 * Math.PI;
      return { x, z, yaw, curvature: dth / ds };
    },
  };
}
