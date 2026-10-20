import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// The Morning route's extra cast, all modelled in Blender (blender/cast.py):
// Walt the mail carrier, Theo on his bike, Pepper the neighbour's dog and
// her ball, plus the wheelie bins the van backs up to. Everything is posed
// from the film clock by film.js, so scrubbing always lands on the same frame.

const v3 = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sm = (x) => ((x = Math.min(1, Math.max(0, x))), x * x * (3 - 2 * x));

function prep(o, list) {
  o.traverse((m) => {
    if (m.isMesh) {
      m.castShadow = m.receiveShadow = true;
      list.push(m.geometry, ...[].concat(m.material));
    }
  });
  const part = (n) => {
    let hit = null;
    o.traverse((c) => !hit && (c.name === n || c.name.startsWith(n + ".")) && (hit = c));
    return hit;
  };
  return { root: o, part };
}

export class Crew {
  constructor(scene, toon) {
    this.scene = scene;
    this.toon = toon || ((m) => m);
    this.group = new T.Group();
    this.group.name = "Morning route crew";
    this.disposables = [];
  }
  async load() {
    const loader = new GLTFLoader();
    const get = (u) => new Promise((res) => loader.load(u, (g) => res(g.scene), undefined, () => res(null)));
    const timeout = new Promise((res) => setTimeout(() => res([]), 6000));
    const [walt, theo, dog] = await Promise.race([Promise.all(["assets/town/mailman.glb", "assets/town/cyclist.glb", "assets/town/dog.glb"].map(get)), timeout]);
    if (this.disposed) return;
    if (walt) {
      this.walt = prep(walt, this.disposables);
      walt.scale.setScalar(1.0);
      this.walt.part("head")?.scale.setScalar(1.12);
      this.group.add(walt);
    }
    if (theo) {
      this.theo = prep(theo, this.disposables);
      theo.scale.setScalar(1.05);
      this.group.add(theo);
    }
    if (dog) {
      // Pepper: Biscuit's build in a black-and-white coat with a red bandana.
      dog.traverse((m) => {
        if (!m.isMesh) return;
        m.material = [].concat(m.material).map((mt) => {
          const c = mt.clone();
          if (/fur/i.test(mt.name)) c.color.set("#3b3633");
          if (/bandana(?! dots)/i.test(mt.name)) c.color.set("#e05a4a");
          return c;
        });
        if (m.material.length === 1) m.material = m.material[0];
      });
      this.pepper = prep(dog, this.disposables);
      dog.scale.setScalar(1.15);
      this.group.add(dog);
    }
    const mat = (c, r = 0.6) => {
      const m = this.toon(new T.MeshToonMaterial({ color: c }));
      this.disposables.push(m);
      return m;
    };
    // Pepper's ball.
    const ballGeo = new T.SphereGeometry(0.11, 18, 12);
    this.disposables.push(ballGeo);
    this.ball = new T.Mesh(ballGeo, mat("#f2c14e"));
    this.ball.castShadow = true;
    this.group.add(this.ball);
    // Two wheelie bins, recycling and refuse.
    this.bins = new T.Group();
    const binGeo = new T.BoxGeometry(0.58, 1.0, 0.7),
      lidGeo = new T.BoxGeometry(0.62, 0.06, 0.76),
      wheelGeo = new T.CylinderGeometry(0.09, 0.09, 0.05, 12);
    this.disposables.push(binGeo, lidGeo, wheelGeo);
    [["#3c7d5a", 0], ["#3d6fa3", 0.72]].forEach(([c, z]) => {
      const b = new T.Mesh(binGeo, mat(c));
      b.position.set(0, 0.5, z);
      const l = new T.Mesh(lidGeo, mat(c));
      l.position.set(0, 1.03, z);
      for (const s of [-1, 1]) {
        const w = new T.Mesh(wheelGeo, mat("#2a2826"));
        w.rotation.z = Math.PI / 2;
        w.position.set(0.3, 0.09, z + s * 0.25);
        this.bins.add(w);
      }
      b.castShadow = l.castShadow = true;
      this.bins.add(b, l);
    });
    this.group.add(this.bins);
    // Soft contact shadows that ground everyone on the street.
    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const cg = cv.getContext("2d"),
      gr = cg.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(40,32,24,0.55)");
    gr.addColorStop(0.55, "rgba(40,32,24,0.22)");
    gr.addColorStop(1, "rgba(40,32,24,0)");
    cg.fillStyle = gr;
    cg.fillRect(0, 0, 64, 64);
    const tex = new T.CanvasTexture(cv),
      sMat = new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
      sGeo = new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.disposables.push(tex, sMat, sGeo);
    this.blobs = {};
    for (const [k, w, d] of [["walt", 0.75, 0.6], ["theo", 0.6, 1.3], ["pepper", 0.45, 0.75], ["ball", 0.3, 0.3]]) {
      const m = new T.Mesh(sGeo, sMat);
      m.scale.set(w, 1, d);
      m.renderOrder = 1;
      this.blobs[k] = m;
      this.group.add(m);
    }
    this.scene.add(this.group);
  }
  // Keep a contact shadow under an object; fades as it lifts off the ground.
  ground(key, obj, yaw = 0) {
    const b = this.blobs?.[key];
    if (!b) return;
    if (!obj || !obj.visible) return void (b.visible = false);
    const p = obj.getWorldPosition(v3()),
      h = Math.max(0, p.y - (key === "ball" ? 0.11 : 0));
    b.visible = h < 1.2;
    b.position.set(p.x, 0.025, p.z);
    b.rotation.y = yaw;
    b.material.opacity = 1;
    const k = Math.max(0.35, 1 - h * 0.9);
    b.scale.x = (key === "walt" ? 0.75 : key === "theo" ? 0.6 : key === "pepper" ? 0.45 : 0.3) * (1.4 - k * 0.4);
  }
  // Two-bone arm IK: aim upper arm + forearm so the palm lands on a world target.
  // pole: world direction the elbow should point toward.
  ik(upper, fore, target, pole, a = 0.29, b = 0.3) {
    const S = upper.getWorldPosition(v3());
    const d = target.clone().sub(S);
    const dist = Math.min(a + b - 0.002, Math.max(0.08, d.length())),
      dir = d.normalize();
    let axis = v3().crossVectors(dir, pole);
    if (axis.lengthSq() < 1e-6) axis = v3().crossVectors(dir, v3(1, 0, 0));
    axis.normalize();
    const alpha = Math.acos(Math.min(1, Math.max(-1, (a * a + dist * dist - b * b) / (2 * a * dist)))),
      beta = Math.acos(Math.min(1, Math.max(-1, (a * a + b * b - dist * dist) / (2 * a * b))));
    const upDir = dir.clone().applyAxisAngle(axis, alpha);
    const qW = new T.Quaternion().setFromUnitVectors(v3(0, -1, 0), upDir);
    const pq = upper.parent.getWorldQuaternion(new T.Quaternion());
    upper.quaternion.copy(pq.invert().multiply(qW));
    const axL = axis.clone().applyQuaternion(qW.clone().invert());
    fore.quaternion.setFromAxisAngle(axL, -(Math.PI - beta));
    upper.updateMatrixWorld(true);
  }
  // Walt's full pose. Hands take world targets (null = natural swing/hang).
  poseWalt({ pos, yaw = 0, quat, walk = 0, phase = 0, seated = 0, handL = null, handR = null, poleL, poleR, head = 0, nod = 0, letter = false, visible = true, legs = {}, lean = 0, t = 0 }) {
    const w = this.walt;
    if (!w) return;
    const r = w.root;
    r.visible = visible;
    if (!visible) return;
    r.position.copy(pos);
    if (quat) r.quaternion.copy(quat);
    else r.rotation.set(0, yaw, 0);
    const P = w.part;
    const thL = P("thigh_L"),
      thR = P("thigh_R"),
      shL = P("shin_L"),
      shR = P("shin_R"),
      hips = P("hips"),
      torso = P("torso"),
      hd = P("head");
    // Gait: thighs swing in opposition; each knee folds through its swing
    // phase (peak at mid-swing) and stays nearly straight in stance. The
    // pelvis is highest as the legs pass and lowest at full stride.
    const A = 0.36 * walk,
      sp = Math.sin(phase);
    const knee = (p) => walk * (0.07 + 0.78 * Math.pow(Math.max(0, -Math.cos(p)), 1.5) + 0.1 * Math.max(0, Math.sin(p)));
    const L = legs;
    if (thL) thL.rotation.set(-1.5 * seated + A * sp + (L.thL || 0), 0, 0.04 * seated);
    if (thR) thR.rotation.set(-1.5 * seated - A * sp + (L.thR || 0), 0, -0.04 * seated);
    if (shL) shL.rotation.set(1.45 * seated + knee(phase) + (L.shL || 0), 0, 0);
    if (shR) shR.rotation.set(1.45 * seated + knee(phase + Math.PI) + (L.shR || 0), 0, 0);
    const breathe = Math.sin(t * 1.6) * 0.008;
    if (hips) hips.position.y = 0.95 + walk * (0.012 * Math.cos(2 * phase) - 0.012) + (L.dip || 0);
    if (torso) torso.rotation.set(0.05 * walk - 0.06 * seated + lean + breathe, 0.06 * sp * walk, 0.02 * Math.cos(phase) * walk);
    if (hd) hd.rotation.set(nod + Math.sin(phase * 2) * 0.02 * walk, head, 0);
    const LT = P("letter");
    if (LT) LT.visible = letter;
    r.updateMatrixWorld(true);
    const fwd = v3(0, 0, 1).applyQuaternion(r.quaternion),
      left = v3(1, 0, 0).applyQuaternion(r.quaternion),
      down = v3(0, -1, 0);
    for (const [side, target, pole] of [["L", handL, poleL], ["R", handR, poleR]]) {
      const up = P("upperarm_" + side),
        fo = P("forearm_" + side);
      if (!up || !fo) continue;
      if (target) this.ik(up, fo, target, pole || fwd.clone().multiplyScalar(-1).addScaledVector(left, side === "L" ? 0.6 : -0.6).addScaledVector(down, 0.4).normalize());
      else {
        const s = side === "L" ? 1 : -1;
        // Arms swing opposite the legs, forearm trailing a little.
        const sw = -Math.sin(phase) * 0.32 * walk * s;
        up.rotation.set(sw + 0.03, 0, s * 0.07);
        fo.rotation.set(-0.2 - 0.12 * walk + Math.min(0, sw) * 0.5, 0, 0);
      }
    }
  }
  poseTheo(pos, yaw, speed, t, visible) {
    const c = this.theo;
    if (!c) return;
    c.root.visible = visible;
    if (!visible) return;
    c.root.position.copy(pos);
    c.root.rotation.set(0, yaw, 0);
    const P = c.part,
      spin = t * speed * 4;
    for (const n of ["wheel_F", "wheel_B"]) P(n) && (P(n).rotation.x = -spin);
    if (P("leg_L")) P("leg_L").rotation.x = Math.sin(spin * 0.5) * 0.5;
    if (P("leg_R")) P("leg_R").rotation.x = -Math.sin(spin * 0.5) * 0.5;
    if (P("head")) P("head").rotation.y = -0.5; // looks over at the van
  }
  posePepper(pos, yaw, run, sit, t, pace = 16, look = 0) {
    const c = this.pepper;
    if (!c) return;
    const r = c.root,
      P = c.part;
    r.position.copy(pos);
    r.rotation.y = yaw;
    const ph = t * pace;
    for (const [n, o] of [["leg_FL", 0], ["leg_BR", 0], ["leg_FR", Math.PI], ["leg_BL", Math.PI]]) {
      const leg = P(n);
      if (leg) leg.rotation.x = Math.sin(ph + o) * 0.85 * Math.min(1, run * 1.5) + (n.startsWith("leg_B") ? sit : 0);
    }
    const body = P("body");
    if (body) {
      body.rotation.set(-0.25 * sit, 0, Math.sin(ph) * 0.07 * run);
      body.position.y = 0.2 + Math.abs(Math.sin(ph)) * 0.035 * run;
    }
    if (P("tail")) P("tail").rotation.z = Math.sin(t * 16) * 0.5;
    if (P("head")) P("head").rotation.set(look, 0, sit * Math.sin(t * 2) * 0.25);
  }
  dispose() {
    this.disposed = true;
    this.scene.remove(this.group);
    for (const d of this.disposables) d?.dispose?.();
    this.disposables = [];
  }
}
export { sm, v3 };
