
(() => {
  // Evita instancias duplicadas.
  if (window.__webBreakout?.cleanup) {
    window.__webBreakout.cleanup();
  }

  const CONFIG = {
    maxBlocks: 70,
    minWidth: 24,
    minHeight: 18,
    maxElementArea: 0.88,
    blockResistance: 2,

    paddleWidth: 110,
    paddleHeight: 12,
    paddleBottom: 28,

    ballRadius: 7,
    ballSpeed: 10,

    particlesPerHit: 8,
    maxParticles: 120,
  };

  const SELECTORS = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'li', 'blockquote', 'pre', 'code',
    'img', 'svg', 'picture', 'video', 'figure', 'canvas',
    'button', 'input', 'textarea', 'select',
    'a, [role="link"]',
    'a[href]', 'summary', 'article', 'section', 'aside',
    'td', 'th', 'tr',
    '[role="button"]', '[role="img"]', '[role="listitem"]',
    '[class*="card"]', '[class*="tile"]', '[class*="product"]',
    '[class*="item"]', '[class*="thumbnail"]', '[class*="banner"]',
    'img','svg','svg image','[role="img"]','[aria-label]','[title]',
  ];

  const state = {
    active: false,
    gameOver: false,
    lives: 3,

    canvas: null,
    ctx: null,
    animationFrame: null,
    lastTime: 0,

    blocks: [],
    particles: [],

    score: 0,
    paddleX: 0,
    ball: null,

    totalBlocks: 0,
    destroyedBlocks: 0,

    keys: {
      left: false,
      right: false,
    },

    mouseX: null,
    listeners: [],
    originalVisibility: new Map(),
  };

  // --------------------------------------------------
  // Mensajes a popup.js
  // --------------------------------------------------

  function sendStatus(active, message = '') {
    try {
      chrome.runtime.sendMessage({
        type: 'gameStatus',
        active,
        message,
        score: state.score,
      }).catch(() => {});
    } catch {
      // La extensión puede haberse recargado.
    }
  }

  function addListener(target, event, handler, options) {
    target.addEventListener(event, handler, options);

    state.listeners.push(() => {
      target.removeEventListener(event, handler, options);
    });
  }

  // --------------------------------------------------
  // Restauración de los elementos de la página
  // --------------------------------------------------

  function restoreVisibility() {
    for (const [element, original] of state.originalVisibility) {
      if (!element?.style) continue;

      if (original.hadInlineVisibility) {
        element.style.setProperty(
          'visibility',
          original.value,
          original.priority,
        );
      } else {
        element.style.removeProperty('visibility');
      }
    }

    state.originalVisibility.clear();
  }

  function hideElement(element) {
    if (!element?.style || !element.isConnected) return;

    if (!state.originalVisibility.has(element)) {
      state.originalVisibility.set(element, {
        hadInlineVisibility:
          element.style.getPropertyValue('visibility') !== '',
        value: element.style.getPropertyValue('visibility'),
        priority: element.style.getPropertyPriority('visibility'),
      });
    }

    element.style.setProperty('visibility', 'hidden', 'important');
  }

  // --------------------------------------------------
  // Detección de bloques invisibles
  // --------------------------------------------------

  function getElementArea(rect) {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function isVisibleCandidate(element) {
    if (
      !(element instanceof HTMLElement) &&
      !(element instanceof SVGElement)
    ) {
      return false;
    }

    if (!element.isConnected) return false;

    if (element.closest(
      'script, style, noscript, template, head, meta, link, title'
    )) {
      return false;
    }

    // No detectar elementos pertenecientes al propio juego.
    if (element.closest('#webbreakout-canvas')) return false;

    const style = getComputedStyle(element);

    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number(style.opacity) === 0
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();

    if (
      rect.width < CONFIG.minWidth ||
      rect.height < CONFIG.minHeight ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= window.innerHeight ||
      rect.left >= window.innerWidth
    ) {
      return false;
    }

    const viewportArea = window.innerWidth * window.innerHeight;

    if (getElementArea(rect) > viewportArea * CONFIG.maxElementArea) {
      return false;
    }

    return true;
  }

  function getBlockTarget(element) {
    if (!element.matches('input, textarea, select')) {
      return element;
    }

    let parent = element.parentElement;

    for (let i = 0; parent && i < 5; i++, parent = parent.parentElement) {
      const rect = parent.getBoundingClientRect();

      // Evitar seleccionar contenedores demasiado grandes.
      if (
        rect.width < 120 ||
        rect.height < 30 ||
        rect.width > Math.min(window.innerWidth * 0.8, 900) ||
        rect.height > 160
      ) {
        continue;
      }

      const style = window.getComputedStyle(parent);

      const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(side => {
        const width = parseFloat(style[`border${side}Width`]);
        const borderStyle = style[`border${side}Style`];
        const color = style[`border${side}Color`];

        return (
          width > 0 &&
          borderStyle !== 'none' &&
          color !== 'rgba(0, 0, 0, 0)' &&
          !color.endsWith(', 0)')
        );
      });

      const hasShadow = style.boxShadow !== 'none';

      if (hasBorder || hasShadow) {
        return parent;
      }
    }

    // Si no encuentra un contenedor visual, conserva el elemento original.
    return element;
  }

  function detectBlocks() {
    const candidates = new Set();

    // Detectar elementos que coincidan con los selectores.
    try {
      document
        .querySelectorAll(SELECTORS.join(','))
        .forEach((element) => {
          const target = getBlockTarget(element);

          if (
            isVisibleCandidate(target) &&
            !target.closest('#webbreakout-canvas')
          ) {
            candidates.add(target);
          }
        });
    } catch (error) {
      console.warn('WebBreakout: error al detectar elementos:', error);
    }

    // Medir los candidatos detectados.
    const measured = [...candidates].map((element) => {
      const rect = element.getBoundingClientRect();

      return {
        element,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        area: getElementArea(rect),
      };
    });

    // Priorizar elementos pequeños para evitar seleccionar
    // contenedores grandes que cubran otros elementos.
    measured.sort((a, b) => a.area - b.area);

    const selected = [];

    for (const candidate of measured) {
      if (selected.length >= CONFIG.maxBlocks) break;

      const rect = candidate.element.getBoundingClientRect();
      const candidateArea = getElementArea(rect);

      if (candidateArea <= 0) continue;

      // Evitar bloques que estén prácticamente cubiertos
      // por otro bloque seleccionado.
      const coveredByExisting = selected.some((block) => {
        const other = block.element.getBoundingClientRect();

        const left = Math.max(rect.left, other.left);
        const top = Math.max(rect.top, other.top);
        const right = Math.min(rect.right, other.right);
        const bottom = Math.min(rect.bottom, other.bottom);

        if (right <= left || bottom <= top) return false;

        const overlapArea = (right - left) * (bottom - top);

        return overlapArea / candidateArea > 0.88;
      });

      if (coveredByExisting) continue;

      selected.push({
        element: candidate.element,
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
        resistance: CONFIG.blockResistance,
        maxResistance: CONFIG.blockResistance,
        alive: true,
      });
    }

    return selected;
  }

  // --------------------------------------------------
  // Canvas
  // --------------------------------------------------

  function createCanvas() {
    const canvas = document.createElement('canvas');

    canvas.id = 'webbreakout-canvas';
    canvas.setAttribute('aria-hidden', 'true');

    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      zIndex: '2147483647',
      pointerEvents: 'none',
      background: 'transparent',
    });

    document.documentElement.appendChild(canvas);

    state.canvas = canvas;
    state.ctx = canvas.getContext('2d');

    resizeCanvas();
  }

  function resizeCanvas() {
    if (!state.canvas || !state.ctx) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);

    state.canvas.width = Math.round(window.innerWidth * dpr);
    state.canvas.height = Math.round(window.innerHeight * dpr);

    state.canvas.style.width = `${window.innerWidth}px`;
    state.canvas.style.height = `${window.innerHeight}px`;

    state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    state.paddleX = Math.max(
      0,
      Math.min(
        state.paddleX,
        window.innerWidth - CONFIG.paddleWidth,
      ),
    );
  }

  // --------------------------------------------------
  // Pelota y partículas
  // --------------------------------------------------

  function createBall() {
    return {
      x: window.innerWidth / 2,
      y: window.innerHeight * 0.65,
      vx: CONFIG.ballSpeed * 0.65,
      vy: -CONFIG.ballSpeed,
      radius: CONFIG.ballRadius,
    };
  }

  let audioContext = null;

