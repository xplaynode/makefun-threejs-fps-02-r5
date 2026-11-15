// main.js — bootstrap and render loop for SLAGLINE.
// The simulation advances on a fixed 1/60 step from an accumulator, entirely
// separate from rendering; the renderer only reads state. Frame quality is
// adaptive: pixel ratio is capped at 1.75, and when the frame-time EMA stays
// above ~21 ms the cap steps down (1.75 → 1.5 → 1.25 → 1) until it recovers.

import * as THREE from "three";
import { buildWorld, EYE } from "./world.js";
import { Match } from "./game.js";
import { Hud } from "./hud.js";
import { SoundBank } from "./audio.js";
import { currentSpread } from "./combat.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const FAST = params.has("test");

const canvas = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
let pixelCap = 1.75;
renderer.setPixelRatio(Math.min(devicePixelRatio, pixelCap));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.05, 220);
scene.add(camera);

const world = buildWorld(scene);
const sounds = new SoundBank();
const hud = new Hud();
const match = new Match(scene, world, sounds, hud, canvas, { demo: DEMO, fast: FAST });
const player = match.player;

// Viewmodel: a low gun shape glued to the camera, plus a muzzle point.
const vm = new THREE.Group();
const vmBody = new THREE.Mesh(
  new THREE.BoxGeometry(0.09, 0.16, 0.72),
  new THREE.MeshStandardMaterial({ color: 0x23252a, roughness: 0.55, metalness: 0.5 })
);
vmBody.position.set(0.24, -0.22, -0.55);
const vmBarrel = new THREE.Mesh(
  new THREE.BoxGeometry(0.05, 0.05, 0.4),
  new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.4, metalness: 0.6 })
);
vmBarrel.position.set(0.24, -0.16, -1.05);
vm.add(vmBody, vmBarrel);
camera.add(vm);

// Input state for the human player.
const input = { firing: false, nextShot: 0 };
addEventListener("mousedown", (e) => {
  sounds.unlock();
  if (e.button === 0) input.firing = true;
  if (e.button === 2 && player.weapon && player.weapon.def.zoom) player.zoomed = !player.zoomed;
});
addEventListener("mouseup", (e) => { if (e.button === 0) input.firing = false; });
addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("keydown", (e) => {
  if (DEMO) return;
  if (e.code === "KeyR") match.startReload(player);
  if (e.code === "KeyG" && player.alive && player.primaryId) match.dropWeapon(player);
  if (e.code === "KeyB" && match.phase === "buy") {
    const b = hud.el.buy;
    if (b.style.display === "none") hud.showBuy(player, "ember", match.lossStreak.ember, (k) => match.playerBuy(k), true,
      { call: match.buyCalls.ember, team: match.fighters.filter((f) => f.team === "ember") });
    else hud.hideBuy();
  }
  if (match.phase === "buy" && hud.buyKeys && /^Digit[1-9]$/.test(e.code)) {
    const key = hud.buyKeys[Number(e.code.slice(5)) - 1];
    if (key) match.playerBuy(key);
  }
  // Grenades: 3 = flash, 4 = frag, 5 = smoke — thrown toward the crosshair.
  const gk = e.code === "Digit3" ? "flash" : e.code === "Digit4" ? "frag" : e.code === "Digit5" ? "smoke" : null;
  if (gk && player.grenades[gk] > 0 && match.phase === "live") {
    player.grenades[gk]--;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    match.grenades.throwGrenade(gk, new THREE.Vector3(player.x, player.eyeY, player.z), dir, 13);
  }
});
let plantHeld = false, defuseHeld = false;
addEventListener("keydown", (e) => { if (e.code === "KeyE") plantHeld = true; if (e.code === "KeyF") defuseHeld = true; });
addEventListener("keyup", (e) => { if (e.code === "KeyE") plantHeld = false; if (e.code === "KeyF") defuseHeld = false; });

const startOverlay = document.getElementById("startOverlay");
if (DEMO) startOverlay.style.display = "none";
else startOverlay.addEventListener("click", () => { sounds.unlock(); canvas.requestPointerLock(); });
document.addEventListener("pointerlockchange", () => {
  if (!DEMO) startOverlay.style.display = document.pointerLockElement === canvas ? "none" : "flex";
});

// Demo camera: chase the camera fighter from just behind its shoulder.
const demoCam = new THREE.Vector3();
let chirpSeq = 0;
let last = performance.now();
let acc = 0;
const STEP = 1 / 60;
let frameEma = 16;
let qualityCooldown = 0;

