// world.js — the SLAGLINE foundry: an original industrial map with two bomb
// sites, three lanes and a mid connector. The same collider list drives
// movement collision, bullet impacts, line-of-sight checks and the bots'
// navigation graph, so what you see is exactly what the simulation believes.

import * as THREE from "three";

export const EYE = 1.62;

const STEEL = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.85, metalness: 0.35 });
const RUST = new THREE.MeshStandardMaterial({ color: 0x8a4a26, roughness: 0.95, metalness: 0.1 });
const CONCRETE = new THREE.MeshStandardMaterial({ color: 0x77726a, roughness: 1, metalness: 0 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.9, metalness: 0.4 });
const SLAG = new THREE.MeshStandardMaterial({ color: 0xff6a1f, emissive: 0xff5a00, emissiveIntensity: 1.6, roughness: 0.6 });
const CRATE = new THREE.MeshStandardMaterial({ color: 0x9a7b4f, roughness: 0.95 });
const FLOOR_MAT = new THREE.MeshStandardMaterial({ color: 0x3d3a36, roughness: 1 });
const SITE_A_MAT = new THREE.MeshStandardMaterial({ color: 0xb3541e, roughness: 0.9, emissive: 0x903c00, emissiveIntensity: 0.25 });
const SITE_B_MAT = new THREE.MeshStandardMaterial({ color: 0x1e5fa8, roughness: 0.9, emissive: 0x0a3f7d, emissiveIntensity: 0.25 });

function letterTexture(letter, bg, fg) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = bg; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = fg; g.lineWidth = 10; g.strokeRect(14, 14, 228, 228);
  g.fillStyle = fg;
  g.font = "900 170px Arial, sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(letter, 128, 138);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

// A box collider: {x0,x1,z0,z1,h} — footprint plus height. h >= EYE blocks sight.
export function makeBox(x, z, w, d, h) {
  return { x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2, h };
}

// Resolve a circle (x,z,r) out of every collider footprint. Returns via out.
export function collideCircle(x, z, r, colliders, out) {
  out.x = x; out.z = z;
  for (let i = 0; i < colliders.length; i++) {
    const b = colliders[i];
    if (b.off) continue;
    const nx = Math.max(b.x0, Math.min(b.x1, out.x));
    const nz = Math.max(b.z0, Math.min(b.z1, out.z));
    const dx = out.x - nx, dz = out.z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        out.x = nx + (dx / d) * r;
        out.z = nz + (dz / d) * r;
      } else {
        // centre inside the box: push out along the shallowest axis
        const pl = out.x - b.x0, pr = b.x1 - out.x, pn = out.z - b.z0, pf = b.z1 - out.z;
        const m = Math.min(pl, pr, pn, pf);
        if (m === pl) out.x = b.x0 - r; else if (m === pr) out.x = b.x1 + r;
        else if (m === pn) out.z = b.z0 - r; else out.z = b.z1 + r;
      }
    }
  }
  return out;
}

// 2D sight check: does the segment pass through any tall collider?
export function segmentBlocked(x0, z0, x1, z1, colliders) {
  for (let i = 0; i < colliders.length; i++) {
    const b = colliders[i];
    if (b.off || b.h < 1.4) continue;
    if (segHitsBox(x0, z0, x1, z1, b.x0, b.z0, b.x1, b.z1)) return true;
  }
  return false;
}

