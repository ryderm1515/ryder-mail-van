export async function createUI(rig, actions) {
  const icons = await (await fetch("./assets/icons.json")).json(),
    $ = (id) => document.getElementById(id);
  const icon = (e, name) => {
    if (typeof e === "string") e = $(e);
    e.innerHTML = icons[name] || icons["circle-dot"];
  };
  const mapping = {
    waypoint: "arrow-up",
    power: "power",
    course: "flag",
    help: "keyboard",
    theme: "sun",
    inspect: "settings",
    camera: "cube",
    left: "arrow-left",
    right: "arrow-right",
    hazards: "alert-triangle",
    lights: "bulb",
    wipers: "wiper",
    horn: "bell",
    sound: "volume-off",
    reset: "arrow-back-up",
    "close-parts": "x",
    "close-property": "x",
    "close-help": "x",
    "reset-rig": "rotate-clockwise",
    "property-reset": "rotate-clockwise",
    "property-focus": "focus-2",
    "property-toggle": "player-play",
    "brand-icon": "truck",
    "search-icon": "search",
  };
  Object.entries(mapping).forEach(([id, name]) => icon(id, name));
  let timeout,
    selected = null,
    category = "all";
  const tip = document.createElement("div");
  tip.id = "part-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.append(tip);
  function showTip(b, label) {
    const r = b.getBoundingClientRect();
    tip.textContent = label;
    tip.hidden = false;
    tip.style.left = Math.max(10, Math.min(innerWidth - 260, r.left - 90)) + "px";
    tip.style.top = Math.max(10, r.top - 38) + "px";
  }
  function hideTip() {
    tip.hidden = true;
  }
  const toast = (t) => {
    $("toast").textContent = t;
    $("toast").classList.add("show");
    clearTimeout(timeout);
    timeout = setTimeout(() => $("toast").classList.remove("show"), 2700);
  };
  const press = (id, value) => $(id).setAttribute("aria-pressed", String(value));
  const prettify = (s) =>
    s
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  const classify = (c) =>
    /LIGHTING/.test(c.bone)
      ? "lights"
      : /WHEEL|LUG|HUBCAP|SETTINGS/.test(c.bone)
        ? "wheels"
        : /HOOD|FLUID|FUSE|COOLING/.test(c.bone)
          ? "service"
          : /SHELF|REAR_|SHUTTER|TIE_DOWN|PARTITION|SORTING|EXTINGUISHER/.test(c.bone)
            ? "cargo"
            : "cab";
  const partIcon = (c) =>
    /LIGHT/.test(c.bone)
      ? "bulb"
      : /LUG|HUBCAP/.test(c.bone)
        ? "tool"
        : /WHEEL/.test(c.bone)
          ? "wheel"
          : /DOOR|PARTITION|SHUTTER/.test(c.bone)
            ? "door-enter"
            : /WINDOW/.test(c.bone)
              ? "window"
              : /MIRROR/.test(c.bone)
                ? "eye"
                : /WIPER/.test(c.bone)
                  ? "wiper"
                  : /SEAT|HEADREST/.test(c.bone)
                    ? "armchair"
                    : /SHELF|TRAY/.test(c.bone)
                      ? "layout-board"
                      : /FAN|VENT/.test(c.bone)
                        ? "car-fan"
                        : /FLUID/.test(c.bone)
                          ? "droplet"
                          : /HOOD|FUSE/.test(c.bone)
                            ? "bolt"
                            : /GAUGE/.test(c.bone)
                              ? "dashboard"
                              : /PEDAL/.test(c.bone)
                                ? "arrow-down"
                                : /BELT|LATCH/.test(c.bone)
                                  ? "lock"
                                  : /TIE/.test(c.bone)
                                    ? "circles"
                                    : /STEERING|SETTINGS/.test(c.bone)
                                      ? "steering-wheel"
                                      : "toggle-left";
  function open(c) {
    selected = c;
    $("property-popover").hidden = false;
    $("property-name").textContent = prettify(c.bone) + " · " + c.name;
    $("property-detail").textContent = c.description || "Independent animation control";
    const s = $("property-slider");
    s.min = c.min;
    s.max = c.max;
    s.step = c.max - c.min > 100 ? 1 : 0.001;
    s.value = rig.targets[c.id];
    s.setAttribute("aria-label", prettify(c.bone) + " " + c.name);
    $("property-value").value = Number(s.value).toFixed(Math.abs(c.max) > 10 ? 0 : 2);
    actions.pauseForInteraction();
  }
  const controls = rig.controls;
  function render() {
    const query = $("search").value.toLowerCase().replace(/_/g, " ");
    const filtered = controls.filter(
      (c) =>
        (category === "all" || classify(c) === category) &&
        `${c.bone} ${c.name} ${c.description}`.toLowerCase().replace(/_/g, " ").includes(query),
    );
    $("part-count").textContent = filtered.length + " / " + controls.length;
    $("parts-grid").replaceChildren();
    for (const c of filtered) {
      const b = document.createElement("button");
      const label = prettify(c.bone) + " · " + c.name;
      b.setAttribute("aria-label", label);
      b.dataset.label = label;
      b.dataset.control = c.id;
      b.setAttribute("aria-pressed", String(rig.overrides.has(c.id)));
      icon(b, partIcon(c));
      const small = document.createElement("small");
      small.textContent = c.bone.match(/(?:_|^)(FL|FR|RL|RR|L|R|\d+)$/)?.[1] || c.name.substring(0, 1);
      b.append(small);
      b.addEventListener("click", () => {
        hideTip();
        open(c);
      });
      b.addEventListener("pointerenter", () => showTip(b, label));
      b.addEventListener("focus", () => showTip(b, label));
      b.addEventListener("pointerleave", hideTip);
      b.addEventListener("blur", hideTip);
      $("parts-grid").append(b);
    }
    if (!filtered.length) {
      const p = document.createElement("p");
      p.textContent = "No matching controls";
      $("parts-grid").append(p);
    }
  }
  for (const [key, i, label] of [
    ["all", "grid-dots", "All controls"],
    ["cab", "armchair", "Cab and doors"],
    ["cargo", "package", "Cargo and shutter"],
    ["wheels", "wheel", "Wheels and chassis"],
    ["service", "bolt", "Service bay"],
    ["lights", "bulb", "Lighting"],
  ]) {
    const b = document.createElement("button");
    icon(b, i);
    b.dataset.tip = label;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", String(key === category));
    b.onclick = () => {
      category = key;
      [...$("categories").children].forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      render();
    };
    $("categories").append(b);
  }
  $("search").oninput = render;
  render();
  function adjust(v) {
    if (!selected) return;
    const c = selected;
    rig.set(c.bone, c.name, v, true);
    $("property-slider").value = v;
    $("property-value").value = v.toFixed(Math.abs(c.max) > 10 ? 0 : 2);
    actions.interaction(c, v);
    document.querySelector(`[data-control="${CSS.escape(c.id)}"]`)?.setAttribute("aria-pressed", "true");
  }
  $("property-slider").oninput = (e) => adjust(Number(e.target.value));
  $("property-toggle").onclick = () => {
    const c = selected;
    if (c) adjust(rig.targets[c.id] > (c.max + c.min) / 2 ? c.min : c.max);
  };
  $("property-reset").onclick = () => {
    if (selected) {
      rig.overrides.delete(selected.id);
      rig.set(selected.bone, selected.name, selected.default);
      $("property-slider").value = selected.default;
      $("property-value").value = selected.default;
      render();
      toast("Automatic control restored");
    }
  };
  $("property-focus").onclick = () => {
    if (selected) {
      actions.focus(selected.bone);
      if (innerWidth < 680) {
        $("parts-panel").hidden = true;
        panel = false;
        press("inspect", false);
      }
    }
  };
  $("close-property").onclick = () => {
    $("property-popover").hidden = true;
    selected = null;
  };
  let panel = false;
  function setPanel(v) {
    if (v && actions.pauseForInteraction() === false) return;
    panel = v;
    $("parts-panel").hidden = !v;
    press("inspect", v);
    if (!v) {
      $("property-popover").hidden = true;
      selected = null;
    }
    actions.panel(v);
  }
  $("inspect").onclick = () => setPanel(!panel);
  $("close-parts").onclick = () => setPanel(false);
  $("reset-rig").onclick = () => {
    rig.reset();
    render();
    toast("Interaction overrides cleared");
  };
  for (const id of [
    "power",
    "course",
    "theme",
    "camera",
    "left",
    "right",
    "hazards",
    "lights",
    "wipers",
    "horn",
    "sound",
    "reset",
  ])
    $(id).onclick = () => actions[id]?.();
  for (const b of document.querySelectorAll("[data-gear]")) b.onclick = () => actions.gear(b.dataset.gear);
  $("help").onclick = () => $("help-dialog").showModal();
  $("close-help").onclick = () => $("help-dialog").close();
  $("help-dialog").onclick = (e) => {
    if (e.target === $("help-dialog")) $("help-dialog").close();
  };
  for (const b of document.querySelectorAll("[data-hold]")) {
    const key = b.dataset.hold;
    icon(b, { left: "arrow-left", right: "arrow-right", brake: "hand-stop", throttle: "arrow-up" }[key]);
    b.onpointerdown = (e) => {
      b.setPointerCapture(e.pointerId);
      actions.hold(key, true);
    };
    b.onpointerup = b.onpointercancel = () => actions.hold(key, false);
  }
  return {
    toast,
    press,
    icon,
    setPanel,
    open,
    render,
    selectBone(name) {
      const c = controls.find((c) => c.bone === name);
      if (c) {
        setPanel(true);
        open(c);
      }
    },
    gear(g) {
      document
        .querySelectorAll("[data-gear]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.gear === g)));
    },
    update(speed, throttle) {
      $("speed").value = Math.round(Math.abs(speed) * 3.6);
      $("load-fill").style.width = throttle * 100 + "%";
    },
    camera(name, i) {
      $("camera-tag").textContent = name.toUpperCase();
      $("camera").dataset.tip = "Camera: " + name + " · C";
      icon("camera", i);
    },
    engine(on) {
      press("power", on);
      $("engine-dot").classList.toggle("on", on);
      $("power").setAttribute("aria-label", on ? "Power off" : "Power on");
    },
  };
}
