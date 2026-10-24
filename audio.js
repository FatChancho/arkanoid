/*
 * audio.js — Efectos de sonido sintetizados con Web Audio.
 *
 * Sin archivos de audio ni dependencias: todo se genera con osciladores y
 * ruido filtrado.
 *
 *   bounce(kind)       "wall" | "paddle" | "target": clic corto de rebote.
 *   explosion(i)       i en [0.15, 1]: más grande = más larga y más grave.
 *   laser()            "pew" corto al disparar.
 *   pickup()           arpegio ascendente al recoger un objeto.
 *   toggleMute()       silencia / activa (tecla M en el juego).
 *   state()            "off" | "locked" | "on" | "muted" | "unavailable".
 *   tryStart()         crea el contexto solo si la página ya tuvo interacción.
 *   unlock()           crea/reanuda el contexto; llamar desde un gesto del usuario.
 *   dispose()          cierra el contexto y suelta todo.
 *
 * POLÍTICA DE AUTOPLAY
 * Chrome no deja sonar a una página hasta que el usuario interactúa con ella
 * (clic o tecla; mover el ratón no cuenta), y pulsar el botón del popup de la
 * extensión no cuenta como interacción con la página. Por eso el contexto
 * solo se crea si la página ya había recibido interacción, o en el primer
 * clic/tecla del juego. Mientras tanto state() devuelve "off"/"locked" y el
 * HUD avisa al jugador. Nunca se encolan sonidos mientras el contexto está
 * suspendido, para que no suenen todos de golpe al reanudarse.
 *
 * LÍMITES
 * Máximo de voces simultáneas, separación mínima entre rebotes, atenuación
 * de cada sonido nuevo según las voces activas, un compresor y un limitador
 * suave (tanh) en la salida: la señal nunca pasa de +-1, así que muchas
 * explosiones juntas no saturan el altavoz.
 *
 * Para pruebas, create({ context, muted }) acepta un contexto ya construido
 * (por ejemplo OfflineAudioContext), que se considera siempre "en marcha".
 */
