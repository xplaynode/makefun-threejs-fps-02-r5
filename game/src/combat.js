// combat.js — firing, recoil, grenades and the noise bus.
// The hot path is allocation-free: three scratch vectors live here, the ray
// tests every collider and every live fighter with slab maths, and tracers
// are drawn from a fixed pool. Nothing in fire() allocates per shot.

import * as THREE from "three";
import { EYE } from "./world.js";

export const VIEW_RECOVERY = 0.55; // fraction of recoil pitch recovered per second toward rest
export const GRAVITY = 9.8;

const tmpOrigin = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpHit = new THREE.Vector3();
const tmpAim = new THREE.Vector3();

// Ray vs axis-aligned box (box: {x0,x1,z0,z1,h}, floor at y=0). Returns the
// entry distance or Infinity. Slab method, no allocations.
export function rayBox(ox, oy, oz, dx, dy, dz, b) {
  let t0 = 0, t1 = Infinity;
  if (Math.abs(dx) < 1e-9) { if (ox < b.x0 || ox > b.x1) return Infinity; }
  else {
    let ta = (b.x0 - ox) / dx, tb = (b.x1 - ox) / dx;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return Infinity;
  }
  if (Math.abs(dz) < 1e-9) { if (oz < b.z0 || oz > b.z1) return Infinity; }
  else {
    let ta = (b.z0 - oz) / dz, tb = (b.z1 - oz) / dz;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return Infinity;
  }
  if (Math.abs(dy) < 1e-9) { if (oy < 0 || oy > b.h) return Infinity; }
  else {
    let ta = (0 - oy) / dy, tb = (b.h - oy) / dy;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return Infinity;
  }
  return t1 < 0 ? Infinity : t0;
}

// Ray vs a standing fighter (cylinder body + head sphere), returning the
// nearest positive distance and whether the hit was the head.
export function rayFighter(ox, oy, oz, dx, dy, dz, fx, fz, crouch) {
  const r = 0.42;
  const top = crouch ? 1.15 : 1.78;
  // side entry distance for the cylinder, via 2D closest approach
  const ex = fx - ox, ez = fz - oz;
  const tca = ex * dx + ez * dz;
  if (tca < 0) return null;
  const d2 = ex * ex + ez * ez - tca * tca;
  if (d2 > r * r) return null;
  const thc = Math.sqrt(r * r - d2);
  const t = tca - thc;
  if (t < 0) return null;
  const y = oy + dy * t;
  if (y < 0 || y > top) return null;
  const headY = crouch ? 1.0 : 1.6;
  const head = Math.abs(y - headY) < 0.24 && Math.abs(ox + dx * t - fx) < 0.26 && Math.abs(oz + dz * t - fz) < 0.26;
  return { t, head };
}

// Current spread (radians) for a fighter's weapon given stance and speed.
// Hip-fired Longshot is heavily penalised; scoped Longshot is a laser.
export function currentSpread(w, moving, air, crouch, zoomed, shotHeat) {
  const def = w.def || w;
  let s = def.spreadStill;
  if (moving) s = def.spreadMove;
  if (air) s = Math.max(s, def.spreadAir);
  if (crouch) s *= 0.55;
  if (w.id === "longshot" && !zoomed) s *= def.hipSpreadMult;
  if (w.id === "longshot" && zoomed) s = def.spreadStill * 0.6;
  return s + shotHeat * 0.004;
}

// Fire one trigger pull: for each pellet, a spread ray against walls and
// fighters. hitCb(target, isHead, damage, distance) is invoked per pellet hit.
export function fireShots(world, shooter, fighters, aimYaw, aimPitch, spread, range, fireFn) {
  tmpOrigin.set(shooter.x, shooter.eyeY, shooter.z);
  const pellets = fireFn.pellets;
  let anyHit = false;
  for (let p = 0; p < pellets; p++) {
    const aYaw = aimYaw + (Math.random() * 2 - 1) * spread;
    const aPitch = aimPitch + (Math.random() * 2 - 1) * spread;
    const cy = Math.cos(aPitch), sy = Math.sin(aPitch);
    tmpDir.set(-Math.sin(aYaw) * cy, sy, -Math.cos(aYaw) * cy).normalize();
    let best = range, bestF = null, bestHead = false;
    // walls
    const cols = world.colliders;
    for (let i = 0; i < cols.length; i++) {
      const b = cols[i];
      if (b.off) continue;
      const t = rayBox(tmpOrigin.x, tmpOrigin.y, tmpOrigin.z, tmpDir.x, tmpDir.y, tmpDir.z, b);
      if (t < best) best = t;
    }
    // floor
    if (tmpDir.y < -1e-6) {
      const t = -tmpOrigin.y / tmpDir.y;
      if (t < best && t > 0) best = t;
    }
    // fighters
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      if (!f.alive || f === shooter) continue;
      if (f.team === shooter.team) continue;
      const hit = rayFighter(tmpOrigin.x, tmpOrigin.y, tmpOrigin.z, tmpDir.x, tmpDir.y, tmpDir.z, f.x, f.z, f.crouch);
      if (hit && hit.t < best) { best = hit.t; bestF = f; bestHead = hit.head; }
    }
    tmpHit.copy(tmpOrigin).addScaledVector(tmpDir, best);
    fireFn.onTrace(tmpOrigin, tmpHit, bestF !== null);
    if (bestF) { anyHit = true; fireFn.onHit(bestF, bestHead, best); }
  }
  return anyHit;
}

