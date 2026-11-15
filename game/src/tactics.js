// tactics.js — SLAGLINE's team brain: round plans, buy calls and the words
// the radio speaks. Pure data and pure functions only — no DOM, no three.js,
// no match state. game.js asks for a plan at round start, bots.js executes
// the assignments it is handed, hud.js prints the buy call. Because nothing
// here reaches outside itself, the whole file can be read top to bottom and
// checked against the economy table in config.js.

import { nextLossBonus } from "./config.js";

// --- Callouts ---------------------------------------------------------------
// The foundry divided into the names players actually shout. A contact call
// is only useful if the place it names is the place the contact happened.
export function placeName(x, z) {
  if (z > 16) return "the yard";
  if (x < -16 && z < -8) return "site A";
  if (x > 16 && z < -8) return "site B";
  if (x < -13) return "A lane";
  if (x > 13) return "B lane";
  if (z < -12) return "the furnace";
  if (z > 8) return "south mid";
  return "mid";
}

// --- Buy calls ---------------------------------------------------------------
// One call per team per round, derived from the SAME numbers the payout code
// uses: average money now, and the exact loss bonus a defeat would pay.
// A "force" is only called when losing still funds rifles next round —
// that arithmetic is the whole point of printing nextLossBonus here.
export function buyCall(avgMoney, lossStreak, round) {
  if (round <= 1) return { id: "pistol", label: "PISTOL ROUND", why: "sidearms only, bank the $800" };
  const bonus = nextLossBonus(lossStreak);
  if (avgMoney >= 3950) return { id: "full", label: "FULL BUY", why: "rifles, armor and utility for everyone" };
  if (avgMoney >= 2150 && avgMoney + bonus >= 3950) {
    return { id: "force", label: "FORCE BUY", why: `a loss still pays +$${bonus} — rifles again next round` };
  }
  if (avgMoney >= 2450) return { id: "half", label: "HALF BUY", why: "SMGs and armor, save the rest for rifles" };
  return { id: "eco", label: "ECO", why: `bank it — a loss pays +$${bonus} toward a full buy` };
}

// --- Ember (attack) plans ------------------------------------------------------
// lanes maps a bot role to the lane it works. site is where the charge is
// finally planted; fake names a lane the team SHOWS at first — noise, one
// flash, bodies at the lane mouth — before rotating to the real site at
// fakeUntil. executeAt is when a default setup converts into the site hit:
// before it, entry bots stage at the lane approach and only take picks.
export const EMBER_PLANS = {
  defaultA: { id: "defaultA", site: "A", fake: null, fakeUntil: 0, executeAt: 17,
    label: "Default — hit A", call: "Default. Work picks, we hit A on my call.",
    lanes: { carrier: "A", entry: "A", support: "A", lurk: "mid", flex: "B" } },
  defaultB: { id: "defaultB", site: "B", fake: null, fakeUntil: 0, executeAt: 17,
    label: "Default — hit B", call: "Default. Work picks, we hit B on my call.",
    lanes: { carrier: "B", entry: "B", support: "B", lurk: "mid", flex: "A" } },
  rushA: { id: "rushA", site: "A", fake: null, fakeUntil: 0, executeAt: 0,
    label: "Rush A", call: "Rush A — no stopping, trade every kill.",
    lanes: { carrier: "A", entry: "A", support: "A", lurk: "A", flex: "A" } },
  rushB: { id: "rushB", site: "B", fake: null, fakeUntil: 0, executeAt: 0,
    label: "Rush B", call: "Rush B — no stopping, trade every kill.",
    lanes: { carrier: "B", entry: "B", support: "B", lurk: "B", flex: "B" } },
  splitA: { id: "splitA", site: "A", fake: null, fakeUntil: 0, executeAt: 13,
    label: "Split A through mid", call: "Split A — two through mid, three down the lane.",
    lanes: { carrier: "A", entry: "mid", support: "mid", lurk: "A", flex: "A" } },
  splitB: { id: "splitB", site: "B", fake: null, fakeUntil: 0, executeAt: 13,
    label: "Split B through mid", call: "Split B — two through mid, three down the lane.",
    lanes: { carrier: "B", entry: "mid", support: "mid", lurk: "B", flex: "B" } },
  fakeA: { id: "fakeA", site: "B", fake: "A", fakeUntil: 15, executeAt: 15,
    label: "Fake A, finish B", call: "Sell the fake on A — noise, one flash — then we finish B.",
    lanes: { carrier: "B", entry: "A", support: "A", lurk: "mid", flex: "B" } },
  fakeB: { id: "fakeB", site: "A", fake: "B", fakeUntil: 15, executeAt: 15,
    label: "Fake B, finish A", call: "Sell the fake on B — noise, one flash — then we finish A.",
    lanes: { carrier: "A", entry: "B", support: "B", lurk: "mid", flex: "A" } },
  ecoStackA: { id: "ecoStackA", site: "A", fake: null, fakeUntil: 0, executeAt: 5,
    label: "Eco stack — A", call: "Eco stack A. Close range only, swing together.",
    lanes: { carrier: "A", entry: "A", support: "A", lurk: "A", flex: "A" } },
  ecoStackB: { id: "ecoStackB", site: "B", fake: null, fakeUntil: 0, executeAt: 5,
    label: "Eco stack — B", call: "Eco stack B. Close range only, swing together.",
    lanes: { carrier: "B", entry: "B", support: "B", lurk: "B", flex: "B" } },
};

