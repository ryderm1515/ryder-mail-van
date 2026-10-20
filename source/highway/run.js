import * as T from "three";

// Interstate run: the survival mail-delivery loop on top of the existing
// highway world. A run starts on entry, tracks distance, deliveries, van
// health and score, ends when the van is wrecked (or the player stops), and
// records results in an on-device leaderboard.
//
// The leaderboard lives in this browser only (localStorage). It is NOT secure
// or global; `submit()` is the single place a server-backed board would hook in.

const STOPS_PER_ROUTE = 5;
const BOARD_KEY = "van-interstate-board-v1";
const fmt = (n) => Math.round(n).toLocaleString();
const km = (m) => (m / 1000).toFixed(m < 10000 ? 2 : 1) + " km";
const load = () => {
  try {
    return JSON.parse(localStorage.getItem(BOARD_KEY)) || [];
  } catch {
    return [];
  }
};
const save = (b) => {
  try {
    localStorage.setItem(BOARD_KEY, JSON.stringify(b.slice(0, 50)));
  } catch {}
};

export class Run {
  constructor(hw) {
    this.hw = hw;
    this.dev = { invincible: false, dmgMult: 1, drain: 0, rocket: false, rocketPower: 1, density: 1, debug: false };
    this.buildUI();
    this.buildMarker();
  }
  // ------------------------------------------------------------------ state
  start() {
    this.active = true;
    this.over = false;
    this.hp = 100;
    this.distance = 0;
    this.deliveries = 0;
    this.routesDone = 0;
    this.score = 0;
    this.time = 0;
    this.lastHit = -9;
    this.nearMisses = 0;
    this.nearPending = null;
    this.clean = true; // no damage since the last delivery
    this.cleanStreak = 0;
    this.last = null;
    this.newRoute();
    this.results.hidden = true;
    this.hudEl.hidden = false;
    this.hw.physics.paused = false;
  }
  stop() {
    this.active = false;
    this.hudEl.hidden = true;
    this.results.hidden = true;
    this.devEl.hidden = true;
    this.marker.visible = false;
  }
  newRoute() {
    const lots = [];
    this.hw.towns.forEach((t) => t.lots?.forEach((l) => lots.push({ town: t, lot: l })));
    // Mix towns so every route crosses the interstate at least once.
    const shuffled = lots.sort(() => Math.random() - 0.5);
    const route = [];
    for (const p of shuffled) {
      if (route.length >= STOPS_PER_ROUTE) break;
      if (route.length && route[route.length - 1].town === p.town && route.filter((r) => r.town === p.town).length >= 3) continue;
      route.push(p);
    }
    let route2 = route.map((p) => ({ ...p, pos: p.lot.mailbox.clone().add(p.town.origin), label: p.lot.num + " · " + p.town.label }));
    // One or two business stops in Downtown / Industrial per route.
    const acc = this.hw.layout.access || [];
    const nz = acc.length ? 1 + Math.floor(Math.random() * 2) : 0;
    for (let k = 0; k < nz; k++) {
      const ac = acc[Math.floor(Math.random() * acc.length)],
        st = ac.stops[Math.floor(Math.random() * ac.stops.length)];
      if (route2.some((r) => r.lot === st)) continue;
      route2.splice(1 + Math.floor(Math.random() * (route2.length - 1)), 1, { zone: ac, lot: st, pos: st.pos.clone(), label: st.num + " · " + ac.label });
    }
    this.route = route2;
    this.stop_i = 0;
    this.setMission();
  }
  setMission() {
    this.hw.mission = this.route[this.stop_i] || null;
  }
  onDeliver() {
    if (!this.active || this.over) return;
    let pts = 250;
    if (this.clean) {
      this.cleanStreak++;
      pts += 100 * Math.min(5, this.cleanStreak);
    } else this.cleanStreak = 0;
    this.clean = true;
    this.deliveries++;
    this.score += pts;
    this.pop("+" + pts + (this.cleanStreak > 1 ? "  clean ×" + this.cleanStreak : ""), "good");
    this.stop_i++;
    if (this.stop_i >= this.route.length) {
      const bonus = Math.round(1000 * (0.5 + this.hp / 200));
      this.score += bonus;
      this.routesDone++;
      this.hw.ui?.toast?.(`Route ${this.routesDone} complete · +${bonus}. New route on your map.`);
      this.newRoute();
    } else this.setMission();
  }
  onImpact(severity) {
    if (!this.active || this.over) return;
    if (this.dev.invincible) return;
    const loss = Math.max(0, (severity - 1.2) * 2.2) * this.dev.dmgMult;
    if (loss < 0.5) return;
    this.hp = Math.max(0, this.hp - loss);
    this.lastHit = this.time;
    this.clean = false;
    this.cleanStreak = 0;
    this.pop("−" + Math.round(loss) + " van", "bad");
    this.hudEl.classList.remove("hit");
    void this.hudEl.offsetWidth;
    this.hudEl.classList.add("hit");
    if (this.hp <= 0) this.end("wrecked");
  }
  end(reason) {
    if (this.over) return;
    this.over = true;
    this.hw.physics.paused = true;
    const entry = { name: this.lastName || "Driver", score: Math.round(this.score), distance: Math.round(this.distance), deliveries: this.deliveries, time: Math.round(this.time), reason, date: Date.now() };
    this.showResults(entry);
  }
  update(dt, { position, speed }) {
    if (!this.active || this.over) return;
    this.time += dt;
    if (this.last) {
      const d = Math.hypot(position.x - this.last.x, position.z - this.last.z);
      if (d < 30) {
        this.distance += d;
        this.score += d / 10; // 1 point per 10 m driven
      }
    }
    this.last = { x: position.x, z: position.z };
    // Near misses: threading past traffic at speed without touching it.
    if (Math.abs(speed) > 17 && this.time - (this.lastHit ?? -9) > 1.5) {
      for (const car of this.hw.traffic?.cars || []) {
        if (!car.pos || car.wreck) continue;
        const d = Math.hypot(car.pos.x - position.x, car.pos.z - position.z);
        if (d < 3.6 && d > 1.2 && this.time - (car.nearAt ?? -9) > 4) {
          car.nearAt = this.time;
          this.nearPending = { car, at: this.time };
        }
      }
      const n = this.nearPending;
      if (n && this.time - n.at > 0.6) {
        this.nearPending = null;
        if (this.time - (this.lastHit ?? -9) > 0.7) {
          this.score += 75;
          this.nearMisses = (this.nearMisses || 0) + 1;
          this.pop("+75 near miss", "good");
        }
      }
    }
    if (this.dev.drain > 0 && !this.dev.invincible) {
      this.hp = Math.max(0, this.hp - this.dev.drain * dt);
      if (this.hp <= 0) return this.end("wrecked");
    }
    // Rocket booster (dev): extra shove while boost (Shift) is held.
    const ph = this.hw.physics;
    if (this.dev.rocket && ph.boost && ph.body) {
      const q = ph.body.rotation(),
        f = new T.Vector3(-1, 0, 0).applyQuaternion(new T.Quaternion(q.x, q.y, q.z, q.w));
      const m = ph.body.mass();
      const k = 18 * this.dev.rocketPower * m * dt;
      ph.body.applyImpulse({ x: f.x * k, y: 0, z: f.z * k }, true);
    }
    this.hw.traffic.density = this.dev.density;
    this.updateMarker(dt);
    this.renderHud(position);
  }
  // ---------------------------------------------------------------- marker
  buildMarker() {
    const g = new T.Group();
    const beam = new T.Mesh(
      new T.CylinderGeometry(0.9, 0.9, 40, 24, 1, true),
      new T.MeshBasicMaterial({ color: "#5aa9ff", transparent: true, opacity: 0.22, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending }),
    );
    beam.position.y = 20;
    const ring = new T.Mesh(new T.RingGeometry(4.9, 5.5, 48).rotateX(-Math.PI / 2), new T.MeshBasicMaterial({ color: "#5aa9ff", transparent: true, opacity: 0.55, depthWrite: false }));
    ring.position.y = 0.06;
    g.add(beam, ring);
    g.visible = false;
    this.marker = g;
    this.markerRing = ring;
    this.hw.scene.add(g);
  }
  updateMarker() {
    const m = this.hw.mission;
    this.marker.visible = !!m && this.active;
    if (!m) return;
    this.marker.position.set(m.pos.x, 0, m.pos.z);
    const s = 1 + Math.sin(this.time * 3) * 0.04;
    this.markerRing.scale.set(s, 1, s);
  }
  // -------------------------------------------------------------------- UI
  buildUI() {
    const h = (this.hudEl = document.createElement("div"));
    h.className = "run-hud surface";
    h.hidden = true;
    h.innerHTML = `
      <div class="run-hp"><span class="run-lab">Van</span><div class="run-bar"><i></i></div></div>
      <div class="run-stat"><span class="run-lab">Distance</span><b data-k="dist">0</b></div>
      <div class="run-stat"><span class="run-lab">Delivered</span><b data-k="del">0</b></div>
      <div class="run-stat"><span class="run-lab">Score</span><b data-k="score">0</b><small data-k="best"></small></div>
      <div class="run-next"><span class="run-lab" data-k="routeLab">Next stop</span><b data-k="next">—</b><small data-k="where"></small></div>
      <button class="run-end" type="button" aria-label="End run">End run</button>`;
    document.body.append(h);
    h.querySelector(".run-end").onclick = () => this.end("ended");
    this.q = (k) => h.querySelector(`[data-k="${k}"]`);
    this.bar = h.querySelector(".run-bar i");
    this.pops = document.createElement("div");
    this.pops.className = "run-pops";
    document.body.append(this.pops);
    // Results / leaderboard.
    const r = (this.results = document.createElement("div"));
    r.className = "run-results";
    r.hidden = true;
    document.body.append(r);
    this.buildDev();
  }
  renderHud(pos) {
    const best = this.bests();
    this.bar.style.transform = `scaleX(${this.hp / 100})`;
    this.bar.parentElement.dataset.state = this.hp > 60 ? "ok" : this.hp > 25 ? "warn" : "crit";
    this.q("dist").textContent = km(this.distance);
    this.q("del").textContent = this.deliveries;
    this.q("score").textContent = fmt(this.score);
    this.q("best").textContent = best.score ? (this.score > best.score ? "New best" : "Best " + fmt(best.score)) : "";
    const m = this.hw.mission;
    this.q("routeLab").textContent = `Route ${this.routesDone + 1} · stop ${Math.min(this.stop_i + 1, this.route.length)}/${this.route.length}`;
    this.q("next").textContent = m ? m.label : "—";
    const here = this.hw.towns.find((t) => Math.abs(pos.x - t.origin.x) < 560 && Math.abs(pos.z - t.origin.z) < 300);
    this.q("where").textContent = (here ? here.label : this.hw.zoneName?.(pos) || "I-16") + (m ? " · " + km(Math.hypot(pos.x - m.pos.x, pos.z - m.pos.z)) : "");
  }
  pop(text, kind) {
    const e = document.createElement("div");
    e.className = "run-pop " + kind;
    e.textContent = text;
    this.pops.append(e);
    setTimeout(() => e.remove(), 1600);
  }
  bests() {
    const b = load();
    return {
      score: Math.max(0, ...b.map((e) => e.score)),
      distance: Math.max(0, ...b.map((e) => e.distance)),
      deliveries: Math.max(0, ...b.map((e) => e.deliveries)),
      time: Math.max(0, ...b.map((e) => e.time)),
    };
  }
  // Single hook for a future server-backed leaderboard.
  submit(entry) {
    const b = load();
    b.push(entry);
    b.sort((a, c) => c.score - a.score);
    save(b);
    return b;
  }
  showResults(entry) {
    const prev = this.bests();
    const r = this.results;
    const pb = (k) => (entry[k] > prev[k] && prev[k] > 0 ? '<em class="run-pb">New best</em>' : "");
    const mmss = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    r.innerHTML = `
      <div class="run-card surface" role="dialog" aria-label="Run results">
        <p class="run-kicker">${entry.reason === "wrecked" ? "Van out of service" : "Run ended"}</p>
        <h2>${fmt(entry.score)} <span>points</span> ${pb("score")}</h2>
        <div class="run-grid">
          <div><span>Distance</span><b>${km(entry.distance)}</b>${pb("distance")}</div>
          <div><span>Delivered</span><b>${entry.deliveries}</b>${pb("deliveries")}</div>
          <div><span>Routes</span><b>${this.routesDone}</b></div>
          <div><span>Time</span><b>${mmss(entry.time)}</b>${pb("time")}</div>
          <div><span>Van health</span><b>${Math.round(this.hp)}%</b></div>
        </div>
        <label class="run-name">Name for the board <input id="run-name" maxlength="14" value="${(this.lastName || "Driver").replace(/"/g, "")}"></label>
        <div class="run-actions"><button id="run-save" class="tour-primary" type="button">Save and play again</button><button id="run-skip" class="tour-secondary" type="button">Play again</button><button id="run-exit" class="tour-secondary" type="button">Leave Interstate</button></div>
        <div class="run-board"></div>
        <p class="run-note">Leaderboard is saved on this device only.</p>
      </div>`;
    r.hidden = false;
    const board = (list) => {
      r.querySelector(".run-board").innerHTML =
        "<h3>Top runs</h3><ol>" +
        list
          .slice(0, 8)
          .map((e) => `<li${e === entry ? ' class="me"' : ""}><span>${e.name.replace(/</g, "")}</span><b>${fmt(e.score)}</b><small>${km(e.distance)} · ${e.deliveries} mail</small></li>`)
          .join("") +
        "</ol>";
    };
    board(load());
    const again = (saveIt) => {
      if (saveIt) {
        entry.name = (r.querySelector("#run-name").value || "Driver").trim().slice(0, 14);
        this.lastName = entry.name;
        board(this.submit(entry));
      }
      this.hw.restart();
    };
    r.querySelector("#run-save").onclick = () => again(true);
    r.querySelector("#run-skip").onclick = () => again(false);
    r.querySelector("#run-exit").onclick = () => {
      this.results.hidden = true;
      this.hw.physics.paused = false;
      this.hw.exit?.();
    };
    r.querySelector("#run-name").addEventListener("keydown", (e) => e.stopPropagation());
  }
  // ------------------------------------------------------- developer menu
  // DEBUG / DEVELOPMENT TOOL. Hidden from players: toggle with Alt+Shift+D,
  // or type "vandev" while driving.
  buildDev() {
    const d = (this.devEl = document.createElement("div"));
    d.className = "run-dev";
    d.hidden = true;
    d.setAttribute("data-debug-tool", "true");
    d.innerHTML = `
      <header>DEV / DEBUG <small>Alt+Shift+D</small></header>
      <label><input type="checkbox" data-d="invincible"> Invincible</label>
      <label>Damage per hit <input type="range" min="0" max="3" step="0.1" value="1" data-d="dmgMult"><output></output></label>
      <label>Damage drain /s <input type="range" min="0" max="10" step="0.5" value="0" data-d="drain"><output></output></label>
      <button data-a="repair">Repair van</button>
      <label><input type="checkbox" data-d="rocket"> Rocket booster (hold Shift)</label>
      <label>Rocket power <input type="range" min="0.5" max="5" step="0.1" value="1" data-d="rocketPower"><output></output></label>
      <label>Traffic density <input type="range" min="0" max="1" step="0.05" value="1" data-d="density"><output></output></label>
      <label><input type="checkbox" data-d="debug"> Debug overlay (routes, triggers)</label>
      <div class="run-dev-row"><button data-a="route">New route</button><button data-a="skip">Skip stop</button><button data-a="end">End run</button></div>
      <div class="run-dev-row" data-tp></div>`;
    document.body.append(d);
    for (const el of d.querySelectorAll("[data-d]")) {
      const k = el.dataset.d,
        out = el.parentElement.querySelector("output");
      const sync = () => {
        this.dev[k] = el.type === "checkbox" ? el.checked : +el.value;
        if (out) out.textContent = el.value;
        if (k === "debug") this.hw.setDebug?.(el.checked);
      };
      el.addEventListener("input", sync);
      el.addEventListener("keydown", (e) => e.stopPropagation());
      sync();
    }
    const act = {
      repair: () => {
        this.hw.damage?.repair();
        this.hp = 100;
      },
      route: () => this.newRoute(),
      skip: () => this.onDeliver(),
      end: () => this.end("ended"),
    };
    for (const b of d.querySelectorAll("[data-a]")) b.onclick = () => act[b.dataset.a]();
    // Secret keys.
    let typed = "";
    addEventListener("keydown", (e) => {
      if (!this.active) return;
      if (e.altKey && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        return this.toggleDev();
      }
      typed = (typed + (e.key || "")).slice(-6).toLowerCase();
      if (typed === "vandev") this.toggleDev();
    });
  }
  toggleDev() {
    const d = this.devEl;
    d.hidden = !d.hidden;
    if (!d.hidden) {
      const row = d.querySelector("[data-tp]");
      row.innerHTML = "";
      for (const [label, fn] of this.hw.teleports()) {
        const b = document.createElement("button");
        b.textContent = label;
        b.onclick = fn;
        row.append(b);
      }
    }
  }
}