function playHitSound(destroyed = false) {
  try {
    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) return;

    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContextClass();
    }

    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const now = audioContext.currentTime;

    oscillator.type = destroyed ? 'square' : 'sine';
    oscillator.frequency.setValueAtTime(
      destroyed ? 880 : 440,
      now,
    );

    oscillator.frequency.exponentialRampToValueAtTime(
      destroyed ? 220 : 300,
      now + 0.08,
    );

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(now);
    oscillator.stop(now + 0.09);
  } catch (error) {
    console.debug('WebBreakout: no se pudo reproducir el sonido.', error);
  }
}

  function createParticles(x, y, color = '#ffcf5c') {
    for (let i = 0; i < CONFIG.particlesPerHit; i++) {
      if (state.particles.length >= CONFIG.maxParticles) {
        state.particles.shift();
      }

      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 3;

      state.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        size: 2 + Math.random() * 3,
        color,
      });
    }
  }

  function updateParticles(delta) {
    const factor = delta / 16.67;

    for (const particle of state.particles) {
      particle.x += particle.vx * factor;
      particle.y += particle.vy * factor;
      particle.vy += 0.04 * factor;
      particle.life -= 0.025 * factor;
    }

    state.particles = state.particles.filter(
      (particle) => particle.life > 0,
    );
  }

  // --------------------------------------------------
  // Colisiones
  // --------------------------------------------------

  function circleIntersectsRect(ball, rect) {
    const closestX = Math.max(
      rect.left,
      Math.min(ball.x, rect.right),
    );

    const closestY = Math.max(
      rect.top,
      Math.min(ball.y, rect.bottom),
    );

    const dx = ball.x - closestX;
    const dy = ball.y - closestY;

    return dx * dx + dy * dy <= ball.radius * ball.radius;
  }

  function updateBlocks() {
    for (const block of state.blocks) {
      if (!block.alive || !block.element?.isConnected) continue;

      const rect = block.element.getBoundingClientRect();

      block.x = rect.left;
      block.y = rect.top;
      block.width = rect.width;
      block.height = rect.height;
    }
  }

  function hitBlock(block) {
    if (!block.alive) return;

    block.resistance--;

    if (block.resistance <= 0) {
      state.destroyedBlocks++;
      block.alive = false;

      hideElement(block.element);

      state.score += 10;

      // Animación de destrucción: amarillo.
      createParticles(
        block.x + block.width / 2,
        block.y + block.height / 2,
        '#ffcf5c',
      );

      playHitSound(true);
    }
  }

  function updateBall(delta) {
    if (state.gameOver || !state.ball) return;

    const ball = state.ball;
    const factor = Math.min(delta / 16.67, 2);

    ball.x += ball.vx * factor;
    ball.y += ball.vy * factor;

    // Paredes laterales.
    if (ball.x - ball.radius <= 0) {
      ball.x = ball.radius;
      ball.vx = Math.abs(ball.vx);
    }

    if (ball.x + ball.radius >= window.innerWidth) {
      ball.x = window.innerWidth - ball.radius;
      ball.vx = -Math.abs(ball.vx);
    }

    // Techo.
    if (ball.y - ball.radius <= 0) {
      ball.y = ball.radius;
      ball.vy = Math.abs(ball.vy);
    }

    // Pala.
    const paddleY =
      window.innerHeight -
      CONFIG.paddleBottom -
      CONFIG.paddleHeight;

    const paddleRect = {
      left: state.paddleX,
      right: state.paddleX + CONFIG.paddleWidth,
      top: paddleY,
      bottom: paddleY + CONFIG.paddleHeight,
    };

    if (
      ball.vy > 0 &&
      circleIntersectsRect(ball, paddleRect)
    ) {
      ball.y = paddleY - ball.radius;

      const hitPosition =
        (ball.x - (state.paddleX + CONFIG.paddleWidth / 2)) /
        (CONFIG.paddleWidth / 2);

      ball.vx = hitPosition * CONFIG.ballSpeed;

      ball.vy = -Math.max(
        2.5,
        Math.sqrt(
          Math.max(
            0,
            CONFIG.ballSpeed ** 2 - ball.vx ** 2,
          ),
        ),
      );
    }

    // Bloques invisibles del DOM.
    for (const block of state.blocks) {
      if (!block.alive) continue;

      if (!block.element?.isConnected) {
        block.alive = false;
        continue;
      }

      const rect = block.element.getBoundingClientRect();

      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.bottom <= 0 ||
        rect.top >= window.innerHeight ||
        rect.right <= 0 ||
        rect.left >= window.innerWidth
      ) {
        continue;
      }

      block.x = rect.left;
      block.y = rect.top;
      block.width = rect.width;
      block.height = rect.height;

      if (!circleIntersectsRect(ball, rect)) continue;

const now = performance.now();
const canDamage =
  now - (block.lastHitAt ?? -Infinity) >= 250;

if (canDamage) {
  block.lastHitAt = now;

  // Animación de impacto: azul eléctrico.
  createParticles(
    ball.x,
    ball.y,
    '#35d9ff',
  );

  playHitSound();

  hitBlock(block);
}

      const overlapLeft = Math.abs(
        ball.x + ball.radius - rect.left,
      );

      const overlapRight = Math.abs(
        rect.right - (ball.x - ball.radius),
      );

      const overlapTop = Math.abs(
        ball.y + ball.radius - rect.top,
      );

      const overlapBottom = Math.abs(
        rect.bottom - (ball.y - ball.radius),
      );

      const horizontal = Math.min(overlapLeft, overlapRight);
      const vertical = Math.min(overlapTop, overlapBottom);

      if (horizontal < vertical) {
        ball.vx *= -1;
      } else {
        ball.vy *= -1;
      }

      // Un impacto por frame.
      break;
    }

    // Game Over: no reiniciar la pelota automáticamente.
    if (ball.y - ball.radius > window.innerHeight) {
      state.lives--;

      state.keys.left = false;
      state.keys.right = false;
      state.mouseX = null;

      if (state.lives <= 0) {
        state.lives = 0;
        state.gameOver = true;
        sendStatus(true, 'Game Over');
      } else {
        // Nueva pelota, conservando la puntuación y los bloques destruidos.
        state.ball = createBall();
        state.ball.y = window.innerHeight * 0.65;
        state.ball.vy = -CONFIG.ballSpeed;
      }
    }
  }

  // --------------------------------------------------
  // Movimiento de la pala
  // --------------------------------------------------

  function updatePaddle() {
    if (state.gameOver) return;

    const maxX = Math.max(
      0,
      window.innerWidth - CONFIG.paddleWidth,
    );

    if (state.mouseX !== null) {
      state.paddleX = Math.max(
        0,
        Math.min(
          maxX,
          state.mouseX - CONFIG.paddleWidth / 2,
        ),
      );

      return;
    }

    if (state.keys.left) state.paddleX -= 7;
    if (state.keys.right) state.paddleX += 7;

    state.paddleX = Math.max(
      0,
      Math.min(maxX, state.paddleX),
    );
  }

  function onMouseMove(event) {
    if (state.gameOver) return;
    state.mouseX = event.clientX;
  }

  function onKeyDown(event) {
    if (
      ['ArrowLeft', 'ArrowRight', 'a', 'A', 'd', 'D'].includes(event.key)
    ) {
      if (
        event.key === 'ArrowLeft' ||
        event.key.toLowerCase() === 'a'
      ) {
        state.keys.left = true;
      }

      if (
        event.key === 'ArrowRight' ||
        event.key.toLowerCase() === 'd'
      ) {
        state.keys.right = true;
      }
    }
  }

  function onKeyUp(event) {
    if (
      event.key === 'ArrowLeft' ||
      event.key.toLowerCase() === 'a'
    ) {
      state.keys.left = false;
    }

    if (
      event.key === 'ArrowRight' ||
      event.key.toLowerCase() === 'd'
    ) {
      state.keys.right = false;
    }
  }

  // --------------------------------------------------
  // Dibujado
  // --------------------------------------------------

  function drawBall() {
    if (!state.ball) return;

    const ctx = state.ctx;
    const ball = state.ball;

    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);

    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawPaddle() {
    const ctx = state.ctx;

    const y =
      window.innerHeight -
      CONFIG.paddleBottom -
      CONFIG.paddleHeight;

    ctx.fillStyle = '#ffffff';

    ctx.fillRect(
      state.paddleX,
      y,
      CONFIG.paddleWidth,
      CONFIG.paddleHeight,
    );

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 2;

    ctx.strokeRect(
      state.paddleX,
      y,
      CONFIG.paddleWidth,
      CONFIG.paddleHeight,
    );
  }

  function drawParticles() {
    const ctx = state.ctx;

    for (const particle of state.particles) {
      ctx.globalAlpha = Math.max(0, particle.life);
      ctx.fillStyle = particle.color;

      ctx.beginPath();
      ctx.arc(
        particle.x,
        particle.y,
        particle.size,
        0,
        Math.PI * 2,
      );

      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }

  function drawHUD() {
    const ctx = state.ctx;

    const remaining = Math.max(
      0,
      state.totalBlocks - state.destroyedBlocks,
    );

    const percentage = state.totalBlocks > 0
      ? Math.round((remaining / state.totalBlocks) * 100)
      : 0;

    const x = 12;
    const y = 12;
    const width = 250;
    const height = 76;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
    ctx.fillRect(x, y, width, height);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    ctx.fillText(`Score: ${state.score}`, x + 10, y + 8);
    ctx.fillText(`Vidas: ${state.lives}`, x + 145, y + 8);

    ctx.font = '13px sans-serif';
    ctx.fillText(`${percentage}% restante`, x + 10, y + 32);

    const barX = x + 10;
    const barY = y + 53;
    const barWidth = width - 20;
    const barHeight = 10;

    // Fondo de la barra.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fillRect(barX, barY, barWidth, barHeight);

    // Progreso restante.
    ctx.fillStyle = percentage > 50 ? '#35d9ff' : '#ffcf5c';
    ctx.fillRect(
      barX,
      barY,
      barWidth * (percentage / 100),
      barHeight,
    );
  }

  function drawGameOver() {
    const ctx = state.ctx;
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Fondo semitransparente.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
    ctx.fillRect(0, 0, width, height);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText(
      'GAME OVER',
      width / 2,
      height / 2 - 45,
    );

    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(
      `Score: ${state.score}`,
      width / 2,
      height / 2 + 5,
    );

    ctx.font = '17px sans-serif';
    ctx.fillStyle = '#ffcf5c';

    ctx.fillText(
      'Haz clic para volver a jugar',
      width / 2,
      height / 2 + 55,
    );
  }

  function draw() {
    if (!state.ctx) return;

    const ctx = state.ctx;

    ctx.clearRect(
      0,
      0,
      window.innerWidth,
      window.innerHeight,
    );

    // Los bloques DOM no se dibujan.
    drawParticles();
    drawPaddle();
    drawBall();
    drawHUD();

    if (state.gameOver) {
      drawGameOver();
    }
  }

  // --------------------------------------------------
  // Game Over y reinicio
  // --------------------------------------------------

  function restartGame() {
    if (!state.active || !state.gameOver) return;

    // Recuperar elementos destruidos para la nueva partida.
    restoreVisibility();

    state.blocks = detectBlocks();

    state.totalBlocks = state.blocks.length;
    state.destroyedBlocks = 0;

    state.particles = [];
    state.score = 0;
    state.gameOver = false;
    state.lastTime = 0;
    state.mouseX = null;

    state.keys.left = false;
    state.keys.right = false;

    state.paddleX =
      (window.innerWidth - CONFIG.paddleWidth) / 2;

    state.ball = createBall();

    sendStatus(true, 'Game restarted');
  }

  function onGameClick(event) {
    if (!state.active || !state.gameOver) return;

    // No activar enlaces o botones de la web al reiniciar.
    event.preventDefault();
    event.stopPropagation();

    restartGame();
  }

  // --------------------------------------------------
  // Bucle del juego
  // --------------------------------------------------

  function gameLoop(timestamp) {
    if (!state.active) return;

    const delta = state.lastTime
      ? Math.min(timestamp - state.lastTime, 40)
      : 16.67;

    state.lastTime = timestamp;

    updateBlocks();
    updatePaddle();
    updateBall(delta);
    updateParticles(delta);
    draw();

    state.animationFrame = requestAnimationFrame(gameLoop);
  }

  // --------------------------------------------------
  // Activar y desactivar
  // --------------------------------------------------

  function startGame() {
    if (state.active) return;

    restoreVisibility();

    state.blocks = detectBlocks();

    state.totalBlocks = state.blocks.length;
    state.destroyedBlocks = 0;

    if (state.blocks.length === 0) {
      sendStatus(false, 'No playable elements found on this page.');
      return;
    }

    state.particles = [];
    state.score = 0;
    state.gameOver = false;
    state.lastTime = 0;
    state.mouseX = null;

    state.keys.left = false;
    state.keys.right = false;

    state.paddleX =
      (window.innerWidth - CONFIG.paddleWidth) / 2;

    state.ball = createBall();
    state.active = true;

    createCanvas();

    if (!state.ctx) {
      stopGame();
      sendStatus(false, 'Unable to create canvas context.');
      return;
    }

    addListener(window, 'mousemove', onMouseMove, {
      passive: true,
    });

    addListener(window, 'keydown', onKeyDown);
    addListener(window, 'keyup', onKeyUp);

    addListener(window, 'resize', resizeCanvas, {
      passive: true,
    });

    addListener(window, 'scroll', updateBlocks, {
      passive: true,
      capture: true,
    });

    // El clic solo se intercepta cuando aparece Game Over.
    addListener(window, 'click', onGameClick, true);

    state.animationFrame = requestAnimationFrame(gameLoop);

    sendStatus(true, 'Game started');
  }

  function stopGame() {
    const wasActive = state.active;

    state.active = false;

    if (state.animationFrame !== null) {
      cancelAnimationFrame(state.animationFrame);
      state.animationFrame = null;
    }

    for (const removeListener of state.listeners) {
      removeListener();
    }

    state.listeners = [];

    if (state.canvas) {
      state.canvas.remove();
      state.canvas = null;
      state.ctx = null;
    }

    restoreVisibility();

    state.blocks = [];
    state.particles = [];
    state.ball = null;
    state.mouseX = null;
    state.lastTime = 0;
    state.gameOver = false;

    state.keys.left = false;
    state.keys.right = false;

    if (wasActive) {
      sendStatus(false, 'Game stopped');
    }
  }

  function cleanup() {
    stopGame();

    chrome.runtime.onMessage.removeListener(messageListener);

    delete window.__webBreakout;
  }

  // --------------------------------------------------
  // Comunicación con popup.js
  // Utiliza message.action, como tu popup actual.
  // --------------------------------------------------

  function messageListener(message, sender, sendResponse) {
    if (!message || typeof message.action !== 'string') return;

    switch (message.action) {
      case 'activate':
        startGame();

        sendResponse({
          ok: state.active,
          active: state.active,
          error: state.active
            ? undefined
            : 'No se han encontrado elementos jugables.',
        });
        break;

      case 'deactivate':
        stopGame();

        sendResponse({
          ok: true,
          active: false,
        });
        break;

      case 'toggle':
        if (state.active) {
          stopGame();
        } else {
          startGame();
        }

        sendResponse({
          ok: state.active,
          active: state.active,
        });
        break;

      case 'getStatus':
        sendResponse({
          ok: true,
          active: state.active,
          gameOver: state.gameOver,
          score: state.score,
        });
        break;

      default:
        sendResponse({
          ok: false,
          error: `Acción desconocida: ${message.action}`,
        });
    }

    return false;
  }

  chrome.runtime.onMessage.addListener(messageListener);

  window.__webBreakout = {
    startGame,
    stopGame,
    cleanup,
  };
})();
