// player.js — first-person control for the human fighter: pointer-lock mouse
// look, acceleration-based WASD movement, crouch, a small jump whose landing
// blooms the crosshair, and collision against the world's colliders.

import { EYE, collideCircle } from "./world.js";

const scratch = { x: 0, z: 0 };

export class PlayerControl {
  constructor(fighter, world, dom) {
    this.f = fighter;
    this.world = world;
    this.keys = new Set();
    this.locked = false;
    this.landingBloom = 0;   // extra spread (rad) right after landing; decays fast
    this.wasAir = false;
    this.stepAcc = 0;

    dom.addEventListener("click", () => { if (!this.locked) dom.requestPointerLock(); });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === dom;
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      const s = fighter.zoomed ? 0.0009 : 0.0021;
      fighter.yaw -= e.movementX * s;
      fighter.pitch -= e.movementY * s;
      fighter.pitch = Math.max(-1.45, Math.min(1.45, fighter.pitch));
    });
    addEventListener("keydown", (e) => { this.keys.add(e.code); if (e.code === "Space") e.preventDefault(); });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());
  }

  get firing() { return this.mouseDown && this.locked; }

  update(dt, env) {
    const f = this.f;
    if (!f.alive) { f.vx = 0; f.vz = 0; return; }
    const k = this.keys;
    let ix = 0, iz = 0;
    if (k.has("KeyW") || k.has("ArrowUp")) iz -= 1;
    if (k.has("KeyS") || k.has("ArrowDown")) iz += 1;
    if (k.has("KeyA") || k.has("ArrowLeft")) ix -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) ix += 1;
    f.crouch = k.has("ControlLeft") || k.has("KeyC");
    const sy = Math.sin(f.yaw), cy = Math.cos(f.yaw);
    let wx = (-sy * -iz) + (cy * ix);
    let wz = (-cy * -iz) + (-sy * ix);
    const len = Math.hypot(wx, wz);
    if (len > 0.001) { wx /= len; wz /= len; }

    // Shift walks: barely half speed, and — the point — silent. Footstep
    // noise is what the bots' hearing investigates, so a walked rotation
    // genuinely cannot be heard (game.js checks this.walking in onStep).
    this.walking = k.has("ShiftLeft") || k.has("ShiftRight");
    let maxSpeed = f.crouch ? 2.1 : 5.2;
    if (this.walking) maxSpeed = Math.min(maxSpeed, 2.5);
    if (f.zoomed && f.weapon) maxSpeed *= f.weapon.def.moveCapScoped; // scoped movement cap
    if (env.phase === "buy") maxSpeed = Math.min(maxSpeed, 3.2);

    // Acceleration model: velocity chases the wish velocity; stopping is
    // quick, which is exactly why counter-strafing to shoot pays.
    const accel = f.air ? 2.2 : 14;
    f.vx += (wx * maxSpeed - f.vx) * Math.min(1, accel * dt);
    f.vz += (wz * maxSpeed - f.vz) * Math.min(1, accel * dt);
    f.speed = Math.hypot(f.vx, f.vz);
    f.moving = f.speed > 0.6;

    if (k.has("Space") && !f.air) { f.vy = 4.6; f.air = true; }
    if (f.air) {
      f.vy -= 12.5 * dt;
      f.y += f.vy * dt;
      if (f.y <= 0) {
        f.y = 0; f.air = false;
        this.landingBloom = 0.028; // small landing bloom, gone in ~200 ms
        if (this.wasAir) env.onLand();
      }
    }
    this.wasAir = f.air;
    this.landingBloom = Math.max(0, this.landingBloom - dt * 0.14);

    collideCircle(f.x + f.vx * dt, f.z + f.vz * dt, 0.45, this.world.colliders, scratch);
    f.x = scratch.x; f.z = scratch.z;
    f.x = Math.max(-37.4, Math.min(37.4, f.x));
    f.z = Math.max(-27.4, Math.min(27.4, f.z));
    f.eyeY = f.y + (f.crouch ? 1.12 : EYE);

    if (f.moving && !f.air) {
      this.stepAcc += dt * f.speed;
      if (this.stepAcc > 2.4) { this.stepAcc = 0; env.onStep(f); }
    }
  }
}
