import * as T from "three";
import { Town, ORIGIN } from "./town.js";
import { Ambience } from "./ambience.js";
import { TourMusic } from "./music.js";
import { Cinema } from "./cinema.js";
import { BEATS, STARTS, TOTAL, TITLE, TIMES, CUES, beatAt, vanAt, clipTime, startOf } from "./beats.js";
import { Crew } from "./crew.js";

// Morning Route: a short film of the new electric mail van on its morning
// round through Willow Lane.
//
// Like the walkthrough, everything is a pure function of the film time t, so
// pausing, skipping and replaying land on the same frame. Physics is paused
// while it plays; the van is placed on the street each frame from beats.js.

const ease = (x) => {
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
};
const span = (u, a, b) => ease((u - a) / (b - a));
const v3 = (x, y, z) => new T.Vector3(x, y, z);
const WHEEL_R = 0.43;
const RIDE = 0.95; // body origin height that puts the tyres on the road (settled van: 0.88 + tyre squash)

// Rig controls the film drives (and hands back on exit).
const CTL = {
  door: ["DOOR_L", "Open"],
  latch: ["DOOR_LATCH_L", "Pull"],
  window: ["WINDOW_L", "Lower"],
  steer: ["SETTINGS", "Steering"],
  brake: ["LIGHTING", "Brake"],
  running: ["LIGHTING", "Running"],
  head: ["LIGHTING", "Headlights"],
  hazards: ["LIGHTING", "Hazards"],
  cab: ["LIGHTING", "Cab"],
  belt: ["SEATBELT", "Fasten"],
};
const WHEELS = ["FL", "FR", "RL", "RR"];

