// Synthesized sound: every cue is a few oscillators and noise bursts through filters and gain
// envelopes, built per play and freed when done. No files to download, all original.
// World sounds sit in 3D at their source; our own mech's play flat, as heard from the cockpit.

const MAX_VOICES = 24; // world (3D) one-shots at once; past that, new ones are dropped
const MAX_DISTANCE = 150; // m: farther world sounds aren't started
const THRUST_SLOTS = 3; // remote thruster loops, for the nearest boosting or hovering mechs
const EXHAUST_SLOTS = 4; // exhaust loops, for the nearest rockets and darts in flight
const WEIGHT = { A: 0.65, B: 1, C: 1.5 }; // shot and landing heft by class
const STEP_DEPTH = { A: 1, B: 1.5, C: 2.1 }; // footsteps: even the Light stomps; the Heavy shakes the ground
// Outside sounds reach us through the cockpit's armor: highs cut, low body lifted.
const COCKPIT_CUTOFF = 2400; // Hz

export class Sound {
  constructor() {
    this.ctx = null;
    this.voices = 0;
    this.volume = 0.8;
    this.muted = false;
    this.listener = { x: 0, y: 0, z: 0 };
    this.timers = { heat: 0, hull: 0, missile: 0, seek: 0 };
    this.overheated = false;
    this.lockMade = false;
  }

