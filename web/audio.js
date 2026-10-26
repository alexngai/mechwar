// Synthesized sound: every cue is a few oscillators and noise bursts through filters and gain
// envelopes, built per play and freed when done. No files to download, all original.
// World sounds sit in 3D at their source; our own mech's play flat, as heard from the cockpit.

const MAX_VOICES = 24; // world (3D) one-shots at once; past that, new ones are dropped
const MAX_DISTANCE = 150; // m: farther world sounds aren't started
const THRUST_SLOTS = 3; // remote thruster loops, for the nearest boosting or hovering mechs
const EXHAUST_SLOTS = 4; // exhaust loops, for the nearest rockets and darts in flight
const WEIGHT = { A: 0.65, B: 1, C: 1.5 }; // shot and landing heft by class
const STEP_DEPTH = { A: 1, B: 1.5, C: 2.1, hauler: 3 }; // footsteps: even the Light stomps; the Heavy shakes the ground, Convoy's hauler more
// Primary shots past the usual level, reverb and length (0.6 s). Fast guns stay dry: at their
// fire rate reverb smears into a wash. The slow, heavy ones ring out, and hit about as hard as
// the rail gun; the HEAT cannon's boom rolls on longest.
const SHOT_MIX = { shotgun: { gain: 1.35, send: 0.3 }, flak: { send: 0.15 }, rail: { gain: 1.1, send: 0.35, life: 1 } };
// Outside sounds reach us through the cockpit's armor: highs cut, low body lifted.
const COCKPIT_CUTOFF = 2400; // Hz
// Under camouflage everything, our own mech and cockpit too, sounds muffled (`stealth`).
const STEALTH_CUTOFF = 800; // Hz
const OPEN_CUTOFF = 20000; // Hz: the filter's off
// Ambience is heard through the hull too, but less dulled than the action (crickets, rain hiss).
const AMBIENCE_CUTOFF = 5500; // Hz
const AMBIENCE_LEVEL = 0.45; // all of it, against the action
/**
 * Each map's ambience (its palette's `ambience`): a quiet bed under everything, and sparse accents
 * at random intervals, each panned somewhere random. Beds are [kind, level, ...shape]; accents are
 * [kind, every [lo, hi] s, level]; `gain` trims the whole (measured: storms and machinery about
 * -39 dB, quiet places about -45, a blast 12 m off -22). See `bed` and `accent` for the kinds.
 */
const AMBIENCE = {
  reactor: { gain: 1.3, beds: [['hum', 0.035, [60, 120.3, 180]], ['wind', 0.03, 500, 0.6]], accents: [['geiger', [2, 7], 0.05], ['steam', [9, 20], 0.05], ['clank', [10, 22], 0.035], ['siren', [45, 90], 0.02]] },
  foundry: { gain: 1.2, beds: [['roar', 0.06], ['hum', 0.035, [48, 96.4, 144]]], accents: [['clank', [3, 8], 0.06], ['steam', [6, 14], 0.05], ['rumble', [15, 30], 0.07]] },
  acidrain: { gain: 1.15, beds: [['rain', 0.05, 2500], ['hum', 0.02, [62, 124.6]]], accents: [['patter', [0.3, 1.2], 0.03], ['siren', [25, 50], 0.025]] },
  canyon: { gain: 1.5, beds: [['wind', 0.06, 320, 2.5], ['hum', 0.025, [73.4, 74.1, 110]]], accents: [['rumble', [12, 25], 0.06], ['moan', [18, 35], 0.03]] },
  undercity: { beds: [['water', 0.05], ['hum', 0.03, [50, 100.3]]], accents: [['drip', [0.4, 1.6], 0.06], ['creak', [14, 28], 0.04]] },
  quarry: { gain: 1.3, beds: [['wind', 0.07, 650, 0.9], ['hum', 0.025, [41, 82.3]]], accents: [['rumble', [16, 34], 0.08], ['clank', [6, 14], 0.04], ['creak', [12, 24], 0.035], ['siren', [50, 90], 0.02]] },
  grove: { gain: 1.2, beds: [['wind', 0.03, 900, 0.6], ['hum', 0.012, [55, 55.35, 82.4]]], accents: [['moan', [25, 50], 0.018], ['creak', [16, 32], 0.025], ['hoot', [30, 60], 0.02]] },
  storm: { gain: 1.2, beds: [['rain', 0.07, 1800], ['wind', 0.05, 450, 1]], accents: [['croak', [3, 8], 0.035], ['creak', [8, 18], 0.05]] },
  desert: { gain: 1.2, beds: [['wind', 0.1, 900, 0.8], ['wind', 0.06, 3200, 1.2]], accents: [['whistle', [15, 35], 0.025]] },
  blizzard: { gain: 1.9, beds: [['howl', 0.12, 600], ['wind', 0.07, 2400, 0.7]], accents: [['creak', [12, 24], 0.035]] },
  // Hivewall: wind up the canyon, the flooded mines below, the Bloom's machines droning on.
  hive: { gain: 1.3, beds: [['wind', 0.045, 380, 2], ['water', 0.03], ['hum', 0.03, [55, 82.6, 110.3]]], accents: [['drip', [0.6, 2], 0.045], ['moan', [14, 30], 0.035], ['clank', [6, 14], 0.04], ['creak', [10, 22], 0.035], ['rumble', [18, 36], 0.06], ['siren', [60, 110], 0.018]] },
};