function segHitsBox(x0, z0, x1, z1, bx0, bz0, bx1, bz1) {
  const dx = x1 - x0, dz = z1 - z0;
  let t0 = 0, t1 = 1;
  if (Math.abs(dx) < 1e-9) { if (x0 < bx0 || x0 > bx1) return false; }
  else {
    let ta = (bx0 - x0) / dx, tb = (bx1 - x0) / dx;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  if (Math.abs(dz) < 1e-9) { if (z0 < bz0 || z0 > bz1) return false; }
  else {
    let ta = (bz0 - z0) / dz, tb = (bz1 - z0) / dz;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

export function buildWorld(scene) {
  const colliders = [];
  const group = new THREE.Group();
  scene.add(group);

  const addBox = (x, z, w, d, h, mat) => {
    colliders.push(makeBox(x, z, w, d, h));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, h / 2, z);
    group.add(mesh);
    return mesh;
  };

  // Floor and outer walls (playfield x -38..38, z -28..28)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(76, 56), FLOOR_MAT);
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);
  addBox(0, -28.6, 78, 1.2, 5, DARK); addBox(0, 28.6, 78, 1.2, 5, DARK);
  addBox(-38.6, 0, 1.2, 58, 5, DARK); addBox(38.6, 0, 1.2, 58, 5, DARK);

  // Lane walls carving A lane (west), mid and B lane (east), with door gaps.
  // West block between A lane and mid, gaps at z = -6 and z = 14.
  addBox(-12, -19, 1.4, 16, 4.4, STEEL);
  addBox(-12, 3.5, 1.4, 9, 4.4, STEEL);
  addBox(-12, 21.5, 1.4, 11, 4.4, STEEL);
  // East block between mid and B lane, gaps at z = -12 and z = 10.
  addBox(12, -21.5, 1.4, 11, 4.4, STEEL);
  addBox(12, -2.5, 1.4, 9, 4.4, STEEL);
  addBox(12, 19, 1.4, 16, 4.4, STEEL);
  // Cross walls shaping site entries and spawn exits.
  addBox(-24, -6, 14, 1.4, 4.4, RUST);   // A site back wall segment
  addBox(24, -8, 14, 1.4, 4.4, RUST);    // B site back wall segment
  addBox(0, 12, 16, 1.4, 4.4, CONCRETE); // mid-to-spawn divider, gaps at sides
  addBox(-24, 8, 12, 1.4, 4.4, CONCRETE);
  addBox(24, 6, 12, 1.4, 4.4, CONCRETE);

  // Cover: crates and furnace furniture inside and around the sites.
  const cover = [
    [-28, -18, 3, 3, 1.6], [-19, -12, 2.4, 2.4, 1.2], [-24, -22, 4, 2, 1.1],
    [28, -19, 3, 3, 1.6], [20, -13, 2.4, 2.4, 1.2], [24, -23, 4, 2, 1.1],
    [0, -14, 5, 3, 1.7], [-5, 2, 3, 3, 1.3], [6, -3, 2.4, 4, 1.3],
    [-8, -8, 2.4, 2.4, 1.3], [8, 7, 2.4, 2.4, 1.3], // mid-connector crates: the split routes now have a fight in them
    [-24, -1, 3, 2.4, 1.2], [24, 0, 3, 2.4, 1.2], [-31, 4, 2.4, 2.4, 1.2],
    [31, 12, 2.4, 2.4, 1.2], [0, 22, 6, 2, 1.1], [-18, 18, 2.4, 2.4, 1.2], [18, 16, 2.4, 2.4, 1.2],
  ];
  for (const [x, z, w, d, h] of cover) addBox(x, z, w, d, h, CRATE);

  // The furnace: a tall block north-mid with a glowing slag mouth.
  addBox(0, -23, 10, 4, 6.5, RUST);
  const mouth = new THREE.Mesh(new THREE.PlaneGeometry(6, 2.6), SLAG);
  mouth.position.set(0, 1.6, -20.94);
  group.add(mouth);
  for (const sx of [-3.4, 3.4]) {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 9, 10), DARK);
    stack.position.set(sx, 9, -23);
    group.add(stack);
  }
  // Hanging lamps over both sites and mid.
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffe2b0, emissive: 0xffc873, emissiveIntensity: 2.2 });
  for (const [x, z] of [[-24, -16], [24, -16], [0, -2], [0, 20]]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.25, 1.6), lampMat);
    lamp.position.set(x, 5.4, z);
    group.add(lamp);
    const light = new THREE.PointLight(0xffd9a0, 60, 26, 1.8);
    light.position.set(x, 5, z);
    group.add(light);
  }
  scene.add(new THREE.HemisphereLight(0xbdd3e6, 0x3a2f28, 1.2));
  const sun = new THREE.DirectionalLight(0xfff1dd, 1.9);
  sun.position.set(24, 40, 14);
  scene.add(sun);
  scene.fog = new THREE.Fog(0x1c1a18, 55, 120);
  scene.background = new THREE.Color(0x191715);

  // Sites: floor pads, rings and big readable signage.
  const sites = {
    A: { key: "A", x: -24, z: -16, r: 6.5 },
    B: { key: "B", x: 24, z: -16, r: 6.5 },
  };
  for (const s of [sites.A, sites.B]) {
    const pad = new THREE.Mesh(new THREE.CircleGeometry(s.r, 28), s.key === "A" ? SITE_A_MAT : SITE_B_MAT);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(s.x, 0.02, s.z);
    group.add(pad);
    const signMat = new THREE.MeshBasicMaterial({ map: letterTexture(s.key, s.key === "A" ? "#7a2d08" : "#0d3f74", "#ffffff") });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6), signMat);
    sign.position.set(s.x, 3.4, s.key === "A" ? -22.2 : -22.2);
    group.add(sign);
    const sign2 = sign.clone();
    sign2.position.set(s.x + (s.key === "A" ? 6.8 : -6.8), 3.2, -16);
    sign2.rotation.y = s.key === "A" ? Math.PI / 2 : -Math.PI / 2;
    group.add(sign2);
  }

  // --- Foundry dressing (visual only — no colliders, so the simulation's
  // view of the map is unchanged and nothing here can be walked into or
  // shot through in a way the bots do not expect). An overhead crane spans
  // the hall, pipes run the lane walls, barrels sit ON the crate cover,
  // painted lane stripes lead each spawn to its sites, a glowing slag
  // channel borders mid, ingot stacks dress the site corners, and factory
  // silhouettes stand beyond the north wall in the fog.
  const crane = new THREE.Group();
  for (const z of [-16, 2]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(64, 0.5, 0.8), STEEL);
    beam.position.set(0, 6.8, z);
    crane.add(beam);
  }
  const hook = new THREE.Group();
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6), DARK);
  cable.position.y = -1.3;
  const hookBlock = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.7), RUST);
  hookBlock.position.y = -2.9;
  hook.add(cable, hookBlock);
  hook.position.set(-6, 6.8, -16);
  crane.add(hook);
  group.add(crane);
  for (const sx of [-36.8, 36.8]) {
    for (const [py, pm] of [[3.4, RUST], [2.7, DARK]]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 46, 8), pm);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(sx, py, 0);
      group.add(pipe);
    }
  }
  for (const [x, z, topY] of [[-28, -18, 1.6], [0, -14, 1.7], [28, -19, 1.6], [-5, 2, 1.3]]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.15, 10), RUST);
    barrel.position.set(x, topY + 0.58, z);
    group.add(barrel);
  }
  const stripe = (x, z, len, mat) => {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(1.3, len), mat);
    s.rotation.x = -Math.PI / 2;
    s.position.set(x, 0.03, z);
    group.add(s);
  };
  stripe(-24, 5, 15, SITE_A_MAT); stripe(24, 5, 15, SITE_B_MAT); stripe(0, -5, 18, CONCRETE);
  for (const sx of [-10.8, 10.8]) {
    const channel = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 42), SLAG);
    channel.rotation.x = -Math.PI / 2;
    channel.position.set(sx, 0.025, -2);
    group.add(channel);
  }
  for (const [x, z] of [[-31.5, -23], [31.5, -23]]) {
    for (let i = 0; i < 3; i++) {
      const ingot = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.45, 0.65), STEEL);
      ingot.position.set(x + (i % 2) * 0.7 - 0.35, 0.24 + (i > 1 ? 0.45 : 0), z);
      group.add(ingot);
    }
  }
  for (let i = 0; i < 7; i++) {
    const h = 8 + (i * 37 % 9);
    const sil = new THREE.Mesh(new THREE.BoxGeometry(7, h, 5), DARK);
    sil.position.set(-33 + i * 11, h / 2, -36 - (i % 3) * 3);
    group.add(sil);
  }
  // Emissive lamp strips over the lane doors (no extra point lights — the
  // four real lamps above carry the lighting; these just read as fixtures).
  const stripMat = new THREE.MeshStandardMaterial({ color: 0xffe2b0, emissive: 0xffc873, emissiveIntensity: 1.6 });
  for (const [x, z] of [[-12, -6], [-12, 14], [12, -12], [12, 10], [0, 12]]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 0.5), stripMat);
    strip.position.set(x, 4.5, z);
    group.add(strip);
  }
  const midLight = new THREE.PointLight(0xffd9a0, 40, 22, 1.8);
  midLight.position.set(0, 5, 14);
  group.add(midLight);

  // Buy-phase barriers are created AFTER the navigation graph below: the
  // graph's edge tests must not see them, or the spawn pockets would be
  // disconnected from the lanes once the barriers drop. setBarrier is
  // declared here and filled in below, before buildWorld returns.
  let setBarrier = () => {};

  // Spawns and staging posts (behind the barriers during the buy phase).
  const emberSpawn = [[-6, 24], [-2, 25], [2, 24], [6, 25], [0, 22]];
  const wardenSpawn = [[-6, -25], [-2, -24], [2, -25], [6, -24], [0, -22.5]];
  const emberPosts = [[-22, 15], [-26, 15], [-2, 18], [22, 14], [26, 14]];
  const wardenPosts = [[-22, -12], [-27, -13], [0, -14.5], [22, -14], [27, -13]];
  // Warden post sets for the stack / retake / aggro-mid plans (tactics.js
  // picks the set, game.js deals the posts out). A stack puts three bodies
  // on one site in crossfire positions; a retake five pulls everyone back
  // to mid so the retake starts grouped, with utility unspent.
  const wardenPostsByPlan = {
    standard: wardenPosts,
    stackA: [[-22, -12], [-27, -13], [-19, -19], [0, -14.5], [22, -14]],
    stackB: [[-22, -12], [19, -19], [0, -14.5], [22, -14], [27, -13]],
    retake: [[-14, -10], [14, -10], [0, -6], [-6, -12], [6, -12]],
    aggroMid: [[-22, -12], [27, -13], [0, -8], [-4, -2], [4, -2]],
  };
  // Lane approach holds: where attackers stage before an execute, and the
  // mouth a fake shows itself at. Just outside each site's entry doors.
  const holds = {
    A: { x: -24, z: 3 }, B: { x: 24, z: 4 }, mid: { x: 0, z: 7 },
  };

  // Navigation waypoints along the lanes; edges auto-link when the straight
  // walk between two nodes stays clear of tall colliders.
  const wpRaw = [
    [-24, 22], [-24, 15], [-24, 5], [-24, -4], [-24, -12], [-24, -20], [-29, -16], [-19, -16],
    [24, 22], [24, 14], [24, 4], [24, -5], [24, -12], [24, -20], [29, -16], [19, -16],
    [0, 24], [0, 18], [0, 8], [0, 0], [0, -8], [0, -16], [-6, -16], [6, -16],
    [-17, 14], [-17, -6], [-17, 4], [17, 10], [17, -12], [17, 2],
    [-24, -26], [24, -26], [0, -24], [-12, 24], [12, 24], [-31, -8], [31, -8],
    [-8, -4], [8, 2], [-24, 3], [24, 4], [0, 7], [-19, -19], [19, -19],
  ];
  const waypoints = wpRaw.map(([x, z], i) => ({ i, x, z, edges: [] }));
  for (let a = 0; a < waypoints.length; a++) {
    for (let b = a + 1; b < waypoints.length; b++) {
      const A = waypoints[a], B = waypoints[b];
      const dx = A.x - B.x, dz = A.z - B.z;
      if (dx * dx + dz * dz > 20 * 20) continue;
      if (!segmentBlocked(A.x, A.z, B.x, B.z, colliders)) { A.edges.push(b); B.edges.push(a); }
    }
  }

  // Buy-phase barriers: translucent walls sealing each spawn until go-live.
  // Added to the collider list only now that the nav graph exists.
  const barrierMat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
  const barrierMeshes = [];
  const barrierBoxes = [];
  for (const [x, z, w, d] of [[-24, 12.8, 11, 0.6], [0, 15.5, 14, 0.6], [24, 10.8, 11, 0.6], [-24, -9.5, 11, 0.6], [0, -17.5, 14, 0.6], [24, -11.5, 11, 0.6]]) {
    const b = makeBox(x, z, w, d, 3);
    barrierBoxes.push(b); colliders.push(b);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 3, d), barrierMat);
    m.position.set(x, 1.5, z);
    group.add(m); barrierMeshes.push(m);
  }
  setBarrier = (on) => {
    for (const b of barrierBoxes) b.off = !on;
    for (const m of barrierMeshes) m.visible = on;
  };

  let flicker = 0;
  return {
    colliders, sites, emberSpawn, wardenSpawn, emberPosts, wardenPosts,
    wardenPostsByPlan, holds,
    waypoints, setBarrier,
    nearestWaypoint(x, z) {
      let best = 0, bd = Infinity;
      for (const w of waypoints) { const d = (w.x - x) ** 2 + (w.z - z) ** 2; if (d < bd) { bd = d; best = w.i; } }
      return best;
    },
    update(dt) {
      flicker += dt;
      SLAG.emissiveIntensity = 1.45 + Math.sin(flicker * 7.3) * 0.18 + Math.sin(flicker * 23.7) * 0.08;
      hook.rotation.z = Math.sin(flicker * 0.7) * 0.045;   // the crane hook sways, barely
      hook.rotation.x = Math.cos(flicker * 0.53) * 0.03;
    },
  };
}

