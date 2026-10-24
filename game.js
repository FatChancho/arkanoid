/*
 * game.js — Motor del juego.
 *
 * Responsabilidades:
 *  - Canvas de juego y su ciclo de vida (crear, redimensionar, retirar).
 *  - Pelotas, pala, vidas, puntuación, Game Over, victoria y reinicio.
 *  - Objetos (power-ups) que caen según la puntuación y sus efectos.
 *  - Entrada de teclado, ratón y táctil.
 *  - Efectos: fragmentos (trozos de la captura), polvo y sonido (audio.js).
 *  - HUD de progreso.
 *
 * El escenario (captura con lo destruido borrado) lo pinta la capa de
 * escena de destruction.js; las regiones y la colisión las resuelve el motor
 * de destrucción. Este módulo solo les pregunta y les ordena.
 *
 * COORDENADAS
 * El juego trabaja en un "escenario" del tamaño del viewport en el momento de
 * la captura. Si la ventana cambia de tamaño, el escenario se escala de forma
 * uniforme (con barras oscuras si cambia la proporción) porque la captura no
 * se puede repetir desde la página. El canvas se ajusta siempre a
 * devicePixelRatio.
 *
 * FÍSICA
 * Paso fijo de 1/60 s (la velocidad no depende de los Hz del monitor) y
 * subpasos de como mucho 3,5 px. La velocidad de cada pelota es constante.
 * Un contacto de una pelota con un objetivo destruye como mucho UNA región, y
 * tras un impacto esa pelota tiene un bloqueo de 3 subpasos en los que rebota
 * sin dañar, para que un mismo golpe no se lleve varios objetivos contiguos.
 *
 * OBJETOS (POWER-UPS)
 * Cada `powerupEvery` puntos (60 por defecto) cae un objeto desde el lugar del
 * impacto que cruzó el umbral. Los tipos salen de una "bolsa" barajada, así
 * que cada tres objetos aparecen los tres tipos:
 *   - multiball: cada pelota se triplica (±22° respecto a su trayectoria),
 *                hasta `maxBalls` pelotas.
 *   - wide:      la pala pasa de 110 a 190 px durante 20 s.
 *   - laser:     durante 15 s, clic del ratón (o Espacio, o tocar la pantalla)
 *                dispara dos proyectiles desde los extremos de la pala. Dejar
 *                pulsado repite el disparo con un enfriamiento de 14 pasos.
 *                Cada proyectil destruye como mucho una región, igual que la
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
    powerupEvery: 60,
    itemFallSpeed: 2.6,
    itemWidth: 36,
    itemHeight: 18,
    widePaddleWidth: 190,
    paddleEase: 0.22,
    wideSteps: 1200,
    laserSteps: 900,
    maxBalls: 9,
    splitAngle: 0.38,
    laserCooldownSteps: 14,
    boltSpeed: 11,
    boltStep: 3.7,
    boltRadius: 2
  };

  const STEP_MS = 1000 / 60;
  const GAME_KEYS = new Set(["ArrowLeft", "ArrowRight", " ", "a", "d", "r", "m"]);

  const ITEM_TYPES = ["multiball", "wide", "laser"];
  const ITEM_COLORS = { multiball: "#ffd166", wide: "#35d9ff", laser: "#ff5d73" };

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

  /**
   * options = { engine, sceneLayer, image, stage:{width,height},
   *             config?, audio?, onExit?, onError? }
   */
  function create(options) {
    const cfg = Object.assign({}, CONFIG, options.config || {});
    const { engine, sceneLayer, image } = options;
    const W = options.stage.width;
    const H = options.stage.height;

    const g = {
      active: false,
      state: "playing", // playing | gameover | won
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
      effects: { wide: 0, laser: 0 },
      cooldown: 0,
      firing: false,
      nextPowerup: cfg.powerupEvery,
      bag: [],
      spawned: 0,
      lastBoltHit: null,
      keys: new Set(),
      audio: null,
      fragments: [],
      dust: [],
      view: { scale: 1, offsetX: 0, offsetY: 0, dpr: 1 }
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

    function setCursor() {
      if (g.canvas) g.canvas.style.cursor = g.state === "playing" ? "none" : "default";
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
      setCursor();
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

      const scale = Math.min(vw / W, vh / H);
      g.view = {
        scale,
        offsetX: (vw - W * scale) / 2,
        offsetY: (vh - H * scale) / 2,
        dpr
      };
    }

    /* ---------------- Estado ---------------- */

    function newBall(x, y, vx, vy) {
      return { x, y, vx, vy, r: cfg.ballRadius, serve: 0, lock: 0, lost: false };
    }

    function spawnBall() {
      const angle = (Math.random() - 0.5) * 1.0;
      const b = newBall(
        g.paddleX,
        paddleY() - cfg.ballRadius - 1,
        Math.sin(angle) * cfg.ballSpeed,
        -Math.cos(angle) * cfg.ballSpeed
      );
      b.serve = cfg.serveDelaySteps;
      g.balls = [b];
    }

    /** Quita efectos, objetos en caída y proyectiles (vida perdida o reinicio). */
    function resetPowerups() {
      g.items = [];
      g.bolts = [];
      g.effects.wide = 0;
      g.effects.laser = 0;
      g.cooldown = 0;
      g.firing = false;
      g.paddleW = cfg.paddleWidth;
    }

    function restart() {
      engine.reset();
      sceneLayer.reset();
      g.score = 0;
      g.lives = cfg.maxLives;
      g.fragments = [];
      g.dust = [];
      g.state = "playing";
      g.keys.clear();
      g.nextPowerup = cfg.powerupEvery;
      g.bag = [];
      resetPowerups();
      spawnBall();
      setCursor();
    }

    function loseLife() {
      g.lives--;
      resetPowerups();
      if (g.lives <= 0) {
        g.lives = 0;
        g.state = "gameover";
        g.balls = [];
        setCursor();
        return;
      }
      spawnBall();
    }

    function finishGame() {
      g.state = "won";
      g.balls = [];
      g.items = [];
      g.bolts = [];
      g.firing = false;
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
    }

    /* ---------------- Impactos y puntuación ---------------- */

    /** Un impacto (de pelota o de proyectil) destruye la región del contacto. */
    function applyHit(contact, x, y) {
      const result = engine.hit(contact, { x, y });
      if (!result) return false;

      sceneLayer.erase(result.rects);
      addEffects(result.fragments);

      // Cuanto más área rompe el impacto, más larga y grave es la explosión.
      sfx("explosion", clamp(Math.sqrt(result.area) / 220 + (result.targetDestroyed ? 0.15 : 0), 0.2, 1));

      g.score += cfg.scorePerRegion;
      if (result.targetDestroyed && result.target.resistance > 1) {
        g.score += cfg.scoreTargetBonus;
      }

      if (result.targetDestroyed && engine.stats().remainingTargets === 0) {
        finishGame();
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
    }

    /** Cae un objeto cada vez que la puntuación cruza un múltiplo de powerupEvery. */
    function maybeDropItem(x, y) {
      if (cfg.powerupEvery <= 0 || g.state !== "playing") return;
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
          normalizeBall(clone);
          g.balls.push(clone);
        }
      }
    }

    function collectItem(type) {
      if (type === "multiball") splitBalls();
      else if (type === "wide") g.effects.wide = cfg.wideSteps;
      else if (type === "laser") {
        g.effects.laser = cfg.laserSteps;
        g.cooldown = 0;
      }
      sfx("pickup");
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
      if (g.effects.laser > 0 && (g.firing || g.keys.has(" "))) fireLaser();

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
    }

    function normalizeBall(b) {
      const speed = Math.hypot(b.vx, b.vy);
      if (!speed) {
        b.vx = 0;
        b.vy = -cfg.ballSpeed;
        return;
      }
      b.vx = (b.vx / speed) * cfg.ballSpeed;
      b.vy = (b.vy / speed) * cfg.ballSpeed;

      // Evita trayectorias casi horizontales (rebote infinito entre paredes).
      const minVy = cfg.ballSpeed * cfg.minVerticalRatio;
      if (Math.abs(b.vy) < minVy) {
        b.vy = (b.vy < 0 ? -1 : 1) * minVy;
        b.vx = (b.vx < 0 ? -1 : 1) * Math.sqrt(cfg.ballSpeed ** 2 - minVy ** 2);
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
      b.vx = Math.sin(angle) * cfg.ballSpeed;
      b.vy = -Math.cos(angle) * cfg.ballSpeed;
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
      const n = Math.max(1, Math.ceil(cfg.ballSpeed / cfg.maxSubstepDistance));

      for (const b of g.balls.slice()) {
        if (g.state !== "playing") return;

        if (b.serve > 0) {
          b.serve--;
          b.x = g.paddleX;
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

    function drawItems(ctx) {
      for (const it of g.items) {
        const w = cfg.itemWidth;
        const h = cfg.itemHeight;
        ctx.save();
        ctx.translate(it.x, it.y);
        ctx.shadowColor = ITEM_COLORS[it.type];
        ctx.shadowBlur = 12;
        ctx.fillStyle = ITEM_COLORS[it.type];
        roundRectPath(ctx, -w / 2, -h / 2, w, h, h / 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        drawItemIcon(ctx, it.type);
        ctx.restore();
      }
    }

    function drawBolts(ctx) {
      if (!g.bolts.length) return;
      ctx.save();
      ctx.strokeStyle = "#ff5d73";
      ctx.shadowColor = "#ff5d73";
      ctx.shadowBlur = 10;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      for (const b of g.bolts) {
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x, b.y + 14);
        ctx.stroke();
      }
      ctx.restore();
    }


function drawPaddle(ctx) {
  const x = g.paddleX - cfg.paddleWidth / 2
  const y = paddleY()

  // Sombra para separarla del fondo de la página
  ctx.shadowColor = "rgba(0, 180, 255, 0.6)"
  ctx.shadowBlur = 8

  // Cuerpo turquesa
  ctx.fillStyle = "#00D9FF"

  roundRectPath(
    ctx,
    x,
    y,
    cfg.paddleWidth,
    cfg.paddleHeight,
    7
  )

  ctx.fill()

  // Borde azul oscuro
  ctx.shadowBlur = 0
  ctx.strokeStyle = "#075985"
  ctx.lineWidth = 2

  roundRectPath(
    ctx,
    x,
    y,
    cfg.paddleWidth,
    cfg.paddleHeight,
    7
  )

  ctx.stroke()

  // Reflejo superior
  ctx.beginPath()
  ctx.moveTo(x + 9, y + 3)
  ctx.lineTo(x + cfg.paddleWidth - 9, y + 3)

  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)"
  ctx.lineWidth = 1.5
  ctx.stroke()
}


    function drawBalls(ctx) {
      ctx.fillStyle = "#ffd166";
      ctx.shadowColor = "#ffd166";
      ctx.shadowBlur = 12;
      for (const b of g.balls) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    function drawHud(ctx) {
      const s = engine.stats();
      const pct = Math.min(100, Math.floor(s.percentDestroyed));
      const panelW = Math.min(300, W - 28);

      ctx.fillStyle = "rgba(12, 17, 27, 0.88)";
      roundRectPath(ctx, 14, 14, panelW, 142, 12);
      ctx.fill();

      ctx.textBaseline = "top";
      ctx.textAlign = "start";
      ctx.font = "bold 15px system-ui, sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText("Puntos: " + g.score, 28, 26);
      ctx.fillText("Vidas: " + ("♥ ".repeat(g.lives).trim() || "—"), 28, 48);

      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "#cbd5e1";
      ctx.fillText(
        "Destruidos: " + s.destroyedTargets + "   Restantes: " + s.remainingTargets,
        28,
        72
      );

      const barX = 28;
      const barW = panelW - 28;
      ctx.fillStyle = "rgba(255,255,255,0.2)";
      ctx.fillRect(barX, 94, barW, 8);
      ctx.fillStyle = "#ffd166";
      ctx.fillRect(barX, 94, barW * (pct / 100), 8);

      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(pct + "% de la superficie destruida", barX, 110);

      const sound = g.audio ? g.audio.state() : "unavailable";
      const hint =
        sound === "on" ? "M: silenciar el sonido"
        : sound === "muted" ? "M: activar el sonido"
        : sound === "unavailable" ? ""
        : "Haz clic o pulsa una tecla para activar el sonido";
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillStyle = "#cbd5e1";
      ctx.fillText(hint, barX, 128);

      drawEffectsPanel(ctx, panelW);
    }

    /** Efectos activos con su tiempo restante. */
    function drawEffectsPanel(ctx, panelW) {
      const rows = [];
      if (g.balls.length > 1) {
        rows.push({ label: "Bolas: " + g.balls.length, color: ITEM_COLORS.multiball, frac: 1 });
      }
      if (g.effects.wide > 0) {
        rows.push({
          label: "Barra grande · " + Math.ceil(g.effects.wide / 60) + " s",
          color: ITEM_COLORS.wide,
          frac: g.effects.wide / cfg.wideSteps
        });
      }
      if (g.effects.laser > 0) {
        rows.push({
          label: "Láser (clic o Espacio) · " + Math.ceil(g.effects.laser / 60) + " s",
          color: ITEM_COLORS.laser,
          frac: g.effects.laser / cfg.laserSteps
        });
      }
      if (!rows.length) return;

      const top = 14 + 142 + 8;
      ctx.fillStyle = "rgba(12, 17, 27, 0.88)";
      roundRectPath(ctx, 14, top, panelW, 12 + rows.length * 30, 12);
      ctx.fill();

      ctx.textBaseline = "top";
      ctx.font = "bold 12px system-ui, sans-serif";
      rows.forEach((row, i) => {
        const y = top + 10 + i * 30;
        ctx.fillStyle = "#ffffff";
        ctx.fillText(row.label, 28, y);
        ctx.fillStyle = "rgba(255,255,255,0.2)";
        ctx.fillRect(28, y + 17, panelW - 28, 5);
        ctx.fillStyle = row.color;
        ctx.fillRect(28, y + 17, (panelW - 28) * clamp(row.frac, 0, 1), 5);
      });
    }

    function drawOverlay(ctx) {
      if (g.state === "playing") return;
      ctx.fillStyle = "rgba(0, 0, 0, 0.76)";
      ctx.fillRect(0, 0, W, H);

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 42px system-ui, sans-serif";
      ctx.fillText(g.state === "won" ? "¡HAS DESTRUIDO LA PÁGINA!" : "GAME OVER", W / 2, H / 2 - 48);
      ctx.font = "20px system-ui, sans-serif";
      ctx.fillText("Puntuación: " + g.score, W / 2, H / 2);
      ctx.font = "16px system-ui, sans-serif";
      ctx.fillStyle = "#ffd166";
      ctx.fillText("Haz clic o pulsa R para volver a jugar · Escape para salir", W / 2, H / 2 + 42);
      ctx.textAlign = "start";
    }

    function draw() {
      const ctx = g.ctx;
      const v = g.view;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = cfg.destroyColor;
      ctx.fillRect(0, 0, g.canvas.width, g.canvas.height);

      ctx.setTransform(v.dpr * v.scale, 0, 0, v.dpr * v.scale, v.dpr * v.offsetX, v.dpr * v.offsetY);
      sceneLayer.draw(ctx, 0, 0, W, H);

      drawFragments(ctx);
      drawDust(ctx);
      drawItems(ctx);
      drawBolts(ctx);
      drawPaddle(ctx);
      drawBalls(ctx);
      drawHud(ctx);
      drawOverlay(ctx);
    }

    /* ---------------- Entrada ---------------- */

    function onMouseMove(event) {
      g.inputMode = "mouse";
      g.mouseX = toStageX(event.clientX);
    }

    function onKeyDown(event) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      if (key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
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
      if (key === "r") {
        if (!event.repeat) restart();
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
      // Clic izquierdo = disparo (solo si el láser está activo).
      if (event.type === "mousedown" && event.button === 0 && g.state === "playing") {
        g.firing = true;
        fireLaser();
      }
    }

    function onMouseUp() {
      g.firing = false;
    }

    function onClick(event) {
      swallow(event);
      if (event.target !== g.canvas) return;
      unlockAudio();
      if (g.state !== "playing") {
        restart();
        return;
      }
      if (toStageY(event.clientY) >= paddleY() - 50) {
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
      if (event.type === "touchstart" && g.state === "playing") {
        g.firing = true;
        fireLaser();
      }
    }

    function onTouchEnd() {
      g.firing = false;
      unlockAudio();
    }

    function onWheel(event) {
      event.preventDefault();
    }

    function onBlur() {
      g.keys.clear();
      g.firing = false;
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
      listen(window, "mouseup", onMouseUp, true);
      listen(window, "wheel", onWheel, { capture: true, passive: false });
      listen(window, "touchstart", onTouch, { capture: true, passive: false });
      listen(window, "touchmove", onTouch, { capture: true, passive: false });
      listen(window, "touchend", onTouchEnd, true);
      listen(window, "touchcancel", onTouchEnd, true);
      listen(window, "blur", onBlur);
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
      resetPowerups();

      g.audio = options.audio !== undefined ? options.audio : WB.Audio ? WB.Audio.create() : null;
      if (g.audio) g.audio.tryStart();

      createCanvas();
      resize();
      attach();
      spawnBall();

      // Que ninguna caja de texto de la página siga recibiendo teclas.
      if (document.activeElement && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }
      g.raf = requestAnimationFrame(frame);
    }

    /** Retira canvas, listeners y animación. No toca el motor ni la capa. */
    function stop() {
      if (!g.active) return;
      g.active = false;

      if (g.raf) cancelAnimationFrame(g.raf);
      g.raf = 0;

      for (const remove of removers) remove();
      removers.length = 0;

      if (g.canvas) g.canvas.remove();
      g.canvas = null;
      g.ctx = null;

      if (g.audio) g.audio.dispose();
      g.audio = null;

      g.keys.clear();
      g.firing = false;
      g.fragments = [];
      g.dust = [];
      g.balls = [];
      g.items = [];
      g.bolts = [];
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
          wideSeconds: Math.ceil(g.effects.wide / 60),
          laserSeconds: Math.ceil(g.effects.laser / 60)
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
        press(down) { g.firing = Boolean(down); }
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