export class Sound {
  constructor() {
    this.ctx = null;
    this.voices = 0;
    this.volume = 0.8;
    this.muted = false;
    this.listener = { x: 0, y: 0, z: 0 };
    this.timers = { heat: 0, hull: 0, missile: 0 };
    this.overheated = false;
    this.lockStep = -1;
    this.lockMade = false;
    // A storm's sky (web/sky.js) says when its lightning strikes.
    addEventListener('thunder', (e) => this.thunder(e.detail.delay, e.detail.close));
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
    this.veil = ctx.createBiquadFilter();
    this.veil.type = 'lowpass';
    this.veil.frequency.value = OPEN_CUTOFF;
    this.master.connect(this.veil).connect(comp).connect(ctx.destination);
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
    this.ambienceOut = ctx.createGain();
    this.ambienceOut.gain.value = AMBIENCE_LEVEL;
    const dull = ctx.createBiquadFilter();
    dull.type = 'lowpass';
    dull.frequency.value = AMBIENCE_CUTOFF;
    this.ambienceOut.connect(dull).connect(this.master);
    this.long = buffer(ctx, () => Math.random() * 2 - 1, 4); // a long noise loop for beds: no audible repeat
    this.setAmbience(this.ambienceName);
    this.loops = { own: this.loop(null), remote: Array.from({ length: THRUST_SLOTS }, () => this.loop(ctx.createPanner())) };
    this.jets = Array.from({ length: EXHAUST_SLOTS }, () => this.jet(ctx.createPanner()));
    this.hulls = [0, 1].map(() => this.drone(ctx.createPanner()));
    this.gatherLoop();
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
   * weapon's mechanical action; no high ringing, which is what reads as a plink. A charged shot
   * (`charge` 0-1) goes off louder, up to 30% at full. A grenade or rocket primary launches like
   * the secondary that sounds the same.
   */
  shot(sound, pos, charge = 0) {
    if (sound === 'mortar' || sound === 'rocket') return this.launch(sound, pos);
    const mix = SHOT_MIX[sound] ?? {};
    const out = this.voice(pos, mix.life ?? 0.6, undefined, mix.send ?? 0);
    if (!out) return;
    out.gain.value = (pos ? 1.2 : 0.9) * (mix.gain ?? 1) * (1 + 0.3 * charge);
    if (sound === 'vulcan') {
      // Submachine cannon: a sharp report, a short thump, and the bolt cycling right after.
      this.noise(out, 'white', 'highpass', 1400, 900, 0.001, 0.045, 0.85);
      this.noise(out, 'white', 'lowpass', 3500, 900, 0.001, 0.03, 0.35);
      this.tone(out, 'sine', 150, 60, 0.002, 0.07, 0.6);
      this.noise(out, 'brown', 'lowpass', 900, 200, 0.002, 0.08, 0.35);
      this.noise(out, 'white', 'bandpass', 650, 550, 0.001, 0.03, 0.22, 2, 0.028);
    } else if (sound === 'shotgun') {
      // Shotgun: a high, sharp crack that tears for a moment and a hard blast, over a punch
      // sweeping down from the mid-bass (as the rail gun's does, where small speakers still play
      // it) and a deep boom and rumble rolling on behind them, then the pump racking.
      this.noise(out, 'white', 'highpass', 8500, 4500, 0.0003, 0.02, 2.8);
      this.noise(out, 'white', 'highpass', 5500, 3500, 0.0003, 0.015, 1.4, 1, 0.014);
      this.noise(out, 'white', 'highpass', 2600, 1200, 0.0005, 0.07, 1.0);
      this.noise(out, 'white', 'lowpass', 7000, 1800, 0.0005, 0.045, 0.55);
      this.tone(out, 'sine', 170, 50, 0.002, 0.22, 1.0);
      this.tone(out, 'sine', 80, 28, 0.004, 0.35, 0.9);
      this.noise(out, 'brown', 'lowpass', 1100, 100, 0.004, 0.4, 0.7);
      this.noise(out, 'white', 'bandpass', 900, 700, 0.001, 0.03, 0.3, 2.5, 0.28);
      this.noise(out, 'white', 'bandpass', 620, 520, 0.001, 0.04, 0.32, 2.5, 0.36);
    } else if (sound === 'flak') {
      // Flak cannon: a crack like the rail gun's with two quick aftercracks, a shotgun's hard
      // blast, a deep boom and rumble, then the breech racking.
      this.noise(out, 'white', 'highpass', 6500, 3500, 0.0003, 0.02, 1.8);
      this.noise(out, 'white', 'highpass', 3400, 2200, 0.0003, 0.015, 0.9, 1, 0.016);
      this.noise(out, 'white', 'highpass', 3000, 1900, 0.0003, 0.02, 0.6, 1, 0.038);
      this.noise(out, 'white', 'highpass', 1800, 700, 0.0005, 0.07, 0.9);
      this.noise(out, 'white', 'lowpass', 7000, 1400, 0.0005, 0.045, 0.5);
      this.tone(out, 'sine', 95, 34, 0.002, 0.28, 0.85);
      this.noise(out, 'brown', 'lowpass', 1100, 120, 0.002, 0.28, 0.6);
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
      // Charge cannon, fired like artillery: a sharp crack that tears for a moment and a broad
      // muzzle blast, a punch and a deep concussive boom, a rolling rumble with a slap of echo
      // off the terrain, and the coils' discharge zapping down.
      this.noise(out, 'white', 'highpass', 7500, 4000, 0.0003, 0.02, 3.0);
      this.noise(out, 'white', 'highpass', 4500, 2800, 0.0003, 0.018, 1.4, 1, 0.015);
      this.noise(out, 'white', 'highpass', 1500, 600, 0.0005, 0.09, 1.0);
      this.noise(out, 'white', 'lowpass', 6000, 1200, 0.0005, 0.06, 0.6);
      this.tone(out, 'sine', 150, 45, 0.002, 0.3, 1.0);
      this.tone(out, 'sine', 60, 24, 0.005, 0.6, 1.0);
      this.noise(out, 'brown', 'lowpass', 900, 70, 0.01, 0.75, 0.85);
      this.noise(out, 'white', 'lowpass', 2000, 500, 0.002, 0.08, 0.2, 1, 0.2);
      this.noise(out, 'brown', 'lowpass', 700, 150, 0.02, 0.35, 0.35, 1, 0.22);
      this.tone(out, 'sawtooth', 900, 160, 0.002, 0.18, 0.12);
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
   * Secondary fire with weapons.json `sound` leaving its launcher; the mortar pops from its tube.
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
    if (sound === 'mortar') {
      // Tube launcher: a deep, hollow "pwoomp" like a giant cork drawn from a bottle, with no
      // motor's whoosh. A pressure crack as the shell clears the muzzle, the tube's air column
      // ringing up in pitch, a falling hollow body and sub thump from the charge, and gas rushing
      // out after.
      const out = this.voice(pos, 0.6, undefined, 0.15);
      if (!out) return;
      out.gain.value = pos ? 1.6 : 1.2;
      this.noise(out, 'white', 'highpass', 1800, 1000, 0.0005, 0.015, 0.55);
      this.noise(out, 'white', 'lowpass', 2500, 400, 0.001, 0.05, 0.5);
      this.tone(out, 'sine', 200, 480, 0.002, 0.09, 0.6);
      this.tone(out, 'sine', 180, 95, 0.004, 0.28, 1.0);
      this.growl(out, 'sawtooth', 150, 80, 600, 0.004, 0.22, 0.35);
      this.tone(out, 'sine', 75, 38, 0.003, 0.32, 0.9);
      this.noise(out, 'white', 'bandpass', 700, 250, 0.01, 0.25, 0.45, 1.2);
      return;
    }
    if (sound === 'piston') {
      // Pile driver: its booster lighting, a hard crack and a deep whump into a falling roar (the
      // exhaust carries the burn on), as the ram thumps out and its latch clacks behind.
      const out = this.voice(pos, 0.7, undefined, 0.15);
      if (!out) return;
      out.gain.value = pos ? 1.6 : 1.1;
      this.noise(out, 'white', 'highpass', 2200, 1200, 0.0005, 0.03, 0.7);
      this.tone(out, 'sine', 110, 45, 0.003, 0.3, 1.0);
      this.noise(out, 'brown', 'lowpass', 1600, 300, 0.01, 0.45, 0.8);
      this.noise(out, 'white', 'bandpass', 1400, 500, 0.02, 0.4, 0.4, 0.8);
      this.tone(out, 'square', 900, 600, 0.001, 0.05, 0.1, 0.1);
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
    if (sound === 'furnace') this.noise(out, 'brown', 'lowpass', 600, 120, 0.01, 0.5, 0.7);
    if (sound === 'hornet') this.noise(out, 'white', 'bandpass', 1800, 3000, 0.005, 0.25, 0.4, 2);
  }

  /**
   * A burst of radius `radius` m at `pos`: a deep boom and rumble (the hull filter softens it). A
   * charged shot's (`charge` 0-1) is louder, up to 50% at full.
   */
  blast(radius, pos, charge = 0) {
    const size = Math.min(Math.max(radius / 4, 0.4), 2);
    const life = 0.55 + 0.4 * size;
    const out = this.voice(pos, life + 0.3, undefined, 0.2);
    if (!out) return;
    out.gain.value = 1 + 0.5 * charge;
    this.noise(out, 'brown', 'lowpass', 900, 90, 0.005, life, Math.min(0.7 + 0.3 * size, 1.3));
    this.tone(out, 'sine', 56, 19, 0.005, life + 0.2, Math.min(0.6 + 0.35 * size, 1.2));
    this.noise(out, 'white', 'lowpass', 2200, 600, 0.002, 0.1, 0.3 * size);
  }

  /**
   * Plays the ambience named `name` (see AMBIENCE; none for an unknown or missing one), fading out
   * whatever played before. Before audio starts it's only remembered.
   */
  setAmbience(name) {
    this.ambienceName = name;
    if (!this.ctx) return;
    const { ctx } = this, t = ctx.currentTime;
    if (this.ambience) {
      const old = this.ambience;
      clearInterval(old.timer);
      old.bus.gain.setTargetAtTime(0, t, 0.4);
      setTimeout(() => {
        for (const src of old.sources) src.stop();
        old.bus.disconnect();
      }, 2500);
    }
    const spec = AMBIENCE[name];
    this.ambience = null;
    if (!spec) return;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.gain.setTargetAtTime(spec.gain ?? 1, t, 0.8);
    bus.connect(this.ambienceOut);
    const amb = (this.ambience = { bus, sources: [], gusts: [], accents: spec.accents.map(([kind, every, level]) => ({ kind, every, level, next: t + every[0] * Math.random() })) });
    for (const [kind, ...shape] of spec.beds) this.bed(amb, kind, ...shape);
    amb.timer = setInterval(() => this.ambienceTick(amb), 250);
  }

  /** A gain node at `value`. */
  amp(value) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    return g;
  }

  /** A looping bed of `kind` at `level` into `amb`'s bus. */
  bed(amb, kind, level, a, b) {
    const { ctx } = this;
    const out = ctx.createGain();
    out.gain.value = level;
    out.connect(amb.bus);
    const loop = (buf) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.start(ctx.currentTime, Math.random() * buf.duration);
      amb.sources.push(src);
      return src;
    };
    const osc = (type, f) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.start();
      amb.sources.push(o);
      return o;
    };
    const filter = (type, f, q = 1) => {
      const node = ctx.createBiquadFilter();
      node.type = type;
      node.frequency.value = f;
      node.Q.value = q;
      return node;
    };
    // An oscillator at `rate` Hz wobbling `param` by `depth` either side of what it's set to.
    const wobble = (param, rate, depth, type = 'sine') => osc(type, rate).connect(this.amp(depth)).connect(param);
    if (kind === 'wind' || kind === 'howl') {
      // Noise through a band that gusts: louder and higher on a slow random walk (see `ambienceTick`).
      // A howl is a narrow, sweeping band: wind whistling.
      const band = filter('bandpass', a, kind === 'howl' ? 6 : b);
      loop(this.long).connect(band).connect(out);
      amb.gusts.push({ gain: out.gain, freq: band.frequency, level, f: a, sweep: kind === 'howl' ? 0.6 : 0.3, g: Math.random() });
    } else if (kind === 'rain') {
      loop(this.long).connect(filter('highpass', a)).connect(out);
    } else if (kind === 'roar') {
      loop(this.brown).connect(filter('lowpass', 400)).connect(out); // a furnace's draw
      wobble(out.gain, 0.13, level * 0.3);
    } else if (kind === 'water') {
      loop(this.brown).connect(filter('bandpass', 600, 0.7)).connect(out); // lapping, slow swells
      wobble(out.gain, 0.08, level * 0.5);
    } else if (kind === 'hum') {
      // Machinery or something stranger: tones, the close pairs beating, through a low-pass.
      const lp = filter('lowpass', 400);
      lp.connect(out);
      for (const f of a) osc('sine', f).connect(this.amp(1 / a.length)).connect(lp);
      wobble(out.gain, 0.05, level * 0.25);
    }
  }

