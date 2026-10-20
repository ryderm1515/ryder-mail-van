import * as T from "three";
import { buildExplode } from "./explode.js";
import { TourMusic } from "./music.js";

// Guided, cinematic walkthrough of the van.
//
// Each chapter is a pure function of its local time u (0..1): a camera shot in
// body space and a pose for the rig's mechanisms. Nothing accumulates, so
// pausing, skipping and replaying always land on exactly the right frame. Drag
// at any time to take over the camera; press play to hand it back.

const ease = (x) => {
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
};
const span = (u, a, b) => ease((u - a) / (b - a));
const pulse = (u, a, b, c, d) => span(u, a, b) * (1 - span(u, c, d));
const lerp = (a, b, t) => a + (b - a) * t;
const v = (x, y, z) => new T.Vector3(x, y, z);
const mix = (a, b, t) => a.clone().lerp(b, t);
// Orbit position around the van in body space. 180 deg = in front, 270 = left side.
const around = (deg, r, h) => v(Math.cos((deg * Math.PI) / 180) * r, h, Math.sin((deg * Math.PI) / 180) * r);

function chapters(info) {
  const head = info.head,
    c = info.counts;
  const n = (k) => (c[k] || 0).toLocaleString();
  return [
    {
      title: "Meet the route van.",
      body: `A walk-in delivery van, modelled part by part. ${info.objects.toLocaleString()} objects, ${info.controls} working mechanisms.`,
      duration: 9,
      shot: (u) => ({ pos: around(lerp(203, 252, ease(u)), lerp(9.5, 8.2, ease(u)), lerp(1.9, 2.6, u)), look: v(-0.3, 0.45, 0), fov: 34 }),
      pose: (u) => ({ "LIGHTING|Running": 1, "LIGHTING|Headlights": span(u, 0.35, 0.55) }),
    },
    {
      title: "One continuous shell.",
      body: "Crowned roof, rolled shoulders and pressed arch flares, drawn as a single clean surface.",
      duration: 8,
      shot: (u) => ({ pos: mix(v(-4.6, 0.05, -4.3), v(3.9, 0.75, -4.6), ease(u)), look: mix(v(-2.3, 0.55, 0), v(1.8, 0.9, 0), ease(u)), fov: 38 }),
      pose: () => ({ "LIGHTING|Running": 1, "LIGHTING|Headlights": 1 }),
    },
    {
      title: "Lit for early starts.",
      body: "Projector headlamps, wraparound signals and a sculpted impact bumper.",
      duration: 8,
      shot: (u) => ({ pos: mix(v(-7.2, 0.25, -2.4), v(-6.4, 1.0, 2.0), ease(u)), look: v(-2.7, 0.25, 0), fov: 32 }),
      pose: (u) => ({
        "LIGHTING|Running": 1,
        "LIGHTING|Headlights": 1,
        "LIGHTING|Hazards": u > 0.3 && Math.sin(u * 8 * 2 * Math.PI * 1.1) > 0 ? 1 : 0,
        "MIRROR_L|Fold": pulse(u, 0.55, 0.7, 0.85, 0.98),
        "MIRROR_R|Fold": pulse(u, 0.55, 0.7, 0.85, 0.98),
      }),
    },
    {
      title: "The service bay.",
      body: "Hood up. Cooling fans, fluid reservoirs and the fuse box all move on their own controls.",
      duration: 10,
      shot: (u) => ({ pos: mix(v(-5.6, 1.4, -2.2), v(-4.3, 2.7, 0.8), ease(u)), look: mix(v(-2.4, 0.4, 0), v(-2.25, 0.05, 0), ease(u)), fov: 36 }),
      pose: (u) => ({
        "LIGHTING|Running": 1,
        "HOOD_LATCH|Release": pulse(u, 0.02, 0.08, 0.2, 0.3),
        "HOOD|Open": span(u, 0.08, 0.35),
        "COOLING_FAN_1|Turns": span(u, 0.3, 1) * 40,
        "COOLING_FAN_2|Turns": span(u, 0.3, 1) * 46,
        "FLUID_CAP_1|Unscrew": pulse(u, 0.45, 0.6, 0.78, 0.9),
        "FLUID_CAP_2|Unscrew": pulse(u, 0.52, 0.66, 0.82, 0.94),
        "FUSE_LID|Open": pulse(u, 0.6, 0.72, 0.86, 0.97),
      }),
    },
    {
      title: "Walk-in cab.",
      body: "The cab door slides back. Switches, wipers, visors and steering are all live.",
      duration: 12,
      shot: (u) => {
        const outside = v(-1.15, 0.95, -4.2),
          door = v(-1.15, head.y - 0.05, -1.45),
          seat = head.clone().add(v(-0.3, 0.1, 0));
        const pos = u < 0.45 ? mix(outside, door, ease(u / 0.45)) : mix(door, seat, ease((u - 0.45) / 0.35));
        const look = u < 0.45 ? mix(v(-1.2, 0.6, 0), v(-1.8, 0.45, 0.2), ease(u / 0.45)) : mix(v(-1.8, 0.45, 0.2), seat.clone().add(v(-3, -0.55, 0.35 * Math.sin(u * 4))), ease((u - 0.45) / 0.3));
        return { pos, look, fov: u < 0.5 ? 40 : lerp(40, 62, span(u, 0.5, 0.8)) };
      },
      pose: (u) => ({
        "LIGHTING|Running": 1,
        "LIGHTING|Cab": span(u, 0.3, 0.4),
        "DOOR_LATCH_L|Pull": pulse(u, 0.02, 0.07, 0.14, 0.2),
        "DOOR_L|Open": span(u, 0.06, 0.3),
        "WINDOW_L|Lower": span(u, 0.25, 0.45),
        "GAUGE_NEEDLE_1|Reading": pulse(u, 0.55, 0.68, 0.75, 0.9),
        "GAUGE_NEEDLE_2|Reading": pulse(u, 0.58, 0.7, 0.78, 0.92),
        "SETTINGS|Steering": Math.sin(span(u, 0.6, 1) * Math.PI * 2) * 30,
        "SETTINGS|Wiper cycles": span(u, 0.62, 0.95) * 2,
        "VISOR_L|Lower": pulse(u, 0.7, 0.8, 0.9, 1),
        "INDICATOR_STALK|Position": 0.5 + 0.5 * pulse(u, 0.66, 0.72, 0.8, 0.86),
        "SEAT_BACK|Recline": pulse(u, 0.5, 0.6, 0.85, 0.98) * 0.4,
      }),
    },
    {
      title: "A live driver display.",
      body: "Built from the Oshkosh dashboard design. Every state is real: startup, doors, signals, belt, parking and collision warnings.",
      duration: 13,
      enter: (ctx) => ctx.dash?.restartStartup(),
      shot: (u) => {
        const seat = head.clone().add(v(-0.3, 0.1, 0)),
          center = info.display ? info.display.clone() : v(-1.62, 0.95, -0.53),
          front = center.clone().addScaledVector(seat.clone().sub(center).normalize(), 0.66);
        return { pos: mix(seat, front, ease(Math.min(1, u / 0.3))), look: mix(seat.clone().add(v(-3, -0.55, 0)), center, ease(Math.min(1, u / 0.25))), fov: lerp(62, 36, span(u, 0, 0.3)) };
      },
      pose: (u) => ({
        "LIGHTING|Running": 1,
        "SEATBELT|Fasten": u < 0.42 ? 0 : 1,
        "LIGHTING|Indicator L": u > 0.5 && u < 0.68 && Math.sin(u * 13 * 2 * Math.PI) > 0 ? 1 : 0,
        "LIGHTING|Indicator R": u > 0.7 && u < 0.86 && Math.sin(u * 13 * 2 * Math.PI) > 0 ? 1 : 0,
        "DOOR_L|Open": pulse(u, 0.88, 0.92, 0.97, 1),
      }),
    },
    {
      title: "Built around the load.",
      body: "A roll-up shutter, folding shelves, a sliding bulkhead and tie-down points down the floor.",
      duration: 12,
      shot: (u) => {
        const back = v(7.4, 1.4, 2.6),
          mouth = v(3.6, 1.05, 0.35),
          inside = v(1.7, 1.15, 0.2);
        const pos = u < 0.5 ? mix(back, mouth, ease(u / 0.5)) : mix(mouth, inside, ease((u - 0.5) / 0.4));
        return { pos, look: mix(v(2.4, 0.7, 0), v(-0.9, 0.55, 0), ease(u)), fov: lerp(36, 64, span(u, 0.45, 0.85)) };
      },
      pose: (u) => ({
        "LIGHTING|Running": 1,
        "LIGHTING|Cargo": span(u, 0.25, 0.4),
        "SHUTTER_OUTSIDE_HANDLE|Pull": pulse(u, 0.02, 0.07, 0.14, 0.2),
        "SHUTTER_LATCH|Release": pulse(u, 0.03, 0.08, 0.16, 0.22),
        "REAR_DOOR|Open": span(u, 0.08, 0.4),
        "SHELF_L_1|Fold": span(u, 0.55, 0.68),
        "SHELF_R_1|Fold": span(u, 0.6, 0.72),
        "SHELF_L_2|Fold": span(u, 0.64, 0.76),
        "SHELF_R_2|Fold": span(u, 0.68, 0.8),
        "PARTITION_LATCH|Pull": pulse(u, 0.7, 0.74, 0.78, 0.82),
        "PARTITION|Open": span(u, 0.74, 0.92),
        "TIE_DOWN_01|Lift": span(u, 0.8, 0.86),
        "TIE_DOWN_02|Lift": span(u, 0.82, 0.88),
        "TIE_DOWN_03|Lift": span(u, 0.84, 0.9),
        "SORTING_TRAY|Fold": span(u, 0.86, 0.95),
      }),
    },
    {
      title: "Corner by corner.",
      body: "Ackermann steering, independent suspension travel, and a hubcap and six lug nuts on every wheel.",
      duration: 11,
      shot: (u) => ({ pos: mix(v(-4.2, -0.15, -3.6), v(-2.15, -0.35, -3.0), ease(u)), look: mix(v(-1.9, -0.3, -0.6), v(-1.96, -0.45, -1.1), ease(u)), fov: 38 }),
      pose: (u) => {
        const lugs = {};
        for (let i = 1; i <= 6; i++) lugs[`LUG_FL_0${i}|Turns`] = span(u, 0.5 + i * 0.025, 0.66 + i * 0.025) * 6;
        return {
          "LIGHTING|Running": 1,
          "SETTINGS|Steering": Math.sin(span(u, 0.02, 0.4) * Math.PI * 2) * 34,
          "WHEEL_FL|Suspension": Math.sin(u * Math.PI * 6) * 0.08 * pulse(u, 0.05, 0.15, 0.32, 0.42),
          "HUBCAP_FL|Remove": pulse(u, 0.4, 0.5, 0.9, 0.98),
          "WHEEL_FL|Remove": pulse(u, 0.72, 0.84, 0.9, 0.98) * 0.6,
          ...lugs,
        };
      },
    },
    {
      title: "Every part, in its place.",
      body: "The exploded view. The shell lifts, the front clip pulls away, wheels slide out and the running gear drops.",
      duration: 12,
      explode: (u) => span(u, 0.12, 0.92),
      shot: (u) => ({ pos: around(lerp(222, 300, ease(u)), lerp(9, 14.5, ease(u)), lerp(2.6, 6.2, ease(u))), look: v(-0.1, lerp(0.5, 1.1, ease(u)), 0), fov: 36 }),
      pose: () => ({ "LIGHTING|Running": 1, "LIGHTING|Headlights": 1 }),
    },
    {
      title: "Systems, layer by layer.",
      body: `${n("Body shell")} shell panels, ${n("Cab")} cab parts, ${n("Cargo fit-out")} cargo fittings, ${n("Wheels")} wheel parts. Every fastener floats beside its system.`,
      duration: 11,
      explode: () => 1,
      shot: (u) => ({ pos: around(lerp(300, 392, u), lerp(14.5, 12.5, ease(u)), lerp(6.2, 4.6, ease(u))), look: v(0, 1.0, 0), fov: 36 }),
      pose: () => ({ "LIGHTING|Running": 1, "LIGHTING|Headlights": 1, "LIGHTING|Cab": 1, "LIGHTING|Cargo": 1 }),
    },
    {
      title: "Back together.",
      body: "Every piece returns to its exact position.",
      duration: 8,
      explode: (u) => 1 - span(u, 0.05, 0.85),
      shot: (u) => ({ pos: around(lerp(392, 495, ease(u)), lerp(12.5, 8.6, ease(u)), lerp(4.6, 2.2, ease(u))), look: v(-0.3, lerp(1.0, 0.45, ease(u)), 0), fov: 34 }),
      pose: () => ({ "LIGHTING|Running": 1, "LIGHTING|Headlights": 1 }),
    },
    {
      title: "Ready for the route.",
      body: "Take it out, or explore every mechanism yourself.",
      duration: 6,
      end: true,
      shot: (u) => ({ pos: around(lerp(495, 515, ease(u)), 8.6, 2.2), look: v(-0.3, 0.45, 0), fov: 34 }),
      pose: () => ({ "LIGHTING|Running": 1, "LIGHTING|Headlights": 1 }),
    },
  ];
}

