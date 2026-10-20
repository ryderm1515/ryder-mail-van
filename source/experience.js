import { ZONES } from "./world.js";
export function enhanceExperience(ui, rig, actions, world, damage) {
  const $ = (id) => document.getElementById(id);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<section id="start-menu" class="start-menu"><p class="start-kicker">THE DRIVING PLAYGROUND</p><h1>Test ground.</h1><p class="start-description">Drive it. Open it. Break it. Put it back together.</p><button id="start-drive" class="start-drive"><span>Drive</span><span id="start-play"></span></button><button id="start-explore" class="start-explore">Explore the van</button><button id="start-tour" class="start-explore">Watch the walkthrough</button><button id="start-film" class="start-explore">Morning route</button><div id="start-destinations" class="start-destinations"></div><p class="start-hint">W A S D to drive · Shift to boost</p></section><section id="quick-panel" class="surface quick-panel" hidden aria-label="Quick vehicle interactions"><div class="panel-head"><span class="panel-title">Hands on</span><button id="quick-close" aria-label="Close quick interactions" data-tip="Close"></button></div><div id="quick-grid"></div><div class="quick-footer"><button id="quick-advanced" data-tip="All 154 rig controls" aria-label="All 154 rig controls"></button><button id="quick-demo" data-tip="Preview moving mechanisms" aria-label="Preview moving mechanisms" aria-pressed="false"></button><span>Click an action. Drag a part.</span></div></section><section id="world-panel" class="surface world-panel" hidden aria-label="Choose a test ground"><div class="panel-head"><span class="panel-title">Go somewhere.</span><button id="world-close" aria-label="Close test grounds"></button></div><div id="zone-grid"></div><div class="world-footer"><button id="delivery-run" aria-label="Delivery route" data-tip="Three-stop delivery route"></button><div id="zone-hint">Ten places to play.</div></div></section><div class="surface utility-dock"><button id="hand-tool" data-tip="Grab and pull · G" aria-label="Grab and pull" aria-pressed="false"></button><button id="repair-car" data-tip="Repair vehicle · Backspace" aria-label="Repair vehicle"></button><button id="slow-motion" data-tip="Slow motion · Z" aria-label="Slow motion" aria-pressed="false"></button><span class="divider"></span><button id="boost" data-tip="Hold to boost · Shift" aria-label="Hold to boost"></button></div><div id="activity" class="activity" hidden><span id="activity-name"></span><strong id="activity-value"></strong></div><div id="part-hover" class="part-hover" hidden><strong></strong><span></span></div>`,
  );
  document.body.classList.add("starting");
  for (const e of document.querySelectorAll(".topbar,.dock,.telemetry,.utility-dock,.touch-drive"))
    e.inert = true;
  let start = true,
    quick = false,
    demo = false;
  const icon = ui.icon;
  for (const [id, name] of Object.entries({
    "delivery-run": "truck",
    "start-play": "arrow-right",
    "quick-close": "x",
    "world-close": "x",
    "quick-advanced": "adjustments-horizontal",
    "quick-demo": "player-play",
    "hand-tool": "hand-grab",
    "repair-car": "tools",
    "slow-motion": "player-pause",
    boost: "bolt",
  }))
    icon(id, name);
  icon("course", "map");
  $("course").setAttribute("aria-label", "Choose a test ground");
  $("course").dataset.tip = "Test grounds · T";
  const parts = [
    ["Left door", "door-enter", "DOOR_L", "Open"],
    ["Right door", "door-exit", "DOOR_R", "Open"],
    ["Rear shutter", "chevrons-up", "REAR_DOOR", "Open"],
    ["Hood", "bolt", "HOOD", "Open"],
    ["Left window", "window", "WINDOW_L", "Lower"],
    ["Right window", "window", "WINDOW_R", "Lower"],
    ["Partition", "layout-board", "PARTITION", "Open"],
    ["Seatbelt", "lock", "SEATBELT", "Fasten"],
    ["Left shelving", "package", "SHELF_L_1", "Fold"],
    ["Right shelving", "package", "SHELF_R_1", "Fold"],
    ["Mirrors", "eye", "MIRROR_L", "Fold"],
    ["Glovebox", "door", "GLOVEBOX", "Open"],
  ];
  function togglePart(b, k) {
    if (Math.abs(world.physics.speed) > 1 && /DOOR|HOOD|REAR|SHELF/.test(b)) {
      ui.toast("Stop before opening this part");
      return;
    }
    const c = rig.controls.find((c) => c.bone === b && c.name === k);
    if (!c) return;
    const value = rig.targets[c.id] > 0.5 ? c.min : c.max;
    rig.set(b, k, value, true);
    actions.interaction(c, value);
    if (b === "MIRROR_L") rig.set("MIRROR_R", k, value, true);
    update();
  }
  for (const [label, i, b, k] of parts) {
    const button = document.createElement("button");
    button.dataset.tip = label;
    button.setAttribute("aria-label", label);
    button.dataset.part = b + "|" + k;
    icon(button, i);
    button.onclick = () => togglePart(b, k);
    $("quick-grid").append(button);
  }
  function closeStart(mode = "drive") {
    if (!start) return;
    start = false;
    document.body.classList.remove("starting");
    for (const e of document.querySelectorAll(".topbar,.dock,.telemetry,.utility-dock,.touch-drive"))
      e.inert = false;
    $("start-menu").hidden = true;
    if (mode === "drive") {
      actions.drive();
      actions.setCamera(1);
    } else if (mode === "tour" || mode === "film") {
      // The walkthrough or the film takes over the screen.
    } else {
      quick = true;
      $("quick-panel").hidden = false;
    }
    if (mode !== "tour" && mode !== "film")
      ui.toast(
      mode === "drive"
        ? "W to go · S to brake · Shift boosts · C changes camera"
        : "Hover to preview. Use the hand to drag parts.",
    );
  }
  function zones() {
    const open = $("world-panel").hidden;
    $("world-panel").hidden = !open;
    $("quick-panel").hidden = true;
    quick = false;
    ui.press("course", open);
  }
  function go(id) {
    closeStart("explore");
    $("world-panel").hidden = true;
    $("quick-panel").hidden = true;
    quick = false;
    ui.press("course", false);
    actions.teleport(id);
  }
  for (const z of ZONES) {
    const b = document.createElement("button");
    icon(b, z.icon);
    b.dataset.tip = z.name;
    b.setAttribute("aria-label", "Teleport to " + z.name);
    b.onclick = () => go(z.id);
    b.onpointerenter = b.onfocus = () => {
      $("zone-hint").textContent = z.name + " · " + z.hint;
    };
    $("zone-grid").append(b);
    if (["garage", "interstate", "jump", "crash"].includes(z.id)) {
      const clone = document.createElement("button");
      icon(clone, z.icon);
      clone.dataset.tip = z.name;
      clone.setAttribute("aria-label", "Start at " + z.name);
      clone.onclick = () => {
        go(z.id);
        actions.drive();
        actions.setCamera(z.id === "interstate" ? 2 : 1);
      };
      $("start-destinations").append(clone);
    }
  }
  $("delivery-run").onclick = () => {
    closeStart("explore");
    $("world-panel").hidden = true;
    $("quick-panel").hidden = true;
    actions.teleport("garage");
    actions.course();
  };
  $("course").onclick = zones;
  $("world-close").onclick = () => {
    $("world-panel").hidden = true;
    ui.press("course", false);
  };
  $("start-drive").onclick = () => closeStart();
  $("start-tour").onclick = () => {
    closeStart("tour");
    actions.tour();
  };
  $("start-film").onclick = () => {
    closeStart("film");
    actions.film();
  };
  // Back to the start menu (after the film).
  function reopen() {
    if (start) return;
    start = true;
    document.body.classList.add("starting");
    for (const e of document.querySelectorAll(".topbar,.dock,.telemetry,.utility-dock,.touch-drive")) e.inert = true;
    $("start-menu").hidden = false;
    $("quick-panel").hidden = true;
    quick = false;
  }
  $("start-explore").onclick = () => closeStart("explore");
  $("inspect").onclick = () => {
    if (start) closeStart("explore");
    else {
      quick = !quick;
      $("quick-panel").hidden = !quick;
      $("world-panel").hidden = true;
      ui.press("inspect", quick);
    }
  };
  $("quick-close").onclick = () => {
    quick = false;
    $("quick-panel").hidden = true;
    ui.press("inspect", false);
  };
  $("quick-advanced").onclick = () => {
    if (Math.abs(world.physics.speed) > 0.65) {
      ui.toast("Stop to use the advanced rig inspector");
      return;
    }
    $("quick-panel").hidden = true;
    quick = false;
    ui.setPanel(true);
  };
  $("hand-tool").onclick = () => actions.grab();
  $("repair-car").onclick = () => actions.repair();
  $("slow-motion").onclick = () => actions.slow();
  $("boost").onpointerdown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    actions.hold("boost", true);
  };
  $("boost").onpointerup = $("boost").onpointercancel = () => actions.hold("boost", false);
  $("quick-demo").onclick = () => {
    if (Math.abs(world.physics.speed) > 1) {
      ui.toast("Park to preview the mechanisms");
      return;
    }
    demo = !demo;
    ui.press("quick-demo", demo);
    if (!demo) rig.reset();
  };
  function update(dt = 0, time = 0) {
    for (const b of $("quick-grid").children)
      b.setAttribute("aria-pressed", String(rig.targets[b.dataset.part] > 0.5));
    $("repair-car").dataset.tip =
      "Repair vehicle · " + Math.round((1 - damage.level) * 100) + "% condition · Backspace";
    $("repair-car").classList.toggle("damaged", damage.level > 0.15);
    if (demo) {
      const value = 0.5 - 0.5 * Math.cos(time * 1.3);
      for (const [, , b, k] of parts) rig.set(b, k, value, true);
      rig.set("SETTINGS", "Steering", Math.sin(time) * 25, true);
    }
    const s = world.stats,
      active = world.active;
    $("activity").hidden = active === "garage";
    $("activity-name").textContent = ZONES.find((z) => z.id === active)?.name || "";
    $("activity-value").textContent =
      active === "jump" || active === "drop"
        ? "Best " + s.bestJump.toFixed(1) + " m"
        : active === "handling"
          ? (s.lapTime ? s.lapTime.toFixed(2) + " s" : "Ready") + " · " + Math.min(s.gates, 8) + "/8"
          : active === "bowling"
            ? s.barrels + "/10 barrels · " + s.dominoes + "/28 dominoes"
            : active === "crash" || active === "pendulum"
              ? Math.round((1 - damage.level) * 100) + "% condition"
              : active === "bridge"
                ? "Find the balance"
                : "Four independent wheels";
  }
  return {
    update,
    start: closeStart,
    reopen,
    zones,
    isStarting: () => start,
    togglePart,
    setHand(on) {
      ui.press("hand-tool", on);
      document.body.classList.toggle("grabbing-mode", on);
    },
    setSlow(on) {
      ui.press("slow-motion", on);
    },
  };
}
