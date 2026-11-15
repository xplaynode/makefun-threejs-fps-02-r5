// audio.js — every sound in SLAGLINE is synthesised with WebAudio; the game
// ships no audio files and makes no network request. One shared context,
// short envelope-shaped oscillators and filtered noise bursts. Positional
// sounds take a 0..1 volume from distance at the call site.

export class SoundBank {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.lastBeepAt = 0;
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    this.startAmbience();
  }

  // The foundry never sleeps: a low furnace hum and slow filtered air,
  // looped under everything at a level you feel more than hear. Started
  // once, on the same user gesture that unlocks the context.
  startAmbience() {
    if (!this.ctx || this.ambient) return;
    const hum = this.ctx.createOscillator();
    hum.type = "sine";
    hum.frequency.value = 54;
    const humGain = this.ctx.createGain();
    humGain.gain.value = 0.016;
    hum.connect(humGain).connect(this.master);
    hum.start();
    const len = 2 * this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const white = Math.random() * 2 - 1; last = (last + 0.02 * white) / 1.02; data[i] = last * 3; }
    const air = this.ctx.createBufferSource();
    air.buffer = buf; air.loop = true;
    const airFilter = this.ctx.createBiquadFilter();
    airFilter.type = "lowpass"; airFilter.frequency.value = 220;
    const airGain = this.ctx.createGain();
    airGain.gain.value = 0.012;
    air.connect(airFilter).connect(airGain).connect(this.master);
    air.start();
    this.ambient = { hum, air };
  }

  // Radio squelch: the two-tone chirp that precedes a teammate's call, so
  // a plan change registers in the ear before it registers in the log.
  radioChirp() {
    this.tone(1240, 0.045, "square", 0.05);
    setTimeout(() => this.tone(1560, 0.05, "square", 0.05), 55);
  }

  // Planting feedback: a soft tick every quarter of the channel, rising in
  // pitch with progress — the planter can keep eyes on the door.
  plantTick(frac) {
    this.tone(700 + frac * 500, 0.04, "sine", 0.07);
  }

  tone(freq, dur, type, vol, slideTo) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  noise(dur, vol, cutoff, type = "lowpass") {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const len = Math.max(1, (dur * this.ctx.sampleRate) | 0);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type; filter.frequency.value = cutoff;
    const gain = this.ctx.createGain();
    gain.gain.value = vol;
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
  }

  shot(kind, vol = 1) {
    if (kind === "longshot") { this.noise(0.28, 0.5 * vol, 900); this.tone(120, 0.22, "square", 0.18 * vol, 40); }
    else if (kind === "scatter") { this.noise(0.2, 0.5 * vol, 1400); this.tone(160, 0.14, "square", 0.14 * vol, 60); }
    else if (kind === "sidearm") { this.noise(0.09, 0.32 * vol, 2600); this.tone(300, 0.05, "square", 0.08 * vol, 120); }
    else { this.noise(0.13, 0.4 * vol, 2000); this.tone(220, 0.07, "square", 0.1 * vol, 90); }
  }

  dryFire() { this.tone(1400, 0.03, "square", 0.06); }
  reload() { this.tone(500, 0.05, "square", 0.07); setTimeout(() => this.tone(760, 0.05, "square", 0.07), 160); }
  hitmark() { this.tone(1900, 0.045, "sine", 0.12); }
  headshot() { this.tone(2400, 0.06, "sine", 0.14); this.tone(3100, 0.05, "sine", 0.08); }

  // The kill confirmation: a low thock plus a bright tick, distinct from the
  // hitmarker so a kill registers without looking at the feed.
  kill() {
    this.tone(180, 0.16, "triangle", 0.28, 60);
    this.tone(1250, 0.09, "sine", 0.16);
    this.noise(0.08, 0.12, 700);
  }

  hurt() { this.tone(140, 0.12, "sawtooth", 0.12, 80); }
  buy() { this.tone(880, 0.06, "sine", 0.1); setTimeout(() => this.tone(1320, 0.07, "sine", 0.1), 60); }
  denied() { this.tone(220, 0.09, "square", 0.08); }
  roundWin() { this.tone(660, 0.14, "triangle", 0.14); setTimeout(() => this.tone(990, 0.2, "triangle", 0.14), 120); }
  roundLose() { this.tone(392, 0.16, "triangle", 0.12); setTimeout(() => this.tone(262, 0.24, "triangle", 0.12), 130); }
  plantStart() { this.tone(520, 0.08, "square", 0.1); }
  planted() { this.tone(1040, 0.1, "sine", 0.14); setTimeout(() => this.tone(1040, 0.1, "sine", 0.14), 140); }
  defuseTick() { this.tone(1560, 0.04, "sine", 0.09); }
  explosion() { this.noise(1.1, 0.7, 300); this.tone(70, 0.9, "sine", 0.4, 30); }
  flashPop() { this.noise(0.16, 0.3, 5000, "highpass"); this.tone(3400, 0.3, "sine", 0.05, 2800); }
  fragPop() { this.noise(0.4, 0.5, 800); this.tone(90, 0.3, "sine", 0.3, 40); }
  smokeHiss() { this.noise(0.7, 0.1, 1200); }
  step(vol) { this.noise(0.05, 0.05 * vol, 500); }

  // Bomb beeps accelerate as the fuse burns: interval shrinks from 1 s to
  // 0.18 s, and under ten seconds the pitch rises and a warning warble joins.
  bombBeep(timeLeft, nowMs) {
    const interval = timeLeft > 20 ? 1000 : timeLeft > 10 ? 600 : timeLeft > 5 ? 340 : 180;
    if (nowMs - this.lastBeepAt < interval) return;
    this.lastBeepAt = nowMs;
    const urgent = timeLeft <= 10;
    this.tone(urgent ? 1560 : 1180, 0.06, "sine", urgent ? 0.16 : 0.11);
    if (urgent) this.tone(2093, 0.05, "sine", 0.06);
  }
}
