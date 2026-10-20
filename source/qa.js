const out = document.createElement("pre");
out.id = "qa-results";
out.style =
  "position:fixed;left:12px;top:100px;z-index:100;background:#fff;color:#172b22;padding:16px;font:11px monospace;max-width:530px;max-height:65vh;overflow:auto";
document.body.append(out);
const rows = [];
function check(label, pass, detail = "") {
  rows.push({ label, pass, detail });
  out.textContent = JSON.stringify(rows, null, 2);
  if (!pass) throw Error(label + ": " + detail);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, limit = 14000) {
  const t = performance.now();
  while (!fn() && performance.now() - t < limit) await sleep(100);
  return fn();
}
try {
  const p = window.playground;
  p.experience.start();
  check("154 rig controls", p.rig.controls.length === 154);
  check("Suspension settled", await until(() => p.physics.grounded === 4));
  p.actions.teleport("crash");
  p.actions.drive();
  p.setInput({ steer: 0, throttle: 1, brake: 0, handbrake: false, boost: true });
  check("Physical forward drive", await until(() => p.state.speed > 7), p.state.speed);
  document.querySelector("#camera").click();
  document.querySelector("#camera").click();
  await sleep(300);
  const offset = () => {
    const v = p.camera.position
      .clone()
      .sub(p.vehicle.position)
      .applyQuaternion(p.vehicle.quaternion.clone().invert());
    return [v.x, v.y, v.z];
  };
  const before = offset();
  await sleep(1200);
  const after = offset();
  check(
    "Cockpit stays anchored while accelerating",
    Math.hypot(...after.map((x, i) => x - before[i])) < 0.04,
    { before, after },
  );
  check("Wall collision creates deformation", await until(() => p.damage.level > 0.1, 20000), p.damage.level);
  check("Body part physically detached", p.damage.debris.length > 0, p.damage.debris.length);
  p.setInput({ steer: 0, throttle: 0, brake: 1, handbrake: false, boost: false });
  p.actions.repair();
  check("Repair restores parts", p.damage.debris.length === 0 && p.damage.level === 0);
  p.actions.teleport("drop");
  check("Drop platform teleport", p.physics.body.translation().y > 22);
  p.actions.teleport("bridge");
  check("Physical bridge is dynamic", p.testWorld.bridge.body.isDynamic());
  p.actions.teleport("bowling");
  check("Bowling has 10 physical barrels", p.testWorld.barrels.length === 10);
  check("Domino chain has 28 pieces", p.testWorld.dominoes.length === 28);
  p.actions.teleport("garage");
  p.actions.grab();
  check("Hand tool enabled", p.direct.hand);
  p.actions.grab();
  await until(() => p.physics.grounded === 4);
  const y = p.physics.body.translation().y;
  p.physics.grab = {
    local: p.vehicle.position.clone().set(0, 0, 0),
    target: p.vehicle.position.clone().add(p.vehicle.position.clone().set(0, 3, 0)),
  };
  check("Body grab applies physical lift", await until(() => p.physics.body.translation().y > y + 0.8, 5000));
  p.physics.grab = null;
  p.actions.reset();
  p.actions.slow();
  check("Slow motion steps physics", p.physics.timeScale === 0.18);
  p.actions.slow();
  p.experience.togglePart("WINDOW_L", "Lower");
  check("One-tap window control", p.rig.targets["WINDOW_L|Lower"] === 1);
  p.actions.repair();
  p.testInput = null;
  check("Complete", true);
  out.dataset.complete = "true";
} catch (e) {
  out.dataset.failed = "true";
  out.textContent += "\n" + e.stack;
  console.error(e);
}
