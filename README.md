# SLAGLINE

A round-based tactical first-person shooter built on three.js, in the style
Counter-Strike made famous — but with its own map, teams, weapons and names.
Two five-bot-and-you teams fight over a working foundry: **Ember** attacks and
plants a charge on site **A** or **B**; the **Wardens** defend, rotate and
defuse. Money flows between rounds through a buy menu, accuracy beats speed,
and the first team to 9 rounds takes the match.

## Play it

```sh
node serve.ts        # then open http://localhost:8080 in desktop Chrome
```

Or serve `game/` with any static file server and open `game/index.html`.
The game is plain ES modules with no build step and no network request;
three.js 0.187.0 is vendored under `game/vendor/three/`.

**Controls** — WASD move, mouse aim, click to fire, R reload, Ctrl crouch,
Shift walk (silent — bots' hearing cannot pick up a walked rotation),
Space jump, right-click to scope the Longshot, 3/4/5 throw flash/frag/smoke,
hold E to plant, G drops your primary for a teammate, B opens the buy menu
during the buy phase.

## How it plays

- **Rounds** — a 12 s buy phase (teams stage behind barriers, weapons silent),
  then live rounds up to 100 s. Planting takes 3.2 s, the charge burns 40 s,
  a defuse takes 5 s with a kit, 10 s without. Elimination, detonation,
  defusal and time all end rounds.
- **Economy** — one price table (`game/src/config.js`) feeds the buy menu,
  bot shopping and the firing code, so they can never disagree. Wins pay
  $3,250 ($3,500 for an objective win), losses pay a growing bonus
  ($1,400 + $500 per consecutive loss, capped $3,400) — and the buy menu
  prints the exact bonus you will get if you lose the next round. The
  planter's bonuses are paid at the moment the charge goes down, so a
  post-plant elimination win still pays them in full. Kill rewards differ
  by weapon class (SMG/shotgun $600, rifle $300, Longshot $100), and each
  round opens with a team **buy call** — pistol / eco / force / half /
  full — derived from average money plus the exact loss bonus a defeat
  would pay; bot shopping obeys the call, and the richest bot drops a
  rifle for the poorest teammate who has none.
- **Team plans and radio** — every round both teams play a called plan
  (`game/src/tactics.js`): Ember runs defaults, rushes, mid splits, fakes
  (show one lane, finish the other) and eco stacks; the Wardens answer
  with a standard 2-1-2, site stacks, an aggro-mid pair or a retake five.
  Bots stage at lane approaches and convert on the execute call. A bot
  that spots an enemy radios the contact — the call is written to the
  radio log, a squelch chirps, and the spotted position becomes shared
  team intel that free teammates respond to. Deaths are radioed too, and
  the nearest teammate claims the trade swing. Footsteps are real noise:
  a rotating team can be heard rotating, unless it walks.
- **Gunplay** — five weapons with fixed, learnable recoil patterns and only
  partial view recovery; spread punishes moving and jumping (plus a small
  landing bloom), crouching tightens it, the hip-fired Longshot is wildly
  inaccurate while its scope caps your movement speed. Headshots multiply
  damage; armor absorbs half.
- **Bots** — turn-rate-limited aim with error that grows with target speed, a
  feet-planted settle before each first burst, bursts with decaying recoil
  heat, and hearing that only investigates noise 0.15–2.2 s old. They flash
  site entries, smoke and frag retakes, spread post-plant, fall back at low
  health, re-path when stuck, reload in lulls, assign retake roles (nearest
  defuses, one covers, the rest advance) — and the bomb carrier will not
  plant into a fresh contact.
- **Feedback** — a dynamic crosshair driven by your real current spread,
  a damage-direction wedge, hitmarkers with a distinct kill sound, alive
  pips for both teams, a bomb status line whose beeps accelerate as the
  fuse burns, with a rising warning under ten seconds — plus a live
  minimap drawn from the world's own collider list (teammates, the last
  radioed enemy intel, the charge), a radio log, round-history dots, a
  plant/defuse progress bar, a round MVP named from tracked damage, and a
  buy menu that shows every teammate's money and primary. Dropped
  primaries — yours with G, or a dead fighter's — lie in the world for
  anyone without one to pick up, and the detonation itself deals falloff
  damage to anyone caught near the site.

## Code layout

| File | Job |
| --- | --- |
| `game/src/config.js` | Single source of truth: weapons, prices, recoil patterns, economy |
| `game/src/tactics.js` | Team plans, buy calls, callout names and every radio line (pure data/functions) |
| `game/src/radio.js` | The radio log and the shared-intel record a contact call creates |
| `game/src/world.js` | The foundry map, colliders, nav graph, sites, signage, plan post sets |
| `game/src/combat.js` | Allocation-free firing/LOS hot path, grenades, the noise bus |
| `game/src/bots.js` | Bot perception, aim model, plan execution, trades, intel response |
| `game/src/player.js` | Pointer-lock movement, crouch, silent walk, jump, landing bloom |
| `game/src/game.js` | Match state machine: phases, plans, bomb, economy, drops, damage |
| `game/src/hud.js` | DOM HUD, crosshair, minimap, radio log, buy menu, killfeed |
| `game/src/audio.js` | All-synthesised WebAudio sound: shots, radio squelch, ambience, bomb beeps |
| `game/src/main.js` | Bootstrap, fixed-step loop, adaptive quality |
| `main.ts` | Hand-in program: copies `game/` + `screenshots/` to the output dir and writes `dossier.json` |

The simulation runs on a fixed 1/60 step, separate from rendering. The
firing and line-of-sight path allocates nothing per shot. Pixel ratio is
capped at 1.75 and steps down automatically when frame times stay slow.

A hands-free demo mode (`game/index.html?demo=1`) lets the bots play a full
match against each other — handy for screenshots and smoke tests.

## License

MIT — see `LICENSE`. three.js is vendored under its own license at
`game/vendor/three/LICENSE`.
