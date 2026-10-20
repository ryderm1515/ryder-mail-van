TEST GROUND / LOCAL DRIVING PLAYGROUND

START
Double-click “Open viewer.command”. Python 3 and WebGL 2 are required.
Everything runs locally on this Mac, with no account or internet service.
Keep the terminal window open. The server binds only to 127.0.0.1.

Click Drive, or press W, to start driving. Explore the van opens the immediate
animation controls. The truck on the start screen is the actual 3D model.

DRIVING
W / Up: accelerate. S / Down: brake. A / D: steer. Space: handbrake.
Shift: boost. P / R / N / F: Park / Reverse / Neutral / Drive.
W also starts the engine and selects Drive when parked with closed doors.
When Reverse is selected, W remains the accelerator.
Enter toggles the engine. Stop before shifting. Open doors, hood or a removed
wheel prevent selecting a drive gear until closed or repaired.

C: cycle camera. 1–5: isometric, chase, cockpit, cargo, orbit.
Scroll to zoom. Orbit: drag to rotate, right-drag to pan.
The cockpit camera is anchored to the animated seat/headrest without world-
position lag, so acceleration no longer drags it through the seat. The chase
camera retains eased motion. Camera projections transition smoothly.

G: hand tool. T: teleport menu. Z: slow motion. Backspace: repair/recover.
Home: respawn at the current test ground and reset loose obstacles.
Q / E: indicators. B: hazards. L: headlights. X: wipers. H: horn. M: sound.
V: quick interactions. Question mark: full keyboard help.
Touch devices have steering, throttle and brake buttons; hold the bolt to boost.

HANDS ON
Hover over a rigged part to identify it. While stopped, a short hover gives
selected doors, windows, shelves and other mechanisms a reversible animation
preview. Click a part to animate it. Hover previews restore the prior pose.

Enable the hand icon (G) for direct manipulation:
- Drag a side window downward to lower it, upward to raise it.
- Pull the rear shutter upward to open it.
- Pull the hood upward, or slide a cab door toward the rear.
- Grab the body shell to lift, pull and throw the vehicle using an applied
  force at the grabbed point. Release to let inertia and gravity take over.
Stop before dragging articulated parts. The body grab itself remains physical.

The gear icon now opens one-tap buttons for common animations: both cab doors,
rear shutter, hood, windows, partition, belt, shelves, mirrors and glovebox.
The play button previews a sequence of moving mechanisms. Stop the preview
to reset the pose. The adjustment icon reveals the full 154-property inspector,
with category filtering, search, exact sliders, focus-camera and reset controls.
Manual poses override their automatic driving channel until reset.

TEST GROUNDS
The map button opens nine instant destinations:
1. Workshop: explore and reset the van.
2. Mega ramp: curved 18-meter launch, aerial rings and a landing ramp.
3. Crash laboratory: rigid wall and forty independently simulated blocks.
4. Pendulum alley: a 2,000 kg ball on a physical spherical joint.
5. Barrel bowling: ten rolling barrels and a 28-piece domino chain.
6. Handling circuit: eight gates and a lap timer, plus a slalom approach.
7. Suspension course: alternating humps, rumble strips and steps.
8. Balance bridge: a dynamic seesaw on a limited revolute joint.
9. Drop platform: a 22-meter fall for landing and crash experiments.

Hold Shift on the mega-ramp run-up. Z slows the complete physical simulation.
Air time and jump distance are measured on landing. Bowling and domino counts
come from physical displacement or tipping. The handling circuit times gates
in sequence. Teleporting repairs the van and resets the selected challenge.

The truck icon inside the map panel starts the original three-stop delivery
route. Follow the direction arrow, park on a pad and open the rear shutter.
Close it before moving to the next delivery. All three stops complete the run.

CRASHES AND REPAIR
Rapier contact-force events drive local plastic mesh deformation, body-region
condition, engine-power loss and wheel/suspension damage. Strong impacts can
detach bumpers, hood, mirrors, cab doors, rear slats and wheels. Detached parts
become independent rigid bodies with inherited velocity, gravity and collisions.
Damaged wheels can lose suspension support and traction or pull the steering.
Repair restores original geometry and shading, reattaches parts and restores
wheel forces, power and rig defaults. It also rights the van in place.

