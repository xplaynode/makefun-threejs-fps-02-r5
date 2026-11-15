// bots.js — the bot brain for SLAGLINE.
// Design rules the whole file follows:
//  * Aim is turn-rate limited: a bot's yaw/pitch chase the target at a capped
//    rate, never snapping. Aim error grows with the target's speed.
//  * A bot plants its feet and settles briefly before its first burst, fires
//    short bursts, and lets its recoil heat decay between them.
//  * Hearing only investigates FRESH noise: events 0.15–2.2 s old. Older
//    gunfire is forgotten, sounds that have not "arrived" are ignored.
//  * During the buy phase bots stage at posts behind the barrier and nobody
//    fires; the game only enables combat once the round is live.

import * as THREE from "three";
import { EYE, collideCircle, segmentBlocked, findPath } from "./world.js";
import { WEAPONS } from "./config.js";
import { placeName } from "./tactics.js";

const TURN_RATE = 2.7;          // rad/s — the fastest a bot may swing its aim
const SETTLE_SECONDS = 0.28;    // feet-planted pause before the first burst
const HEAR_MIN_AGE = 0.15, HEAR_MAX_AGE = 2.2;
const LOW_HP = 22;              // at or below this, a bot falls back
const FRESH_CONTACT = 1.2;      // carrier will not plant into contact this fresh

const scratch = { x: 0, z: 0 };
const pathBuf = new Int16Array(64);

export function createBotMesh(teamColor) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.9 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.95, 0.34), mat);
  body.position.y = 1.02;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), dark);
  head.position.y = 1.68;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.3), dark);
  legs.position.y = 0.28;
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.85), dark);
  gun.position.set(0.24, 1.28, -0.4);
  g.add(body, head, legs, gun);
  g.userData.gun = gun;
  g.userData.body = body;
  return g;
}

let nextBotId = 1;

export class Bot {
  constructor(fighter, world) {
    this.f = fighter;
    this.world = world;
    this.id = nextBotId++;
    // perception
    this.target = null;
    this.lastSeenAt = -99;
    this.lastSeenX = 0; this.lastSeenZ = 0;
    this.lastContactAt = -99;   // last time an enemy was seen or hurt us
    this.perceptAt = Math.random() * 0.12;
    // aim
    this.settleT = 0;
    this.burstLeft = 0;
    this.burstWait = 0;
    this.recoilHeat = 0;
    this.nextShotAt = 0;
    // movement
    this.path = new Int16Array(64);
    this.pathLen = 0; this.pathIdx = 0;
    this.goalX = fighter.x; this.goalZ = fighter.z;
    this.hasGoal = false;
    this.stuckT = 0; this.lastX = fighter.x; this.lastZ = fighter.z;
    this.moveSpeed = 0;
    // tactics
    this.role = "entry";
    this.postX = fighter.x; this.postZ = fighter.z;
    this.usedUtilityThisRound = false;
    this.repathCooldown = 0;
    this.thinkAt = Math.random() * 0.2;
    this.state = "stage";
    // plan execution (assigned by game.js from tactics.js each round)
    this.assign = null;         // {lane, hold, fakeHold, executeAt, fakeUntil, faceYaw, holdForRetake}
    this.lastCallAt = -99;      // last radio contact call (rate-limited)
    this.planFlashed = false;   // the execute/fake flash has been thrown
    this.stepAcc = 0;           // metres travelled toward the next footstep noise
    this.tradedFor = null;      // the death this bot has already swung for
  }

  resetForRound(post, assign) {
    this.target = null;
    this.lastSeenAt = -99;
    this.lastContactAt = -99;
    this.settleT = 0; this.burstLeft = 0; this.burstWait = 0; this.recoilHeat = 0;
    this.usedUtilityThisRound = false;
    this.planFlashed = false;
    this.rotated = false;
    this.tradedFor = null;
    this.assign = assign || null;
    this.postX = post.x; this.postZ = post.z;
    this.goalX = post.x; this.goalZ = post.z; this.hasGoal = true;
    this.state = "stage";
    this.pathLen = 0;
  }

  setGoal(x, z) {
    this.goalX = x; this.goalZ = z; this.hasGoal = true;
    const wps = this.world.waypoints;
    const from = this.world.nearestWaypoint(this.f.x, this.f.z);
    const to = this.world.nearestWaypoint(x, z);
    this.pathLen = findPath(this.world, from, to, pathBuf);
    for (let i = 0; i < this.pathLen; i++) this.path[i] = pathBuf[i];
    this.pathIdx = 0;
    void wps;
  }

