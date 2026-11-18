/*
 * audio.js — Efectos de sonido sintetizados con Web Audio.
 *
 * Sin archivos de audio ni dependencias: todo se genera con osciladores y
 * ruido filtrado.
 *
 *   bounce(kind)           "wall" | "paddle" | "target": clic corto de rebote.
 *   explosion(i)           i en [0.15, 1]: más grande = más larga y más grave.
 *   laser()                "pew" corto al disparar.
 *   pickup()               arpegio ascendente al recoger un objeto.
 *   levelUp()              fanfarria corta al pasar de nivel / destruir la web.
 *   playMusic(kind)        "game" (Arcade Kid, en bucle) | "gameover" (marcha fúnebre, una vez).
 *   playLevelMusic(level)  música chiptune procedural distinta para cada nivel arcade.
 *   stopMusic()            desvanece y para la música.
 *   stopLevelMusic()       detiene la música de nivel con fundido.
 *   musicState()           "idle" | "loading" | "waiting" | "playing:game" | "playing:gameover" |
 *                          "playing:level" | "error" | "disabled" | "off".
 *   setHidden(bool)        pausa/reanuda el audio con la visibilidad de la pestaña.
 *   toggleMute()           silencia / activa (tecla M en el juego).
 *   state()                "off" | "locked" | "on" | "muted" | "unavailable".
 *   tryStart()             crea el contexto solo si la página ya tuvo interacción.
 *   unlock()               crea/reanuda el contexto; llamar desde un gesto del usuario.
 *   dispose()              cierra el contexto y suelta todo.
 *
 * MÚSICA DE NIVEL (chiptune procedural)
 * Cada nivel arcade tiene su propio tema generado con osciladores Web Audio,
 * sin archivos adicionales. La melodía, el bajo y el arpeggio de acorde usan
 * escalas y patrones distintos según el grupo de nivel. Un bucle de
 * planificación repone notas cada 200 ms (ventana de anticipación de 0,3 s)
 * para encolar trabajo mínimo y reaccionar rápido a stop/mute. La música de
 * nivel coexiste con el sistema de pistas MP3 existente: "game" y "gameover"
 * siguen usando los mismos búferes.
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

  // ── Chiptune por nivel ────────────────────────────────────────────────────
  // Cada «tema» describe la escala, el tempo, las voces y la secuencia de la
  // melodía. Se elige según (level - 1) % LEVEL_THEMES.length para que el
  // ciclo al pasar del último nivel definido.
  //
  // freq(semitono) = 440 * 2^(semitono/12)   (A4 = semitono 0)
  // Los patrones son índices sobre la escala; -1 = silencio.
  // «bass» indica grado del acorde que sigue la voz de bajo.
  //
  // Gain de la música de nivel: 0,22 — un poco por debajo del MP3 de juego
  // (0,28) para que los efectos siempre estén por encima.
  function noteFreq(semitone) {
    return 440 * Math.pow(2, semitone / 12);
  }

  // Escalas: lista de semitonos relativos a la raíz (C3 = -21 sobre A4).
  const SCALES = {
    major:      [0, 2, 4, 5, 7, 9, 11, 12],
    minor:      [0, 2, 3, 5, 7, 8, 10, 12],
    dorian:     [0, 2, 3, 5, 7, 9, 10, 12],
    phrygian:   [0, 1, 3, 5, 7, 8, 10, 12],
    mixolydian: [0, 2, 4, 5, 7, 9, 10, 12],
    blues:      [0, 3, 5, 6, 7, 10, 12, 15]
  };


  // root: semitono sobre A4 de la nota raíz (C3 = -21).
  // Los temas se agrupan en conjuntos de 3 niveles por «mundo» para dar
  // sensación de progresión sin romper el bucle.


const LEVEL_THEMES = [
  // ==========================================
  // ARCADE CLASSICS
  // ==========================================

  // Nivel 1 — Tetris
  {
    name: 'Tetris',
    scale: 'minor',
    root: -21,
    bpm: 150,
    gain: 0.22,
    melody: [
      4, 0, 2, 3, 2, 0, 6, 6,
      2, 4, 6, 7, 6, 4, 3, 3,
      2, 0, 2, 4, 3, 2, 0, 6,
      6, 2, 4, 6, 7, 6, 4, 3
    ],
    melody2: [
      -1, -1, -1, -1, 0, -1, -1, -1,
      -1, -1, -1, -1, 2, -1, -1, -1,
      -1, -1, -1, -1, 0, -1, -1, -1,
      -1, -1, -1, -1, 2, -1, -1, -1
    ],
    bass: [
      0, -1, 0, -1, 4, -1, 4, -1,
      3, -1, 3, -1, 4, -1, 4, -1,
      0, -1, 0, -1, 4, -1, 4, -1,
      3, -1, 3, -1, 4, -1, 0, -1
    ],
    chord: [0, 3, 7]
  },

  // Nivel 2 — Ode to Joy (Beethoven)
  {
    name: 'Ode to Joy',
    scale: 'major',
    root: -19,
    bpm: 140,
    gain: 0.22,
    melody: [
      2, 2, 3, 4, 4, 3, 2, 0,
      0, 2, 2, 3, 3, 2, 2, -1,
      2, 2, 3, 4, 4, 3, 2, 0,
      0, 2, 0, -1, 0, -1, -1, -1
    ],
    melody2: [
      -1, -1, -1, 0, -1, -1, -1, -1,
      -1, -1, 0, -1, -1, -1, -1, -1,
      -1, -1, -1, 0, -1, -1, -1, -1,
      -1, -1, 4, -1, -1, -1, -1, -1
    ],
    bass: [
      0, -1, 0, -1, 4, -1, 4, -1,
      5, -1, 5, -1, 0, -1, 0, -1,
      0, -1, 0, -1, 4, -1, 4, -1,
      5, -1, 5, -1, 0, -1, 0, -1
    ],
    chord: [0, 4, 7]
  },

  // Nivel 3 — Canon in D (Pachelbel)
  {
    name: 'Canon in D',
    scale: 'major',
    root: -21,
    bpm: 115,
    gain: 0.22,
    melody: [
      4, 2, 3, 4, 2, 3, 4, 0,
      1, 2, 3, 4, 5, 6, 5, 4,
      3, 4, 2, 3, 4, 0, 1, 2,
      3, 4, 5, 4, 3, 2, 1, 0
    ],
    melody2: [
      -1, -1, -1, -1, 0, -1, -1, -1,
      -1, -1, -1, -1, 4, -1, -1, -1,
      -1, -1, -1, -1, 0, -1, -1, -1,
      -1, -1, -1, -1, 4, -1, -1, -1
    ],
    bass: [
      0, -1, -1, -1, 4, -1, -1, -1,
      5, -1, -1, -1, 2, -1, -1, -1,
      3, -1, -1, -1, 0, -1, -1, -1,
      4, -1, -1, -1, 0, -1, -1, -1
    ],
    chord: [0, 4, 7]
  },

  // Nivel 4 — In the Hall of the Mountain King (Grieg)
  {
    name: 'Mountain King',
    scale: 'minor',
    root: -17,
    bpm: 135,
    gain: 0.22,
    melody: [
      0, 2, 3, 4, 3, 2, 0, 2,
      3, 4, 3, 2, 0, 2, 3, 4,
      5, 4, 3, 2, 0, 2, 3, 4,
      3, 2, 0, 2, 3, 4, 3, 2
    ],
    melody2: [
      -1, -1, -1, -1, -1, -1, 0, -1,
      -1, -1, -1, -1, 0, -1, -1, -1,
      -1, -1, -1, -1, 0, -1, -1, -1,
      -1, -1, 0, -1, -1, -1, -1, -1
    ],
    bass: [
      0, -1, 0, -1, 0, -1, 0, -1,
      3, -1, 3, -1, 3, -1, 3, -1,
      4, -1, 4, -1, 4, -1, 4, -1,
      0, -1, 0, -1, 0, -1, 0, -1
    ],
    chord: [0, 3, 7]
  },

  // Nivel 5 — Jingle Bells
  {
    name: 'Jingle Bells',
    scale: 'major',
    root: -21,
    bpm: 155,
    gain: 0.22,
    melody: [
      2, 2, 2, -1, 2, 2, 2, -1,
      2, 4, 0, 1, 2, -1, -1, -1,
      3, 3, 3, 3, 3, 2, 2, 2,
      2, 1, 1, 2, 1, 4, -1, -1
    ],
    melody2: [
      -1, -1, -1, -1, 4, -1, -1, -1,
      -1, -1, -1, -1, 4, -1, -1, -1,
      -1, -1, -1, -1, 4, -1, -1, -1,
      -1, -1, -1, -1, 4, -1, -1, -1
    ],
    bass: [
      0, -1, 0, -1, 0, -1, 0, -1,
      4, -1, 4, -1, 0, -1, -1, -1,
      3, -1, 3, -1, 0, -1, 0, -1,
      4, -1, 4, -1, 0, -1, -1, -1
    ],
    chord: [0, 4, 7]
  },

  // Nivel 6 — Eine kleine Nachtmusik (Mozart)
  {
    name: 'Eine kleine Nachtmusik',
    scale: 'major',
    root: -17,
    bpm: 145,
    gain: 0.22,
    melody: [
      0, 4, 0, 2, 4, 2, 0, 4,
      0, 4, 0, 2, 4, 2, 0, 4,
      5, 4, 3, 2, 1, 0, 1, 2,
      3, 2, 1, 0, 4, 2, 0, -1
    ],
    melody2: [
      -1, -1, -1, -1, 4, -1, -1, -1,
      -1, -1, -1, -1, 4, -1, -1, -1,
      -1, -1, -1, -1, 4, -1, -1, -1,
      -1, -1, -1, -1, 4, -1, -1, -1
    ],
    bass: [
      0, -1, 0, -1, 4, -1, 4, -1,
      0, -1, 0, -1, 4, -1, 4, -1,
      5, -1, 5, -1, 2, -1, 2, -1,
      0, -1, 0, -1, 4, -1, 0, -1
    ],
    chord: [0, 4, 7]
  },

  // ==========================================
  // ORIGINAL ARCADE THEMES
  // ==========================================

  // Nivel 7 — Alegre, mayor, fácil
  {
    name: 'Happy Arcade',
    scale: 'major',
    root: -21,
    bpm: 155,
    gain: 0.22,
    melody: [
      0, 4, 7, 4, 9, 7, 4, -1,
      5, 9, 12, 9, 7, 5, 4, -1,
      0, 4, 7, 12, 11, 9, 7, 4,
      5, 7, 9, 7, 5, 4, 2, 0
    ],
    melody2: [
      -1, -1, -1, -1, 4, -1, -1, -1,
      -1, -1, 7, -1, 5, -1, -1, -1,
      -1, -1, 4, -1, 7, -1, 5, -1,
      -1, 4, -1, 2, -1, 0, -1, -1
    ],
    bass: [
      0, -1, 7, -1, 0, -1, 7, -1,
      5, -1, 12, -1, 5, -1, 7, -1,
      0, -1, 7, -1, 0, -1, 12, -1,
      5, -1, 7, -1, 4, -1, 7, -1
    ],
    chord: [0, 4, 7]
  },

  // Nivel 8 — Dorian: alegre y misterioso
  {
    name: 'Mystery Adventure',
    scale: 'dorian',
    root: -21,
    bpm: 148,
    gain: 0.22,
    melody: [
      0, 3, 5, 7, 5, 3, 2, -1,
      0, 3, 5, 7, 8, 7, 5, -1,
      3, 5, 7, 10, 8, 7, 5, 3,
      2, 3, 5, 7, 5, 3, 2, 0
    ],
    melody2: [
      -1, -1, -1, 3, -1, -1, -1, -1,
      -1, 5, -1, 3, -1, 5, -1, -1,
      -1, -1, 3, -1, 5, -1, 3, -1,
      -1, 3, -1, 5, -1, 2, -1, -1
    ],
    bass: [
      0, -1, 5, -1, 0, -1, 7, -1,
      0, -1, 5, -1, 0, -1, 7, -1,
      3, -1, 7, -1, 3, -1, 5, -1,
      0, -1, 5, -1, 7, -1, 0, -1
    ],
    chord: [0, 3, 7]
  },

  // Nivel 9 — Mixolydian: arcade clásico
  {
    name: 'Classic Arcade',
    scale: 'mixolydian',
    root: -19,
    bpm: 158,
    gain: 0.22,
    melody: [
      0, 4, 7, 9, 7, 4, 5, -1,
      7, 9, 12, 9, 7, 5, 4, -1,
      0, 4, 7, 12, 10, 9, 7, 5,
      4, 5, 7, 9, 7, 5, 4, 0
    ],
    melody2: [
      -1, -1, 4, -1, -1, 7, -1, -1,
      -1, 5, -1, 7, -1, 4, -1, -1,
      -1, 7, -1, 5, -1, 7, -1, 4,
      -1, -1, 5, -1, 4, -1, -1, -1
    ],
    bass: [
      0, -1, 7, -1, 0, -1, 5, -1,
      0, -1, 7, -1, 0, -1, 5, -1,
      4, -1, 7, -1, 4, -1, 5, -1,
      0, -1, 7, -1, 5, -1, 0, -1
    ],
    chord: [0, 4, 7]
  },

  // Nivel 10 — Minor: oscuro y dramático
  {
    name: 'Dark Quest',
    scale: 'minor',
    root: -24,
    bpm: 152,
    gain: 0.22,
    melody: [
      0, 3, 7, 5, 3, 0, 2, -1,
      3, 5, 8, 7, 5, 3, 0, -1,
      7, 8, 10, 8, 7, 5, 3, 2,
      0, 3, 5, 7, 5, 3, 2, 0
    ],
    melody2: [
      -1, -1, 3, -1, -1, 5, -1, -1,
      -1, 3, -1, 5, -1, 3, -1, -1,
      -1, 5, -1, 3, -1, 7, -1, 5,
      -1, -1, 3, -1, 5, -1, -1, -1
    ],
    bass: [
      0, -1, 7, -1, 3, -1, 5, -1,
      0, -1, 7, -1, 3, -1, 5, -1,
      0, -1, 5, -1, 3, -1, 7, -1,
      0, -1, 5, -1, 3, -1, 0, -1
    ],
    chord: [0, 3, 7]
  },

  // Nivel 11 — Phrygian: exótico y agresivo
  {
    name: 'Danger Zone',
    scale: 'phrygian',
    root: -22,
    bpm: 165,
    gain: 0.22,
    melody: [
      0, 1, 3, 7, 5, 3, 1, -1,
      0, 3, 5, 8, 7, 5, 3, -1,
      1, 3, 5, 7, 10, 8, 7, 5,
      3, 5, 7, 8, 7, 5, 3, 0
    ],
    melody2: [
      -1, -1, 3, -1, -1, 5, -1, -1,
      -1, 1, -1, 3, -1, 5, -1, -1,
      -1, 5, -1, 3, -1, 7, -1, 5,
      -1, 3, -1, 5, -1, 1, -1, -1
    ],
    bass: [
      0, -1, 5, -1, 0, -1, 7, -1,
      0, -1, 5, -1, 3, -1, 7, -1,
      0, -1, 5, -1, 3, -1, 7, -1,
      0, -1, 5, -1, 3, -1, 0, -1
    ],
    chord: [0, 3, 7]
  },

  // Nivel 12 — Blues: juguetón y sincopado
  {
    name: 'Blues Runner',
    scale: 'blues',
    root: -21,
    bpm: 160,
    gain: 0.22,
    melody: [
      0, 3, 5, 6, 7, 6, 5, -1,
      3, 5, 7, 10, 7, 6, 5, -1,
      0, 3, 6, 7, 10, 7, 6, 3,
      5, 6, 7, 10, 7, 5, 3, 0
    ],
    melody2: [
      -1, -1, 3, -1, -1, 5, -1, -1,
      -1, 6, -1, 7, -1, 5, -1, -1,
      -1, 5, -1, 3, -1, 7, -1, 5,
      -1, 3, -1, 6, -1, 5, -1, -1
    ],
    bass: [
      0, -1, 7, -1, 0, -1, 6, -1,
      0, -1, 7, -1, 3, -1, 6, -1,
      0, -1, 7, -1, 3, -1, 6, -1,
      0, -1, 7, -1, 5, -1, 0, -1
    ],
    chord: [0, 3, 7]
  },

  // Nivel 13 — Major: rápido, brillante y heroico
  {
    name: 'Heroic Journey',
    scale: 'major',
    root: -17,
    bpm: 174,
    gain: 0.22,
    melody: [
      7, 4, 2, 0, 2, 4, 7, -1,
      9, 7, 5, 4, 5, 7, 9, -1,
      12, 11, 9, 7, 5, 7, 9, 12,
      11, 9, 7, 5, 4, 2, 4, 7
    ],
    melody2: [
      -1, -1, 5, -1, -1, 7, -1, -1,
      -1, 5, -1, 7, -1, 9, -1, -1,
      -1, 7, -1, 9, -1, 7, -1, 5,
      -1, 7, -1, 5, -1, 4, -1, -1
    ],
    bass: [
      0, -1, 7, -1, 5, -1, 0, -1,
      0, -1, 7, -1, 5, -1, 0, -1,
      4, -1, 7, -1, 5, -1, 7, -1,
      0, -1, 7, -1, 5, -1, 0, -1
    ],
    chord: [0, 4, 7]
  },

  // Nivel 14 — Dorian: dramático e intenso
  {
    name: 'Final Battle',
    scale: 'dorian',
    root: -19,
    bpm: 180,
    gain: 0.22,
    melody: [
      0, 5, 7, 3, 2, 3, 5, -1,
      7, 8, 10, 8, 7, 5, 3, -1,
      0, 3, 5, 7, 10, 8, 7, 5,
      3, 5, 7, 8, 7, 5, 3, 0
    ],
    melody2: [
      -1, -1, 3, -1, -1, 5, -1, -1,
      -1, 7, -1, 5, -1, 3, -1, -1,
      -1, 5, -1, 3, -1, 7, -1, 5,
      -1, 3, -1, 5, -1, 2, -1, -1
    ],
    bass: [
      0, -1, 7, -1, 5, -1, 3, -1,
      0, -1, 7, -1, 5, -1, 3, -1,
      0, -1, 5, -1, 3, -1, 7, -1,
      0, -1, 7, -1, 5, -1, 0, -1
    ],
    chord: [0, 3, 7]
  },

  // Nivel 15 — Major: pre-boss, épico y acelerado
  {
    name: 'Boss Fight',
    scale: 'major',
    root: -21,
    bpm: 190,
    gain: 0.22,
    melody: [
      0, 4, 7, 9, 12, 9, 7, -1,
      5, 7, 9, 11, 12, 11, 9, -1,
      7, 9, 12, 14, 12, 11, 9, 7,
      5, 7, 9, 12, 11, 9, 7, 0
    ],
    melody2: [
      -1, -1, 4, -1, -1, 7, -1, -1,
      -1, 5, -1, 7, -1, 9, -1, -1,
      -1, 7, -1, 9, -1, 7, -1, 5,
      -1, 4, -1, 7, -1, 5, -1, -1
    ],
    bass: [
      0, -1, 7, -1, 0, -1, 5, -1,
      4, -1, 7, -1, 5, -1, 0, -1,
      0, -1, 7, -1, 4, -1, 5, -1,
      0, -1, 7, -1, 5, -1, 0, -1
    ],
    chord: [0, 4, 7]
  }
]



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
      levelUp: noop,
      playMusic: noop,
      stopMusic: noop,
      playLevelMusic: noop,
      stopLevelMusic: noop,
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

    // Música de nivel (chiptune procedural)
    let lvlGain = null;
    let lvlTheme = null;
    let lvlScheduleId = null;
    let lvlNextBeat = 0;
    let lvlBeat = 0;
    let lvlActive = false;

    function build() {
      master = ctx.createGain();
      master.gain.value = muted ? 0 : CFG.master;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;

      // Limitador suave.
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

    function themeFor(level) {
      return LEVEL_THEMES[(level - 1) % LEVEL_THEMES.length];
    }

    function scaleFreq(theme, degree, octave) {
      const sc = SCALES[theme.scale];
      const semi = theme.root +
      sc[degree % sc.length] +
      Math.floor(degree / sc.length) * 12 +
      (octave || 0) * 12

      return noteFreq(semi);
    }

    function scheduleBeat(t, stepDur) {
      if (!lvlTheme || !master || !lvlGain) return

      const th = lvlTheme
      const beat = lvlBeat
      const step = beat % th.melody.length

      /**
       * Programa una nota chiptune.
       * Permite controlar duración, volumen y pitch bend.
       */
      function playNote({
        type = 'square',
        freq,
        time = t,
        duration = stepDur,
        volume = 0.1,
        bend = 0,
        octave = 0
      }) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()

        const startFreq = freq * (1 + bend)

        osc.type = type
        osc.frequency.setValueAtTime(startFreq, time)
        osc.frequency.linearRampToValueAtTime(
          freq,
          time + Math.min(0.035, duration * 0.25)
        )

        gain.gain.setValueAtTime(0.0001, time)
        gain.gain.linearRampToValueAtTime(volume, time + 0.006)
        gain.gain.setValueAtTime(volume, time + duration * 0.65)
        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          time + duration
        )

        osc.connect(gain)
        gain.connect(lvlGain)

        osc.start(time)
        osc.stop(time + duration + 0.01)
      }

      // ── 1. Melodía principal ─────────────────────────────────

      const melodyDegree = th.melody[step]

      if (melodyDegree >= 0) {
        const freq = scaleFreq(th, melodyDegree, 1)

        // Variación de duración para evitar que todas las notas suenen iguales.
        const durationMultiplier = [
          0.9, 0.55, 0.75, 0.45,
          1.2, 0.55, 0.8, 0.4
        ][step % 8]

        const duration = stepDur * durationMultiplier

        // Algunas notas tienen un pequeño deslizamiento de frecuencia.
        const bend = step % 4 === 0 ? 0.035 : 0

        playNote({
          type: 'square',
          freq,
          duration,
          volume: step % 4 === 0 ? 0.14 : 0.105,
          bend
        })
      }

      // ── 2. Segunda voz ───────────────────────────────────────

      if (th.melody2) {
        const secondDegree = th.melody2[step % th.melody2.length]

        if (secondDegree >= 0) {
          playNote({
            type: 'square',
            freq: scaleFreq(th, secondDegree, 2),
            duration: stepDur * 0.65,
            volume: 0.045,
            bend: 0.015
          })
        }
      }

      // ── 3. Bajo ──────────────────────────────────────────────

      const bassDegree = th.bass[step % th.bass.length]

      if (bassDegree >= 0) {
        const bassFreq = scaleFreq(th, bassDegree, -1)

        playNote({
          type: 'triangle',
          freq: bassFreq,
          duration: stepDur * (step % 4 === 0 ? 1.8 : 1.15),
          volume: step % 4 === 0 ? 0.2 : 0.14
        })
      }

      // ── 4. Arpegio rápido ────────────────────────────────────

      const chord = th.chord
      const chordIndex = step % chord.length
      const chordDegree = chord[chordIndex]

      // Alternamos octavas para darle más movimiento.
      const chordOctave = step % 4 === 0 ? 1 : 0

      playNote({
        type: 'sawtooth',
        freq: scaleFreq(th, chordDegree, chordOctave),
        duration: stepDur * 0.38,
        volume: 0.035
      })

      // Nota adicional entre pulsos para crear un arpegio más arcade.
      if (step % 2 === 0) {
        const nextChordDegree = chord[(chordIndex + 1) % chord.length]

        playNote({
          type: 'square',
          freq: scaleFreq(th, nextChordDegree, 1),
          time: t + stepDur * 0.5,
          duration: stepDur * 0.28,
          volume: 0.025
        })
      }

      // ── 5. Variación ocasional ───────────────────────────────

      // Cada 16 pasos añadimos una pequeña nota aguda.
      if (step % 16 === 15) {
        playNote({
          type: 'square',
          freq: scaleFreq(th, 7, 2),
          time: t + stepDur * 0.45,
          duration: stepDur * 0.35,
          volume: 0.055,
          bend: 0.04
        })
      }
    }

    const LVL_LOOKAHEAD = 0.3;

    function lvlScheduleTick() {
      if (!lvlActive || !canPlay() || !lvlTheme || !lvlGain) return

      const th = lvlTheme
      const stepDur = 60 / th.bpm / 2
      const horizon = ctx.currentTime + LVL_LOOKAHEAD

      while (lvlNextBeat < horizon) {
        scheduleBeat(lvlNextBeat, stepDur)

        lvlBeat = (lvlBeat + 1) % th.melody.length
        lvlNextBeat += stepDur
      }
    }

    function startLevelMusic(theme) {
      stopLevelMusicInternal(0.15);
      if (!ensure()) return;

      lvlTheme = theme;
      lvlActive = true;
      lvlBeat = 0;
      lvlNextBeat = ctx.currentTime + 0.05;

      lvlGain = ctx.createGain();
      lvlGain.gain.setValueAtTime(0.0001, ctx.currentTime);
      lvlGain.gain.linearRampToValueAtTime(theme.gain, ctx.currentTime + 0.5);
      lvlGain.connect(master);

      lvlScheduleTick();
      lvlScheduleId = setInterval(lvlScheduleTick, 200);
    }

    function stopLevelMusicInternal(fade) {
      lvlActive = false;
      if (lvlScheduleId !== null) {
        clearInterval(lvlScheduleId);
        lvlScheduleId = null;
      }
      const gain = lvlGain;
      lvlGain = null;
      lvlTheme = null;
      if (!gain || !ctx) return;
      try {
        const t = ctx.currentTime;
        const fadeDur = fade > 0 ? fade : 0;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        if (fadeDur > 0) {
          gain.gain.linearRampToValueAtTime(0.0001, t + fadeDur);
          setTimeout(() => {
            try {
              gain.disconnect();
            } catch {
              /**/
            }
          }, (fadeDur + 0.1) * 1000);
        } else {
          try {
            gain.disconnect();
          } catch {
            /**/
          }
        }
      } catch {
        /**/
      }
    }

    function playLevelMusic(level) {
      if (!musicOpts || disposed) return;
      if (wanted) {
        wanted = null;
        stopCurrent(0.2);
      }
      startLevelMusic(themeFor(level));
    }

    function stopLevelMusic() {
      stopLevelMusicInternal(0.3);
    }

    // Corrección: declaración de la función que decodifica las pistas MP3.
    function decodeMusic(arrayBuffer) {
      if (injected) return ctx.decodeAudioData(arrayBuffer);
      const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (Offline) return new Offline(2, 1, MUSIC_RATE).decodeAudioData(arrayBuffer);
      if (!ensure()) return Promise.reject(new Error("sin AudioContext"));
      return ctx.decodeAudioData(arrayBuffer);
    }

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

    function syncMusic() {
      if (!musicOpts || disposed || hiddenSuspended || !canPlay()) return;
      if (!wanted) {
        stopCurrent(0.25);
        return;
      }
      if (current && current.kind === wanted) return;
      if (lastFinished === wanted) return;
      const buffer = buffers[wanted];
      if (!buffer) return;
      stopCurrent(0.2);
      startTrack(wanted, buffer);
    }

    function playMusic(kind) {
      if (!musicOpts || disposed || !MUSIC[kind]) return;
      stopLevelMusicInternal(0.2);
      wanted = kind;
      lastFinished = null;
      loadMusic();
      syncMusic();
    }

    function stopMusic() {
      stopLevelMusicInternal(0.2);
      wanted = null;
      syncMusic();
    }

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
      if (lvlActive) return "playing:level";
      if (current) return "playing:" + current.kind;
      if (!wanted) return "idle";
      if (buffers[wanted]) return lastFinished === wanted ? "idle" : "waiting";
      return loaded ? "error" : "loading";
    }

    function levelUp() {
      if (!canPlay() || muted || voices >= CFG.maxVoices) return;
      const k = crowd();
      tone("square", 392, 392, 0.1, 0.17 * k, 0);
      tone("square", 494, 494, 0.1, 0.17 * k, 0.1);
      tone("square", 587, 587, 0.1, 0.17 * k, 0.2);
      const last = tone("square", 784, 784, 0.22, 0.2 * k, 0.3);
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
      stopLevelMusicInternal(0);
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
      levelUp,
      playMusic,
      stopMusic,
      playLevelMusic,
      stopLevelMusic,
      setHidden,
      musicState,
      setMuted,
      toggleMute,
      isMuted: () => muted,
      state,
      dispose,
      debug: {
        get voices() {
          return voices;
        },
        get context() {
          return ctx;
        },
        get buffers() {
          return buffers;
        },
        musicReady: () => loading || Promise.resolve(),
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