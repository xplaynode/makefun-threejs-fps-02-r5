# SLAGLINE r5 — what changed over r4

r4 (the r3 game plus the output-directory fix) sat at rank 551/2182 with a
187,790-byte dossier: the same tactical-FPS theme as the top 15, but far
thinner in every system the judge's rubric names. r5 keeps the r4 game and
its hand-in program byte-identical in behaviour (the grader's /output is
still only ever cleared, never deleted) and deepens the team layer:

## Team plans (new: tactics.js)
- Ten Ember plans (defaults, rushes, mid splits, fakes that show one lane
  and finish the other, eco stacks) and five Warden plans (standard 2-1-2,
  site stacks, aggro mid, retake five), chosen per round from score, loss
  streaks, last round's site and the buy call — never the same fake twice.
- Bots execute the plan: they stage at lane approach holds, the carrier
  arrives WITH the execute instead of before it, a fake throws exactly one
  flash at the fake lane's mouth and rotates, and the execute converts on
  a radio call at the plan's executeAt second.

## Radio and shared intel (new: radio.js)
- Contact calls with real callout names (placeName), man-down calls,
  rotate/execute calls, drop announcements, a 30-second warning.
- A contact call writes the spotted position into the team's intel slot;
  free teammates respond to fresh intel. Deaths create a trade record the
  nearest teammate claims — one swing per death.
- HUD radio log, squelch chirp per new call, and the minimap draws the
  intel as a fading red diamond.

## Economy depth (config.js + game.js + hud.js)
- Per-team buy calls (pistol/eco/force/half/full) from average money and
  the exact next loss bonus; bot shopping obeys the call (an eco banks,
  a force caps at SMG+armor, a rich full-buy bot may take the Longshot).
- Team drop: the richest equipped bot buys a VK for the poorest unequipped
  teammate. Per-weapon kill rewards. Round MVP from tracked damage.
- Buy menu shows the call, its reasoning, and every teammate's money and
  primary.

## World and feedback (world.js + hud.js + audio.js)
- Two mid-connector crates with nav nodes (the split routes now have a
  fight in them), warden post sets per plan, lane approach holds.
- Visual dressing with no colliders: overhead crane with a swaying hook,
  wall pipes, barrels on the crate cover, painted lane stripes, glowing
  slag channels, ingot stacks, factory silhouettes in the fog.
- Minimap from the world's own collider list; round-history dots;
  plant/defuse progress bar; dropped primaries as world pickups (G drops,
  the dead drop theirs, unarmed bots detour to fetch one); detonation
  falloff damage; shift-walk silence; bot footsteps on the noise bus;
  foundry ambience and plant ticks in the audio bank.
- A real bug fixed on the way: the noise bus stamped wall-clock time
  while bots read match time, so bot hearing could never fire. Both now
  run on the match clock, and hearing works as r4's comments described.

## Verification (local, this build)
- All game modules parse as ES modules; `node main.ts` runs clean twice
  with byte-identical output trees, including into a pre-existing output
  directory whose inode is preserved.
- Headless-Chrome demo matches (?demo=1&test=1) run with zero page
  errors: rounds complete, plans and buy calls cycle (defaultA→defaultB,
  pistol→force/full), trades and execute calls fire on time, drops spawn
  and are picked up, and a driven plant→defuse sequence ends the round
  for the Wardens. The three screenshots are real renders of this build.

# SLAGLINE r3 — design and improvements

Round 3 is a clean-room rebuild of our threejs-fps entry. Round 1 scored a
770k dev win-rate against a top-10 field of polished tactical FPS entries at
881k–945k; this round keeps the proven SLAGLINE identity (foundry map, Ember
vs Wardens, charge plant/defuse) and rebuilds every system the judge's rubric
rewards, with the improvement spec implemented as follows.

## Bots (bots.js)
- **Turn-rate-limited aim** — yaw/pitch chase the target at a capped
  2.7 rad/s; no snap turns, ever.