// --- Warden (defence) plans ----------------------------------------------------
// posts are chosen by game.js from world.js post sets; the plan only decides
// WHICH set and how the holders behave: a retake five gives the sites up,
// keeps its utility and its numbers, and hits together once the charge is
// down; an aggro-mid pair fights for mid control in the first seconds.
export const WARDEN_PLANS = {
  standard: { id: "standard", posts: "standard", holdForRetake: false,
    label: "Standard 2-1-2", call: "Standard hold — two, one, two. Call contacts, don't peek alone." },
  stackA: { id: "stackA", posts: "stackA", holdForRetake: false,
    label: "Stack A", call: "Stack A — three on the site, play crossfire." },
  stackB: { id: "stackB", posts: "stackB", holdForRetake: false,
    label: "Stack B", call: "Stack B — three on the site, play crossfire." },
  retake: { id: "retake", posts: "retake", holdForRetake: true,
    label: "Play for retake", call: "Give the sites, keep utility — we retake together on the plant." },
  aggroMid: { id: "aggroMid", posts: "aggroMid", holdForRetake: false,
    label: "Aggro mid", call: "Two take mid early. Sites play safe behind them." },
};

// --- Plan selection --------------------------------------------------------------
// ctx: { round, avgMoney, lossStreak, scoreFor, scoreAgainst, lastId,
//        lastSite (the site Ember hit last round), callId (the buy call) }
export function chooseEmberPlan(ctx) {
  const P = EMBER_PLANS;
  if (ctx.round <= 1) return P.defaultA;
  if (ctx.callId === "eco") return ctx.round % 2 ? P.ecoStackA : P.ecoStackB;
  const ahead = ctx.scoreFor - ctx.scoreAgainst;
  // A fake only works if the defence believes the show: run it while ahead,
  // never twice in a row, and never on a force buy (no utility to sell it).
  if (ahead >= 2 && ctx.callId === "full" && ctx.lastId !== "fakeA" && ctx.lastId !== "fakeB") {
    return ctx.lastSite === "A" ? P.fakeA : P.fakeB;
  }
  // Down two losses the round has to be fast: a rush trades the whole team
  // at one door before the defence can set its crossfires.
  if (ctx.lossStreak >= 2) return ctx.round % 2 ? P.rushB : P.rushA;
  if (ctx.round % 3 === 0) return ctx.lastSite === "A" ? P.splitB : P.splitA;
  // Default: hit the site Ember did NOT hit last round, so the defence's
  // stack reads from the previous round are wrong half the time.
  return ctx.lastSite === "A" ? P.defaultB : P.defaultA;
}

export function chooseWardenPlan(ctx) {
  const P = WARDEN_PLANS;
  if (ctx.round <= 1) return P.standard;
  if (ctx.callId === "eco") return P.retake;
  // Lost the last two defences on the same site? Stack it and dare them back.
  if (ctx.lossStreak >= 2 && ctx.lastSite) return ctx.lastSite === "A" ? P.stackA : P.stackB;
  if ((ctx.scoreFor - ctx.scoreAgainst) >= 3 && ctx.round % 2 === 0) return P.aggroMid;
  if (ctx.round % 4 === 0) return ctx.lastSite === "A" ? P.stackB : P.stackA;
  return P.standard;
}

// --- Radio lines -------------------------------------------------------------------
// Every line the radio can speak, built in one place so the HUD log, the
// squelch chirps and the bots' shared intel all tell the same story.
// The HUD prints "<speaker> <text>", so no line below repeats its speaker's
// name — a log that reads "Cinder Cinder is down" is a bug, not a style.
export const RADIO = {
  plan: (plan) => plan.call,
  contact: (place) => `contact — ${place}!`,
  rotate: (site) => `Rotate — we finish ${site}.`,
  execute: (site) => `Execute ${site} — go, go!`,
  manDown: (place) => `is down — ${place}.`,
  trade: () => `trading, swinging now.`,
  planted: (site) => `Charge planted, site ${site}. Retake together.`,
  defusing: () => `defusing — cover me.`,
  drop: (to, what) => `dropped a ${what} for ${to}.`,
  lowTime: () => "Thirty seconds — commit now.",
  ecoWin: () => "Eco steal! Bank it, full buy next.",
};
