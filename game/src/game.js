// game.js — the SLAGLINE match engine. One Match object holds ALL state:
// fighters, money, the bomb, phase timers and the score. The simulation runs
// on a fixed step (see main.js) and never touches the DOM; the HUD reads a
// snapshot each frame. Rendering data (meshes, tracers) is written here but
// the three.js scene graph is only mutated with pooled objects.

import * as THREE from "three";
import { WEAPONS, GRENADES, ARMOR_PRICE, KIT_PRICE, MATCH, ECONOMY, TEAMS, BOT_NAMES, KILL_REWARD, nextLossBonus } from "./config.js";
import { EYE } from "./world.js";
import { fireShots, currentSpread, NoiseBus, GrenadeSim } from "./combat.js";
import { Bot, createBotMesh } from "./bots.js";
import { PlayerControl } from "./player.js";
import { buyCall, chooseEmberPlan, chooseWardenPlan, placeName, RADIO } from "./tactics.js";
import { Radio } from "./radio.js";

function makeWeapon(id) {
  return { id, def: WEAPONS[id], ammo: WEAPONS[id].mag, reserve: WEAPONS[id].reserve, reloading: 0, shotIdx: 0, lastShotAt: -9 };
}

function makeFighter(name, team, isPlayer) {
  return {
    name, team, isPlayer, alive: true,
    x: 0, z: 0, y: 0, vy: 0, vx: 0, vz: 0, speed: 0, moving: false, air: false,
    yaw: 0, pitch: 0, kickPitch: 0, kickYaw: 0, eyeY: EYE, crouch: false, zoomed: false,
    hp: 100, armor: 0, hasKit: false, hasBomb: false,
    money: MATCH.startMoney, kills: 0, deaths: 0, dmgDealt: 0,
    weapon: makeWeapon("sidearm"), primaryId: null, sidearmId: "sidearm",
    grenades: { flash: 0, frag: 0, smoke: 0 },
    blindT: 0, deafT: 0, lastHurtAt: -9, lastHurtFrom: 0,
  };
}

