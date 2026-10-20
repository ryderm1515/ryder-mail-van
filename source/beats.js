// Morning route: the film's timeline and the van's motion along the street.
//
// Everything is a pure function of time t (seconds from the start), so the
// film can pause, scrub and replay and always land on the same frame.
//
// Each alert beat plays one of Ryder's V4 cluster animations from the Figma
// file (8 s, ODC ADAS alerts) starting `at` seconds into the beat, with the
// chimes on the cue times printed in that video.

export const TITLE = "Morning route";

export const BEATS = [
  { id: "dawn", caption: "Seven a.m. on Willow Lane. Walt's first route in the new van.", duration: 11 },
  { id: "welcome", caption: "Grab the handle, step up, settle in. One press and the cluster wakes, checks every light, then settles on READY.", duration: 13, alert: 0, at: 4.6, tag: ["INFO", "Startup"] },
  { id: "seatbelt", caption: "Rolling out unbelted. Two soft chimes, then it insists until the belt clicks.", duration: 10, alert: 3, at: 0.4, tag: ["ADVISORY", "Seatbelt"] },
  { id: "glide", caption: "Silent all the way. Fully electric.", duration: 9 },
  { id: "blinker", caption: "Signal, then ease in to the kerb at number 14. One tick per flash.", duration: 9, alert: 2, at: 0.3, tag: ["INFO", "Turn signal"] },
  { id: "stop", caption: "First stop.", duration: 6 },
  { id: "delivery", caption: "Open, in, shut, flag up. The mail, right on time.", duration: 11 },
  { id: "wave", caption: "Say good morning.", duration: 10 },
  { id: "cross", caption: "Backing out for the next street. Traffic from the right: Theo on his bike.", duration: 10, alert: 8, at: 0, tag: ["CAUTION", "Cross traffic"] },
  { id: "approach", caption: "Two streets over, Pepper has a brand-new ball.", duration: 8 },
  { id: "fcw", caption: "A ball bounces into the street, and Pepper wanders out after it. The cluster takes over: brake now.", duration: 18, alert: 5, at: 7.6, tag: ["CRITICAL", "Forward collision"] },
  { id: "away", caption: "Everyone's fine. On to the next street.", duration: 9 },
  { id: "finale", caption: "The new electric route van. Quiet, clean, on time.", duration: 16 },
];

// Chime cues (seconds into each 8 s clip), from the V4 cue sheets.
export const CUES = {
  0: [[1.0, "welcome"]],
  1: [2, 3, 4, 5].map((t) => [t, "door"]),
  2: [0.8, 1.5, 2.2, 2.9, 4.4, 5.1, 5.8, 6.5].map((t) => [t, "blinker"]),
  3: [2.0, 2.8, 3.6, 4.0, 4.4, 4.8, 5.2].map((t) => [t, "belt"]),
  4: [[2.0, "park"], [2.8, "park"], [3.6, "park"], [4.2, "park"], [4.8, "park-near"], [5.1, "park-near"], [5.4, "park-near"], [5.7, "park-near"], [6.0, "park-near"], [6.2, "park-solid"]],
  5: [2.6, 3.0, 3.4, 3.8].map((t) => [t, "fcw"]),
  6: [3.0, 3.4, 3.8, 5.0, 6.2, 7.4].map((t) => [t, "thermal"]),
  7: [2.5, 3.1].map((t) => [t, "lane"]),
  8: [[3.2, "cross"]],
};

export const STARTS = [];
let acc = 0;
for (const b of BEATS) {
  STARTS.push(acc);
  acc += b.duration;
}
export const TOTAL = acc;
export const startOf = (id) => STARTS[BEATS.findIndex((b) => b.id === id)];