(() => {
  "use strict";

  const WB = (globalThis.__WebBreakout = globalThis.__WebBreakout || {});

  const CFG = {
    master: 0.55,
    maxVoices: 8,
    maxBounceVoices: 6,
    minBounceGap: 0.03
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function unavailable() {
    const noop = () => {};
    return {
      available: false,
      tryStart: noop,
      unlock: noop,
      bounce: noop,
      explosion: noop,
      laser: noop,
      pickup: noop,
      setMuted: noop,
      toggleMute: () => false,
      isMuted: () => false,
      state: () => "unavailable",
      dispose: noop
    };
  }

  function create(options) {
    const opts = options || {};
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    const injected = Boolean(opts.context);
    if (!injected && !Ctor) return unavailable();

    let ctx = opts.context || null;
    let master = null;
    let noise = null;
    let muted = Boolean(opts.muted);
    let disposed = false;
    let voices = 0;
    let bounceVoices = 0;
    let lastBounce = -1;
    let lastLaser = -1;

    function build() {
      master = ctx.createGain();
      master.gain.value = muted ? 0 : CFG.master;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      // Limitador suave: la entrada fuera de [-1, 1] se recorta al extremo de
      // la curva, así que la salida no puede superar +-1.
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(2048);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6);
      }
      shaper.curve = curve;

      master.connect(comp);
      comp.connect(shaper);
      shaper.connect(ctx.destination);

      const length = Math.floor(ctx.sampleRate);
      noise = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }

    if (injected) build();

    function ensure() {
      if (disposed) return false;
      if (!ctx) {
        try {
          ctx = new Ctor();
        } catch {
          disposed = true;
          return false;
        }
        build();
      }
      return true;
    }

    function resumeContext() {
      if (!injected && ctx && ctx.state === "suspended" && typeof ctx.resume === "function") {
        ctx.resume().catch(() => {});
      }
    }

    function canPlay() {
      return Boolean(ctx && master && !disposed && (injected || ctx.state === "running"));
    }

    function tryStart() {
      if (disposed) return;
      if (ctx) {
        resumeContext();
        return;
      }
      const activation = typeof navigator !== "undefined" ? navigator.userActivation : null;
      if (activation && activation.hasBeenActive && ensure()) resumeContext();
    }

    function unlock() {
      if (disposed) return;
      if (ensure()) resumeContext();
    }

    /* ---------- Bloques de construcción ---------- */

    function tone(type, f0, f1, dur, gain, delay) {
      const t = ctx.currentTime + (delay || 0);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(master);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      return osc;
    }

    function noiseBurst(filterType, f0, f1, q, dur, gain) {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = filterType;
      filter.Q.value = q;
      filter.frequency.setValueAtTime(f0, t);
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(filter);
      filter.connect(g);
      g.connect(master);
      const offset = Math.random() * Math.max(0, noise.duration - dur - 0.05);
      src.start(t, offset, dur + 0.02);
      return src;
    }

    /* ---------- Sonidos ---------- */

    /** Cuantas más voces suenan, más bajo entra la siguiente. */
    function crowd() {
      return 1 / (1 + 0.35 * (voices + bounceVoices * 0.3));
    }

    function bounce(kind) {
      if (!canPlay() || muted) return;
      const now = ctx.currentTime;
      if (now - lastBounce < CFG.minBounceGap || bounceVoices >= CFG.maxBounceVoices) return;
      lastBounce = now;

      const r = 1 + (Math.random() - 0.5) * 0.1;
      const k = crowd();
      let osc;
      if (kind === "paddle") osc = tone("triangle", 420 * r, 700 * r, 0.09, 0.38 * k);
      else if (kind === "target") osc = tone("square", 760 * r, 520 * r, 0.05, 0.1 * k);
      else osc = tone("triangle", 320 * r, 250 * r, 0.07, 0.3 * k);

      bounceVoices++;
      osc.onended = () => {
        bounceVoices--;
      };
    }

    function explosion(intensity) {
      if (!canPlay() || muted || voices >= CFG.maxVoices) return;
      const i = clamp(Number.isFinite(intensity) ? intensity : 0.6, 0.15, 1);
      const dur = 0.2 + 0.45 * i;
      const r = 1 + (Math.random() - 0.5) * 0.12;

      const k = crowd();
      noiseBurst("highpass", 1800 * r, 900, 0.7, 0.05, 0.35 * k);
      noiseBurst("lowpass", (2600 + 1200 * i) * r, 160, 0.9, dur, (0.55 + 0.25 * i) * k);
      const boom = tone("sine", 140 * r, 36, dur * 1.15, (0.5 + 0.3 * i) * k);

      voices++;
      boom.onended = () => {
        voices--;
      };
    }

    function laser() {
      if (!canPlay() || muted || bounceVoices >= CFG.maxBounceVoices) return;
      const now = ctx.currentTime;
      if (now - lastLaser < 0.05) return;
      lastLaser = now;

      const r = 1 + (Math.random() - 0.5) * 0.08;
      const osc = tone("sawtooth", 1500 * r, 280, 0.13, 0.3 * crowd());
      bounceVoices++;
      osc.onended = () => {
        bounceVoices--;
      };
    }

    function pickup() {
      if (!canPlay() || muted || voices >= CFG.maxVoices) return;
      const k = crowd();
      tone("square", 520, 780, 0.07, 0.16 * k);
      tone("square", 780, 1170, 0.07, 0.16 * k, 0.07);
      const last = tone("square", 1170, 1560, 0.1, 0.16 * k, 0.14);
      voices++;
      last.onended = () => {
        voices--;
      };
    }

    /* ---------- Control ---------- */

    function applyMute() {
      if (!master) return;
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setTargetAtTime(muted ? 0 : CFG.master, t, 0.015);
    }

    function setMuted(value) {
      muted = Boolean(value);
      applyMute();
    }

    function toggleMute() {
      setMuted(!muted);
      return muted;
    }

    function state() {
      if (disposed) return "off";
      if (muted) return "muted";
      if (!ctx) return "off";
      return injected || ctx.state === "running" ? "on" : "locked";
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      const old = ctx;
      ctx = null;
      master = null;
      noise = null;
      if (old && !injected && typeof old.close === "function") old.close().catch(() => {});
    }

    return {
      available: true,
      tryStart,
      unlock,
      bounce,
      explosion,
      laser,
      pickup,
      setMuted,
      toggleMute,
      isMuted: () => muted,
      state,
      dispose,
      // Solo para pruebas.
      debug: { get voices() { return voices; }, get context() { return ctx; } }
    };
  }

  WB.Audio = { create, CFG };
})();