function frame(nowMs) {
  requestAnimationFrame(frame);
  let dt = (nowMs - last) / 1000;
  last = nowMs;
  if (dt > 0.25) dt = 0.25;

  // Adaptive quality: sustained slow frames step the pixel cap down.
  frameEma = frameEma * 0.95 + Math.min(100, dt * 1000) * 0.05;
  qualityCooldown -= dt;
  if (frameEma > 21 && pixelCap > 1 && qualityCooldown <= 0) {
    pixelCap = pixelCap > 1.5 ? 1.5 : pixelCap > 1.25 ? 1.25 : 1;
    renderer.setPixelRatio(Math.min(devicePixelRatio, pixelCap));
    qualityCooldown = 2.5;
  }

  // Player actions that live outside the fixed step (fire rate, plant hold).
  if (!DEMO && player.alive && match.phase === "live") {
    const w = player.weapon;
    if (input.firing && w && nowMs >= input.nextShot) {
      const ok = match.shoot(player, player.yaw, player.pitch, 0);
      input.nextShot = nowMs + (60000 / w.def.rpm) * (w.def.auto ? 1 : 1.6);
      if (!ok && w.ammo > 0) input.nextShot = nowMs + 90;
    }
    if (!input.firing) player.zoomed = player.zoomed && player.weapon && player.weapon.def.zoom ? player.zoomed : false;
    if (plantHeld && player.hasBomb) {
      const site = [world.sites.A, world.sites.B].find((s) => Math.hypot(player.x - s.x, player.z - s.z) < s.r);
      if (site) match.tryPlant(player, site);
    }
    if (defuseHeld && match.bomb.state === "planted") match.tryDefuse(player);
    hud.prompt(
      player.hasBomb && match.bomb.state === "carried"
        ? "You carry the charge — reach a site and hold E to plant"
        : match.bomb.state === "planted" && player.team === "warden"
          ? "Charge planted — hold F at the charge to defuse"
          : ""
    );
  }

  // Radio squelch for fresh calls on the player's team (the radio log
  // itself is rendered by the HUD from the same record).
  if (!DEMO) {
    const fresh = match.radio.calls.filter((c) => c.seq >= chirpSeq && c.team === player.team);
    chirpSeq = match.radio.seq;
    if (fresh.length) sounds.radioChirp();
  } else chirpSeq = match.radio.seq;
  // Planting ticks: while the player plants, tick with progress.
  if (!DEMO && match.planting && match.planting.fighter === player) {
    const frac = match.planting.t / 3.2;
    if ((frac * 8 | 0) !== (((frac - dt / 3.2) * 8) | 0)) sounds.plantTick(frac);
  }

  acc += dt;
  while (acc >= STEP) { match.update(STEP); acc -= STEP; }

  // Camera from the player fighter (or the demo chase view).
  if (DEMO) {
    demoCam.set(player.x - Math.sin(player.yaw) * -6, 4.2, player.z - Math.cos(player.yaw) * -6);
    camera.position.lerp(demoCam, 0.08);
    camera.lookAt(player.x, 1.2, player.z);
    vm.visible = false;
  } else {
    camera.position.set(player.x, player.y + player.eyeY, player.z);
    camera.rotation.set(0, 0, 0);
    camera.rotation.order = "YXZ";
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch + player.kickPitch;
    camera.rotation.z = 0;
    camera.fov += (((player.zoomed ? 32 : 78)) - camera.fov) * 0.35;
    camera.updateProjectionMatrix();
    vm.visible = player.alive;
    vm.position.y = player.crouch ? -0.12 : 0;
  }

  // Dynamic crosshair from the REAL current spread of the player's weapon.
  if (!DEMO && player.weapon) {
    const spread = currentSpread(player.weapon, player.moving, player.air, player.crouch, player.zoomed, 0)
      + (match.control ? match.control.landingBloom : 0);
    hud.setCrosshairSpread(spread * 900);
    hud.el.scope.style.display = player.zoomed ? "block" : "none";
  }
  hud.el.flash.style.opacity = player.blindT > 0.2 ? String(Math.min(0.9, player.blindT * 0.4)) : hud.el.flash.style.opacity;
  hud.frame(match.hudState());
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Test/demo hook: lets a headless smoke run read the match state.
window.__slagline = { match, world, scene };