This is a custom browser damage system, not BeamNG's node-and-beam soft-body
solver. It uses a rigid chassis, localized vertex deformation, thresholds for
part separation and simplified debris colliders. It does not simulate a
measured tire model, structural beam network or calibrated vehicle crash data.
Detached debris does not collide with its parent chassis, avoiding unstable
interpenetration at separation. Most small cabin mechanisms remain authored
rig motion rather than independent rigid-body mechanisms. Boost is a deliberate
playground feature, not a specification of a real delivery vehicle.

PHYSICS / ANIMATION
120 Hz fixed-step Rapier simulation; independent raycast springs and dampers,
Ackermann steering, rear-wheel drive, tire friction, service/parking brakes,
aerodynamic resistance and automatic forward ratios with brief torque dips.
Physical wheel speed, suspension, steering, pedals and gauges animate the rig.
Gear, braking and signal actions drive the corresponding vehicle lamps.

The browser preserves 165 bone transforms, 247 rig drivers and all 154 exposed
rig properties. Sparse geometry morphs preserve belt and suspension deformation.
The Blender source and original handoff document remain unchanged.

Flat toon materials with antialiased band boundaries, clear windows, hard
contact shadows, a subtle filtered grid and floor grain. Neutral daytime and
night themes share the same restrained interface. Reduced-motion preferences
remove decorative UI and camera-transition animation.

AUDIO
Locally synthesized vehicle-inspired engine, tire/road, horn, reversing beeper,
indicator, latch, impact and metallic crash sounds. These are procedural sound
effects, not recordings of the specific vehicle. Sound unlocks on a user gesture.

VALIDATION
All 154 original controls were tested for finite, observable rig responses.
Physics checks passed settling, acceleration, braking, reverse, steering and
ramp travel. Browser checks passed cockpit stability during acceleration,
wall-impact deformation, part detachment, repair, teleporting, dynamic bridge,
barrel/domino inventory, one-tap window control and slow motion. The anchored
cockpit offset remained stable within numerical precision as speed increased.
Earlier browser checks covered gear lamps, signals, wipers and delivery stops.
The Lighthouse headless browser could not initialize WebGL, so its performance
score is not representative of the running game. Interactive rendering was
verified separately. Performance depends on hardware and the number of props
and detached parts currently active.

DEVELOPER HANDOFF
app.js: input, lighting, camera states and simulation/rig coordination.
physics.js: Rapier chassis, wheel dynamics, grabbing forces and impact events.
world.js: physical test fixtures, destinations and measured challenge states.
damage.js: deformation, separation, debris and repair.
direct.js: ray picking, hover previews, direct part dragging and body grabbing.
experience.js: start screen, quick animations, destinations and utility tools.
rig.js: controller hierarchy, safe driver evaluator, morphs and pose smoothing.
ui.js / styles.css: full rig inspector, icon controls and responsive styling.
audio.js: gesture-unlocked procedural sound.
assets/vehicle.json: full rig manifest and geometry layout.
assets/vehicle.bin.gz: compressed detailed geometry and deformation data.
app.bundle.js: ready-to-run minified runtime. Source map included.
qa.js: opt-in browser integration tests at ?qa=1.
serve.py: loopback-only server with precompressed asset support.

Rebuild app.bundle.js with esbuild after editing sources. Regenerate sibling
.gz files for edited JS, CSS and JSON, or remove stale compressed copies.
The application does not require node_modules to run. There is no save-game
persistence; reload starts a new session.

DEPENDENCIES
Three.js 0.180.0 (MIT), Tabler Icons 3.35.0 (MIT), Rapier compatibility engine
0.21.0 (Apache-2.0). Licenses are retained under vendor/.
https://rapier.rs/javascript3d/classes/DynamicRayCastVehicleController.html
