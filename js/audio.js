/**
 * audio.js — background music from an MP3 file (config.js → MUSIC_SRC) plus procedural SFX.
 * If the MP3 is missing or undecodable, a generated Hijaz-maqam loop plays instead.
 * Singleton; all state is encapsulated. Safe to import before any user gesture.
 */
import { MUSIC_SRC } from './config.js';

const STORAGE_KEY = 'arabicScrabble.audio.v1';
const DEFAULT_PREFS = Object.freeze({ music: true, sfx: true, musicVolume: 0.3, sfxVolume: 0.7 });

// Hijaz maqam (semitones above the tonic) — supplies the Arabic colour.
const HIJAZ = Object.freeze([0, 1, 4, 5, 7, 8, 10, 12]);
const TONIC_HZ = 146.83; // D3
const STEP_SEC = 0.5;
const STEPS_PER_BAR = 8;
const LOOKAHEAD_SEC = 1.0; // schedule ahead so timer jitter never causes gaps
const TICK_MS = 250;

const hz = (semitones) => TONIC_HZ * 2 ** (semitones / 12);
const clamp01 = (n, fallback) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback);

// t = start offset (s), d = duration (s), g = peak gain.
const SFX = Object.freeze({
  select:    [{ f: 880, d: 0.05, g: 0.25 }],
  place:     [{ f: 196, d: 0.09, type: 'triangle', g: 0.6 }, { f: 147, t: 0.02, d: 0.12, g: 0.5 }],
  recall:    [{ f: 440, d: 0.06 }, { f: 330, t: 0.06, d: 0.08 }],
  score:     [{ f: 523, d: 0.1 }, { f: 659, t: 0.09, d: 0.1 }, { f: 784, t: 0.18, d: 0.18 }],
  invalid:   [{ f: 160, d: 0.14, type: 'square', g: 0.15 }, { f: 130, t: 0.14, d: 0.2, type: 'square', g: 0.15 }],
  swap:      [{ f: 392, d: 0.08 }, { f: 330, t: 0.08, d: 0.1 }],
  pass:      [{ f: 262, d: 0.15, type: 'triangle' }],
  challenge: [{ f: 330, d: 0.12, type: 'triangle' }, { f: 330, t: 0.16, d: 0.12, type: 'triangle' }],
  tick:      [{ f: 1000, d: 0.03, g: 0.15 }],
  lowTime:   [{ f: 800, d: 0.08, type: 'triangle', g: 0.3 }],
  win:       [523, 659, 784, 1047].map((f, i) => ({ f, t: i * 0.12, d: 0.3, g: 0.35 })),
});

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      music: raw.music ?? DEFAULT_PREFS.music,
      sfx: raw.sfx ?? DEFAULT_PREFS.sfx,
      musicVolume: clamp01(raw.musicVolume, DEFAULT_PREFS.musicVolume),
      sfxVolume: clamp01(raw.sfxVolume, DEFAULT_PREFS.sfxVolume),
    };
  } catch {
    return { ...DEFAULT_PREFS }; // storage blocked or corrupt JSON
  }
}

class AudioManager {
  #prefs = loadPrefs();
  #ctx = null;
  #master = null;
  #sfxBus = null;
  #musicBus = null;     // persistent: volume control for both music sources
  #sessionBus = null;   // procedural fallback only; fresh per session so old notes can't bleed in
  #el = null;           // <audio> element for the MP3 (created lazily, reused)
  #fileFailed = false;
  #timer = null;
  #nextTime = 0;
  #step = 0;
  #degree = 0;
  #musicRequested = false;
  #initialized = false;