const lin = (u, a, b) => Math.min(1, Math.max(0, (u - a) / (b - a)));
const smooth01 = (x) => x * x * x * (x * (6 * x - 15) + 10);
export class Film {
  constructor(o) {
    Object.assign(this, o); // scene, renderer, persp, physics, vehicle, rig, dash, audio, ui, actions, lights, toon, onExit
    this.active = false;
    this.ready = false;
    this.playing = false;
    this.t = 0;
    this.beats = BEATS;
    this.starts = STARTS;
    this.total = TOTAL;
    this.vanState = { s: 0, speed: 0, braking: 0, doorOpen: 0 };
    this.music = new TourMusic(this.audio, { bpm: 66, voice: "piano", level: 0.3 });
    this.ambience = new Ambience(this.audio);
    this.cam = { pos: new T.Vector3(), look: new T.Vector3(), fov: 40 };
    this.buildUI();
  }
  buildUI() {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<section id="film" class="film" hidden aria-label="${TITLE}, a short film">
        <div class="film-bar top"><div class="film-controls"><button id="film-prev" aria-label="Previous scene" data-tip="Previous · ←"></button><button id="film-play" aria-label="Pause" data-tip="Pause · Space"></button><button id="film-next" aria-label="Next scene" data-tip="Next · →"></button><button id="film-exit" aria-label="Exit film" data-tip="Exit · Esc"></button></div></div>
        <div class="film-card" aria-hidden="true"><p class="kicker">A short film</p><h2>${TITLE}</h2><p>Willow Lane, first light</p></div><div class="film-card end" aria-hidden="true"><p class="kicker">The new electric route van</p><h2>Quiet. Clean. On time.</h2></div>
        <div class="film-bar bottom"><p class="film-caption" aria-live="polite"></p><div class="film-end" hidden><button id="film-drive" class="tour-primary">Drive it</button><button id="film-replay" class="tour-secondary">Replay</button></div><div class="film-progress"><i></i></div></div>
        <div class="film-fade"></div>
      </section>`,
    );
    const $ = (id) => document.getElementById(id);
    this.el = $("film");
    this.caption = this.el.querySelector(".film-caption");
    this.card = this.el.querySelector(".film-card");
    this.endCard = this.el.querySelector(".film-card.end");
    this.endEl = this.el.querySelector(".film-end");
    this.fade = this.el.querySelector(".film-fade");
    this.progress = this.el.querySelector(".film-progress i");
    for (const [id, icon] of [
      ["film-prev", "player-track-prev"],
      ["film-play", "player-pause"],
      ["film-next", "player-track-next"],
      ["film-exit", "x"],
    ])
      this.ui?.icon(id, icon);
    $("film-prev").onclick = () => this.step(-1);
    $("film-next").onclick = () => this.step(1);
    $("film-play").onclick = () => this.toggle();
    $("film-exit").onclick = () => this.exit();
    $("film-drive").onclick = () => this.exit("drive");
    $("film-replay").onclick = () => {
      this.seek(0);
      this.setPlaying(true);
    };
  }
  async start() {
    if (this.active) return;
    this.nearRest = this.persp.near;
    this.active = true;
    this.ready = false;
    const token = (this.token = {});
    this.actions.stopTour?.();
    document.body.classList.add("touring", "filming");
    this.el.hidden = false;
    this.fade.classList.add("on");
    this.physics.paused = true;
    if (!this.actions.isOn?.()) this.actions.power?.();
    this.actions.setCamera?.(4);
    this.town = new Town(this.scene, this.renderer, { lights: this.lights, toon: this.toon });
    const town = this.town;
    this.crew = new Crew(this.scene, this.toon);
    await Promise.all([town.build(), this.crew.load()]);
    if (this.token !== token) {
      town.dispose();
      this.crew.dispose();
      return;
    }
    this.setupStory();
    // Warm the V4 alert clips so the cluster never shows a blank frame.
    const ext = document.createElement("video").canPlayType('video/mp4; codecs="avc1.640028"') ? ".mp4" : ".webm";
    for (let i = 0; i < 9; i++) fetch("./assets/alerts/a" + i + ext).catch(() => {});
    if (this.dash) this.dash.filmControl = true;
    this.cinema ||= new Cinema(this.renderer, this.scene, this.persp);
    this.persp.aspect = innerWidth / innerHeight;
    this.persp.updateProjectionMatrix();
    this.t = 0;
    this.prevT = 0;
    this.shown = -1;
    this.spin = 0;
    // Warm up behind the fade: compile every shader and upload every texture
    // the opening shot needs, so the first dawn pan isn't a stuttering mess
    // on a cold load (it only looked right after a refresh before).
    this.ready = true;
    this.setPlaying(false);
    this.update(0);
    try {
      await this.renderer.compileAsync?.(this.scene, this.persp);
    } catch {}
    for (let i = 0; i < 4; i++) {
      if (this.token !== token) return;
      this.t = 0;
      this.update(0);
      this.cinema.render(0, { focus: 0 });
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (this.token !== token) return;
    this.t = this.prevT = 0;
    this.shown = -1;
    this.update(0);
    this.setPlaying(true);
    requestAnimationFrame(() => this.fade.classList.remove("on"));
    this.audio
      .unlock?.()
      .then(() => {
        if (this.token !== token || !this.active) return;
        this.music.start();
        this.ambience.start();
      })
      .catch(() => {});
  }
  exit(next = null) {
    if (!this.active) return;
    this.persp.near = this.nearRest ?? this.persp.near;
    this.persp.updateProjectionMatrix();
    this.active = false;
    this.ready = false;
    this.token = null;
    this.setPlaying(false);
    this.music.stop(1.2);
    this.ambience.stop(1.2);
    this.town?.dispose();
    this.town = null;
    this.crew?.dispose();
    this.crew = null;
    if (this.dash) {
      this.dash.filmControl = false;
      this.dash.filmPlaying = undefined;
      this.dash.showAlert(null);
    }
    this.el.hidden = true;
    this.fade.classList.remove("on");
    document.body.classList.remove("touring", "filming");
    this.rig.reset();
    this.physics.paused = false;
    this.actions.teleport?.("garage");
    if (next === "drive") {
      this.actions.setCamera?.(1);
      this.actions.drive?.();
    } else {
      this.actions.setCamera?.(0);
      this.onExit?.();
    }
  }
  setPlaying(on) {
    this.playing = on;
    this.ui?.icon("film-play", on ? "player-pause" : "player-play");
    const b = document.getElementById("film-play");
    if (b) {
      b.setAttribute("aria-label", on ? "Pause" : "Play");
      b.dataset.tip = (on ? "Pause" : "Play") + " · Space";
    }
  }
  toggle() {
    if (this.t >= this.total - 0.01) {
      this.seek(0);
      this.setPlaying(true);
      return;
    }
    this.setPlaying(!this.playing);
  }
  step(dir) {
    const { i } = beatAt(this.t);
    const k = Math.min(BEATS.length - 1, Math.max(0, i + dir));
    this.seek(STARTS[k] + 0.001);
  }
  seek(t) {
    this.t = Math.min(this.total, Math.max(0, t));
    this.prevT = this.t; // no foley for jumps
    this.shown = -1;
    this.snap = true; // mechanisms jump to the new frame instead of easing
  }
  key(e) {
    if (!this.active) return false;
    const k = e.key.toLowerCase();
    if (k === " ") this.toggle();
    else if (k === "arrowright") this.step(1);
    else if (k === "arrowleft") this.step(-1);
    else if (k === "escape") this.exit();
    else return true;
    e.preventDefault();
    return true;
  }
  // ------------------------------------------------------------ the story
  setupStory() {
    const town = this.town,
      R = town.route,
      S = town.stops[0];
    const lot = town.lots.find((l) => l.num === 18) || town.lots[town.lots.length - 2];
    const gate = lot.gate.clone().add(town.origin);
    let best = 0,
      bd = 1e9;
    for (let d = 0; d < R.length; d += 0.25) {
      const p = R.at(d),
        dd = Math.hypot(p.x - gate.x, p.z - gate.z);
      if (dd < bd) (bd = dd), (best = d);
    }
    const dogS = Math.min(R.length - 80, Math.max(S + 50, best));
    this.stopsArr = [S, dogS - 6.2];
    this.dogS = dogS;
    this.dogGate = gate.setY(0);
    // Mailbox handle and flag points in their own local space, so the hand
    // can follow them as they swing.
    const mb = town.mailbox;
    town.group.updateMatrixWorld(true);
    const local = (o, pick) => {
      if (!o) return null;
      const box = new T.Box3().setFromObject(o);
      const p = pick(box);
      return o.worldToLocal(p.clone());
    };
    const mbW = town.anchors.mailbox.clone().setY(0);
    const street = R.at(S).x !== undefined ? v3(R.at(S).x, 0, R.at(S).z) : mbW;
    const toStreet = street.clone().sub(mbW).setY(0).normalize();
    this.mail = {
      toStreet,
      handle: local(mb?.door, (b) => {
        const c = b.getCenter(v3());
        return v3(c.x, b.max.y - 0.02, c.z);
      }),
      flag: local(mb?.flag, (b) => b.getCenter(v3())),
      mouth: (() => {
        if (!mb?.door) return mbW.clone().setY(1.05);
        const b = new T.Box3().setFromObject(mb.door),
          c = b.getCenter(v3());
        return c.addScaledVector(toStreet, -0.2);
      })(),
    };
    const front = mb?.door ? new T.Box3().setFromObject(mb.door).getCenter(v3()).setY(0) : mbW.clone();
    this.mail.stand = front.addScaledVector(toStreet, 0.5);
  }
  frameAtS(s, lat = 0) {
    const p = this.town.route.at(s),
      left = v3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    const m = new T.Matrix4().compose(v3(p.x, RIDE, p.z).addScaledVector(left, lat), new T.Quaternion().setFromEuler(new T.Euler(0, p.yaw, 0)), v3(1, 1, 1));
    return { at: (x, y, z) => v3(x, y, z).applyMatrix4(m), left, fwd: v3(-Math.cos(p.yaw), 0, Math.sin(p.yaw)), pos: v3(p.x, 0, p.z) };
  }
  // ----------------------------------------------------------------- van
  placeVan(dt) {
    const town = this.town,
      t = this.t,
      st = (this.vanState = vanAt(t, town.route, this.stopsArr)),
      p = town.route.at(st.s);
    const roll = Math.max(-0.05, Math.min(0.05, -p.curvature * st.speed * st.speed * 0.012)),
      pitch = st.braking * st.speed * 0.012 - (st.speed > 0 && st.braking === 0 ? 0.004 : 0),
      bob = Math.sin(st.s * 1.7) * 0.004 * Math.min(1, st.speed / 4);
    const V = this.vehicle;
    V.position.set(p.x, RIDE + bob, p.z);
    V.quaternion.setFromEuler(new T.Euler(0, p.yaw, 0, "YXZ")).multiply(new T.Quaternion().setFromEuler(new T.Euler(roll, 0, -pitch)));
    V.updateMatrixWorld();
    this.physics.speed = st.speed * st.dir;
    const deg = (-(st.s / WHEEL_R) * 180) / Math.PI;
    for (const w of WHEELS) this.rig.set("WHEEL_" + w, "Spin", deg, true);
    this.rig.set(...CTL.steer, (Math.atan(p.curvature * 3.3) * 180) / Math.PI / 0.62, true);
    const blink = Math.sin(t * Math.PI * 2 * 1.3) > 0 ? 1 : 0;
    const D = startOf("delivery"),
      C = startOf("cross");
    const bi = BEATS.findIndex((b) => b.id === "blinker"),
      bv = clipTime(t, bi);
    const sigL = bv != null && bv > 0.6 && bv < 3.1,
      sigR = bv != null && bv > 4.2 && bv < 6.7;
    const flash = bv != null ? ((((bv - 0.8) % 0.7) + 0.7) % 0.7) < 0.35 : 0;
    this.rig.set("LIGHTING", "Indicator L", sigL && flash ? 1 : 0, true);
    this.rig.set("LIGHTING", "Indicator R", sigR && flash ? 1 : 0, true);
    this.rig.set("LIGHTING", "Reverse", st.reverse ? 1 : 0, true);
    this.rig.set(...CTL.brake, st.braking > 0.05 || (st.speed < 0.01 && t > TIMES.roll) ? 1 : 0, true);
    this.rig.set(...CTL.running, t > startOf("welcome") + 1 ? 1 : 0, true);
    this.rig.set(...CTL.head, t > startOf("welcome") + 1 && t < STARTS[4] ? 1 : 0, true);
    this.rig.set(...CTL.hazards, t > D + 1 && t < C ? blink : 0, true);
    this.rig.set(...CTL.door, st.doorOpen, true);
    this.rig.set(...CTL.window, 0, true);
    this.rig.set(...CTL.latch, st.doorOpen > 0.02 && st.doorOpen < 0.3 ? 1 : 0, true);
    this.rig.set(...CTL.cab, 1, true);
    this.rig.set(...CTL.belt, this.beltK ?? 0, true);
    if (this.snap) {
      this.snap = false;
      this.rig.update(0, true);
    }
    return st;
  }
  frame() {
    const V = this.vehicle,
      m = V.matrixWorld;
    const at = (x, y, z) => v3(x, y, z).applyMatrix4(m);
    const fwd = v3(-1, 0, 0).transformDirection(m),
      right = v3(0, 0, -1).transformDirection(m);
    return { at, fwd, right, pos: V.position.clone() };
  }
  cab(x, y, z) {
    const hr = v3();
    this.rig.bones.HEADREST?.pose.getWorldPosition(hr);
    return hr.add(v3(x, y, z).applyQuaternion(this.vehicle.quaternion));
  }
  pod() {
    return this.dash?.pod ? this.dash.pod.getWorldPosition(v3()) : this.frame().at(-1.58, 0.79, -0.53);
  }
  // ---------------------------------------------------------------- cast
  poseCast(t, F) {
    const crew = this.crew;
    if (!crew) return;
    const A = this.town.anchors,
      M = this.mail,
      mbx = this.town.mailbox;
    const W = startOf("welcome"),
      D = startOf("delivery"),
      Wv = startOf("wave"),
      q = this.vehicle.quaternion;
    const vz = v3(0, 0, 1).applyQuaternion(q), // toward the passenger side
      vup = v3(0, 1, 0).applyQuaternion(q);
    const seatQ = q.clone().multiply(new T.Quaternion().setFromAxisAngle(v3(0, 1, 0), -Math.PI / 2));
    const g = -RIDE; // ground height in van-local space
    const seatPos = this.cab(-0.1, -1.55, 0);
    const doorPt = F.at(-0.95, g, -1.95).setY(0);
    const outPt = F.at(-0.95, g, -2.35).setY(0);
    const stepPt = F.at(-0.95, g + 0.36, -1.42);
    const floorPt = F.at(-0.98, g + 0.6, -0.92);
    const pillar = F.at(-1.4, g + 1.5, -1.12); // grab handle on the A-pillar
    const frameR = F.at(-0.42, g + 1.28, -1.1); // door frame behind the seat
    const yawTo = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
    const faceVan = yawTo(doorPt, F.pos.clone().setY(0));
    const vf = v3(-1, 0, 0).applyQuaternion(q);
    const yawFwd = Math.atan2(vf.x, vf.z);
    const yq = (y) => new T.Quaternion().setFromAxisAngle(v3(0, 1, 0), y);
    const lerpA = (a, b, k) => {
      let d = b - a;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return a + d * k;
    };
    // Smooth keyframe track (cubic Hermite through every key, C1 continuous).
    const track = (k, keys) => {
      if (k <= keys[0][0]) return keys[0][1].clone ? keys[0][1].clone() : keys[0][1];
      const n = keys.length - 1;
      if (k >= keys[n][0]) return keys[n][1].clone ? keys[n][1].clone() : keys[n][1];
      let i = 0;
      while (k > keys[i + 1][0]) i++;
      const [t0, p0] = keys[i],
        [t1, p1] = keys[i + 1];
      const h = t1 - t0,
        s = (k - t0) / h;
      const tan = (j) => {
        if (j <= 0 || j >= n) return null;
        const [ta, pa] = keys[j - 1],
          [tb, pb] = keys[j + 1];
        return pa.clone ? pb.clone().sub(pa).multiplyScalar(h / (tb - ta)) : ((pb - pa) * h) / (tb - ta);
      };
      const m0 = tan(i),
        m1 = tan(i + 1);
      const h00 = 2 * s ** 3 - 3 * s * s + 1,
        h10 = s ** 3 - 2 * s * s + s,
        h01 = -2 * s ** 3 + 3 * s * s,
        h11 = s ** 3 - s * s;
      if (p0.clone) {
        const r = p0.clone().multiplyScalar(h00).addScaledVector(p1, h01);
        if (m0) r.addScaledVector(m0, h10);
        if (m1) r.addScaledVector(m1, h11);
        return r;
      }
      return p0 * h00 + p1 * h01 + (m0 || 0) * h10 + (m1 || 0) * h11;
    };
    const bump = (k, a, b, c) => sm((k - a) / (b - a)) * (1 - sm((k - b) / (c - b)));
    // Hands on the wheel rim at ten-to-two, from the wheel mesh itself.
    if (!this.wheelLocal) {
      const m = this.rig.meshes?.find((x) => x.userData?.bone === "STEERING_WHEEL");
      this.vehicle.updateMatrixWorld(true);
      const c = m ? new T.Box3().setFromObject(m).getCenter(v3()) : this.rig.bones.STEERING_WHEEL?.pose.getWorldPosition(v3());
      this.wheelLocal = c ? this.vehicle.worldToLocal(c.clone()) : v3(-1.3, 0.5, -0.55);
    }
    const wc = this.vehicle.localToWorld(this.wheelLocal.clone());
    const toDriver = this.cab(-0.25, 0, 0).sub(wc).normalize();
    const wheelL = wc.clone().addScaledVector(vz, 0.165).addScaledVector(vup, 0.06).addScaledVector(toDriver, 0.02),
      wheelR = wc.clone().addScaledVector(vz, -0.165).addScaledVector(vup, 0.06).addScaledVector(toDriver, 0.02);
    const elbowsOut = (s) => vup.clone().negate().addScaledVector(vz, s * 0.75).normalize();
    const restHand = (pos, yaw, s) => pos.clone().add(v3(0, 0.83, 0)).addScaledVector(v3(Math.cos(yaw), 0, -Math.sin(yaw)), 0.24 * s).addScaledVector(v3(Math.sin(yaw), 0, Math.cos(yaw)), 0.03);
    const seat = (extra = {}) => ({ pos: seatPos, quat: seatQ, seated: 1, handL: wheelL, handR: wheelR, poleL: elbowsOut(1), poleR: elbowsOut(-1), head: Math.sin(t * 0.37) * 0.08, ...extra });
    // Walk from a to b over [t0, t0+dur], easing in and out of a steady pace.
    const walkTo = (a, b, t0, dur, fromYaw) => {
      const k = Math.min(1, Math.max(0, (t - t0) / dur)),
        e = 0.2,
        f = k < e ? (k * k) / (2 * e * (1 - e)) : k > 1 - e ? 1 - ((1 - k) * (1 - k)) / (2 * e * (1 - e)) : (k - e / 2) / (1 - e);
      const d = a.distanceTo(b),
        yaw = yawTo(a, b);
      const turn = fromYaw == null ? 1 : sm((t - t0) / 0.45);
      const stepTurn = fromYaw == null ? 0 : (1 - turn) * Math.min(1, Math.abs(lerpA(fromYaw, yaw, 1) - fromYaw) * 2);
      return { pos: a.clone().lerp(b, f), yaw: fromYaw == null ? yaw : lerpA(fromYaw, yaw, turn), walk: Math.max(k > 0 && k < 1 ? Math.min(1, Math.min(k, 1 - k) * 8) : 0, 0.55 * stepTurn * (k > 0 ? 1 : 0)), phase: d * f * 4.3 + turn * 3.1 };
    };
    // Climb in: grab the pillar handle, step onto the running board, pull up,
    // turn and drop into the seat, hands to the wheel.
    const climbIn = (k) => {
      const pos = track(k, [[0, doorPt], [0.45, doorPt], [0.95, stepPt], [1.45, floorPt], [2.05, floorPt.clone().lerp(seatPos, 0.45)], [2.6, seatPos]]);
      const turn = sm((k - 1.3) / 0.8),
        seated = sm((k - 1.85) / 0.75);
      const yaw = lerpA(faceVan, yawFwd, turn);
      const quat = yq(yaw).slerp(seatQ, seated);
      const legs = {
        thL: -1.15 * bump(k, 0.35, 0.7, 1.05),
        shL: 1.4 * bump(k, 0.35, 0.7, 1.1),
        thR: 0.3 * bump(k, 0.8, 1.0, 1.15) - 1.05 * bump(k, 1.05, 1.25, 1.55),
        shR: 0.45 * bump(k, 0.8, 1.0, 1.15) + 1.35 * bump(k, 1.05, 1.25, 1.6),
        dip: -0.05 * bump(k, 0.3, 0.55, 0.9),
      };
      const rL = restHand(pos, yaw, 1),
        rR = restHand(pos, yaw, -1);
      let handL = rL.lerp(pillar, sm((k - 0.1) / 0.35));
      if (k > 1.7) handL = pillar.clone().lerp(wheelL, sm((k - 1.75) / 0.8));
      let handR = rR.lerp(frameR, sm((k - 0.5) / 0.4));
      if (k > 1.5) handR = frameR.clone().lerp(wheelR, sm((k - 1.6) / 0.9));
      return { pos, quat, seated, legs, handL, handR, lean: 0.12 * bump(k, 0.5, 1.0, 1.6), poleL: elbowsOut(1), poleR: elbowsOut(-1), head: 0.15 * bump(k, 0, 0.4, 1) };
    };
    // Climb out: stand and turn to the door, hand on the pillar, step down
    // onto the running board, then the ground.
    // Climb out at the mailbox: stand and turn a quarter toward the box, hand
    // on the pillar, step down onto the running board and land right where the
    // delivery starts, already facing the mailbox, feet planted.
    const landPt = M.stand.clone().setY(0),
      yawLand = yawTo(landPt, A.mailbox.clone().setY(0));
    const climbOut = (k) => {
      const pos = track(k, [[0, seatPos], [0.9, floorPt.clone().lerp(seatPos, 0.35)], [1.35, floorPt], [2.0, stepPt], [2.65, landPt], [3.0, landPt]]);
      const stand = 1 - sm(k / 0.9);
      const quat = seatQ.clone().slerp(yq(yawLand), sm((k - 0.25) / 1.05));
      const legs = {
        thR: -0.75 * bump(k, 1.35, 1.7, 2.0) - 0.5 * bump(k, 2.0, 2.3, 2.65),
        shR: 0.35 * bump(k, 1.35, 1.7, 2.0) + 0.4 * bump(k, 2.0, 2.3, 2.65),
        thL: -0.6 * bump(k, 1.9, 2.25, 2.65),
        shL: 0.9 * bump(k, 1.45, 1.9, 2.25) + 0.7 * bump(k, 1.9, 2.25, 2.65),
        dip: -0.06 * bump(k, 1.35, 1.9, 2.4) - 0.035 * bump(k, 2.55, 2.75, 3.0),
      };
      let handL = wheelL.clone().lerp(pillar, sm((k - 0.15) / 0.65));
      if (k > 2.2) handL = pillar.clone().lerp(restHand(pos, yawLand, 1), sm((k - 2.2) / 0.5));
      const handR = k < 0.7 ? wheelR.clone().lerp(frameR, sm(k / 0.7)) : frameR.clone().lerp(restHand(pos, yawLand, -1), sm((k - 0.9) / 0.9));
      return { pos, quat, seated: stand, legs, handL, handR, letter: true, poleL: elbowsOut(1), poleR: elbowsOut(-1), nod: 0.12 * sm((k - 2.4) / 0.4) };
    };
    let w,
      mail = null;
    this.beltK = 0;
    const sb = BEATS.findIndex((b) => b.id === "seatbelt");
    const sv = clipTime(t, sb);
    const CLIMB_IN = W + 1.2,
      OUT0 = D + 0.6,
      BACK = Wv + 6.0;
    if (t < W) {
      const u = (t - STARTS[0]) / BEATS[0].duration,
        from = F.at(11, g, -2.1).setY(0);
      w = walkTo(from, doorPt, STARTS[0] + BEATS[0].duration * 0.3, BEATS[0].duration * 0.66);
      if (u > 0.96) w.yaw = lerpA(w.yaw, faceVan, sm((u - 0.96) / 0.04));
    } else if (t < CLIMB_IN) {
      // Reach for the handle and pull the door open.
      const k = t - W;
      const handle = F.at(-0.62 + 0.5 * this.vanState.doorOpen, g + 1.12, -1.32);
      w = { pos: doorPt, yaw: faceVan, handR: restHand(doorPt, faceVan, -1).lerp(handle, sm(k / 0.3)), head: 0.1 };
    } else if (t < D - 1.0) {
      w = t < CLIMB_IN + 2.6 ? climbIn(t - CLIMB_IN) : seat();
      this.beltK = sv == null ? (t > STARTS[sb] + 5 ? 1 : 0) : sm((sv - 4.0) / 1.5);
      if (sv != null && sv > 2.8 && sv < 6.8) {
        // Buckle up along one continuous path: off the wheel, up past the
        // shoulder to the belt, across the chest, click, back to the wheel.
        const sh = this.shoulderR || this.cab(-0.18, -0.3, -0.19);
        const at = (f, u2, l) => sh.clone().addScaledVector(vf, f).addScaledVector(vup, u2).addScaledVector(vz, l);
        const keys = [
          [2.8, wheelR],
          [3.45, at(0.2, -0.02, -0.08)],
          [3.95, at(-0.06, 0.13, -0.11)],
          [4.2, at(-0.04, 0.1, -0.1)],
          [4.85, at(0.22, -0.26, 0.17)],
          [5.45, at(0.15, -0.5, 0.34)],
          [5.75, at(0.15, -0.53, 0.34)],
          [6.6, wheelR],
        ];
        w.handR = track(sv, keys);
        // Left hand drops to the bottom of the rim so the reach across the chest reads.
        const low = wc.clone().addScaledVector(vup, -0.13).addScaledVector(vz, 0.06);
        w.handL = wheelL.clone().lerp(low, bump(sv, 2.8, 3.4, 6.4));
        w.poleR = vup.clone().multiplyScalar(-0.6).addScaledVector(vz, -0.8).normalize();
        w.head = -0.55 * bump(sv, 3.0, 3.7, 4.4) + 0.4 * bump(sv, 4.6, 5.3, 6.0);
        w.nod = 0.28 * bump(sv, 4.6, 5.3, 6.0);
      }
    } else if (t < OUT0) {
      // Unbuckle: thumb the release, guide the belt back to the pillar.
      w = seat();
      const k = t - (D - 1.0);
      const sh = this.shoulderR || this.cab(-0.18, -0.3, -0.19);
      const at = (f, u2, l) => sh.clone().addScaledVector(vf, f).addScaledVector(vup, u2).addScaledVector(vz, l);
      w.handR = track(k, [[0, wheelR], [0.45, at(0.15, -0.5, 0.34)], [0.6, at(0.15, -0.53, 0.34)], [1.05, at(0.12, -0.15, 0.05)], [1.4, at(0.05, -0.05, -0.12)]]);
      w.poleR = vup.clone().negate().addScaledVector(vz, -0.9).normalize();
      w.nod = 0.25 * bump(k, 0.2, 0.5, 1.0);
      this.beltK = 1 - sm((k - 0.55) / 0.6);
    } else if (t < OUT0 + 3.0) w = climbOut(t - OUT0);
    else {
      // At the mailbox: open, letter in, shut, flag up.
      const stand = M.stand,
        faceBox = yawTo(stand, A.mailbox),
        dt = t - D;
      const handle = M.handle && mbx?.door ? mbx.door.localToWorld(M.handle.clone()) : A.mailbox.clone().setY(1.1);
      const flagP = M.flag && mbx?.flag ? mbx.flag.localToWorld(M.flag.clone()) : A.mailbox.clone().setY(1.15);
      const kk = (a, b) => sm((dt - a) / (b - a));
      mail = { open: kk(4.9, 5.6) * (1 - kk(7.2, 7.8)), flag: kk(8.3, 8.9), flagT: dt - 8.9 };
      if (dt < 4.35) {
        // Landed: a beat to look at the box, then straight into the reach.
        w = { pos: landPt, yaw: yawLand, letter: true, nod: 0.12 };
      } else if (t < Wv + 4.2) {
        w = { pos: stand, yaw: faceBox, letter: dt < 6.7, head: 0, nod: 0.15 };
        let h = null;
        const idle = restHand(stand, faceBox, -1);
        const mouth = M.mouth.clone().addScaledVector(M.toStreet, 0.15);
        if (dt < 9.6) {
          h = track(dt, [
            [4.35, idle],
            [4.85, handle],
            [5.6, mbx?.door ? handle : handle],
            [6.0, mouth],
            [6.65, M.mouth.clone().addScaledVector(M.toStreet, -0.12)],
            [6.95, mouth],
            [7.2, handle],
            [7.85, handle],
            [8.3, flagP],
            [8.9, flagP],
            [9.6, idle],
          ]);
          // Follow the door and flag exactly while holding them.
          if (dt > 4.85 && dt < 5.6) h = handle;
          if (dt > 7.2 && dt < 7.85) h = handle;
          if (dt > 8.3 && dt < 8.9) h = flagP;
        }
        w.handR = h;
        w.poleR = v3(0, -1, 0).addScaledVector(v3(Math.cos(faceBox), 0, -Math.sin(faceBox)), -0.8).normalize();
        if (t >= Wv) {
          // Juniper waves; Walt turns and waves back with his left hand.
          const j = this.town.cast.neighbor?.root.getWorldPosition(v3()).setY(0) || A.yard;
          const tw = t - Wv;
          const yj = yawTo(stand, j);
          w.yaw = lerpA(faceBox, yj, sm(tw / 1.0));
          w.walk = 0.5 * bump(tw, 0, 0.45, 1.0);
          w.phase = tw * 6.3;
          w.handR = null;
          const wv = sm((tw - 0.9) / 0.4) * (1 - sm((tw - 3.5) / 0.5));
          if (wv > 0.01) {
            this.crew.walt?.root.updateMatrixWorld(true);
            const sh = this.crew.walt?.part("upperarm_L")?.getWorldPosition(v3()) || stand.clone().setY(1.4);
            const fwd = v3(Math.sin(w.yaw), 0, Math.cos(w.yaw)),
              lft = v3(Math.cos(w.yaw), 0, -Math.sin(w.yaw));
            w.handL = sh.clone().add(v3(0, 0.12 + 0.36 * wv, 0)).addScaledVector(lft, 0.18 + Math.sin(t * 8) * 0.09 * wv).addScaledVector(fwd, 0.14);
            w.poleL = lft.clone().add(v3(0, -0.6, 0)).normalize();
          }
          w.nod = -0.05;
        }
      } else if (t < BACK) {
        const j = this.town.cast.neighbor?.root.getWorldPosition(v3()).setY(0) || A.yard;
        w = walkTo(stand, doorPt, Wv + 4.2, BACK - Wv - 4.3, yawTo(stand, j));
        if (t > BACK - 0.45) w.yaw = lerpA(w.yaw, faceVan, sm((t - BACK + 0.45) / 0.4));
      } else if (t < BACK + 2.6) w = climbIn(t - BACK);
      else {
        w = seat();
        this.beltK = sm((t - BACK - 2.8) / 1.0);
      }
    }
    if (t >= startOf("cross")) this.beltK = 1;
    w.t = t;
    crew.poseWalt(w);
    this.shoulderR = crew.walt?.part("upperarm_R")?.getWorldPosition(v3());
    this.mailState = mail;
    // Theo crosses behind the van while it reverses.
    const C = startOf("cross"),
      tv = t - C;
    if (tv > 0 && tv < 10) {
      const fr = this.frameAtS(this.stopsArr[0] - 2.5);
      const right = fr.left.clone().negate();
      const base = fr.at(2.9 + 4.2, -RIDE, 0).setY(0);
      const x = 9 - 2.6 * (tv - 0.6);
      crew.poseTheo(base.addScaledVector(right, x), Math.atan2(-right.x, -right.z), 3.4, t, true);
    } else crew.poseTheo(v3(), 0, 0, t, false);
    crew.bins.visible = false;
    // Pepper's ball bounces out of her yard and settles in the lane; she wanders out after it.
    const fr = this.frameAtS(this.dogS),
      lane = fr.pos.clone().addScaledVector(fr.left, 0.3),
      yard = this.dogGate.clone().addScaledVector(fr.left, 2.5),
      home = this.dogGate.clone().addScaledVector(fr.left, 1.2);
    const Fc = startOf("fcw"),
      Aw = startOf("away"),
      fv = t - Fc;
    // Pepper noses her ball: it rolls out through the gate, drops off the
    // kerb, takes a few shrinking hops and comes to rest in the lane.
    const bStart = home.clone().lerp(lane, 0.06).setY(0.11);
    const along = sm((fv - 1.0) / 3.3);
    let ball = bStart.clone().lerp(lane, along);
    let by = 0.11;
    for (const [a, b, h] of [[1.7, 2.3, 0.5], [2.3, 2.82, 0.33], [2.82, 3.2, 0.18], [3.2, 3.45, 0.08], [3.45, 3.62, 0.03]])
      if (fv >= a && fv < b) {
        const f = (fv - a) / (b - a);
        by = 0.11 + h * 4 * f * (1 - f);
      }
    ball.y = by;
    let dog,
      dyaw,
      run = 0,
      sit = 0,
      pace = 9,
      look = 0;
    const mouth = (p, y) => p.clone().add(v3(Math.sin(y) * 0.42, 0.33, Math.cos(y) * 0.42));
    const toLane = yawTo(home, lane);
    if (fv < 2.6) (dog = home), (dyaw = toLane), (sit = fv < 0.3 ? 1 : fv < 1.1 ? 1 - sm((fv - 0.3) / 0.3) : fv < 2.2 ? 0 : 0), (look = fv < 0 ? 0.25 * Math.sin(t * 2.2) : 0.55 * bump(fv, 0.4, 0.75, 1.1));
    else if (fv < 8.6) (dog = home.clone().lerp(lane.clone().addScaledVector(fr.fwd, -0.6), sm((fv - 2.6) / 6.0))), (dyaw = toLane), (run = 0.55), (pace = 9);
    else if (fv < 13.6) {
      dog = lane.clone().addScaledVector(fr.fwd, -0.6);
      const toVan = yawTo(dog, F.pos);
      dyaw = fv < 9.6 ? toLane + Math.PI * 0.5 * sm((fv - 8.6) / 1.0) * 0 : toLane + (toVan - toLane) * sm((fv - 9.6) / 0.8);
      sit = sm((fv - 10.2) / 0.5);
      look = fv < 9.8 ? 0.35 : -0.1;
    } else if (fv < 14.4) (dog = lane.clone().addScaledVector(fr.fwd, -0.6)), (dyaw = yawTo(dog, ball)), (look = 0.5 * Math.sin(((fv - 13.6) / 0.8) * Math.PI));
    else {
      const k = sm((t - Fc - 14.4) / (Aw + 4 - Fc - 14.4));
      const from = lane.clone().addScaledVector(fr.fwd, -0.6);
      dog = from.lerp(home, k);
      dyaw = k < 1 ? yawTo(lane, home) : toLane;
      run = k > 0 && k < 1 ? 0.5 : 0;
      sit = k >= 1 ? 1 : 0;
    }
    if (fv > 14.0) ball = mouth(dog, dyaw);
    crew.posePepper(dog.clone(), dyaw, run, sit, t, pace, look);
    crew.ball.position.copy(ball);
    // Contact shadows (Walt only while he's on the street, not in the cab).
    const waltOut = crew.walt && crew.walt.root.visible && crew.walt.root.position.y < 0.2;
    crew.ground("walt", waltOut ? crew.walt.root : null, crew.walt?.root.rotation.y || 0);
    crew.ground("theo", crew.theo?.root, crew.theo?.root.rotation.y || 0);
    crew.ground("pepper", crew.pepper?.root, dyaw);
    crew.ground("ball", crew.ball.visible ? crew.ball : null);
    crew.ball.rotation.x = -along * 40;
    crew.ball.visible = t > startOf("cross");
    this.dogPt = dog.clone();
    this.ballPt = ball.clone();
  }
  // ---------------------------------------------------------------- shots
  shot(id, u) {
    const A = this.town.anchors,
      F = this.frame(),
      lerp = (a, b, k) => a.clone().lerp(b, k);
    const toVan = (p) => p.distanceTo(F.pos);
    const ext = (p, l, fov = 36) => ({ pos: F.at(...p), look: F.at(...l), fov, focus: toVan(F.at(...p)) });
    const pod = this.pod();
    const dashCU = (k = 0.5) => {
      const e = this.cab(-0.42, 0.04, 0.34);
      return { pos: lerp(e, pod, 0.1 + 0.14 * k), look: pod, fov: 44, plain: true };
    };
    const ots = () => ({ pos: this.cab(0.12, 0.1, 0.72), look: lerp(pod, F.at(-12, 0.4, 0), 0.3), fov: 54, plain: true });
    const passenger = () => ({ pos: this.cab(-0.82, 0.16, 0.46), look: this.cab(-0.12, -0.34, -0.1), fov: 46, plain: true });
    const walt = this.crew?.walt?.root.position.clone() || F.pos.clone();
    switch (id) {
      case "dawn": {
        const B = A.bridge;
        const sun = this.town.sunDir || v3(-0.75, 0.55, 0.42);
        const fall = smooth01(lin(u, 0, 0.92));
        const end = F.pos.clone().addScaledVector(F.right, 9).addScaledVector(F.fwd, -7).setY(2.4);
        const start = B.clone().add(v3(78, 56, -14));
        const pos = start.clone().lerp(end, fall);
        pos.add(v3(0, 0, Math.sin(fall * Math.PI) * -9));
        const k = smooth01(lin(u, 0.08, 0.75));
        const sky = B.clone().addScaledVector(sun, 180).add(v3(0, 30, 0));
        const target = lerp(F.pos.clone().addScaledVector(F.fwd, 2).add(v3(0, -0.2, 0)), walt.clone().setY(1), 0.3 * span(u, 0.5, 1));
        const dSky = sky.clone().sub(pos).normalize(),
          dVan = target.clone().sub(pos).normalize();
        const qq = new T.Quaternion().setFromUnitVectors(dSky, dVan),
          qk = new T.Quaternion().slerp(qq, k);
        const look = pos.clone().add(dSky.applyQuaternion(qk).multiplyScalar(pos.distanceTo(target)));
        return { pos, look, fov: 38, focus: 0 };
      }
      case "welcome":
        // Wide on the climb in, then over his shoulder as the cluster wakes.
        if (u < 0.36) return ext([-5.2 + 1.2 * u, 0.25, -6.4], [-0.75, 0.05, -1.3], 38);
        return u < 0.55 ? ots() : dashCU((u - 0.55) / 0.45);
      case "seatbelt":
        if (u < 0.2) return ext([-9, -0.3, -3.5], [0, 0.2, 0], 34);
        if (u < 0.33) return dashCU((u - 0.2) / 0.13);
        if (u < 0.74) return passenger();
        return dashCU(0.5 + (u - 0.74));
      case "glide": {
        const pos = F.pos.clone().addScaledVector(F.right, 10.5).addScaledVector(F.fwd, 5 - 8 * u).add(v3(0, -0.2, 0));
        return { pos, look: F.pos.clone().addScaledVector(F.fwd, 0.6).add(v3(0, 0.15, 0)), fov: 34, focus: toVan(pos) };
      }
      case "blinker":
        return u < 0.5 ? ext([9.5, -0.35, 3.2], [0, 0.25, 0], 32) : dashCU(0.3);
      case "stop": {
        const mb = A.mailbox,
          road = this.town.route.at(this.stopsArr[0]),
          dir = v3(-Math.cos(road.yaw), 0, Math.sin(road.yaw));
        const pos = mb.clone().addScaledVector(dir, 8).add(v3(0, 0.9, 0)).addScaledVector(v3(dir.z, 0, -dir.x), -0.8);
        return { pos, look: F.pos.clone().add(v3(0, 0.1, 0)).lerp(mb.clone().setY(1), 0.12), fov: 32, focus: toVan(pos) };
      }
      case "delivery": {
        if (u < 0.26) return ext([-5.4, 0.3, -5.6], [-0.4, -0.05, -1.5], 38);
        const mb = A.mailbox,
          ts = this.mail.toStreet,
          side = v3(ts.z, 0, -ts.x);
        if (u < 0.4) {
          const pos = walt.clone().addScaledVector(side, 3.2).addScaledVector(ts, 1.2).add(v3(0, 1.3, 0));
          return { pos, look: walt.clone().add(v3(0, 1.0, 0)), fov: 38, focus: pos.distanceTo(walt) };
        }
        // Three-quarter on the mailbox: hand, door, letter and flag all in frame.
        // From the yard side: Walt's face, his hand on the box, the van behind him.
        const pos = mb.clone().addScaledVector(side, 2.3 - 0.3 * u).addScaledVector(ts, -0.9).add(v3(0, 1.55, 0));
        return { pos, look: mb.clone().add(v3(0, 1.12, 0)).addScaledVector(ts, 0.45), fov: 40, focus: pos.distanceTo(mb) };
      }
      case "wave": {
        const j = this.town.cast.neighbor?.root;
        const at = j ? j.getWorldPosition(v3(0, 0, 0)) : A.yard;
        const dir = walt.clone().sub(at).setY(0).normalize(),
          side = v3(dir.z, 0, -dir.x);
        if (u < 0.22) {
          const pos = at.clone().addScaledVector(dir, 4.2).addScaledVector(side, -1.0).add(v3(0, 1.35, 0));
          return { pos, look: at.clone().add(v3(0, 1.0, 0)), fov: 34, focus: pos.distanceTo(at) };
        }
        if (u < 0.5) {
          const pos = at.clone().addScaledVector(dir, -3.0).addScaledVector(side, 1.3).add(v3(0, 1.75, 0));
          return { pos, look: walt.clone().add(v3(0, 1.2, 0)), fov: 34, focus: pos.distanceTo(walt) };
        }
        return ext([-6.5, 0.3, -6], [0, 0.1, -1.2], 38);
      }
      case "cross":
        // Theo coming up from the right, the warning, then him passing behind.
        if (u < 0.28) return ext([14, 2.4, -10], [6.5, -0.5, -3.5], 40);
        if (u < 0.5) return dashCU((u - 0.28) / 0.22);
        return ext([6.5, -0.35, 8], [6, -0.45, -2], 38);
      case "fcw": {
        const dp = this.dogPt || F.at(-8, -0.95, 0),
          bp = this.ballPt || dp;
        const fr = this.frameAtS(this.dogS),
          right = fr.left.clone().negate();
        if (u < 0.26) {
          // From the far kerb: the ball comes bouncing out of the yard toward us.
          const pos = fr.pos.clone().addScaledVector(right, 2.6).addScaledVector(fr.fwd, 2.8).add(v3(0, 0.55, 0));
          const mid = fr.pos.clone().addScaledVector(fr.left, 3.5).setY(0.5);
          return { pos, look: lerp(mid, bp, 0.75), fov: 44, focus: pos.distanceTo(bp) };
        }
        if (u < 0.47) {
          // Low, ahead of Pepper: she wanders out, the van coming up behind her.
          const pos = dp.clone().addScaledVector(fr.fwd, 3.4).addScaledVector(right, 1.3).add(v3(0, 0.5, 0));
          return { pos, look: dp.clone().add(v3(0, 0.35, 0)).addScaledVector(fr.fwd, -1.5), fov: 38, focus: pos.distanceTo(dp) };
        }
        if (u < 0.56) return ots();
        if (u < 0.7) return dashCU(0.7);
        if (u < 0.86) return ext([-7.5, -0.45, 1.6], [-4, -0.7, 0], 32);
        const pos = dp.clone().addScaledVector(right, 3.5).addScaledVector(fr.fwd, 2).add(v3(0, 1.0, 0));
        return { pos, look: dp.clone().add(v3(0, 0.3, 0)), fov: 36, focus: pos.distanceTo(dp) };
      }
      case "approach": {
        // Foreshadow: the van rolling up the street, then Pepper and her ball
        // in the yard, the van small behind her.
        const fr = this.frameAtS(this.dogS),
          home = this.dogGate.clone().addScaledVector(fr.left, 1.2);
        if (u < 0.5) return ext([8 - 2 * u, 0.55, 3.4], [-14, -0.4, 1.8], 40);
        const pos = home.clone().addScaledVector(fr.left, 1.6).addScaledVector(fr.fwd, 2.1).add(v3(0, 0.5, 0));
        return { pos, look: home.clone().add(v3(0, 0.3, 0)).lerp(F.pos, 0.12 + 0.05 * u), fov: 40, focus: pos.distanceTo(home) };
      }
      case "away": {
        const pos = F.pos.clone().addScaledVector(F.fwd, -10 - 3 * u).addScaledVector(F.right, -3.5).add(v3(0, 3.2 + 1.5 * u, 0));
        return { pos, look: F.pos.clone().addScaledVector(F.fwd, 6), fov: 40, focus: toVan(pos) };
      }
      case "finale":
      default: {
        // Bookend to the dawn crane: follow the van briefly, then let it go,
        // rising slowly over the rooftops while the view tilts up into the sky.
        const t0 = startOf("finale"),
          dur = BEATS[BEATS.length - 1].duration;
        const follow = (s) => {
          const fr = this.frameAtS(s);
          return fr.pos.clone().addScaledVector(fr.fwd, -9).addScaledVector(fr.left, 1.8).add(v3(0, 2.3, 0));
        };
        const lookVan = F.pos.clone().addScaledVector(F.fwd, 6).add(v3(0, 0.6, 0));
        const SPLIT = 0.3;
        if (u < SPLIT) return { pos: follow(this.vanState.s), look: lookVan, fov: 40, focus: 0 };
        const sA = vanAt(t0 + dur * SPLIT, this.town.route, this.stopsArr).s,
          frA = this.frameAtS(sA),
          anchor = follow(sA);
        const k = smooth01(lin(u, SPLIT, 1));
        // Ease out of the follow: drift on a few metres, then hang and rise.
        const pos = anchor.clone().addScaledVector(frA.fwd, 7 * Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5)).add(v3(0, 24 * k * k * (3 - 2 * k), 0));
        const dVan = lookVan.clone().sub(pos).normalize(),
          dSky = frA.fwd.clone().add(v3(0, 1.5, 0)).normalize();
        const tilt = smooth01(lin(u, SPLIT + 0.12, 0.96));
        const qq = new T.Quaternion().setFromUnitVectors(dVan, dSky),
          qk = new T.Quaternion().slerp(qq, tilt);
        const look = pos.clone().add(dVan.applyQuaternion(qk).multiplyScalar(30));
        return { pos, look, fov: 40 + 4 * tilt, focus: 0 };
      }
    }
  }
  render(time) {
    if (!this.active || !this.ready || !this.cinema || this.lastShot?.plain) return false;
    this.cinema.render(time, { focus: this.lastShot?.focus || 0, aperture: 0.00014 });
    return true;
  }
  // --------------------------------------------------------------- update
  update(dt) {
    if (!this.active || !this.ready || !this.town) return;
    this.frames = (this.frames || 0) + 1;
    if (this.playing) this.t = Math.min(this.total, this.t + dt);
    const t = this.t,
      { i, u } = beatAt(t),
      b = BEATS[i];
    const st = this.placeVan(dt);
    const F = this.frame();
    this.poseCast(t, F);
    const s = (this.lastShot = this.shot(b.id, u)),
      cam = this.persp;
    const k = s.plain ? 0.25 : 1;
    const drift = v3(Math.sin(t * 0.53) + Math.sin(t * 1.31) * 0.4, Math.sin(t * 0.71 + 1) * 0.6, Math.cos(t * 0.47) + Math.sin(t * 1.13) * 0.3).multiplyScalar(0.018 * k);
    cam.position.copy(s.pos).add(drift);
    cam.lookAt(s.look.clone().add(drift.multiplyScalar(0.6)));
    const near = s.plain ? 0.02 : Math.min(2, Math.max(this.nearRest ?? 0.04, (cam.position.y - 2) * 0.04));
    if (Math.abs(cam.near - near) > 0.005) {
      cam.near = near;
      cam.updateProjectionMatrix();
    }
    if (cam.fov !== s.fov) {
      cam.fov = s.fov;
      cam.updateProjectionMatrix();
    }
    this.town.update(t, { beat: b.id, u, t, order: BEATS.map((x) => x.id), waveEnd: startOf("wave") + 5, mail: this.mailState, van: F.pos, cam: cam.position.clone(), letterFrom: F.at(-0.4, 0.6, -1.3) });
    // The cluster: V4 alert clip for this scene, in step with the film clock.
    if (this.dash) {
      this.dash.filmPlaying = this.playing;
      const vt = clipTime(t, i);
      this.dash.showAlert(vt != null ? b.alert : null, vt);
    }
    // Chimes on the V4 cue sheet, plus foley, only when playing forward through them.
    const crossed = (x) => this.prevT < x && t >= x && this.playing;
    if (b.alert != null)
      for (const [ct, kind] of CUES[b.alert]) {
        if (crossed(STARTS[i] + b.at + ct)) {
          this.audio.chime?.(kind);
          this.music.duck(b.alert === 5 || b.alert === 6 ? 0.15 : 0.4, 1.5);
        }
      }
    const foley = (name, at, duck = 0.35) => {
      this.ambience.foley(name, at);
      this.music.duck(duck, 1.2);
    };
    const Dl = startOf("delivery"),
      Wv = startOf("wave");
    if (crossed(TIMES.arrive - 1.6)) foley("gravel", F.pos, 0.2);
    for (const a of [startOf("welcome") + 0.3, Dl - 0.1]) if (crossed(a)) foley("door", F.pos);
    for (const a of [startOf("welcome") + 2.8, Wv + 7.2]) if (crossed(a)) foley("door", F.pos);
    if (crossed(Dl + 4.9)) foley("mailbox", this.town.anchors.mailbox);
    if (crossed(Dl + 7.6)) foley("mailbox", this.town.anchors.mailbox, 0.2);
    if (crossed(Dl + 8.8)) foley("flag", this.town.anchors.mailbox);
    if (crossed(TIMES.fcwStop - 1.2)) foley("gravel", F.pos, 0.2);
    this.prevT = t;
    this.ambience.update({ cam: this.persp.position.clone(), van: F.pos, speed: st.speed, creek: this.town.anchors.bridge, sprinkler: this.town.sprayAt?.clone().add(ORIGIN) });
    if (this.shown !== i) {
      if (this.shown !== -1) this.music.accent();
      this.shown = i;
      this.caption.innerHTML = (b.tag ? `<span class="film-tag sev-${b.tag[0].toLowerCase()}">${b.tag[0]} · ${b.tag[1]}</span>` : "") + b.caption;
      this.caption.classList.remove("in");
      void this.caption.offsetWidth;
      this.caption.classList.add("in");
    }
    this.card.classList.toggle("show", b.id === "dawn" && u > 0.12 && u < 0.7);
    this.endCard.classList.toggle("show", b.id === "finale" && u > 0.66);
    this.endEl.hidden = !(b.id === "finale" && u > 0.82);
    this.progress.style.transform = `scaleX(${t / this.total})`;
    if (t >= this.total && this.playing) this.setPlaying(false);
  }
}
const sm = (x) => ((x = Math.min(1, Math.max(0, x))), x * x * (3 - 2 * x));