  // --- perception ---------------------------------------------------------
  perceive(now, env) {
    const f = this.f;
    let best = null, bestD = 46;
    for (const e of env.fighters) {
      if (!e.alive || e.team === f.team) continue;
      const dx = e.x - f.x, dz = e.z - f.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD) continue;
      // field of view: 130 degrees around facing
      const ang = Math.atan2(-dx, -dz);
      let diff = Math.abs(((ang - f.yaw) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      if (d > 4 && diff > 1.15) continue;
      if (segmentBlocked(f.x, f.z, e.x, e.z, this.world.colliders)) continue;
      if (env.smokeBlocks(f.x, EYE, f.z, e.x, EYE, e.z)) continue;
      best = e; bestD = d;
    }
    if (best) {
      const fresh = now - this.lastSeenAt > 1.6 || this.target !== best;
      this.target = best;
      this.lastSeenAt = now;
      this.lastSeenX = best.x; this.lastSeenZ = best.z;
      this.lastContactAt = now;
      // Radio the contact: the call itself is rate-limited, but the intel
      // share is not — a teammate who hears "contact, mid" turns toward
      // mid whether or not this bot had breath to shout it twice. Neither
      // happens during the buy phase: staging posts can be in sight of
      // each other across the barriers, and a "contact" call before the
      // round is live is noise, not information.
      if (env.phase === "live" || env.phase === "planted") {
        if (env.shareIntel) env.shareIntel(this, best);
        if (fresh && now - this.lastCallAt > 5 && env.callContact) {
          this.lastCallAt = now;
          env.callContact(this, placeName(best.x, best.z));
        }
      }
    } else if (now - this.lastSeenAt > 3.5) {
      this.target = null;
    }
    // hearing: only noise in the fresh window draws an investigation
    if (!this.target && env.phase === "live") {
      const heard = env.noise.recent(now, HEAR_MIN_AGE, HEAR_MAX_AGE);
      for (const n of heard) {
        const d = Math.hypot(n.x - f.x, n.z - f.z);
        if (d < n.radius && d > 3) {
          this.setGoal(n.x, n.z);
          this.state = "investigate";
          break;
        }
      }
    }
  }

  // --- aim ----------------------------------------------------------------
  aimAt(now, dt, tx, tz, targetSpeed) {
    const f = this.f;
    const dx = tx - f.x, dz = tz - f.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    const wantYaw = Math.atan2(-dx, -dz);
    let dy = ((wantYaw - f.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const maxTurn = TURN_RATE * dt;
    f.yaw += Math.max(-maxTurn, Math.min(maxTurn, dy));
    const wantPitch = Math.atan2(1.35 - EYE, dist);
    f.pitch += Math.max(-maxTurn, Math.min(maxTurn, wantPitch - f.pitch));
    // error grows with target speed and with our own recoil heat
    const err = 0.016 + targetSpeed * 0.011 + this.recoilHeat * 0.02;
    return { yaw: f.yaw + (Math.random() * 2 - 1) * err, pitch: f.pitch + (Math.random() * 2 - 1) * err * 0.7, dist, aligned: Math.abs(dy) < 0.06 };
  }

  // --- main update ----------------------------------------------------------
  update(dt, now, env) {
    const f = this.f;
    if (!f.alive) return;
    this.stepEnv = env.step || null;   // moveToward has no env parameter; this is its wire to the noise bus
    this.perceptAt -= dt;
    if (this.perceptAt <= 0) { this.perceptAt = 0.12; this.perceive(now, env); }
    this.recoilHeat = Math.max(0, this.recoilHeat - dt * 1.4);
    this.repathCooldown -= dt;

    if (env.phase === "buy") {
      // Stage at the assigned post behind the barrier. Weapons stay silent.
      this.moveToward(dt, this.postX, this.postZ, 2.2);
      return;
    }
    if (env.phase !== "live" && env.phase !== "planted") return;

    // Velocity is re-earned every step by the movement code below. Clearing
    // it here means a fighting (stationary) bot reports speed 0 — otherwise
    // the last travel velocity would linger forever and inflate both its
    // own spread and every opponent's aim error against it.
    f.vx = 0; f.vz = 0;

    const hp = f.hp;
    // Low-health fallback: break off and hold a defensive post.
    if (hp <= LOW_HP && this.state !== "fallback" && env.phase === "live") {
      this.state = "fallback";
      const post = env.fallbackPost(f.team, this.id);
      this.setGoal(post.x, post.z);
    }

    // Reload during lulls only — never with a fresh target.
    if (f.weapon && f.weapon.ammo === 0 && now - this.lastSeenAt > 1) env.reload(f);
    else if (f.weapon && f.weapon.ammo <= f.weapon.def.mag * 0.3 && now - this.lastSeenAt > 2.5 && !f.reloading) env.reload(f);

    if (this.target && this.target.alive && now - this.lastSeenAt < 1.6) {
      this.fight(dt, now, env);
      return;
    }
    // Engagement over: the next first burst must settle again from zero.
    this.settleT = 0;

    // Trade frags: a teammate died nearby in the last 2.5 s and nobody has
    // swung for it yet — the nearest living teammate takes the swing at the
    // killer's last known position. One bot trades each death, once.
    const death = env.lastDeath;
    if (death && death.team === f.team && death.victim !== f && this.tradedFor !== death &&
        now - death.at < 2.5 && env.phase === "live") {
      const d = Math.hypot(death.x - f.x, death.z - f.z);
      if (d < 17 && env.claimTrade(this, death)) {
        this.tradedFor = death;
        this.setGoal(death.x, death.z);
        this.state = "trade";
        if (env.callTrade) env.callTrade(this);
      }
    }

    // Shared intel: a teammate's radioed contact is worth a look. Respond
    // only when free (not holding a retake post, not the carrier mid-plant
    // run) and only while the intel is fresh — chasing ghosts loses rounds.
    if (!this.target && env.phase === "live" && this.state !== "fallback" &&
        !(this.assign && this.assign.holdForRetake)) {
      const intel = env.intel ? env.intel(f.team, now) : null;
      if (intel && intel.by !== f.name) {
        const d = Math.hypot(intel.x - f.x, intel.z - f.z);
        if (d > 5 && d < 30 && this.state !== "respond") {
          this.setGoal(intel.x, intel.z);
          this.state = "respond";
        }
      }
    }

    // Holding a post means WATCHING the door it covers: when idle at the
    // goal with no target, settle the yaw onto the assigned facing instead
    // of staring at the last travel direction.
    if (this.assign && this.assign.faceYaw !== undefined &&
        Math.hypot(this.goalX - f.x, this.goalZ - f.z) < 1.3) {
      const want = this.assign.faceYaw;
      let diff = ((want - f.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      f.yaw += Math.max(-2.2 * dt, Math.min(2.2 * dt, diff));
    }

    // Objective / role movement.
    this.thinkAt -= dt;
    if (this.thinkAt <= 0) { this.thinkAt = 0.25; this.decideObjective(now, env); }
    const speed = this.state === "fallback" ? 3.4 : 3.1;
    if (this.hasGoal) this.moveAlongPath(dt, speed, env);
    f.speed = Math.hypot(f.vx, f.vz);
    f.moving = f.speed > 0.6;
  }

  fight(dt, now, env) {
    const f = this.f, t = this.target;
    const tspeed = Math.hypot(t.vx || 0, t.vz || 0);
    const aim = this.aimAt(now, dt, t.x, t.z, tspeed);
    // Settle: feet planted briefly before the first burst of an engagement.
    if (this.settleT < SETTLE_SECONDS) {
      this.settleT += dt;
      f.crouch = f.crouch; // hold position; movement stops because we return here
      return;
    }
    if (!f.weapon || f.reloading) return;
    if (this.burstWait > 0) { this.burstWait -= dt; return; }
    if (this.burstLeft <= 0) {
      this.burstLeft = 3 + (Math.random() * 3 | 0);
      this.burstWait = 0.22 + Math.random() * 0.25;
    }
    if (now >= this.nextShotAt && aim.aligned) {
      const interval = 60 / f.weapon.def.rpm;
      this.nextShotAt = now + interval * (f.weapon.def.auto ? 1 : 2.6);
      this.burstLeft--;
      this.recoilHeat = Math.min(1, this.recoilHeat + 0.16);
      env.shoot(f, aim.yaw, aim.pitch, this.recoilHeat);
      if (f.weapon.ammo <= 0) env.reload(f);
    }
  }

  decideObjective(now, env) {
    const f = this.f;
    const bomb = env.bomb;
    if (f.team === "ember") {
      if (bomb.state === "planted") {
        // Post-plant: spread out around the site and hold angles.
        const post = env.postPlantPost(this.id, bomb.site);
        this.setGoal(post.x, post.z);
        this.state = "hold";
        return;
      }
      const a = this.assign;
      const site = env.targetSite;
      const roundT = env.roundT ? env.roundT() : 99;
      if (f.hasBomb) {
        // On a fake, the carrier never shows at the fake lane: it stages at
        // mid until the show ends, then walks the real site.
        if (a && a.fakeHold && roundT < a.fakeUntil) {
          this.setGoal(a.fakeHold.x, a.fakeHold.z);
          this.state = "stageFake";
          return;
        }
        // On a default, the carrier leaves late so it arrives WITH the
        // execute, not thirty seconds before it, alone.
        if (a && roundT < a.executeAt - 6 && a.hold) {
          this.setGoal(a.hold.x, a.hold.z);
          this.state = "setup";
          return;
        }
        // The carrier must not plant into a fresh contact.
        const d = Math.hypot(site.x - f.x, site.z - f.z);
        if (d < site.r - 1) {
          if (now - this.lastContactAt > FRESH_CONTACT) env.plant(f, site);
          else { this.state = "waitCover"; return; }
        } else {
          this.maybeUtility(env, site);
          this.setGoal(site.x + (this.id % 3 - 1) * 2, site.z + (this.id % 2) * 2);
          this.state = "push";
        }
        return;
      }
      // A dropped primary on the way is worth a two-second detour: an
      // unarmed bot swinging a site helps nobody.
      if (!f.primaryId && env.nearestDrop) {
        const drop = env.nearestDrop(f);
        if (drop) { this.setGoal(drop.x, drop.z); this.state = "fetchDrop"; return; }
      }
      if (!a) {
        // No plan assigned (should not happen): the r4 behaviour.
        if (this.role === "lurk") { this.setGoal(0, -4); this.state = "hold"; return; }
        this.maybeUtility(env, site);
        this.setGoal(site.x + (this.id % 5 - 2) * 2.4, site.z + (this.id % 3 - 1) * 2.4);
        this.state = "push";
        return;
      }
      // The fake: show at the fake lane's mouth, make the noise, throw the
      // one flash — then rotate. Nobody enters the fake site itself.
      if (a.fakeHold && this.role !== "lurk" && roundT < a.fakeUntil) {
        if (roundT > a.fakeUntil - 1.4) this.planUtility(env, a.fakeSite || site);
        this.setGoal(a.fakeHold.x + (this.id % 3 - 1) * 2, a.fakeHold.z + (this.id % 2) * 2);
        this.state = "fake";
        return;
      }
      if (a.fakeHold && roundT >= a.fakeUntil && !this.rotated) {
        this.rotated = true;
        if (env.callRotate) env.callRotate(this, site.key);
      }
      // The lurker's job is information and the late flank: hold mid, and
      // only walk the site once the execute is fully committed.
      if (this.role === "lurk") {
        if (roundT < a.executeAt + 9) { this.setGoal(a.hold.x, a.hold.z); this.state = "hold"; return; }
        this.setGoal(site.x, site.z + 4);
        this.state = "flank";
        return;
      }
      // Before the execute: stage at the lane approach. Picks are welcome
      // (the fight code handles any contact), wandering in is not.
      if (roundT < a.executeAt) {
        this.setGoal(a.hold.x + (this.id % 3 - 1) * 2.2, a.hold.z + (this.id % 2 - 1) * 2.2);
        this.state = "setup";
        return;
      }
      // Execute: the support's flash goes the moment the hit starts, from
      // approach range — not whenever a distance check happens to trip.
      if (!this.planFlashed) this.planUtility(env, site);
      this.maybeUtility(env, site);
      this.setGoal(site.x + (this.id % 5 - 2) * 2.4, site.z + (this.id % 3 - 1) * 2.4);
      this.state = "push";
    } else {
      // Wardens.
      if (bomb.state === "planted") {
        const role = env.retakeRole(this, bomb);
        if (role === "defuse") { this.setGoal(bomb.x, bomb.z); this.state = "retakeDefuse"; if (Math.hypot(bomb.x - f.x, bomb.z - f.z) < 1.6) env.defuse(f); }
        else if (role === "cover") { this.state = "hold"; }
        else {
          this.maybeUtility(env, { x: bomb.x, z: bomb.z });
          this.setGoal(bomb.x, bomb.z); this.state = "retakePush";
        }
        return;
      }
      if (bomb.state === "carried" || bomb.state === "dropped") {
        // Hold assigned posts; the closest warden rotates toward any drop.
        if (this.role === "rotate" && bomb.state === "dropped") { this.setGoal(bomb.x, bomb.z); this.state = "rotate"; return; }
        this.setGoal(this.postX, this.postZ);
        this.state = "hold";
        return;
      }
    }
  }

  // The plan-timed throw: a flash (attackers) or smoke (defenders) sent at
  // the site entrance at the exact moment the plan converts — the fake's
  // single flash, or the execute's entry flash. Longer range than the
  // opportunistic maybeUtility below, and it spends the planFlashed flag
  // so the two systems never double-throw the same grenade.
  planUtility(env, site) {
    const f = this.f;
    this.planFlashed = true;
    const d = Math.hypot(site.x - f.x, site.z - f.z);
    if (d > 22 || d < 3) return;
    const entry = { x: site.x, z: site.z + 6 };   // the door, not the pad centre
    if (f.team === "ember" && f.grenades.flash > 0) {
      f.grenades.flash--; this.usedUtilityThisRound = true;
      env.throwGrenade(f, "flash", entry.x, entry.z);
    } else if (f.team === "warden" && f.grenades.smoke > 0) {
      f.grenades.smoke--; this.usedUtilityThisRound = true;
      env.throwGrenade(f, "smoke", entry.x, entry.z);
    }
  }

  // Utility: flash before a site entry, smoke or frag on a retake — once per
  // round per bot, thrown toward the objective from approach range.
  maybeUtility(env, site) {
    const f = this.f;
    if (this.usedUtilityThisRound) return;
    const d = Math.hypot(site.x - f.x, site.z - f.z);
    if (d > 13 || d < 4) return;
    if (f.grenades.flash > 0 && f.team === "ember") {
      f.grenades.flash--; this.usedUtilityThisRound = true;
      env.throwGrenade(f, "flash", site.x, site.z);
    } else if (f.team === "warden" && f.grenades.smoke > 0) {
      f.grenades.smoke--; this.usedUtilityThisRound = true;
      env.throwGrenade(f, "smoke", site.x, site.z);
    } else if (f.team === "warden" && f.grenades.frag > 0) {
      f.grenades.frag--; this.usedUtilityThisRound = true;
      env.throwGrenade(f, "frag", site.x, site.z);
    }
  }

  // --- movement -------------------------------------------------------------
  moveToward(dt, tx, tz, speed) {
    const f = this.f;
    const dx = tx - f.x, dz = tz - f.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.4) { f.vx = 0; f.vz = 0; return true; }
    // Footsteps are noise: every ~2.6 m of travel posts a step to the bus,
    // so a rotating team can be HEARD rotating. Standing fights stay quiet.
    this.stepAcc += speed * dt;
    if (this.stepAcc > 2.6) { this.stepAcc = 0; if (this.stepEnv) this.stepEnv(f); }
    const vx = (dx / d) * speed, vz = (dz / d) * speed;
    f.vx = vx; f.vz = vz;
    collideCircle(f.x + vx * dt, f.z + vz * dt, 0.45, this.world.colliders, scratch);
    f.x = scratch.x; f.z = scratch.z;
    // face travel direction when not fighting
    if (!this.target) {
      const want = Math.atan2(-vx, -vz);
      let diff = ((want - f.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      f.yaw += Math.max(-3.2 * dt, Math.min(3.2 * dt, diff));
    }
    return false;
  }

  moveAlongPath(dt, speed, env) {
    const f = this.f;
    // Stuck detection: commanded to move but barely displaced → re-path.
    const moved = Math.hypot(f.x - this.lastX, f.z - this.lastZ);
    if (speed > 0.5) {
      if (moved < 0.04) this.stuckT += dt; else this.stuckT = 0;
      if (this.stuckT > 0.7 && this.repathCooldown <= 0) {
        this.stuckT = 0; this.repathCooldown = 1.5;
        this.setGoal(this.goalX, this.goalZ);
        // sidestep to break the snag
        f.x += (Math.random() - 0.5) * 1.2;
        f.z += (Math.random() - 0.5) * 1.2;
      }
    }
    this.lastX = f.x; this.lastZ = f.z;

    if (this.pathIdx < this.pathLen) {
      const node = this.world.waypoints[this.path[this.pathIdx]];
      if (this.moveToward(dt, node.x, node.z, speed)) this.pathIdx++;
    } else {
      this.moveToward(dt, this.goalX, this.goalZ, speed);
    }
    void env;
  }
}
