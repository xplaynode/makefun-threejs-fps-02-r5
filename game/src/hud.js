// hud.js — all DOM feedback: health/ammo/timer/score, a dynamic crosshair
// driven by the shooter's REAL current spread, a damage-direction wedge,
// alive-count pips for both teams, a bomb status line, the killfeed, the
// team radio log, a live minimap, plant/defuse progress, round-history
// dots, and the buy menu (which prints the exact next loss bonus from
// config.js and the team's buy call from tactics.js).

import { WEAPONS, GRENADES, ARMOR_PRICE, KIT_PRICE, nextLossBonus, ECONOMY } from "./config.js";

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      hp: $("hp"), money: $("money"), ammo: $("ammo"), weapon: $("weaponName"),
      timer: $("timer"), score: $("score"), phase: $("phaseLine"),
      pipsE: $("pipsEmber"), pipsW: $("pipsWarden"),
      cross: $("crosshair"), hitmark: $("hitmarker"), dmgDir: $("dmgDir"),
      bombLine: $("bombLine"), feed: $("feed"), banner: $("banner"),
      buy: $("buyMenu"), buyItems: $("buyItems"), buyHead: $("buyHead"),
      scope: $("scopeOverlay"), flash: $("flashOverlay"), vignette: $("hurtVignette"),
      prompt: $("prompt"), matchEnd: $("matchEnd"),
      radio: $("radioLog"), dots: $("roundDots"),
      progress: $("progressWrap"), progressBar: $("progressBar"), progressLabel: $("progressLabel"),
      minimap: $("minimap"),
    };
    this.mapCtx = this.el.minimap ? this.el.minimap.getContext("2d") : null;
    this.hitT = 0;
    this.feedTimers = [];
    this.radioKey = "";
    this.dotsKey = "";
  }

  setCrosshairSpread(px) {
    const c = this.el.cross;
    const g = Math.max(3, Math.min(46, px));
    c.style.setProperty("--gap", g + "px");
  }

  showHitmark(head) {
    this.el.hitmark.style.opacity = "1";
    this.el.hitmark.style.color = head ? "#ffb02e" : "#ffffff";
    this.hitT = performance.now();
  }

  // Wedge rotated toward the direction damage came from, relative to view.
  damageFrom(angleDiff) {
    const d = this.el.dmgDir;
    d.style.opacity = "1";
    d.style.transform = `translate(-50%,-50%) rotate(${angleDiff}rad)`;
    clearTimeout(this.dmgTimer);
    this.dmgTimer = setTimeout(() => { d.style.opacity = "0"; }, 700);
  }

  hurtFlash() {
    this.el.vignette.style.opacity = "0.55";
    setTimeout(() => { this.el.vignette.style.opacity = "0"; }, 180);
  }

  feed(html) {
    const row = document.createElement("div");
    row.className = "feedRow";
    row.innerHTML = html;
    this.el.feed.prepend(row);
    while (this.el.feed.children.length > 6) this.el.feed.lastChild.remove();
    setTimeout(() => row.remove(), 4200);
  }

  banner(text, sub, ms = 2600) {
    this.el.banner.innerHTML = `<div class="bannerMain">${text}</div><div class="bannerSub">${sub || ""}</div>`;
    this.el.banner.style.opacity = "1";
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { this.el.banner.style.opacity = "0"; }, ms);
  }

  pips(team, alive, total) {
    const host = team === "ember" ? this.el.pipsE : this.el.pipsW;
    let html = "";
    for (let i = 0; i < total; i++) html += `<span class="pip ${team}${i < alive ? "" : " dead"}"></span>`;
    if (host.dataset.n !== String(alive)) { host.innerHTML = html; host.dataset.n = String(alive); }
  }

  bombStatus(text, urgent) {
    this.el.bombLine.textContent = text;
    this.el.bombLine.className = urgent ? "urgent" : "";
    this.el.bombLine.style.display = text ? "block" : "none";
  }

  // The radio log: the player's team's last calls, newest at the bottom,
  // rebuilt only when a new call actually arrives (the seq key changes).
  radioLog(calls) {
    if (!this.el.radio) return;
    const key = calls.length ? String(calls[calls.length - 1].seq) + ":" + calls.length : "none";
    if (key === this.radioKey) return;
    this.radioKey = key;
    this.el.radio.innerHTML = calls.map((c) =>
      `<div class="radioRow"><b>${c.speaker}</b> ${c.text}</div>`).join("");
  }

  // Round-history dots under the score: one dot per finished round, in the
  // winner's colour, so the match's shape reads at a glance.
  roundDots(history) {
    if (!this.el.dots) return;
    const key = String(history.length);
    if (key === this.dotsKey) return;
    this.dotsKey = key;
    this.el.dots.innerHTML = history.map((r) =>
      `<span class="dot ${r.winner}"></span>`).join("");
  }

  progressBar(state) {
    if (!this.el.progress) return;
    const pr = state.progress;
    if (!pr) { this.el.progress.style.display = "none"; return; }
    this.el.progress.style.display = "block";
    this.el.progressLabel.textContent = pr.label;
    this.el.progressBar.style.width = Math.round(Math.min(1, pr.frac) * 100) + "%";
  }

  // The minimap: the world's own collider list drawn top-down (so the map
  // on the HUD can never disagree with the map in the simulation), the two
  // site pads, every living teammate, the player as a white ring, the last
  // radioed enemy intel as a fading red diamond, and the charge — carried
  // (on its carrier), dropped (blinking) or planted (pulsing on its site).
  minimap(state) {
    const ctx = this.mapCtx;
    if (!ctx || !state.map) return;
    const W = 152, H = 112;
    const sx = (x) => ((x + 38) / 76) * W;
    const sz = (z) => ((z + 28) / 56) * H;
    ctx.fillStyle = "rgba(12,12,14,.72)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.20)";
    for (const b of state.map.colliders) {
      if (b.off) continue;
      ctx.fillRect(sx(b.x0), sz(b.z0), Math.max(1.5, sx(b.x1) - sx(b.x0)), Math.max(1.5, sz(b.z1) - sz(b.z0)));
    }
    for (const key of ["A", "B"]) {
      const s = state.map.sites[key];
      ctx.fillStyle = key === "A" ? "rgba(255,140,74,.5)" : "rgba(87,182,255,.5)";
      ctx.beginPath(); ctx.arc(sx(s.x), sz(s.z), s.r * 2, 0, 7); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "bold 9px Arial";
      ctx.fillText(key, sx(s.x) - 3, sz(s.z) + 3);
    }
    const me = state.player;
    for (const f of state.fighters) {
      if (!f.alive || f.team !== me.team) continue;
      ctx.fillStyle = f === me ? "#ffffff" : "#ffb37a";
      ctx.beginPath(); ctx.arc(sx(f.x), sz(f.z), f === me ? 3 : 2.2, 0, 7); ctx.fill();
    }
    if (state.intel) {
      ctx.fillStyle = "rgba(255,60,40,.9)";
      const ix = sx(state.intel.x), iz = sz(state.intel.z);
      ctx.beginPath(); ctx.moveTo(ix, iz - 3.4); ctx.lineTo(ix + 3.4, iz); ctx.lineTo(ix, iz + 3.4); ctx.lineTo(ix - 3.4, iz); ctx.fill();
    }
    const b = state.bomb;
    if (b && b.state !== "carried") {
      ctx.fillStyle = "#ffd76a";
      ctx.fillRect(sx(b.x) - 2.5, sz(b.z) - 2.5, 5, 5);
    } else if (b && b.carrier) {
      ctx.fillStyle = "#ffd76a";
      ctx.fillRect(sx(b.carrier.x) - 2, sz(b.carrier.z) - 2, 4, 4);
    }
  }

  frame(state) {
    if (performance.now() - this.hitT > 90) this.el.hitmark.style.opacity = "0";
    const p = state.player;
    this.radioLog(state.radio || []);
    this.roundDots(state.roundHistory || []);
    this.progressBar(state);
    this.minimap(state);
    this.el.hp.textContent = Math.max(0, Math.ceil(p.hp));
    this.el.hp.style.color = p.hp <= 25 ? "#ff5a4a" : "#fff";
    this.el.money.textContent = "$" + p.money;
    const w = p.weapon;
    this.el.weapon.textContent = w ? w.def.label : "—";
    this.el.ammo.textContent = w ? (w.reloading ? "···" : `${w.ammo} / ${w.reserve}`) : "";
    const t = Math.max(0, state.phaseT);
    const mm = (t / 60) | 0, ss = (t % 60) | 0;
    this.el.timer.textContent = `${mm}:${ss.toString().padStart(2, "0")}`;
    this.el.timer.style.color = state.phase === "live" && t <= 10 ? "#ff5a4a" : "#fff";
    this.el.score.textContent = `${state.score.ember} — ${state.score.warden}`;
    this.el.phase.textContent = state.phaseLabel;
    this.pips("ember", state.alive.ember, state.total.ember);
    this.pips("warden", state.alive.warden, state.total.warden);
  }

  showBuy(player, team, lossStreak, onBuy, canBuy, opts = {}) {
    const b = this.el.buy;
    b.style.display = "block";
    const bonus = nextLossBonus(lossStreak);
    // The header carries the team's buy call (tactics.js) and every
    // teammate's money and primary, so a buy decision is made on the whole
    // team's economy — including who can drop for whom — not on one wallet.
    const callLine = opts.call
      ? `<br>TEAM CALL: <b>${opts.call.label}</b> — ${opts.call.why}` : "";
    const teamLine = opts.team
      ? `<br>` + opts.team.map((f) =>
          `${f.name} $${f.money}${f.primaryId ? " ▸" + (WEAPONS[f.primaryId] ? WEAPONS[f.primaryId].label.split(" ")[0] : "") : ""}`).join(" &nbsp;·&nbsp; ")
      : "";
    this.el.buyHead.innerHTML =
      `BUY — ${team === "ember" ? "EMBER" : "WARDEN"} &nbsp;·&nbsp; $${player.money}` +
      ` &nbsp;·&nbsp; if you lose this round: +$${bonus} (loss bonus, streak ${lossStreak})` +
      ` &nbsp;·&nbsp; win pays $${ECONOMY.winReward}` + callLine + teamLine;
    const items = [];
    let n = 1;
    const add = (label, price, key, owned) => {
      items.push(`<button class="buyItem" data-key="${key}" ${owned || player.money < price || !canBuy ? "disabled" : ""}>` +
        `<span class="buyKey">${n++}</span> ${label}<span class="buyPrice">$${price}</span>${owned ? '<span class="owned">OWNED</span>' : ""}</button>`);
    };
    for (const [id, w] of Object.entries(WEAPONS)) if (w.slot === "primary") add(w.label, w.price, "w:" + id, player.primaryId === id);
    for (const [id, w] of Object.entries(WEAPONS)) if (w.slot === "sidearm" && w.price > 0) add(w.label, w.price, "w:" + id, false);
    for (const [id, g] of Object.entries(GRENADES)) add(`${g.label} (${player.grenades[id] || 0})`, g.price, "g:" + id, false);
    add("Kevlar Vest", ARMOR_PRICE, "armor", player.armor >= 100);
    if (team === "warden") add("Defuse Kit", KIT_PRICE, "kit", player.hasKit);
    this.el.buyItems.innerHTML = items.join("");
    this.el.buyItems.querySelectorAll(".buyItem").forEach((btn) => {
      btn.addEventListener("click", () => onBuy(btn.dataset.key));
    });
    this.buyKeys = [...this.el.buyItems.querySelectorAll(".buyItem")].map((x) => x.dataset.key);
  }

  hideBuy() { this.el.buy.style.display = "none"; }

  prompt(text) {
    this.el.prompt.textContent = text || "";
    this.el.prompt.style.display = text ? "block" : "none";
  }
}