export class Showcase {
  constructor(o) {
    Object.assign(this, o); // rig, physics, vehicle, field, ui, actions, persp, orbit, setCameraMode, canvas, audio
    this.active = false;
    this.playing = false;
    this.t = 0;
    this.blend = 1;
    this.free = false;
    this.camFrom = { pos: new T.Vector3(), quat: new T.Quaternion(), fov: 40 };
    this.touched = new Set();
    this.music = new TourMusic(this.audio);
    this.buildUI();
  }
  prepare() {
    if (this.layout) return;
    this.layout = buildExplode(this.rig, this.vehicle, this.field);
    this.vehicle.updateMatrixWorld(true);
    const head = new T.Vector3();
    this.rig.bones.HEADREST.pose.getWorldPosition(head);
    this.info = {
      head: this.vehicle.worldToLocal(head),
      counts: this.layout.counts,
      objects: this.rig.data.manifest.parts?.length || this.layout.parts.length - 1,
      controls: this.rig.controls.length,
      display: this.dash?.base?.clone(),
    };
    this.chapters = chapters(this.info);
    this.dashPart = this.layout.parts.findIndex((p) => /^Sculpted continuous dashboard skin/.test(p.name || ""));
    this.starts = [];
    let acc = 0;
    for (const c of this.chapters) {
      this.starts.push(acc);
      acc += c.duration;
      for (const k of Object.keys(c.pose(0.5))) this.touched.add(k);
      for (const k of Object.keys(c.pose(0.01))) this.touched.add(k);
    }
    this.total = acc;
    this.bar.replaceChildren(
      ...this.chapters.map((c, i) => {
        const b = document.createElement("button");
        b.className = "tour-seg";
        b.style.flexGrow = c.duration;
        b.setAttribute("aria-label", "Chapter " + (i + 1) + ": " + c.title);
        b.innerHTML = "<i></i>";
        b.onclick = () => this.seek(this.starts[i] + 0.001, true);
        return b;
      }),
    );
  }
  buildUI() {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<section id="tour" class="tour" hidden aria-label="Guided walkthrough"><div class="tour-copy surface" aria-live="polite"><p id="tour-kicker" class="tour-kicker"></p><h2 id="tour-title"></h2><p id="tour-body"></p><div id="tour-end" class="tour-end" hidden><button id="tour-drive" class="tour-primary">Drive it</button><button id="tour-explore" class="tour-secondary">Explore it</button></div></div><div class="tour-rail"><div id="tour-bar" class="tour-bar" role="group" aria-label="Chapters"></div><div class="tour-controls surface"><button id="tour-prev" aria-label="Previous chapter" data-tip="Previous · ←"></button><button id="tour-play" aria-label="Pause" data-tip="Pause · Space"></button><button id="tour-next" aria-label="Next chapter" data-tip="Next · →"></button><span class="divider"></span><button id="tour-exit" aria-label="Exit walkthrough" data-tip="Exit · Esc"></button></div></div><p id="tour-hint" class="tour-hint">Drag to look around. Press play to continue the tour.</p></section>`,
    );
    const $ = (id) => document.getElementById(id);
    this.el = $("tour");
    this.bar = $("tour-bar");
    this.titleEl = $("tour-title");
    this.bodyEl = $("tour-body");
    this.ui.icon("tour-prev", "player-track-prev");
    this.ui.icon("tour-next", "player-track-next");
    this.ui.icon("tour-exit", "x");
    this.ui.icon("tour-play", "player-pause");
    $("tour-prev").onclick = () => this.step(-1);
    $("tour-next").onclick = () => this.step(1);
    $("tour-play").onclick = () => this.toggle();
    $("tour-exit").onclick = () => this.exit();
    $("tour-drive").onclick = () => this.exit("drive");
    $("tour-explore").onclick = () => this.exit("explore");
    // Dragging hands the camera to the viewer until they press play.
    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.active || e.button > 2) return;
      this.takeOver();
    });
  }
  start() {
    this.prepare();
    this.actions.teleport("garage");
    if (!this.actions.isOn?.()) this.actions.power();
    this.actions.setCamera(4);
    this.orbit.enabled = false;
    this.active = true;
    this.free = false;
    document.body.classList.add("touring");
    this.el.hidden = false;
    this.capture();
    this.blend = 0;
    this.seek(0, false);
    this.setPlaying(true);
    this.audio.unlock().then(() => this.active && this.music.start());
  }
  exit(next = null) {
    if (!this.active) return;
    this.active = false;
    this.setPlaying(false);
    this.music.stop();
    this.el.hidden = true;
    document.body.classList.remove("touring", "tour-free");
    this.field.uniforms.uExplode.value = 0;
    this.dash?.setExplode(new T.Vector3());
    this.rig.reset();
    this.orbit.enabled = false;
    if (next === "drive") {
      this.actions.setCamera(1);
      this.actions.drive();
    } else this.actions.setCamera(next === "explore" ? 4 : 0);
    if (next === "explore") document.getElementById("inspect")?.click();
  }
  setPlaying(on) {
    this.playing = on;
    this.ui.icon("tour-play", on ? "player-pause" : "player-play");
    const b = document.getElementById("tour-play");
    b.setAttribute("aria-label", on ? "Pause" : "Play");
    b.dataset.tip = (on ? "Pause" : "Play") + " · Space";
  }
  toggle() {
    if (this.t >= this.total - 0.01) {
      this.seek(0, true);
      this.setPlaying(true);
      return;
    }
    if (this.free) this.release();
    this.setPlaying(!this.playing);
  }
  takeOver() {
    if (this.free) return;
    this.free = true;
    this.setPlaying(false);
    document.body.classList.add("tour-free");
    const shot = this.currentShot();
    this.orbit.target.copy(shot.look);
    this.orbit.enabled = true;
    this.orbit.update();
  }
  release() {
    this.free = false;
    this.orbit.enabled = false;
    document.body.classList.remove("tour-free");
    this.capture();
    this.blend = 0;
  }
  step(dir) {
    const i = this.index();
    const target = T.MathUtils.clamp(i + dir, 0, this.chapters.length - 1);
    this.seek(this.starts[target] + 0.001, true);
  }
  seek(t, smooth) {
    if (this.free) this.release();
    if (smooth) {
      this.capture();
      this.blend = 0;
    }
    this.t = T.MathUtils.clamp(t, 0, this.total);
    this.chapterShown = -1;
  }
  capture() {
    const cam = this.persp;
    this.camFrom.pos.copy(cam.position);
    this.camFrom.quat.copy(cam.quaternion);
    this.camFrom.fov = cam.fov;
  }
  index() {
    let i = 0;
    while (i < this.chapters.length - 1 && this.t >= this.starts[i + 1]) i++;
    return i;
  }
  currentShot() {
    const i = this.index(),
      c = this.chapters[i],
      u = (this.t - this.starts[i]) / c.duration,
      s = c.shot(Math.min(1, u)),
      m = this.vehicle.matrixWorld;
    return { pos: s.pos.clone().applyMatrix4(m), look: s.look.clone().applyMatrix4(m), fov: s.fov, u, c, i };
  }
  key(e) {
    if (!this.active) return false;
    const k = e.key.toLowerCase();
    if (k === " ") this.toggle();
    else if (k === "arrowright") this.step(1);
    else if (k === "arrowleft") this.step(-1);
    else if (k === "escape") this.exit();
    else return true; // swallow other keys so the van stays parked
    e.preventDefault();
    return true;
  }
  update(dt) {
    if (!this.active) return;
    if (this.playing) this.t = Math.min(this.total, this.t + dt);
    const shot = this.currentShot(),
      { c, i } = shot,
      u = Math.min(1, shot.u);
    // Mechanisms: every control the tour uses rests at its default unless this chapter moves it.
    const pose = c.pose(u);
    for (const id of this.touched) {
      const [b, k] = id.split("|");
      const ctl = this.rig.controls.find((x) => x.id === id);
      // During the tour the driver is belted unless a chapter says otherwise.
      const rest = id === "SEATBELT|Fasten" ? 1 : ctl ? ctl.default : 0;
      this.rig.set(b, k, id in pose ? pose[id] : rest, true);
    }
    const ex = (this.field.uniforms.uExplode.value = c.explode ? c.explode(u) : 0);
    // The driver display pod rides with the dashboard part it sits on.
    if (this.dash && this.dashPart) {
      const d = this.field.explodeData,
        o = this.dashPart * 4;
      let k = Math.min(1, Math.max(0, (ex - d[o + 3]) / 0.45));
      k = k * k * k * (k * (k * 6 - 15) + 10);
      this.dash.setExplode(new T.Vector3(d[o], d[o + 1], d[o + 2]).multiplyScalar(k));
    }
    // Copy and progress.
    if (this.chapterShown !== i) {
      this.chapterShown = i;
      c.enter?.(this);
      this.music.accent();
      document.getElementById("tour-kicker").textContent = `${String(i + 1).padStart(2, "0")} / ${String(this.chapters.length).padStart(2, "0")}`;
      this.titleEl.textContent = c.title;
      this.bodyEl.textContent = c.body;
      this.el.querySelector(".tour-copy").classList.remove("in");
      void this.el.offsetWidth;
      this.el.querySelector(".tour-copy").classList.add("in");
      document.getElementById("tour-end").hidden = !c.end;
    }
    [...this.bar.children].forEach((seg, k) => {
      const f = k < i ? 1 : k > i ? 0 : u;
      seg.firstChild.style.transform = `scaleX(${f})`;
      seg.setAttribute("aria-current", String(k === i));
    });
    if (this.t >= this.total && this.playing) this.setPlaying(false);
    // Camera: follow the shot, blending in after a jump or a hand-back.
    const cam = this.persp;
    if (this.free) {
      this.orbit.update();
      return;
    }
    this.blend = Math.min(1, this.blend + dt / 1.1);
    const b = ease(this.blend);
    const look = new T.Matrix4().lookAt(shot.pos, shot.look, new T.Vector3(0, 1, 0));
    const q = new T.Quaternion().setFromRotationMatrix(look);
    cam.position.lerpVectors(this.camFrom.pos, shot.pos, b);
    cam.quaternion.slerpQuaternions(this.camFrom.quat, q, b);
    cam.fov = lerp(this.camFrom.fov, shot.fov, b);
    cam.updateProjectionMatrix();
  }
}