  /** Every quarter second: the wind's gusts drift, and accents come due. */
  ambienceTick(amb) {
    if (!this.running) return;
    const t = this.ctx.currentTime;
    for (const w of amb.gusts) {
      w.g = Math.min(Math.max(w.g + (Math.random() - 0.5) * 0.25, 0), 1);
      w.gain.setTargetAtTime(w.level * (0.45 + 0.8 * w.g), t, 1.2);
      w.freq.setTargetAtTime(w.f * (1 - w.sweep / 2 + w.sweep * w.g), t, 1.2);
    }
    for (const a of amb.accents) {
      if (t < a.next) continue;
      a.next = t + a.every[0] + Math.random() * (a.every[1] - a.every[0]);
      const out = this.ctx.createGain(), pan = this.ctx.createStereoPanner();
      out.gain.value = a.level;
      pan.pan.value = Math.random() * 1.6 - 0.8;
      out.connect(pan).connect(amb.bus);
      if (a.kind === 'drip') out.connect(this.amp(1.5)).connect(this.reverb); // underground: it rings
      this.accent(out, a.kind);
      setTimeout(() => out.disconnect(), 6000);
    }
  }

  /** A one-off of `kind` into `out`. */
  accent(out, kind) {
    const r = (lo, hi) => lo + Math.random() * (hi - lo);
    if (kind === 'clank') {
      // Metal on metal: inharmonic partials, struck.
      const f = r(300, 520);
      this.tone(out, 'square', f, f * 0.95, 0.002, 0.22, 0.5);
      this.tone(out, 'triangle', f * 2.71, f * 2.6, 0.002, 0.35, 0.4);
      this.noise(out, 'white', 'highpass', 3000, 2000, 0.001, 0.05, 0.4);
    } else if (kind === 'steam') {
      this.noise(out, 'white', 'bandpass', r(2500, 3500), 2000, 0.15, r(0.8, 1.6), 0.8);
    } else if (kind === 'rumble') {
      this.noise(out, 'brown', 'lowpass', 160, 60, 0.6, r(2.5, 4), 1);
      this.tone(out, 'sine', 40, 28, 0.5, 3, 0.5);
    } else if (kind === 'siren') {
      // Far off: up, and down again.
      this.tone(out, 'sine', 620, 880, 1, 1.3, 0.6);
      this.tone(out, 'sine', 880, 620, 1, 1.3, 0.6, 2.1);
    } else if (kind === 'patter') {
      // Rain on metal: a few ticks.
      for (let k = 0; k < 3; k++) this.noise(out, 'white', 'bandpass', r(3000, 5000), 3000, 0.001, 0.03, r(0.4, 1), 4, r(0, 0.3));
    } else if (kind === 'drip') {
      const f = r(700, 1100);
      this.tone(out, 'sine', f, f * 2, 0.002, 0.07, 0.8);
    } else if (kind === 'creak') {
      // Metal under strain: a slow, low groan.
      this.growl(out, 'sawtooth', r(85, 110), r(60, 75), 500, 0.4, r(1.2, 2), 0.7);
    } else if (kind === 'moan') {
      this.growl(out, 'triangle', r(170, 200), r(130, 150), 600, 1.5, 2.5, 0.7);
    } else if (kind === 'croak') {
      for (const d of [0, 0.3]) this.growl(out, 'square', r(150, 175), 135, 700, 0.01, 0.2, 0.6, d);
    } else if (kind === 'hoot') {
      for (const d of [0, 0.7]) this.tone(out, 'sine', 420, 380, 0.08, 0.45, 0.6, d);
    } else if (kind === 'whistle') {
      // Wind through the arch's gap: a long, rising note.
      this.tone(out, 'sine', r(1100, 1300), r(1400, 1600), 1.5, 2, 0.4);
      this.noise(out, 'white', 'bandpass', 1400, 1500, 1.5, 2, 0.3, 8);
    } else if (kind === 'geiger') {
      // A counter near something hot: a crackle of clicks at random, a few or a burst.
      for (let k = 0, n = 3 + Math.floor(r(0, 14)), d = 0; k < n; k++, d -= Math.log(1 - Math.random()) * 0.09) {
        this.noise(out, 'white', 'highpass', 3500, 3000, 0.0005, 0.004, r(0.5, 1), 1, d);
      }
    }
  }

