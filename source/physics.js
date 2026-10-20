import RAPIER from "./vendor/rapier/rapier.mjs";
import * as T from "three";
export { RAPIER };

const STEP = 1 / 120;
const _q = new T.Quaternion(),
  _qs = new T.Quaternion(),
  _fwd = new T.Vector3(),
  _vel = new T.Vector3(),
  _tmp = new T.Vector3(),
  _tmp2 = new T.Vector3(),
  _bp = new T.Vector3(),
  _av = new T.Vector3(),
  _s1 = new T.Vector3(),
  _s2 = new T.Vector3(),
  _s3 = new T.Vector3(),
  _s4 = new T.Vector3(),
  _s5 = new T.Vector3();

// Keeps the previous and current fixed-step pose of a rigid body so rendering
// can interpolate between them. Without this, any display refresh rate that is
// not an exact multiple of the 120 Hz physics clock shows visible judder.
class Tracked {
  constructor(body) {
    this.body = body;
    this.p0 = new T.Vector3();
    this.p1 = new T.Vector3();
    this.q0 = new T.Quaternion();
    this.q1 = new T.Quaternion();
    this.snap();
  }
  snap() {
    const t = this.body.translation(),
      r = this.body.rotation();
    this.p1.set(t.x, t.y, t.z);
    this.q1.set(r.x, r.y, r.z, r.w);
    this.p0.copy(this.p1);
    this.q0.copy(this.q1);
  }
  advance() {
    this.p0.copy(this.p1);
    this.q0.copy(this.q1);
  }
  capture() {
    const t = this.body.translation(),
      r = this.body.rotation();
    this.p1.set(t.x, t.y, t.z);
    this.q1.set(r.x, r.y, r.z, r.w);
  }
  apply(object, alpha) {
    object.position.lerpVectors(this.p0, this.p1, alpha);
    object.quaternion.slerpQuaternions(this.q0, this.q1, alpha);
  }
}

