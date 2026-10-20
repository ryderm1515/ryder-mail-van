import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VehicleRig } from "./rig.js";
import { DrivingPhysics, RAPIER } from "./physics.js";
import { VehicleAudio } from "./audio.js";
import { createUI } from "./ui.js";
import { TestWorld, ZONES } from "./world.js";
import { VehicleDamage } from "./damage.js";
import { enhanceExperience } from "./experience.js";
import { DirectInteraction } from "./direct.js";
import { SkidMarks } from "./skidmarks.js";
import { Dashboard } from "./dash.js";
import { Showcase } from "./showcase.js";
import { Town } from "./town.js";
import { Film } from "./film.js";
import { Ambience } from "./ambience.js";
import { TourMusic } from "./music.js";
import { Packages } from "./packages.js";
import { Highway } from "./highway/index.js";
const $ = (id) => document.getElementById(id),
  reduced = matchMedia("(prefers-reduced-motion: reduce)"),
  darkPreference = matchMedia("(prefers-color-scheme: dark)");
const audio = new VehicleAudio();
// Cab field of view: same hover slider, on the camera button.
{
  try {
    const f = parseFloat(localStorage.getItem("van-fov"));
    if (f >= 50 && f <= 110) cabFov = f;
  } catch {}
  const attach = () => {
    const btn = document.getElementById("camera");
    if (!btn || btn.parentElement.classList.contains("vol-wrap")) return !!btn;
    const wrap = document.createElement("span");
    wrap.className = "vol-wrap";
    btn.replaceWith(wrap);
    wrap.append(btn);
    const pop = document.createElement("div");
    pop.className = "vol-pop surface fov-pop";
    pop.innerHTML = '<input type="range" min="50" max="110" step="1" aria-label="First-person field of view"><span class="fov-label"></span>';
    wrap.append(pop);
    const range = pop.querySelector("input"),
      label = pop.querySelector(".fov-label");
    const paint = () => {
      range.style.setProperty("--v", ((range.value - 50) / 60) * 100 + "%");
      label.textContent = range.value + "°";
    };
    range.value = cabFov;
    paint();
    range.addEventListener("input", () => {
      cabFov = +range.value;
      try {
        localStorage.setItem("van-fov", String(cabFov));
      } catch {}
      paint();
    });
    range.addEventListener("keydown", (e) => e.stopPropagation());
    return true;
  };
  if (!attach()) addEventListener("DOMContentLoaded", attach, { once: true });
  setTimeout(attach, 1500);
}
// Discreet volume: a thin slider that slides out above the sound button on hover.
{
  const btn = document.getElementById("sound");
  if (btn) {
    const wrap = document.createElement("span");
    wrap.className = "vol-wrap";
    btn.replaceWith(wrap);
    wrap.append(btn);
    const pop = document.createElement("div");
    pop.className = "vol-pop surface";
    pop.innerHTML = '<input type="range" min="0" max="100" step="1" aria-label="Volume">';
    wrap.append(pop);
    const range = pop.querySelector("input");
    range.value = Math.round(audio.volume * 100);
    const paint = () => range.style.setProperty("--v", range.value + "%");
    paint();
    range.addEventListener("input", () => {
      audio.setVolume(range.value / 100);
      paint();
    });
    range.addEventListener("keydown", (e) => e.stopPropagation());
  }
}
let renderer;
try {
  // alpha: the driver display glass punches through to the live DOM layer behind the canvas.
  renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
} catch (e) {
  $("loading-label").textContent = "WebGL is unavailable. Enable hardware acceleration and reload.";
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = T.SRGBColorSpace;
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.16;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFShadowMap;
renderer.domElement.setAttribute(
  "aria-label",
  "Driving playground. W accelerates, S brakes, A and D steer. Press question mark for all controls.",
);
renderer.domElement.tabIndex = 0;
$("stage").append(renderer.domElement);
const scene = new T.Scene();
scene.background = new T.Color("#d7d9d7");
scene.fog = new T.Fog("#d7d9d7", 180, 430);
const worldVehicle = new T.Group();
scene.add(worldVehicle);
const hemi = new T.HemisphereLight(0xf7f9f4, 0x777d79, 2.1);
scene.add(hemi);
const sun = new T.DirectionalLight(0xfff9ed, 2.3);
sun.position.set(-14, 22, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 0.5, far: 65 });
sun.shadow.bias = -0.000055;
sun.shadow.normalBias = 0.024;
sun.shadow.radius = 1;
scene.add(sun, sun.target);
const sunOffset = new T.Vector3(-14, 22, 9),
  sunRotation = new T.Quaternion().setFromRotationMatrix(
    new T.Matrix4().lookAt(sunOffset, new T.Vector3(), new T.Vector3(0, 1, 0)),
  ),
  sunInverse = sunRotation.clone().invert(),
  shadowTexel = 18 / 4096;
const fill = new T.DirectionalLight(0xe3eef5, 0.8);
fill.position.set(5, 9, -10);
scene.add(fill);
function toon(m) {
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      "#include <gradientmap_pars_fragment>",
      `vec3 getGradientIrradiance(vec3 normal,vec3 lightDirection){float v=dot(normal,lightDirection)*.5+.5;float e=max(fwidth(v)*.8,.0001);return vec3(.32+.33*smoothstep(.38-e,.38+e,v)+.35*smoothstep(.72-e,.72+e,v));}`,
    );
  };
  m.customProgramCacheKey = () => "clean-toon-v2";
  return m;
}
function material(d) {
  const c = new T.Color().fromArray(d.color);
  let m;
  if (/glazing/i.test(d.name)) {
    m = new T.MeshPhysicalMaterial({
      color: 0xf5fafb,
      metalness: 0,
      roughness: 0.07,
      transparent: true,
      opacity: 0.19,
      depthWrite: false,
      side: T.DoubleSide,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
    });
  } else {
    m = toon(new T.MeshToonMaterial({ color: c }));
    // The source model's skins are single-sided: from inside the cab (door
    // open, walk-in shots) their back faces vanished and you could see into
    // the panels. Draw both faces; shadows keep the old single-sided casting.
    m.side = T.DoubleSide;
    m.shadowSide = T.BackSide;
  }
  m.userData.source = d.name;
  m.userData.data = d;
  if (d.name.startsWith("ANIM LIGHT")) {
    m.emissive.copy(c);
    m.emissiveIntensity = 0;
  }
  return m;
}
// Undeformed twin of a vehicle material, for wheels and for detached debris
// (debris carries its damage baked into its own geometry).
const plainCache = new Map();
function plainMaterial(m) {
  if (!m.userData.data) return m;
  if (!plainCache.has(m)) plainCache.set(m, material(m.userData.data));
  return plainCache.get(m);
}
// Blue baseplate, muted to sit with the sage and warm-grey palette.
const BASE_LIGHT = 0x9fb6c8,
  BASE_DARK = 0x3b4d5c;