  /** Thunder `delay` s after its flash: a crack if the strike was close, then a long low rumble. */
  thunder(delay, close) {
    const out = this.voice(null, delay + 6, this.world, 0.5);
    if (!out) return;
    if (close) this.noise(out, 'white', 'lowpass', 3000, 400, 0.005, 0.5, 0.45, 1, delay);
    this.noise(out, 'brown', 'lowpass', 420, 60, 0.35, 4.8, 1.0, 1, delay + 0.05);
    this.tone(out, 'sine', 46, 22, 0.4, 4.2, 0.45, delay + 0.1);
  }

  /**
   * A silo launching at `pos`: the hatch unlocking with a clank, its doors grinding apart, a blast
   * of steam, then the rocket lighting: a roar building over a deep thump.
   */
  silo(pos) {
    const out = this.voice(pos, 3.4, undefined, 0.3);
    if (!out) return;
    out.gain.value = 1.6;
    this.noise(out, 'white', 'bandpass', 900, 700, 0.002, 0.08, 0.6, 3);
    this.tone(out, 'triangle', 140, 120, 0.002, 0.2, 0.4);
    this.growl(out, 'sawtooth', 70, 52, 380, 0.15, 0.7, 0.3, 0.06);
    this.noise(out, 'white', 'highpass', 1800, 900, 0.05, 0.9, 0.35, 0.7, 0.45);
    this.noise(out, 'brown', 'lowpass', 260, 900, 0.9, 1.9, 1.2, 1, 0.9);
    this.tone(out, 'sine', 48, 30, 0.01, 1.6, 1.0, 0.95);
  }

