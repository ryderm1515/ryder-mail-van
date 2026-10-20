import * as T from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RAPIER } from "./physics.js";
export const ZONES = [
  {
    id: "garage",
    name: "The workshop",
    hint: "Explore, repair and start driving",
    icon: "building-warehouse",
    spawn: [0, 1.06, 0],
    yaw: 0,
  },
  {
    id: "jump",
    name: "Mega ramp",
    hint: "Hold Shift for boost. Find your longest jump.",
    icon: "plane-tilt",
    spawn: [14, 1.06, -60],
    yaw: 0,
  },
  {
    id: "crash",
    name: "Crash laboratory",
    hint: "Concrete wall and a breakaway block stack",
    icon: "car-crash",
    spawn: [18, 1.06, 65],
    yaw: 0,
  },
  {
    id: "pendulum",
    name: "Pendulum alley",
    hint: "Time your run past a two-ton swinging ball",
    icon: "wrecking-ball",
    spawn: [12, 1.06, 25],
    yaw: 0,
  },
  {
    id: "bowling",
    name: "Barrel bowling",
    hint: "Knock down the barrels and start a domino chain",
    icon: "bowling",
    spawn: [10, 1.06, 110],
    yaw: 0,
  },
  {
    id: "handling",
    name: "Handling circuit",
    hint: "Eight gates. One clean, timed lap.",
    icon: "route",
    spawn: [106, 1.06, 81],
    yaw: Math.PI / 2,
  },
  {
    id: "articulation",
    name: "Suspension course",
    hint: "Alternating humps, rumble strips and steps",
    icon: "arrows-up-down",
    spawn: [20, 1.06, -150],
    yaw: 0,
  },
  {
    id: "bridge",
    name: "Balance bridge",
    hint: "A physical seesaw that moves under the van",
    icon: "building-bridge",
    spawn: [15, 1.06, -25],
    yaw: 0,
  },
  {
    id: "interstate",
    name: "Interstate 16",
    hint: "Open highway with live traffic. Two exits lead to mail-route towns.",
    icon: "road",
    spawn: [0, 1.06, 0],
    yaw: 0,
    open: true,
  },
  {
    id: "drop",
    name: "Drop platform",
    hint: "A 22-meter drop. Try slow motion before landing.",
    icon: "parachute",
    spawn: [5, 23.06, -110],
    yaw: 0,
  },
];
export class TestWorld {
  constructor(scene, physics, toon) {
    this.scene = scene;
    this.physics = physics;
    this.moving = [];
    this.barrels = [];
    this.dominoes = [];
    this.gates = [];
    this.jumps = [];
    this.materials = {};
    this.toon = toon;
    this.stats = {
      airStart: null,
      bestJump: 0,
      lastJump: 0,
      gates: 0,
      lapTime: 0,
      bestLap: null,
      lapStart: null,
      barrels: 0,
      dominoes: 0,
    };
    this.active = "garage";
    this.notice = () => {};
    for (const [key, color] of Object.entries({
      sage: 0x829e8b,
      light: 0xdbddd2,
      concrete: 0xb6bcb5,
      dark: 0x47564f,
      rust: 0xc48b70,
      blue: 0x8faeb7,
      yellow: 0xd7bc79,
      white: 0xeceee6,
    }))
      this.materials[key] = toon(new T.MeshToonMaterial({ color }));
    this.build();
  }
  mesh(geo, mat = "sage") {
    const m = new T.Mesh(geo, this.materials[mat] || mat);
    m.castShadow = true;
    m.receiveShadow = true;
    this.scene.add(m);
    return m;
  }
  box(pos, half, mat = "sage", dynamic = false, mass = 25, rotation = 0) {
    const p = this.physics.obstacle(pos, half, rotation, dynamic, { mass }),
      m = this.mesh(
        new RoundedBoxGeometry(half[0] * 2, half[1] * 2, half[2] * 2, 2, Math.min(0.09, ...half) * 0.5),
        mat,
      );
    m.position.set(...pos);
    m.rotation.z = rotation;
    if (dynamic) this.moving.push({ body: p.body, mesh: m });
    return { body: p.body, mesh: m, p };
  }
  paint(pos, width, length, mat = "light", rotation = 0) {
    const m = new T.Mesh(new T.PlaneGeometry(width, length), this.materials[mat]);
    m.rotation.set(-Math.PI / 2, 0, rotation);
    m.position.set(pos[0], 0.018, pos[1]);
    m.receiveShadow = true;
    this.scene.add(m);
    return m;
  }
  label(text, pos, size = 8) {
    const c = document.createElement("canvas");
    c.width = 1024;
    c.height = 128;
    const x = c.getContext("2d");
    x.fillStyle = "#eff1e8";
    x.font = "600 62px -apple-system, sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(text, 512, 64);
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    const m = new T.Mesh(
      new T.PlaneGeometry(size, size / 8),
      new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = -Math.PI / 2;
    m.position.set(...pos);
    this.scene.add(m);
    return m;
  }
  ramp(startX, endX, z, width, heightFn, color = "sage", segments = 48) {
    const verts = [],
      idx = [];
    for (let i = 0; i <= segments; i++) {
      const u = i / segments,
        x = T.MathUtils.lerp(startX, endX, u),
        y = heightFn(u) + 0.025;
      verts.push(x, y, z - width / 2, x, y, z + width / 2);
    }
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = this.mesh(g, color);
    m.material = this.materials[color].clone();
    m.material.side = T.DoubleSide;
    this.physics.surface(verts, idx);
    // Closed side profiles give each ramp a clean, substantial silhouette.
    for (const sign of [-1, 1]) {
      const v = [],
        ix = [];
      for (let i = 0; i <= segments; i++) {
        const u = i / segments,
          x = T.MathUtils.lerp(startX, endX, u),
          y = heightFn(u) + 0.025;
        v.push(x, 0, z + (sign * width) / 2, x, y, z + (sign * width) / 2);
      }
      for (let i = 0; i < segments; i++) {
        const a = i * 2;
        ix.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const sg = new T.BufferGeometry();
      sg.setAttribute("position", new T.Float32BufferAttribute(v, 3));
      sg.setIndex(ix);
      sg.computeVertexNormals();
      const side = this.mesh(sg, "concrete");
      side.material = this.materials.concrete.clone();
      side.material.side = T.DoubleSide;
      this.physics.surface(v, ix);
    }
    return m;
  }
  cone(x, z) {
    const p = this.physics.obstacle([x, 0.31, z], [0.25, 0.31, 0.25], 0, true, { mass: 6 }),
      g = new T.Group(),
      base = new T.Mesh(new RoundedBoxGeometry(0.65, 0.1, 0.65, 1, 0.03), this.materials.dark),
      cone = new T.Mesh(new T.ConeGeometry(0.25, 0.64, 10), this.materials.rust),
      band = new T.Mesh(new T.CylinderGeometry(0.11, 0.16, 0.11, 10), this.materials.light);
    base.position.y = -0.26;
    cone.position.y = 0.02;
    band.position.y = 0.06;
    g.add(base, cone, band);
    g.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.scene.add(g);
    this.moving.push({ body: p.body, mesh: g });
  }
  build() {
    // Workshop islands and route markings stay low and open around the vehicle.
    this.paint([0, 0], 16, 12, "concrete");
    this.label("WORKSHOP", [3, 0.032, 0], 6);
    for (const z of [-6, 6])
      for (let i = 0; i < 5; i++)
        this.box([5 + i * 1.6, 0.16, z], [0.55, 0.16, 0.2], i % 2 ? "light" : "sage");
    // Continuous curved launch ramp and a descending landing apron.
    this.paint([-32, -60], 85, 9, "concrete");
    this.ramp(-70, -120, -60, 10, (u) => 18 * u * u, "sage", 72);
    this.ramp(-170, -220, -60, 15, (u) => 12 * (1 - u) * (1 - u), "sage", 60);
    this.label("MEGA RAMP", [-20, 0.035, -60], 10);
    for (let i = 0; i < 10; i++)
      for (const z of [-65.3, -54.7])
        this.box([-10 - i * 6, 0.11, z], [1.7, 0.11, 0.13], i % 2 ? "light" : "sage");
    for (let i = 0; i < 4; i++) {
      const ring = this.mesh(new T.TorusGeometry(4.8, 0.13, 8, 56), "light");
      ring.rotation.y = Math.PI / 2;
      ring.position.set(-130 - i * 9, 21 + i * 0.5, -60);
      this.jumps.push(ring);
    }
    // Twenty-two-meter drop platform with a readable ledge and support legs.
    this.box([4, 21.7, -110], [10, 0.3, 8], "blue");
    for (const x of [-3, 11])
      for (const z of [-116, -104]) this.box([x, 10.7, z], [0.35, 10.7, 0.35], "concrete");
    this.label("DROP / 22 M", [6, 22.02, -110], 9);
    for (const z of [-117.7, -102.3]) this.box([4, 22.35, z], [10, 0.35, 0.12], "light");
    // Crash lanes: rigid barrier and independent breakaway blocks.
    this.paint([-23, 65], 91, 13, "concrete");
    this.label("CRASH LAB", [-4, 0.035, 65], 10);
    this.box([-66, 3.2, 65], [1.1, 3.2, 7.5], "light");
    for (let i = 0; i < 13; i++) this.paint([-66 + 2, 58 + i * 1.1], 0.3, 0.6, i % 2 ? "dark" : "yellow");
    this.paint([-24, 84], 85, 11, "concrete");
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 8; col++)
        this.box(
          [-62, 0.42 + row * 0.85, 79.1 + col * 1.4],
          [0.65, 0.415, 0.66],
          (row + col) % 3 ? "sage" : "light",
          true,
          52,
        );
    // Pendulum on a real spherical joint. Its rod is a rigid extension of the ball.
    const cx = -47,
      cz = 25;
    this.paint([-26, 25], 75, 12, "concrete");
    this.label("PENDULUM", [-8, 0.035, 25], 9);
    for (const z of [cz - 8, cz + 8]) this.box([cx, 7, z], [0.38, 7, 0.38], "sage");
    this.box([cx, 14, cz], [0.5, 0.35, 8.5], "sage");
    const anchor = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(cx, 13.7, cz),
    );
    const angle = 0.64,
      len = 7.5,
      ball = this.physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(cx, 13.7 - len * Math.cos(angle), cz - len * Math.sin(angle))
          .setRotation({ x: Math.sin(angle / 2), y: 0, z: 0, w: Math.cos(angle / 2) })
          .setAngularDamping(0.005)
          .setCcdEnabled(true),
      );
    this.physics.world.createCollider(RAPIER.ColliderDesc.ball(1.65).setMass(2000).setFriction(0.6), ball);
    this.physics.world.createImpulseJoint(
      RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: 0, y: len, z: 0 }),
      anchor,
      ball,
      true,
    );
    const group = new T.Group(),
      sphere = new T.Mesh(new T.IcosahedronGeometry(1.65, 2), this.materials.rust),
      rod = new T.Mesh(new T.CylinderGeometry(0.07, 0.07, len, 8), this.materials.dark);
    rod.position.y = len / 2;
    group.add(sphere, rod);
    group.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.scene.add(group);
    this.moving.push({ body: ball, mesh: group });
    this.pendulum = { body: ball, anchor, cx, cz, angle, len };
    // Bowling cylinders, intentionally loose enough to tumble and roll.
    this.paint([-23, 110], 75, 13, "concrete");
    this.label("BARREL BOWLING", [-5, 0.035, 110], 10);
    for (let row = 0; row < 4; row++)
      for (let col = 0; col <= row; col++) {
        const pos = [-43 - row * 1.65, 0.65, 110 + (col - row / 2) * 1.45],
          body = this.physics.world.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic()
              .setTranslation(...pos)
              .setCcdEnabled(true),
          );
        this.physics.world.createCollider(
          RAPIER.ColliderDesc.cylinder(0.65, 0.5).setMass(24).setFriction(0.55),
          body,
        );
        const g = new T.Group(),
          can = new T.Mesh(
            new T.CylinderGeometry(0.5, 0.5, 1.3, 16),
            this.materials[row % 2 ? "blue" : "rust"],
          );
        g.add(can);
        for (const y of [-0.44, 0.44]) {
          const ring = new T.Mesh(new T.TorusGeometry(0.5, 0.035, 6, 20), this.materials.light);
          ring.rotation.x = Math.PI / 2;
          ring.position.y = y;
          g.add(ring);
        }
        g.traverse((o) => {
          if (o.isMesh) o.castShadow = true;
        });
        this.scene.add(g);
        this.moving.push({ body, mesh: g });
        this.barrels.push({ body, pos });
      }
    for (let i = 0; i < 28; i++) {
      const x = -78 - i * 2.3,
        z = 110 + Math.sin(i * 0.18) * 4;
      const p = this.box([x, 1.3, z], [0.2, 1.3, 0.82], i % 3 ? "sage" : "light", true, 32);
      this.dominoes.push({ body: p.body, pos: [x, 1.3, z] });
    }
    // A circular handling course and a slalom approach.
    const circle = new T.Mesh(new T.RingGeometry(23.5, 29, 112), this.materials.concrete);
    circle.rotation.x = -Math.PI / 2;
    circle.position.set(80, 0.021, 85);
    this.scene.add(circle);
    this.label("HANDLING", [81, 0.035, 85], 10);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4,
        x = 80 + 26.25 * Math.cos(a),
        z = 85 + 26.25 * Math.sin(a),
        group = new T.Group();
      for (const d of [-3, 3]) {
        const post = new T.Mesh(new T.CylinderGeometry(0.07, 0.1, 1.6, 8), this.materials.sage);
        post.position.set(d * Math.cos(a), 0.8, d * Math.sin(a));
        group.add(post);
      }
      const stripe = new T.Mesh(new T.BoxGeometry(6, 0.02, 0.12), this.materials.light);
      stripe.rotation.y = -a;
      group.add(stripe);
      group.position.set(x, 0.03, z);
      this.scene.add(group);
      this.gates.push({ group, x, z });
    }
    for (let i = 0; i < 12; i++) this.cone(50 + i * 4, 25 + (i % 2 ? 2.5 : -2.5));
    // Alternating raised patches, then evenly spaced rumble strips.
    this.paint([-28, -150], 100, 8, "concrete");
    this.label("ARTICULATION", [5, 0.035, -150], 10);
    for (let i = 0; i < 10; i++) {
      const x = -5 - i * 5,
        z = -150 + (i % 2 ? 1.05 : -1.05);
      this.ramp(
        x + 1.5,
        x - 1.5,
        z,
        1.3,
        (u) => 0.28 * Math.sin(Math.PI * u) ** 2,
        i % 2 ? "sage" : "light",
        12,
      );
    }
    for (let i = 0; i < 10; i++)
      this.box([-65 - i * 0.9, 0.095, -150], [0.18, 0.095, 2.6], i % 2 ? "light" : "sage");
    for (let i = 0; i < 5; i++)
      this.box([-82 - i * 1.3, 0.12 + i * 0.07, -150], [0.64, 0.12 + i * 0.07, 2.7], "concrete");
    // A heavy seesaw with bounded revolute motion and a weak centering spring.
    this.ramp(-9, -29, -25, 6, (u) => 1.85 * u, "blue", 20);
    this.ramp(-53, -73, -25, 6, (u) => 1.85 * (1 - u), "blue", 20);
    const pivot = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(-41, 1.8, -25),
    );
    const deck = this.box([-41, 1.8, -25], [12, 0.16, 3], "blue", true, 900);
    deck.p.managed = true;
    const hinge = this.physics.world.createImpulseJoint(
      RAPIER.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
      pivot,
      deck.body,
      true,
    );
    hinge.setLimits(-0.12, 0.12);
    hinge.configureMotorPosition(0, 400, 100);
    this.box([-41, 0.7, -25], [0.7, 0.7, 3.2], "concrete");
    this.label("BALANCE BRIDGE", [2, 0.035, -25], 10);
    this.bridge = deck;
    // Low, rounded blocks delineate the world without enclosing every course.
    for (const x of [-330, 330]) this.box([x, 0.45, 0], [0.3, 0.45, 330], "concrete");
    for (const z of [-330, 330]) this.box([0, 0.45, z], [330, 0.45, 0.3], "concrete");
    for (let i = 0; i < 18; i++) {
      const a = (i * Math.PI * 2) / 18,
        r = 235 + (i % 3) * 9,
        x = Math.cos(a) * r,
        z = Math.sin(a) * r;
      const mound = this.mesh(new T.SphereGeometry(1, 16, 10), "sage");
      mound.position.set(x, -1, z);
      mound.scale.set(14 + (i % 3) * 5, 4 + (i % 4) * 2, 12 + (i % 2) * 8);
      mound.updateMatrixWorld(true);
      const verts = Array.from(mound.geometry.attributes.position.array);
      for (let j = 0; j < verts.length; j += 3) {
        verts[j] = verts[j] * mound.scale.x + x;
        verts[j + 1] = verts[j + 1] * mound.scale.y - 1;
        verts[j + 2] = verts[j + 2] * mound.scale.z + z;
      }
      this.physics.surface(verts, Array.from(mound.geometry.index.array));
    }
  }
  resetChallenges() {
    Object.assign(this.stats, {
      airStart: null,
      lastJump: 0,
      gates: 0,
      lapTime: 0,
      lapStart: null,
      barrels: 0,
      dominoes: 0,
    });
    for (const b of [...this.barrels, ...this.dominoes]) {
      b.body.setTranslation({ x: b.pos[0], y: b.pos[1], z: b.pos[2] }, true);
      b.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    this.physics.snapAll();
  }
  select(id) {
    this.active = id;
    this.stats.gates = 0;
    this.stats.lapStart = null;
    this.stats.lapTime = 0;
    this.stats.airStart = null;
    this.gates.forEach((g) =>
      g.group.traverse((o) => {
        if (o.isMesh) o.material = this.materials.light;
      }),
    );
  }
  update(dt, st) {
    const alpha = this.physics.alpha;
    for (const p of this.moving) {
      // Interpolated between fixed physics steps, same as the van.
      p.track ||= this.physics.track(p.body);
      p.track.apply(p.mesh, alpha);
    }
    const s = this.stats,
      pos = st.position;
    if (st.grounded === 0 && Math.abs(st.speed) > 3) {
      if (!s.airStart) s.airStart = { x: pos.x, z: pos.z, time: this.physics.elapsed };
    } else if (s.airStart) {
      const duration = this.physics.elapsed - s.airStart.time;
      if (duration > 0.45) {
        const distance = Math.hypot(pos.x - s.airStart.x, pos.z - s.airStart.z);
        s.lastJump = distance;
        s.bestJump = Math.max(s.bestJump, distance);
        this.notice("Air time " + duration.toFixed(1) + " s · " + distance.toFixed(1) + " m");
      }
      s.airStart = null;
    }
    s.barrels = this.barrels.filter((b) => {
      const p = b.body.translation(),
        q = b.body.rotation();
      return Math.hypot(p.x - b.pos[0], p.z - b.pos[2]) > 1.4 || Math.abs(q.x) + Math.abs(q.z) > 0.35;
    }).length;
    s.dominoes = this.dominoes.filter((b) => {
      const q = b.body.rotation();
      return Math.abs(q.x) + Math.abs(q.z) > 0.45;
    }).length;
    if (this.active === "handling") {
      const gate = this.gates[s.gates % 8];
      if (Math.hypot(pos.x - gate.x, pos.z - gate.z) < 3) {
        if (!s.lapStart) s.lapStart = this.physics.elapsed;
        gate.group.traverse((o) => {
          if (o.isMesh) o.material = this.materials.sage;
        });
        s.gates++;
        if (s.gates === 9) {
          s.lapTime = this.physics.elapsed - s.lapStart;
          s.bestLap = s.bestLap === null ? s.lapTime : Math.min(s.bestLap, s.lapTime);
          this.notice("Lap complete · " + s.lapTime.toFixed(2) + " s");
          s.gates = 0;
          s.lapStart = null;
        }
      }
      if (s.lapStart) s.lapTime = this.physics.elapsed - s.lapStart;
    }
  }
}