export class Match {
  constructor(scene, world, sounds, hud, canvas, opts = {}) {
    this.scene = scene; this.world = world; this.sounds = sounds; this.hud = hud;
    this.demo = !!opts.demo;
    this.fast = !!opts.fast;
    this.timeScale = this.fast ? 3 : 1;
    this.now = 0;
    this.noise = new NoiseBus();
    this.grenades = new GrenadeSim(scene);
    this.grenadeEvents = [];
    this.fighters = [];
    this.bots = new Map();

    for (const team of ["ember", "warden"]) {
      for (let i = 0; i < MATCH.teamSize; i++) {
        const isPlayer = team === "ember" && i === 0 && !this.demo;
        const f = makeFighter(isPlayer ? "You" : BOT_NAMES[team][i], team, isPlayer);
        this.fighters.push(f);
        if (!isPlayer) {
          f.mesh = createBotMesh(TEAMS[team].color);
          scene.add(f.mesh);
          this.bots.set(f, new Bot(f, world));
        }
      }
    }
    this.player = this.fighters.find((f) => f.isPlayer) || this.fighters[0];
    // In demo mode every fighter (the camera fighter included) already got a
    // bot and a mesh in the loop above, so the game plays itself hands-free.
    this.control = this.demo ? null : new PlayerControl(this.player, world, canvas);
    this.controlEnv = {
      phase: "buy",
      // A shift-walked step makes no noise at all — that silence is the
      // entire reason to walk (see player.js).
      onStep: (f) => { if (!this.control || !this.control.walking) this.noise.emit(f.x, f.z, 9, "step"); },
      onLand: () => this.noise.emit(this.player.x, this.player.z, 7, "land"),
    };

    // Bomb prop: a charge case with a blinking lamp.
    this.bombMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.24, 0.36),
      new THREE.MeshStandardMaterial({ color: 0x1d1d1f, roughness: 0.6 })
    );
    this.bombLamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff2222 })
    );
    this.bombMesh.add(this.bombLamp);
    this.bombLamp.position.set(0, 0.16, 0);
    scene.add(this.bombMesh);

    // Tracer pool: one LineSegments, 48 segments, positions rewritten in place.
    this.tracerCount = 48;
    this.tracerPos = new Float32Array(this.tracerCount * 6);
    this.tracerLife = new Float32Array(this.tracerCount);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(this.tracerPos, 3));
    this.tracers = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.75 }));
    this.tracers.frustumCulled = false;
    scene.add(this.tracers);
    this.tracerIdx = 0;

    this.score = { ember: 0, warden: 0 };
    this.lossStreak = { ember: 0, warden: 0 };
    this.radio = new Radio();
    this.liveT = 0;              // seconds since the round went live
    this.lastDeath = null;       // {victim, killer, x, z, at, team, claimedBy}
    this.lastSiteKey = null;     // the site Ember hit last round (plan memory)
    this.emberPlan = null;
    this.wardenPlan = null;
    this.buyCalls = { ember: null, warden: null };
    this.roundHistory = [];      // [{winner, mvp}] for the HUD round dots
    this.drops = [];             // dropped primaries lying in the world
    this.round = 0;
    this.phase = "buy";
    this.phaseT = 0;
    this.bomb = { state: "carried", x: 0, z: 0, site: null, carrier: null, timer: 0 };
    this.planting = null;
    this.defusing = null;
    this.targetSite = world.sites.A;
    this.matchOver = false;
    this.winner = null;
    this.mouseDown = false;
    this.nextPlayerShot = 0;

    this.env = this.buildBotEnv();
    this.startRound();
  }

  // ---- bot environment -----------------------------------------------------
  buildBotEnv() {
    const m = this;
    return {
      fighters: this.fighters,
      noise: this.noise,
      get phase() { return m.bomb.state === "planted" ? "planted" : m.phase; },
      get bomb() { return m.bomb; },
      get targetSite() { return m.targetSite; },
      smokeBlocks: (a, b, c, d, e, f) => m.grenades.smokeBlocks(a, b, c, d, e, f),
      shoot: (f, yaw, pitch, heat) => m.shoot(f, yaw, pitch, heat),
      reload: (f) => m.startReload(f),
      throwGrenade: (f, kind, tx, tz) => m.throwGrenade(f, kind, tx, tz),
      plant: (f, site) => m.tryPlant(f, site),
      defuse: (f) => m.tryDefuse(f),
      fallbackPost: (team, id) => {
        const posts = team === "ember" ? m.world.emberPosts : m.world.wardenPosts;
        return posts[id % posts.length];
      },
      // --- the r5 team layer: radio, intel, trades, drops, footsteps ---
      get lastDeath() { return m.lastDeath; },
      roundT: () => m.liveT,
      step: (f) => {
        m.noise.emit(f.x, f.z, 8, "step");
        const dp = Math.hypot(f.x - m.player.x, f.z - m.player.z);
        if (!m.demo && dp < 13 && f !== m.player) m.sounds.step(Math.max(0.1, 1 - dp / 13));
      },
      shareIntel: (bot, enemy) => m.radio.shareIntel(bot.f.team, enemy.x, enemy.z, m.now, bot.f.name),
      callContact: (bot, place) => m.radio.push(bot.f.team, bot.f.name, RADIO.contact(place), m.now),
      callTrade: (bot) => m.radio.push(bot.f.team, bot.f.name, RADIO.trade(), m.now),
      callRotate: (bot, siteKey) => m.radio.push(bot.f.team, bot.f.name, RADIO.rotate(siteKey), m.now),
      intel: (team, now) => m.radio.intelFor(team, now, 3.2),
      claimTrade: (bot, death) => {
        if (death.claimedBy) return false;
        death.claimedBy = bot;
        return true;
      },
      nearestDrop: (f) => {
        let best = null, bd = 16;
        for (const d of m.drops) {
          const dist = Math.hypot(d.x - f.x, d.z - f.z);
          if (dist < bd) { bd = dist; best = d; }
        }
        return best;
      },
      postPlantPost: (id, site) => {
        const ring = [[-4, -3], [4, -3], [-4, 3], [4, 3], [0, -5.5]];
        const p = ring[id % ring.length];
        return { x: site.x + p[0], z: site.z + p[1] };
      },
      retakeRole: (bot, bomb) => {
        const wardens = m.fighters.filter((f) => f.team === "warden" && f.alive)
          .sort((a, b) => (Math.hypot(a.x - bomb.x, a.z - bomb.z) - Math.hypot(b.x - bomb.x, b.z - bomb.z)));
        if (wardens[0] === bot.f) return "defuse";
        if (wardens[1] === bot.f) return "cover";
        return "push";
      },
    };
  }

  // ---- round flow ------------------------------------------------------------
  startRound() {
    this.round++;
    const w = this.world;
    this.phase = "buy";
    this.phaseT = MATCH.buySeconds / this.timeScale;
    this.liveT = 0;
    this.lastDeath = null;
    this.bomb = { state: "carried", x: 0, z: 0, site: null, carrier: null, timer: 0 };
    this.planting = null; this.defusing = null;
    for (const d of this.drops) this.scene.remove(d.mesh);
    this.drops = [];
    w.setBarrier(true);
    for (const f of this.fighters) f.dmgDealt = 0;

    const embers = this.fighters.filter((f) => f.team === "ember");
    const wardens = this.fighters.filter((f) => f.team === "warden");

    // --- Plans and buy calls, chosen ONCE per round from the same numbers
    // the payouts use (tactics.js). The plan picks Ember's site; the call
    // shapes every bot's shopping below.
    const avgMoney = (team) => team.reduce((s, f) => s + f.money, 0) / team.length;
    this.buyCalls = {
      ember: buyCall(avgMoney(embers), this.lossStreak.ember, this.round),
      warden: buyCall(avgMoney(wardens), this.lossStreak.warden, this.round),
    };
    this.emberPlan = chooseEmberPlan({
      round: this.round, lossStreak: this.lossStreak.ember,
      scoreFor: this.score.ember, scoreAgainst: this.score.warden,
      lastId: this.emberPlan ? this.emberPlan.id : null, lastSite: this.lastSiteKey,
      callId: this.buyCalls.ember.id,
    });
    this.wardenPlan = chooseWardenPlan({
      round: this.round, lossStreak: this.lossStreak.warden,
      scoreFor: this.score.warden, scoreAgainst: this.score.ember,
      lastId: this.wardenPlan ? this.wardenPlan.id : null, lastSite: this.lastSiteKey,
      callId: this.buyCalls.warden.id,
    });
    this.targetSite = w.sites[this.emberPlan.site];
    this.lastSiteKey = this.emberPlan.site;

    embers.forEach((f, i) => {
      const s = w.emberSpawn[i];
      this.resetFighter(f, s[0], s[1], 0);
      const post = w.emberPosts[i];
      this.bots.get(f)?.resetForRound({ x: post[0], z: post[1] }, null);
    });
    const wardenPosts = w.wardenPostsByPlan[this.wardenPlan.posts] || w.wardenPosts;
    wardens.forEach((f, i) => {
      const s = w.wardenSpawn[i];
      this.resetFighter(f, s[0], s[1], Math.PI);
      const post = wardenPosts[i];
      const bot = this.bots.get(f);
      if (bot) {
        // Face the door the post covers: A posts watch the A entry, B posts
        // the B entry, everyone else watches mid-north.
        const watch = post[0] < -14 ? { x: -24, z: -4 } : post[0] > 14 ? { x: 24, z: -5 } : { x: 0, z: -14 };
        const faceYaw = Math.atan2(-(watch.x - post[0]), -(watch.z - post[1]));
        bot.resetForRound({ x: post[0], z: post[1] }, {
          hold: { x: post[0], z: post[1] }, faceYaw, holdForRetake: this.wardenPlan.holdForRetake,
          executeAt: 0, fakeUntil: 0, fakeHold: null,
        });
        bot.role = i === 0 ? "siteA" : i === 1 ? "siteB" : i === 2 ? "mid" : "rotate";
      }
    });
    // Assign roles and the bomb among attackers.
    const carrier = embers[1 + (this.round % 3)]; // a bot carries, not the human
    carrier.hasBomb = true;
    this.bomb.carrier = carrier;
    embers.forEach((f, i) => {
      const bot = this.bots.get(f);
      if (!bot) return;
      bot.role = f.hasBomb ? "carrier" : i === 4 ? "lurk" : i % 2 ? "support" : "entry";
      // The bot's assignment: which lane it works, where it stages, and (on
      // a fake) where it shows itself before rotating.
      const lane = this.emberPlan.lanes[bot.role] || this.emberPlan.lanes.entry || this.emberPlan.site;
      const holdBase = lane === "mid" ? w.holds.mid : w.holds[lane];
      const fakeLane = this.emberPlan.fake;
      const onFake = fakeLane && (bot.role === "entry" || bot.role === "support");
      bot.assign = {
        lane,
        hold: { x: holdBase.x + (i % 3 - 1) * 2.2, z: holdBase.z + (i % 2) * 2 },
        fakeHold: onFake ? { x: w.holds[fakeLane].x + (i % 3 - 1) * 2.2, z: w.holds[fakeLane].z } : (f.hasBomb && fakeLane ? { x: w.holds.mid.x, z: w.holds.mid.z } : null),
        fakeSite: fakeLane ? w.sites[fakeLane] : null,
        executeAt: this.emberPlan.executeAt,
        fakeUntil: this.emberPlan.fakeUntil,
        holdForRetake: false,
      };
    });
    for (const f of this.fighters) if (!f.isPlayer || this.demo) this.botBuy(f);
    this.teamDrop("ember");
    this.teamDrop("warden");
    this.radio.push("ember", "Leader", RADIO.plan(this.emberPlan), this.now);
    this.radio.push("warden", "Leader", RADIO.plan(this.wardenPlan), this.now);
    if (!this.demo) {
      this.hud.showBuy(this.player, "ember", this.lossStreak.ember, (key) => this.playerBuy(key), true,
        { call: this.buyCalls.ember, team: embers });
    }
    this.hud.banner(`ROUND ${this.round}`, `${this.emberPlan.label} · Wardens: ${this.wardenPlan.label}`, 2200);
    this.syncMeshes();
  }

  // Team drop: after individual shopping, the richest fighter on a team who
  // already owns a primary buys one for the poorest teammate who has none.
  // Money is real — the donor pays the full price from the same table — and
  // the gift is announced on the radio, because that is what teams do.
  teamDrop(team) {
    const mates = this.fighters.filter((f) => f.team === team);
    const donor = mates.filter((f) => f.primaryId && f.money >= WEAPONS.vk.price + 900)
      .sort((a, b) => b.money - a.money)[0];
    const needy = mates.filter((f) => !f.primaryId).sort((a, b) => a.money - b.money)[0];
    if (!donor || !needy || donor === needy) return;
    donor.money -= WEAPONS.vk.price;
    needy.primaryId = "vk";
    needy.weapon = makeWeapon("vk");
    this.radio.push(team, donor.name, RADIO.drop(needy.name, "VK Rifle"), this.now);
    if (needy.isPlayer && !this.demo) this.hud.feed(`<b>${donor.name}</b> dropped a VK Rifle for you`);
  }

  resetFighter(f, x, z, yaw) {
    const keepPrimary = f.alive && f.primaryId;
    f.x = x; f.z = z; f.y = 0; f.vx = 0; f.vz = 0; f.vy = 0;
    f.yaw = yaw; f.pitch = 0; f.kickPitch = 0; f.kickYaw = 0;
    f.hp = 100; f.alive = true; f.crouch = false; f.zoomed = false; f.air = false;
    f.blindT = 0; f.hasBomb = false;
    f.grenades = { flash: 0, frag: 0, smoke: 0 };
    if (!keepPrimary) {
      f.primaryId = null;
      f.weapon = makeWeapon("sidearm");
      f.armor = 0; f.hasKit = false;
    } else {
      f.weapon = makeWeapon(f.primaryId);
    }
    if (f.mesh) f.mesh.visible = true;
  }

  // Bot shopping follows the team's buy call (tactics.js), not a private
  // shopping list: an eco means the money SURVIVES the round, a force caps
  // spending at SMG-plus-armor so a loss still funds rifles, and only a
  // full buy reaches for the VK — or, for one rich bot late in a match,
  // the Longshot. Utility is bought last and a retake five buys none of it
  // early: its grenades are the retake.
  botBuy(f) {
    const call = (this.buyCalls[f.team] || { id: "full" }).id;
    if (call === "pistol") return;   // the pistol round banks the $800 — that IS the call
    const spend = (price) => { if (f.money >= price) { f.money -= price; return true; } return false; };
    if (!f.primaryId) {
      if (call === "full") {
        if (f.money >= WEAPONS.longshot.price + 1500 && this.round >= 5 && Math.random() < 0.3 && spend(WEAPONS.longshot.price)) f.primaryId = "longshot";
        else if (spend(WEAPONS.vk.price)) f.primaryId = "vk";
        else if (spend(WEAPONS.wasp.price)) f.primaryId = "wasp";
      } else if (call === "force" || call === "half") {
        if (spend(WEAPONS.wasp.price)) f.primaryId = "wasp";
        else if (spend(WEAPONS.scatter.price)) f.primaryId = "scatter";
      } else if (call === "eco") {
        // Eco discipline: a Scattergun only for a bot rich enough that the
        // purchase cannot delay the team's next full buy.
        if (f.money >= 3200 && spend(WEAPONS.scatter.price)) f.primaryId = "scatter";
      }
      if (f.primaryId) f.weapon = makeWeapon(f.primaryId);
    }
    if (call !== "eco" && f.armor < 100 && spend(ARMOR_PRICE)) f.armor = 100;
    if (call === "eco" && f.money >= 2600 && f.armor < 100 && spend(ARMOR_PRICE)) f.armor = 100;
    if (f.team === "warden" && !f.hasKit && call !== "eco" && spend(KIT_PRICE)) f.hasKit = true;
    if (call === "pistol" || call === "eco") return;
    if (spend(GRENADES.flash.price)) f.grenades.flash++;
    if (Math.random() < 0.6 && spend(GRENADES.frag.price)) f.grenades.frag++;
    if (Math.random() < 0.5 && spend(GRENADES.smoke.price)) f.grenades.smoke++;
  }

  playerBuy(key) {
    const p = this.player;
    if (this.phase !== "buy") return;
    const [kind, id] = key.split(":");
    let ok = false;
    if (kind === "w") {
      const w = WEAPONS[id];
      if (p.money >= w.price && p.primaryId !== id) {
        p.money -= w.price; p.primaryId = id; p.weapon = makeWeapon(id); ok = true;
      }
    } else if (kind === "g") {
      if (p.money >= GRENADES[id].price) { p.money -= GRENADES[id].price; p.grenades[id]++; ok = true; }
    } else if (key === "armor") {
      if (p.money >= ARMOR_PRICE && p.armor < 100) { p.money -= ARMOR_PRICE; p.armor = 100; ok = true; }
    } else if (key === "kit") {
      if (p.money >= KIT_PRICE && !p.hasKit) { p.money -= KIT_PRICE; p.hasKit = true; ok = true; }
    }
    if (ok) this.sounds.buy(); else this.sounds.denied();
    this.hud.showBuy(p, "ember", this.lossStreak.ember, (k) => this.playerBuy(k), true,
      { call: this.buyCalls.ember, team: this.fighters.filter((f) => f.team === "ember") });
  }

  goLive() {
    this.phase = "live";
    this.phaseT = MATCH.liveSeconds / this.timeScale;
    this.liveT = 0;
    this.world.setBarrier(false);
    this.hud.hideBuy();
    this.hud.banner("ROUND LIVE", this.bomb.carrier ? `${this.bomb.carrier.name} has the charge` : "", 1500);
    if (this.emberPlan.executeAt <= 0) this.radio.push("ember", "Leader", RADIO.execute(this.emberPlan.site), this.now);
  }

  endRound(winner, reason, objective) {
    if (this.phase === "end" || this.matchOver) return;
    this.phase = "end";
    this.phaseT = MATCH.endSeconds / this.timeScale;
    this.score[winner]++;
    const loser = winner === "ember" ? "warden" : "ember";
    const winPay = objective ? ECONOMY.winObjective : ECONOMY.winReward;
    for (const f of this.fighters) {
      if (f.team === winner) f.money = Math.min(MATCH.maxMoney, f.money + winPay);
      else f.money = Math.min(MATCH.maxMoney, f.money + nextLossBonus(this.lossStreak[loser]));
    }
    this.lossStreak[winner] = 0;
    this.lossStreak[loser] = Math.min(4, this.lossStreak[loser] + 1);
    // Round MVP: the most damage dealt by a fighter on the winning team.
    // Damage is tracked per hit in applyHit, so this is a fact, not a vote.
    const mvp = this.fighters.filter((f) => f.team === winner)
      .sort((a, b) => b.dmgDealt - a.dmgDealt)[0];
    this.roundHistory.push({ winner, mvp: mvp ? mvp.name : "" });
    const mine = winner === "ember";
    this.hud.banner(mine ? "ROUND WON" : "ROUND LOST",
      `${reason}${mvp && mvp.dmgDealt > 0 ? ` · MVP ${mvp.name} (${Math.round(mvp.dmgDealt)} dmg)` : ""}`, 3000);
    if (!this.demo) (mine ? this.sounds.roundWin() : this.sounds.roundLose());
    if (this.score[winner] >= MATCH.roundTarget) {
      this.matchOver = true;
      this.winner = winner;
    }
  }

  // ---- combat ---------------------------------------------------------------
  startReload(f) {
    const w = f.weapon;
    if (!w || w.reloading > 0 || w.ammo >= w.def.mag || w.reserve <= 0) return;
    w.reloading = w.def.reloadMs / 1000;
    if (f.isPlayer) this.sounds.reload();
  }

  shoot(f, yaw, pitch, heat) {
    if (this.phase !== "live") return false;      // weapons silent until go-live
    if (!f.alive || f.blindT > 1.2) return false;
    const w = f.weapon;
    if (!w || w.reloading > 0) return false;
    if (w.ammo <= 0) { if (f.isPlayer) this.sounds.dryFire(); this.startReload(f); return false; }
    const now = this.now;
    if (now - w.lastShotAt > 0.4) w.shotIdx = 0;
    w.lastShotAt = now;
    w.ammo--;
    // fixed learnable recoil: pattern kick, only partly recovered (see update)
    const pat = w.def.pattern[Math.min(w.shotIdx, w.def.pattern.length - 1)];
    w.shotIdx++;
    f.kickPitch += pat[0];
    f.kickYaw += pat[1];
    const spread = currentSpread(w, f.moving, f.air, f.crouch, f.zoomed, heat || 0) + (f === this.player && this.control ? this.control.landingBloom : 0);
    const distToPlayer = Math.hypot(f.x - this.player.x, f.z - this.player.z);
    if (f !== this.player || !this.demo) this.sounds.shot(w.id, f === this.player ? 1 : Math.max(0.08, 1 - distToPlayer / 46));
    this.noise.emit(f.x, f.z, 32, "shot");
    const self = this;
    fireShots(this.world, f, this.fighters, yaw + f.kickYaw, pitch + f.kickPitch, spread, w.def.range, {
      pellets: w.def.pellets,
      onTrace: (o, h) => self.addTracer(o, h),
      onHit: (target, head, dist) => self.applyHit(f, target, head, dist),
    });
    return true;
  }

  applyHit(attacker, target, head, dist) {
    const w = attacker.weapon;
    let dmg = w.def.damage * (head ? w.def.headMult : 1);
    const over = Math.max(0, dist - w.def.range * 0.6) / (w.def.range * 0.4);
    dmg *= 1 - Math.min(0.5, over * 0.5);
    if (target.armor > 0) { const absorbed = dmg * 0.5; target.armor = Math.max(0, target.armor - absorbed); dmg -= absorbed; }
    const hpBefore = target.hp;
    target.hp -= dmg;
    attacker.dmgDealt += Math.max(0, hpBefore - Math.max(0, target.hp)); // real HP removed, never overkill
    target.lastHurtAt = this.now;
    target.lastHurtFrom = Math.atan2(-(attacker.x - target.x), -(attacker.z - target.z));
    const bot = this.bots.get(target);
    if (bot) bot.lastContactAt = this.now;
    if (attacker.isPlayer && !this.demo) {
      this.hud.showHitmark(head);
      head ? this.sounds.headshot() : this.sounds.hitmark();
    }
    if (target.isPlayer && !this.demo) {
      this.sounds.hurt();
      this.hud.hurtFlash();
      this.hud.damageFrom(((target.lastHurtFrom - target.yaw) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    }
    if (target.hp <= 0 && target.alive) this.kill(attacker, target, head);
  }

  kill(attacker, target, head) {
    target.alive = false;
    target.hp = 0;
    target.deaths++;
    // A frag death passes the victim as its own attacker: no kill credit,
    // no kill reward — only a genuine opponent kill pays out.
    if (attacker !== target) {
      attacker.kills++;
      const reward = KILL_REWARD[attacker.weapon ? attacker.weapon.id : "sidearm"] ?? ECONOMY.killReward;
      attacker.money = Math.min(MATCH.maxMoney, attacker.money + reward);
    }
    // The death becomes the round's trade record and a radio call: the
    // victim's team learns WHERE it happened (placeName via bots' call),
    // and the nearest teammate may claim the trade swing (bots.js).
    if (attacker !== target) {
      this.lastDeath = { victim: target, killer: attacker, x: target.x, z: target.z, at: this.now, team: target.team, claimedBy: null };
      this.radio.push(target.team, target.name, RADIO.manDown(placeName(target.x, target.z)), this.now);
    }
    // A dead fighter's primary drops where they fell: a teammate can fetch
    // it (bots detour for it; the player can walk over it).
    if (target.primaryId) {
      this.spawnDrop(target.primaryId, target.x, target.z);
      target.primaryId = null;
    }
    if (target.hasBomb) {
      target.hasBomb = false;
      this.bomb.state = "dropped";
      this.bomb.x = target.x; this.bomb.z = target.z;
      this.bomb.carrier = null;
    }
    if (target.mesh) target.mesh.visible = false;
    this.hud.feed(`<b style="color:${TEAMS[attacker.team].css}">${attacker.name}</b> ▸ ${head ? "⌖ " : ""}<b style="color:${TEAMS[target.team].css}">${target.name}</b>`);
    if (attacker.isPlayer && !this.demo) this.sounds.kill();   // the kill sound, wired
    if (target.isPlayer && !this.demo) this.sounds.roundLose();
  }

  throwGrenade(f, kind, tx, tz) {
    const dir = new THREE.Vector3(tx - f.x, 0.4, tz - f.z);
    const d = dir.length() || 1;
    dir.normalize();
    const from = new THREE.Vector3(f.x, f.eyeY, f.z);
    this.grenades.throwGrenade(kind, from, dir, Math.min(15, 6 + d * 0.7));
    if (kind === "smoke") this.sounds.smokeHiss();
  }

  // --- dropped weapons -----------------------------------------------------
  // A primary on the ground is a real object: a small gun-shaped prop that
  // any fighter of either team without a primary picks up by walking over
  // it. The player drops with G (main.js); the dead drop automatically.
  spawnDrop(weaponId, x, z) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.14, 0.85),
      new THREE.MeshStandardMaterial({ color: 0x2a2c31, roughness: 0.5, metalness: 0.5 })
    );
    mesh.position.set(x, 0.16, z);
    mesh.rotation.y = Math.random() * Math.PI;
    this.scene.add(mesh);
    this.drops.push({ id: weaponId, x, z, mesh });
  }

  dropWeapon(f) {
    if (!f.primaryId || !f.alive) return;
    this.spawnDrop(f.primaryId, f.x, f.z);
    f.primaryId = null;
    f.weapon = makeWeapon(f.sidearmId || "sidearm");
  }

  updateDrops() {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      for (const f of this.fighters) {
        if (!f.alive || f.primaryId) continue;
        if (Math.hypot(f.x - d.x, f.z - d.z) < 1.1) {
          f.primaryId = d.id;
          f.weapon = makeWeapon(d.id);
          this.scene.remove(d.mesh);
          this.drops.splice(i, 1);
          break;
        }
      }
    }
  }

  tryPlant(f, site) {
    if (this.phase !== "live" || this.bomb.state !== "carried" || !f.hasBomb) return;
    if (this.planting) return;
    this.planting = { fighter: f, site, t: 0 };
    if (f.isPlayer || f === this.bomb.carrier) this.sounds.plantStart();
  }

  tryDefuse(f) {
    if (this.bomb.state !== "planted" || this.defusing) return;
    this.defusing = { fighter: f, t: 0, need: f.hasKit ? MATCH.defuseSeconds : MATCH.defuseNoKitSeconds };
  }

  addTracer(o, h) {
    const i = this.tracerIdx;
    this.tracerIdx = (this.tracerIdx + 1) % this.tracerCount;
    const p = this.tracerPos, o6 = i * 6;
    p[o6] = o.x; p[o6 + 1] = o.y - 0.12; p[o6 + 2] = o.z;
    p[o6 + 3] = h.x; p[o6 + 4] = h.y; p[o6 + 5] = h.z;
    this.tracerLife[i] = 0.06;
    this.tracers.geometry.attributes.position.needsUpdate = true;
  }

  // ---- fixed-step simulation --------------------------------------------------
  update(dt) {
    this.now += dt;
    this.noise.time = this.now;   // the noise bus runs on match time (combat.js)
    const w = this.world;
    w.update(dt);
    this.phaseT -= dt;
    if (this.phase === "live") {
      const before = this.liveT;
      this.liveT += dt;
      // Timed radio calls: the execute call lands as the hit starts, and a
      // thirty-second warning commits a default that is still staging.
      if (this.emberPlan && before < this.emberPlan.executeAt && this.liveT >= this.emberPlan.executeAt && this.emberPlan.executeAt > 0) {
        this.radio.push("ember", "Leader", RADIO.execute(this.emberPlan.site), this.now);
      }
      if (before < MATCH.liveSeconds - 30 && this.liveT >= MATCH.liveSeconds - 30 && this.bomb.state !== "planted") {
        this.radio.push("ember", "Leader", RADIO.lowTime(), this.now);
      }
    }

    // reloads + recoil recovery (partial: kicks decay, never fully vanish
    // inside a burst — that is what makes the pattern learnable)
    for (const f of this.fighters) {
      if (f.weapon && f.weapon.reloading > 0) {
        f.weapon.reloading -= dt;
        if (f.weapon.reloading <= 0) {
          const wdef = f.weapon;
          const take = Math.min(wdef.def.mag - wdef.ammo, wdef.reserve);
          wdef.ammo += take; wdef.reserve -= take;
        }
      }
      const rec = Math.exp(-dt * 3.2);
      f.kickPitch *= rec; f.kickYaw *= rec;
      f.blindT = Math.max(0, f.blindT - dt);
      f.eyeY = f.y + (f.crouch ? 1.12 : EYE);
    }

    if (this.phase === "buy") {
      for (const bot of this.bots.values()) bot.update(dt, this.now, this.env);
      if (this.control) { this.controlEnv.phase = "buy"; this.control.update(dt, this.controlEnv); }
      if (this.phaseT <= 0) this.goLive();
    } else if (this.phase === "live") {
      for (const bot of this.bots.values()) bot.update(dt, this.now, this.env);
      if (this.demo) { /* camera fighter already in bots map? no — drive below */ }
      if (this.control) { this.controlEnv.phase = "live"; this.control.update(dt, this.controlEnv); }
      this.updateBomb(dt);
      this.updateGrenades(dt);
      this.checkRoundEnd();
      if (this.phase === "live" && this.phaseT <= 0 && this.bomb.state !== "planted") {
        this.endRound("warden", "Time expired — the Wardens held the foundry", false);
      }
    } else if (this.phase === "end") {
      if (this.phaseT <= 0) {
        if (this.matchOver) { this.phase = "over"; this.hud.banner(
          this.winner === "ember" ? "EMBER TAKES THE MATCH" : "WARDENS TAKE THE MATCH",
          `Final score ${this.score.ember} — ${this.score.warden} · refresh to play again`, 60000); }
        else this.startRound();
      }
    }

    this.updateDrops();

    // bomb prop follows carrier / drop / plant site; lamp blinks faster late
    const b = this.bomb;
    if (b.state === "carried" && b.carrier) { this.bombMesh.position.set(b.carrier.x, 1.05, b.carrier.z); this.bombMesh.visible = b.carrier.alive; }
    else if (b.state === "dropped") { this.bombMesh.position.set(b.x, 0.14, b.z); this.bombMesh.visible = true; }
    else if (b.state === "planted") {
      this.bombMesh.position.set(b.x, 0.14, b.z); this.bombMesh.visible = true;
      const urgent = b.timer <= 10;
      this.bombLamp.material.color.setHex(Math.sin(this.now * (urgent ? 18 : 6)) > 0 ? 0xff2222 : 0x551111);
      if (!this.demo) this.sounds.bombBeep(b.timer, performance.now());
      this.hud.bombStatus(`CHARGE PLANTED — SITE ${b.site.key} · ${b.timer.toFixed(1)}s${urgent ? " · DETONATION IMMINENT" : ""}`, urgent);
    } else this.hud.bombStatus("", false);

    // tracers fade
    let anyTracer = false;
    for (let i = 0; i < this.tracerCount; i++) {
      if (this.tracerLife[i] > 0) { this.tracerLife[i] -= dt; if (this.tracerLife[i] <= 0) { this.tracerPos.fill(0, i * 6, i * 6 + 6); } anyTracer = true; }
    }
    if (anyTracer) this.tracers.geometry.attributes.position.needsUpdate = true;
    this.syncMeshes();
  }

  updateBomb(dt) {
    const b = this.bomb;
    // dropped charge: an attacker walking over it picks it up
    if (b.state === "dropped") {
      for (const f of this.fighters) {
        if (f.alive && f.team === "ember" && Math.hypot(f.x - b.x, f.z - b.z) < 1.1) {
          f.hasBomb = true; b.state = "carried"; b.carrier = f;
          const bot = this.bots.get(f); if (bot) bot.role = "carrier";
          break;
        }
      }
    }
    if (this.planting) {
      const p = this.planting;
      const inSite = Math.hypot(p.fighter.x - p.site.x, p.fighter.z - p.site.z) < p.site.r;
      if (!p.fighter.alive || !inSite) this.planting = null;
      else {
        p.t += dt;
        if (p.t >= MATCH.plantSeconds / this.timeScale) {
          p.fighter.hasBomb = false;
          b.state = "planted"; b.x = p.fighter.x; b.z = p.fighter.z; b.site = p.site;
          b.timer = MATCH.bombSeconds / this.timeScale;
          b.carrier = null;
          // Planter bonuses are paid NOW, at the plant — so a round later won
          // by post-plant elimination still pays them in full.
          for (const f of this.fighters) if (f.team === "ember") f.money = Math.min(MATCH.maxMoney, f.money + ECONOMY.plantTeamBonus);
          p.fighter.money = Math.min(MATCH.maxMoney, p.fighter.money + ECONOMY.planterBonus);
          this.planting = null;
          this.sounds.planted();
          this.radio.push("warden", "Leader", RADIO.planted(b.site.key), this.now);
          this.hud.banner("CHARGE PLANTED", `Site ${b.site.key} · ${MATCH.bombSeconds} seconds to detonation`, 2000);
        }
      }
    }
    if (b.state === "planted") {
      b.timer -= dt;
      if (this.defusing) {
        const d = this.defusing;
        if (!d.fighter.alive || Math.hypot(d.fighter.x - b.x, d.fighter.z - b.z) > 1.8) this.defusing = null;
        else {
          if (d.t === 0) this.radio.push("warden", d.fighter.name, RADIO.defusing(), this.now);
          d.t += dt;
          if ((d.t * 4 | 0) !== ((d.t - dt) * 4 | 0)) this.sounds.defuseTick();
          if (d.t >= d.need / this.timeScale) {
            b.state = "defused";
            d.fighter.money = Math.min(MATCH.maxMoney, d.fighter.money + ECONOMY.defuserBonus);
            this.defusing = null;
            this.endRound("warden", `Charge defused on site ${b.site.key}`, true);
            return;
          }
        }
      }
      if (b.timer <= 0) {
        b.state = "exploded";
        this.sounds.explosion();
        // The detonation is not a cutscene: anyone caught near the site —
        // a late retake, a planter who never left — takes falloff damage.
        for (const f of this.fighters) {
          if (!f.alive) continue;
          const dist = Math.hypot(f.x - b.x, f.z - b.z);
          if (dist < 10) {
            f.hp -= 160 * (1 - dist / 10);
            if (f.hp <= 0) this.kill(f, f, false);
          }
        }
        this.endRound("ember", `Site ${b.site.key} detonated`, true);
      }
    }
  }

  updateGrenades(dt) {
    const events = this.grenades.update(dt, this.world, this.grenadeEvents);
    for (const ev of events) {
      if (ev.kind === "frag") {
        this.sounds.fragPop();
        this.noise.emit(ev.x, ev.z, 20, "frag");
        for (const f of this.fighters) {
          if (!f.alive) continue;
          const d = Math.hypot(f.x - ev.x, f.z - ev.z);
          if (d < 5.5) {
            const dmg = 85 * (1 - d / 5.5);
            f.hp -= dmg;
            if (f.hp <= 0) this.kill(f, f, false); // frag deaths credit no one here
          }
        }
      } else if (ev.kind === "flash") {
        this.sounds.flashPop();
        for (const f of this.fighters) {
          if (!f.alive) continue;
          const dx = ev.x - f.x, dz = ev.z - f.z;
          const d = Math.hypot(dx, dz);
          if (d > 19) continue;
          const facing = Math.cos(Math.atan2(-dx, -dz) - f.yaw);
          if (facing > 0.25) {
            f.blindT = Math.max(f.blindT, (1 - d / 19) * 2.6 * facing);
            if (f.isPlayer && !this.demo) {
              this.hud.el.flash.style.opacity = String(Math.min(0.95, f.blindT * 0.5));
              setTimeout(() => { this.hud.el.flash.style.opacity = "0"; }, 500 + f.blindT * 600);
            }
          }
        }
      } else if (ev.kind === "smoke") {
        this.noise.emit(ev.x, ev.z, 8, "smoke");
      }
    }
  }

  checkRoundEnd() {
    const emberAlive = this.fighters.some((f) => f.team === "ember" && f.alive);
    const wardenAlive = this.fighters.some((f) => f.team === "warden" && f.alive);
    if (!wardenAlive) { this.endRound("ember", "Wardens eliminated", false); return; }
    if (!emberAlive) {
      // With the charge planted the round runs on: Wardens must still defuse.
      if (this.bomb.state === "planted") return;
      this.endRound("warden", "Ember eliminated", false);
    }
  }

  syncMeshes() {
    for (const f of this.fighters) {
      if (!f.mesh) continue;
      f.mesh.position.set(f.x, f.y, f.z);
      f.mesh.rotation.y = -f.yaw + Math.PI;
      f.mesh.scale.y = f.crouch ? 0.78 : 1;
    }
  }

  hudState() {
    const alive = { ember: 0, warden: 0 };
    for (const f of this.fighters) if (f.alive) alive[f.team]++;
    // Plant/defuse progress for the HUD bar: shown when the actor is the
    // player or a teammate — the enemy's progress is their secret.
    let progress = null;
    if (this.planting && this.planting.fighter.team === this.player.team) {
      progress = { label: `PLANTING — SITE ${this.planting.site.key}`, frac: this.planting.t / (MATCH.plantSeconds / this.timeScale) };
    } else if (this.defusing && this.defusing.fighter.team === this.player.team) {
      progress = { label: "DEFUSING", frac: this.defusing.t / (this.defusing.need / this.timeScale) };
    } else if (this.planting && this.planting.fighter.isPlayer) {
      progress = { label: `PLANTING — SITE ${this.planting.site.key}`, frac: this.planting.t / (MATCH.plantSeconds / this.timeScale) };
    }
    return {
      player: this.player,
      phaseT: this.bomb.state === "planted" ? this.bomb.timer : this.phaseT * this.timeScale,
      phase: this.phase,
      phaseLabel: this.phase === "buy" ? "BUY PHASE — B to shop, weapons silent" :
        this.phase === "live" ? (this.bomb.state === "planted" ? "CHARGE PLANTED" : `ROUND ${this.round} · LIVE`) :
        this.phase === "end" ? "ROUND OVER" : this.phase === "over" ? "MATCH OVER" : "",
      score: this.score,
      alive,
      total: { ember: MATCH.teamSize, warden: MATCH.teamSize },
      radio: this.radio.latest(4).filter((c) => c.team === this.player.team),
      roundHistory: this.roundHistory,
      progress,
      planLabel: this.emberPlan ? this.emberPlan.label : "",
      map: this.world,
      fighters: this.fighters,
      bomb: this.bomb,
      intel: this.radio.intelFor(this.player.team, this.now, 3.2),
    };
  }
}