  /**
   * An objective changing hands: one plain tone, higher when it's `took` (ours now) than when it's
   * `lost` (ours no more) or `enemy` (theirs now).
   */
  zone(kind) {
    const out = this.voice(null, 0.6, this.ui);
    if (!out) return;
    const f = kind === 'took' ? 587 : 294;
    this.tone(out, 'triangle', f, f, 0.01, 0.42, 0.3);
    this.tone(out, 'sine', f / 2, f / 2, 0.01, 0.42, 0.12);
  }

  /**
   * A blip while we take an objective, rising two octaves as it comes our way (`share`: 0 theirs,
   * 0.5 neutral, 1 ours); a low double buzz while it's contested.
   */
  capturing(share, contested) {
    const out = this.voice(null, 0.3, this.ui);
    if (!out) return;
    if (contested) {
      this.tone(out, 'square', 110, 104, 0.003, 0.07, 0.09);
      this.tone(out, 'square', 110, 104, 0.003, 0.07, 0.09, 0.12);
      return;
    }
    const f = 330 * 2 ** (2 * share);
    this.tone(out, 'sine', f, f, 0.003, 0.09, 0.17);
    this.tone(out, 'triangle', 2 * f, 2 * f, 0.003, 0.05, 0.04);
  }

  /**
   * A battleship lifting off at `pos`: a deep boom, then a long, bass-heavy rumble of engines
   * spooling up. Heard everywhere: in 3D near it, and as distant thunder through the hull past that.
   */
  shipLaunch(pos) {
    const l = this.listener, near = pos && Math.hypot(pos.x - l.x, pos.y - l.y, pos.z - l.z) <= MAX_DISTANCE;
    const out = this.voice(near ? pos : null, 5.2, this.world, 0.4);
    if (!out) return;
    out.gain.value = near ? 3.2 : 0.7;
    this.tone(out, 'sine', 52, 30, 0.01, 1.4, 1.2);
    this.noise(out, 'brown', 'lowpass', 600, 90, 0.005, 1.0, 1.0);
    this.noise(out, 'brown', 'lowpass', 90, 240, 1.2, 3.6, 1.3, 1, 0.3);
    this.tone(out, 'sine', 31, 38, 1.0, 3.8, 1.1, 0.4);
    this.growl(out, 'sawtooth', 44, 58, 160, 1.4, 3.2, 0.5, 0.5);
  }

