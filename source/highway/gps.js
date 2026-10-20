import * as T from "three";

// In-dash style GPS: heading-up mini map with the roads, traffic, your route
// to the next mailbox and a turn-by-turn line.

export class Gps {
  constructor(hw) {
    this.hw = hw;
    const el = (this.el = document.createElement("div"));
    el.className = "gps surface";
    el.hidden = true;
    el.innerHTML = '<div class="gps-instr"><strong></strong><span></span></div><canvas width="420" height="420"></canvas>';
    document.body.append(el);
    this.canvas = el.querySelector("canvas");
    this.g = this.canvas.getContext("2d");
    this.instrMain = el.querySelector("strong");
    this.instrSub = el.querySelector("span");
    this.zoom = 0.8;
    this.lines = this.collectRoads();
  }
  collectRoads() {
    const { main, interchanges } = this.hw.layout;
    const sample = (path, step, closed = false) => {
      const out = [];
      for (let s = 0; s <= path.length; s += step) {
        const p = path.at(s);
        out.push([p.x, p.z]);
      }
      if (closed) out.push(out[0]);
      return out;
    };
    const lines = [{ pts: sample(main, 20, true), w: 26, c: "#c9ced1" }];
    for (const ic of interchanges) {
      for (const r of ic.ramps) lines.push({ pts: sample(r.path, 10), w: 9, c: "#b8bec1" });
      lines.push({ pts: sample(ic.cross, 10), w: 14, c: "#d7dbdd" });
      for (const lp of ic.loops) lines.push({ pts: sample(lp, 10), w: 11, c: "#e3dfd2" });
    }
    for (const t of this.hw.towns || []) {
      const o = t.origin,
        pts = [[o.x - 520, o.z + 2]];
      for (let d = 0; d <= t.street.length; d += 8) {
        const p = t.street.at(d);
        pts.push([o.x + p.x, o.z + p.z]);
      }
      pts.push([o.x + 420, o.z]);
      lines.push({ pts, w: 11, c: "#e3dfd2", town: t });
    }
    return lines;
  }
  // ---------------------------------------------------------------- route
  townOf(x, z) {
    for (const t of this.hw.towns) if (x > t.origin.x - 760 && x < t.origin.x + 580 && Math.abs(z - t.origin.z) < 340) return t;
    return null;
  }
  route(px, pz) {
    const hw = this.hw,
      m = hw.mission;
    if (!m) return null;
    const { main, interchanges } = hw.layout;
    const ti = hw.towns.indexOf(m.town),
      tic = interchanges[ti];
    const target = [m.pos.x, m.pos.z];
    const here = this.townOf(px, pz);
    const junction = (ic) => [ic.end.x, ic.end.z];
    const townLeg = (t, from) => {
      // Along the street from the crossroad junction to the mailbox.
      const o = t.origin;
      return [from, [o.x + (m.pos.x - o.x), o.z + 2], target].filter(Boolean);
    };
    const crossLeg = (ic, s0, s1) => {
      const out = [];
      const step = s1 > s0 ? 12 : -12;
      for (let s = s0; step > 0 ? s <= s1 : s >= s1; s += step) {
        const p = ic.cross.at(s);
        out.push([p.x, p.z]);
      }
      return out;
    };
    const mainLeg = (s0, s1, dir) => {
      const out = [],
        L = main.length;
      let d = ((s1 - s0) * dir) % L;
      if (d < 0) d += L;
      for (let k = 0; k <= d; k += 25) {
        const p = main.point(s0 + k * dir, 17 * dir);
        out.push([p.x, p.z]);
      }
      return { pts: out, dist: d };
    };
    let pts = [[px, pz]],
      text = "",
      sub = "";
    if (here === m.town) {
      pts.push(...townLeg(m.town, null));
      const d = Math.hypot(px - m.pos.x, pz - m.pos.z);
      text = "Mailbox " + m.lot.num;
      sub = d < 400 ? Math.round(d) + " m · pull up beside it" : (d / 1609).toFixed(1) + " mi";
      return { pts, text, sub };
    }
    let sStart,
      dir = hw.player.onMain ? hw.player.dir : 0;
    if (here) {
      // Leave this town: street → crossroad → bridge, then onto the interstate.
      const ic = interchanges[hw.towns.indexOf(here)];
      pts.push(junction(ic), ...crossLeg(ic, 0, 740));
      sStart = ic.sc;
      text = "Head back to I-16";
      sub = "Follow the crossroad over the bridge";
    } else sStart = hw.player.s;
    if (!dir) {
      const L = main.length,
        fwd = (((tic.sc - sStart) % L) + L) % L;
      dir = fwd < L / 2 ? 1 : -1;
    }
    const leg = mainLeg(sStart, tic.sc - dir * 560, dir);
    pts.push(...leg.pts);
    const off = tic.ramps.find((r) => r.dir === dir && r.kind === "off");
    for (let s = 0; s <= off.path.length; s += 20) {
      const p = off.path.at(s);
      pts.push([p.x, p.z]);
    }
    pts.push(...crossLeg(tic, 740 + (dir > 0 ? 60 : -60), 0), ...townLeg(m.town, junction(tic)));
    if (!here) {
      const onRamp = !hw.player.onMain && main.project(px, pz, hw.player.s, 200).dist < 80;
      text = onRamp ? "Merge onto I-16 " + (dir > 0 ? "East" : "West") : leg.dist < 900 ? "Exit " + tic.exit + " · keep right" : "Exit " + tic.exit + " · " + tic.names[1];
      sub = leg.dist < 900 ? Math.round(leg.dist) + " m to the ramp" : (leg.dist / 1609).toFixed(1) + " mi · stay on I-16";
    }
    return { pts, text, sub };
  }
  // ----------------------------------------------------------------- draw
  update(pos, fwd, speed, cars) {
    if (this.el.hidden) return;
    const g = this.g,
      W = this.canvas.width,
      H = this.canvas.height,
      cx = W / 2,
      cy = H * 0.62;
    this.zoom += ((Math.max(0.55, 2.2 - Math.abs(speed) * 0.045)) - this.zoom) * 0.05;
    const k = this.zoom;
    const fx = fwd.x,
      fz = fwd.z,
      rx = -fz,
      rz = fx;
    const P = (x, z) => {
      const dx = x - pos.x,
        dz = z - pos.z;
      return [cx + (dx * rx + dz * rz) * k, cy - (dx * fx + dz * fz) * k];
    };
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#24302d";
    g.fillRect(0, 0, W, H);
    // Faint terrain grid.
    g.strokeStyle = "rgba(255,255,255,0.04)";
    g.lineWidth = 1;
    g.lineCap = g.lineJoin = "round";
    const view = (W / k) * 0.9;
    for (const l of this.lines) {
      g.beginPath();
      let started = false;
      for (const [x, z] of l.pts) {
        if (Math.abs(x - pos.x) > view && Math.abs(z - pos.z) > view) {
          started = false;
          continue;
        }
        const [sx, sy] = P(x, z);
        if (!started) g.moveTo(sx, sy), (started = true);
        else g.lineTo(sx, sy);
      }
      g.strokeStyle = "#151d1b";
      g.lineWidth = Math.max(4, l.w * k) + 4;
      g.stroke();
      g.strokeStyle = l.c;
      g.lineWidth = Math.max(3, l.w * k);
      g.stroke();
    }
    // Route.
    const r = this.route(pos.x, pos.z);
    if (r) {
      g.beginPath();
      r.pts.forEach(([x, z], i) => {
        const [sx, sy] = P(x, z);
        i ? g.lineTo(sx, sy) : g.moveTo(sx, sy);
      });
      g.strokeStyle = "rgba(61,139,253,0.95)";
      g.lineWidth = 7;
      g.stroke();
      const [dx, dy] = P(r.pts[r.pts.length - 1][0], r.pts[r.pts.length - 1][1]);
      const ex = Math.min(W - 18, Math.max(18, dx)),
        ey = Math.min(H - 18, Math.max(18, dy));
      g.fillStyle = "#e5484d";
      g.beginPath();
      g.arc(ex, ey - 12, 11, Math.PI, 0);
      g.lineTo(ex, ey + 4);
      g.closePath();
      g.fill();
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(ex, ey - 12, 4, 0, Math.PI * 2);
      g.fill();
      this.instrMain.textContent = r.text;
      this.instrSub.textContent = r.sub;
    }
    // Traffic.
    for (const c of cars) {
      const d2 = (c.pos.x - pos.x) ** 2 + (c.pos.z - pos.z) ** 2;
      if (d2 > view * view) continue;
      const [sx, sy] = P(c.pos.x, c.pos.z);
      g.fillStyle = c.wreck ? "#ffb020" : c.truck ? "#9aa6ad" : "#eef1f2";
      g.beginPath();
      g.arc(sx, sy, c.truck ? 4 : 3, 0, Math.PI * 2);
      g.fill();
    }
    // The van.
    g.save();
    g.translate(cx, cy);
    g.fillStyle = "#3d8bfd";
    g.strokeStyle = "#fff";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, -16);
    g.lineTo(11, 12);
    g.lineTo(0, 6);
    g.lineTo(-11, 12);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
  show(on) {
    this.el.hidden = !on;
  }
}
