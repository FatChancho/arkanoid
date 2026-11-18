/*
 * game.js — Motor del juego.
 *
 * Responsabilidades:
 *  - Canvas de juego y su ciclo de vida (crear, redimensionar, retirar).
 *  - Pelotas, pala, vidas, puntuación, Game Over, victoria y reinicio.
 *  - Objetos (power-ups) que caen según la puntuación y sus efectos.
 *  - Entrada de teclado, ratón y táctil.
 *  - Efectos: fragmentos (trozos de la captura), polvo y sonido (audio.js).
 *  - Banner retro de progreso, fuera del tablero.
 *
 * El escenario (captura con lo destruido borrado) lo pinta la capa de
 * escena de destruction.js; las regiones y la colisión las resuelve el motor
 * de destrucción. Este módulo solo les pregunta y les ordena.
 *
 * COORDENADAS Y BANNER
 * El juego trabaja en un "escenario" del tamaño del viewport en el momento de
 * la captura. El banner (puntos, vidas, progreso, efectos) ocupa una franja
 * superior FUERA del tablero, así que nunca tapa la página: el escenario se
 * escala de forma uniforme para caber debajo del banner (con un marco retro y
 * barras oscuras si cambia la proporción). Esto también cubre el
 * redimensionado de la ventana, porque la captura no se puede repetir desde
 * la página. El canvas se ajusta siempre a devicePixelRatio.
 *
 * La tipografía del banner es una fuente de píxeles 5x7 propia dibujada con
 * rectángulos: no depende de fuentes del sistema ni de la página.
 *
 * FÍSICA
 * Paso fijo de 1/60 s (la velocidad no depende de los Hz del monitor) y
 * subpasos de como mucho 3,5 px. La velocidad de cada pelota es constante.
 * Un contacto de una pelota con un objetivo destruye como mucho UNA región, y
 * tras un impacto esa pelota tiene un bloqueo de 3 subpasos en los que rebota
 * sin dañar, para que un mismo golpe no se lleve varios objetivos contiguos.
 *
 * RATÓN CAPTURADO (POINTER LOCK)
 * El primer clic captura el ratón con la API de bloqueo del puntero: el cursor
 * se oculta y no puede salir de la ventana, y el juego recibe solo movimiento
 * RELATIVO del que usa únicamente el eje horizontal (el vertical se ignora).
 * Así la pala sigue respondiendo aunque muevas el ratón mucho más allá del
 * borde de la ventana. `movementX` llega en píxeles CSS (también con DPR 2) y
 * se divide por la escala del tablero para que la pala siga al ratón 1:1.
 * Defensa contra saltos espurios: algunos navegadores/plataformas emiten un
 * `movementX` enorme justo al conceder la captura (la pala saltaría al borde y
 * se perdería la bola). Se ignora el movimiento durante `lockSettleMs` tras
 * la captura y los eventos sueltos con |movementX| mayor que
 * max(lockMinJump, 45 % del ancho de la ventana). Entre que se pide la captura
 * y se concede (`lockPendingMs` como máximo) también se ignora el movimiento
 * absoluto: algunos navegadores llevan el cursor a (0, 0) en ese intervalo y la
 * pala saltaría al borde izquierdo.
 * Si se pierde la captura (Esc, cambio de pestaña...), reaparece el cursor, la
 * pala vuelve al control absoluto y un aviso pide un clic para recapturar.
 * Esc con el ratón capturado solo lo libera; otra pulsación sale del juego.
 * Sin soporte (iframe sin permiso, etc.) todo sigue con el control absoluto.
 *
 * MODO ARCADE
 * Al destruir toda la web (en vez de terminar) empieza el modo arcade: niveles
 * de ladrillos generados por arcade.js. Cada nivel es un "mundo" nuevo (lienzo
 * + motor de destrucción + capa de escena) que sustituye al de la web; la
 * puntuación y las vidas continúan. Estado "clear": 2,5 s de pantalla de
 * transición (web destruida / nivel superado), sin física. Cada nivel sube la
 * velocidad de la bola un 5 % (tope x1,6). Los ladrillos dan sus propios
 * puntos (plateado: 2 golpes; dorado: indestructible) y los objetos caen de
 * ladrillos al azar (`arcadeDropChance`), no por puntuación. Tras un Game Over
 * se vuelve a empezar desde la web. `arcade: false` recupera el final clásico.
 *
 * PAUSA AUTOMÁTICA
 * Si el ratón NO está capturado (la captura falló o se perdió), el cursor es
 * visible y puede salir de la ventana —por ejemplo, a otro monitor—, momento en
 * que la pala deja de recibir movimiento. Para no costar la bola, la partida
 * se pausa cuando: se pierde la captura (Esc, otra ventana...), el cursor sale
 * de la ventana, la ventana pierde el foco o la pestaña se oculta. Solo si la
 * bola está en juego y el último control usado fue el ratón (con flechas no
 * se pausa por mover el ratón). Se sale con un clic, que además recaptura el
 * ratón, o con Espacio. `autoPause: false` lo desactiva.
 *
 * SAQUE
 * La bola espera pegada a la pala hasta que el jugador la lanza con un clic
 * (o con Espacio, o tocando la pantalla). Vale para el saque inicial y para el
 * de después de perder una vida. `serveWaitsForClick: false` recupera el saque
 * automático tras `serveDelaySteps` pasos.
 *
 * REVELAR BLOQUES
 * La tecla B alterna un resaltado rojo con desenfoque sobre las regiones que
 * quedan vivas (las mismas que usa la colisión): un halo que sale por fuera del
 * borde y un tinte suave en el interior, para no tapar el contenido. Se pinta
 * en una capa en caché, a media resolución, que solo se reconstruye cuando se
 * destruye algo.
 *
 * OBJETOS (POWER-UPS)
 * Cada `powerupEvery` puntos (150 por defecto: unos 3 objetos en una página de
 * 40 regiones, 1 en una de 14) cae un objeto desde el lugar del impacto que
 * cruzó el umbral. Los tipos salen de una "bolsa" barajada, así que cada
 * cuatro objetos aparecen los cuatro tipos:
 *   - multiball: cada pelota se triplica (±22° respecto a su trayectoria),
 *                hasta `maxBalls` pelotas.
 *   - wide:      la pala pasa de 110 a 190 px durante 20 s.
 *   - bigball:   el radio de TODAS las bolas pasa de 7 a 13 px durante 20 s
 *                (también el de las que nazcan mientras dure). Toca antes los
 *                bloques y es más fácil de recoger con la pala; sigue
 *                destruyendo una sola región por contacto.
 *   - laser:     durante 15 s dispara SOLO, sin pulsar nada: dos proyectiles
 *                desde los extremos de la pala cada 24 pasos (0,4 s). Cada
 *                proyectil destruye como mucho una región, igual que la
 *                pelota.
 * Perder una vida o reiniciar elimina los efectos y los objetos en caída.
 * Recoger un objeto del mismo tipo reinicia su temporizador (no se acumulan).
 * `powerupEvery: 0` desactiva los objetos.
 */