  /** A battleship's gun at `pos`: a heavy cannon report, all low end, with a long tail. */
  shipGun(pos) {
    const out = this.voice(pos, 1.2, undefined, 0.4);
    if (!out) return;
    out.gain.value = 2.6;
    this.tone(out, 'sine', 74, 28, 0.003, 0.7, 1.2);
    this.noise(out, 'brown', 'lowpass', 520, 70, 0.003, 0.8, 1.1);
    this.noise(out, 'white', 'lowpass', 2400, 400, 0.001, 0.06, 0.35);
    this.growl(out, 'sawtooth', 60, 32, 140, 0.005, 0.5, 0.4);
  }

  /**
   * Energy banked: a heavy latch, the charge draining off up a rising sweep, and a settled tone.
   * `ours` is for our own deposit, else (softer) a teammate's.
   */
  deposit(ours) {
    const out = this.voice(null, 0.8, this.ui);
    if (!out) return;
    out.gain.value = ours ? 1 : 0.4;
    this.tone(out, 'triangle', 150, 90, 0.002, 0.12, 0.5);
    this.noise(out, 'white', 'bandpass', 1200, 800, 0.002, 0.05, 0.35, 3);
    this.tone(out, 'sine', 220, 880, 0.02, 0.3, 0.18, 0.06);
    this.noise(out, 'white', 'bandpass', 900, 4200, 0.02, 0.3, 0.08, 2, 0.06);
    this.tone(out, 'sine', 523, 523, 0.01, 0.4, 0.16, 0.34);
  }

  /** Our flag taken: a two-tone klaxon, twice. */
  flagAlarm() {
    const out = this.voice(null, 1.1, this.ui);
    if (!out) return;
    for (let k = 0; k < 2; k++) {
      this.tone(out, 'square', 392, 392, 0.01, 0.22, 0.1, 0.5 * k);
      this.tone(out, 'square', 311, 311, 0.01, 0.22, 0.1, 0.5 * k + 0.25);
    }
  }

