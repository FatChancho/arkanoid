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
 *   playMusic(kind)    "game" (Arcade Kid, en bucle) | "gameover" (marcha fúnebre, una vez).
 *   stopMusic()        desvanece y para la música.
 *   musicState()       "idle" | "loading" | "waiting" | "playing:game" | "playing:gameover" |
 *                      "error" | "disabled" | "off".
 *   setHidden(bool)    pausa/reanuda el audio con la visibilidad de la pestaña.
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
 * MÚSICA
 * Los dos MP3 van dentro de la extensión (music/, declarados como
 * web_accessible_resources). Se cargan con fetch desde el content script, se
 * decodifican a 32 kHz en un OfflineAudioContext (ocupan ~31 MB y ~1 MB; a
 * 48 kHz serían 49 MB) y se reproducen con AudioBufferSourceNode a través de la
 * misma mezcla maestra que los efectos, así que `M` también la silencia y el
 * limitador la cubre. No se usa un <audio>: un elemento de medios estaría
 * sujeto al `media-src` de la CSP de cada página, mientras que fetch desde el
 * mundo aislado de la extensión funciona incluso con `default-src 'none'`.
 *  - La carga es perezosa (al pedir la primera pista) y no necesita
 *    AudioContext, así que puede empezar antes del primer gesto del usuario.
 *  - Cada pista tiene su ganancia: la marcha fúnebre está masterizada ~8 dB
 *    más fuerte (-7,8 LUFS, picos en 0 dBFS) que Arcade Kid (-15,8 LUFS).
 *  - La música NO debe tapar los efectos: con el fondo a su nivel actual cada
 *    efecto sobresale ~8 dB o más sobre la música en su banda de frecuencias
 *    (medido). Si subes `gain` de "game", comprueba antes que no tapa los rebotes.
 *  - Arcade Kid lleva ~0,8 s de silencio al principio y ~1 s al final, así
 *    que en el bucle hay una pausa natural en la costura.
 *  - Al cambiar de pista hay un fundido cruzado corto.
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

  // Pistas: ganancia propia para igualar la sonoridad percibida (ver cabecera).
  const MUSIC = {
    game: { file: "music/arcade-kid.mp3", gain: 0.28, loop: true, fadeIn: 0.6 },
    gameover: { file: "music/marcha-funebre.mp3", gain: 0.4, loop: false, fadeIn: 0.05 }
  };
  const MUSIC_RATE = 32000;

  function extensionUrl(path) {
    const rt = globalThis.chrome && globalThis.chrome.runtime;
    return rt && typeof rt.getURL === "function" ? rt.getURL(path) : path;
  }

  function defaultLoader(kind) {
    return fetch(extensionUrl(MUSIC[kind].file)).then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.arrayBuffer();
    });
  }

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
      playMusic: noop,
      stopMusic: noop,
      setHidden: noop,
      musicState: () => "disabled",
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

    // Música
    const musicOpts = opts.music === false ? null : opts.music || {};
    const loader = (musicOpts && musicOpts.loader) || defaultLoader;
    const buffers = {};
    let wanted = null;
    let current = null;
    let lastFinished = null;
    let loading = null;
    let loaded = false;
    let musicError = null;
    let hiddenSuspended = false;

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
        ctx.onstatechange = () => syncMusic();
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
        syncMusic();
        return;
      }
      const activation = typeof navigator !== "undefined" ? navigator.userActivation : null;
      if (activation && activation.hasBeenActive && ensure()) resumeContext();
    }

    function unlock() {
      if (disposed) return;
      if (ensure()) resumeContext();
      syncMusic();
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
      else if (kind === "target") osc = tone("square", 760 * r, 520 * r, 0.05, 0.22 * k);
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
      const osc = tone("sawtooth", 1500 * r, 280, 0.13, 0.5 * crowd());
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

    /* ---------- Música ---------- */

    function decodeMusic(arrayBuffer) {
      if (injected) return ctx.decodeAudioData(arrayBuffer);
      const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (Offline) return new Offline(2, 1, MUSIC_RATE).decodeAudioData(arrayBuffer);
      if (!ensure()) return Promise.reject(new Error("sin AudioContext"));
      return ctx.decodeAudioData(arrayBuffer);
    }

    /** Carga y decodifica las dos pistas (una sola vez). No necesita AudioContext. */
    function loadMusic() {
      if (!musicOpts || loading) return loading;
      loading = Promise.all(
        Object.keys(MUSIC).map(async (kind) => {
          try {
            const raw = await loader(kind);
            const decoded =
              raw && typeof raw.getChannelData === "function" ? raw : await decodeMusic(raw);
            if (!disposed) buffers[kind] = decoded;
          } catch (error) {
            musicError = error;
          }
        })
      ).then(() => {
        loaded = true;
        syncMusic();
      });
      return loading;
    }

    function stopCurrent(fade) {
      const track = current;
      if (!track) return;
      current = null;
      try {
        if (fade > 0 && ctx) {
          const t = ctx.currentTime;
          track.g.gain.cancelScheduledValues(t);
          track.g.gain.setValueAtTime(track.g.gain.value, t);
          track.g.gain.linearRampToValueAtTime(0.0001, t + fade);
          track.src.stop(t + fade + 0.02);
        } else {
          track.src.stop();
        }
      } catch {
        // La fuente ya había terminado.
      }
    }

    function startTrack(kind, buffer) {
      const cfg = MUSIC[kind];
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = cfg.loop;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(cfg.gain, t + cfg.fadeIn);
      src.connect(g);
      g.connect(master);

      const track = { kind, src, g };
      src.onended = () => {
        try {
          g.disconnect();
        } catch {
          // Ya desconectado.
        }
        if (current === track) {
          current = null;
          if (!cfg.loop) lastFinished = kind;
        }
      };
      current = track;
      src.start(t);
    }

    /** Hace que suene lo que se pidió, cuando se pueda (contexto en marcha y pista cargada). */
    function syncMusic() {
      if (!musicOpts || disposed || hiddenSuspended || !canPlay()) return;
      if (!wanted) {
        stopCurrent(0.25);
        return;
      }
      if (current && current.kind === wanted) return;
      if (lastFinished === wanted) return; // la marcha ya sonó entera
      const buffer = buffers[wanted];
      if (!buffer) return; // se reintenta al terminar la carga
      stopCurrent(0.2);
      startTrack(wanted, buffer);
    }

    function playMusic(kind) {
      if (!musicOpts || disposed || !MUSIC[kind]) return;
      wanted = kind;
      lastFinished = null; // una petición explícita vuelve a reproducir
      loadMusic();
      syncMusic();
    }

    function stopMusic() {
      wanted = null;
      syncMusic();
    }

    /** La pestaña oculta pausa también el audio (el bucle del juego se detiene igualmente). */
    function setHidden(hidden) {
      if (disposed || injected || !ctx) return;
      if (hidden && ctx.state === "running") {
        hiddenSuspended = true;
        ctx.suspend().catch(() => {});
      } else if (!hidden && hiddenSuspended) {
        hiddenSuspended = false;
        ctx.resume().catch(() => {});
      }
    }

    function musicState() {
      if (disposed) return "off";
      if (!musicOpts) return "disabled";
      if (current) return "playing:" + current.kind;
      if (!wanted) return "idle";
      if (buffers[wanted]) return lastFinished === wanted ? "idle" : "waiting";
      return loaded ? "error" : "loading";
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
      stopCurrent(0);
      for (const key of Object.keys(buffers)) delete buffers[key];
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
      playMusic,
      stopMusic,
      setHidden,
      musicState,
      setMuted,
      toggleMute,
      isMuted: () => muted,
      state,
      dispose,
      // Solo para pruebas.
      debug: {
        get voices() { return voices; },
        get context() { return ctx; },
        get buffers() { return buffers; },
        musicReady: () => loading || Promise.resolve(),
        // Analizador conectado a la salida de la mezcla (música + efectos).
        tap() {
          if (!ctx || !master) return null;
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          master.connect(analyser);
          return analyser;
        }
      }
    };
  }

  WB.Audio = { create, CFG, MUSIC };
})();
