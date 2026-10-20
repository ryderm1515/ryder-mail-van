import * as T from "three";
export class DirectInteraction {
  constructor(canvas, rig, physics, vehicle, getCamera, orbit, actions, ui) {
    Object.assign(this, { canvas, rig, physics, vehicle, getCamera, orbit, actions, ui });
    this.hand = false;
    this.hover = null;
    this.drag = null;
    this.preview = null;
    this.pointer = new T.Vector2();
    this.ray = new T.Raycaster();
    this.plane = new T.Plane();
    this.lastMove = 0;
    this.tip = document.getElementById("part-hover");
    this.mouse = { x: 0, y: 0 };
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e));
    canvas.addEventListener("pointerleave", () => {
      if (!this.drag) {
        this.clearPreview();
        this.hover = null;
        this.tip.hidden = true;
      }
    });
  }
  toggle() {
    this.hand = !this.hand;
    this.clearPreview();
    this.orbit.enabled = !this.hand && this.getCamera().mode === 4;
    this.canvas.style.cursor = this.hand ? "grab" : "";
    return this.hand;
  }
  control(b) {
    if (/^MCH_SLAT/.test(b)) b = "REAR_DOOR";
    const preferred = {
      DOOR_L: "Open",
      DOOR_R: "Open",
      HOOD: "Open",
      REAR_DOOR: "Open",
      WINDOW_L: "Lower",
      WINDOW_R: "Lower",
      MIRROR_L: "Fold",
      MIRROR_R: "Fold",
      PARTITION: "Open",
      DRIVER_SEAT: "Slide",
    };
    if (/^MCH_PARTITION/.test(b)) b = "PARTITION";
    return this.rig.controls.find((c) => c.bone === b && (preferred[b] ? c.name === preferred[b] : true));
  }
  pick(e) {
    this.pointer.set((e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2);
    this.ray.setFromCamera(this.pointer, this.getCamera().camera);
    const candidates = this.rig.meshes.filter((m) => {
      let n = m;
      while (n) {
        if (!n.visible) return false;
        n = n.parent;
      }
      return true;
    });
    return this.ray
      .intersectObjects(candidates, false)
      .find((h) => !h.object.material.transparent || /^WINDOW/.test(h.object.userData.bone));
  }
  clearPreview() {
    if (this.preview) {
      const p = this.preview;
      this.rig.set(p.c.bone, p.c.name, p.value);
      if (!p.override) this.rig.overrides.delete(p.c.id);
      this.preview = null;
    }
  }
  move(e) {
    this.mouse = { x: e.clientX, y: e.clientY };
    if (this.drag) {
      e.stopImmediatePropagation();
      const d = this.drag;
      if (d.kind === "part") {
        const delta = ((e.clientX - d.x) * d.dir.x + (e.clientY - d.y) * d.dir.y) / 180;
        const v = T.MathUtils.clamp(d.value + delta * (d.c.max - d.c.min), d.c.min, d.c.max);
        this.rig.set(d.c.bone, d.c.name, v, true);
        this.tip.lastElementChild.textContent = Math.round(((v - d.c.min) / (d.c.max - d.c.min)) * 100) + "%";
      } else {
        this.pointer.set((e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2);
        this.ray.setFromCamera(this.pointer, this.getCamera().camera);
        const p = new T.Vector3();
        if (this.ray.ray.intersectPlane(this.plane, p)) this.physics.grab.target.copy(p);
      }
      return;
    }
    if (performance.now() - this.lastMove < 100) return;
    this.lastMove = performance.now();
    const hit = this.pick(e),
      c = hit ? this.control(hit.object.userData.bone) : null;
    if (!this.hover || this.hover?.c?.id !== c?.id || !hit) {
      this.clearPreview();
      this.hover = hit ? { hit, c, since: performance.now(), played: false } : null;
    } else if (hit) this.hover.hit = hit;
    if (!hit) {
      this.tip.hidden = true;
      this.canvas.style.cursor = this.hand ? "grab" : "";
      return;
    }
    this.tip.hidden = false;
    this.tip.firstElementChild.textContent = c ? c.bone.replace(/_/g, " ") + " · " + c.name : "BODY SHELL";
    this.tip.lastElementChild.textContent = this.hand
      ? c
        ? "Drag to animate"
        : "Grab, lift and throw"
      : c
        ? "Hover to preview · Click to animate"
        : "Press G to grab the van";
    this.tip.style.left = Math.min(innerWidth - 220, e.clientX + 18) + "px";
    this.tip.style.top = Math.max(84, Math.min(innerHeight - 190, e.clientY - 64)) + "px";
    this.canvas.style.cursor = this.hand ? "grab" : c ? "pointer" : "";
  }
  down(e) {
    this.clickStart = { x: e.clientX, y: e.clientY };
    if (e.button !== 0 || !this.hand) return;
    const hit = this.pick(e);
    if (!hit) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.clearPreview();
    this.canvas.setPointerCapture(e.pointerId);
    const c = this.control(hit.object.userData.bone);
    if (c && /Open|Lower|Fold|Slide|Raise|Recline|Pull/.test(c.name)) {
      if (Math.abs(this.physics.speed) > 1) {
        this.ui.toast("Stop to drag a moving part");
        return;
      }
      let dir = new T.Vector2(0, c.name === "Lower" ? 1 : -1);
      if (/^DOOR_[LR]$/.test(c.bone)) {
        const a = hit.point.clone().project(this.getCamera().camera),
          b = hit.point
            .clone()
            .add(new T.Vector3(1, 0, 0).applyQuaternion(this.vehicle.quaternion))
            .project(this.getCamera().camera);
        dir.set((b.x - a.x) * innerWidth, -(b.y - a.y) * innerHeight).normalize();
      }
      this.drag = { kind: "part", c, value: this.rig.targets[c.id], x: e.clientX, y: e.clientY, dir };
    } else {
      const camera = this.getCamera().camera,
        normal = camera.getWorldDirection(new T.Vector3());
      this.plane.setFromNormalAndCoplanarPoint(normal, hit.point);
      this.physics.grab = { local: this.vehicle.worldToLocal(hit.point.clone()), target: hit.point.clone() };
      this.drag = { kind: "body" };
    }
    this.canvas.style.cursor = "grabbing";
  }
  up(e) {
    if (document.body.classList.contains("starting")) return;
    if (this.drag) {
      e.stopImmediatePropagation();
      if (this.drag.c) this.actions.interaction(this.drag.c, this.rig.targets[this.drag.c.id]);
      this.physics.grab = null;
      this.drag = null;
      this.canvas.style.cursor = "grab";
      return;
    }
    if (this.clickStart && Math.hypot(e.clientX - this.clickStart.x, e.clientY - this.clickStart.y) > 5)
      return;
    if (
      !this.hand &&
      this.hover?.c &&
      Math.abs(this.physics.speed) < 1 &&
      this.hover.hit &&
      performance.now() - this.hover.since > 100
    ) {
      const c = this.hover.c;
      this.clearPreview();
      const v = this.rig.targets[c.id] > (c.min + c.max) / 2 ? c.min : c.max;
      this.rig.set(c.bone, c.name, v, true);
      this.actions.interaction(c, v);
    }
  }
  update(dt) {
    if (document.body.classList.contains("starting")) return;
    const h = this.hover;
    if (this.drag || this.hand || !h?.c || Math.abs(this.physics.speed) > 0.3) return;
    if (!h.played && performance.now() - h.since > 500 && /Open|Lower|Fold|Pull|Sweep|Raise/.test(h.c.name)) {
      h.played = true;
      this.preview = {
        c: h.c,
        value: this.rig.targets[h.c.id],
        override: this.rig.overrides.has(h.c.id),
        time: 0,
      };
    }
    if (this.preview) {
      const p = this.preview;
      p.time += dt;
      const wave = Math.sin(Math.min(1, p.time / 1.5) * Math.PI),
        span = Math.min(1, p.c.max - p.c.min);
      this.rig.set(
        p.c.bone,
        p.c.name,
        T.MathUtils.clamp(p.value + wave * span * 0.32, p.c.min, p.c.max),
        true,
      );
      if (p.time >= 1.5) this.clearPreview();
    }
  }
}
