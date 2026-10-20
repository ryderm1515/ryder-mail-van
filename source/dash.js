import * as T from "three";
import { CSS3DRenderer, CSS3DObject } from "three/addons/renderers/CSS3DRenderer.js";
import { RAPIER } from "./physics.js";

// Driver display, built from the Oshkosh / SCADpro dashboard file in Figma
// (OSHKOSH-SCAD-PRO-DRAFT-FILE, page "SOUND DEMOS / 01 Presenter", frame
// "START / Ready" 277:78997 and its state layers).
//
// This is a real DOM interface, not a texture. It lives on a CSS3D layer behind
// the WebGL canvas; the screen mesh in the cab writes transparent pixels, so the
// live UI shows through exactly where the glass is, and anything between you
// and the screen (the steering wheel, your hands' view of the rim) still
// occludes it. Every element is placed at its Figma coordinates on the
// 1930 x 731.62 artboard, and every state is driven by the simulation.

const W = 1930,
  H = 731.62;
const A = "./assets/dash/";

// Figma inset percentages [top, right, bottom, left] -> absolute px box.
const box = ([t, r, b, l]) =>
  `left:${(l * W) / 100}px;top:${(t * H) / 100}px;width:${(W * (100 - l - r)) / 100}px;height:${(H * (100 - t - b)) / 100}px`;
