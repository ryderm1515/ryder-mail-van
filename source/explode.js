import * as T from "three";

// Exploded-view layout for the van.
//
// Every named object in the model (each mesh range) becomes a "part" with an
// offset in body space and a start delay. Parts are grouped into systems so
// the explosion reads like a technical illustration: the shell lifts off, the
// front clip pulls forward, doors swing wide, wheels slide out with their hubs
// and lug nuts stacked beyond them, the running gear drops, and the cab and
// cargo fit-out rise out of the open body. Fasteners trail their system.
//
// The vertex shader (deform.js) reads offsets from a float texture indexed by
// a per-vertex part id, so the whole thing animates on the GPU.

const SYSTEMS = [
  // name, test(object, bone), offset(center c, part p) in body space, delay
  ["Roof", (o) => /roof|drip rail|Roof extrusion|Arched roof crossmember/i.test(o), (c, p) => new T.Vector3(0, 2.6, 0), 0.0],
  ["Body shell", (o) => /^Cargo shell|insulated wall|Cargo horizontal stamping|Hat rib|Cargo skin|Sculpted A pillar|windshield header|Rear door perimeter/i.test(o), (c, p) => new T.Vector3(0, 1.75, Math.sign(p.z) * 0.15), 0.05],
  ["Glass", (o, b) => /glazing|windshield|Windshield|glass/i.test(o) || /^WINDOW_/.test(b), (c, p) => new T.Vector3(-0.9, 1.1, p.z * 0.6), 0.12],
  ["Front clip", (o) => /fascia|front impact bumper|Bumper|Grille|projector|Headlamp|headlight|Corner turn signal|clearance light|plate pocket|front quarter panel|Indicator lens/i.test(o), (c, p) => new T.Vector3(-1.9, 0.15, p.z * 0.55), 0.1],
  ["Hood", (o, b) => /^HOOD/.test(b), () => new T.Vector3(-1.1, 1.5, 0), 0.12],
  ["Doors", (o, b) => /^DOOR_/.test(b), (c, p) => new T.Vector3(0.1, 0.15, Math.sign(p.z || 1) * 1.7), 0.16],
  ["Mirrors", (o, b) => /^MIRROR/.test(b), (c, p) => new T.Vector3(-0.2, 0.45, Math.sign(p.z || 1) * 2.3), 0.18],
  ["Rear", (o, b) => /^(REAR_DOOR|MCH_SLAT|SHUTTER)/.test(b) || /Rear step|Rear lamp|Rear lens|Rear side marker|High brake|Rear camera|lower rear cladding|Step grip|Step recess|shutter|Torsion|Shutter/i.test(o), (c, p) => new T.Vector3(1.9, 0.25, p.z * 0.4), 0.12],
  ["Arches", (o) => /arch|flare|wheel housing|mud flap|Wheel housing/i.test(o), (c, p) => new T.Vector3(0, 0.1, Math.sign(p.z || 1) * 0.95), 0.2],
  ["Steps", (o) => /running step/i.test(o), (c, p) => new T.Vector3(0, -0.35, Math.sign(p.z || 1) * 1.0), 0.22],
  ["Lug nuts", (o, b) => /^LUG_/.test(b), (c, p) => new T.Vector3(0, 0, Math.sign(p.z || 1) * 2.9), 0.36],
  ["Hubcaps", (o, b) => /^HUBCAP/.test(b), (c, p) => new T.Vector3(0, 0, Math.sign(p.z || 1) * 2.35), 0.32],
  ["Wheels", (o, b) => /^(WHEEL_|MCH_SPIN)/.test(b), (c, p) => new T.Vector3(0, 0, Math.sign(p.z || 1) * 1.65), 0.26],
  ["Running gear", (o, b) => /^(MCH_AXLE|MCH_DAMPER|MCH_STEER)/.test(b) || /Leaf spring/i.test(o), (c, p) => new T.Vector3(0, -1.05, Math.sign(p.z || 0) * 0.25), 0.4],
  ["Power unit", (o, b) => /^(COOLING_FAN|FLUID_CAP|FUSE|HOOD_LATCH)/.test(b) || /Power unit|Battery|Radiator|Cooling fan|reservoir|Reservoir|Service|fuse|Fuse|wiring|hose|Engine bay|harness|Harness|loom/i.test(o), (c, p) => new T.Vector3(-1.5, 1.05, p.z * 0.6), 0.3],
  ["Cab", (o, b) => /^(DRIVER_SEAT|SEAT_|HEADREST|RECLINE|STEERING|PEDAL|GAUGE|HVAC|VISOR|GLOVEBOX|AIR_VENT|CONSOLE|AUX_SWITCH|RADIO|INDICATOR|HAZARD|BELT|SEATBELT|MCH_BELT|WIPER)/.test(b) || /Dashboard|dashboard|Instrument|display|Air vent|Cup holder|binnacle|radio|console|Steering|Seat|seat belt|belt|grab|Cab lamp|overhead|document|demister/i.test(o), (c, p) => new T.Vector3(-0.25, 1.15, p.z * 0.35), 0.34],
  ["Cargo fit-out", (o, b) => /^(SHELF|PARTITION|MCH_PARTITION|TIE_DOWN|SORTING|EXTINGUISHER)/.test(b) || /Cargo rubber floor|Load rail|tie-down|Bulkhead|Partition|Cargo LED|Cargo prismatic|Slotted load|Extinguisher|Cargo wall grab|Sorting/i.test(o), (c, p) => new T.Vector3(0.35 * Math.sign(p.x - 0.8), 0.85, p.z * 0.5), 0.42],
  ["Floor", (o) => /floor|Floor|threshold|Threshold|Cab floor|mat|deck|Deck/i.test(o), (c, p) => new T.Vector3(0, -0.15, 0), 0.5],
];
const FASTENER = /hex head|washer|rivet|screw|bolt|fixing|Fixing|clip|P-clip|bearing bracket/i;