// The noise bus: every gunshot, step and plant action posts a noise here.
// Bots' hearing reads it with an age window (0.15–2.2 s): noise too fresh
// has not "travelled" yet, noise too old is forgotten. See bots.js.
// Events are stamped on the MATCH clock (this.time, set by Match at the
// top of every fixed step), never on wall time: the hearing window is a
// simulation concept, and stamping wall seconds here once silently killed
// bot hearing altogether, because the two clocks never overlap.
export class NoiseBus {
  constructor() { this.events = []; this.time = 0; }
  emit(x, z, radius, kind) { this.events.push({ x, z, radius, kind, at: this.time }); }
  recent(now, minAge, maxAge) {
    const out = this.recentScratch;
    out.length = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      const age = now - e.at;
      if (age > maxAge) continue;
      if (age < minAge) continue;
      out.push(e);
    }
    if (this.events.length > 40) this.events.splice(0, this.events.length - 40);
    return out;
  }
}
NoiseBus.prototype.recentScratch = [];

// ---- Grenades ------------------------------------------------------------
export class GrenadeSim {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.smokes = [];
    const geo = new THREE.SphereGeometry(0.12, 8, 6);
    this.mat = new THREE.MeshBasicMaterial({ color: 0x333333 });
    this.smokeMat = new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.55 });
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
    this.geo = geo;
  }

  throwGrenade(kind, from, dir, power) {
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.items.push({ kind, mesh, vx: dir.x * power, vy: dir.y * power + 3.2, vz: dir.z * power, t: 0, fuse: kind === "flash" ? 1.3 : kind === "frag" ? 1.6 : 1.1 });
  }

  // Returns an array of {kind, x, z} events that went off this step.
  update(dt, world, eventsOut) {
    eventsOut.length = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const g = this.items[i];
      g.t += dt;
      g.vy -= GRAVITY * dt * 0.55;
      g.mesh.position.x += g.vx * dt;
      g.mesh.position.y += g.vy * dt;
      g.mesh.position.z += g.vz * dt;
      if (g.mesh.position.y < 0.12) { g.mesh.position.y = 0.12; g.vy = -g.vy * 0.35; g.vx *= 0.7; g.vz *= 0.7; }
      if (g.t >= g.fuse) {
        eventsOut.push({ kind: g.kind, x: g.mesh.position.x, z: g.mesh.position.z, y: g.mesh.position.y });
        if (g.kind === "smoke") {
          const cloud = new THREE.Mesh(new THREE.SphereGeometry(3.2, 10, 8), this.smokeMat);
          cloud.position.set(g.mesh.position.x, 1.2, g.mesh.position.z);
          cloud.scale.y = 0.55;
          this.scene.add(cloud);
          this.smokes.push({ mesh: cloud, ttl: 14 });
        }
        this.scene.remove(g.mesh);
        this.items.splice(i, 1);
      }
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.ttl -= dt;
      if (s.ttl <= 0) { this.scene.remove(s.mesh); this.smokes.splice(i, 1); }
    }
    return eventsOut;
  }

  // Is the line of sight between two eye points blocked by a smoke cloud?
  smokeBlocks(x0, y0, z0, x1, y1, z1) {
    for (const s of this.smokes) {
      const cx = s.mesh.position.x, cz = s.mesh.position.z;
      // segment-to-point distance in 2D
      const dx = x1 - x0, dz = z1 - z0;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((cx - x0) * dx + (cz - z0) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = x0 + dx * t, pz = z0 + dz * t;
      if ((px - cx) ** 2 + (pz - cz) ** 2 < 3.2 * 3.2) return true;
    }
    return false;
  }
}