export class DrivingPhysics {
  static async create() {
    await RAPIER.init();
    return new DrivingPhysics();
  }
  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.world.integrationParameters.numSolverIterations = 8;
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(350, 0.1, 350).setTranslation(0, -0.1, 0).setFriction(0.95),
    );
    this.events = new RAPIER.EventQueue(true);
    this.impacts = [];
    this.elapsed = 0;
    this.lastContact = -1;
    this.mass = 1850;
    this.body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 1.06, 0)
        .setLinearDamping(0.025)
        .setAngularDamping(0.8)
        .setCcdEnabled(true),
    );
    this.body.setAdditionalMassProperties(
      this.mass,
      { x: 0, y: -0.32, z: 0 }, // low centre of mass: batteries in the floor
      { x: 2100, y: 5900, z: 6100 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );
    // Fitted to the body shell (bumper to rear step, sill to roof, door skin to door skin)
    // so contacts happen where the visible van actually is.
    this.chassisShape = { half: { x: 2.88, y: 1.22, z: 1.1 }, offset: { x: -0.07, y: 0.9, z: 0 } };
    this.chassis = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(2.88, 1.22, 1.1)
        .setTranslation(-0.07, 0.9, 0)
        .setDensity(0)
        .setFriction(0.42)
        .setRestitution(0.02)
        .setCollisionGroups(0x0001fffd)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(26000),
      this.body,
    );
    this.car = this.world.createVehicleController(this.body);
    this.car.indexUpAxis = 1;
    this.car.setIndexForwardAxis = 0; // Rapier names this setter "setIndexForwardAxis"
    this.wheels = [
      ["FL", -1.96, -1.028],
      ["FR", -1.96, 1.028],
      ["RL", 1.53, -1.028],
      ["RR", 1.53, 1.028],
    ];
    this.wheels.forEach((w) =>
      this.car.addWheel(
        { x: w[1], y: -0.135, z: w[2] },
        { x: 0, y: -1, z: 0 },
        { x: 0, y: 0, z: -1 },
        0.3,
        0.517,
      ),
    );
    this.props = [];
    this.obstacles = [];
    this.tracked = new Set();
    this.vehicleTrack = this.track(this.body);
    this.alpha = 1;
    this.soft = null;
    this.speed = 0;
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.distance = 0;
    this.impact = 0;
    this.lastVy = 0;
    this.wheelSpin = [0, 0, 0, 0];
    this.wheelSpinPrev = [0, 0, 0, 0];
    this.suspension = [0, 0, 0, 0];
    this.suspensionPrev = [0, 0, 0, 0];
    this.wheelOffset = [0, 0, 0, 0];
    this.accumulator = 0;
    this.grounded = 0;
    this.rpm = 0;
    this.driveGear = 1;
    this.shiftTimer = 0;
    this.boost = false;
    this.timeScale = 1;
    this.spawn = { position: [0, 1.06, 0], yaw: 0 };
    // Arcade tuning. Pushed well past a real 1.8 t van: it launches like a hot
    // hatch, turns in instantly and holds long, controllable drifts.
    this.arcade = {
      force: 23000, // N at the wheels off the line
      power: 520000, // W, sets the pull once torque runs out
      top: 52, // m/s (~187 km/h)
      boostForce: 30000,
      boostPower: 900000,
      boostTop: 70,
      reverseForce: 12000,
      reverseTop: 13,
      frontShare: 0.38,
      launchAssist: 3.4, // m/s^2 of extra shove, fading out by assistTop
      assistTop: 20,
      brakeFront: 95,
      brakeRear: 70,
      brakeAssist: 10, // m/s^2
      grip: 2.6,
      side: 0.85,
      driftFrontSide: 0.55,
      driftThrust: 7, // m/s^2 along the slide while on the throttle
      driftTop: 34,
      driftSlip: 1.0,
      driftSide: 0.34,
      lockLow: 0.62,
      lockHigh: 0.15,
      steerRate: 15,
      steerReturn: 20,
      pedal: 14,
      yawGain: 1.12,
      maxLateral: 24, // m/s^2 of cornering the yaw assist will ask for
      yawRate: 7,
      gripAlign: 6.5,
      driftYaw: 2.05,
      driftYawRate: 4.5,
      driftAlign: 2.6,
      driftDrag: 0.05,
      counterSteer: 0.75,
      flick: 1.35,
      antiRoll: 7,
      airRight: 1.6,
    };
    this.drift = false;
    this.driftTime = 0;
    this.driftCalm = 0;
    this.driftAmount = 0;
    this.slipAngle = 0;
    this.launch = 0;
    this._state = {
      position: new T.Vector3(),
      rotation: new T.Quaternion(),
      speed: 0,
      steer: 0,
      grounded: 0,
      suspension: [0, 0, 0, 0],
      spin: [0, 0, 0, 0],
      rpm: 0,
      driveGear: 1,
    };
    this.repair();
  }
  track(body) {
    const t = new Tracked(body);
    this.tracked.add(t);
    return t;
  }
  untrack(t) {
    this.tracked.delete(t);
  }
  snapAll() {
    for (const t of this.tracked) t.snap();
    this.accumulator = 0;
    this.alpha = 1;
    for (let i = 0; i < 4; i++) {
      this.wheelSpinPrev[i] = this.wheelSpin[i];
      this.suspensionPrev[i] = this.suspension[i];
    }
  }
  repair() {
    this.power = 1;
    this.wheelEnabled = [true, true, true, true];
    this.wheelDamage = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      this.car.setWheelSuspensionStiffness(i, 44);
      this.car.setWheelSuspensionCompression(i, 4.6);
      this.car.setWheelSuspensionRelaxation(i, 5);
      this.car.setWheelMaxSuspensionTravel(i, 0.14);
      this.car.setWheelMaxSuspensionForce(i, 24000);
      this.car.setWheelFrictionSlip(i, 1.8);
      this.car.setWheelSideFrictionStiffness(i, 1.05);
    }
    this.setChassisShape(this.chassisShape.half, this.chassisShape.offset);
  }
  setChassisShape(half, offset) {
    this.chassis.setHalfExtents(half);
    this.chassis.setTranslationWrtParent(offset);
  }
  damageWheel(i, value, detached = false) {
    this.wheelDamage[i] = Math.min(1, this.wheelDamage[i] + value);
    if (detached) this.wheelEnabled[i] = false;
    this.car.setWheelMaxSuspensionForce(
      i,
      this.wheelEnabled[i] ? 24000 * (1 - this.wheelDamage[i] * 0.55) : 0,
    );
    this.car.setWheelSuspensionStiffness(i, this.wheelEnabled[i] ? 44 * (1 - this.wheelDamage[i] * 0.55) : 0);
  }
  obstacle(pos, size, rotation = 0, dynamic = false, options = {}) {
    const d = (dynamic ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.fixed())
      .setTranslation(...pos)
      .setRotation({ x: 0, y: 0, z: Math.sin(rotation / 2), w: Math.cos(rotation / 2) });
    if (dynamic) d.setCcdEnabled(true).setLinearDamping(0.08).setAngularDamping(0.2);
    const body = this.world.createRigidBody(d);
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(...size)
        .setMass(options.mass || 25)
        .setFriction(0.85)
        .setRestitution(0.04),
      body,
    );
    const p = { body, pos: [...pos], size, rotation, dynamic, name: options.name || "Obstacle" };
    this.obstacles.push(p);
    if (dynamic) this.props.push(p);
    return p;
  }
  surface(vertices, indices) {
    return this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(new Float32Array(vertices), new Uint32Array(indices)).setFriction(0.95),
    );
  }
  teleport(position, yaw = 0) {
    this.spawn = { position: [...position], yaw };
    this.reset(false);
  }
  reset(resetProps = true) {
    this.grab = null;
    const [x, y, z] = this.spawn.position;
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation(
      { x: 0, y: Math.sin(this.spawn.yaw / 2), z: 0, w: Math.cos(this.spawn.yaw / 2) },
      true,
    );
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.distance = 0;
    this.speed = 0;
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.accumulator = 0;
    this.lastContact = this.elapsed;
    this.impacts.length = 0;
    this.wheelSpin.fill(0);
    this.drift = false;
    this.driftAmount = 0;
    this.launching = 0;
    this.launch = 0;
    for (let i = 0; i < 4; i++) this.wheelOffset[i] = this.car.wheelRotation(i) || 0;
    if (resetProps)
      for (const p of this.props) {
        if (p.managed) continue;
        p.body.setTranslation({ x: p.pos[0], y: p.pos[1], z: p.pos[2] }, true);
        p.body.setRotation({ x: 0, y: 0, z: Math.sin(p.rotation / 2), w: Math.cos(p.rotation / 2) }, true);
        p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    this.snapAll();
  }
  update(dt, input, gear, ignition) {
    this.accumulator = Math.min(this.accumulator + dt * this.timeScale, 0.12);
    while (this.accumulator >= STEP) {
      for (const t of this.tracked) t.advance();
      for (let i = 0; i < 4; i++) {
        this.wheelSpinPrev[i] = this.wheelSpin[i];
        this.suspensionPrev[i] = this.suspension[i];
      }
      this.step(STEP, input, gear, ignition);
      for (const t of this.tracked) t.capture();
      this.accumulator -= STEP;
    }
    // Fraction of the next step already elapsed; rendering blends prev -> current by this.
    this.alpha = this.accumulator / STEP;
  }
  step(dt, input, gear, ignition) {
    this.elapsed += dt;
    const A = this.arcade,
      rot = this.body.rotation(),
      q = _q.set(rot.x, rot.y, rot.z, rot.w),
      forward = _fwd.set(-1, 0, 0).applyQuaternion(q),
      v = this.body.linvel(),
      vel = _vel.set(v.x, v.y, v.z);
    this.speed = forward.dot(vel);
    const speedAbs = Math.abs(this.speed),
      onGround = this.grounded >= 2,
      driving = ignition && (gear === "D" || gear === "R");
    // Slip angle: signed angle (left positive, about +Y) from the heading to the
    // horizontal velocity. In reverse it is measured against the tail.
    const fh = Math.hypot(forward.x, forward.z) || 1,
      fx = forward.x / fh,
      fz = forward.z / fh,
      vh = Math.hypot(vel.x, vel.z);
    let slip = vh > 0.6 ? Math.atan2(fz * vel.x - fx * vel.z, fx * vel.x + fz * vel.z) : 0;
    if (this.speed < 0) slip = Math.atan2(Math.sin(slip + Math.PI), Math.cos(slip + Math.PI));
    this.slipAngle = slip;
    // Drift state: a handbrake flick or a big enough slide at speed starts it;
    // it ends once the car has straightened up and the handbrake is released.
    const steerIn = -input.steer;
    this.lastHandbrake = !!input.handbrake;
    if (!this.drift) {
      if (
        onGround &&
        gear !== "R" &&
        this.speed > 7 &&
        ((input.handbrake && Math.abs(input.steer) > 0.15) ||
          (Math.abs(slip) > 0.28 && this.speed > 9) ||
          (input.brake > 0.5 && Math.abs(input.steer) > 0.6 && this.speed > 15)) // brake-tap entry
      ) {
        this.drift = true;
        this.driftTime = 0;
        this.driftCalm = 0;
        // The flick: kick the tail out in the direction of the steer.
        if (Math.abs(input.steer) > 0.15 && (input.handbrake || input.brake > 0.5)) {
          const av = this.body.angvel();
          this.body.setAngvel({ x: av.x, y: av.y + steerIn * A.flick * Math.min(1, this.speed / 14), z: av.z }, true);
        }
      }
    } else {
      this.driftTime += dt;
      this.driftCalm = Math.abs(slip) < 0.11 && !input.handbrake ? this.driftCalm + dt : 0;
      if (this.driftCalm > 0.25 || this.speed < 3.5 || gear === "R") this.drift = false;
    }
    const drift = this.drift;
    this.driftAmount = T.MathUtils.damp(this.driftAmount || 0, drift ? Math.min(1, Math.abs(slip) / 0.5) : 0, 10, dt);
    // Steering: quick rack, generous lock that tightens with speed.
    const maxAngle = T.MathUtils.lerp(A.lockLow, A.lockHigh, Math.min(speedAbs / 38, 1) ** 0.8),
      steerTarget = -input.steer * maxAngle;
    this.steer = T.MathUtils.damp(this.steer, steerTarget, Math.abs(steerTarget) < Math.abs(this.steer) ? A.steerReturn : A.steerRate, dt);
    this.throttle = T.MathUtils.damp(this.throttle, driving ? input.throttle : 0, A.pedal, dt);
    this.brake = T.MathUtils.damp(this.brake, gear === "P" ? 1 : input.brake, 18, dt);
    this.boost = !!input.boost && ignition;
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.driveGear = 1; // single-speed reduction gear: no shifts, ever
    this.rpm = ignition ? Math.min(14000, 800 + (speedAbs / 0.517) * 9.7 * 9.549 + this.throttle * 400) : 0;
    // EV traction: flat torque off the line, then constant power.
    const reverse = gear === "R",
      driveSign = reverse ? -1 : 1,
      limit = reverse ? A.reverseTop : this.boost ? A.boostTop : A.top,
      peak = reverse ? A.reverseForce : this.boost ? A.boostForce : A.force,
      power = this.boost ? A.boostPower : A.power,
      available = (driving ? 1 : 0) * this.power,
      tractive = Math.min(peak, power / Math.max(speedAbs, 0.1)),
      taper = T.MathUtils.clamp((limit - speedAbs) / 5, 0, 1),
      force = available * tractive * this.throttle * driveSign * taper;
    // Launch: tyres light up for a moment when the pedal is floored from low speed.
    if (driving && input.throttle > 0.8 && speedAbs < 6 && !this.launching && (this.lastThrottle || 0) < 0.3) this.launching = 0.7;
    this.launching = Math.max(0, (this.launching || 0) - dt);
    if (input.throttle < 0.3) this.launching = 0;
    this.lastThrottle = input.throttle;
    this.launch = this.launching > 0 ? Math.min(1, this.launching / 0.35) * Math.max(0, 1 - speedAbs / 14) : 0;
    const counter = drift ? T.MathUtils.clamp(slip * A.counterSteer, -0.5, 0.5) : 0;
    let grounded = 0;
    for (let i = 0; i < 4; i++) {
      const inner = i === 0 ? 1 : -1,
        front = i < 2,
        enabled = this.wheelEnabled[i];
      let a = front ? this.steer : 0;
      if (front && Math.abs(a) > 0.001) a = Math.atan(3.49 / (3.49 / Math.tan(a) + inner * 1.028));
      if (front) a = T.MathUtils.clamp(a + counter, -0.75, 0.75);
      a += this.wheelDamage[i] * 0.13 * (i % 2 ? 1 : -1);
      this.car.setWheelSteering(i, a);
      // Dual motor: a rear bias that still pulls hard off the line.
      const share = front ? A.frontShare / 2 : (1 - A.frontShare) / 2,
        roll = Math.sign(this.speed) * Math.min(speedAbs * 60, 160);
      this.car.setWheelEngineForce(i, enabled ? force * share - roll / 4 : 0);
      this.car.setWheelBrake(
        i,
        enabled ? (gear === "P" ? 220 : this.brake * (front ? A.brakeFront : A.brakeRear)) + (input.handbrake && !front ? 200 : 0) : 0,
      );
      const rearLoose = !front && (drift || input.handbrake);
      this.car.setWheelFrictionSlip(
        i,
        enabled ? (rearLoose ? (input.handbrake ? 0.7 : A.driftSlip) : A.grip) * (1 - this.wheelDamage[i] * 0.4) : 0.01,
      );
      this.car.setWheelSideFrictionStiffness(i, enabled ? (rearLoose ? (input.handbrake ? 0.22 : A.driftSide) : front && drift ? A.driftFrontSide : A.side) : 0);
      if (enabled && this.car.wheelIsInContact(i)) grounded++;
    }
    // Aero drag.
    _tmp.copy(forward).multiplyScalar(-Math.sign(this.speed) * 0.75 * this.speed * this.speed * dt);
    this.body.applyImpulse(_tmp, true);
    if (onGround) {
      // Launch assist: extra shove at low speed so the van leaps away.
      if (driving && this.throttle > 0.05 && speedAbs < A.assistTop) {
        const k = this.mass * A.launchAssist * this.throttle * (1 - speedAbs / A.assistTop) * this.power * dt * driveSign;
        this.body.applyImpulse({ x: forward.x * k, y: 0, z: forward.z * k }, true);
      }
      // Brake assist: hauls the van down hard without locking anything.
      const braking = this.brake > 0.05 && ((gear === "D" && this.speed > 0.3) || (reverse && this.speed < -0.3) || gear === "N");
      if (braking && speedAbs > 0.3) {
        const dvb = Math.min(speedAbs, A.brakeAssist * this.brake * dt);
        this.body.applyImpulse({ x: (-vel.x / vh || 0) * dvb * this.mass, y: 0, z: (-vel.z / vh || 0) * dvb * this.mass }, true);
      }
      // Drift drive: the throttle pushes along the slide so it holds its speed.
      if (drift && driving && !reverse && vh > 1 && this.speed < A.driftTop) {
        const k = this.mass * A.driftThrust * this.throttle * this.power * dt / vh;
        this.body.applyImpulse({ x: vel.x * k, y: 0, z: vel.z * k }, true);
      }
      // Arcade yaw and grip: steer the yaw rate directly, and swing the velocity
      // toward the heading. Gripping, that swing is quick; drifting, it is lazy,
      // which is what holds the slide.
      const av = this.body.angvel();
      let wy = av.y;
      if (speedAbs > 0.8) {
        if (drift) {
          const target = (steerIn * A.driftYaw + slip * 0.35) * Math.min(1, this.speed / 10);
          wy = T.MathUtils.damp(wy, target, A.driftYawRate, dt);
        } else {
          const cap = A.maxLateral / Math.max(speedAbs, 1),
            target = T.MathUtils.clamp((this.speed / 3.49) * Math.tan(this.steer) * A.yawGain, -cap, cap);
          wy = T.MathUtils.damp(wy, target, A.yawRate * Math.min(1, speedAbs / 6), dt);
        }
      }
      // Self-righting: keeps the tall van planted through hard direction changes.
      const up = _tmp2.set(0, 1, 0).applyQuaternion(q),
        rx = -up.z,
        rz = up.x,
        kr = A.antiRoll * dt;
      this.body.setAngvel({ x: (av.x + rx * kr) * (1 - 2.5 * dt), y: wy, z: (av.z + rz * kr) * (1 - 2.5 * dt) }, true);
      let k = drift ? A.driftAlign + (1 - this.throttle) * 1.6 - (input.handbrake ? 1.4 : 0) : A.gripAlign;
      if (Math.abs(slip) > 1.05) k += 6; // stop a full spin
      k = Math.max(0.4, k);
      if (vh > 0.8 && Math.abs(slip) < 2) {
        // Read back: the assists above already changed the velocity this step.
        const lv = this.body.linvel(),
          loss = drift ? 1 - A.driftDrag * dt : 1,
          d = slip - slip * Math.exp(-k * dt),
          c = Math.cos(-d),
          sn = Math.sin(-d),
          nx = (lv.x * c + lv.z * sn) * loss,
          nz = (-lv.x * sn + lv.z * c) * loss;
        this.body.setLinvel({ x: nx, y: lv.y, z: nz }, true);
      }
    } else if (this.grounded === 0) {
      // Airborne: settle gently level so landings stay drivable.
      const av = this.body.angvel(),
        up = _tmp2.set(0, 1, 0).applyQuaternion(q),
        kr = A.airRight * dt;
      this.body.setAngvel({ x: av.x - up.z * kr, y: av.y + steerIn * 1.2 * dt, z: av.z + up.x * kr }, true);
    }
    if (this.grab) {
      const b = this.body.translation(),
        bp = _bp.set(b.x, b.y, b.z),
        point = _tmp.copy(this.grab.local).applyQuaternion(q).add(bp),
        a = this.body.angvel(),
        at = _tmp2.copy(point).sub(bp),
        vpoint = _av.set(a.x, a.y, a.z).cross(at).add(vel),
        force = this.grab.target.clone().sub(point).multiplyScalar(65000).addScaledVector(vpoint, -5500);
      force.y += this.mass * 9.81;
      force.clampLength(0, 100000);
      this.body.applyImpulseAtPoint(force.multiplyScalar(dt), point, true);
    }
    this.car.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    this.beforeStep?.(dt);
    this.world.step(this.events);
    this.collectContacts(dt);
    this.grounded = 0;
    for (let i = 0; i < 4; i++) {
      if (this.wheelEnabled[i] && this.car.wheelIsInContact(i)) this.grounded++;
      this.wheelSpin[i] = (this.car.wheelRotation(i) ?? 0) - this.wheelOffset[i];
      this.suspension[i] = 0.3 - (this.car.wheelSuspensionLength(i) ?? 0.3);
    }
    this.measureSlip(dt);
    this.soft?.step(dt);
    this.distance += this.speed * dt;
    this.impact = Math.max(this.impact * 0.93, Math.abs(vel.y - this.lastVy));
    this.lastVy = vel.y;
  }
  // Tyre slip for audio and effects: lateral slide at each contact patch, plus
  // longitudinal slip from wheel surface speed against ground speed (lockups,
  // wheelspin). Also tracks how violently the suspension is compressing.
  measureSlip(dt) {
    const rr = this.body.rotation(),
      q = _qs.set(rr.x, rr.y, rr.z, rr.w),
      lv = this.body.linvel(),
      av = this.body.angvel(),
      w = _s1.set(av.x, av.y, av.z);
    let skid = 0,
      bump = 0,
      activity = 0;
    for (let i = 0; i < 4; i++) {
      const rate = (this.suspension[i] - this.suspensionPrev[i]) / dt;
      bump = Math.max(bump, rate);
      activity += Math.abs(rate);
      if (!this.wheelEnabled[i] || !this.car.wheelIsInContact(i)) continue;
      const wh = this.wheels[i],
        r = _s2.set(wh[1], -0.45, wh[2]).applyQuaternion(q),
        vp = _s3.copy(w).cross(r).add(_s5.set(lv.x, lv.y, lv.z)),
        a = this.car.wheelSteering(i) ?? 0,
        fwd = _s4.set(-Math.cos(a), 0, Math.sin(a)).applyQuaternion(q),
        ground = vp.dot(fwd),
        side = vp.addScaledVector(fwd, -ground).setY(0).length(),
        surface = Math.abs(((this.wheelSpin[i] - this.wheelSpinPrev[i]) / dt) * 0.517),
        longitudinal = Math.abs(surface - Math.abs(ground));
      skid = Math.max(skid, side, longitudinal * 0.85);
    }
    skid = Math.max(skid, (this.launch || 0) * 5);
    this.skid = T.MathUtils.damp(this.skid || 0, skid, 18, dt);
    this.bump = Math.max((this.bump || 0) * Math.exp(-8 * dt), bump);
    this.suspensionActivity = T.MathUtils.damp(this.suspensionActivity || 0, activity / 4, 6, dt);
  }
  // Every chassis contact above the event threshold feeds the soft-body lattice
  // with the velocity change it caused, at each solver contact point. The
  // strongest event per step still drives sound, notices and impact stats.
  collectContacts(dt) {
    let strongest = null;
    const b = this.body.translation(),
      r = this.body.rotation(),
      bodyPos = _bp.set(b.x, b.y, b.z),
      inv = _q.set(r.x, r.y, r.z, r.w).invert(),
      soft = this.soft,
      center = _tmp2;
    this.events.drainContactForceEvents((e) => {
      const h1 = e.collider1(),
        h2 = e.collider2();
      if (h1 !== this.chassis.handle && h2 !== this.chassis.handle) return;
      const magnitude = e.totalForceMagnitude(),
        dv = (magnitude * dt) / this.mass,
        other = this.world.getCollider(h1 === this.chassis.handle ? h2 : h1);
      const points = [];
      let normal = null;
      this.world.contactPair(this.chassis, other, (m) => {
        const n = m.numSolverContacts();
        if (!n) return;
        const nn = m.normal();
        normal = { x: nn.x, y: nn.y, z: nn.z };
        for (let i = 0; i < n; i++) {
          const p = m.solverContactPoint(i);
          points.push({ x: p.x, y: p.y, z: p.z });
        }
      });
      if (soft && points.length) {
        center.set(-0.07, 0.9, 0);
        const local = points.map((p) => new T.Vector3(p.x, p.y, p.z).sub(bodyPos).applyQuaternion(inv)),
          mid = local.reduce((a, p) => a.add(p), new T.Vector3()).multiplyScalar(1 / local.length),
          dir = normal
            ? new T.Vector3(normal.x, normal.y, normal.z).applyQuaternion(inv)
            : center.clone().sub(mid);
        // Point the push into the body, whichever way the manifold normal faces.
        if (dir.dot(_tmp.copy(center).sub(mid)) < 0) dir.negate();
        dir.normalize();
        soft.impact(local, dir, dv, this.elapsed);
      }
      const severity = dv;
      if (severity < 0.7 || (strongest && severity < strongest.severity)) return;
      strongest = {
        severity,
        force: magnitude,
        point: points[0] || null,
        direction: { ...e.maxForceDirection() },
        speed: Math.abs(this.speed),
        time: this.elapsed,
      };
    });
    if (strongest && this.elapsed - this.lastContact > 0.12) {
      this.impacts.push(strongest);
      this.lastContact = this.elapsed;
    }
  }
  consumeImpacts() {
    return this.impacts.splice(0);
  }
  // Interpolated pose for rendering. Gameplay logic keeps reading the body directly.
  state() {
    const s = this._state,
      a = this.alpha,
      t = this.vehicleTrack;
    s.position.lerpVectors(t.p0, t.p1, a);
    s.rotation.slerpQuaternions(t.q0, t.q1, a);
    s.speed = this.speed;
    s.steer = this.steer;
    s.grounded = this.grounded;
    for (let i = 0; i < 4; i++) {
      s.suspension[i] = T.MathUtils.lerp(this.suspensionPrev[i], this.suspension[i], a);
      s.spin[i] = T.MathUtils.lerp(this.wheelSpinPrev[i], this.wheelSpin[i], a);
    }
    s.rpm = this.rpm;
    s.driveGear = this.driveGear;
    s.drift = this.driftAmount;
    s.slip = this.slipAngle;
    return s;
  }
}