export function buildExplode(rig, vehicle, field) {
  vehicle.updateMatrixWorld(true);
  rig.root.updateMatrixWorld(true);
  const toBody = new T.Matrix4(),
    bodyInv = vehicle.matrixWorld.clone().invert(),
    p = new T.Vector3(),
    parts = [{ name: "none", system: null }];
  const counts = {};
  for (let mi = 0; mi < rig.meshes.length; mi++) {
    const m = rig.meshes[mi],
      spec = rig.data.meshes[mi],
      pos = m.geometry.attributes.position,
      ids = new Uint16Array(pos.count),
      ranges = spec.ranges?.length ? spec.ranges : [{ object: spec.objects?.[0] || spec.bone, start: 0, count: pos.count }];
    toBody.multiplyMatrices(bodyInv, m.matrixWorld);
    for (const r of ranges) {
      // Centroid of this object in body space (rest pose).
      const c = new T.Vector3();
      const step = Math.max(1, Math.floor(r.count / 400));
      let n = 0;
      for (let i = r.start; i < r.start + r.count; i += step) {
        c.add(p.fromBufferAttribute(pos, i).applyMatrix4(toBody));
        n++;
      }
      c.multiplyScalar(1 / Math.max(1, n));
      const id = parts.length;
      if (id >= 65535) break;
      parts.push({ name: r.object, bone: spec.bone, center: c });
      ids.fill(id, r.start, r.start + r.count);
    }
    m.geometry.setAttribute("aPart", new T.BufferAttribute(ids, 1));
  }
  // Body centre and per-system centres so parts within a system also fan apart.
  const center = new T.Vector3();
  for (let i = 1; i < parts.length; i++) center.add(parts[i].center);
  center.multiplyScalar(1 / (parts.length - 1));
  const data = new Float32Array(parts.length * 4);
  const systemCenters = {};
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i],
      name = part.name.replace(/\.\d+$/, ""),
      sys = SYSTEMS.find(([, test]) => test(name, part.bone));
    part.system = sys ? sys[0] : "Structure";
    part.fastener = FASTENER.test(name);
    (systemCenters[part.system] ||= { c: new T.Vector3(), n: 0 }).c.add(part.center);
    systemCenters[part.system].n++;
  }
  for (const k in systemCenters) systemCenters[k].c.multiplyScalar(1 / systemCenters[k].n);
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i],
      rel = part.center.clone().sub(center),
      sys = SYSTEMS.find(([n]) => n === part.system);
    let offset, delay;
    if (sys) {
      offset = sys[2](center, rel);
      delay = sys[3];
      // Spread parts within a system away from that system's centre.
      offset.addScaledVector(part.center.clone().sub(systemCenters[part.system].c), 0.22);
    } else {
      // Anything unclassified moves radially, flattened so it stays readable.
      offset = rel.clone().multiply(new T.Vector3(0.35, 0.25, 0.55));
      delay = 0.24;
    }
    if (part.fastener) {
      // Fasteners float a little beyond their system, slightly later.
      offset.multiplyScalar(1.18).add(rel.clone().normalize().multiplyScalar(0.18));
      delay += 0.07;
    }
    delay += Math.random() * 0.05;
    counts[part.system] = (counts[part.system] || 0) + 1;
    data.set([offset.x, offset.y, offset.z, Math.min(0.55, delay)], i * 4);
  }
  field.setExplodeData(data, parts.length);
  return { parts, counts };
}