// Breadth-first path over the waypoint graph. Writes node indices into the
// caller-provided array and returns the count — no allocation per call.
export function findPath(world, fromIdx, toIdx, outPath) {
  const wps = world.waypoints;
  if (fromIdx === toIdx) { outPath[0] = toIdx; return 1; }
  const prev = findPathScratch.prev;
  const queue = findPathScratch.queue;
  for (let i = 0; i < wps.length; i++) prev[i] = -2;
  let qh = 0, qt = 0;
  queue[qt++] = fromIdx; prev[fromIdx] = -1;
  while (qh < qt) {
    const cur = queue[qh++];
    if (cur === toIdx) break;
    const edges = wps[cur].edges;
    for (let e = 0; e < edges.length; e++) {
      const n = edges[e];
      if (prev[n] === -2) { prev[n] = cur; queue[qt++] = n; }
    }
  }
  if (prev[toIdx] === -2) { outPath[0] = toIdx; return 1; }
  let len = 0, cur = toIdx;
  while (cur !== -1) { outPath[len++] = cur; cur = prev[cur]; }
  // reverse in place
  for (let i = 0, j = len - 1; i < j; i++, j--) { const t = outPath[i]; outPath[i] = outPath[j]; outPath[j] = t; }
  return len;
}
const findPathScratch = { prev: new Int16Array(64), queue: new Int16Array(64) };