const floorMat = new T.MeshStandardMaterial({ color: BASE_LIGHT, roughness: 1 });
// x: 1 m lines, y: 5 m lines. Light mode needs more contrast to read speed.
const gridStrength = { value: new T.Vector2(0.15, 0.27) };
floorMat.onBeforeCompile = (s) => {
  s.uniforms.uGrid = gridStrength;
  s.vertexShader = s.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vFloor;")
    .replace(
      "#include <worldpos_vertex>",
      "#include <worldpos_vertex>\nvFloor=(modelMatrix*vec4(transformed,1.)).xyz;",
    );
  s.fragmentShader = s.fragmentShader.replace(
    "#include <common>",
    "#include <common>\nvarying vec3 vFloor;\nuniform vec2 uGrid;",
  );
  s.fragmentShader = s.fragmentShader.replace(
    "#include <color_fragment>",
    `#include <color_fragment>
vec2 p=vFloor.xz;vec2 fw=max(fwidth(p),vec2(.001));vec2 g=abs(fract(p-.5)-.5)/fw;float line=1.-min(min(g.x,g.y),1.);vec2 h=abs(fract(p/5.-.5)-.5)/(fw/5.);float major=1.-min(min(h.x,h.y),1.);float grain=fract(sin(dot(floor(p*180.),vec2(12.9898,78.233)))*43758.5453);diffuseColor.rgb*=1.-uGrid.x*line-uGrid.y*major+(grain-.5)*.018;`,
  );
};
const floor = new T.Mesh(new T.PlaneGeometry(700, 700), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const ortho = new T.OrthographicCamera(-10, 10, 10, -10, 0.1, 700),
  persp = new T.PerspectiveCamera(47, innerWidth / innerHeight, 0.04, 700);
let camera = ortho,
  camMode = 0,
  zoom = 1,
  zoomTarget = 1,
  camInit = false,
  projectionStart = null,
  projectionBlend = 1,
  orbitMotion = null;
// Follow-camera state. Chase works like a modern open-world driving camera:
// it trails the direction of travel with a lag, shows drift angle, pulls back
// and widens with speed, can be dragged around the van and recenters itself.
const rigCam = {
  heading: null,
  userYaw: 0,
  userPitch: 0,
  isoYaw: 0,
  idle: 0,
  dragging: false,
  id: null,
  x: 0,
  y: 0,
  dist: 7.4,
  distTarget: 7.4,
  fov: 52,
  focusY: null,
  shake: 0,
  lastVehicle: null,
  ray: null,
};
const cameraNames = ["isometric", "chase", "cab", "cargo", "orbit"],
  cameraIcons = ["cube", "car", "steering-wheel", "package", "arrows-move"];
const orbit = new OrbitControls(persp, renderer.domElement);
orbit.enabled = false;
orbit.enableDamping = true;
orbit.dampingFactor = 0.085;
orbit.minDistance = 0.15;
orbit.maxDistance = 40;
orbit.maxPolarAngle = Math.PI * 0.91;
orbit.zoomSpeed = 0.65;
orbit.panSpeed = 0.6;
orbit.addEventListener("start", () => {
  orbitMotion = null;
});
const keys = new Set(),
  touch = { left: false, right: false, throttle: false, brake: false };
let soundChosen = false;
let packages = null,
  highway = null,
  highwayLoading = false,
  cabFov = 72,
  mirrorCam = null,
  mirrorFrame = 0,
  lastFwd = 0;
let autoGearHold = 0;
let gear = "P",
  ignition = false,
  signal = 0,
  hazards = false,
  lights = false,
  wipers = false,
  wiperCycles = 0,
  fanTurns = 0,
  time = 0,
  lastTime = 0,
  ui,
  rig,
  physics,
  testWorld,
  damage,
  experience,
  direct,
  courseOn = false,
  dash,
  skids,
  showcase,
  film,
  dashPrev = 2,
  dashBlend = 1,
  dashFrom = null,
  dashLeaving = false,
  completed = new Set(),
  holdDelivery = 0,
  lastDelivery = -1,
  themeDark = false,
  inspecting = false,
  flash = 0,
  signalSteered = false;
const input = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false };
const windowLast = {},
  windowMoving = {};
// Driver's-seat free look: drag to turn your head around the cab.
const head = { yaw: 0, pitch: 0, dragging: false, idle: 0, id: null, x: 0, y: 0 };
const pads = [],
  propMeshes = [],
  headlights = [];
const V = new T.Vector3(),
  Q = new T.Quaternion();
