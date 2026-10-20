import * as T from "three";

// Stylized tyre marks. Each wheel lays a ribbon of quads on the ground while
// it is launching, drifting or braking hard. The look matches the flat, cool
// palette of the baseplate: a soft-edged band with tread grooves that fades
// out over half a minute. One ring buffer, one draw call.

const SEG = 2600,
  WIDTH = [0.25, 0.25, 0.29, 0.29],
  MIN_STEP = 0.22,
  LIFE = [16, 34]; // fade start, fully gone (seconds)

export class SkidMarks {
  constructor(scene, physics) {
    this.physics = physics;
    this.time = 0;
    this.head = 0;
    const pos = new Float32Array(SEG * 4 * 3),
      data = new Float32Array(SEG * 4 * 3),
      index = new Uint32Array(SEG * 6);
    for (let s = 0; s < SEG; s++) {
      const v = s * 4;
      index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], s * 6);
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute("aData", new T.BufferAttribute(data, 3).setUsage(T.DynamicDrawUsage));
    g.setIndex(new T.BufferAttribute(index, 1));
    // Unused segments start long dead so they draw nothing.
    for (let i = 0; i < SEG * 4; i++) data[i * 3 + 2] = -1e4;
    this.geometry = g;
    this.uniforms = {
      uTime: { value: 0 },
      uColor: { value: new T.Color(0x3c4a55) },
      uOpacity: { value: 0.46 },
      uLife: { value: new T.Vector2(...LIFE) },
    };
    this.material = new T.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      vertexShader: /* glsl */ `
        attribute vec3 aData; // across (0..1), intensity, birth time
        varying vec3 vData;
        varying float vAlong;
        void main() {
          vData = aData;
          vAlong = position.x * 0.37 + position.z * 0.61;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uOpacity;
        uniform vec3 uColor;
        uniform vec2 uLife;
        varying vec3 vData;
        varying float vAlong;
        void main() {
          float across = vData.x;
          float age = uTime - vData.z;
          float fade = 1.0 - smoothstep(uLife.x, uLife.y, age);
          float edge = smoothstep(0.0, 0.16, across) * smoothstep(1.0, 0.84, across);
          // Three tread grooves, slightly broken up along the length.
          float g = abs(fract(across * 4.0) - 0.5);
          float groove = 1.0 - smoothstep(0.08, 0.16, g);
          float grain = 0.88 + 0.12 * sin(vAlong * 23.0 + across * 7.0);
          float a = vData.y * edge * fade * (1.0 - 0.55 * groove) * grain * uOpacity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    this.mesh = new T.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = "Skid marks";
    scene.add(this.mesh);
    this.wheels = [0, 1, 2, 3].map(() => ({ active: false, p: new T.Vector3(), l: new T.Vector3(), r: new T.Vector3(), k: 0 }));
    this._p = new T.Vector3();
    this._n = new T.Vector3();
    this._d = new T.Vector3();
    this._s = new T.Vector3();
  }
  setTheme(dark) {
    this.uniforms.uColor.value.set(dark ? 0x1a2329 : 0x3c4a55);
    this.uniforms.uOpacity.value = dark ? 0.6 : 0.46;
  }
  clear() {
    const data = this.geometry.attributes.aData;
    for (let i = 0; i < SEG * 4; i++) data.array[i * 3 + 2] = -1e4;
    data.needsUpdate = true;
    for (const w of this.wheels) w.active = false;
  }
  // How hard each wheel should mark this frame.
  intensity(i) {
    const ph = this.physics,
      rear = i >= 2,
      v = Math.abs(ph.speed),
      drift = ph.driftAmount || 0,
      launch = ph.launch || 0,
      hardBrake = ph.brake > 0.6 && v > 5 ? Math.min(1, (ph.brake - 0.6) * 2.5) * Math.min(1, v / 12) : 0,
      handbrake = rear && ph.lastHandbrake && v > 3 ? 0.9 : 0,
      slide = Math.max(0, ((ph.skid || 0) - 3) / 4);
    let k = Math.max(rear ? drift : drift * 0.45, rear ? launch : launch * 0.35, hardBrake * (rear ? 0.75 : 0.9), handbrake, Math.min(1, slide) * (rear ? 0.8 : 0.5));
    return Math.min(1, k);
  }
  update(dt) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    const ph = this.physics,
      car = ph.car,
      pos = this.geometry.attributes.position,
      data = this.geometry.attributes.aData;
    let dirty = false;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i],
        contact = ph.wheelEnabled[i] && car.wheelIsInContact(i),
        k = contact ? this.intensity(i) : 0;
      if (k < 0.06) {
        w.active = false;
        continue;
      }
      const cp = car.wheelContactPoint(i),
        cn = car.wheelContactNormal(i);
      if (!cp) continue;
      const n = this._n.set(cn?.x ?? 0, cn?.y ?? 1, cn?.z ?? 0),
        p = this._p.set(cp.x, cp.y, cp.z).addScaledVector(n, 0.012);
      if (!w.active || p.distanceTo(w.p) > 3) {
        w.active = true;
        w.p.copy(p);
        w.k = 0;
        w.fresh = true;
        continue;
      }
      const dist = p.distanceTo(w.p);
      if (dist < MIN_STEP) continue;
      const dir = this._d.subVectors(p, w.p).normalize(),
        side = this._s.crossVectors(dir, n).normalize().multiplyScalar(WIDTH[i] / 2);
      if (w.fresh) {
        w.l.copy(w.p).add(side);
        w.r.copy(w.p).sub(side);
        w.fresh = false;
      }
      const s = this.head,
        v = s * 4,
        a = pos.array,
        b = data.array;
      // Previous edge, then the new edge.
      a.set([w.l.x, w.l.y, w.l.z, w.r.x, w.r.y, w.r.z], v * 3);
      w.l.copy(p).add(side);
      w.r.copy(p).sub(side);
      a.set([w.l.x, w.l.y, w.l.z, w.r.x, w.r.y, w.r.z], (v + 2) * 3);
      const k0 = w.k,
        t = this.time;
      b.set([0, k0, t, 1, k0, t, 0, k, t, 1, k, t], v * 3);
      w.k = k;
      w.p.copy(p);
      this.head = (this.head + 1) % SEG;
      dirty = true;
    }
    if (dirty) {
      pos.needsUpdate = true;
      data.needsUpdate = true;
    }
  }
}
