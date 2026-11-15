// config.js — SLAGLINE's single source of truth.
// Weapon prices, stats and recoil patterns live ONLY here: the buy menu, the
// bots' shopping and the firing code all read this table, so a price can
// never disagree between the shop and the simulation. Economy numbers live
// here too, for the same reason.

export const TEAMS = {
  ember: { name: "Ember", color: 0xff7a33, css: "#ff8c4a" },   // attackers, plant the charge
  warden: { name: "Warden", color: 0x3fa7ff, css: "#57b6ff" }, // defenders, hold the sites
};

export const MATCH = {
  roundTarget: 9,        // first team to 9 rounds takes the match
  teamSize: 5,
  buySeconds: 12,
  liveSeconds: 100,
  plantSeconds: 3.2,
  bombSeconds: 40,
  defuseSeconds: 5,      // with a kit; 10 without (see DEFUSE_NO_KIT)
  defuseNoKitSeconds: 10,
  endSeconds: 5,
  startMoney: 800,
  maxMoney: 16000,
};

export const ECONOMY = {
  winReward: 3250,
  winElimination: 3250,
  winObjective: 3500,    // detonation or defusal pays a little more
  lossBase: 1400,        // first loss in a streak
  lossStep: 500,         // each further consecutive loss adds this
  lossCap: 3400,
  killReward: 300,
  plantTeamBonus: 800,   // whole attacking team when the charge goes down
  planterBonus: 300,     // the planter personally — paid even if the round is
                         // then won by post-plant elimination (see game.js)
  defuserBonus: 300,
};

// Kill rewards differ by weapon class, as they do in the games SLAGLINE
// takes its shape from: close-range and SMG kills pay double a rifle kill,
// because the killer took the risk of getting close; a Longshot kill pays
// least, because the rifle itself was the investment. game.js pays from
// this table and from no other.
export const KILL_REWARD = { sidearm: 300, wasp: 600, scatter: 600, vk: 300, longshot: 100 };

// The exact loss bonus a team receives if it loses the NEXT round, given its
// current consecutive-loss streak. The buy menu prints this number, and the
// payout code calls this same function — one definition, two readers.
export function nextLossBonus(lossStreak) {
  return Math.min(ECONOMY.lossCap, ECONOMY.lossBase + ECONOMY.lossStep * lossStreak);
}

// Recoil patterns are fixed and learnable: pattern[i] is the [pitch, yaw]
// kick (radians) of shot i in a burst. The view climbs by the kick and then
// recovers only part of the way (see combat.js VIEW_RECOVERY), so a practiced
// player pulls down against a pattern they can memorise.
export const WEAPONS = {
  sidearm: {
    label: "P9 Sidearm", slot: "sidearm", price: 0, damage: 34, headMult: 3.4,
    rpm: 360, mag: 12, reserve: 96, reloadMs: 1100, range: 60,
    spreadStill: 0.006, spreadMove: 0.02, spreadAir: 0.05, pellets: 1,
    auto: false, zoom: 0, moveCapScoped: 1,
    pattern: [[0.010, 0], [0.011, 0.001], [0.010, -0.001], [0.011, 0.001], [0.010, 0], [0.011, -0.001]],
  },
  wasp: {
    label: "Wasp SMG", slot: "primary", price: 1500, damage: 26, headMult: 3.0,
    rpm: 800, mag: 30, reserve: 120, reloadMs: 1500, range: 55,
    spreadStill: 0.011, spreadMove: 0.026, spreadAir: 0.055, pellets: 1,
    auto: true, zoom: 0, moveCapScoped: 1,
    pattern: [[0.008, 0.001], [0.008, -0.002], [0.009, 0.002], [0.008, -0.001], [0.009, 0.003], [0.008, -0.003], [0.009, 0.001], [0.008, 0]],
  },
  scatter: {
    label: "Scattergun", slot: "primary", price: 900, damage: 13, headMult: 2.2,
    rpm: 68, mag: 6, reserve: 30, reloadMs: 2400, range: 26,
    spreadStill: 0.035, spreadMove: 0.05, spreadAir: 0.08, pellets: 8,
    auto: false, zoom: 0, moveCapScoped: 1,
    pattern: [[0.045, 0], [0.047, 0.002], [0.045, -0.002], [0.047, 0.001], [0.045, 0], [0.047, -0.001]],
  },
  vk: {
    label: "VK Rifle", slot: "primary", price: 2700, damage: 40, headMult: 4.0,
    rpm: 600, mag: 30, reserve: 90, reloadMs: 1900, range: 90,
    spreadStill: 0.004, spreadMove: 0.022, spreadAir: 0.06, pellets: 1,
    auto: true, zoom: 0, moveCapScoped: 1,
    pattern: [[0.014, 0], [0.015, 0.001], [0.016, -0.002], [0.015, 0.003], [0.016, -0.003], [0.015, 0.002], [0.016, -0.001], [0.015, 0.004], [0.016, -0.004], [0.015, 0]],
  },
  longshot: {
    label: "Longshot", slot: "primary", price: 4750, damage: 110, headMult: 2.6,
    rpm: 42, mag: 5, reserve: 25, reloadMs: 2800, range: 160,
    spreadStill: 0.0012, spreadMove: 0.03, spreadAir: 0.09, pellets: 1,
    auto: false, zoom: 4, moveCapScoped: 0.38, // scoped movement is capped hard
    hipSpreadMult: 14,                        // hip-fired sniper: heavily penalised
    pattern: [[0.085, 0], [0.088, 0.002], [0.085, -0.002], [0.088, 0.001], [0.085, 0]],
  },
};

export const GRENADES = {
  flash: { label: "Flash Charge", price: 200, key: "flash" },
  frag: { label: "Frag Charge", price: 300, key: "frag" },
  smoke: { label: "Smoke Charge", price: 300, key: "smoke" },
};

export const ARMOR_PRICE = 650;
export const KIT_PRICE = 400;

export const BOT_NAMES = {
  ember: ["Cinder", "Slag", "Forge", "Anvil", "Ember-9"],
  warden: ["Bastion", "Rampart", "Aegis", "Bulwark", "Parapet"],
};