export function beatAt(t) {
  t = Math.min(TOTAL, Math.max(0, t));
  let i = 0;
  while (i < BEATS.length - 1 && t >= STARTS[i + 1]) i++;
  return { i, u: Math.min(1, (t - STARTS[i]) / BEATS[i].duration) };
}
// Time into the alert clip for beat i (null outside it).
export function clipTime(t, i) {
  const b = BEATS[i];
  if (b.alert == null) return null;
  const vt = t - STARTS[i] - b.at;
  return vt < 0 ? null : Math.min(8, vt);
}

const smooth = (x) => {
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
};

// Velocity shapes on [0, T] (ease in over a, out over d), with integrals.
const tables = new Map();
function shape(T, a, d) {
  const key = T + ":" + a + ":" + d;
  if (tables.has(key)) return tables.get(key);
  const n = 2000,
    w = (t) => (a ? smooth(t / a) : 1) * (d ? smooth((T - t) / d) : 1),
    cum = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const t0 = ((i - 1) / n) * T,
      t1 = (i / n) * T;
    cum[i] = cum[i - 1] + ((w(t0) + w(t1)) / 2) * (t1 - t0);
  }
  const out = { T, a, d, w, cum, n, total: cum[n] };
  tables.set(key, out);
  return out;
}
function integral(sh, t) {
  t = Math.min(sh.T, Math.max(0, t));
  const x = (t / sh.T) * sh.n,
    i = Math.min(sh.n - 1, Math.floor(x)),
    f = x - i;
  return sh.cum[i] + (sh.cum[i + 1] - sh.cum[i]) * f;
}

// Key times.
export const TIMES = {};
TIMES.roll = startOf("seatbelt") + 1.0;
TIMES.arrive = startOf("delivery") - 0.2;
TIMES.reverse = [startOf("cross") + 0.8, startOf("cross") + 3.1];
TIMES.drive = startOf("approach") + 0.6;
TIMES.fcwStop = startOf("fcw") + 7.6 + 5.0;
TIMES.leave = startOf("away") + 1.5;

function moves(S, Sd, L) {
  return [
    { t0: TIMES.roll, t1: TIMES.arrive, s0: 0, s1: S, a: 5, d: 8 },
    { t0: TIMES.reverse[0], t1: TIMES.reverse[1], s0: S, s1: S - 2.5, a: 0.8, d: 0.8 },
    { t0: TIMES.drive, t1: TIMES.fcwStop, s0: S - 2.5, s1: Sd, a: 3, d: 1.4 },
    { t0: TIMES.leave, t1: TOTAL, s0: Sd, s1: Math.min(L - 3, Sd + 190), a: 6, d: 0 },
  ];
}

// The van's state at time t. stops = [S, Sd].
export function vanAt(t, route, stops) {
  const [S, Sd] = stops;
  const M = moves(S, Sd, route.length);
  let s = 0,
    speed = 0,
    braking = 0;
  for (const m of M) {
    if (t < m.t0) break;
    const sh = shape(m.t1 - m.t0, m.a, m.d),
      k = (m.s1 - m.s0) / sh.total,
      u = t - m.t0;
    s = m.s0 + k * integral(sh, u);
    speed = u < sh.T ? k * sh.w(u) : 0;
    if (m.d && u > sh.T - m.d && u < sh.T) braking = 1 - sh.w(u);
  }
  const reverse = t > TIMES.reverse[0] - 0.4 && t < TIMES.reverse[1] + 0.4;
  // Driver door (0..1): Walt gets in at the start, out at number 14, back in after the wave.
  const W = startOf("welcome"),
    D = startOf("delivery"),
    V = startOf("wave"),
    span = (a, b, c, d) => smooth((t - a) / (b - a)) * (1 - smooth((t - c) / (d - c)));
  const doorOpen = Math.max(span(W + 0.2, W + 1.1, W + 4.0, W + 4.8), span(D - 0.2, D + 0.6, V + 8.9, V + 9.6));
  return { s, speed: Math.abs(speed), dir: Math.sign(speed) || 1, braking: Math.min(1, Math.max(0, braking)), doorOpen, reverse, lat: 0 };
}
