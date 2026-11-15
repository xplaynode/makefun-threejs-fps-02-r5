// radio.js — the team radio: a capped log of calls plus the shared-intel
// record they create. A call is not flavour text bolted onto the HUD: when
// a bot radios a contact, game.js writes the spotted position into the
// team's intel slot, and every teammate may respond to it for a few seconds
// (see bots.js). The log itself is what hud.js renders and what main.js
// counts to play the squelch chirp — one record, three readers.

export class Radio {
  constructor() {
    this.calls = [];       // {team, speaker, text, at, seq}
    this.seq = 0;
    this.drained = 0;      // seq already counted by the audio side
    // Shared intel per team: the last position a teammate actually saw an
    // enemy, and when. Bots respond to fresh intel; stale intel is history.
    this.intel = {
      ember: { x: 0, z: 0, at: -99, by: "" },
      warden: { x: 0, z: 0, at: -99, by: "" },
    };
  }

  push(team, speaker, text, now) {
    this.calls.push({ team, speaker, text, at: now, seq: this.seq++ });
    if (this.calls.length > 28) this.calls.shift();
  }

  // A sighting becomes intel for the caller's whole team at once — that is
  // what a radio is FOR. The caller is named so a bot never "responds" to
  // its own call.
  shareIntel(team, x, z, now, by) {
    const slot = this.intel[team];
    slot.x = x; slot.z = z; slot.at = now; slot.by = by;
  }

  intelFor(team, now, maxAge) {
    const slot = this.intel[team];
    return now - slot.at <= maxAge ? slot : null;
  }

  latest(n) { return this.calls.slice(-n); }

  // How many calls arrived since the audio side last looked. main.js turns
  // a positive count for the player's team into one squelch chirp.
  drainNew() {
    const n = this.seq - this.drained;
    this.drained = this.seq;
    return n;
  }
}