function auto(b, k, v) {
  if (!rig.overrides.has(b + "|" + k)) rig.set(b, k, v);
}
function toggle(id, v) {
  ui.press(id, v);
  audio.event("click");
}
function setGear(g) {
  if (Math.abs(physics.speed) > 0.65 && g !== gear) {
    ui.toast("Brake to a stop before changing gear");
    return;
  }
  if (g === "D" || g === "R") {
    const unsafe = rig.controls.some(
      (c) =>
        (/^(DOOR_[LR]|HOOD|REAR_DOOR)$/.test(c.bone) &&
          c.name === "Open" &&
          Math.max(rig.targets[c.id], rig.values[c.id]) > 0.03) ||
        (/WHEEL|HUBCAP/.test(c.bone) &&
          c.name === "Remove" &&
          Math.max(rig.targets[c.id], rig.values[c.id]) > 0.03),
    );
    if (unsafe) {
      ui.toast("Close doors and hood, and refit wheels before driving");
      return;
    }
  }
  gear = g;
  ui.gear(g);
  audio.event("gear");
  if ((g === "D" || g === "R") && inspecting) ui.setPanel(false);
  if (g === "R") ui.toast("Reverse selected");
}
function changeCamera(mode) {
  const previous = camera;
  projectionStart = previous.projectionMatrix.clone();
  projectionBlend = reduced.matches ? 1 : 0;
  camMode = mode;
  camera = camMode === 0 ? ortho : persp;
  rigCam.heading = null;
  rigCam.focusY = null;
  rigCam.userYaw = rigCam.userPitch = 0;
  if (previous !== camera) {
    camera.position.copy(previous.position);
    camera.quaternion.copy(previous.quaternion);
  }
  orbit.enabled = camMode === 4 && !direct?.hand;
  if (orbit.enabled) {
    const to = worldVehicle.position.clone().add(new T.Vector3(-7, 4.4, 7)),
      target = worldVehicle.position.clone().add(new T.Vector3(0, 0.65, 0));
    orbit.target.copy(worldVehicle.position).add(new T.Vector3(0, 0.65, 0));
    orbitMotion = { from: camera.position.clone(), fromTarget: orbit.target.clone(), to, target, time: 0 };
  }
  ui.camera(cameraNames[camMode], cameraIcons[camMode]);
  resize();
}
function focusBone(name) {
  changeCamera(4);
  rig.root.updateMatrixWorld(true);
  const b = rig.bones[name];
  b.pose.getWorldPosition(V);
  orbit.target.copy(V);
  let offset = new T.Vector3(-1.3, 0.7, 1.5);
  if (/REAR|SHUTTER/.test(name)) offset.set(3, 1, 1);
  if (/SHELF|PARTITION|TIE|TRAY/.test(name)) offset.set(1.2, 0.3, 0);
  if (/GAUGE|PEDAL|HVAC|RADIO|STEERING|SEAT|VENT|BUTTON|VISOR|BELT/.test(name)) offset.set(1.1, 0.4, 0);
  offset.applyQuaternion(worldVehicle.quaternion);
  orbitMotion = {
    from: persp.position.clone(),
    fromTarget: orbit.target.clone(),
    to: V.clone().add(offset),
    target: V.clone(),
    time: 0,
  };
}
function setTheme(d) {
  themeDark = d;
  document.documentElement.classList.toggle("dark", d);
  scene.background.set(d ? "#333b3b" : "#d7d9d7");
  scene.fog.color.copy(scene.background);
  floorMat.color.set(d ? BASE_DARK : BASE_LIGHT);
  skids?.setTheme(d);
  gridStrength.value.set(d ? 0.05 : 0.15, d ? 0.11 : 0.27);
  hemi.intensity = d ? 0.65 : 2.1;
  sun.intensity = d ? 0.85 : 2.3;
  fill.intensity = d ? 0.25 : 0.8;
  ui?.icon("theme", d ? "moon" : "sun");
}
const actions = {
  power() {
    ignition = !ignition;
    ui.engine(ignition);
    audio.unlock().then(async () => {
      if (!soundChosen) {
        soundChosen = true;
        const on = await audio.toggle();
        ui.press("sound", on);
        ui.icon("sound", on ? "volume" : "volume-off");
        $("sound").setAttribute("aria-label", "Mute sound");
      }
      audio.event(ignition ? "start" : "gear");
    });
    if (ignition && gear === "P") ui.toast("Ready. Select D to drive.");
  },
  gear: setGear,
  theme() {
    setTheme(!themeDark);
  },
  camera() {
    changeCamera((camMode + 1) % 5);
  },
  left() {
    signal = signal === -1 ? 0 : -1;
    hazards = false;
    signalSteered = false;
    ui.press("left", signal === -1);
    ui.press("right", signal === 1);
    ui.press("hazards", false);
  },
  right() {
    signal = signal === 1 ? 0 : 1;
    hazards = false;
    signalSteered = false;
    ui.press("left", signal === -1);
    ui.press("right", signal === 1);
    ui.press("hazards", false);
  },
  hazards() {
    hazards = !hazards;
    toggle("hazards", hazards);
  },
  lights() {
    lights = !lights;
    toggle("lights", lights);
  },
  wipers() {
    wipers = !wipers;
    toggle("wipers", wipers);
  },
  horn() {
    audio.unlock();
    rig.bones.STEERING_WHEEL?.pose.getWorldPosition(V);
    audio.horn(true, V.clone());
    flash = 0.15;
  },
  hornOff() {
    audio.horn(false);
  },
  async sound() {
    soundChosen = true;
    const on = await audio.toggle();
    ui.press("sound", on);
    ui.icon("sound", on ? "volume" : "volume-off");
    $("sound").setAttribute("aria-label", on ? "Mute sound" : "Enable sound");
  },
  reset() {
    damage?.repair();
    physics.reset();
    rig.reset();
    testWorld?.resetChallenges();
    gear = "P";
    ui.gear(gear);
    keys.clear();
    Object.keys(touch).forEach((k) => (touch[k] = false));
    ui.toast("Back at the start");
    camInit = false;
  },
  hold(k, v) {
    touch[k] = v;
    audio.unlock();
    if (v && k === "throttle" && (!ignition || gear === "P" || gear === "N"))
      ui.toast(
        !ignition
          ? "Tap power to start, then tap D to drive."
          : "Tap D for forward or R for reverse, then hold the accelerator.",
      );
  },
  pauseForInteraction() {
    if (Math.abs(physics.speed) > 0.65) {
      ui.toast("Brake to a stop before opening Interactions");
      return false;
    }
    gear = "P";
    ui.gear(gear);
    return true;
  },
  panel(v) {
    inspecting = v;
    if (v) changeCamera(4);
    else if (camMode === 4) changeCamera(0);
  },
  focus: focusBone,
  interaction(c, v) {
    audio.event(/Open|Pull|Release|Fold/.test(c.name) ? "latch" : "click");
    if (c.name === "Open" && /DOOR_[LR]/.test(c.bone)) {
      const b = c.bone.replace("DOOR", "DOOR_LATCH");
      rig.set(b, "Pull", v > 0.02 ? 1 : 0);
      setTimeout(() => {
        if (rig.targets[c.id] === v) rig.set(b, "Pull", 0);
      }, 500);
    }
    if (c.bone === "HAZARD_BUTTON" && c.name === "Press") {
      hazards = v > 0.5;
      ui.press("hazards", hazards);
    }
    if (c.bone === "INDICATOR_STALK") {
      signal = v < 0.33 ? -1 : v > 0.66 ? 1 : 0;
      ui.press("left", signal === -1);
      ui.press("right", signal === 1);
    }
    if (c.bone === "BELT_RELEASE" && v > 0.5) rig.set("SEATBELT", "Fasten", 0, true);
    if (c.bone === "REAR_DOOR") {
      auto("SHUTTER_LATCH", "Release", v > 0.02 ? 1 : 0);
      auto("SHUTTER_OUTSIDE_HANDLE", "Pull", v > 0.02 ? 0.5 : 0);
    }
  },
  course() {
    courseOn = !courseOn;
    completed.clear();
    holdDelivery = 0;
    lastDelivery = -1;
    ui.press("course", courseOn);
    $("delivery-count").hidden = !courseOn;
    $("delivery-count").textContent = "0 / 3";
    pads.forEach((p) => (p.group.visible = courseOn));
    ui.toast(courseOn ? "Three stops. Park on a pad and open the rear shutter." : "Free drive");
  },
};
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  dash?.resize(innerWidth, innerHeight);
  const a = innerWidth / innerHeight,
    h = (innerWidth < 680 ? 8 : 5.8) / zoom;
  ortho.left = -h * a;
  ortho.right = h * a;
  ortho.top = h;
  ortho.bottom = -h;
  ortho.updateProjectionMatrix();
  persp.aspect = a;
  persp.updateProjectionMatrix();
}
addEventListener("resize", resize);
renderer.domElement.addEventListener(
  "wheel",
  (e) => {
    if (camMode === 4) return;
    e.preventDefault();
    // Trackpads send many small deltas, mouse wheels a few large ones; both feel even.
    const d = T.MathUtils.clamp(e.deltaY * (e.deltaMode === 1 ? 16 : 1), -120, 120);
    if (camMode === 1) rigCam.distTarget = T.MathUtils.clamp(rigCam.distTarget * Math.exp(d * 0.0016), 3.4, 26);
    else zoomTarget = T.MathUtils.clamp(zoomTarget * Math.exp(-d * 0.0012), camMode === 0 ? 0.32 : 0.6, camMode === 0 ? 3.4 : 2.1);
  },
  { passive: false },
);
function scenery() {
  for (const [i, pos] of [
    [0, [-20, 0, 0]],
    [1, [-51, 0, 0]],
    [2, [-68, 0, -16]],
  ]) {
    const group = new T.Group();
    group.position.set(...pos);
    const ring = new T.Mesh(
      new T.RingGeometry(3.5, 3.57, 80),
      new T.MeshBasicMaterial({ color: 0x718f7e, transparent: true, opacity: 0.8, side: T.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(ring);
    const flag = new T.Mesh(new T.BoxGeometry(0.6, 0.32, 0.035), new T.MeshToonMaterial({ color: 0x739581 }));
    flag.position.set(0.3, 1.65, -3.65);
    group.add(flag);
    group.visible = false;
    scene.add(group);
    pads.push({ group, ring, flag, pos, index: i });
  }
}
actions.setCamera = (mode) => changeCamera(mode);
actions.tour = () => {
  if (film?.active) film.exit();
  showcase.start();
};
actions.film = () => film.start();
actions.stopTour = () => showcase?.active && showcase.exit();
actions.isOn = () => ignition;
// Driver display focus: the screen fills the view and takes the mouse.
actions.focusDisplay = (on = !dash.focus) => {
  if (on === dash.focus || showcase?.active) return;
  dashFrom = { pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: persp.fov };
  dashBlend = 0;
  if (on) {
    if (!ignition) actions.power(); // the display wakes when you look at it
    dashPrev = camMode;
    if (camera !== persp) changeCamera(2);
    dash.setFocus(true);
    dashLeaving = false;
    ui.toast("Driver display. Tap a symbol to learn what it means. Esc to go back.");
  } else {
    dash.stopDemo();
    dashLeaving = true;
  }
};
actions.drive = () => {
  // The driver buckles up as they set off; the display shows the reminder clear.
  if (rig.get("SEATBELT", "Fasten") < 0.5)
    setTimeout(() => {
      rig.set("SEATBELT", "Fasten", 1);
      audio.event("latch");
    }, 1400);
  if (!ignition) actions.power();
  if (gear === "P" || gear === "N") setGear("D");
};
function highwayLoader() {
  const el = document.createElement("div");
  el.className = "hw-load";
  el.innerHTML = `<div class="hw-sky"><div class="hw-sun"></div><div class="hw-hills h1"></div><div class="hw-hills h2"></div></div>
  <div class="hw-road"><div class="hw-dash"></div></div>
  <svg class="hw-van" viewBox="0 0 120 70" aria-hidden="true"><rect x="6" y="10" width="78" height="40" rx="6" fill="#f4f4ef"/><path d="M84 22h18l12 14v14H84z" fill="#f4f4ef"/><path d="M88 26h12l8 10H88z" fill="#8fc3e6"/><rect x="6" y="34" width="108" height="5" fill="#2d5ba8"/><rect x="6" y="40" width="108" height="3" fill="#d23a3a"/><circle cx="28" cy="52" r="9" fill="#2a2d31"/><circle cx="28" cy="52" r="4" fill="#bfc4c8"/><circle cx="94" cy="52" r="9" fill="#2a2d31"/><circle cx="94" cy="52" r="4" fill="#bfc4c8"/><rect x="18" y="16" width="26" height="12" rx="2" fill="#e9e7df"/></svg>
  <div class="hw-shield"><span>INTERSTATE</span><b>16</b></div>
  <div class="hw-info"><strong>Heading out on I-16</strong><span class="hw-step">Surveying the route</span><div class="hw-bar"><i></i></div></div>`;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add("on"));
  const bar = el.querySelector(".hw-bar i"),
    step = el.querySelector(".hw-step");
  return {
    set: (p, label) => {
      bar.style.width = Math.round(p * 100) + "%";
      if (label) step.textContent = label;
    },
    close: () => {
      el.classList.remove("on");
      setTimeout(() => el.remove(), 600);
    },
  };
}
actions.teleport = async (id) => {
  const z = ZONES.find((z) => z.id === id);
  if (!z) return;
  if (id === "interstate") {
    if (highwayLoading) return;
    if (!highway) highway = new Highway({ scene, physics, toon, audio, lights: { sun, hemi, sunOffset }, renderer, persp, ui });
    if (!highway.built) {
      highwayLoading = true;
      const ld = highwayLoader();
      await new Promise((r) => setTimeout(r, 60));
      try {
        await highway.build(ld.set);
        await new Promise((r) => setTimeout(r, 350));
      } finally {
        highwayLoading = false;
        ld.close();
      }
    }
    const sp = highway.enter();
    z.spawn = sp.position;
    z.yaw = sp.yaw;
  } else highway?.leave();
  direct?.clearPreview();
  physics.grab = null;
  damage.repair();
  rig.reset();
  physics.teleport(z.spawn, z.yaw);
  physics.reset(true);
  testWorld.resetChallenges();
  testWorld.select(id);
  gear = "P";
  ui.gear(gear);
  ui.setPanel(false);
  // Keep the player's chosen driving view; detail views fall back to the chase cam.
  changeCamera(camMode >= 3 ? 1 : camMode);
  camInit = false;
  ui.toast(z.name + " · " + z.hint);
};
actions.repair = () => {
  direct?.clearPreview();
  physics.grab = null;
  damage.repair();
  rig.reset();
  const p = physics.body.translation(),
    q = physics.body.rotation(),
    yaw = new T.Euler().setFromQuaternion(new T.Quaternion(q.x, q.y, q.z, q.w), "YXZ").y;
  physics.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  physics.body.setTranslation({ x: p.x, y: Math.max(1.06, p.y + 0.35), z: p.z }, true);
  physics.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  physics.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  physics.snapAll();
  dash?.repair();
  gear = "P";
  ui.gear(gear);
  ui.toast("Repaired and ready");
};
actions.grab = () => {
  const on = direct.toggle();
  experience.setHand(on);
  ui.toast(on ? "Drag a window or door. Grab the body to lift the van." : "Grab tool off");
};
actions.slow = () => {
  physics.timeScale = physics.timeScale === 1 ? 0.18 : 1;
  experience.setSlow(physics.timeScale < 1);
  ui.toast(physics.timeScale < 1 ? "Slow motion" : "Normal speed");
};

try {
  const [data, response, p] = await Promise.all([
    fetch("./assets/vehicle.json").then((r) => r.json()),
    fetch("./assets/vehicle.bin.gz"),
    DrivingPhysics.create(),
  ]);
  physics = p;
  skids = new SkidMarks(scene, physics);
  skids.setTheme(themeDark);
  $("progress").value = 35;
  $("loading-label").textContent = "Assembling the articulated van";
  if (!response.ok) throw Error("Vehicle geometry unavailable");
  const bytes = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  rig = new VehicleRig(data, bytes, material);
  rig.root.position.y = -0.95;
  worldVehicle.add(rig.root);
  rig.fixCab();
  rig.mirrorCab();
  $("progress").value = 70;
  testWorld = new TestWorld(scene, physics, toon);
  damage = new VehicleDamage(scene, rig, physics, worldVehicle, audio, plainMaterial);
  scenery();
  ui = await createUI(rig, actions);
  experience = enhanceExperience(ui, rig, actions, testWorld, damage);
  direct = new DirectInteraction(
    renderer.domElement,
    rig,
    physics,
    worldVehicle,
    () => ({ camera, mode: camMode }),
    orbit,
    actions,
    ui,
  );
  testWorld.notice = damage.notice = ui.toast;
  dash = new Dashboard({ vehicle: worldVehicle, physics, rig, damage, audio, actions, renderer, toon, ui });
  await dash.build();
  dash.resize(innerWidth, innerHeight);
  // Dock button and focus-mode exit for the driver display.
  const displayBtn = document.createElement("button");
  displayBtn.id = "display-btn";
  displayBtn.dataset.tip = "Driver display · I";
  displayBtn.setAttribute("aria-label", "Open the driver display");
  $("camera").after(displayBtn);
  ui.icon(displayBtn, "dashboard");
  displayBtn.onclick = () => actions.focusDisplay();
  const dashControls = document.createElement("div");
  dashControls.className = "dash-controls";
  dashControls.innerHTML =
    '<button class="surface" id="dash-exit"><span id="dash-exit-icon"></span><span>Back to cab</span></button>' +
    '<button class="surface" id="dash-play"><span id="dash-play-icon"></span><span id="dash-play-label">Play the Figma sequence</span></button>';
  document.body.append(dashControls);
  ui.icon("dash-exit-icon", "arrow-back-up");
  ui.icon("dash-play-icon", "player-play");
  $("dash-exit").onclick = () => actions.focusDisplay(false);
  $("dash-play").onclick = () => {
    if (dash.demo && !dash.demoFinished) {
      dash.stopDemo();
      return;
    }
    dash.demoFinished = false;
    dash.playDemo();
  };
  dash.onDemo = (on) => {
    $("dash-play-label").textContent = on ? "Stop sequence" : "Play the Figma sequence";
    ui.icon("dash-play-icon", on ? "player-stop" : "player-play");
  };
  dash.demoEnd = () => {
    dash.demoFinished = true;
    $("dash-play-label").textContent = "Replay sequence";
    ui.icon("dash-play-icon", "player-play");
  };
  showcase = new Showcase({ rig, physics, vehicle: worldVehicle, field: damage.field, ui, actions, persp, orbit, canvas: renderer.domElement, audio, dash });
  film = new Film({ scene, renderer, persp, physics, vehicle: worldVehicle, rig, dash, audio, ui, actions, toon, lights: { sun, hemi, get sunOffset() { return sunOffset; } }, onExit: () => experience.reopen?.() });
  // Parcels in the cargo bay (they hop away when a shelf is folded up).
  packages = new Packages({ rig, vehicle: worldVehicle, toon, audio });
  packages.build();
  window.__packages = packages;
  // Side mirrors: real reflective glass fed by a small cube map around the cab.
  mirrorCam = new T.CubeCamera(0.3, 400, new T.WebGLCubeRenderTarget(128, { type: T.HalfFloatType, generateMipmaps: false }));
  mirrorCam.position.set(-1.45, 1.4, 0);
  worldVehicle.add(mirrorCam);
  const mirrorGlass = new T.MeshStandardMaterial({ color: 0xdfe6ea, metalness: 1, roughness: 0.02, envMap: mirrorCam.renderTarget.texture, envMapIntensity: 1.15 });
  for (const m of rig.meshes) if (/^MIRROR_[LR]_(MAIN|CONVEX)$/.test(m.userData.bone)) m.material = mirrorGlass;
  damage.onImpact = (severity) => (rigCam.shake = Math.min(0.35, rigCam.shake + severity * 0.012));
  setTheme(false);
  resize();
  // Lights share the rig's lamp controls and travel with the vehicle.
  for (const side of [-1, 1]) {
    const lamp = new T.SpotLight(0xe5f0ed, 0, 26, 0.43, 0.38, 1.5);
    lamp.position.set(-2.7, 0.8, side * 0.73);
    lamp.target.position.set(-15, 0.1, side * 1.4);
    worldVehicle.add(lamp, lamp.target);
    headlights.push(lamp);
  }
  window.playground = {
    rig,
    physics,
    actions,
    testWorld,
    damage,
    experience,
    direct,
    get dash() {
      return dash;
    },
    get skids() {
      return skids;
    },
    get showcase() {
      return showcase;
    },
    get film() {
      return film;
    },
    THREE: T,
    Town,
    Ambience,
    TourMusic,
    lights: { sun, hemi, get sunOffset() { return sunOffset; } },
    get camera() {
      return camera;
    },
    get vehicle() {
      return worldVehicle;
    },
    get state() {
      return {
        gear,
        ignition,
        camMode,
        courseOn,
        completed: [...completed],
        speed: physics.speed,
        controls: rig.controls.length,
        render: renderer.info.render,
      };
    },
    setInput(v) {
      Object.assign(input, v);
      this.testInput = v;
    },
    // Advance and render frames synchronously (testing, throttled previews).
    step(frames = 1, dt = 1 / 60) {
      for (let i = 0; i < frames; i++) frame((lastTime || performance.now()) + dt * 1000);
    },
    renderer,
    scene,
    testInput: null,
  };
  $("progress").value = 95;
  await renderer.compileAsync(scene, camera);
  $("progress").value = 100;
  requestAnimationFrame(() => {
    $("loading").classList.add("done");
    $("loading").setAttribute("aria-hidden", "true");
  });
} catch (e) {
  console.error(e);
  $("loading-label").textContent = "Could not prepare the van. Reload to try again. " + e.message;
  throw e;
}
// The horn sounds for as long as it is held, on screen or on the H key.
$("horn").onclick = null;
$("horn").onpointerdown = (e) => {
  $("horn").setPointerCapture(e.pointerId);
  actions.horn();
};
$("horn").onpointerup = $("horn").onpointercancel = () => actions.hornOff();
$("waypoint").onclick = () => {
  const next = pads.find((p) => !completed.has(p.index));
  if (!next) return;
  const distance = Math.hypot(worldVehicle.position.x - next.pos[0], worldVehicle.position.z - next.pos[2]);
  if (distance < 3.4 && Math.abs(physics.speed) < 0.65) {
    ui.setPanel(true);
    ui.open(rig.controls.find((c) => c.bone === "REAR_DOOR" && c.name === "Open"));
  } else ui.toast("Next stop: " + Math.round(distance) + " m. Follow the arrow.");
};
const shortcuts = {
  enter: "power",
  q: "left",
  e: "right",
  b: "hazards",
  l: "lights",
  x: "wipers",
  h: "horn",
  m: "sound",
  c: "camera",
  home: "reset",
};
addEventListener("keydown", (e) => {
  if (/INPUT|TEXTAREA/.test(e.target.tagName) || $("help-dialog").open) return;
  if (film?.key(e)) return;
  if (showcase?.key(e)) return;
  const k = e.key.toLowerCase();
  if (k === "i" && !e.repeat) actions.focusDisplay();
  if (k === "escape" && dash?.focus) actions.focusDisplay(false);
  if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright", "home"].includes(k)) e.preventDefault();
  keys.add(k);
  if (e.repeat) return;
  if (experience.isStarting() && ["enter", "w", "arrowup"].includes(k)) {
    experience.start();
    return;
  }
  if (k === "g") actions.grab();
  if (k === "t") experience.zones();
  if (k === "z") actions.slow();
  if (k === "backspace") {
    e.preventDefault();
    actions.repair();
  }
  if (["1", "2", "3", "4", "5"].includes(k)) changeCamera(Number(k) - 1);
  if (k === "w" || k === "arrowup") {
    if (gear === "P" && !inspecting) actions.drive();
    if (!ignition) ui.toast("Enter powers the van on. F selects Drive. Then hold W.");
    else if (gear === "P" || gear === "N") ui.toast("Select D or press F, then hold W to accelerate.");
  }
  if (shortcuts[k]) actions[shortcuts[k]]();
  if (k === "v") $("inspect").click();
  if (k === "?") $("help").click();
  if ({ p: 1, r: 1, n: 1, f: 1 }[k]) setGear(k === "f" ? "D" : k.toUpperCase());
  audio.unlock();
});
addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  keys.delete(k);
  if (k === "h") actions.hornOff();
});
addEventListener("blur", () => {
  keys.clear();
  actions.hornOff();
  Object.keys(touch).forEach((k) => (touch[k] = false));
});
document.addEventListener("visibilitychange", () => {
  lastTime = 0;
  keys.clear();
});
renderer.domElement.addEventListener("contextmenu", (e) => {
  if (camMode <= 1) e.preventDefault();
});
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (camMode > 1 || direct?.hand || inspecting || (e.button !== 0 && e.button !== 2)) return;
  Object.assign(rigCam, { dragging: true, id: e.pointerId, x: e.clientX, y: e.clientY });
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!rigCam.dragging || e.pointerId !== rigCam.id) return;
  const dx = e.clientX - rigCam.x,
    dy = e.clientY - rigCam.y;
  rigCam.x = e.clientX;
  rigCam.y = e.clientY;
  if (camMode === 0) rigCam.isoYaw -= dx * 0.006;
  else {
    rigCam.userYaw -= dx * 0.0062;
    rigCam.userPitch = T.MathUtils.clamp(rigCam.userPitch + dy * 0.0042, -0.3, 0.95);
  }
  rigCam.idle = 0;
});
for (const type of ["pointerup", "pointercancel"])
  renderer.domElement.addEventListener(type, (e) => {
    if (e.pointerId === rigCam.id) rigCam.dragging = false;
  });
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (camMode !== 2 || direct?.hand || inspecting || e.button !== 0) return;
  Object.assign(head, { dragging: true, id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!head.dragging || e.pointerId !== head.id) return;
  head.yaw = T.MathUtils.clamp(head.yaw - (e.clientX - head.x) * 0.0055, -2.7, 2.7); // drag right looks right
  head.pitch = T.MathUtils.clamp(head.pitch + (e.clientY - head.y) * 0.0045, -0.9, 1.0);
  head.x = e.clientX;
  head.y = e.clientY;
});
for (const type of ["pointerup", "pointercancel"])
  renderer.domElement.addEventListener(type, (e) => {
    if (e.pointerId !== head.id) return;
    head.dragging = false;
    // A click (not a drag) on the display glass opens it full screen.
    if (type === "pointerup" && Math.hypot(e.clientX - head.sx, e.clientY - head.sy) < 5 && camMode === 2) {
      const ray = new T.Raycaster();
      ray.setFromCamera(new T.Vector2((e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2), camera);
      if (ray.intersectObject(dash.glass, false).length) actions.focusDisplay(true);
    }
  });
renderer.domElement.addEventListener("dblclick", () => {
  if (camMode === 2) Object.assign(head, { yaw: 0, pitch: 0 });
});
let pointerStart = null;
renderer.domElement.addEventListener("pointerdown", (e) => (pointerStart = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!inspecting || !pointerStart || Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 4)
    return;
  const ray = new T.Raycaster();
  ray.setFromCamera(
    new T.Vector2((e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2),
    camera,
  );
  const hit = ray.intersectObjects(rig.meshes, false).find((h) => !h.object.material.transparent);
  if (hit) {
    let b = hit.object.userData.bone;
    for (let n = 0; n < 5 && b; n++) {
      if (rig.controls.some((c) => c.bone === b)) {
        ui.selectBone(b);
        break;
      }
      b = rig.bones[b]?.data.parent;
    }
  }
});
const UP = new T.Vector3(0, 1, 0);
function angleDamp(a, b, rate, dt) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * (1 - Math.exp(-rate * dt));
}
function chaseCamera(dt, p, q) {
  const v = physics.body.linvel(),
    hs = Math.hypot(v.x, v.z),
    fwd = new T.Vector3(-1, 0, 0).applyQuaternion(q).setY(0),
    bodyYaw = Math.atan2(fwd.x, fwd.z);
  // Trail the direction of travel when moving forward so slides show their angle;
  // stay behind the body when slow or reversing.
  let targetYaw = bodyYaw;
  if (hs > 2.5 && physics.speed > 0) {
    const travel = Math.atan2(v.x, v.z),
      blend = 0.55 * T.MathUtils.smoothstep(hs, 2.5, 10);
    targetYaw = bodyYaw + Math.atan2(Math.sin(travel - bodyYaw), Math.cos(travel - bodyYaw)) * blend;
  }
  if (rigCam.heading === null || !camInit) rigCam.heading = targetYaw;
  rigCam.heading = angleDamp(rigCam.heading, targetYaw, 2.6 + Math.min(hs, 25) * 0.08, dt);
  // Hands off for a moment while driving and the view swings back behind the van.
  if (!rigCam.dragging) rigCam.idle += dt;
  if (rigCam.idle > 1.3 && hs > 2) {
    rigCam.userYaw = angleDamp(rigCam.userYaw, 0, 2.2, dt);
    rigCam.userPitch = T.MathUtils.damp(rigCam.userPitch, 0, 2.2, dt);
  }
  rigCam.dist = T.MathUtils.damp(rigCam.dist, rigCam.distTarget, 7, dt);
  // Hard launches stretch the camera back a touch; hard stops pull it in.
  const accel = (physics.speed - (rigCam.lastSpeed ?? physics.speed)) / Math.max(dt, 1e-3);
  rigCam.lastSpeed = physics.speed;
  rigCam.surge = T.MathUtils.damp(rigCam.surge || 0, T.MathUtils.clamp(accel * 0.07, -0.6, 0.9), 4, dt);
  const yaw = rigCam.heading + rigCam.userYaw,
    pitch = 0.27 + rigCam.userPitch - T.MathUtils.smoothstep(hs, 8, 30) * 0.05,
    dist = rigCam.dist * (1 + Math.min(hs, 35) * 0.012) + (physics.boost ? 0.6 : 0) + rigCam.surge;
  // Focus slightly ahead of the van; vertical motion is filtered so bumps don't shake the view.
  const focus = p.clone().addScaledVector(new T.Vector3(v.x, 0, v.z), 0.06);
  rigCam.focusY = rigCam.focusY === null || !camInit ? p.y : T.MathUtils.damp(rigCam.focusY, p.y, 9, dt);
  focus.y = rigCam.focusY + 1.45;
  const back = new T.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  // Pull in in front of walls and props instead of clipping through them.
  rigCam.ray ||= new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  rigCam.ray.origin = { x: focus.x, y: focus.y, z: focus.z };
  rigCam.ray.dir = { x: back.x, y: back.y, z: back.z };
  const hit = physics.world.castRay(rigCam.ray, dist, true, undefined, undefined, physics.chassis, physics.body);
  const reach = hit ? Math.max(1.6, hit.timeOfImpact - 0.35) : dist;
  const pos = focus.clone().addScaledVector(back, reach);
  pos.y = Math.max(pos.y, 0.35);
  // Crash shake decays fast and never moves the focus point.
  rigCam.shake *= Math.exp(-7 * dt);
  if (rigCam.shake > 0.002 && !reduced.matches)
    pos.add(new T.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(rigCam.shake));
  camera.position.copy(pos);
  camera.up.copy(UP);
  camera.lookAt(focus);
  rigCam.fov = T.MathUtils.damp(rigCam.fov, 50 + Math.min(hs, 40) * 0.32 + (physics.boost ? 5 : 0) + (physics.launch || 0) * 7 + (physics.driftAmount || 0) * 3, 3, dt);
  camInit = true;
  zoom = T.MathUtils.damp(zoom, zoomTarget, 9, dt);
  persp.fov = rigCam.fov;
  persp.updateProjectionMatrix();
}
function focusCamera(dt) {
  dashBlend = Math.min(1, dashBlend + dt / (dashLeaving ? 0.5 : 0.75));
  const e = dashBlend * dashBlend * dashBlend * (dashBlend * (dashBlend * 6 - 15) + 10);
  let pos, quat, fov;
  if (!dashLeaving) {
    const pose = dash.focusPose(innerWidth / innerHeight, 34);
    pos = pose.pos;
    quat = new T.Quaternion().setFromRotationMatrix(new T.Matrix4().lookAt(pose.pos, pose.look, worldVehicle.up.clone().applyQuaternion(worldVehicle.quaternion)));
    fov = pose.fov;
  } else {
    // Ease back toward the driver's eye, then hand control back.
    updateCamera(dt);
    pos = camera.position.clone();
    quat = camera.quaternion.clone();
    fov = persp.fov;
  }
  dash.setSettled(!dashLeaving && dashBlend >= 1 && !dash.band_moving);
  camera.position.lerpVectors(dashFrom.pos, pos, e);
  camera.quaternion.slerpQuaternions(dashFrom.quat, quat, e);
  persp.fov = T.MathUtils.lerp(dashFrom.fov, fov, e);
  persp.updateProjectionMatrix();
  if (dashLeaving && dashBlend >= 1) {
    dash.setSettled(false);
    dash.setFocus(false);
    dashLeaving = false;
    changeCamera(dashPrev);
  }
}
function updateCamera(dt) {
  const p = worldVehicle.position,
    q = worldVehicle.quaternion;
  // Orbit view travels with the van so you can drive while orbiting.
  if (rigCam.lastVehicle && camMode === 4 && !orbitMotion) {
    const d = p.clone().sub(rigCam.lastVehicle);
    if (d.lengthSq() < 25) {
      camera.position.add(d);
      orbit.target.add(d);
    }
  }
  (rigCam.lastVehicle ||= new T.Vector3()).copy(p);
  let look = new T.Vector3(),
    position = new T.Vector3();
  if (camMode === 4) {
    if (orbitMotion) {
      orbitMotion.time += dt;
      const t = reduced.matches ? 1 : Math.min(1, orbitMotion.time / 0.65),
        e = t * t * t * (t * (t * 6 - 15) + 10);
      camera.position.lerpVectors(orbitMotion.from, orbitMotion.to, e);
      orbit.target.lerpVectors(orbitMotion.fromTarget, orbitMotion.target, e);
      if (t === 1) orbitMotion = null;
    }
    orbit.update();
    return;
  }
  if (camMode === 0) {
    look.copy(p).add(new T.Vector3(0, 0.5, 0));
    position.copy(look).add(new T.Vector3(-11, 9, 12).applyAxisAngle(UP, rigCam.isoYaw));
  }
  if (camMode === 1) {
    chaseCamera(dt, p, q);
    return;
  }
  if (camMode === 2) {
    // Head pivots on the neck: turning shifts the eyes slightly toward the look
    // direction, and acceleration leans the head against the g-load.
    if (!head.dragging && Math.abs(physics.speed) > 3) head.idle += dt;
    else head.idle = 0;
    if (head.idle > 1.6) {
      head.yaw = T.MathUtils.damp(head.yaw, 0, 2.5, dt);
      head.pitch = T.MathUtils.damp(head.pitch, 0, 2.5, dt);
    }
    const accel = (physics.speed - (head.lastSpeed ?? physics.speed)) / Math.max(dt, 1e-3);
    head.lastSpeed = physics.speed;
    head.lean = T.MathUtils.damp(head.lean || 0, T.MathUtils.clamp(-accel * 0.006, -0.05, 0.05), 6, dt);
    head.side = T.MathUtils.damp(head.side || 0, T.MathUtils.clamp(physics.steer * physics.speed * 0.006, -0.05, 0.05), 5, dt);
    rig.bones.HEADREST.pose.getWorldPosition(position);
    position.add(
      new T.Vector3(-0.3 + head.lean - Math.abs(Math.sin(head.yaw)) * 0.05, 0.12, Math.sin(head.yaw) * -0.09 + head.side).applyQuaternion(q),
    );
    const dir = new T.Vector3(-8, -1.7, 0)
      .applyAxisAngle(new T.Vector3(0, 0, 1), head.pitch)
      .applyAxisAngle(new T.Vector3(0, 1, 0), head.yaw);
    look.copy(position).add(dir.applyQuaternion(q));
  }
  if (camMode === 3) {
    position.set(2.12, 1.0, 0).applyQuaternion(q).add(p);
    look.set(-1.5, 0.8, 0).applyQuaternion(q).add(p);
  }
  const t = camMode === 2 || camMode === 3 || !camInit || reduced.matches ? 1 : 1 - Math.exp(-dt * 5);
  camera.position.lerp(position, t);
  const desired = new T.Matrix4().lookAt(camera.position, look, new T.Vector3(0, 1, 0));
  Q.setFromRotationMatrix(desired);
  camera.quaternion.slerp(Q, camMode === 2 || camMode === 3 || !camInit ? 1 : 1 - Math.exp(-dt * 9));
  camInit = true;
  zoom = T.MathUtils.damp(zoom, zoomTarget, 9, dt);
  const a = innerWidth / innerHeight,
    h = (innerWidth < 680 ? 8 : 5.8) / zoom;
  ortho.left = -h * a;
  ortho.right = h * a;
  ortho.top = h;
  ortho.bottom = -h;
  ortho.updateProjectionMatrix();
  persp.fov = (camMode === 2 ? cabFov : camMode >= 2 ? 65 : 47) / Math.sqrt(zoom);
  persp.updateProjectionMatrix();
}
function animate(ms) {
  requestAnimationFrame(animate);
  frame(ms);
}
function frame(ms) {
  const dt = lastTime ? Math.min((ms - lastTime) / 1000, 0.05) : 1 / 60;
  lastTime = ms;
  time += dt;
  if (!window.playground.testInput) {
    input.steer =
      (keys.has("d") || keys.has("arrowright") || touch.right ? 1 : 0) -
      (keys.has("a") || keys.has("arrowleft") || touch.left ? 1 : 0);
    input.throttle = keys.has("w") || keys.has("arrowup") || touch.throttle ? 1 : 0;
    input.brake = keys.has("s") || keys.has("arrowdown") || touch.brake ? 1 : 0;
    input.handbrake = keys.has(" ");
    input.boost = keys.has("shift") || touch.boost;
  }
  if ($("help-dialog").open) {
    input.throttle = 0;
    input.brake = 1;
    input.steer = 0;
  }
  // Arcade pedals: S brakes, then backs up once stopped; W pulls away again.
  // In reverse the pedals swap so S always means "go backwards".
  const raw = { throttle: input.throttle, brake: input.brake };
  if (ignition && !physics.grab) {
    const still = Math.abs(physics.speed) < 0.7;
    autoGearHold = still && ((gear === "D" && raw.brake > 0.5 && !raw.throttle) || (gear === "R" && raw.throttle > 0.5 && !raw.brake)) ? autoGearHold + dt : 0;
    if (autoGearHold > 0.22) {
      autoGearHold = 0;
      setGear(gear === "D" ? "R" : "D");
    }
  }
  const pedals = gear === "R" ? { ...input, throttle: raw.brake, brake: raw.throttle } : input;
  // During the Morning Route film the van is placed on the street by the film.
  if (!film?.active) {
    physics.update(dt, pedals, gear, ignition);
    skids?.update(dt);
  }
  const st = physics.state();
  if (!film?.active) {
    worldVehicle.position.copy(st.position);
    worldVehicle.quaternion.copy(st.rotation);
    worldVehicle.updateMatrixWorld();
  }
  auto("SETTINGS", "Steering", (st.steer * 180) / Math.PI);
  auto("SETTINGS", "Roll distance", 0);
  auto("SETTINGS", "Travel", 0);
  for (let i = 0; i < 4; i++) {
    auto("WHEEL_" + physics.wheels[i][0], "Suspension", T.MathUtils.clamp(st.suspension[i], -0.14, 0.14));
    auto("WHEEL_" + physics.wheels[i][0], "Spin", (-st.spin[i] * 180) / Math.PI);
  }
  auto("PEDAL_ACCELERATOR", "Press", physics.throttle);
  auto("PEDAL_BRAKE", "Press", physics.brake);
  auto("GAUGE_NEEDLE_1", "Reading", Math.min(1, Math.abs(st.speed) / 36));
  auto(
    "GAUGE_NEEDLE_2",
    "Reading",
    ignition ? 0.18 + physics.throttle * 0.3 + Math.abs(st.speed) * 0.009 : 0,
  );
  if (wipers) wiperCycles += dt * 0.7;
  else wiperCycles = T.MathUtils.damp(wiperCycles, Math.ceil(wiperCycles), 8, dt);
  auto("SETTINGS", "Wiper cycles", wiperCycles);
  if (ignition) fanTurns += dt * 3;
  auto("COOLING_FAN_1", "Turns", fanTurns);
  auto("COOLING_FAN_2", "Turns", fanTurns);
  const blink = Math.sin(time * Math.PI * 2 * 1.3) > 0 ? 1 : 0;
  auto("LIGHTING", "Headlights", lights ? 1 : 0);
  auto("LIGHTING", "Running", ignition ? 1 : 0);
  auto("LIGHTING", "Brake", pedals.brake > 0.1 || input.handbrake ? 1 : 0);
  auto("LIGHTING", "Reverse", gear === "R" ? 1 : 0);
  auto("LIGHTING", "Indicator L", signal === -1 ? blink : 0);
  auto("LIGHTING", "Indicator R", signal === 1 ? blink : 0);
  auto("LIGHTING", "Hazards", hazards ? blink : 0);
  auto("INDICATOR_STALK", "Position", signal === -1 ? 0 : signal === 1 ? 1 : 0.5);
  auto("HAZARD_BUTTON", "Press", hazards ? 1 : 0);
  if (signal && Math.abs(st.steer) > 0.16) signalSteered = true;
  if (signalSteered && Math.abs(st.steer) < 0.03 && Math.abs(st.speed) > 1) {
    signal = 0;
    signalSteered = false;
    ui.press("left", false);
    ui.press("right", false);
  }
  direct.update(dt);
  rig.update(dt);
  dash.update({
    dt,
    ignition,
    gear,
    speed: physics.speed,
    signal,
    hazards,
    blinkL: Math.max(rig.get("LIGHTING", "Indicator L"), rig.get("LIGHTING", "Hazards")),
    blinkR: Math.max(rig.get("LIGHTING", "Indicator R"), rig.get("LIGHTING", "Hazards")),
    lights,
    handbrake: input.handbrake,
  });
  damage.update(dt);
  testWorld.update(dt, st);
  experience.update(dt, time);
  headlights.forEach((l) => (l.intensity = rig.get("LIGHTING", "Headlights") * (themeDark ? 90 : 25)));
  for (const { p, m } of propMeshes)
    if (p.dynamic) {
      m.position.copy(p.body.translation());
      m.quaternion.copy(p.body.rotation());
    }
  // A stable, tightly fitted moving shadow map keeps hard shadows crisp.
  // Snap the moving shadow frustum to whole shadow-map texels so the shadow
  // edges stay still while the van moves instead of crawling and shimmering.
  V.copy(worldVehicle.position).applyQuaternion(sunInverse);
  V.x = Math.round(V.x / shadowTexel) * shadowTexel;
  V.y = Math.round(V.y / shadowTexel) * shadowTexel;
  V.applyQuaternion(sunRotation);
  sun.target.position.copy(V);
  sun.position.copy(V).add(sunOffset);
  sun.target.updateMatrixWorld();
  if (film?.active) {
    film.update(dt);
    camera = persp;
  } else if (showcase.active) {
    showcase.update(dt);
    camera = persp;
  } else if (dash.focus) focusCamera(dt);
  else updateCamera(dt);
  if (projectionBlend < 1 && projectionStart) {
    projectionBlend = Math.min(1, projectionBlend + dt / 0.65);
    const e = projectionBlend * projectionBlend * (3 - 2 * projectionBlend);
    for (let i = 0; i < 16; i++)
      camera.projectionMatrix.elements[i] = T.MathUtils.lerp(
        projectionStart.elements[i],
        camera.projectionMatrix.elements[i],
        e,
      );
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
  // Power windows run their motor sound while the glass is actually moving.
  for (const side of ["L", "R"]) {
    const value = rig.get("WINDOW_" + side, "Lower"),
      // The walkthrough lowers the glass silently.
      moving = !showcase?.active && Math.abs(value - (windowLast[side] ?? value)) / Math.max(dt, 1e-3) > 0.04;
    windowLast[side] = value;
    if (moving !== !!windowMoving[side]) {
      windowMoving[side] = moving;
      rig.bones["WINDOW_" + side]?.pose.getWorldPosition(V);
      audio.windowMotor(side, moving, V.clone());
    }
  }
  // The film has its own soundscape; keep the van's driving sounds quiet.
  const filming = !!film?.active;
  audio.update({
    dt,
    time,
    speed: filming ? 0 : st.speed,
    throttle: filming ? 0 : physics.throttle,
    brake: filming ? 0 : physics.brake,
    ignition: filming ? false : ignition,
    gear,
    boost: physics.boost,
    power: physics.power,
    signal: signal !== 0 || hazards,
    reverse: gear === "R" && ignition,
    cab: camMode === 2,
    listener: camera,
    vehicle: worldVehicle,
    skid: physics.skid || 0,
    bump: physics.bump || 0,
    suspensionActivity: physics.suspensionActivity || 0,
    plastic: damage.soft.plasticRate || 0,
    grounded: st.grounded,
  });
  ui.update(st.speed, physics.throttle);
  if (courseOn) {
    let near = -1;
    for (const p of pads) {
      const distance = Math.hypot(st.position.x - p.pos[0], st.position.z - p.pos[2]);
      if (distance < 3.4 && !completed.has(p.index)) near = p.index;
      p.flag.scale.y = 1 + Math.sin(time * 2 + p.index) * 0.025;
    }
    if (near >= 0) {
      if (lastDelivery !== near) {
        ui.toast("Park here, then open the rear shutter in Interactions.");
        lastDelivery = near;
      }
      if (gear === "P" && Math.abs(st.speed) < 0.15 && rig.get("REAR_DOOR", "Open") > 0.85) {
        holdDelivery += dt;
        if (holdDelivery > 1) {
          completed.add(near);
          pads[near].ring.material.color.set(0x3b6e59);
          pads[near].flag.material.color.set(0x3b6e59);
          $("delivery-count").textContent = completed.size + " / 3";
          audio.event("success");
          ui.toast(
            completed.size === 3
              ? "All deliveries complete. Beautifully handled."
              : "Delivered. Close the shutter and head to the next stop.",
          );
          holdDelivery = 0;
        }
      } else holdDelivery = 0;
    } else holdDelivery = 0;
  }
  const next = courseOn ? pads.find((p) => !completed.has(p.index)) : highway?.active ? highway.waypoint() : null;
  $("waypoint").hidden = !next;
  if (next) {
    const projected = new T.Vector3(next.pos[0], 1.4, next.pos[2]).project(camera);
    let dx = (projected.x * innerWidth) / 2,
      dy = (-projected.y * innerHeight) / 2;
    const maxX = innerWidth / 2 - 42,
      maxY = innerHeight / 2 - 180,
      k = Math.max(1, Math.abs(dx) / maxX, Math.abs(dy) / Math.max(70, maxY));
    dx /= k;
    dy /= k;
    $("waypoint").style.left = innerWidth / 2 + dx + "px";
    $("waypoint").style.top = innerHeight / 2 + dy + "px";
    $("waypoint").firstElementChild.style.transform =
      "rotate(" + ((Math.atan2(dy, dx) * 180) / Math.PI + 90) + "deg)";
    const distance = Math.round(Math.hypot(st.position.x - next.pos[0], st.position.z - next.pos[2]));
    $("waypoint").dataset.tip = "Next stop · " + distance + " m";
    $("waypoint").setAttribute("aria-label", "Next delivery stop, " + distance + " meters");
  }
  if (st.position.y < -10) actions.reset();
  if (highway?.active) {
    const lv = physics.body.linvel();
    highway.update(dt, { position: st.position, velocity: lv, speed: st.speed, camera, rotation: st.rotation });
  }
  if (packages) {
    const fwd = st.speed;
    const acc = (fwd - lastFwd) / Math.max(dt, 1e-3);
    lastFwd = fwd;
    packages.update(dt, new T.Vector3(-T.MathUtils.clamp(acc, -30, 30), 0, T.MathUtils.clamp(physics.steer * st.speed * Math.abs(st.speed) * 0.2, -20, 20)));
  }
  // Refresh the mirror reflections now and then, only when the camera is close.
  if (mirrorCam && !film?.active && ++mirrorFrame % 3 === 0 && camera.position.distanceTo(worldVehicle.position) < 14) {
    rig.root.visible = false;
    packages && (packages.group.visible = false);
    mirrorCam.update(renderer, scene);
    rig.root.visible = true;
    packages && (packages.group.visible = true);
  }
  dash.render(camera);
  if (!film?.render(time)) renderer.render(scene, camera);
}
requestAnimationFrame(animate);
if (new URLSearchParams(location.search).has("qa")) import("./qa.js");