  /** Our hold just filled with energy: one soft, plain tone. */
  full() {
    const out = this.voice(null, 0.5, this.ui);
    if (!out) return;
    this.tone(out, 'sine', 440, 440, 0.01, 0.35, 0.22);
    this.tone(out, 'triangle', 880, 880, 0.01, 0.2, 0.05);
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

  /** Camouflage on or off: the whole mix muffles, or clears, over a moment. */
  stealth(on) {
    if (!this.veil || on === this.stealthed) return;
    this.stealthed = on;
    this.veil.frequency.setTargetAtTime(on ? STEALTH_CUTOFF : OPEN_CUTOFF, this.ctx.currentTime, 0.12);
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

  /**
   * Ability cue, by weapons.json id: a Vent hiss, a Speed boost surge, Camouflage fading out, a
   * Power shot charging up, or a clunk (Bulwark, Barrage, Artillery).
   */
  ability(id, pos) {
    const out = this.voice(pos, 0.9);
    if (!out) return;
    if (id === 'vent') {
      this.noise(out, 'white', 'highpass', 2500, 1200, 0.03, 0.8, 0.35);
    } else if (id === 'slipstream') {
      this.noise(out, 'white', 'bandpass', 600, 3200, 0.05, 0.45, 0.4, 1.5);
      this.tone(out, 'sawtooth', 180, 640, 0.05, 0.4, 0.06);
    } else if (id === 'cloak') {
      this.noise(out, 'white', 'bandpass', 3000, 500, 0.05, 0.7, 0.25, 2);
      this.tone(out, 'sine', 900, 220, 0.02, 0.6, 0.12);
    } else if (id === 'power') {
      this.tone(out, 'sawtooth', 120, 900, 0.02, 0.35, 0.08);
      this.tone(out, 'sine', 240, 1800, 0.02, 0.35, 0.1);
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

  /** A dome or barrier powering down at its end: its hum sagging away under a soft fizz. */
  fieldDown(pos) {
    const out = this.voice(pos, 0.9, undefined, 0.3);
    if (!out) return;
    this.growl(out, 'sawtooth', 240, 45, 700, 0.01, 0.8, 0.12);
    this.tone(out, 'sine', 600, 180, 0.01, 0.6, 0.08);
    this.noise(out, 'white', 'highpass', 4000, 1500, 0.02, 0.5, 0.06);
  }

  /** A dome or barrier shot through: a glassy crash, its hum cut off in a zap, a thump, and tinkling. */
  shatter(pos) {
    const out = this.voice(pos, 1.2, undefined, 0.4);
    if (!out) return;
    this.noise(out, 'white', 'highpass', 2500, 6000, 0.002, 0.45, 0.45);
    this.noise(out, 'white', 'bandpass', 3000, 1200, 0.002, 0.25, 0.3, 3);
    this.tone(out, 'sawtooth', 900, 60, 0.002, 0.35, 0.16);
    this.tone(out, 'sine', 140, 40, 0.003, 0.4, 0.5);
    for (let k = 0; k < 6; k++) {
      const f = 1800 + Math.random() * 2400;
      this.tone(out, 'triangle', f, f * 0.97, 0.002, 0.15 + Math.random() * 0.25, 0.05, 0.03 + Math.random() * 0.5);
    }
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

  /** Rockets and darts in flight this frame, as [{ x, y, z, dart, big }] (big: a silo's rocket): the nearest few roar along with them. */
  exhausts(list) {
    if (!this.running) return;
    const l = this.listener, t = this.ctx.currentTime;
    const near = list.sort((a, b) => dist2(a, l) - dist2(b, l)).slice(0, EXHAUST_SLOTS);
    this.jets.forEach((jet, i) => {
      const o = near[i];
      jet.gain.gain.setTargetAtTime(o ? (o.big ? 1.1 : o.dart ? 0.2 : 0.55) : 0, t, o ? 0.02 : 0.06);
      if (!o) return;
      jet.band.frequency.setTargetAtTime(o.big ? 520 : o.dart ? 2600 : 1100, t, 0.02);
      if (jet.panner.positionX) {
        jet.panner.positionX.setTargetAtTime(o.x, t, 0.01);
        jet.panner.positionY.setTargetAtTime(o.y, t, 0.01);
        jet.panner.positionZ.setTargetAtTime(o.z, t, 0.01);
      } else {
        jet.panner.setPosition(o.x, o.y, o.z);
      }
    });
  }

  /**
   * A battleship's engines: a sub-bass drone (two low sines a fifth apart, beating slowly, over
   * low-passed brown noise), silent until `ships` drives it; heard from far off.
   */
  drone(panner) {
    const { ctx } = this;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    Object.assign(panner, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 30, maxDistance: 600, rolloffFactor: 1 });
    gain.connect(panner).connect(this.world);
    for (const [f, level] of [[34, 0.9], [51.3, 0.5]]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(gain);
      osc.start();
    }
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.brown;
    rumble.loop = true;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 140;
    rumble.connect(low).connect(gain);
    rumble.start(0, Math.random());
    return { gain, panner };
  }

  /** The battleships up this frame, as [{ x, y, z }]: each drones from where it is. */
  ships(list) {
    if (!this.running) return;
    const t = this.ctx.currentTime;
    this.hulls.forEach((hull, i) => {
      const o = list[i];
      hull.gain.gain.setTargetAtTime(o ? 1.6 : 0, t, o ? 0.4 : 0.8);
      if (!o) return;
      if (hull.panner.positionX) {
        hull.panner.positionX.setTargetAtTime(o.x, t, 0.05);
        hull.panner.positionY.setTargetAtTime(o.y, t, 0.05);
        hull.panner.positionZ.setTargetAtTime(o.z, t, 0.05);
      } else {
        hull.panner.setPosition(o.x, o.y, o.z);
      }
    });
  }

  /**
   * Drawing energy: a soft hum with a shimmer on it, pulsing, that climbs as the hold fills; built
   * once on unlock, silent until `gathering` drives it.
   */
  gatherLoop() {
    const { ctx } = this;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.cockpitBus);
    const pulse = ctx.createGain();
    pulse.gain.value = 0.7;
    pulse.connect(gain);
    const lfo = ctx.createOscillator(), depth = ctx.createGain();
    lfo.frequency.value = 7;
    depth.gain.value = 0.3;
    lfo.connect(depth).connect(pulse.gain);
    lfo.start();
    const tones = [['sine', 1, 0.5], ['triangle', 2, 0.12], ['sine', 3.01, 0.05]].map(([type, mult, level]) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(pulse);
      osc.start();
      return { osc, mult };
    });
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.white;
    hiss.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 3200;
    band.Q.value = 2;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.04;
    hiss.connect(band).connect(hissGain).connect(pulse);
    hiss.start(0, Math.random());
    this.gatherNodes = { gain, tones };
  }

  /** Drawing energy with the hold `share` full (0 to 1), or not (null): the hum on, climbing, or off. */
  gathering(share) {
    if (!this.running || !this.gatherNodes) return;
    const t = this.ctx.currentTime, { gain, tones } = this.gatherNodes;
    gain.gain.setTargetAtTime(share === null ? 0 : 0.22, t, share === null ? 0.08 : 0.05);
    if (share === null) return;
    const f = 160 * 2 ** (1.3 * share);
    for (const { osc, mult } of tones) osc.frequency.setTargetAtTime(f * mult, t, 0.05);
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
    // The HEAT cannon's charge, a bow drawn across sheet metal: a sawtooth (the bow's stick and
    // slip) and the plate's inharmonic partials, one a hair sharp so they shimmer, all with a
    // slight vibrato, through a band-pass that follows the pitch; and the rosin's scrape. Sent to
    // a longer reverb of its own too, so it rings on about a second once the bow lifts.
    const bowFilter = ctx.createBiquadFilter();
    bowFilter.type = 'bandpass';
    bowFilter.Q.value = 1.2;
    const bowGain = ctx.createGain();
    bowGain.gain.value = 0;
    bowFilter.connect(bowGain).connect(this.cockpitBus);
    const bowSend = ctx.createGain();
    bowSend.gain.value = 0.8;
    const bowVerb = ctx.createConvolver();
    bowVerb.buffer = impulse(ctx, 1.6, 0.28);
    bowGain.connect(bowSend).connect(bowVerb).connect(this.cockpitBus);
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 5.5;
    const depth = ctx.createGain();
    depth.gain.value = 9; // cents
    vibrato.connect(depth);
    vibrato.start();
    const bow = [['sawtooth', 1, 0.5], ['sine', 1.006, 0.5], ['sine', 2.76, 0.35], ['sine', 5.4, 0.18]].map(([type, mult, level]) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      depth.connect(osc.detune);
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(bowFilter);
      osc.start();
      return { osc, mult };
    });
    const scrape = ctx.createBufferSource();
    scrape.buffer = this.white;
    scrape.loop = true;
    const scrapeFilter = ctx.createBiquadFilter();
    scrapeFilter.type = 'bandpass';
    scrapeFilter.Q.value = 6;
    const scrapeGain = ctx.createGain();
    scrapeGain.gain.value = 0.25;
    scrape.connect(scrapeFilter).connect(scrapeGain).connect(bowGain);
    scrape.start();
    this.cockpitNodes = { whir, whirGain, spool, spoolFilter, spoolGain, bow, bowFilter, bowGain, scrapeFilter };
  }

  /**
   * Each frame: { alive, heat (0-1), overheated, hull (0-1), repairing (0-1 phase), jammed, beaming,
   * spin (0-1), charge (0-1), incoming (m, or null), lock (0-1) }. Drives the repair whir (higher
   * and softer for a held beam), the Gatling's spool, rising from a low hum to a high whine as the
   * barrels spin up, and the HEAT cannon's bowed charge, and paces warning beeps, the missile alarm
   * and the lock tones.
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
    // The HEAT cannon's charge (0-1): the bow draws a low note up, rounding out high and swelling
    // from a whisper, and lifts off once full, leaving it to ring out in the reverb; it stops short
    // if the shot goes first.
    const charge = s.alive ? s.charge : 0, fb = 160 + 560 * (1 - (1 - charge) ** 2);
    for (const { osc, mult } of n.bow) osc.frequency.setTargetAtTime(fb * mult, t, 0.03);
    n.bowFilter.frequency.setTargetAtTime(fb * 2, t, 0.03);
    n.scrapeFilter.frequency.setTargetAtTime(fb * 3.5, t, 0.03);
    const bowing = charge > 0 && charge < 1;
    n.bowGain.gain.setTargetAtTime(bowing ? 0.004 + 0.09 * charge ** 2 : 0, t, bowing ? 0.04 : charge >= 1 ? 0.06 : 0.015);
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
    // Our own lock (`lock`, 0 to 1 made; 0 for none): three tracking beeps climbing while it
    // locks, one per third, then a bright rising chirp once it's made.
    const step = s.lock > 0 && s.lock < 1 ? Math.floor(s.lock * 3) : -1;
    if (step >= 0 && step !== this.lockStep) {
      const out = this.voice(null, 0.15, this.ui);
      if (out) this.tone(out, 'triangle', 1100 + 150 * step, 1100 + 150 * step, 0.002, 0.06, 0.16);
    }
    this.lockStep = step;
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
function buffer(ctx, sample, seconds = 1) {
  const b = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
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