(() => {
  "use strict";

  const WB = (globalThis.__WebBreakout = globalThis.__WebBreakout || {});

  const CONFIG = {
    paddleWidth: 110,
    paddleHeight: 12,
    paddleBottom: 28,
    paddleSpeed: 7,
    ballRadius: 7,
    ballSpeed: 12,
    maxLives: 3,
    serveDelaySteps: 40,
    serveWaitsForClick: true,
    pointerLock: true,
    autoPause: true,

    // Modo arcade
    arcade: true,
    clearSteps: 150,
    levelBonus: 500,
    arcadeDropChance: 0.07,
    speedPerLevel: 0.05,
    maxSpeedFactor: 1.6,
    mouseSensitivity: 1,
    lockEscGraceMs: 400,
    lockSettleMs: 150,
    lockPendingMs: 300,
    lockMinJump: 300,
    revealBlur: 5,
    hitLockSubsteps: 3,
    maxSubstepDistance: 3.5,
    maxStepsPerFrame: 3,
    minVerticalRatio: 0.22,
    maxPaddleAngle: 1.05,
    maxFragments: 260,
    maxDust: 160,
    dustPerHit: 10,
    scorePerRegion: 10,
    scoreTargetBonus: 20,
    destroyColor: "#18202b",
    canvasId: "webbreakout-game-canvas",

    // Objetos
    powerupEvery: 150,
    itemFallSpeed: 2.6,
    itemWidth: 36,
    itemHeight: 18,
    widePaddleWidth: 190,
    paddleEase: 0.22,
    wideSteps: 1200,
    laserSteps: 900,
    maxBalls: 9,
    bigBallRadius: 20,
    bigBallSteps: 1200,
    ballEase: 0.25,
    splitAngle: 0.38,
    laserCooldownSteps: 24,
    boltSpeed: 11,
    boltStep: 3.7,
    boltRadius: 2
  };

  const STEP_MS = 1000 / 60;
  const GAME_KEYS = new Set(["ArrowLeft", "ArrowRight", " ", "a", "d", "r", "m", "b"]);

  const ITEM_TYPES = ["multiball", "wide", "laser", "bigball"];
  const ITEM_COLORS = { multiball: "#ffd166", wide: "#35d9ff", laser: "#ff5d73", bigball: "#5be37d" };
  const ITEM_LABELS = { multiball: "BOLA TRIPLE", wide: "BARRA GRANDE", laser: "LÁSER AUTOMÁTICO", bigball: "BOLA GRANDE" };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }


  const INK = "#10131a";

  /* Fuente de píxeles 5x7 (solo mayúsculas, dígitos y la puntuación necesaria). */
  const FONT_ROWS = {
    A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
    H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
    J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
    K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
    R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
    0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
    "%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
    "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
    "¡": ["00100", "00000", "00100", "00100", "00100", "00100", "00100"],
    "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"]
  };
  const ACCENTED = { "Á": "A", "É": "E", "Í": "I", "Ó": "O", "Ú": "U" };
  const GLYPHS = {};
  for (const [ch, rows] of Object.entries(FONT_ROWS)) {
    const dots = [];
    rows.forEach((row, y) => {
      for (let x = 0; x < 5; x++) if (row[x] === "1") dots.push([x, y]);
    });
    GLYPHS[ch] = dots;
  }
  const HEART = ["0110110", "1111111", "1111111", "0111110", "0011100", "0001000"];

  /** Ancho que avanza una cadena (5 columnas + 1 de separación por letra). */
  function textAdvance(str, px) {
    return str.length * 6 * px;
  }

  function textWidth(str, px) {
    return str.length ? textAdvance(str, px) - px : 0;
  }

  function textPass(ctx, str, x, y, px, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    let cx = x;
    for (const raw of str) {
      const ch = raw.toUpperCase();
      const base = ACCENTED[ch] || ch;
      const dots = GLYPHS[base];
      if (dots) {
        for (const [gx, gy] of dots) ctx.rect(cx + gx * px, y + gy * px, px, px);
        if (ACCENTED[ch]) {
          ctx.rect(cx + 3 * px, y - 2 * px, px, px);
          ctx.rect(cx + 2 * px, y - px, px, px);
        }
      }
      cx += 6 * px;
    }
    ctx.fill();
  }

  /** Dibuja texto de píxeles; con `shadow` añade una sombra desplazada. */
  function drawText(ctx, str, x, y, px, color, shadow) {
    if (shadow) textPass(ctx, str, x + px, y + px, px, shadow);
    textPass(ctx, str, x, y, px, color);
  }

  function drawHeart(ctx, x, y, px, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    HEART.forEach((row, gy) => {
      for (let gx = 0; gx < 7; gx++) if (row[gx] === "1") ctx.rect(x + gx * px, y + gy * px, px, px);
    });
    ctx.fill();
  }

  /**
   * options = { engine, sceneLayer, image, stage:{width,height},
   *             config?, audio?, onExit?, onError? }
   */
  function create(options) {
    const cfg = Object.assign({}, CONFIG, options.config || {});
    // Mundo actual: la captura de la web o, en el modo arcade, el nivel en curso.
    let engine = options.engine;
    let sceneLayer = options.sceneLayer;
    let image = options.image;
    const web = { engine, sceneLayer, image };
    const W = options.stage.width;
    const H = options.stage.height;

    const g = {
      active: false,
      state: "playing", // playing | clear | gameover | won
      mode: "web", // web | arcade
      level: 0,
      speed: cfg.ballSpeed,
      arcadeWorld: null,
      clearUntil: 0,
      clearKind: "web",
      intro: null,
      canvas: null,
      ctx: null,
      raf: 0,
      last: 0,
      acc: 0,
      score: 0,
      lives: cfg.maxLives,
      paddleX: W / 2,
      paddleW: cfg.paddleWidth,
      mouseX: null,
      inputMode: "mouse",
      balls: [],
      items: [],
      bolts: [],
      effects: { wide: 0, laser: 0, big: 0 },
      cooldown: 0,
      tick: 0,
      flash: { steps: 0, color: "#ffffff" },
      toasts: [],
      patterns: null,
      bannerInfo: null,
      reveal: { on: false, dirty: true, layer: null, sharp: null },
      lock: { wasActive: false, everLocked: false, lostAt: -1e9, acquiredAt: -1e9, pendingUntil: 0, ignored: 0, failures: 0 },
      pause: { on: false, outside: false },
      nextPowerup: cfg.powerupEvery,
      bag: [],
      spawned: 0,
      spawnLog: [],
      lastBoltHit: null,
      keys: new Set(),
      audio: null,
      fragments: [],
      dust: [],
      view: { scale: 1, offsetX: 0, offsetY: 0, dpr: 1, vw: 0, vh: 0, bannerH: 0, ui: 1 }
    };
    const removers = [];

    /* ---------------- Utilidades ---------------- */

    function paddleY() {
      return H - cfg.paddleBottom - cfg.paddleHeight;
    }

    function toStageX(clientX) {
      return (clientX - g.view.offsetX) / g.view.scale;
    }

    function toStageY(clientY) {
      return (clientY - g.view.offsetY) / g.view.scale;
    }

    function listen(target, type, handler, opts) {
      target.addEventListener(type, handler, opts);
      removers.push(() => target.removeEventListener(type, handler, opts));
    }

    /** Los efectos de sonido nunca deben poder romper el juego. */
    function sfx(name, arg) {
      if (g.audio && typeof g.audio[name] === "function") g.audio[name](arg);
    }

    function unlockAudio() {
      if (g.audio) g.audio.unlock();
    }

    function lockActive() {
      return Boolean(g.canvas) && document.pointerLockElement === g.canvas;
    }

    /** Cursor oculto solo si está capturado (si no, hay que poder verlo). */
    function setCursor() {
      if (g.canvas) g.canvas.style.cursor = g.state === "playing" && lockActive() ? "none" : "default";
    }

    /** El navegador no puede (o no quiere) capturar el ratón: no insistir ni avisar. */
    function lockUnsupported() {
      return (
        !g.canvas ||
        typeof g.canvas.requestPointerLock !== "function" ||
        (!g.lock.everLocked && g.lock.failures >= 2)
      );
    }

    /** Pausa solo si la bola está en juego y se juega con el ratón. */
    function pauseEligible() {
      return cfg.autoPause && g.state === "playing" && !waitingForLaunch() && g.inputMode === "mouse";
    }

    function pauseGame() {
      if (g.pause.on) return;
      g.pause.on = true;
      g.keys.clear();
    }

    function resumeGame() {
      g.pause.on = false;
      g.pause.outside = false;
    }

    /** Debe llamarse desde un gesto del usuario (clic o tecla). */
    function requestLock() {
      if (!cfg.pointerLock || !g.canvas || lockActive()) return;
      if (typeof g.canvas.requestPointerLock !== "function") return;
      g.lock.pendingUntil = performance.now() + cfg.lockPendingMs;
      try {
        const result = g.canvas.requestPointerLock();
        if (result && typeof result.catch === "function") {
          result.catch(() => {
            g.lock.pendingUntil = 0; // rechazada: vuelve el control absoluto
            g.lock.failures++;
          });
        }
      } catch {
        g.lock.pendingUntil = 0;
        g.lock.failures++;
        // Sin permiso o sin soporte: se sigue con el control absoluto.
      }
    }

    function releaseLock() {
      try {
        if (document.pointerLockElement && document.pointerLockElement === g.canvas) {
          document.exitPointerLock();
        }
      } catch {
        // Ya liberado.
      }
    }

    function onLockChange() {
      const active = lockActive();
      g.lock.pendingUntil = 0;
      if (active) {
        g.lock.everLocked = true;
        g.lock.failures = 0;
        g.lock.acquiredAt = performance.now();
        g.mouseX = g.paddleX; // sin saltos al capturar
        g.inputMode = "mouse";
        resumeGame();
      } else if (g.lock.wasActive) {
        g.lock.lostAt = performance.now();
        if (pauseEligible()) pauseGame(); // se soltó el ratón (Esc, otra ventana...): pausa
      }
      g.lock.wasActive = active;
      setCursor();
    }

    /* ---------------- Canvas ---------------- */

    function createCanvas() {
      const canvas = document.createElement("canvas");
      canvas.id = cfg.canvasId;
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "WebBreakout: juego sobre la página. Pulsa Escape para salir.");
      Object.assign(canvas.style, {
        position: "fixed",
        left: "0",
        top: "0",
        zIndex: "2147483647",
        display: "block",
        margin: "0",
        padding: "0",
        border: "0",
        pointerEvents: "auto",
        touchAction: "none",
        userSelect: "none",
        background: cfg.destroyColor
      });
      document.documentElement.appendChild(canvas);
      g.canvas = canvas;
      g.ctx = canvas.getContext("2d");
      g.patterns = {
        dots: makePattern(8, 8, (c) => {
          c.fillStyle = "#0b0f1a";
          c.fillRect(0, 0, 8, 8);
          c.fillStyle = "#151d31";
          c.fillRect(0, 0, 2, 2);
        }),
        scan: makePattern(1, 4, (c) => {
          c.fillStyle = "rgba(0,0,0,0.3)";
          c.fillRect(0, 3, 1, 1);
        })
      };
      setCursor();
    }

    function makePattern(w, h, paint) {
      const tile = document.createElement("canvas");
      tile.width = w;
      tile.height = h;
      paint(tile.getContext("2d"));
      return g.ctx.createPattern(tile, "repeat");
    }

    function resize() {
      if (!g.canvas) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      g.canvas.style.width = vw + "px";
      g.canvas.style.height = vh + "px";
      g.canvas.width = Math.max(1, Math.round(vw * dpr));
      g.canvas.height = Math.max(1, Math.round(vh * dpr));

      // Banner fuera del tablero: el escenario se escala para caber debajo de
      // él (con 6 px de margen para el marco).
      const ui = vw >= 1000 ? 2 : 1;
      const bannerH = ui === 2 ? 64 : 34;
      const availH = Math.max(1, vh - bannerH);
      const scale = Math.max(0.05, Math.min((vw - 12) / W, (availH - 12) / H));
      g.view = {
        scale,
        offsetX: (vw - W * scale) / 2,
        offsetY: bannerH + (availH - H * scale) / 2,
        dpr,
        vw,
        vh,
        bannerH,
        ui
      };
    }

    /* ---------------- Estado ---------------- */

    function ballRadiusTarget() {
      return g.effects.big > 0 ? cfg.bigBallRadius : cfg.ballRadius;
    }

    function newBall(x, y, vx, vy) {
      return { x, y, vx, vy, r: ballRadiusTarget(), serve: 0, lock: 0, lost: false };
    }

    function spawnBall() {
      const angle = (Math.random() - 0.5) * 1.0;
      const b = newBall(
        g.paddleX,
        paddleY() - ballRadiusTarget() - 1,
        Math.sin(angle) * g.speed,
        -Math.cos(angle) * g.speed
      );
      // Espera pegada a la pala hasta el clic (Infinity no se agota nunca).
      b.serve = cfg.serveWaitsForClick ? Infinity : cfg.serveDelaySteps;
      g.balls = [b];
    }

    /** Lanza las bolas que esperan en la pala. Devuelve si lanzó alguna. */
    function launchBall() {
      if (g.state !== "playing") return false;
      let launched = false;
      for (const b of g.balls) {
        if (b.serve > 0) {
          b.serve = 0;
          launched = true;
        }
      }
      return launched;
    }

    function waitingForLaunch() {
      return g.state === "playing" && g.balls.some((b) => b.serve > 0);
    }

    /** Quita efectos, objetos en caída y proyectiles (vida perdida o reinicio). */
    function resetPowerups() {
      g.items = [];
      g.bolts = [];
      g.effects.wide = 0;
      g.effects.laser = 0;
      g.effects.big = 0;
      g.cooldown = 0;
      g.flash.steps = 0;
      g.paddleW = cfg.paddleWidth;
    }

    function restart() {
      if (g.mode === "arcade") {
        // Tras un Game Over del arcade:
        // - en modo arcade puro vuelve al nivel 1 del arcade,
        // - en modo web vuelve a empezar desde la web.
        if (options.startMode === "arcade") {
          disposeArcadeWorld();
          g.level = 0;
          g.speed = cfg.ballSpeed;
          g.intro = null;
        } else {
          disposeArcadeWorld();
          enterWorld(web);
          g.mode = "web";
          g.level = 0;
          g.speed = cfg.ballSpeed;
          g.intro = null;
        }
      }
      engine.reset();
      sceneLayer.reset();
      g.reveal.dirty = true;
      resumeGame();
      g.score = 0;
      g.lives = cfg.maxLives;
      g.fragments = [];
      g.dust = [];
      g.state = "playing";
      g.keys.clear();
      g.nextPowerup = cfg.powerupEvery;
      g.bag = [];
      resetPowerups();
      if (options.startMode === "arcade" && arcadeAvailable()) {
        startLevel(1);
      } else {
        spawnBall();
        setCursor();
        sfx("playMusic", "game");
      }
    }

    function loseLife() {
      g.lives--;
      resetPowerups();
      if (g.lives <= 0) {
        g.lives = 0;
        g.state = "gameover";
        g.balls = [];
        setCursor();
        sfx("playMusic", "gameover"); // la marcha fúnebre sustituye a la música de juego
        return;
      }
      spawnBall();
    }

    function finishGame() {
      g.state = "won";
      g.balls = [];
      g.items = [];
      g.bolts = [];
      setCursor();
    }

    /* ---------------- Modo arcade ---------------- */

    function arcadeAvailable() {
      return cfg.arcade && WB.Arcade && WB.Destruction;
    }

    function enterWorld(world) {
      engine = world.engine;
      sceneLayer = world.sceneLayer;
      image = world.image;
      g.reveal.dirty = true;
      g.reveal.layer = null;
      g.reveal.sharp = null;
    }

    function disposeArcadeWorld() {
      if (!g.arcadeWorld) return;
      g.arcadeWorld.sceneLayer.dispose();
      g.arcadeWorld.image.width = 0;
      g.arcadeWorld.image.height = 0;
      g.arcadeWorld = null;
    }

    /** Lienzo del nivel + motor + capa de escena, por la misma tubería que la captura de la web. */
    function buildArcadeWorld(level) {
      const ds = Math.max(1, Math.min(2, Math.ceil(window.devicePixelRatio || 1)));
      const data = WB.Arcade.build(level, { width: W, height: H }, { scale: ds });
      const sampler = WB.Destruction.createSampler({ image: data.canvas, stageWidth: W, stageHeight: H });
      const eng = WB.Destruction.createEngine({
        width: W,
        height: H,
        targets: data.targets,
        sampler,
        playAreaBottom: H - cfg.paddleBottom - cfg.paddleHeight
      });
      const layer = WB.Destruction.createSceneLayer({ image: data.canvas, stageWidth: W, stageHeight: H });
      return { engine: eng, sceneLayer: layer, image: data.canvas, data };
    }

    function speedForLevel(level) {
      return cfg.ballSpeed * Math.min(cfg.maxSpeedFactor, 1 + cfg.speedPerLevel * (level - 1));
    }

    function startLevel(level) {
      disposeArcadeWorld();
      g.arcadeWorld = buildArcadeWorld(level);
      enterWorld(g.arcadeWorld);
      g.mode = "arcade";
      g.level = level;
      g.speed = speedForLevel(level);
      g.state = "playing";
      g.fragments = [];
      g.dust = [];
      g.toasts = [];
      resetPowerups();
      spawnBall();
      g.intro = { until: g.tick + 210, level, name: g.arcadeWorld.data.name };
      sfx("playLevelMusic", level);
      resumeGame();
      setCursor();
    }

    /** Se ha destruido todo lo destruible del mundo actual. */
    function onWorldCleared() {
      if (!arcadeAvailable()) {
        finishGame();
        return;
      }
      g.clearKind = g.mode === "web" ? "web" : "level";
      if (g.mode === "arcade") g.score += cfg.levelBonus;
      g.state = "clear";
      g.clearUntil = g.tick + cfg.clearSteps;
      g.balls = [];
      g.items = [];
      g.bolts = [];
      sfx("levelUp");
      setCursor();
    }

    /* ---------------- Efectos visuales ---------------- */

    function addEffects(fragments) {
      g.fragments.push(...fragments);
      const overflow = g.fragments.length - cfg.maxFragments;
      if (overflow > 0) g.fragments.splice(0, overflow);

      for (let i = 0; i < cfg.dustPerHit && fragments.length; i++) {
        const f = fragments[(Math.random() * fragments.length) | 0];
        g.dust.push({
          x: f.x + Math.random() * f.w,
          y: f.y + Math.random() * f.h,
          vx: (Math.random() - 0.5) * 3,
          vy: -Math.random() * 2,
          size: 1.5 + Math.random() * 2.5,
          color: f.color,
          life: 1
        });
      }
      const extra = g.dust.length - cfg.maxDust;
      if (extra > 0) g.dust.splice(0, extra);
    }

    function updateEffects() {
      for (const f of g.fragments) {
        f.x += f.vx;
        f.y += f.vy;
        f.vy += 0.14;
        f.vx *= 0.992;
        f.rot += f.vr;
        f.life -= f.decay;
      }
      g.fragments = g.fragments.filter((f) => f.life > 0 && f.y < H + 80);

      for (const d of g.dust) {
        d.x += d.vx;
        d.y += d.vy;
        d.vy += 0.1;
        d.life -= 0.03;
      }
      g.dust = g.dust.filter((d) => d.life > 0);

      for (const t of g.toasts) {
        t.y -= 0.6;
        t.life -= 1 / 75;
      }
      g.toasts = g.toasts.filter((t) => t.life > 0);
      if (g.flash.steps > 0) g.flash.steps--;
    }

    /* ---------------- Impactos y puntuación ---------------- */

    /** Un impacto (de pelota o de proyectil) destruye la región del contacto. */
    function applyHit(contact, x, y) {
      const result = engine.hit(contact, { x, y });
      if (!result) return false;

      // Ladrillo de varios golpes (plateado): aguanta y se agrieta.
      if (result.damaged) {
        addEffects(result.fragments);
        sfx("explosion", 0.2);
        if (WB.Arcade && g.arcadeWorld) {
          WB.Arcade.paintDamage(g.arcadeWorld.data, result.target, sceneLayer.canvas.getContext("2d"), sceneLayer.scaleX);
        }
        return true;
      }

      sceneLayer.erase(result.rects);
      addEffects(result.fragments);
      g.reveal.dirty = true;

      // Cuanto más área rompe el impacto, más larga y grave es la explosión.
      sfx("explosion", clamp(Math.sqrt(result.area) / 220 + (result.targetDestroyed ? 0.15 : 0), 0.2, 1));

      if (g.mode === "arcade") {
        g.score += result.target.points || 0;
      } else {
        g.score += cfg.scorePerRegion;
        if (result.targetDestroyed && result.target.resistance > 1) {
          g.score += cfg.scoreTargetBonus;
        }
      }

      if (result.targetDestroyed && engine.stats().remainingTargets === 0) {
        onWorldCleared();
      } else {
        maybeDropItem(x, y);
      }
      return true;
    }

    /* ---------------- Objetos ---------------- */

    function nextItemType() {
      if (!g.bag.length) {
        g.bag = ITEM_TYPES.slice();
        for (let i = g.bag.length - 1; i > 0; i--) {
          const j = (Math.random() * (i + 1)) | 0;
          [g.bag[i], g.bag[j]] = [g.bag[j], g.bag[i]];
        }
      }
      return g.bag.pop();
    }

    function spawnItem(type, x, y) {
      g.items.push({
        type,
        x: clamp(x, cfg.itemWidth / 2, W - cfg.itemWidth / 2),
        y
      });
      g.spawned++;
      g.spawnLog.push(type); // para pruebas: orden real de creación
    }

    /** Cae un objeto cada vez que la puntuación cruza un múltiplo de powerupEvery. */
    function maybeDropItem(x, y) {
      if (g.state !== "playing") return;
      if (g.mode === "arcade") {
        // En el arcade los objetos caen de ladrillos al azar, no por puntuación.
        if (cfg.arcadeDropChance > 0 && Math.random() < cfg.arcadeDropChance) spawnItem(nextItemType(), x, y);
        return;
      }
      if (cfg.powerupEvery <= 0) return;
      if (g.score < g.nextPowerup) return;
      spawnItem(nextItemType(), x, y);
      g.nextPowerup = (Math.floor(g.score / cfg.powerupEvery) + 1) * cfg.powerupEvery;
    }

    function splitBalls() {
      const parents = g.balls.slice();
      for (const b of parents) {
        if (b.serve > 0) b.serve = 0; // una bola a la espera de saque se lanza
        for (const sign of [1, -1]) {
          if (g.balls.length >= cfg.maxBalls) return;
          const a = sign * cfg.splitAngle;
          const cos = Math.cos(a);
          const sin = Math.sin(a);
          const clone = newBall(b.x, b.y, b.vx * cos - b.vy * sin, b.vx * sin + b.vy * cos);
          clone.r = b.r; // hereda el radio actual (puede estar a medio crecer)
          normalizeBall(clone);
          g.balls.push(clone);
        }
      }
    }

    function collectItem(type) {
      if (type === "multiball") splitBalls();
      else if (type === "wide") g.effects.wide = cfg.wideSteps;
      else if (type === "bigball") g.effects.big = cfg.bigBallSteps;
      else if (type === "laser") {
        g.effects.laser = cfg.laserSteps;
        g.cooldown = 0;
      }
      sfx("pickup");

      // Aviso flotante y destello de la pala: se ve aunque no mires el banner.
      g.toasts.push({
        text: ITEM_LABELS[type],
        color: ITEM_COLORS[type],
        x: g.paddleX,
        y: paddleY() - 26,
        life: 1
      });
      g.flash = { steps: 40, color: ITEM_COLORS[type] };
    }

    function updateItems() {
      const py = paddleY();
      const halfW = g.paddleW / 2 + cfg.itemWidth / 2;
      const halfH = cfg.itemHeight / 2;

      const remaining = [];
      for (const it of g.items) {
        it.y += cfg.itemFallSpeed;
        const touchesX = Math.abs(it.x - g.paddleX) <= halfW;
        const touchesY = it.y + halfH >= py && it.y - halfH <= py + cfg.paddleHeight;
        if (touchesX && touchesY) {
          collectItem(it.type);
        } else if (it.y - halfH <= H) {
          remaining.push(it);
        }
      }
      g.items = remaining;
    }

    function updateTimers() {
      if (g.effects.wide > 0) g.effects.wide--;
      if (g.effects.laser > 0) g.effects.laser--;
      if (g.effects.big > 0) g.effects.big--;
      if (g.cooldown > 0) g.cooldown--;
    }

    /* ---------------- Láser ---------------- */

    function fireLaser() {
      if (g.state !== "playing" || g.effects.laser <= 0 || g.cooldown > 0) return false;
      const offset = g.paddleW / 2 - 9;
      const y = paddleY() - 4;
      g.bolts.push({ x: g.paddleX - offset, y }, { x: g.paddleX + offset, y });
      g.cooldown = cfg.laserCooldownSteps;
      sfx("laser");
      return true;
    }

    /**
     * Mueve los proyectiles en subpasos de <= boltStep px (la caja más fina
     * mide 10 px) y los consume al tocar una región viva.
     */
    function updateBolts() {
      if (g.effects.laser > 0) fireLaser(); // automático; el enfriamiento marca el ritmo

      const n = Math.max(1, Math.ceil(cfg.boltSpeed / cfg.boltStep));
      const step = cfg.boltSpeed / n;
      const remaining = [];

      for (const bolt of g.bolts) {
        let alive = true;
        for (let i = 0; i < n && alive && g.state === "playing"; i++) {
          bolt.y -= step;
          const contact = engine.queryCircle(bolt.x, bolt.y, cfg.boltRadius);
          if (contact) {
            g.lastBoltHit = { x: bolt.x, y: bolt.y };
            applyHit(contact, bolt.x, bolt.y);
            alive = false;
          } else if (bolt.y < -16) {
            alive = false;
          }
        }
        if (alive) remaining.push(bolt);
      }
      g.bolts = g.state === "playing" ? remaining : [];
    }

    /* ---------------- Pala y pelotas ---------------- */

    function updatePaddle() {
      if (g.inputMode === "keys") {
        if (g.keys.has("ArrowLeft") || g.keys.has("a")) g.paddleX -= cfg.paddleSpeed;
        if (g.keys.has("ArrowRight") || g.keys.has("d")) g.paddleX += cfg.paddleSpeed;
      } else if (g.mouseX !== null) {
        g.paddleX = g.mouseX;
      }

      const target = g.effects.wide > 0 ? cfg.widePaddleWidth : cfg.paddleWidth;
      g.paddleW += (target - g.paddleW) * cfg.paddleEase;
      if (Math.abs(target - g.paddleW) < 0.3) g.paddleW = target;

      g.paddleX = clamp(g.paddleX, g.paddleW / 2, W - g.paddleW / 2);
      if (lockActive()) g.mouseX = g.paddleX; // el "ratón lógico" nunca se sale de la pala: sin zona muerta
    }

    function normalizeBall(b) {
      const speed = Math.hypot(b.vx, b.vy);
      if (!speed) {
        b.vx = 0;
        b.vy = -g.speed;
        return;
      }
      b.vx = (b.vx / speed) * g.speed;
      b.vy = (b.vy / speed) * g.speed;

      // Evita trayectorias casi horizontales (rebote infinito entre paredes).
      const minVy = g.speed * cfg.minVerticalRatio;
      if (Math.abs(b.vy) < minVy) {
        b.vy = (b.vy < 0 ? -1 : 1) * minVy;
        b.vx = (b.vx < 0 ? -1 : 1) * Math.sqrt(g.speed ** 2 - minVy ** 2);
      }
    }

    function collideTargets(b) {
      let damaged = false;
      let bounced = false;

      for (let iter = 0; iter < 3 && g.state === "playing"; iter++) {
        const c = engine.queryCircle(b.x, b.y, b.r);
        if (!c) break;

        // Saca la pelota del objetivo y rebota solo si se acerca a él.
        b.x += c.nx * (c.depth + 0.01);
        b.y += c.ny * (c.depth + 0.01);
        const vn = b.vx * c.nx + b.vy * c.ny;
        if (vn < 0) {
          b.vx -= 2 * vn * c.nx;
          b.vy -= 2 * vn * c.ny;
          if (!bounced) {
            bounced = true;
            sfx("bounce", "target");
          }
        }

        if (!damaged && b.lock <= 0) {
          damaged = true;
          b.lock = cfg.hitLockSubsteps;
          applyHit(c, b.x, b.y);
        }
      }
    }

    function collidePaddle(b) {
      if (b.vy <= 0) return;

      const py = paddleY();
      const left = g.paddleX - g.paddleW / 2;
      const right = g.paddleX + g.paddleW / 2;
      const nearestX = clamp(b.x, left, right);
      const nearestY = clamp(b.y, py, py + cfg.paddleHeight);
      const dx = b.x - nearestX;
      const dy = b.y - nearestY;

      if (dx * dx + dy * dy > b.r * b.r || b.y > py + cfg.paddleHeight) return;

      b.y = py - b.r - 0.01;
      const offset = clamp((b.x - g.paddleX) / (g.paddleW / 2), -1, 1);
      const angle = offset * cfg.maxPaddleAngle;
      b.vx = Math.sin(angle) * g.speed;
      b.vy = -Math.cos(angle) * g.speed;
      sfx("bounce", "paddle");
    }

    function substep(b, fraction) {
      b.x += b.vx * fraction;
      b.y += b.vy * fraction;

      if (b.x - b.r < 0) {
        b.x = b.r;
        b.vx = Math.abs(b.vx);
        sfx("bounce", "wall");
      } else if (b.x + b.r > W) {
        b.x = W - b.r;
        b.vx = -Math.abs(b.vx);
        sfx("bounce", "wall");
      }
      if (b.y - b.r < 0) {
        b.y = b.r;
        b.vy = Math.abs(b.vy);
        sfx("bounce", "wall");
      }

      collidePaddle(b);

      if (b.y - b.r > H) {
        b.lost = true;
        return;
      }

      collideTargets(b);
      if (g.state !== "playing") return;

      normalizeBall(b);
      if (b.lock > 0) b.lock--;
    }

    function stepBalls() {
      const n = Math.max(1, Math.ceil(g.speed / cfg.maxSubstepDistance));

      const targetR = ballRadiusTarget();
      for (const b of g.balls.slice()) {
        if (g.state !== "playing") return;

        // El radio se acerca a su valor objetivo en unos 15 pasos.
        b.r += (targetR - b.r) * cfg.ballEase;
        if (Math.abs(targetR - b.r) < 0.15) b.r = targetR;

        if (b.serve > 0) {
          b.serve--;
          b.x = g.paddleX;
          b.y = paddleY() - b.r - 1;
          continue;
        }
        for (let i = 0; i < n; i++) {
          substep(b, 1 / n);
          if (b.lost || g.state !== "playing") break;
        }
      }

      if (g.state !== "playing") return;
      g.balls = g.balls.filter((b) => !b.lost);
      if (!g.balls.length) loseLife(); // se pierde la vida al perder la ÚLTIMA bola
    }

    function update() {
      g.tick++;
      if (g.pause.on) return; // en pausa no avanza nada (ni la física ni los temporizadores)
      if (g.state === "clear") {
        updateEffects();
        if (g.tick >= g.clearUntil) startLevel(g.level + 1);
        return;
      }
      if (g.state === "playing") {
        updatePaddle();
        updateTimers();
        updateBolts();
        updateItems();
        stepBalls();
      }
      updateEffects();
    }

    /* ---------------- Dibujo ---------------- */

    function drawFragments(ctx) {
      const sx = sceneLayer.scaleX;
      const sy = sceneLayer.scaleY;
      for (const f of g.fragments) {
        ctx.save();
        ctx.globalAlpha = clamp(f.life * 1.5, 0, 1);
        ctx.translate(f.x + f.w / 2, f.y + f.h / 2);
        ctx.rotate(f.rot);
        ctx.drawImage(image, f.sx * sx, f.sy * sy, f.w * sx, f.h * sy, -f.w / 2, -f.h / 2, f.w, f.h);
        ctx.restore();
      }
    }

    function drawDust(ctx) {
      for (const d of g.dust) {
        ctx.globalAlpha = clamp(d.life, 0, 1);
        ctx.fillStyle = d.color;
        ctx.fillRect(d.x, d.y, d.size, d.size);
      }
      ctx.globalAlpha = 1;
    }

    function drawItemIcon(ctx, type) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";

      if (type === "multiball") {
        for (const dx of [-9, 0, 9]) {
          ctx.beginPath();
          ctx.arc(dx, 0, 2.8, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (type === "bigball") {
        ctx.beginPath();
        ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
        ctx.fill();
      } else if (type === "wide") {
        ctx.beginPath();
        ctx.moveTo(-10, 0);
        ctx.lineTo(10, 0);
        ctx.moveTo(-10, 0);
        ctx.lineTo(-6, -3.5);
        ctx.moveTo(-10, 0);
        ctx.lineTo(-6, 3.5);
        ctx.moveTo(10, 0);
        ctx.lineTo(6, -3.5);
        ctx.moveTo(10, 0);
        ctx.lineTo(6, 3.5);
        ctx.stroke();
      } else {
        for (const dx of [-6, 6]) {
          ctx.beginPath();
          ctx.moveTo(dx, 5);
          ctx.lineTo(dx, -5);
          ctx.stroke();
        }
      }
    }

    /**
     * Resaltado rojo de las regiones que quedan. Se pinta a media resolución en
     * un lienzo auxiliar (rojo plano) y se desenfoca en otro; ambos se reusan
     * mientras no se destruya nada.
     */
    function rebuildReveal() {
      const half = 0.5;
      const rw = Math.max(1, Math.ceil(W * half));
      const rh = Math.max(1, Math.ceil(H * half));
      const mk = () => {
        const c = document.createElement("canvas");
        c.width = rw;
        c.height = rh;
        return c;
      };
      if (!g.reveal.sharp) {
        g.reveal.sharp = mk();
        g.reveal.layer = mk();
      }

      const sharp = g.reveal.sharp.getContext("2d");
      sharp.clearRect(0, 0, rw, rh);
      sharp.fillStyle = "#ff1e3c";
      sharp.beginPath();
      for (const t of engine.targets) {
        if (t.destroyed || t.solid) continue;
        for (const ch of t.chunks) {
          if (!ch.alive) continue;
          for (const r of ch.rects) sharp.rect(r.x * half, r.y * half, r.w * half, r.h * half);
        }
      }
      sharp.fill();

      const blur = g.reveal.layer.getContext("2d");
      blur.clearRect(0, 0, rw, rh);
      if ("filter" in blur) blur.filter = "blur(" + cfg.revealBlur + "px)";
      blur.drawImage(g.reveal.sharp, 0, 0);
      if ("filter" in blur) blur.filter = "none";

      // Se vacía el interior: queda solo el halo que sale por fuera del borde,
      // así los bloques grandes no tapan el contenido de la página.
      blur.globalCompositeOperation = "destination-out";
      blur.drawImage(g.reveal.sharp, 0, 0);
      // Los sólidos (ladrillos dorados) no se pueden destruir: el halo de sus
      // vecinos no debe teñirlos, o parecerían destruibles.
      blur.fillStyle = "#000";
      blur.beginPath();
      for (const t of engine.targets) {
        if (!t.solid) continue;
        for (const ch of t.chunks) for (const r of ch.rects) blur.rect(r.x * half, r.y * half, r.w * half, r.h * half);
      }
      blur.fill();
      blur.globalCompositeOperation = "source-over";
      g.reveal.dirty = false;
    }

    function drawReveal(ctx) {
      if (!g.reveal.on) return;
      if (g.reveal.dirty || !g.reveal.layer) rebuildReveal();

      const pulse = 0.9 + 0.1 * Math.sin(g.tick / 8);
      ctx.save();
      ctx.globalAlpha = pulse;
      for (let i = 0; i < 3; i++) ctx.drawImage(g.reveal.layer, 0, 0, W, H); // halo: varias pasadas = más intensidad
      ctx.globalAlpha = 0.3 * pulse;
      ctx.drawImage(g.reveal.sharp, 0, 0, W, H); // tinte suave del interior (deja ver la página)
      ctx.restore();
    }

    /** Aviso cuando se pierde la captura del ratón a mitad de partida. */
    function drawLockPrompt(ctx) {
      if (!cfg.pointerLock || lockActive() || lockUnsupported() || g.state !== "playing") return;
      if (g.pause.on || waitingForLaunch() || (g.tick >> 4) % 2 === 1) return;
      const text = "CLIC PARA CAPTURAR EL RATÓN";
      const px = 2;
      const tw = textWidth(text, px);
      const x = clamp(W / 2 - tw / 2, 8, W - tw - 8);
      const y = 22;
      ctx.fillStyle = INK;
      ctx.fillRect(x - 6, y - 5, tw + 12, 7 * px + 10);
      ctx.fillStyle = "#35d9ff";
      ctx.fillRect(x - 6, y - 5, tw + 12, 1);
      ctx.fillRect(x - 6, y - 5 + 7 * px + 9, tw + 12, 1);
      drawText(ctx, text, x, y, px, "#35d9ff");
    }

    /** Aviso sobre la bola mientras espera el lanzamiento. */
    function drawLaunchPrompt(ctx) {
      if (!waitingForLaunch() || (g.tick >> 4) % 2 === 1) return;
      const text = "CLIC PARA LANZAR";
      const px = 2;
      const tw = textWidth(text, px);
      const x = clamp(g.paddleX - tw / 2, 8, W - tw - 8);
      const y = paddleY() - 52;
      ctx.fillStyle = INK;
      ctx.fillRect(x - 6, y - 5, tw + 12, 7 * px + 10);
      ctx.fillStyle = "#ffd166";
      ctx.fillRect(x - 6, y - 5, tw + 12, 1);
      ctx.fillRect(x - 6, y - 5 + 7 * px + 9, tw + 12, 1);
      drawText(ctx, text, x, y, px, "#ffd166");
    }

    /** Cápsulas con contorno oscuro: se ven sobre fondos claros y oscuros. */
    function drawItems(ctx) {
      for (const it of g.items) {
        const w = cfg.itemWidth;
        const h = cfg.itemHeight;
        ctx.save();
        ctx.translate(it.x, it.y);
        ctx.fillStyle = INK;
        roundRectPath(ctx, -w / 2 - 2, -h / 2 - 2, w + 4, h + 4, h / 2 + 2);
        ctx.fill();
        ctx.fillStyle = ITEM_COLORS[it.type];
        roundRectPath(ctx, -w / 2, -h / 2, w, h, h / 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.fillRect(-w / 2 + 7, -h / 2 + 2, w - 14, 2);
        drawItemIcon(ctx, it.type);
        ctx.restore();
      }
    }

    function drawBolts(ctx) {
      ctx.lineCap = "butt";
      for (const b of g.bolts) {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y - 1);
        ctx.lineTo(b.x, b.y + 15);
        ctx.stroke();
        ctx.strokeStyle = "#ff5d73";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x, b.y + 14);
        ctx.stroke();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y + 1);
        ctx.lineTo(b.x, b.y + 12);
        ctx.stroke();
      }
    }

    /**
     * Pala estilo arcade con contorno oscuro de 2 px y cuerpo de colores
     * planos: se distingue sobre una página blanca igual que sobre una negra.
     * Con la barra grande los extremos pasan a cian; al recoger un objeto
     * destella durante 40 pasos.
     */
    function drawPaddle(ctx) {
      const w = g.paddleW;
      const x = g.paddleX - w / 2;
      const y = paddleY();
      const h = cfg.paddleHeight;
      const flashOn = g.flash.steps > 0 && (g.flash.steps >> 2) % 2 === 0;

      ctx.fillStyle = INK;
      roundRectPath(ctx, x - 2, y - 2, w + 4, h + 4, 8);
      ctx.fill();

      ctx.save();
      roundRectPath(ctx, x, y, w, h, 6);
      ctx.clip();
      const body = flashOn ? g.flash.color : null;
      ctx.fillStyle = body || "#eef3fb";
      ctx.fillRect(x, y, w, 4);
      ctx.fillStyle = body || "#b8c4d8";
      ctx.fillRect(x, y + 4, w, 4);
      ctx.fillStyle = body || "#7f8da6";
      ctx.fillRect(x, y + 8, w, h - 8);

      const cap = g.effects.wide > 0 ? "#35d9ff" : "#ff3b4e";
      ctx.fillStyle = flashOn ? "#ffffff" : cap;
      ctx.fillRect(x, y, 14, h);
      ctx.fillRect(x + w - 14, y, 14, h);
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.fillRect(x, y, 14, 3);
      ctx.fillRect(x + w - 14, y, 14, 3);
      ctx.restore();

      if (g.effects.laser > 0) {
        for (const cx of [x + 3, x + w - 11]) {
          ctx.fillStyle = INK;
          ctx.fillRect(cx - 1, y - 9, 10, 11);
          ctx.fillStyle = "#ff5d73";
          ctx.fillRect(cx + 1, y - 7, 6, 9);
        }
      }
    }

    function drawBalls(ctx) {
      for (const b of g.balls) {
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffd166";
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
        const hl = Math.max(3, Math.round(b.r * 0.42));
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.fillRect(b.x - b.r * 0.45, b.y - b.r * 0.55, hl, hl);
      }
    }

    function drawToasts(ctx) {
      for (const t of g.toasts) {
        const px = 2;
        const tw = textWidth(t.text, px);
        ctx.globalAlpha = clamp(t.life * 2, 0, 1);
        drawText(ctx, t.text, clamp(t.x - tw / 2, 4, W - tw - 4), t.y, px, t.color, INK);
      }
      ctx.globalAlpha = 1;
    }

    /* ---- Banner retro (espacio de pantalla, fuera del tablero) ---- */

    function drawTag(ctx, text, x, y, px, color) {
      const padX = 3 * px;
      const padY = 2 * px;
      const w = textWidth(text, px) + 2 * padX;
      const h = 7 * px + 2 * padY;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - padY, w, px);
      ctx.fillRect(x, y - padY + h - px, w, px);
      ctx.fillRect(x, y - padY, px, h);
      ctx.fillRect(x + w - px, y - padY, px, h);
      drawText(ctx, text, x + padX, y, px, color);
    }

    function bannerSegments(ctx, px, barVariant) {
      const LABEL = "#8b98b8";
      const VALUE = "#ffffff";
      const surf = g.mode === "arcade" ? "PROGRESO" : "SUPERFICIE";
      const adv = (str) => textAdvance(str, px);
      const wid = (str) => textWidth(str, px);
      const s = engine.stats();
      const pct = Math.min(100, Math.floor(s.percentDestroyed));

      const field = (label, value, color, opt) => ({
        opt: Boolean(opt),
        w: wid(label + " " + value),
        draw: (x, y) => {
          drawText(ctx, label, x, y, px, LABEL);
          drawText(ctx, value, x + adv(label + " "), y, px, color || VALUE);
        }
      });

      /* Fila 1 */
      const left1 = [
        {
          opt: false,
          w: wid("WEBBREAKOUT"),
          draw: (x, y) => drawText(ctx, "WEBBREAKOUT", x, y, px, "#35d9ff", "#0a4a5a")
        },
        field("PUNTOS", String(g.score).padStart(6, "0"), "#ffd166")
      ];
      if (g.mode === "arcade") left1.push(field("NIVEL", String(g.level), "#4ade80", true));

      const manyLives = cfg.maxLives > 5;
      const heartsW = manyLives ? 8 * px + wid("X" + g.lives) : cfg.maxLives * 8 * px - px;
      left1.push({
        opt: false,
        w: adv("VIDAS ") + heartsW,
        draw: (x, y) => {
          drawText(ctx, "VIDAS", x, y, px, LABEL);
          let hx = x + adv("VIDAS ");
          if (manyLives) {
            drawHeart(ctx, hx, y, px, "#ff3b4e");
            drawText(ctx, "X" + g.lives, hx + 8 * px, y, px, VALUE);
          } else {
            for (let i = 0; i < cfg.maxLives; i++, hx += 8 * px) {
              drawHeart(ctx, hx, y, px, i < g.lives ? "#ff3b4e" : "#2a3350");
            }
          }
        }
      });
      if (g.balls.length > 1) left1.push(field("BOLAS", "X" + g.balls.length, ITEM_COLORS.multiball, true));

      const right1 = [];
      const tag = (text, color, steps) => {
        const warn = steps <= 180 && (g.tick >> 3) % 2 === 1;
        return {
          opt: true,
          w: textWidth(text, px) + 6 * px,
          draw: (x, y) => drawTag(ctx, text, x, y, px, warn ? "#4a5570" : color)
        };
      };
      if (g.effects.wide > 0) {
        right1.push(tag("BARRA " + Math.ceil(g.effects.wide / 60) + "S", ITEM_COLORS.wide, g.effects.wide));
      }
      if (g.effects.laser > 0) {
        right1.push(tag("LÁSER " + Math.ceil(g.effects.laser / 60) + "S", ITEM_COLORS.laser, g.effects.laser));
      }
      if (g.effects.big > 0) {
        right1.push(tag("BOLA GRANDE " + Math.ceil(g.effects.big / 60) + "S", ITEM_COLORS.bigball, g.effects.big));
      }

      /* Fila 2 */
      const left2 = [
        field("DESTRUIDOS", String(s.destroyedTargets)),
        field("RESTANTES", String(s.remainingTargets))
      ];

      if (barVariant < 2) {
        const segs = barVariant === 0 ? 20 : 10;
        const segW = (barVariant === 0 ? 3 : 5) * px;
        const barW = segs * (segW + px) - px;
        const filled = Math.floor((pct / 100) * segs + 1e-9);
        left2.push({
          opt: false,
          w: adv(surf + " ") + barW + 3 * px + wid(pct + "%"),
          draw: (x, y) => {
            drawText(ctx, surf, x, y, px, LABEL);
            const bx = x + adv(surf + " ");
            for (let i = 0; i < segs; i++) {
              ctx.fillStyle = i < filled ? "#ffd166" : "#243049";
              ctx.fillRect(bx + i * (segW + px), y, segW, 7 * px);
            }
            drawText(ctx, pct + "%", bx + barW + 3 * px, y, px, VALUE);
          }
        });
      } else {
        left2.push(field(surf, pct + "%"));
      }

      const right2 = [];
      if (
        cfg.pointerLock &&
        g.state === "playing" &&
        !g.pause.on &&
        !waitingForLaunch() &&
        !lockActive() &&
        !lockUnsupported()
      ) {
        const warn = (g.tick >> 4) % 2 === 0;
        right2.push({
          opt: true,
          w: wid("RATÓN LIBRE"),
          draw: (x, y) => drawText(ctx, "RATÓN LIBRE", x, y, px, warn ? "#ff4d63" : "#4a5570")
        });
      }
      {
        const on = g.reveal.on;
        const text = on ? "B: BLOQUES ON" : "B: VER BLOQUES";
        right2.push({
          opt: true,
          w: wid(text),
          draw: (x, y) => drawText(ctx, text, x, y, px, on ? "#ff4d63" : LABEL)
        });
      }
      const snd = g.audio ? g.audio.state() : "unavailable";
      let text = null;
      let color = LABEL;
      if (snd === "on") text = "M: SONIDO ON";
      else if (snd === "muted") text = "M: SONIDO OFF";
      else if (snd === "off" || snd === "locked") {
        text = "CLIC: ACTIVAR SONIDO";
        if ((g.tick >> 5) % 2 === 1) color = "#4a5570";
      }
      if (text) {
        right2.push({ opt: true, w: wid(text), draw: (x, y) => drawText(ctx, text, x, y, px, color) });
      }

      return { left1, right1, left2, right2 };
    }

    /** Quita piezas opcionales (primero las de la derecha) hasta que la fila quepa. */
    function fitRow(left, right, vw, ui) {
      const margin = 8 * ui;
      const gap = 12 * ui;
      const L = left.slice();
      const R = right.slice();
      const sum = (l) => l.reduce((a, seg, i) => a + seg.w + (i ? gap : 0), 0);
      const total = () => sum(L) + sum(R) + (L.length && R.length ? gap : 0);
      const fits = () => total() <= vw - 2 * margin;
      for (const list of [R, L]) {
        for (let i = list.length - 1; i >= 0 && !fits(); i--) if (list[i].opt) list.splice(i, 1);
      }
      return { L, R, margin, gap, width: total(), fits: fits(), sum };
    }

    function drawBanner(ctx) {
      const v = g.view;
      const ui = v.ui;
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);

      ctx.fillStyle = "#0b1020";
      ctx.fillRect(0, 0, v.vw, v.bannerH);
      ctx.fillStyle = "#35d9ff";
      ctx.fillRect(0, v.bannerH - 3 * ui, v.vw, ui);
      ctx.fillStyle = "#ff2fa8";
      ctx.fillRect(0, v.bannerH - ui, v.vw, ui);

      const rowY = ui === 2 ? [10, 38] : [5, 18];
      const info = { ui, height: v.bannerH, rows: [] };

      let row2 = null;
      let seg = null;
      for (let variant = 0; variant < 3; variant++) {
        seg = bannerSegments(ctx, ui, variant);
        row2 = fitRow(seg.left2, seg.right2, v.vw, ui);
        if (row2.fits) break;
      }
      const row1 = fitRow(seg.left1, seg.right1, v.vw, ui);

      [[row1, rowY[0]], [row2, rowY[1]]].forEach(([row, y]) => {
        let x = row.margin;
        for (const part of row.L) {
          part.draw(x, y);
          x += part.w + row.gap;
        }
        if (row.R.length) {
          x = v.vw - row.margin - row.sum(row.R);
          for (const part of row.R) {
            part.draw(x, y);
            x += part.w + row.gap;
          }
        }
        info.rows.push({ width: row.width, fits: row.fits, parts: row.L.length + row.R.length });
      });
      g.bannerInfo = info;

      // Líneas de escaneo CRT sobre el banner.
      if (g.patterns && g.patterns.scan) {
        ctx.fillStyle = g.patterns.scan;
        ctx.fillRect(0, 0, v.vw, v.bannerH - 3 * ui);
      }
    }

    function drawFrame(ctx) {
      const v = g.view;
      const x = v.offsetX;
      const y = v.offsetY;
      const w = W * v.scale;
      const h = H * v.scale;
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#35d9ff";
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#ff2fa8";
      ctx.strokeRect(x - 5.5, y - 5.5, w + 11, h + 11);
    }

    /** Pantalla final en espacio de pantalla, centrada en el tablero. */
    function drawOverlay(ctx) {
      if (g.state === "playing" || g.state === "clear") return;
      const v = g.view;
      const bw = W * v.scale;
      const bh = H * v.scale;
      const cx = v.offsetX + bw / 2;
      const cy = v.offsetY + bh / 2;
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);

      ctx.fillStyle = "rgba(5, 8, 18, 0.78)";
      ctx.fillRect(v.offsetX, v.offsetY, bw, bh);

      const fit = (text, start) => {
        let px = start;
        while (px > 1 && textWidth(text, px) > bw - 24) px--;
        return px;
      };
      const title = g.state === "won" ? "¡PÁGINA DESTRUIDA!" : "GAME OVER";
      const tpx = fit(title, v.ui === 2 ? 6 : 3);
      drawText(ctx, title, cx - textWidth(title, tpx) / 2, cy - 7 * tpx - 10, tpx, g.state === "won" ? "#ffd166" : "#ff3b4e", "#3a0f18");

      const scoreText = "PUNTUACIÓN " + String(g.score).padStart(6, "0");
      const spx = fit(scoreText, v.ui === 2 ? 3 : 2);
      drawText(ctx, scoreText, cx - textWidth(scoreText, spx) / 2, cy + 6, spx, "#ffffff");

      let extra = 0;
      if (g.mode === "arcade" && g.state === "gameover") {
        const reached = "LLEGASTE AL NIVEL " + g.level;
        const lpx = fit(reached, v.ui === 2 ? 2 : 1);
        drawText(ctx, reached, cx - textWidth(reached, lpx) / 2, cy + 6 + 7 * spx + 12, lpx, "#4ade80");
        extra = 7 * lpx + 12;
      }

      if ((g.tick >> 4) % 2 === 0) {
        const prompt = "CLIC O R: JUGAR - ESC: SALIR";
        const ppx = fit(prompt, v.ui === 2 ? 2 : 1);
        drawText(ctx, prompt, cx - textWidth(prompt, ppx) / 2, cy + 6 + 7 * spx + 18 + extra, ppx, "#35d9ff");
      }
    }

    /** Transición: web destruida → modo arcade, o nivel superado. */
    function drawClear(ctx) {
      if (g.state !== "clear") return;
      const v = g.view;
      const bw = W * v.scale;
      const bh = H * v.scale;
      const cx = v.offsetX + bw / 2;
      const cy = v.offsetY + bh / 2;
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);

      ctx.fillStyle = "rgba(5, 8, 18, 0.66)";
      ctx.fillRect(v.offsetX, v.offsetY, bw, bh);

      const fit = (text, start) => {
        let px = start;
        while (px > 1 && textWidth(text, px) > bw - 24) px--;
        return px;
      };
      const web = g.clearKind === "web";
      const title = web ? "¡WEB DESTRUIDA!" : "NIVEL " + g.level + " SUPERADO";
      const tpx = fit(title, v.ui === 2 ? 6 : 3);
      drawText(ctx, title, cx - textWidth(title, tpx) / 2, cy - 7 * tpx - 14, tpx, web ? "#ffd166" : "#4ade80", "#1a2a10");

      const sub = web ? "MODO ARCADE" : "+" + cfg.levelBonus + " PUNTOS";
      const spx = fit(sub, v.ui === 2 ? 4 : 2);
      drawText(ctx, sub, cx - textWidth(sub, spx) / 2, cy + 2, spx, "#35d9ff", "#0a4a5a");

      if ((g.tick >> 3) % 2 === 0 && WB.Arcade) {
        const next = (web ? "NIVEL 1: " : "SIGUIENTE: ") + WB.Arcade.patternFor(g.level + 1).name;
        const npx = fit(next, v.ui === 2 ? 2 : 1);
        drawText(ctx, next, cx - textWidth(next, npx) / 2, cy + 2 + 7 * spx + 18, npx, "#ffd166");
      }
    }

    /** Rótulo «NIVEL n» al empezar cada nivel (mientras la bola espera). */
    function drawIntro(ctx) {
      // Solo mientras la bola espera: una vez lanzada, el rótulo taparía el juego.
      if (g.mode !== "arcade" || !g.intro || g.tick >= g.intro.until || g.state !== "playing" || g.pause.on) return;
      if (!waitingForLaunch()) return;
      const v = g.view;
      const bw = W * v.scale;
      const bh = H * v.scale;
      const cx = v.offsetX + bw / 2;
      const cy = v.offsetY + bh * 0.7;
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);

      const fit = (text, start) => {
        let px = start;
        while (px > 1 && textWidth(text, px) > bw - 24) px--;
        return px;
      };
      const title = "NIVEL " + g.intro.level;
      const tpx = fit(title, v.ui === 2 ? 5 : 3);
      drawText(ctx, title, cx - textWidth(title, tpx) / 2, cy, tpx, "#35d9ff", "#0a4a5a");
      const name = g.intro.name;
      const npx = fit(name, v.ui === 2 ? 3 : 2);
      drawText(ctx, name, cx - textWidth(name, npx) / 2, cy + 7 * tpx + 12, npx, "#ffd166", "#3a2a00");
    }

    /** Pantalla de pausa (espacio de pantalla, centrada en el tablero). */
    function drawPause(ctx) {
      if (!g.pause.on || g.state !== "playing") return;
      const v = g.view;
      const bw = W * v.scale;
      const bh = H * v.scale;
      const cx = v.offsetX + bw / 2;
      const cy = v.offsetY + bh / 2;
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);

      ctx.fillStyle = "rgba(5, 8, 18, 0.74)";
      ctx.fillRect(v.offsetX, v.offsetY, bw, bh);

      const fit = (text, start) => {
        let px = start;
        while (px > 1 && textWidth(text, px) > bw - 24) px--;
        return px;
      };
      const title = "PAUSA";
      const tpx = fit(title, v.ui === 2 ? 6 : 3);
      drawText(ctx, title, cx - textWidth(title, tpx) / 2, cy - 7 * tpx - 14, tpx, "#35d9ff", "#0a4a5a");

      if ((g.tick >> 4) % 2 === 0) {
        const prompt = "CLIC PARA CONTINUAR";
        const ppx = fit(prompt, v.ui === 2 ? 3 : 2);
        drawText(ctx, prompt, cx - textWidth(prompt, ppx) / 2, cy + 4, ppx, "#ffd166");
      }
      if (!lockUnsupported() && cfg.pointerLock) {
        const note = "SE CAPTURARÁ EL RATÓN DE NUEVO";
        const npx = fit(note, v.ui === 2 ? 2 : 1);
        drawText(ctx, note, cx - textWidth(note, npx) / 2, cy + 4 + 7 * (v.ui === 2 ? 3 : 2) + 16, npx, "#8b98b8");
      }
    }

    function draw() {
      const ctx = g.ctx;
      const v = g.view;

      // Fondo retro (puntos) en toda la ventana, también en los márgenes.
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      ctx.fillStyle = g.patterns.dots;
      ctx.fillRect(0, 0, v.vw, v.vh);

      // Tablero: la página capturada, escalada y recortada a su marco.
      ctx.setTransform(v.dpr * v.scale, 0, 0, v.dpr * v.scale, v.dpr * v.offsetX, v.dpr * v.offsetY);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.clip();
      ctx.fillStyle = cfg.destroyColor;
      ctx.fillRect(0, 0, W, H);
      sceneLayer.draw(ctx, 0, 0, W, H);
      drawReveal(ctx);
      drawFragments(ctx);
      drawDust(ctx);
      drawItems(ctx);
      drawBolts(ctx);
      drawPaddle(ctx);
      drawBalls(ctx);
      drawToasts(ctx);
      drawLaunchPrompt(ctx);
      drawLockPrompt(ctx);
      ctx.restore();

      drawFrame(ctx);
      drawBanner(ctx);
      drawOverlay(ctx);
      drawClear(ctx);
      drawIntro(ctx);
      drawPause(ctx);
    }

    /* ---------------- Entrada ---------------- */

    function onMouseMove(event) {
      g.inputMode = "mouse";
      if (lockActive()) {
        // Recién capturado, o salto imposible de una sola vez: se descarta.
        const raw = event.movementX || 0;
        if (
          performance.now() - g.lock.acquiredAt < cfg.lockSettleMs ||
          Math.abs(raw) > Math.max(cfg.lockMinJump, window.innerWidth * 0.45)
        ) {
          g.lock.ignored++;
          return;
        }
        // Solo el eje horizontal; el vertical (movementY) se ignora a propósito.
        const base = g.mouseX === null ? g.paddleX : g.mouseX;
        const dx = (raw / g.view.scale) * cfg.mouseSensitivity;
        g.mouseX = clamp(base + dx, g.paddleW / 2, W - g.paddleW / 2);
      } else {
        // Captura pedida y aún sin conceder: el cursor puede estar "en tránsito".
        if (performance.now() < g.lock.pendingUntil) {
          g.lock.ignored++;
          return;
        }
        g.mouseX = toStageX(event.clientX);
      }
    }

    function onKeyDown(event) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      if (key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        // Primera pulsación: solo soltar el ratón (Chrome ya lo hace por su cuenta;
        // si la tecla nos llega igualmente, no se interpreta como "salir").
        if (lockActive()) {
          releaseLock();
          return;
        }
        if (performance.now() - g.lock.lostAt < cfg.lockEscGraceMs) return;
        exit();
        return;
      }
      unlockAudio();
      if (!GAME_KEYS.has(key)) return;

      event.preventDefault();
      event.stopPropagation();

      if (key === "m") {
        if (!event.repeat && g.audio) g.audio.toggleMute();
        return;
      }
      if (key === "b") {
        if (!event.repeat) {
          g.reveal.on = !g.reveal.on;
          g.reveal.dirty = true;
        }
        return;
      }
      if (key === " ") {
        if (!event.repeat) {
          resumeGame();
          requestLock(); // lanzar con teclado también captura el ratón
          launchBall();
        }
        return;
      }
      if (key === "r") {
        if (!event.repeat) {
          restart();
          requestLock();
        }
        return;
      }
      if (key === "ArrowLeft" || key === "ArrowRight" || key === "a" || key === "d") {
        g.inputMode = "keys";
      }
      g.keys.add(key);
    }

    function onKeyUp(event) {
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      g.keys.delete(key);
    }

    /** Los eventos dirigidos al canvas no deben llegar a los listeners de la página. */
    function swallow(event) {
      if (event.target !== g.canvas) return;
      event.stopPropagation();
      if (event.type === "mousedown" || event.type === "pointerdown") unlockAudio();
      if (event.type === "mousedown" && event.button === 0) {
        resumeGame();
        requestLock();
        launchBall();
      }
    }

    function onClick(event) {
      swallow(event);
      if (event.target !== g.canvas) return;
      unlockAudio();
      if (g.state === "clear") return; // transición de nivel: el clic no hace nada
      if (g.state !== "playing") {
        restart();
        return;
      }
      resumeGame();
      requestLock();
      launchBall();
      if (!lockActive() && toStageY(event.clientY) >= paddleY() - 50) {
        g.mouseX = toStageX(event.clientX);
        g.inputMode = "mouse";
      }
    }

    function onTouch(event) {
      event.preventDefault();
      const t = event.touches[0];
      if (!t) return;
      g.inputMode = "mouse";
      g.mouseX = toStageX(t.clientX);
      if (event.type === "touchstart") launchBall();
    }

    function onTouchEnd() {
      unlockAudio();
    }

    function onWheel(event) {
      event.preventDefault();
    }

    function onBlur() {
      g.keys.clear();
      if (!lockActive() && pauseEligible()) pauseGame();
    }

    /** El cursor salió de la ventana (p. ej. hacia otro monitor). */
    function onMouseLeave() {
      g.pause.outside = true;
      if (!lockActive() && pauseEligible()) pauseGame();
    }

    function onMouseEnter() {
      g.pause.outside = false;
    }

    function attach() {
      listen(window, "mousemove", onMouseMove, true);
      listen(window, "keydown", onKeyDown, { capture: true, passive: false });
      listen(window, "keyup", onKeyUp, true);
      listen(window, "resize", resize);
      listen(window, "click", onClick, true);
      for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick"]) {
        listen(window, type, swallow, true);
      }
      listen(window, "wheel", onWheel, { capture: true, passive: false });
      listen(window, "touchstart", onTouch, { capture: true, passive: false });
      listen(window, "touchmove", onTouch, { capture: true, passive: false });
      listen(window, "touchend", onTouchEnd, true);
      listen(window, "touchcancel", onTouchEnd, true);
      listen(window, "blur", onBlur);
      listen(document, "visibilitychange", onVisibility);
      listen(document, "pointerlockchange", onLockChange);
      listen(document, "pointerlockerror", () => {
        g.lock.pendingUntil = 0;
        g.lock.failures++;
      });
      listen(document.documentElement, "mouseleave", onMouseLeave);
      listen(document.documentElement, "mouseenter", onMouseEnter);
    }

    /** Pestaña oculta: el bucle se detiene, y el audio también. */
    function onVisibility() {
      sfx("setHidden", document.hidden);
      if (document.hidden && cfg.autoPause && g.state === "playing" && !waitingForLaunch()) pauseGame();
    }

    /* ---------------- Ciclo de vida ---------------- */

    function frame(timestamp) {
      if (!g.active) return;
      try {
        const dt = g.last ? timestamp - g.last : STEP_MS;
        g.last = timestamp;
        g.acc += Math.min(dt, 100);

        let steps = 0;
        while (g.acc >= STEP_MS && steps < cfg.maxStepsPerFrame) {
          update();
          g.acc -= STEP_MS;
          steps++;
        }
        if (steps === cfg.maxStepsPerFrame) g.acc = 0;

        draw();
      } catch (error) {
        console.error("WebBreakout: error en el bucle del juego.", error);
        stop();
        if (options.onError) options.onError(error);
        return;
      }
      g.raf = requestAnimationFrame(frame);
    }

    function start() {
      if (g.active) return;
      g.active = true;
      g.state = "playing";
      g.score = 0;
      g.lives = cfg.maxLives;
      g.keys.clear();
      g.fragments = [];
      g.dust = [];
      g.last = 0;
      g.acc = 0;
      g.nextPowerup = cfg.powerupEvery;
      g.bag = [];
      g.spawned = 0;
      g.spawnLog = [];
      g.tick = 0;
      g.pause.on = false;
      g.pause.outside = false;
      g.lock.failures = 0;
      g.toasts = [];
      resetPowerups();

      g.audio = options.audio !== undefined ? options.audio : WB.Audio ? WB.Audio.create() : null;
      if (g.audio) g.audio.tryStart();

      createCanvas();
      resize();
      attach();

      // Que ninguna caja de texto de la página siga recibiendo teclas.
      if (document.activeElement && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }

      if (options.startMode === "arcade" && arcadeAvailable()) {
        // Modo arcade puro: empieza directamente en el nivel 1, sin web.
        g.raf = requestAnimationFrame(frame);
        startLevel(1);
      } else {
        // Modo web (por defecto): destruye la página y luego entra en arcade.
        sfx("playMusic", "game");
        spawnBall();
        g.raf = requestAnimationFrame(frame);
      }
    }

    /** Retira canvas, listeners y animación. No toca el motor ni la capa. */
    function stop() {
      if (!g.active) return;
      g.active = false;

      if (g.raf) cancelAnimationFrame(g.raf);
      g.raf = 0;

      for (const remove of removers) remove();
      removers.length = 0;

      releaseLock();
      disposeArcadeWorld();
      if (g.canvas) g.canvas.remove();
      g.canvas = null;
      g.ctx = null;
      g.lock.wasActive = false;
      g.lock.everLocked = false;

      if (g.audio) g.audio.dispose();
      g.audio = null;

      g.keys.clear();
      g.fragments = [];
      g.dust = [];
      g.balls = [];
      g.items = [];
      g.bolts = [];
      g.toasts = [];
      g.patterns = null;
      g.reveal.layer = null;
      g.reveal.sharp = null;
      g.reveal.dirty = true;
    }

    function exit() {
      if (options.onExit) options.onExit();
      else stop();
    }

    function getStatus() {
      return Object.assign(
        {
          state: g.state,
          score: g.score,
          lives: g.lives,
          balls: g.balls.length,
          waiting: waitingForLaunch(),
          paused: g.pause.on,
          mode: g.mode,
          level: g.level,
          speed: g.speed,
          wideSeconds: Math.ceil(g.effects.wide / 60),
          laserSeconds: Math.ceil(g.effects.laser / 60),
          bigSeconds: Math.ceil(g.effects.big / 60),
          music: g.audio && typeof g.audio.musicState === "function" ? g.audio.musicState() : "none"
        },
        engine.stats()
      );
    }

    return {
      start,
      stop,
      restart,
      getStatus,
      isActive: () => g.active,
      // Acceso para pruebas.
      debug: {
        step: update,
        draw,
        get ball() { return g.balls[0] || null; },
        get balls() { return g.balls; },
        get items() { return g.items; },
        get bolts() { return g.bolts; },
        get effects() { return g.effects; },
        get spawned() { return g.spawned; },
        get spawnLog() { return g.spawnLog; },
        get lastBoltHit() { return g.lastBoltHit; },
        get paddleW() { return g.paddleW; },
        get cooldown() { return g.cooldown; },
        get state() { return g.state; },
        get canvas() { return g.canvas; },
        get fragments() { return g.fragments; },
        get paddleX() { return g.paddleX; },
        get score() { return g.score; },
        get lives() { return g.lives; },
        get audio() { return g.audio; },
        get view() { return g.view; },
        setPaddle(x) { g.mouseX = x; g.inputMode = "mouse"; g.paddleX = x; },
        spawnItem,
        addBolt(x, y) { g.bolts.push({ x, y }); },
        fire: fireLaser,
        get banner() { return g.bannerInfo; },
        get locked() { return lockActive(); },
        get mode() { return g.mode; },
        get level() { return g.level; },
        get speed() { return g.speed; },
        get world() { return g.arcadeWorld; },
        get intro() { return g.intro; },
        get clearUntil() { return g.clearUntil; },
        get engine() { return engine; },
        get sceneLayer() { return sceneLayer; },
        startLevel,
        forceClear: onWorldCleared,
        get paused() { return g.pause.on; },
        get pauseInfo() { return g.pause; },
        get tick() { return g.tick; },
        get mouseX() { return g.mouseX; },
        get lockInfo() { return g.lock; },
        get reveal() { return g.reveal.on; },
        get waiting() { return waitingForLaunch(); },
        launch: launchBall,
        setReveal(v) { g.reveal.on = Boolean(v); g.reveal.dirty = true; },
        get toasts() { return g.toasts; },
        get flash() { return g.flash; }
      }
    };
  }

  /** Línea y a partir de la cual la pelota ya no puede llegar (parte superior de la pala). */
  function playAreaBottom(stageHeight, config) {
    const c = Object.assign({}, CONFIG, config || {});
    return stageHeight - c.paddleBottom - c.paddleHeight;
  }

  WB.Game = { create, playAreaBottom, CONFIG, ITEM_TYPES };
})();