  /** Starts audio; browsers only allow it from a user gesture, so call this from one. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(ctx.destination);
    // World sounds are heard through the hull: a low-body lift, then a low-pass that also dips
    // briefly when we're hit. Our own mech's sounds skip it and stay clear.
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = COCKPIT_CUTOFF;
    this.muffle.Q.value = 0.9;
    this.muffle.connect(this.master);
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 160;
    body.gain.value = 5;
    body.Q.value = 0.8;
    body.connect(this.muffle);
    this.world = ctx.createGain();
    this.world.connect(body);
    this.cockpitBus = ctx.createGain();
    this.cockpitBus.gain.value = 0.8;
    this.cockpitBus.connect(this.master);
    this.ui = ctx.createGain();
    this.ui.gain.value = 0.7;
    this.ui.connect(this.master);
    // A dark reverb for impacts: sounds send to it after their distance falloff.
    this.reverb = ctx.createGain();
    this.reverb.gain.value = 0.6;
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse(ctx, 0.9, 0.16);
    this.reverb.connect(convolver).connect(this.master);
    this.white = buffer(ctx, () => Math.random() * 2 - 1);
    let last = 0;
    this.brown = buffer(ctx, () => (last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02) * 3.5);
    this.applyVolume();
    this.loops = { own: this.loop(null), remote: Array.from({ length: THRUST_SLOTS }, () => this.loop(ctx.createPanner())) };
    this.jets = Array.from({ length: EXHAUST_SLOTS }, () => this.jet(ctx.createPanner()));
    this.remoteThrust = new Map();
    this.cockpitLoops();
  }

  get running() {
    return this.ctx?.state === 'running';
  }

  setVolume(v) {
    this.volume = v;
    this.applyVolume();
  }

  setMuted(m) {
    this.muted = m;
    this.applyVolume();
  }

  applyVolume() {
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
  }

  /** Puts the listener at `camera`, facing where it looks. */
  listen(camera) {
    if (!this.running) return;
    const l = this.ctx.listener, p = camera.position, e = camera.matrixWorld.elements;
    this.listener = { x: p.x, y: p.y, z: p.z };
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(p.x, t);
      l.positionY.setValueAtTime(p.y, t);
      l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(-e[8], t);
      l.forwardY.setValueAtTime(-e[9], t);
      l.forwardZ.setValueAtTime(-e[10], t);
      l.upX.setValueAtTime(e[4], t);
      l.upY.setValueAtTime(e[5], t);
      l.upZ.setValueAtTime(e[6], t);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(-e[8], -e[9], -e[10], e[4], e[5], e[6]);
    }
  }

  // --- Building blocks ---------------------------------------------------------------------

  /**
   * A one-shot's output node: at `pos` in 3D through the hull filter, or, for our own mech
   * (`pos` null), flat and clear on the cockpit bus; `bus` overrides (UI). Null when the sound
   * should be skipped (no audio, too far, too many voices). `life` is its length in s.
   */
  voice(pos, life, bus = pos ? this.world : this.cockpitBus, send = 0) {
    if (!this.running) return null;
    if (pos) {
      const l = this.listener;
      if (Math.hypot(pos.x - l.x, pos.y - l.y, pos.z - l.z) > MAX_DISTANCE || this.voices >= MAX_VOICES) return null;
    }
    const out = this.ctx.createGain();
    let tap = out;
    if (pos) {
      tap = this.panner(pos);
      out.connect(tap).connect(bus);
    } else {
      out.connect(bus);
    }
    if (send > 0) {
      // Reverb send, taken after the distance falloff.
      const level = this.ctx.createGain();
      level.gain.value = send;
      tap.connect(level).connect(this.reverb);
      setTimeout(() => level.disconnect(), (life + 0.1) * 1000);
    }
    // Only world (3D) sounds count toward the cap; our own and UI sounds always play.
    if (pos) this.voices++;
    setTimeout(() => {
      if (pos) this.voices--;
      out.disconnect();
    }, (life + 0.1) * 1000);
    return out;
  }

  panner(pos) {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 8;
    p.maxDistance = 400;
    p.rolloffFactor = 1;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    return p;
  }

  /**
   * Noise (`white` or `brown`) through a filter of `type` sweeping `f0` to `f1`, with an
   * envelope; `delay` s after now.
   */
  noise(out, kind, type, f0, f1, attack, decay, peak, q = 1, delay = 0) {
    const { ctx } = this, t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this[kind];
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t);
    filter.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
    const g = envelope(ctx, t, attack, decay, peak);
    src.connect(filter).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + decay + 0.05);
  }

  /** An oscillator gliding `f0` to `f1`, with an envelope; `delay` s after now. */
  tone(out, wave, f0, f1, attack, decay, peak, delay = 0) {
    const { ctx } = this, t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
    const g = envelope(ctx, t, attack, decay, peak);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  /** An oscillator gliding `f0` to `f1` through a low-pass at `cutoff`, with an envelope. */
  growl(out, wave, f0, f1, cutoff, attack, decay, peak, delay = 0) {
    const { ctx } = this, t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const g = envelope(ctx, t, attack, decay, peak);
    osc.connect(filter).connect(g).connect(out);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  // --- Cues -------------------------------------------------------------------------------------

  /**
   * A primary shot with weapons.json `sound` at `pos` (null: ours, clear on the cockpit bus;
   * others are heard through the hull). Each is a broadband report, a low punch, a body, and the
   * weapon's mechanical action; no high ringing, which is what reads as a plink.
   */
  shot(sound, pos) {
    const out = this.voice(pos, 0.6); // no reverb: at fire rate it smears into a wash
    if (!out) return;
    out.gain.value = pos ? 1.2 : 0.9;
    if (sound === 'vulcan') {
      // Submachine cannon: a sharp report, a short thump, and the bolt cycling right after.
      this.noise(out, 'white', 'highpass', 1400, 900, 0.001, 0.045, 0.85);
      this.noise(out, 'white', 'lowpass', 3500, 900, 0.001, 0.03, 0.35);
      this.tone(out, 'sine', 150, 60, 0.002, 0.07, 0.6);
      this.noise(out, 'brown', 'lowpass', 900, 200, 0.002, 0.08, 0.35);
      this.noise(out, 'white', 'bandpass', 650, 550, 0.001, 0.03, 0.22, 2, 0.028);
    } else if (sound === 'shotgun') {
      // Shotgun: a hard, bright crack with little boom under it, then the pump racking quick.
      this.noise(out, 'white', 'highpass', 3200, 1800, 0.0005, 0.025, 1.0);
      this.noise(out, 'white', 'highpass', 1300, 700, 0.001, 0.06, 0.85);
      this.noise(out, 'white', 'lowpass', 4200, 1200, 0.001, 0.035, 0.45);
      this.tone(out, 'sine', 140, 52, 0.002, 0.12, 0.8);
      this.noise(out, 'brown', 'lowpass', 1300, 220, 0.002, 0.1, 0.4);
      this.noise(out, 'white', 'bandpass', 900, 700, 0.001, 0.03, 0.3, 2.5, 0.16);
      this.noise(out, 'white', 'bandpass', 620, 520, 0.001, 0.04, 0.32, 2.5, 0.24);
    } else if (sound === 'flak') {
      // Flak cannon: a loud, sharp report, a deep boom and rumble, then the breech racking.
      this.noise(out, 'white', 'highpass', 700, 400, 0.001, 0.1, 1.0);
      this.noise(out, 'white', 'lowpass', 3000, 700, 0.001, 0.06, 0.5);
      this.tone(out, 'sine', 95, 34, 0.002, 0.3, 1.0);
      this.noise(out, 'brown', 'lowpass', 1100, 120, 0.002, 0.35, 0.8);
      this.noise(out, 'white', 'bandpass', 480, 420, 0.002, 0.04, 0.3, 2, 0.2);
      this.noise(out, 'white', 'bandpass', 330, 300, 0.002, 0.05, 0.3, 2, 0.29);
    } else if (sound === 'rotary') {
      // Rotary cannon: a light, quick report and a tick of the turning barrels; at full spin they
      // run together into a roar.
      this.noise(out, 'white', 'highpass', 1800, 1100, 0.001, 0.03, 0.6);
      this.tone(out, 'sine', 170, 80, 0.001, 0.05, 0.45);
      this.noise(out, 'brown', 'lowpass', 800, 200, 0.002, 0.05, 0.25);
    } else if (sound === 'burst') {
      // Burst rifle: a crisp, tight crack with a short body; three come close together.
      this.noise(out, 'white', 'highpass', 1500, 900, 0.001, 0.04, 0.9);
      this.noise(out, 'white', 'lowpass', 3400, 800, 0.001, 0.03, 0.35);
      this.tone(out, 'sine', 140, 55, 0.002, 0.1, 0.7);
      this.noise(out, 'brown', 'lowpass', 900, 160, 0.002, 0.1, 0.35);
    } else if (sound === 'rail') {
      // Charge cannon: a heavy slam and deep boom, and the coils' discharge zapping down.
      this.noise(out, 'white', 'highpass', 600, 300, 0.001, 0.12, 1.0);
      this.tone(out, 'sine', 80, 28, 0.002, 0.4, 1.0);
      this.tone(out, 'sawtooth', 900, 160, 0.002, 0.18, 0.18);
      this.noise(out, 'brown', 'lowpass', 1000, 120, 0.002, 0.4, 0.7);
    } else {
      // Rifle: a heavier report with a longer, deeper body and a slower action.
      this.noise(out, 'white', 'highpass', 1000, 600, 0.001, 0.07, 0.95);
      this.noise(out, 'white', 'lowpass', 3200, 800, 0.001, 0.04, 0.4);
      this.tone(out, 'sine', 125, 42, 0.002, 0.16, 0.85);
      this.noise(out, 'brown', 'lowpass', 1000, 150, 0.002, 0.18, 0.5);
      this.noise(out, 'white', 'bandpass', 520, 460, 0.001, 0.035, 0.22, 2, 0.045);
    }
  }

  /**
   * Secondary fire with weapons.json `sound` leaving its launcher; the mortar adds a hollow knock.
   * A flak volley booms like a gun instead, a rail slug cracks like a sniper's rifle, and a mine is
   * dispensed rather than launched.
   */
  launch(sound, pos) {
    if (sound === 'flak') return this.shot(sound, pos);
    if (sound === 'spindle') {
      // Rail gun: a thunderclap close by, a high, sharp crack that tears for a moment (two quick
      // aftercracks) and echoes, over a boom and a rolling rumble, the rails' discharge whining down.
      const out = this.voice(pos, 0.9, undefined, 0.35);
      if (!out) return;
      out.gain.value = pos ? 1.9 : 1.4;
      this.noise(out, 'white', 'highpass', 6500, 3500, 0.0003, 0.02, 1.0);
      this.noise(out, 'white', 'highpass', 2600, 1200, 0.0005, 0.08, 1.0);
      this.noise(out, 'white', 'lowpass', 8000, 2200, 0.0005, 0.05, 0.6);
      this.noise(out, 'white', 'highpass', 3800, 2400, 0.0003, 0.015, 0.55, 1, 0.018);
      this.noise(out, 'white', 'highpass', 3200, 2000, 0.0003, 0.02, 0.4, 1, 0.042);
      this.tone(out, 'sine', 170, 55, 0.002, 0.3, 0.85);
      this.noise(out, 'brown', 'lowpass', 1400, 120, 0.002, 0.55, 0.75);
      this.tone(out, 'sawtooth', 1600, 320, 0.001, 0.14, 0.15);
      return;
    }
    const out = this.voice(pos, 0.5);
    if (!out) return;
    out.gain.value = pos ? 1 : 0.6;
    if (sound === 'mines') {
      // Mine layer, all steel: the magazine clacks a mine into the chute (a sharp clack, ringing
      // inharmonic partials and a hollow knock), then the spring catches and kicks it out.
      this.noise(out, 'white', 'bandpass', 2600, 2200, 0.001, 0.03, 0.7, 4);
      this.tone(out, 'triangle', 880, 820, 0.001, 0.16, 0.35);
      this.tone(out, 'sine', 1970, 1930, 0.001, 0.22, 0.12);
      this.tone(out, 'square', 3150, 3100, 0.001, 0.05, 0.04);
      this.tone(out, 'sine', 210, 120, 0.001, 0.09, 0.45);
      this.noise(out, 'white', 'bandpass', 1500, 1100, 0.001, 0.025, 0.4, 5, 0.07);
      this.tone(out, 'sawtooth', 520, 300, 0.002, 0.12, 0.08, 0.07);
      return;
    }
    this.noise(out, 'white', 'bandpass', 400, 2600, 0.01, 0.36, 0.5, 1.5);
    this.tone(out, 'sine', 120, 55, 0.003, 0.16, 0.5);
    if (sound === 'mortar') this.tone(out, 'triangle', 190, 120, 0.002, 0.12, 0.45);
    if (sound === 'furnace') this.noise(out, 'brown', 'lowpass', 600, 120, 0.01, 0.5, 0.7);
    if (sound === 'hornet') this.noise(out, 'white', 'bandpass', 1800, 3000, 0.005, 0.25, 0.4, 2);
  }

  /** A burst of radius `radius` m at `pos`: a deep boom and rumble (the hull filter softens it). */
  blast(radius, pos) {
    const size = Math.min(Math.max(radius / 4, 0.4), 2);
    const life = 0.55 + 0.4 * size;
    const out = this.voice(pos, life + 0.3, undefined, 0.2);
    if (!out) return;
    this.noise(out, 'brown', 'lowpass', 900, 90, 0.005, life, Math.min(0.7 + 0.3 * size, 1.3));
    this.tone(out, 'sine', 56, 19, 0.005, life + 0.2, Math.min(0.6 + 0.35 * size, 1.2));
    this.noise(out, 'white', 'lowpass', 2200, 600, 0.002, 0.1, 0.3 * size);
  }

  /** A mech destroyed: a big blast and a metal crunch. */
  death(pos) {
    this.blast(8, pos);
    const out = this.voice(pos, 0.5);
    if (out) this.noise(out, 'white', 'bandpass', 1400, 400, 0.01, 0.4, 0.4, 2);
  }

  /** Our shot or splash landed: a soft, mid "tss" rather than a plink. */
  hitConfirm() {
    const out = this.voice(null, 0.1, this.ui);
    if (!out) return;
    this.noise(out, 'white', 'bandpass', 2600, 1900, 0.001, 0.045, 0.45, 1.4);
    this.tone(out, 'triangle', 820, 700, 0.001, 0.035, 0.07);
  }

  /** We were hit: a clang, a thud, and the world briefly muffled. */
  hurt() {
    const out = this.voice(null, 0.3, this.cockpitBus);
    if (!out) return;
    this.noise(out, 'white', 'bandpass', 950, 700, 0.002, 0.16, 0.5, 4);
    this.tone(out, 'square', 75, 40, 0.002, 0.12, 0.18);
    const f = this.muffle.frequency, t = this.ctx.currentTime;
    f.cancelScheduledValues(t);
    f.setValueAtTime(700, t);
    f.setTargetAtTime(COCKPIT_CUTOFF, t + 0.05, 0.12);
  }

  /**
   * A stomp by class `cls`: the foot's contact crack, a thick sub-bass body with a chest punch, a
   * low ground rumble, a dull hydraulic clunk, then the frame settling a beat later. Heavier
   * mechs are lower, longer and louder.
   */
  step(cls, pos) {
    const d = STEP_DEPTH[cls] ?? 1.5;
    const out = this.voice(pos, 0.9, undefined, 0.12);
    if (!out) return;
    out.gain.value = pos ? 1.1 : 1;
    this.noise(out, 'white', 'lowpass', 1600 / Math.sqrt(d), 260, 0.001, 0.03, 0.55);
    this.tone(out, 'sine', 72 / d ** 0.6, 34 / d ** 0.3, 0.002, 0.22 * d, 0.95 * Math.sqrt(d));
    this.tone(out, 'sine', 125 / Math.sqrt(d), 55 / Math.sqrt(d), 0.001, 0.08, 0.5 * Math.sqrt(d));
    this.noise(out, 'brown', 'lowpass', 320 / Math.sqrt(d), 55, 0.004, 0.3 * d, 0.65 * d);
    this.noise(out, 'white', 'bandpass', 260 / Math.sqrt(d), 220 / Math.sqrt(d), 0.002, 0.05, 0.2, 3);
    this.tone(out, 'sine', 66 / d ** 0.6, 32 / d ** 0.3, 0.004, 0.1 * d, 0.3 * d, 0.04);
  }

  /**
   * Coming down after `air` s in the air: a short, dense thud (no ringing or long boom), bigger
   * the longer the fall.
   */
  land(cls, pos, air) {
    const w = WEIGHT[cls] ?? 1, k = Math.min(air / 1.2, 1.5) + 0.5;
    const out = this.voice(pos, 0.7, undefined, 0.3);
    if (!out) return;
    out.gain.value = pos ? 1 : 0.9;
    this.noise(out, 'brown', 'lowpass', 520, 80, 0.002, 0.16 * k, 1.0 * k);
    this.tone(out, 'sine', 88, 40, 0.002, 0.11 * k, 0.8 * k * Math.sqrt(w));
    this.tone(out, 'triangle', 120, 60, 0.001, 0.05, 0.35);
    this.noise(out, 'white', 'lowpass', 2000, 900, 0.001, 0.04, 0.2);
  }

  /** Thrusters lighting for a boost: a mechanical clunk and a deep turbine spin-up under a low air rush. */
  ignite(cls, pos) {
    const w = WEIGHT[cls] ?? 1;
    const out = this.voice(pos, 0.6);
    if (!out) return;
    out.gain.value = pos ? 1 : 0.8;
    this.tone(out, 'triangle', 60 / Math.sqrt(w), 38, 0.002, 0.09, 0.35);
    this.growl(out, 'sawtooth', 38, 92, 420, 0.04, 0.38, 0.22);
    this.noise(out, 'brown', 'lowpass', 650, 240, 0.02, 0.3, 0.55);
  }

  /** A jump pad firing: a deep magnetic thump under a rush of air sweeping up. */
  pad(pos) {
    const out = this.voice(pos, 1.1, undefined, 0.35);
    if (!out) return;
    out.gain.value = pos ? 1 : 0.9;
    // The piston: a heavy thunk with a metal clank on top.
    this.tone(out, 'sine', 90, 36, 0.002, 0.24, 1.0);
    this.tone(out, 'triangle', 170, 70, 0.001, 0.06, 0.4);
    // The pneumatic release: a sharp hiss falling as the pressure drains, and the rush of air under it.
    this.noise(out, 'white', 'highpass', 3200, 900, 0.003, 0.42, 0.75);
    this.noise(out, 'white', 'bandpass', 1800, 380, 0.01, 0.6, 0.5, 0.8);
    // The energy: a charge zinging up, and the exhaust settling after.
    this.growl(out, 'sawtooth', 70, 300, 900, 0.02, 0.45, 0.16);
    this.tone(out, 'sine', 900, 1900, 0.01, 0.22, 0.05);
    this.noise(out, 'brown', 'lowpass', 420, 110, 0.02, 0.8, 0.45, 1, 0.05);
  }

  /**
   * A shell or grenade bouncing off something hard at `speed` m/s: a metallic clank, inharmonic
   * partials over a short knock, pitched up for a (lighter) grenade.
   */
  clank(pos, speed, light) {
    const out = this.voice(pos, 0.45, undefined, 0.25);
    if (!out) return;
    const k = Math.min(speed / 20, 1.2) + 0.2, f = light ? 1.5 : 1;
    this.tone(out, 'triangle', 620 * f, 560 * f, 0.001, 0.2, 0.3 * k);
    this.tone(out, 'square', 1340 * f, 1250 * f, 0.001, 0.07, 0.07 * k);
    this.tone(out, 'sine', 2290 * f, 2240 * f, 0.001, 0.28, 0.06 * k);
    this.noise(out, 'white', 'bandpass', 3200 * f, 1800 * f, 0.001, 0.04, 0.4 * k, 3);
    this.tone(out, 'sine', 170 * f, 90, 0.001, 0.08, 0.35 * k);
  }

  /** A dash: the mech skids sideways, so a low grinding scrape and a skid rumble, not a hiss. */
  dash(pos) {
    const out = this.voice(pos, 0.5);
    if (!out) return;
    out.gain.value = pos ? 1 : 0.8;
    this.noise(out, 'white', 'bandpass', 380, 210, 0.01, 0.36, 0.7, 6);
    this.noise(out, 'white', 'bandpass', 950, 700, 0.01, 0.24, 0.16, 8);
    this.noise(out, 'brown', 'lowpass', 320, 120, 0.01, 0.32, 0.6);
    this.tone(out, 'sine', 70, 34, 0.004, 0.16, 0.4);
  }

  /** Class ability cue: Vent hiss (B), Speed boost surge (A), Bulwark clunk (C). */
  ability(cls, pos) {
    const out = this.voice(pos, 0.9);
    if (!out) return;
    if (cls === 'B') {
      this.noise(out, 'white', 'highpass', 2500, 1200, 0.03, 0.8, 0.35);
    } else if (cls === 'A') {
      this.noise(out, 'white', 'bandpass', 600, 3200, 0.05, 0.45, 0.4, 1.5);
      this.tone(out, 'sawtooth', 180, 640, 0.05, 0.4, 0.06);
    } else {
      this.tone(out, 'square', 70, 50, 0.002, 0.09, 0.25);
      this.noise(out, 'brown', 'lowpass', 600, 200, 0.004, 0.2, 0.6);
      this.tone(out, 'sine', 160, 90, 0.01, 0.25, 0.3, 0.06);
    }
  }

  /** A grenade thrown. */
  grenade(pos) {
    const out = this.voice(pos, 0.3);
    if (!out) return;
    this.tone(out, 'sine', 230, 120, 0.003, 0.09, 0.45);
    this.noise(out, 'white', 'bandpass', 900, 600, 0.003, 0.07, 0.2, 2);
  }

  /** A smoke grenade bursting: a long, soft hiss. */
  smoke(pos) {
    const out = this.voice(pos, 1.6, undefined, 0.3);
    if (!out) return;
    this.noise(out, 'white', 'bandpass', 2400, 700, 0.02, 1.4, 0.45, 0.7);
    this.noise(out, 'brown', 'lowpass', 500, 200, 0.01, 0.5, 0.4);
  }

  /** A dome or barrier going up: a heavy clunk, then a field humming up to strength. */
  deploy(pos) {
    const out = this.voice(pos, 1.0, undefined, 0.3);
    if (!out) return;
    this.tone(out, 'square', 80, 55, 0.002, 0.12, 0.3);
    this.noise(out, 'brown', 'lowpass', 500, 180, 0.003, 0.2, 0.5);
    this.growl(out, 'sawtooth', 60, 240, 700, 0.05, 0.8, 0.12, 0.05);
    this.tone(out, 'sine', 300, 600, 0.05, 0.7, 0.08, 0.05);
  }

  /** A repair orb dropped: a soft rising chime. */
  salve(pos) {
    const out = this.voice(pos, 0.8);
    if (!out) return;
    this.tone(out, 'sine', 520, 1040, 0.01, 0.5, 0.25);
    this.tone(out, 'triangle', 780, 1560, 0.01, 0.35, 0.08, 0.06);
  }

  /** An EMP: a falling zap with crackle. */
  emp(pos) {
    const out = this.voice(pos, 0.7);
    if (!out) return;
    this.tone(out, 'sawtooth', 1400, 70, 0.005, 0.55, 0.18);
    this.noise(out, 'white', 'highpass', 5000, 2000, 0.005, 0.4, 0.25);
  }

  /** We scored a kill: a rising two-note chime. */
  kill() {
    const out = this.voice(null, 0.4, this.ui);
    if (!out) return;
    this.tone(out, 'triangle', 660, 660, 0.005, 0.12, 0.25);
    this.tone(out, 'triangle', 990, 990, 0.005, 0.2, 0.25, 0.1);
  }

  /** We were destroyed: a low falling tone. */
  died() {
    const out = this.voice(null, 1, this.ui);
    if (out) this.tone(out, 'sine', 320, 70, 0.01, 0.8, 0.3);
  }

  // --- Loops ------------------------------------------------------------------------------------

  /**
   * A thruster loop: low air roar (brown noise through a low-pass) over a sub rumble, silent
   * until driven; 3D when given a panner.
   */
  loop(panner) {
    const { ctx } = this;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain);
    const sub = ctx.createOscillator();
    sub.frequency.value = 42;
    const subGain = ctx.createGain();
    subGain.gain.value = 0;
    sub.connect(subGain).connect(gain);
    sub.start();
    if (panner) {
      Object.assign(panner, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 8, maxDistance: 400 });
      gain.connect(panner).connect(this.world);
    } else {
      gain.connect(this.cockpitBus);
    }
    src.start();
    return { filter, gain, subGain, panner };
  }

  /** Drives a loop toward `level`: 0 off, 1 hover (deep rumble), 2 boost (heavier roar). */
  drive(l, level, loud) {
    const t = this.ctx.currentTime;
    l.gain.gain.setTargetAtTime([0, 0.4, 0.55][level] * loud, t, 0.06);
    l.filter.frequency.setTargetAtTime(level === 2 ? 520 : 300, t, 0.08);
    l.subGain.gain.setTargetAtTime([0, 0.25, 0.35][level], t, 0.08);
  }

  /**
   * Thrusters this frame: ours at `own` (0/1/2), and others as [{ x, y, z, level }]; the nearest
   * few get loops that follow them.
   */
  thrusters(own, others) {
    if (!this.running) return;
    this.drive(this.loops.own, own, 1);
    const l = this.listener;
    const near = others.filter((o) => o.level > 0).sort((a, b) => dist2(a, l) - dist2(b, l)).slice(0, THRUST_SLOTS);
    this.loops.remote.forEach((loop, i) => {
      const o = near[i];
      this.drive(loop, o ? o.level : 0, 1);
      if (!o) return;
      const t = this.ctx.currentTime;
      if (loop.panner.positionX) {
        loop.panner.positionX.setTargetAtTime(o.x, t, 0.02);
        loop.panner.positionY.setTargetAtTime(o.y, t, 0.02);
        loop.panner.positionZ.setTargetAtTime(o.z, t, 0.02);
      } else {
        loop.panner.setPosition(o.x, o.y, o.z);
      }
    });
  }

  /** A projectile's exhaust: a hissing roar through a band-pass over a low rumble, silent until driven. */
  jet(panner) {
    const { ctx } = this;
    const hiss = ctx.createBufferSource(), roar = ctx.createBufferSource();
    hiss.buffer = this.white;
    roar.buffer = this.brown;
    hiss.loop = roar.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.9;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 280;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    hiss.connect(band).connect(gain);
    roar.connect(low).connect(gain);
    Object.assign(panner, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 6, maxDistance: 300 });
    gain.connect(panner).connect(this.world);
    hiss.start(0, Math.random());
    roar.start(0, Math.random());
    return { band, gain, panner };
  }

  /** Rockets and darts in flight this frame, as [{ x, y, z, dart }]: the nearest few roar along with them. */
  exhausts(list) {
    if (!this.running) return;
    const l = this.listener, t = this.ctx.currentTime;
    const near = list.sort((a, b) => dist2(a, l) - dist2(b, l)).slice(0, EXHAUST_SLOTS);
    this.jets.forEach((jet, i) => {
      const o = near[i];
      jet.gain.gain.setTargetAtTime(o ? (o.dart ? 0.2 : 0.55) : 0, t, o ? 0.02 : 0.06);
      if (!o) return;
      jet.band.frequency.setTargetAtTime(o.dart ? 2600 : 1100, t, 0.02);
      if (jet.panner.positionX) {
        jet.panner.positionX.setTargetAtTime(o.x, t, 0.01);
        jet.panner.positionY.setTargetAtTime(o.y, t, 0.01);
        jet.panner.positionZ.setTargetAtTime(o.z, t, 0.01);
      } else {
        jet.panner.setPosition(o.x, o.y, o.z);
      }
    });
  }

  /** The repair drone's whir and the Gatling's spool; built once on unlock. */
  cockpitLoops() {
    const { ctx } = this;
    const whir = ctx.createOscillator();
    whir.type = 'triangle';
    whir.frequency.value = 340;
    const whirGain = ctx.createGain();
    whirGain.gain.value = 0;
    whir.connect(whirGain).connect(this.cockpitBus);
    whir.start();
    // The spool: a sawtooth and a sine a shade over an octave up (a slow beat between them),
    // through a low-pass that opens with the pitch.
    const spoolFilter = ctx.createBiquadFilter();
    spoolFilter.type = 'lowpass';
    const spoolGain = ctx.createGain();
    spoolGain.gain.value = 0;
    spoolFilter.connect(spoolGain).connect(this.cockpitBus);
    const spool = [['sawtooth', 1], ['sine', 2.02]].map(([type, mult]) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.connect(spoolFilter);
      osc.start();
      return { osc, mult };
    });
    this.cockpitNodes = { whir, whirGain, spool, spoolFilter, spoolGain };
  }

  /**
   * Each frame: { alive, heat (0-1), overheated, hull (0-1), repairing (0-1 phase), jammed, beaming,
   * spin (0-1), incoming (m, or null), lock (0-1) }. Drives the repair whir (higher and softer for a
   * held beam) and the Gatling's spool, rising from a low hum to a high whine as the barrels spin up,
   * and paces warning beeps, the missile alarm and the lock tones.
   */
  cockpit(s, dt) {
    if (!this.running) return;
    const n = this.cockpitNodes, t = this.ctx.currentTime;
    n.whir.frequency.setTargetAtTime(s.repairing >= 1 ? 420 : s.beaming ? 560 : 300, t, 0.2);
    n.whirGain.gain.setTargetAtTime(s.repairing > 0 ? 0.05 : s.beaming ? 0.035 : 0, t, 0.1);
    const spin = s.alive ? s.spin : 0, f = 140 + 460 * spin;
    for (const { osc, mult } of n.spool) osc.frequency.setTargetAtTime(f * mult, t, 0.05);
    n.spoolFilter.frequency.setTargetAtTime(f * 3, t, 0.05);
    n.spoolGain.gain.setTargetAtTime(0.02 * Math.sqrt(spin), t, 0.05);
    if (!s.alive) return;
    // Warnings: a burst of fast alarm beeps as we overheat (then quiet through the cooldown),
    // soft beeps while running hot, a low-hull pulse, jam crackle.
    this.timers.heat -= dt;
    this.timers.hull -= dt;
    if (s.overheated && !this.overheated) {
      const out = this.voice(null, 0.5, this.ui);
      if (out) for (let i = 0; i < 4; i++) this.tone(out, 'square', 1100, 1100, 0.002, 0.045, 0.09, i * 0.085);
    }
    this.overheated = s.overheated;
    if (!s.overheated && s.heat > 0.8 && this.timers.heat <= 0) {
      this.timers.heat = 0.6;
      const out = this.voice(null, 0.1, this.ui);
      if (out) this.tone(out, 'square', 1000, 1000, 0.002, 0.05, 0.06);
    }
    if (s.hull < 0.3 && this.timers.hull <= 0) {
      this.timers.hull = 1.2;
      const out = this.voice(null, 0.4, this.ui);
      if (out) this.tone(out, 'sine', 440, 430, 0.01, 0.25, 0.12);
    }
    // Missiles locked on us (`incoming`, m to the nearest; null for none): a two-tone alarm,
    // quicker the closer they are.
    this.timers.missile -= dt;
    if (s.incoming !== null && this.timers.missile <= 0) {
      this.timers.missile = Math.min(Math.max(s.incoming / 80, 0.1), 0.45);
      const out = this.voice(null, 0.2, this.ui);
      if (out) {
        this.tone(out, 'square', 1500, 1500, 0.002, 0.05, 0.11);
        this.tone(out, 'square', 1150, 1150, 0.002, 0.05, 0.11, 0.06);
      }
    }
    // Our own lock (`lock`, 0 to 1 made; 0 for none): quick pips climbing while it locks, then a
    // bright rising chirp once it's made.
    this.timers.seek -= dt;
    if (s.lock > 0 && s.lock < 1 && this.timers.seek <= 0) {
      this.timers.seek = 0.07;
      const out = this.voice(null, 0.1, this.ui);
      if (out) this.tone(out, 'sine', 900 + 600 * s.lock, 900 + 600 * s.lock, 0.002, 0.03, 0.09);
    }
    if (s.lock >= 1 && !this.lockMade) {
      const out = this.voice(null, 0.3, this.ui);
      if (out) {
        this.tone(out, 'sine', 1700, 1700, 0.002, 0.06, 0.12);
        this.tone(out, 'sine', 2300, 2300, 0.002, 0.12, 0.12, 0.07);
      }
    }
    this.lockMade = s.lock >= 1;
    if (s.jammed && Math.random() < dt * 8) {
      const out = this.voice(null, 0.1, this.cockpitBus);
      if (out) this.noise(out, 'white', 'highpass', 3000, 2500, 0.001, 0.04, 0.15);
    }
  }
}

/** A one-second mono buffer filled by `sample()`. */
function buffer(ctx, sample) {
  const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = sample();
  return b;
}

/**
 * A stereo reverb impulse `seconds` long: darkened noise decaying with time constant `tau`, a
 * little different per ear for width.
 */
function impulse(ctx, seconds, tau) {
  const n = Math.round(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let y = 0;
    for (let i = 0; i < n; i++) {
      y += 0.3 * (Math.random() * 2 - 1 - y); // one-pole low-pass: a dark tail
      d[i] = y * Math.exp(-i / ctx.sampleRate / tau);
    }
  }
  return b;
}

/** A gain that rises to `peak` over `attack` s and falls away over `decay` s, from time `t`. */
function envelope(ctx, t, attack, decay, peak) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