  /** Call once at startup. Registers autoplay-unlock and tab-visibility handling. */
  init() {
    if (this.#initialized) return;
    this.#initialized = true;

    const unlock = () => {
      this.#ensureContext()?.resume().catch(() => {});
      // A play() that was rejected by the autoplay policy is retried on the first gesture.
      if (this.#musicRequested && this.#prefs.music) this.startMusic();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);

    // Don't burn CPU/battery (or annoy the user) while the tab is hidden.
    document.addEventListener('visibilitychange', () => {
      if (!this.#ctx) return;
      if (document.hidden) this.#ctx.suspend().catch(() => {});
      else this.#ctx.resume().catch(() => {});
    });
  }

  play(name) {
    if (!this.#prefs.sfx) return;
    const notes = SFX[name];
    if (!notes) return;
    const ctx = this.#ensureContext();
    if (!ctx) return;
    const base = ctx.currentTime;
    for (const n of notes) {
      this.#tone(n.f, base + (n.t ?? 0), n.d, { type: n.type, g: n.g, bus: this.#sfxBus });
    }
  }

  startMusic() {
    this.#musicRequested = true;
    if (!this.#prefs.music) return;
    const ctx = this.#ensureContext();
    if (!ctx) return;
    ctx.resume().catch(() => {});
    this.#musicBus.gain.setTargetAtTime(this.#prefs.musicVolume, ctx.currentTime, 0.8);
    if (this.#fileFailed) this.#startProcedural(ctx);
    else this.#playFile(ctx);
  }

  stopMusic() {
    this.#musicRequested = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (!this.#ctx) return;
    this.#musicBus.gain.setTargetAtTime(0, this.#ctx.currentTime, 0.3);

    const el = this.#el;
    if (el) {
      setTimeout(() => { // let the fade finish, unless music was restarted meanwhile
        if (this.#musicRequested) return;
        el.pause();
        el.currentTime = 0;
      }, 800);
    }
    const session = this.#sessionBus;
    if (session) {
      this.#sessionBus = null;
      session.gain.setTargetAtTime(0, this.#ctx.currentTime, 0.3);
      setTimeout(() => session.disconnect(), 2500);
    }
  }

  setMusicEnabled(on) {
    this.#prefs.music = Boolean(on);
    this.#save();
    if (!on) {
      const wanted = this.#musicRequested;
      this.stopMusic();
      this.#musicRequested = wanted; // remember so re-enabling resumes playback
    } else if (this.#musicRequested) {
      this.startMusic();
    }
  }

  setSfxEnabled(on) {
    this.#prefs.sfx = Boolean(on);
    this.#save();
  }

  /** Master mute for a single button. Returns the new "sound on" state. */
  toggleAll() {
    const turnOn = !(this.#prefs.music || this.#prefs.sfx);
    this.setSfxEnabled(turnOn);
    this.setMusicEnabled(turnOn);
    return turnOn;
  }

  setVolume(kind, value) {
    if (kind !== 'music' && kind !== 'sfx') throw new RangeError(`Unknown volume channel: ${kind}`);
    const v = clamp01(value, NaN);
    if (Number.isNaN(v)) throw new RangeError('Volume must be a number between 0 and 1');
    this.#prefs[`${kind}Volume`] = v;
    this.#save();
    const bus = kind === 'music' ? this.#musicBus : this.#sfxBus;
    if (bus && this.#ctx) bus.gain.setTargetAtTime(v, this.#ctx.currentTime, 0.05);
  }

  get isSoundOn() {
    return this.#prefs.music || this.#prefs.sfx;
  }

  // ---- internals ----------------------------------------------------------

  #ensureContext() {
    if (this.#ctx) return this.#ctx;
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) return null; // very old browser: degrade silently
    try {
      this.#ctx = new Ctor();
    } catch {
      return null;
    }
    // Compressor prevents clipping when SFX overlap with the music bed.
    const limiter = this.#ctx.createDynamicsCompressor();
    limiter.connect(this.#ctx.destination);
    this.#master = this.#ctx.createGain();
    this.#master.connect(limiter);
    this.#sfxBus = this.#ctx.createGain();
    this.#sfxBus.gain.value = this.#prefs.sfxVolume;
    this.#sfxBus.connect(this.#master);
    this.#musicBus = this.#ctx.createGain();
    this.#musicBus.gain.value = 0;
    this.#musicBus.connect(this.#master);
    return this.#ctx;
  }

  #playFile(ctx) {
    if (!this.#el) {
      const el = new Audio(MUSIC_SRC);
      el.loop = true;
      el.preload = 'auto';
      // Routing through the graph gives volume control on iOS, where element.volume is ignored.
      ctx.createMediaElementSource(el).connect(this.#musicBus);
      el.addEventListener('error', () => this.#fallbackToProcedural(), { once: true });
      this.#el = el;
    }
    if (!this.#el.paused) return; // already playing: startMusic() is idempotent
    this.#el.play().catch((err) => {
      // NotAllowedError = autoplay policy; the unlock handler retries on the next gesture.
      if (err?.name !== 'NotAllowedError') this.#fallbackToProcedural();
    });
  }

  #fallbackToProcedural() {
    this.#fileFailed = true;
    this.#el?.pause();
    if (this.#musicRequested && this.#prefs.music && this.#ctx) this.#startProcedural(this.#ctx);
  }

  #startProcedural(ctx) {
    if (this.#timer) return;
    this.#sessionBus = ctx.createGain();
    this.#sessionBus.connect(this.#musicBus);
    this.#nextTime = ctx.currentTime + 0.1;
    this.#step = 0;
    this.#degree = 0;
    this.#timer = setInterval(() => this.#pump(), TICK_MS);
  }

  #tone(freq, start, dur, { type = 'sine', g = 0.4, attack = 0.01, bus }) {
    const ctx = this.#ctx;
    if (!ctx || !bus) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    // Exponential ramps cannot start at 0; use a tiny floor to avoid clicks.
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(g, start + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(env).connect(bus);
    osc.start(start);
    osc.stop(start + dur + 0.05);
    osc.onended = () => { osc.disconnect(); env.disconnect(); }; // free nodes promptly
  }

  #pump() {
    const ctx = this.#ctx;
    if (!ctx || !this.#sessionBus) return;
    // After a throttled/suspended period, skip ahead instead of bursting stale notes.
    if (this.#nextTime < ctx.currentTime) this.#nextTime = ctx.currentTime + 0.05;
    while (this.#nextTime < ctx.currentTime + LOOKAHEAD_SEC) {
      this.#scheduleStep(this.#step++, this.#nextTime);
      this.#nextTime += STEP_SEC;
    }
  }

  #scheduleStep(step, t) {
    const bus = this.#sessionBus;
    const pos = step % STEPS_PER_BAR;

    if (pos === 0) { // drone: tonic + fifth, overlapping so bars crossfade
      const len = STEP_SEC * STEPS_PER_BAR + 1;
      this.#tone(hz(-12), t, len, { g: 0.5, attack: 1.2, bus });
      this.#tone(hz(-5), t, len, { g: 0.25, attack: 1.2, bus });
    }

    const cadence = pos === STEPS_PER_BAR - 2;
    if ((pos % 2 === 0 && Math.random() < 0.65) || cadence) {
      // Mostly stepwise random walk through the maqam; cadence often resolves to tonic.
      const move = [-1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 6)];
      this.#degree = Math.min(HIJAZ.length - 1, Math.max(0, this.#degree + move));
      if (cadence && Math.random() < 0.5) this.#degree = 0;
      this.#tone(hz(HIJAZ[this.#degree]), t, STEP_SEC * 3, { type: 'triangle', g: 0.18, attack: 0.03, bus });
    }
  }

  #save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#prefs));
    } catch {
      /* private mode / quota: preferences just won't persist */
    }
  }
}

export const audio = new AudioManager();