const pct = ([t, r, b, l]) => `left:${l}%;top:${t}%;width:${100 - l - r}%;height:${100 - t - b}%`;
const px = (x, y, w, h) => `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;

// Lower tell-tale row, named by what each symbol means in the source artwork.
const TELLTALES = [
  ["lamp", [[81.02, 95.86, 11.76, 1.3, "tt-lamp"]]],
  ["battery", [[81.95, 91.34, 12.69, 5.72, "tt-g8"]]],
  ["brake", [[83.04, 86.34, 11.28, 10.92, "tt-brake-circle", 0.14], [84.1, 87.61, 12.34, 12.18, "tt-brake-mark", 0.14], [79.45, 85.26, 17.54, 9.87, "tt-brake-word", 0.14]]],
  ["coolant", [[80.7, 81.36, 11.44, 15.87, "tt-battery"]]],
  ["airbag", [[81.56, 76.98, 12.29, 20.27, "tt-g9"]]],
  ["charge", [[82.51, 73.2, 13.25, 23.9, "tt-v7"]]],
  ["belt", [[81.31, 69.96, 12.05, 27.79, "tt-seatbelt-off"]]],
  ["power", [[81.55, 66.41, 12.29, 31.26, "tt-g1"]]],
  ["epb", [[81.56, 30.94, 12.29, 66.1, "tt-park-circle", 0.14]]],
  ["door", [[81.56, 27.56, 12.29, 70.45, "tt-door-off"]]],
  ["esc", [[81.13, 23.56, 14.62, 73.95, "tt-esc-a", 0.14], [86.19, 23.97, 11.87, 74.14, "tt-esc-b", 0.14]]],
  ["steering", [[81.95, 19.65, 12.26, 77.42, "tt-g15"]]],
  ["traction", [[81.15, 16.59, 14.32, 81.6, "tt-tms-off", 0.14], [86.18, 16.61, 11.89, 81.5, "tt-tms-b", 0.14]]],
  ["abs", [[81.56, 12.4, 12.29, 84.64, "tt-abs-off"]]],
  ["tire", [[81.74, 8.63, 12.48, 88.87, "tt-tire-off"]]],
  ["service", [[81.59, 5.29, 12.33, 92.37, "tt-wrench"]]],
  ["hev", [[86.3, 1.87, 11.93, 96.27, "tt-hev-a", 0.14], [81.2, 1.44, 13.98, 95.63, "tt-hev-b", 0.14]]],
];
// What every symbol on the display is. Tap one in the display view to see it.
// [category, name, what it means when lit, what it means when off/idle, artwork]
const INFO = {
  lamp: ["LIGHTING", "Exterior lamp fault", "A headlamp or signal lamp is out", "All exterior lamps working", "tt-lamp"],
  battery: ["ELECTRICAL", "12 V battery", "Low-voltage system is not charging", "Low-voltage system charging normally", "tt-g8"],
  brake: ["BRAKES", "Parking brake", "Parking brake is applied", "Parking brake released", "tt-brake-circle"],
  coolant: ["THERMAL", "Battery temperature", "High-voltage battery cooling fault", "Battery temperature normal", "tt-battery"],
  airbag: ["SAFETY", "Airbag system", "Airbag deployed, restraints need service", "Airbags ready", "tt-g9"],
  charge: ["CHARGING", "Charge cable", "Charge cable connected", "No charge cable connected", "tt-v7"],
  belt: ["SEATBELT", "Seat belt reminder", "Driver seat belt is unfastened", "Driver belt fastened", "tt-seatbelt-off"],
  power: ["DRIVETRAIN", "Reduced power", "Drive power is limited after damage", "Full drive power available", "tt-g1"],
  epb: ["PARKING", "Electronic park brake", "Applied automatically in P", "Released", "tt-park-circle"],
  door: ["GENERAL DRIVER", "Door open", "A door, the hood or the shutter is open", "All doors closed", "tt-door-off"],
  esc: ["STABILITY", "Stability control", "Wheels are slipping, ESC is intervening", "Stability control standing by", "tt-esc-a"],
  steering: ["STEERING", "Power steering", "Steering fault, front suspension damaged", "Steering normal", "tt-g15"],
  traction: ["TRACTION", "Traction control", "A wheel has lost grip or is missing", "Traction normal", "tt-tms-off"],
  abs: ["BRAKES", "Anti-lock brakes", "ABS fault, wheel speed sensor damaged", "ABS ready", "tt-abs-off"],
  tire: ["TIRES", "Tire pressure", "Low pressure or a damaged wheel", "Tire pressure normal", "tt-tire-off"],
  service: ["SERVICE", "Service required", "The van has been damaged, book service", "No service due", "tt-wrench"],
  hev: ["DRIVETRAIN", "Electric drive", "Electric drive system active", "Electric drive system normal", "tt-hev-b"],
  lowbeam: ["LIGHTING", "Low beams", "Headlights on", "Headlights off. Press L to switch on", "lowbeam-dim"],
  highbeam: ["LIGHTING", "High beams", "High beams on", "High beams off", "highbeam-dim"],
  autobeam: ["LIGHTING", "Auto high beam", "Switches high beams for oncoming traffic", "Auto high beam off", "autobeam-dim"],
  position: ["LIGHTING", "Position lamps", "Running and clearance lamps on", "Position lamps off", "position-dim"],
  turn: ["BLINKERS", "Turn signals", "Signal is flashing", "Tap an arrow or press Q / E to signal", "turn-arrows-dim"],
  signal: ["CONNECTIVITY", "Signal strength", "Connected to the fleet network", "Connected to the fleet network", "signal"],
  parkaid: ["PARKING", "Parking assist", "Rear sensors active in reverse", "Active when you select R", "parkaid-dim-b"],
  lanes: ["DRIVER ASSIST", "Lane keeping", "Lane guidance active", "Lane keeping standing by", "lane-guides-dim"],
  lanedep: ["DRIVER ASSIST", "Lane departure", "Drifting out of lane", "Lane departure warning ready", "lane-departure-dim"],
  follow: ["DRIVER ASSIST", "Following distance", "Too close to the vehicle ahead", "Following distance alert ready", "following-dim"],
  siderear: ["DRIVER ASSIST", "Blind spot monitor", "Vehicle in your blind spot", "Blind spot monitor ready", "side-rear-dim"],
  sidefault: ["DRIVER ASSIST", "Side sensor fault", "A side sensor is blocked or damaged", "Side sensors working", "side-fault-dim"],
  obstacle: ["DRIVER ASSIST", "Forward collision warning", "Obstacle ahead, brake now", "Forward collision warning ready", "ctx-fcw"],
  ready: ["READY", "Ready to drive", "The van is powered and in a drive state", "Power on to make the van ready", "ready-van"],
  speed: ["SPEED", "Speedometer", "Current road speed", "Tap to switch mph and km/h", "readout-mph"],
  gear: ["DRIVE SELECTOR", "Gear", "P park, R reverse, N neutral, D drive", "Tap to cycle P R N D", null],
};
const CSS = `
@font-face{font-family:"Inter";font-weight:400;src:url(${A}fonts/inter-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:"Inter";font-weight:700;src:url(${A}fonts/inter-latin-700-normal.woff2) format("woff2")}
@font-face{font-family:"Mona Sans";font-weight:500;src:url(${A}fonts/mona-sans-latin-500-normal.woff2) format("woff2")}
@font-face{font-family:"Mona Sans";font-weight:600;src:url(${A}fonts/mona-sans-latin-600-normal.woff2) format("woff2")}
@font-face{font-family:"Mona Sans";font-weight:700;src:url(${A}fonts/mona-sans-latin-700-normal.woff2) format("woff2")}
#dash-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:-1;background:#050606}

.dash-screen{contain:strict;width:${W}px;height:${H}px;position:relative;background:#050606;overflow:hidden;font-family:Inter,-apple-system,sans-serif;color:#fff;user-select:none;-webkit-user-select:none}
.dash-screen *{box-sizing:border-box}
.dash-screen .dash-alert{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;z-index:50;opacity:0;transition:opacity .35s;pointer-events:none;background:#050606}
.dash-screen .dash-alert.on{opacity:1}
.dash-screen.moving{will-change:transform}
.dash-screen .l{position:absolute}
.dash-screen .l>svg{position:absolute;inset:0;width:100%;height:100%;display:block;overflow:visible}
.dash-ui{position:absolute;inset:0;opacity:0;transition:opacity .5s ease}
.dash-on .dash-ui{opacity:1;transition:none}
.dash-base{position:absolute;inset:0}
.dash-screen .lit{transition:opacity .25s ease}
.dash-screen .off{opacity:0}
/* Startup choreography, timed from the Figma "02 CONTINUOUS" timeline (seconds after power-on). */
@keyframes d-in{from{opacity:0}}
@keyframes d-van-y{from{translate:0 72px}}
@keyframes d-read{from{translate:0 10px;scale:.94}}
@keyframes d-acc-s{from{scale:.01 1}}
@keyframes d-acc-o{0%{opacity:0}41%{opacity:.7;animation-timing-function:ease-in-out}100%{opacity:.35}}
.dash-on .dash-base{animation:d-in .8s ease-out .6s both}
.dash-on .dash-van{animation:d-in .4s ease-out .45s both,d-van-y 1.2s ease-out .45s both}
.dash-on .dash-speed{animation:d-in .8s ease-out .6s both,d-read 1s ease-out .6s both}
.dash-on .dash-gear,.dash-on .unit{animation:d-in .8s ease-out .6s both}
.dash-on .dash-accent{animation:d-acc-s .8s ease-out .8s both,d-acc-o 1.7s ease-out .8s both}
.dash-on .dash-accent+.dash-accent{animation-delay:.95s}
#ind-ready{transition:opacity .35s ease-out}
/* Cue cadences from the same timeline. */
@keyframes d-blink{0%{opacity:1}50%{opacity:0}}
@keyframes d-blink15{0%{opacity:1}50%{opacity:.15}}
@keyframes d-belt{0%{opacity:1}66.667%{opacity:0}}
@keyframes d-belt-sym{0%{opacity:1;animation-timing-function:ease-in-out}66.667%{opacity:.3;animation-timing-function:ease-in-out}100%{opacity:1}}
@keyframes d-park{0%{opacity:1}60%{opacity:0}}
.d-cue-door{animation:d-blink 1s steps(1) infinite}
.d-cue-door-sym{animation:d-blink15 1s steps(1) infinite}
.d-cue-belt{animation:d-belt 1.5s steps(1) infinite}
.d-cue-belt-sym{animation:d-belt-sym 1.5s infinite}
.d-cue-park{animation:d-park var(--pp,1.5s) steps(1) infinite}
.dash-text{position:absolute;white-space:nowrap;line-height:normal}
.dash-speed{font-weight:700;font-size:128px;text-align:center;font-variant-numeric:tabular-nums;transform:translateX(-50%)}
.dash-gear{font-weight:700;font-size:41.935px}
.dash-ready-text{font-family:"Mona Sans",Inter,sans-serif;font-weight:600;font-size:18px;color:#42c2f1}
.dash-ctx{position:absolute;width:335px;display:flex;flex-direction:column;gap:21px;align-items:flex-start;opacity:0;translate:0 14px;transition:opacity .25s ease-in-out,translate .25s ease-in-out}
.dash-ctx.show{opacity:1;translate:0 0;transition:opacity .28s ease-out,translate .38s ease-out}
.dash-ctx.was{translate:0 -7px}
.dash-ctx .sym{transition:opacity .15s}
.dash-ctx .lab{font-size:19px;color:#96a6ab;height:28px;width:335px}
.dash-ctx .tit{font-weight:700;font-size:31px;color:#f5f7f7;height:44px;width:335px}
.dash-ctx .det{font-size:21px;color:#96a6ab;height:58px;width:335px}
.dash-screen .ind-right>svg{transform:scaleX(-1)}
.dash-ctx .sym{position:relative}
.dash-ctx .sym>svg{position:absolute;inset:0;width:100%;height:100%}
.dash-ctx .sym.tint svg *{fill:currentColor}
.dash-readysym{position:relative;width:125px;height:31.041px}
.dash-readysym span{position:absolute;left:0;top:0;font-family:"Mona Sans",Inter,sans-serif;font-weight:600;font-size:22.35px;color:#42c2f1}
.dash-readysym .van{position:absolute;inset:19.5% 0 30.24% 72.49%}
.dash-accent{position:absolute;background:#42c2f1;opacity:0;border-radius:3px}
.dash-road-clip{position:absolute;overflow:hidden}
.dash-van{position:absolute;object-fit:contain}
/* FCW popup: appears at once, pulses its red stroke and glow (0.35 s hold, 0.22 s ease), fades out in 0.22 s. */
@keyframes d-fcw{0%,30.6%{box-shadow:inset 0 0 0 4px #ce0500,0 0 24px 3px rgba(206,5,0,.42),0 6px 11px rgba(0,0,0,.4);animation-timing-function:ease-in-out}48.8%,79.4%{box-shadow:inset 0 0 0 1.5px #ce0500,0 0 5px 0 rgba(206,5,0,.06),0 6px 11px rgba(0,0,0,.4);animation-timing-function:ease-in-out}100%{box-shadow:inset 0 0 0 4px #ce0500,0 0 24px 3px rgba(206,5,0,.42),0 6px 11px rgba(0,0,0,.4)}}
@keyframes d-fcw-sym{0%,30.6%{opacity:1;animation-timing-function:ease-in-out}48.8%,79.4%{opacity:var(--lo,.25);animation-timing-function:ease-in-out}100%{opacity:1}}
.dash-fcw{position:absolute;border-radius:10px;background:linear-gradient(#252828,#040505);box-shadow:inset 0 0 0 1.5px #ce0500,0 0 5px 0 rgba(206,5,0,.06),0 6px 11px rgba(0,0,0,.4);opacity:0;transition:opacity .22s ease-in-out}
.dash-fcw.show{opacity:1;transition:none;animation:d-fcw 1.1446s infinite}
.dash-fcw.show .icon,.d-cue-fcw{animation:d-fcw-sym 1.1446s infinite}
.d-cue-fcw-ctx{--lo:.4;animation:d-fcw-sym 1.1446s infinite}
.dash-fcw p{position:absolute;left:-1px;top:23px;width:518px;text-align:center;font-family:"Mona Sans",Inter,sans-serif;font-weight:700;font-size:24px;margin:0}
.dash-fcw .icon{position:absolute;left:206.4px;top:102px;width:103.492px;height:64.494px}
.dash-prox{position:absolute;display:flex;flex-direction:column;gap:25px;opacity:0;translate:0 8px;transition:opacity .3s ease-out}
.dash-prox.show{opacity:1;translate:0 0;transition:opacity .2s ease-out,translate .25s ease-out}
.dash-prox .lab{font-size:22px;color:#9ea8ad;height:40px;width:340px}
.dash-prox .msg{font-size:27px;height:40px;width:340px}
.dash-prox .bars{display:flex;gap:10px}
.dash-prox .bars i{display:block;width:96px;height:10px;border-radius:3px;background:#fecd06;opacity:.12;transition:opacity .25s ease-out}
.dash-prox .bars i:last-child{background:#ce0500}
.dash-prox .bars i.on{opacity:1}
.dash-flash{animation:dash-flash .7s steps(1) infinite}
@keyframes dash-flash{0%{opacity:1}50%{opacity:.18}}
.dash-tt{cursor:pointer}
.dash-tt.on .l{opacity:1!important}
.dash-tt.on svg *{fill:var(--tt)}
.dash-tt.on{filter:drop-shadow(0 0 4px var(--tt-glow))}
.dash-hit{position:absolute;cursor:pointer}
.dash-info-hit{position:absolute;cursor:pointer;border-radius:8px}
.dash-picked{outline:2px solid rgba(66,194,241,.7);outline-offset:4px;border-radius:8px}
.dash-sheen{position:absolute;inset:0;pointer-events:none;background:linear-gradient(115deg,rgba(255,255,255,.055) 0%,rgba(255,255,255,0) 38%,rgba(255,255,255,0) 70%,rgba(255,255,255,.03) 100%)}
.dash-fault .dash-ui{animation:dash-fault .9s steps(2) 1 forwards}
@keyframes dash-fault{0%{opacity:1}30%{opacity:.2}45%{opacity:.9}60%{opacity:.1}100%{opacity:0}}
.dash-focus #stage{pointer-events:none}
.dash-focus .topbar,.dash-focus .dock,.dash-focus .telemetry,.dash-focus .utility-dock,.dash-focus .camera-tag,.dash-focus #activity,.dash-focus .touch-drive{opacity:0;pointer-events:none}
.dash-focus #dash-layer{pointer-events:none}
.dash-focus .dash-screen{pointer-events:auto}
.dash-controls{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);z-index:20;display:none;gap:8px;transition:bottom .5s cubic-bezier(.16,1,.3,1)}
.dash-focus .dash-controls{display:flex}
.dash-demo .dash-controls{display:none}
.dash-caption .ctl{position:absolute;right:3.63vw;top:2.49vw;display:flex;flex-direction:column;gap:.93vw;pointer-events:auto}
.dash-caption .ctl button{width:16.58vw;height:3.11vw;background:#293032;border:1px solid #69afc8;border-radius:6px;color:#fff;font:700 1.19vw "Mona Sans",Inter,sans-serif;cursor:pointer;transition:background .15s}
.dash-caption .ctl button:hover{background:#34403f}
.dash-caption .ctl button:after{display:none}
.dash-controls button{width:auto;height:42px;padding:0 18px 0 12px;gap:8px;font-size:12.5px;white-space:nowrap}
.dash-controls svg{width:18px;height:18px}
/* Presenter caption band from the Figma sound study frames (1930 x 354 under the display). */
.dash-caption{position:fixed;left:0;right:0;bottom:0;height:min(18.34vw,32vh);background:#141a1c;z-index:19;display:none;flex-direction:column;gap:.88vw;padding:1.55vw 2.49vw 0;font-family:"Mona Sans",Inter,sans-serif;line-height:normal;translate:0 100%;transition:translate .5s cubic-bezier(.16,1,.3,1);pointer-events:none}
.dash-focus .dash-caption{display:flex}
.dash-demo .dash-caption{translate:0 0}
.dash-caption p{margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dash-caption .brand{font-weight:700;font-size:.93vw;color:#69afc8}
.dash-caption .title{font-weight:700;font-size:2.02vw;color:#fff}
.dash-caption .reason{font-weight:500;font-size:1.3vw;color:#a3b0b2}
.dash-caption .status{font-weight:700;font-size:1.19vw;color:#fff}
.dash-caption .audio{font-weight:500;font-size:.88vw;color:#a3b0b2}
.dash-caption .bar{position:absolute;left:0;bottom:0;height:3px;background:#42c2f1;opacity:.6;width:0}
`;

export class Dashboard {
  constructor(o) {
    // vehicle, physics, rig, damage, audio, actions, renderer, toon, ui
    Object.assign(this, o);
    this.state = { on: false, phase: "off", t: 0 };
    this.units = "mph";
    this.selected = null;
    this.selectedTime = 0;
    this.focus = false;
    this.css = new CSS3DRenderer();
    this.css.domElement.id = "dash-layer";
    document.getElementById("stage").before(this.css.domElement);
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    this.cssScene = new T.Scene();
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    this.fcwHold = 0;
    this.lastChime = {};
  }
  async build() {
    const names = [
      ...new Set([
        "base-frame", "base-gearbar", "panel-left", "panel-right", "bracket-left", "bracket-right", "readout-mph", "road",
        "turn-arrows-dim", "lowbeam-dim", "highbeam-dim", "autobeam-dim", "position-dim", "signal", "parkaid-dim-a", "parkaid-dim-b", "parkaid-dim-p",
        "lane-guides-dim", "lane-departure-dim", "following-dim", "side-rear-dim", "side-fault-dim", "forward-obstacle-dim", "ready-dim-van", "ready-van",
        "ctx-ready-van", "ctx-door", "ctx-blinker", "ctx-seatbelt", "ctx-park-a", "ctx-park-b", "ctx-park-p", "ctx-fcw", "fcw-popup-icon",
        "ind-door", "ind-left", "ind-right", "ind-seatbelt", "ind-park-a", "ind-park-b", "ind-park-p", "ind-fcw",
        ...TELLTALES.flatMap(([, parts]) => parts.map((p) => p[4])),
      ]),
    ];
    const svg = {};
    // Figma exports reuse def ids (clip0_0_9, filter0_d_0_7) across files; once
    // inlined into one document those collide, so namespace them per file.
    const scope = (n, s) =>
      s.replace(/x="inf" y="inf" width="-inf" height="-inf" filterUnits="userSpaceOnUse"/g, 'x="-50%" y="-50%" width="200%" height="200%"').replace(/id="((?:clip|filter|paint|mask|pattern)[^"]*)"/g, `id="${n}-$1"`).replace(/url\(#((?:clip|filter|paint|mask|pattern)[^)]*)\)/g, `url(#${n}-$1)`);
    await Promise.all(names.map(async (n) => (svg[n] = scope(n, await (await fetch(A + n + ".svg")).text()))));
    this.svg = svg;
    const L = (style, name, extra = "") => `<div class="l ${extra}" style="${style}">${svg[name]}</div>`;
    const tt = TELLTALES.map(
      ([key, parts]) =>
        `<div class="dash-tt" data-tt="${key}" data-info="${key}">${parts.map(([t, r, b, l, n, op]) => L(box([t, r, b, l]) + (op ? `;opacity:${op}` : ""), n)).join("")}</div>`,
    ).join("");
    const ctx = (id, x, y, label, symbol, title, detail) =>
      `<div class="dash-ctx" id="${id}" style="left:${x}px;top:${y}px"><div class="lab">${label}</div>${symbol}<div class="tit">${title}</div><div class="det">${detail}</div></div>`;
    const sym = (name, w, h, extra = "") => `<div class="sym ${extra}" style="width:${w}px;height:${h}px">${svg[name]}</div>`;
    const readySym = `<div class="dash-readysym"><span>READY</span><div class="l van">${svg["ctx-ready-van"]}</div></div>`;
    const parkSym = `<div class="sym" style="width:125px;height:58.575px">${L(pct([24.29, 34.32, 4.01, 35.84]), "ctx-park-a")}${L(pct([0, 0, 0.04, 66.22]), "ctx-park-b")}${L(pct([0, 64.71, 0, 0]), "ctx-park-p")}</div>`;
    // Root element, 1930 x 731.62 like the Figma artboard.
    const root = document.createElement("div");
    root.className = "dash-screen moving";
    root.innerHTML = `
      <div class="dash-ui">
        <div class="dash-base">
        ${L(box([0.68, 0.26, 0.68, 0.26]), "base-frame")}
        ${L(box([85.92, 0.26, 0.68, 0.26]), "base-gearbar")}
        <div class="l" style="${box([20.95, 74.22, 23.54, 3.84])}"><div class="l" style="inset:-3.94% -3.78%">${svg["panel-left"]}</div></div>
        <div class="l" style="${box([20.95, 3.84, 23.54, 74.22])}"><div class="l" style="inset:-3.94% -3.78%">${svg["panel-right"]}</div></div>
        ${L(box([20.95, 63.98, 23.54, 28.42]), "bracket-left")}
        ${L(box([20.95, 28.42, 23.54, 63.98]), "bracket-right")}
        ${L(box([39.19, 42.77, 10.65, 42.77]), "road")}
        ${tt}
        <div class="dash-text" style="${box([92.77, 69.29, 3.81, 27.44])};font-family:'Mona Sans',Inter,sans-serif;font-weight:500;font-size:18px;opacity:.22">READY</div>
        ${L(box([93.44, 67.36, 4.85, 31.21]) + ";opacity:.22", "ready-dim-van")}
        ${L(box([12.44, 28.43, 82.29, 28.43]), "turn-arrows-dim")}
        ${L(box([3.5, 55.76, 91.25, 41.65]), "lowbeam-dim", "lit")}
        ${L(box([3.75, 51.06, 91.5, 46.35]), "highbeam-dim", "lit")}
        ${L(box([3.75, 46.35, 91.5, 51.06]), "autobeam-dim", "lit")}
        ${L(box([3.76, 41.13, 91.51, 55.47]), "position-dim", "lit")}
        <div class="dash-text dash-clock" style="${box([3.87, 65.88, 92.17, 30.8])};font-size:24px">10:30</div>
        <div class="dash-text" style="${box([3.87, 30.99, 92.17, 66.88])};font-size:24px">82°</div>
        ${L(box([4.27, 60.83, 92.02, 36.65]), "signal")}
        ${L(box([14.2, 35.3, 83.26, 63.85]) + ";opacity:.14", "parkaid-dim-a")}
        ${L(box([13.33, 34.31, 83.12, 64.72]) + ";opacity:.14", "parkaid-dim-b")}
        ${L(box([13.33, 36.17, 83.12, 62.82]) + ";opacity:.14", "parkaid-dim-p")}
        ${L(box([12.48, 60.95, 82.32, 36.47]), "lane-guides-dim")}
        ${L(box([20.45, 57.35, 74.55, 40.9]), "lane-departure-dim")}
        ${L(box([12.54, 56.94, 82.37, 40.49]), "following-dim")}
        ${L(box([12.37, 41.46, 82.21, 56.9]), "side-rear-dim")}
        ${L(box([20.51, 41.7, 74.61, 57.14]), "side-fault-dim")}
        ${L(box([12.42, 38.57, 82.26, 59.66]), "forward-obstacle-dim")}
        </div>
        <div class="dash-road-clip" style="${px(800, 260, 340, 394)}"><img class="dash-van" src="${A}van-rear.png" alt="" style="${px(96.873, 122.64, 137.86, 206.05)}"></div>
        ${L(box([31.22, 48.75, 65.98, 48.76]), "readout-mph", "unit")}
        <div class="dash-text dash-speed" style="left:965px;top:89px;width:220px;height:160px">0</div>
        <div class="dash-text dash-gear" style="${px(951, 660, 45, 60)}">P</div>
        <div class="dash-accent" style="${px(180, 147, 190, 4)}"></div>
        <div class="dash-accent" style="${px(1565, 147, 190, 4)}"></div>
        <div class="l off" id="ind-ready" style="${px(529.28, 678.73, 100.674, 25)};filter:drop-shadow(0 0 4px rgba(66,194,241,.25))"><div class="dash-text dash-ready-text" style="left:0;top:0">READY</div><div class="l" style="inset:19.5% 0 30.24% 72.49%">${svg["ready-van"]}</div></div>
        ${L(px(1359.805, 596.68, 38.16, 45), "ind-door", "off ind-door")}
        ${L(px(548.75, 91.05, 35.27, 38.55), "ind-left", "off ind-left")}
        ${L(px(1345.97, 91.05, 35.27, 38.55), "ind-right", "off ind-right")}
        ${L(px(536.291, 594.88, 43.484, 48.594), "ind-seatbelt", "off ind-seatbelt")}
        <div class="l off ind-park" style="${px(1212.38, 97.55, 55.42, 25.97)};filter:drop-shadow(0 0 4px rgba(254,205,6,.25))">${L(pct([24.29, 34.32, 4.01, 35.84]), "ind-park-a")}${L(pct([0, 0, 0.04, 66.22]), "ind-park-b")}${L(pct([0, 64.71, 0, 0]), "ind-park-p")}</div>
        ${L(px(1144, 98, 49.676, 30.957), "ind-fcw", "off ind-fcw")}
        ${ctx("ctx-startup", 115, 198, "STARTUP", readySym, "Systems waking", "Preparing the driver display")}
        ${ctx("ctx-ready", 115, 205, "READY", readySym, "Ready to drive", "No active alerts")}
        ${ctx("ctx-door", 115, 219, "GENERAL DRIVER", sym("ctx-door", 67.84, 80), "Door open", "Close the door before driving")}
        ${ctx("ctx-left", 115, 219, "BLINKERS", sym("ctx-blinker", 73.193, 80), "Turning left", "Left turn signal active")}
        ${ctx("ctx-belt", 115, 219, "SEATBELT", sym("ctx-seatbelt", 71.588, 80), "Fasten seat belt", "Driver belt is unfastened")}
        ${ctx("ctx-park", 115, 219, "PARKING", parkSym, "Reverse selected", "Parking assistance active")}
        ${ctx("ctx-fcw", 115, 219, "WARNING SOUNDS", sym("ctx-fcw", 125, 77.898), "Collision risk", "Vehicle detected ahead")}
        ${ctx("ctx-info", 115, 219, "", `<div class="sym tint" style="width:80px;height:80px"></div>`, "", "")}
        ${ctx("ctx-right", 1470, 205, "BLINKERS", `<div class="sym" style="width:73.193px;height:80px;transform:rotate(180deg)">${svg["ctx-blinker"]}</div>`, "Turning right", "Right turn signal active")}
        <div class="dash-prox" id="dash-prox" style="${px(1470, 278, 340, 210)}"><div class="lab">PARKING ASSIST</div><div class="msg">Obstacle approaching</div><div class="bars"><i></i><i></i><i></i></div></div>
        <div class="dash-fcw" id="dash-fcw" style="${px(716.19, 318.44, 518.354, 221.991)}"><p>FORWARD COLLISION WARNING</p><div class="l icon">${svg["fcw-popup-icon"]}</div></div>
        <div class="dash-info-hit" data-info="lowbeam" style="${box([2.5, 54.9, 90.3, 40.9])}"></div>
        <div class="dash-info-hit" data-info="highbeam" style="${box([2.5, 50.2, 90.3, 45.6])}"></div>
        <div class="dash-info-hit" data-info="autobeam" style="${box([2.5, 45.5, 90.3, 50.3])}"></div>
        <div class="dash-info-hit" data-info="position" style="${box([2.5, 40.3, 90.3, 54.7])}"></div>
        <div class="dash-info-hit" data-info="signal" style="${box([2.5, 60, 90.3, 35.8])}"></div>
        <div class="dash-info-hit" data-info="lanes" style="${box([11.5, 60.2, 81.5, 35.7])}"></div>
        <div class="dash-info-hit" data-info="follow" style="${box([11.5, 56.2, 81.5, 39.7])}"></div>
        <div class="dash-info-hit" data-info="lanedep" style="${box([19.5, 56.6, 73.8, 40.1])}"></div>
        <div class="dash-info-hit" data-info="siderear" style="${box([11.5, 40.7, 81.5, 56.1])}"></div>
        <div class="dash-info-hit" data-info="sidefault" style="${box([19.5, 40.9, 73.8, 56.4])}"></div>
        <div class="dash-info-hit" data-info="obstacle" style="${box([11.5, 37.8, 81.5, 58.9])}"></div>
        <div class="dash-info-hit" data-info="parkaid" style="${box([12.5, 34, 82.3, 62])}"></div>
        <div class="dash-info-hit" data-info="ready" style="${px(520, 670, 120, 42)}"></div>
        <div class="dash-hit" data-hit="left" style="${px(530, 80, 75, 60)}"></div>
        <div class="dash-hit" data-hit="right" style="${px(1362, 80, 75, 60)}"></div>
        <div class="dash-hit" data-hit="speed" style="${px(840, 80, 250, 200)}"></div>
        <div class="dash-hit" data-hit="gear" style="${px(900, 650, 150, 75)}"></div>
        <div class="dash-hit" data-hit="clock" style="${px(580, 20, 110, 45)}"></div>
        <div class="dash-hit" data-hit="panel" style="${px(70, 150, 440, 330)}"></div>
      </div>
      <div class="dash-sheen"></div>`;
    this.root = root;
    // V4 alert animations from the Figma file (ODC ADAS alerts, 8 s each),
    // cropped to the cluster. They play over the live UI when an alert fires.
    const vid = (this.alertVid = document.createElement("video"));
    vid.className = "dash-alert";
    vid.muted = true;
    vid.playsInline = true;
    vid.preload = "auto";
    root.append(vid);
    this.alertState = { i: -1, until: 0, last: {} };
    const $ = (s) => root.querySelector(s);
    this.el = {
      speed: $(".dash-speed"),
      gear: $(".dash-gear"),
      clock: $(".dash-clock"),
      ready: $("#ind-ready"),
      door: $(".ind-door"),
      left: $(".ind-left"),
      right: $(".ind-right"),
      belt: $(".ind-seatbelt"),
      park: $(".ind-park"),
      fcw: $(".ind-fcw"),
      fcwPop: $("#dash-fcw"),
      prox: $("#dash-prox"),
      proxMsg: $("#dash-prox .msg"),
      bars: [...root.querySelectorAll("#dash-prox .bars i")],
      ctx: Object.fromEntries([...root.querySelectorAll(".dash-ctx")].map((e) => [e.id.slice(4), e])),
      tts: Object.fromEntries([...root.querySelectorAll(".dash-tt")].map((e) => [e.dataset.tt, e])),
      lowbeam: root.querySelectorAll(".lit")[0],
      highbeam: root.querySelectorAll(".lit")[1],
      autobeam: root.querySelectorAll(".lit")[2],
      position: root.querySelectorAll(".lit")[3],
    };
    // The mph label art is a vector; swap to a text label when showing km/h.
    this.el.unit = root.querySelector(".unit");
    this.el.unitText = document.createElement("div");
    this.el.unitText.className = "dash-text";
    this.el.unitText.style.cssText = `left:${965 - 60}px;top:${(31.22 * H) / 100 - 6}px;width:120px;text-align:center;font-size:24px;display:none`;
    this.el.unitText.textContent = "km/h";
    root.querySelector(".dash-ui").append(this.el.unitText);
    this.wire();
    // Presenter caption band (Figma "Presentation caption" frames).
    this.caption = document.createElement("div");
    this.caption.className = "dash-caption";
    this.caption.innerHTML = '<p class="brand">OSHKOSH / SCADpro SOUND STUDY</p><p class="title"></p><p class="reason"></p><p class="status"></p><p class="audio">AUDIO PENDING / Visual timing will follow the supplied sound files.</p><i class="bar"></i><div class="ctl"><button data-demo="next">Next example</button><button data-demo="replay">Replay example</button><button data-demo="end">All examples</button></div>';
    this.caption.addEventListener("click", (e) => {
      const b = e.target.closest("[data-demo]");
      if (!b || !this.demo) return;
      this.audio.event("click");
      const starts = [0, 5, 24, 47, 66, 85],
        t = this.demo.t;
      let cur = 0;
      starts.forEach((st, i) => t >= st - 0.01 && (cur = i));
      if (b.dataset.demo === "end") return this.stopDemo();
      const to = b.dataset.demo === "next" ? starts[(cur + 1) % starts.length] : starts[cur];
      if (to === 0) return this.playDemo();
      this.demo.t = to;
      this.state.t = Math.max(this.state.t, to);
      this.cueT = {};
      this.demoFinished = false;
      this.onDemo?.(true);
    });
    document.body.append(this.caption);
    this.object = new CSS3DObject(root);
    this.cssScene.add(this.object);
    this.buildPod();
    this.hideAnalogCluster();
  }
  // Show what a symbol is in the left panel for a few seconds.
  pick(key, el) {
    if (!key || !INFO[key]) return;
    this.selected = key;
    this.selectedTime = 5;
    this.pickedEl?.classList.remove("dash-picked");
    this.pickedEl = el;
    el?.classList.add("dash-picked");
  }
  // Interactions on the live UI (enabled in display focus mode).
  // Find the tappable element under a point in display pixels (0..W, 0..H).
  elementAt(x, y) {
    let best = null,
      area = Infinity;
    for (const el of this.root.querySelectorAll("[data-hit],[data-info]")) {
      const parts = el.classList.contains("dash-tt") ? [...el.children] : [el];
      for (const part of parts) {
        let lx = 0,
          ly = 0,
          n = part;
        while (n && n !== this.root) {
          lx += n.offsetLeft;
          ly += n.offsetTop;
          n = n.offsetParent;
        }
        const w = part.offsetWidth,
          h = part.offsetHeight,
          pad = 6;
        if (x >= lx - pad && x <= lx + w + pad && y >= ly - pad && y <= ly + h + pad && w * h < area) {
          area = w * h;
          best = el;
        }
      }
    }
    return best;
  }
  // The display sits on a CSS 3D layer behind the canvas, where the browser's
  // own hit testing is unreliable. Clicks are ray-cast onto the glass instead.
  tap(clientX, clientY) {
    const cam = this.lastCamera;
    if (!cam || !this.glass) return false;
    const rc = (this._rc ||= new T.Raycaster()),
      ndc = new T.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    rc.setFromCamera(ndc, cam);
    const hit = rc.intersectObject(this.glass, false)[0];
    if (!hit?.uv) return false;
    const el = this.elementAt(hit.uv.x * W, (1 - hit.uv.y) * H);
    if (el) this.activate(el);
    return !!el;
  }
  wire() {
    window.addEventListener(
      "click",
      (e) => {
        if (!this.focus || e.target.closest("button,.dash-caption,.dash-controls")) return;
        this.tap(e.clientX, e.clientY);
      },
      true,
    );
  }
  activate(hit) {
    {
      this.audio.event("click");
      if (hit.dataset.info) {
        this.pick(hit.dataset.info, hit);
        return;
      }
      const h = hit.dataset.hit;
      this.pick({ left: "turn", right: "turn", speed: "speed", gear: "gear", clock: null, panel: null }[h], null);
      if (h === "left") this.actions.left();
      else if (h === "right") this.actions.right();
      else if (h === "speed") this.units = this.units === "mph" ? "kmh" : "mph";
      else if (h === "clock") this.clock24 = !this.clock24;
      else if (h === "gear") {
        const order = ["P", "R", "N", "D"],
          g = this.lastInput?.gear || "P";
        this.actions.gear(order[(order.indexOf(g) + 1) % 4]);
      } else if (h === "panel") {
        this.selected = null;
        this.cycle = (this.cycle || 0) + 1;
      }
    }
  }
  // Display pod sitting low on the dash top: housing, short foot, visor and glass.
  buildPod() {
    const w = 0.56,
      h = (w * H) / W,
      group = new T.Group(),
      mat = this.toon(new T.MeshToonMaterial({ color: 0x2c3132 })),
      edge = this.toon(new T.MeshToonMaterial({ color: 0x1b1e1f }));
    // Sits on the dash top (y 0.625) ahead of the wheel and is read through
    // the upper half of the rim, like a car's cluster; the windshield stays clear.
    const center = new T.Vector3(-1.58, 0.79, -0.53),
      eye = new T.Vector3(-0.72, 1.2, -0.53);
    group.position.copy(center);
    // Face the driver's eyes in body space.
    const q = new T.Quaternion().setFromRotationMatrix(new T.Matrix4().lookAt(eye, center, new T.Vector3(0, 1, 0)));
    group.quaternion.copy(q);
    const RoundedBox = (bw, bh, bd, r, m) => {
      const s = new T.Shape(),
        x = -bw / 2,
        y = -bh / 2;
      s.moveTo(x + r, y);
      s.lineTo(x + bw - r, y);
      s.quadraticCurveTo(x + bw, y, x + bw, y + r);
      s.lineTo(x + bw, y + bh - r);
      s.quadraticCurveTo(x + bw, y + bh, x + bw - r, y + bh);
      s.lineTo(x + r, y + bh);
      s.quadraticCurveTo(x, y + bh, x, y + bh - r);
      s.lineTo(x, y + r);
      s.quadraticCurveTo(x, y, x + r, y);
      const g = new T.ExtrudeGeometry(s, { depth: bd, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 3, curveSegments: 6 });
      g.translate(0, 0, -bd);
      const mesh = new T.Mesh(g, m);
      mesh.castShadow = mesh.receiveShadow = true;
      return mesh;
    };
    const housing = RoundedBox(w + 0.05, h + 0.05, 0.045, 0.022, mat);
    housing.position.z = -0.004;
    const bezel = RoundedBox(w + 0.016, h + 0.016, 0.006, 0.012, edge);
    bezel.position.z = 0.002;
    const visor = new T.Mesh(new T.BoxGeometry(w + 0.05, 0.012, 0.075), mat);
    visor.position.set(0, h / 2 + 0.027, 0.02);
    visor.rotation.x = -0.12;
    visor.castShadow = true;
    // Short foot down to the dashboard top.
    const stalk = new T.Mesh(new T.CylinderGeometry(0.03, 0.045, 0.07, 16), mat);
    stalk.position.set(0, -h / 2 - 0.03, -0.03);
    stalk.castShadow = true;
    // The glass: writes transparent pixels so the live DOM layer shows through.
    this.glass = new T.Mesh(
      new T.PlaneGeometry(w, h),
      new T.MeshBasicMaterial({ color: 0x000000, opacity: 0, blending: T.NoBlending, toneMapped: false, fog: false }),
    );
    this.glass.position.z = 0.0105; // just proud of the bezel face, or the bezel hides it
    this.glass.name = "Driver display";
    group.add(housing, bezel, visor, stalk, this.glass);
    this.pod = group;
    this.vehicle.add(group);
    this.screenSize = { w, h };
    this.base = group.position.clone();
  }
  // The new display replaces the analog dials in the binnacle.
  hideAnalogCluster() {
    const hide = /^(Instrument smoked dial|Instrument gauge tick|Instrument brushed bezel|Needle spindle|Central instrument display)/;
    this.rig.meshes.forEach((m, mi) => {
      const spec = this.rig.data.meshes[mi],
        a = m.geometry.attributes.position;
      let changed = false;
      for (const r of spec.ranges || [])
        if (hide.test(r.object)) {
          a.array.fill(0, r.start * 3, (r.start + r.count) * 3);
          changed = true;
        }
      if (changed) a.needsUpdate = true;
    });
    for (const b of ["GAUGE_NEEDLE_1", "GAUGE_NEEDLE_2"]) if (this.rig.bones[b]) this.rig.bones[b].pose.visible = false;
  }
  // While the camera moves, Chrome keeps one raster of the display and just
  // transforms it (no re-raster each frame, which flashed blank tiles). Once
  // the focus view settles, it re-rasters once at full sharpness.
  setSettled(on) {
    this.root?.classList.toggle("moving", !on);
  }
  setFocus(on) {
    this.focus = on;
    if (!on) this.stopDemo();
    document.body.classList.toggle("dash-focus", on);
  }
  // Camera pose that frames the display straight on (for focus mode).
  focusPose(aspect, fov) {
    this.pod.updateWorldMatrix(true, false);
    const c = new T.Vector3(),
      n = new T.Vector3(0, 0, 1);
    this.glass.getWorldPosition(c);
    n.applyQuaternion(this.glass.getWorldQuaternion(new T.Quaternion()));
    const { w, h } = this.screenSize;
    let vfov = (fov * Math.PI) / 180;
    const
      // During the presentation a caption band covers the bottom of the view
      // (354 / 1086 of the Figma frame); fit the screen in what's left.
      band = (this.band || 0) * Math.min((0.1834 * innerWidth) / innerHeight, 0.32),
      free = 1 - band,
      fit = (f) => Math.max(h / 2 / Math.tan(f / 2) / free, w / 2 / (Math.tan(f / 2) * aspect)) * 1.08;
    // Tall windows would push the camera back through the cab: widen the lens instead.
    let dist = fit(vfov);
    if (dist > 0.62) {
      const need = Math.max((h / 2) * 1.08 / free, ((w / 2) * 1.08) / aspect);
      vfov = 2 * Math.atan(need / 0.62);
      dist = 0.62;
    }
    const
      up = new T.Vector3(0, 1, 0).applyQuaternion(this.glass.getWorldQuaternion(new T.Quaternion())),
      shift = band * dist * Math.tan(vfov / 2),
      look = c.clone().addScaledVector(up, -shift);
    return { pos: look.clone().addScaledVector(n, dist), look, fov: (vfov * 180) / Math.PI };
  }
  // Sensor ray; floors and ramp surfaces (upward-facing hits) are not obstacles.
  raycast(origin, dir, max) {
    this.ray.origin = origin;
    this.ray.dir = dir;
    const hit = this.physics.world.castRayAndGetNormal(this.ray, max, true, undefined, undefined, this.physics.chassis, this.physics.body);
    if (!hit || hit.normal.y > 0.55) return Infinity;
    return hit.timeOfImpact;
  }
  // Forward collision and rear parking sensors, in body space.
  sensors(st) {
    const q = this.vehicle.quaternion,
      p = this.vehicle.position,
      fwd = new T.Vector3(-1, 0, 0).applyQuaternion(q),
      out = { ahead: Infinity, behind: Infinity };
    for (const z of [-0.8, 0, 0.8]) {
      const o = new T.Vector3(-3.0, -0.35, z).applyQuaternion(q).add(p);
      out.ahead = Math.min(out.ahead, this.raycast(o, fwd, 45));
      const ob = new T.Vector3(2.9, -0.45, z).applyQuaternion(q).add(p);
      out.behind = Math.min(out.behind, this.raycast(ob, fwd.clone().negate(), 4));
    }
    return out;
  }
  // Show V4 alert animation i at time t (seconds into its 8 s clip).
  // Called every frame by the film; null hides it.
  showAlert(i, t = null) {
    const v = this.alertVid;
    if (!v) return;
    if (i == null || i < 0) {
      v.classList.remove("on");
      v.dataset.shown = "";
      if (this.alertState.i >= 0 && !v.paused) setTimeout(() => !v.classList.contains("on") && v.pause(), 400);
      this.alertState.i = -1;
      return;
    }
    if (this.alertState.i !== i) {
      this.alertState.i = i;
      v.src = "./assets/alerts/a" + i + (v.canPlayType('video/mp4; codecs="avc1.640028"') ? ".mp4" : ".webm");
      v.load();
    }
    // Fade in once the first frame is decoded, then stay on (no toggling
    // while it seeks or buffers, which read as flicker).
    if (v.readyState >= 2 || v.dataset.shown === String(i)) {
      v.classList.add("on");
      v.dataset.shown = String(i);
    }
    if (t != null) {
      // Scripted: follow the film clock by nudging the playback rate; only
      // hard-seek on a real jump (scrubbing, chapter skips).
      const drift = t - v.currentTime;
      if (v.readyState >= 1 && (Math.abs(drift) > 0.6 || (this.filmPlaying === false && Math.abs(drift) > 0.05))) v.currentTime = Math.min(7.98, Math.max(0, t));
      else v.playbackRate = Math.min(1.08, Math.max(0.92, 1 + drift * 0.6));
      if (this.filmPlaying !== false && v.paused && t < 7.95) v.play().catch(() => {});
      if ((this.filmPlaying === false || t >= 7.95) && !v.paused) v.pause();
    } else if (v.paused) {
      v.currentTime = 0;
      v.play().catch(() => {});
    }
  }
  // Live driving: fire an alert clip on the rising edge of a state, at most every 25 s each.
  liveAlert(i, on) {
    const a = this.alertState,
      now = performance.now() / 1000;
    if (on && !a.prev?.[i] && now - (a.last[i] || -99) > 25 && a.i < 0) {
      a.last[i] = now;
      a.until = now + 8;
      this.showAlert(i);
    }
    (a.prev ||= {})[i] = on;
  }
  chime(kind, every) {
    const now = performance.now() / 1000;
    if (now - (this.lastChime[kind] || 0) < every) return;
    this.lastChime[kind] = now;
    this.audio.chime?.(kind);
  }
  // The Figma "02 CONTINUOUS" presentation, 1 m 46 s: startup, five cues with
  // 15-second discussion pauses, then the completion state. Times in seconds.
  static DEMO = {
    length: 106,
    captions: [
      [0, "Startup / Ready", "The display wakes, then settles into an idle state.", "CONTINUOUS PLAY / Five sound examples"],
      [5, "01 / General Driver / Door open", "Door left open. The red warning flashes to draw attention.", "WATCH THE CUE / 4 seconds"],
      [9, "01 / General Driver / Door open", "Door left open. The red warning flashes to draw attention.", "DISCUSSION PAUSE / 15 seconds"],
      [24, "02 / Blinkers / Left + right", "One blinker sound, demonstrated left first and then right.", "WATCH THE CUE / 4 seconds"],
      [28, "02 / Blinkers / Left + right", "The same blinker sound now accompanies the right arrow.", "WATCH THE CUE / 4 seconds"],
      [32, "02 / Blinkers / Left + right", "The same blinker sound now accompanies the right arrow.", "DISCUSSION PAUSE / 15 seconds"],
      [47, "03 / Seatbelt / Unfastened", "A repeating reminder asks the driver to fasten the belt.", "WATCH THE CUE / 4 seconds"],
      [51, "03 / Seatbelt / Unfastened", "A repeating reminder asks the driver to fasten the belt.", "DISCUSSION PAUSE / 15 seconds"],
      [66, "04 / Parking / Obstacle approaching", "The proximity display builds as the obstacle gets closer.", "WATCH THE CUE / 4 seconds"],
      [70, "04 / Parking / Obstacle approaching", "The proximity display builds as the obstacle gets closer.", "DISCUSSION PAUSE / 15 seconds"],
      [85, "05 / Warning / Forward collision", "The red popup signals a collision risk ahead.", "WATCH THE CUE / 4 seconds"],
      [89, "05 / Warning / Forward collision", "The red popup signals a collision risk ahead.", "DISCUSSION PAUSE / 15 seconds"],
      [104, "Sequence complete", "All five examples reviewed. Both blinker directions share one sound example.", "READY TO REPLAY"],
    ],
  };
  // Jump the presentation to a time (tests and the presenter controls).
  seekDemo(t) {
    if (!this.demo) this.playDemo();
    this.demo.t = t;
    this.state.t = Math.max(this.state.t, t);
    this.cueT = {};
  }
  playDemo() {
    this.demo = { t: 0 };
    this.state.on = false; // replay the wake-up from black
    this.restartPower = true;
    document.body.classList.add("dash-demo");
    this.captionAt = -1;
    this.onDemo?.(true);
  }
  stopDemo() {
    if (!this.demo) return;
    this.demo = null;
    document.body.classList.remove("dash-demo");
    this.onDemo?.(false);
  }
  // Scripted vehicle state for the presentation timeline.
  demoState(t) {
    const cue = (a, b) => t >= a && t < b,
      phase = (a) => (t - a) % 1 < 0.5;
    return {
      powered: true,
      speed: cue(85, 89) ? 35 / 2.23694 : 0,
      gear: cue(66, 70) ? "R" : cue(85, 89) ? "D" : "P",
      blinkL: cue(24, 28) && phase(24),
      blinkR: cue(28, 32) && phase(28),
      hazards: false,
      doors: cue(5, 9),
      belted: !cue(47, 51),
      behind: t < 67.25 ? 2.5 : t < 68.5 ? 1.5 : 0.6,
      ahead: Infinity,
      fcw: cue(85, 89),
      handbrake: false,
      lights: false,
      // Between cues the left panel rests empty, as in the Figma timeline.
      idle: t < 5 ? "auto" : t >= 89 ? "done" : "none",
    };
  }
  setCaption(t) {
    const caps = Dashboard.DEMO.captions;
    let i = 0;
    while (i + 1 < caps.length && t >= caps[i + 1][0]) i++;
    const c = this.caption;
    if (c && i !== this.captionAt) {
      this.captionAt = i;
      const [, title, reason, status] = caps[i];
      c.querySelector(".title").textContent = title;
      c.querySelector(".reason").textContent = reason;
      c.querySelector(".status").textContent = status;
    }
    if (c) c.querySelector(".bar").style.width = (Math.min(1, t / Dashboard.DEMO.length) * 100).toFixed(2) + "%";
  }
  // Show or hide a context panel with the Figma motion: enter from +14 px
  // (0.28 s fade, 0.38 s rise), leave upward to -7 px in 0.25 s.
  showCtx(e, on, from = 14) {
    const shown = e.classList.contains("show");
    if (on === shown) return;
    if (on) {
      e.classList.remove("was");
      e.style.transition = "none";
      e.style.translate = `0 ${from}px`;
      e.offsetWidth;
      e.style.transition = e.style.translate = "";
      e.classList.add("show");
    } else {
      e.classList.remove("show");
      e.classList.add("was");
    }
  }
  // A cue flashes on the Figma cadence for its first four seconds, then holds.
  cue(key, active, el, cls, dt) {
    this.cueT ||= {};
    this.cueT[key] = active ? (this.cueT[key] || 0) + dt : 0;
    el.classList.toggle(cls, active && this.cueT[key] < 4);
  }
  // Per frame: s = { dt, ignition, gear, speed, signal, hazards, blinkL, blinkR, lights, handbrake }
  update(s) {
    if (!this.root) return;
    const el = this.el,
      d = this.damage,
      rig = this.rig,
      dt = s.dt;
    // Live vehicle state, or the scripted presentation when it is playing.
    let v;
    if (this.demo) {
      this.demo.t += dt;
      if (this.demo.t >= Dashboard.DEMO.length) {
        this.demo.t = Dashboard.DEMO.length;
        this.demoDone = true;
      }
      v = this.demoState(this.demo.t);
      this.setCaption(this.demo.t);
      if (this.demoDone) {
        this.demoDone = false;
        this.demoEnd?.();
      }
    } else {
      const doors = ["DOOR_L", "DOOR_R", "REAR_DOOR", "HOOD"].some((b) => rig.get(b, "Open") > 0.04 && !d.detached.has(b === "DOOR_L" ? "Left door" : b === "DOOR_R" ? "Right door" : b === "HOOD" ? "Hood" : "x"));
      const sens = this.sensors(s);
      if (this.sim) Object.assign(sens, this.sim); // test hook: { ahead, behind, fcw }
      v = {
        powered: s.ignition && !this.fault,
        speed: s.speed,
        gear: s.gear,
        blinkL: s.blinkL > 0.5,
        blinkR: s.blinkR > 0.5,
        hazards: s.hazards,
        doors,
        belted: rig.get("SEATBELT", "Fasten") > 0.6,
        behind: sens.behind,
        ahead: sens.ahead,
        fcw: !!sens.fcw,
        handbrake: s.handbrake,
        lights: s.lights,
        idle: "auto",
      };
    }
    this.lastInput = { ...s, gear: v.gear };
    // Power and the startup flow: display off -> waking (0.7 s) -> vehicle in position -> ready (2.5 s).
    const powered = v.powered;
    if (powered !== this.state.on) {
      this.state.on = powered;
      this.state.t = 0;
      this.root.classList.remove("dash-on");
      if (powered) {
        this.root.offsetWidth; // restart the startup animations
        this.root.classList.add("dash-on");
        this.chime("start", 0.5);
      }
    }
    this.state.t += dt;
    const t = this.state.t,
      ready = powered && t > 2.5;
    el.ready.classList.toggle("off", !(powered && t > 1.65));
    // Readouts.
    const speed = Math.abs(v.speed);
    el.speed.textContent = Math.round(this.units === "mph" ? speed * 2.23694 : speed * 3.6);
    el.unit.style.opacity = this.units === "mph" ? 1 : 0;
    el.unitText.style.display = this.units === "mph" ? "none" : "block";
    el.gear.textContent = v.gear;
    const now = new Date(),
      hh = this.clock24 ? now.getHours() : now.getHours() % 12 || 12;
    el.clock.textContent = (this.clock24 ? String(hh).padStart(2, "0") : hh) + ":" + String(now.getMinutes()).padStart(2, "0");
    el.lowbeam.style.opacity = v.lights ? 1 : "";
    el.position.style.opacity = powered ? 1 : "";
    // Forward collision: time-to-collision under 1.5 s in Drive, held for a second.
    const closing = v.speed > 4 ? v.ahead / v.speed : Infinity;
    if (ready && ((v.gear === "D" && closing < 1.5 && v.ahead < 32) || v.fcw)) this.fcwHold = this.demo ? 0.05 : 1.0;
    else this.fcwHold = Math.max(0, this.fcwHold - dt);
    const fcw = this.fcwHold > 0,
      reverse = ready && v.gear === "R",
      doors = v.doors,
      belted = v.belted;
    // Indicators.
    this.lHold = v.blinkL ? 0.9 : Math.max(0, (this.lHold || 0) - dt);
    this.rHold = v.blinkR ? 0.9 : Math.max(0, (this.rHold || 0) - dt);
    if (this.demo) this.lHold = v.blinkL || (this.demo.t >= 24 && this.demo.t < 28) ? 0.01 : 0;
    if (this.demo) this.rHold = this.demo.t >= 28 && this.demo.t < 32 ? 0.01 : 0;
    el.left.classList.toggle("off", !(ready && v.blinkL));
    el.right.classList.toggle("off", !(ready && v.blinkR));
    el.door.classList.toggle("off", !(ready && doors));
    this.cue("door", ready && doors, el.door, "d-cue-door", dt);
    el.belt.classList.toggle("off", !(ready && !belted));
    this.cue("belt", ready && !belted, el.belt, "d-cue-belt", dt);
    el.park.classList.toggle("off", !reverse);
    el.fcw.classList.toggle("off", !fcw);
    el.fcw.classList.toggle("d-cue-fcw", fcw);
    el.fcwPop.classList.toggle("show", fcw);
    // Context symbols follow the same cues.
    const ctxSym = (k) => el.ctx[k].querySelector(".sym");
    this.cue("door-sym", ready && doors, ctxSym("door"), "d-cue-door-sym", dt);
    this.cue("belt-sym", ready && !belted, ctxSym("belt"), "d-cue-belt-sym", dt);
    ctxSym("fcw").classList.toggle("d-cue-fcw-ctx", fcw);
    ctxSym("left").style.opacity = v.blinkL ? 1 : 0.15;
    ctxSym("right").style.opacity = v.blinkR ? 1 : 0.15;
    // Parking proximity: far, closer, near. The P symbol flashes faster as you close in.
    this.showCtx(el.prox, reverse, 8);
    if (reverse) {
      const b = v.behind;
      el.bars.forEach((bar, i) => bar.classList.toggle("on", b < [3, 1.8, 0.9][i]));
      el.proxMsg.textContent = b < 3 ? "Obstacle approaching" : "Path clear";
      el.park.style.setProperty("--pp", b < 0.9 ? "0.4s" : b < 1.8 ? "0.75s" : "1.5s");
      el.park.classList.toggle("d-cue-park", b < 3);
      if (b < 3) this.chime(b < 0.9 ? "park-near" : "park", b < 0.9 ? 0.12 : b < 1.8 ? 0.35 : 0.7);
    } else el.park.classList.remove("d-cue-park");
    // Real-world tell-tales.
    const soft = d.soft,
      health = d.health,
      wheel = this.physics.wheelDamage,
      live = !this.demo,
      lit = {
        brake: ready && v.handbrake,
        epb: live && ready && v.gear === "P",
        belt: ready && !belted,
        door: ready && doors,
        power: live && ready && this.physics.power < 0.6,
        coolant: live && ready && health.front < 0.55,
        battery: live && ready && this.physics.power < 0.3,
        airbag: live && ready && (this.airbag || false),
        lamp: live && ready && ["Left headlamp", "Right headlamp", "Left tail lamp", "Right tail lamp"].some((x) => d.detached.has(x)),
        esc: live && ready && (this.physics.skid || 0) > 2.2 && speed > 3,
        traction: live && ready && this.physics.wheelEnabled.some((e) => !e),
        steering: live && ready && Math.max(wheel[0], wheel[1]) > 0.35,
        abs: live && ready && Math.max(...wheel) > 0.3,
        tire: live && ready && (Math.max(...wheel) > 0.5 || this.physics.wheelEnabled.some((e) => !e)),
        service: live && ready && d.level > 0.25,
      };
    if (live && ready && d.lastImpact !== this.seenImpact) {
      this.seenImpact = d.lastImpact;
      if (d.level > 0.45) this.airbag = true;
    }
    const red = { brake: 1, epb: 1, belt: 1, door: 1, airbag: 1, coolant: 1, battery: 1 };
    for (const [k, e] of Object.entries(el.tts)) {
      const on = !!lit[k];
      if (e.classList.contains("on") !== on) {
        e.classList.toggle("on", on);
        e.style.setProperty("--tt", red[k] ? "#ce0500" : "#fecd06");
        e.style.setProperty("--tt-glow", red[k] ? "rgba(206,5,0,.35)" : "rgba(254,205,6,.3)");
      }
      e.classList.toggle("dash-flash", on && k === "esc");
    }
    // Left context panel: the most important thing right now.
    this.selectedTime = Math.max(0, this.selectedTime - dt);
    let left = null,
      right = null;
    if (!powered) left = null;
    else if (t < 2.5) left = t > 0.7 ? "startup" : null;
    else if (!this.demo && this.selectedTime > 0 && this.selected) left = "info";
    else if (fcw) left = "fcw";
    else if (doors) left = "door";
    else if (!belted) left = "belt";
    else if (reverse) left = "park";
    else if (this.lHold > 0 && !(v.hazards && this.rHold > 0 && s.signal === 0)) left = "left";
    else if (v.idle === "none") left = null;
    else left = "ready";
    if (powered && t > 2.5 && this.rHold > 0 && !reverse) right = "right";
    const det = el.ctx.ready.querySelector(".det");
    det.textContent = v.idle === "done" ? "Demonstration complete" : "No active alerts";
    if (left === "info") {
      const [lab, name, onText, offText, art] = INFO[this.selected],
        c = el.ctx.info,
        ttEl = el.tts[this.selected],
        on = ttEl
          ? ttEl.classList.contains("on")
          : { lowbeam: !!v.lights, position: powered, turn: v.blinkL || v.blinkR, parkaid: reverse, obstacle: fcw, ready, signal: true, speed: true, gear: true }[this.selected] || false;
      c.querySelector(".lab").textContent = lab;
      c.querySelector(".tit").textContent = name;
      c.querySelector(".det").textContent = on ? onText : offText;
      const symEl = c.querySelector(".sym");
      if (symEl.dataset.k !== this.selected) {
        symEl.dataset.k = this.selected;
        const src = art && this.svg[art],
          vb = src && src.match(/viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/);
        symEl.innerHTML = src ? src.replace(/opacity="0\.\d+"/g, "") : `<div style="font:700 56px Inter,sans-serif;line-height:64px">${v.gear}</div>`;
        symEl.style.height = "64px";
        symEl.style.width = (vb ? Math.min(150, (64 * vb[1]) / vb[2]) : 64) + "px";
      }
      symEl.style.color = on ? (ttEl && ttEl.style.getPropertyValue("--tt")) || "#42c2f1" : "#96a6ab";
    } else if (this.pickedEl) {
      this.pickedEl.classList.remove("dash-picked");
      this.pickedEl = null;
    }
    for (const [k, e] of Object.entries(el.ctx)) this.showCtx(e, k === left || k === right);
    // Chimes that follow the Figma sound study states.
    if (ready && doors && (speed > 0.5 || this.demo)) this.chime("door", 1.0);
    if (ready && !belted && (speed > 2.5 || this.demo)) this.chime("belt", 1.5);
    if (fcw) this.chime("fcw", 0.9);
    // V4 alert animations while driving (the film drives them itself).
    if (live && !this.filmControl) {
      this.liveAlert(1, ready && doors && speed > 0.5);
      this.liveAlert(3, ready && !belted && speed > 2.5);
      this.liveAlert(5, fcw);
      this.liveAlert(2, ready && (v.blinkL || v.blinkR) && !v.hazards);
      this.liveAlert(4, ready && reverse && v.behind < 3);
      if (this.alertState.i >= 0 && performance.now() / 1000 > this.alertState.until) this.showAlert(null);
    }
    if (this.demo && ready && (v.blinkL || v.blinkR) !== this.lastTick) {
      this.lastTick = v.blinkL || v.blinkR;
      this.audio.event?.("tick");
    }
    // Display fault: a heavily crushed dash kills the screen.
    if (live) {
      const dashDisp = soft.sample(this.base, new T.Vector4());
      const fault = Math.hypot(dashDisp.x, dashDisp.y, dashDisp.z) > 0.16;
      if (fault !== !!this.fault) {
        this.fault = fault;
        this.root.classList.toggle("dash-fault", fault);
      }
    }
    // Presenter caption band pushes the screen up in focus view.
    const bandTarget = this.demo && this.focus ? 1 : 0;
    this.band = T.MathUtils.damp(this.band || 0, bandTarget, 6, dt);
    this.band_moving = Math.abs(this.band - bandTarget) > 0.003;
  }
  // Place the DOM exactly on the glass and render the CSS layer. Called right
  // before the WebGL render, after the camera has moved, so they never drift.
  //
  // CSS 3D maps one world unit to one CSS pixel, so a 0.68 m screen became a
  // 0.68 px element scaled up 2800x, viewed through a camera hundreds of
  // "pixels" from the origin. Chrome's compositor loses precision on that and
  // intermittently drops the layer (the black flicker). Instead the CSS scene
  // is rendered camera-relative and scaled so the display is its natural
  // 1930 px: same projection, well-conditioned numbers.
  render(camera) {
    if (!this.root) return;
    this.lastCamera = camera;
    this.glass.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    const K = W / this.screenSize.w,
      ortho = !!camera.isOrthographicCamera;
    if (!this.cssCam || this.cssCam.isOrthographicCamera !== ortho) this.cssCam = ortho ? new T.OrthographicCamera() : new T.PerspectiveCamera();
    const cam = this.cssCam;
    if (ortho) {
      // Same frustum, in the scaled CSS world.
      for (const k of ["left", "right", "top", "bottom"]) cam[k] = camera[k] * K;
      cam.zoom = camera.zoom;
      cam.near = camera.near * K;
      cam.far = camera.far * K;
      cam.updateProjectionMatrix();
    } else {
      cam.projectionMatrix.copy(camera.projectionMatrix);
      cam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    }
    camera.matrixWorld.decompose(this._cp || (this._cp = new T.Vector3()), cam.quaternion, this._cs || (this._cs = new T.Vector3()));
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld(true);
    const gp = new T.Vector3(),
      gq = new T.Quaternion(),
      gs = new T.Vector3();
    this.glass.matrixWorld.decompose(gp, gq, gs);
    this.object.position.copy(gp.sub(this._cp).multiplyScalar(K));
    this.object.quaternion.copy(gq);
    this.object.scale.set(gs.x, gs.y, 1);
    this.object.updateMatrixWorld(true);
    this.css.render(this.cssScene, cam);
  }
  // Exploded view: the pod travels with the dashboard it sits on.
  setExplode(offset) {
    if (this.pod) this.pod.position.copy(this.base).add(offset);
  }
  resize(w, h) {
    this.css.setSize(w, h);
  }
  // Replays the display's wake-up sequence (used by the walkthrough).
  restartStartup() {
    this.state.on = false;
  }
  repair() {
    this.airbag = false;
    this.fault = false;
    this.root?.classList.remove("dash-fault");
  }
}