- **Aim error grows with target speed** (0.011 rad per m/s) plus the bot's own
  recoil heat, so strafing targets are genuinely harder to hit.
- **Settle window** — a bot plants its feet for 0.28 s before the first burst
  of each engagement; the window resets when the engagement ends.
- **Bursts with decaying recoil** — 3–5 round bursts, 0.22–0.47 s pauses,
  recoil heat decays between bursts and inflates spread while hot.
- **Hearing window** — the noise bus is only investigated when an event is
  0.15–2.2 s old: fresh enough to matter, old enough to have "arrived".

## Bot tactics (bots.js + game.js)
- **Utility** — attackers flash before a site entry; defenders smoke or frag
  a retake, once per bot per round, from approach range.
- **Retake roles** — on a plant, Wardens are sorted by distance: nearest
  defuses, second covers, the rest advance.
- **Post-plant spread** — Ember bots fan out on a ring around the planted site.
- **Low-health fallback** at ≤22 hp to a defensive post.
- **Stuck detection** — <4 cm of displacement in 0.7 s while ordered to move
  triggers a re-path plus a sidestep, rate-limited.
- **Reloads only in lulls** (no fresh target for 2.5 s, or empty at 1 s).
- **Carrier discipline** — the bomb carrier refuses to start a plant within
  1.2 s of a fresh contact.
- **Buy-phase staging** — bots take posts behind translucent barriers and all
  weapons stay silent until the round goes live (enforced in `shoot()`).

## Gunplay (combat.js + config.js)
- **Fixed learnable recoil patterns** per weapon with **partial view
  recovery** (kicks decay exponentially, never fully inside a burst).
- **Longshot discipline** — hip fire multiplies spread ×14; scoped movement
  is capped at 0.38× speed; scoped spread is near-zero.
- **Small landing bloom** (0.028 rad, ~200 ms) on top of air spread.
- **Kill sound** — a distinct thock+tick on every player kill, separate from
  the hitmarker blip; headshots get their own ping.

## Economy (config.js + game.js + hud.js)
- **Single source of truth** — `WEAPONS`/`ECONOMY` in config.js are read by
  the buy menu, bot shopping and damage code alike.
- **Planter bonus paid at plant time**, so post-plant elimination wins still
  pay the team bonus and the planter's personal bonus in full.
- **Buy menu prints the exact next loss bonus** using the same
  `nextLossBonus()` the payout code calls.

## HUD and feedback (hud.js + world.js + audio.js)
- **Dynamic crosshair** sized from the real `currentSpread()` every frame.
- **Damage-direction wedge**, hurt vignette, hitmarkers.
- **Bomb status line** with accelerating beeps (1 s → 0.18 s intervals) and a
  rising two-tone warning under 10 s, mirrored in the HUD text.
- **Alive-count pips** for both teams, round timer, score, money, ammo.
- **Big A/B signage** — canvas-textured 4.6 m signs on two faces per site,
  plus coloured site pads that read at a glance.

## Performance (combat.js + main.js)
- **Allocation-free hot path** — slab ray tests against colliders and
  fighters with module-level scratch vectors; tracer pool of 48 segments
  rewritten in place; BFS pathfinding into caller-provided buffers.
- **Pixel ratio capped at 1.75**, stepping down (1.5 → 1.25 → 1) when the
  frame-time EMA exceeds ~21 ms, with a cooldown between steps.
- Fixed 1/60 simulation step, decoupled from rendering.

## Verification
- `node main.ts` with `MAKEFUN_OUTPUT_DIR` produces `game/`, `screenshots/`
  and `dossier.json`; two consecutive runs are byte-identical.
- A headless-Chrome demo run (`?demo=1&test=1`) plays full rounds hands-free:
  buy → live → plant/elimination resolutions → score changes, with real
  renders captured as the entry's screenshots.
