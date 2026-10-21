(() => {
  // Prevent duplicate content-script instances after extension reloads.
  if (window.__webBreakout?.cleanup) {
    window.__webBreakout.cleanup();
  }

  const CONFIG = {
    minWidth: 36,
    minHeight: 24,
    maxBlocks: 70,
    paddleWidth: 110,
    paddleHeight: 12,
    paddleBottom: 34,
    ballRadius: 8,
    ballSpeed: 10,
    maxParticles: 180,
    selectors: [
      'img', 'picture', 'button', 'input', 'textarea', 'select',
      'a', 'article', 'section', 'main > div',
      'h1', 'h2', 'h3', 'p', 'li'
    ].join(',')
  };

  let active = false;
  let gameOver = false;
  let animationId = 0;
  let canvas = null;
  let ctx = null;
  let blocks = [];
  let particles = [];
  let score = 0;
  let lives = 3;
  let paddle = null;
  let ball = null;
  let lastTime = 0;
  let lastMouseX = window.innerWidth / 2;

  function resistanceFor(el) {
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
    if (/card|container|section|article|banner|hero/.test(cls) || ['article', 'section'].includes(tag)) return 3;
    if (['img', 'picture', 'video'].includes(tag) || /image|photo|media/.test(cls)) return 2;
    return 1;
  }

  function detectBlocks() {
    const candidates = Array.from(document.querySelectorAll(CONFIG.selectors));
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const found = [];
    const seenRects = new Set();

    for (const el of candidates) {
      if (!el.isConnected || canvas?.contains(el)) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < CONFIG.minWidth || rect.height < CONFIG.minHeight) continue;
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= viewportHeight || rect.left >= viewportWidth) continue;
      if (style.position === 'fixed' && Number(style.zIndex) > 1000) continue;

      const x = Math.max(0, rect.left);
      const y = Math.max(0, rect.top);
      const width = Math.min(viewportWidth, rect.right) - x;
      const height = Math.min(viewportHeight, rect.bottom) - y;
      if (width < CONFIG.minWidth || height < CONFIG.minHeight) continue;

      // Avoid identical boxes and overly large page wrappers swallowing the whole page.
      if (width > viewportWidth * 0.96 && height > viewportHeight * 0.8) continue;
      const key = [Math.round(x), Math.round(y), Math.round(width), Math.round(height)].join(':');
      if (seenRects.has(key)) continue;
      seenRects.add(key);

      found.push({
        x, y, width, height,
        type: el.tagName.toLowerCase(),
        resistance: resistanceFor(el),
        maxResistance: resistanceFor(el),
        alive: true
      });
    }

    // Prefer larger semantic elements and cap the number for performance.
    found.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    const selected = [];
    for (const block of found) {
      // Skip a small block almost completely covered by an already selected block.
      const covered = selected.some(other => {
        const overlapW = Math.max(0, Math.min(block.x + block.width, other.x + other.width) - Math.max(block.x, other.x));
        const overlapH = Math.max(0, Math.min(block.y + block.height, other.y + other.height) - Math.max(block.y, other.y));
        return overlapW * overlapH > block.width * block.height * 0.88;
      });
      if (!covered) selected.push(block);
      if (selected.length >= CONFIG.maxBlocks) break;
    }
    return selected;
  }

  function createParticles(block) {
    const count = 10;
    for (let i = 0; i < count && particles.length < CONFIG.maxParticles; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 3;
      particles.push({
        x: block.x + block.width / 2,
        y: block.y + block.height / 2,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 2 + Math.random() * 3,
        life: 1,
        color: colorFor(block.type)
      });
    }
  }

  function colorFor(type) {
    if (['img', 'picture', 'video'].includes(type)) return '#e74c3c';
    if (['button', 'input', 'textarea', 'select'].includes(type)) return '#f39c12';
    if (['h1', 'h2', 'h3', 'p', 'li'].includes(type)) return '#1abc9c';
    if (['article', 'section'].includes(type)) return '#2ecc71';
    return '#3498db';
  }

  function resetBall() {
    if (!paddle || !canvas) return;
    ball = {
      x: paddle.x + paddle.width / 2,
      y: paddle.y - CONFIG.ballRadius - 2,
      vx: (Math.random() < 0.5 ? -1 : 1) * CONFIG.ballSpeed * 0.65,
      vy: -CONFIG.ballSpeed,
      radius: CONFIG.ballRadius
    };
  }

  function resizeCanvas() {
    if (!canvas) return;
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (paddle) {
      paddle.y = window.innerHeight - CONFIG.paddleBottom - CONFIG.paddleHeight;
      paddle.x = Math.min(Math.max(0, paddle.x), window.innerWidth - paddle.width);
    }
    blocks = detectBlocks();
    if (paddle) resetBall();
  }

  function movePaddle(event) {
    if (!active || !paddle) return;
    lastMouseX = event.clientX;
    paddle.x = Math.max(0, Math.min(window.innerWidth - paddle.width, lastMouseX - paddle.width / 2));
  }

  function overlapsCircleRect(circle, rect) {
    const nearestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.width));
    const nearestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.height));
    const dx = circle.x - nearestX;
    const dy = circle.y - nearestY;
    return dx * dx + dy * dy < circle.radius * circle.radius;
  }

  function updateBall() {
    if (!ball || !paddle) return;
    const previousX = ball.x;
    const previousY = ball.y;
    ball.x += ball.vx;
    ball.y += ball.vy;

    if (ball.x - ball.radius <= 0) {
      ball.x = ball.radius;
      ball.vx = Math.abs(ball.vx);
    } else if (ball.x + ball.radius >= window.innerWidth) {
      ball.x = window.innerWidth - ball.radius;
      ball.vx = -Math.abs(ball.vx);
    }
    if (ball.y - ball.radius <= 0) {
      ball.y = ball.radius;
      ball.vy = Math.abs(ball.vy);
    }

    // Paddle collision only while travelling downward, preventing repeated bounce frames.
    if (ball.vy > 0 && overlapsCircleRect(ball, paddle) && previousY + ball.radius <= paddle.y + 8) {
      ball.y = paddle.y - ball.radius;
      const hit = (ball.x - (paddle.x + paddle.width / 2)) / (paddle.width / 2);
      const speed = Math.max(CONFIG.ballSpeed, Math.hypot(ball.vx, ball.vy));
      ball.vx = hit * speed * 0.85;
      ball.vy = -Math.sqrt(Math.max(4, speed * speed - ball.vx * ball.vx));
    }

    for (const block of blocks) {
      if (!block.alive || !overlapsCircleRect(ball, block)) continue;
      block.resistance -= 1;
      if (block.resistance <= 0) {
        block.alive = false;
        score += 10;
        createParticles(block);
      }
      // Choose the collision axis from the previous position.
      if (previousX + ball.radius <= block.x || previousX - ball.radius >= block.x + block.width) {
        ball.vx *= -1;
      } else {
        ball.vy *= -1;
      }
      break;
    }

    if (ball.y - ball.radius > window.innerHeight) {
      lives -= 1;
      if (lives <= 0) {
        gameOver = true;
      } else {
        resetBall();
      }
    }

    if (blocks.every(block => !block.alive)) gameOver = true;
  }

  function updateParticles(delta) {
    const factor = Math.min(delta / 16.67, 2);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * factor;
      p.y += p.vy * factor;
      p.vy += 0.04 * factor;
      p.life -= 0.025 * factor;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function draw() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (const block of blocks) {
      if (!block.alive) continue;
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = colorFor(block.type);
      ctx.fillRect(block.x, block.y, block.width, block.height);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colorFor(block.type);
      ctx.lineWidth = 2;
      ctx.strokeRect(block.x + 1, block.y + 1, Math.max(0, block.width - 2), Math.max(0, block.height - 2));
      if (block.maxResistance > 1) {
        ctx.fillStyle = '#111';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(String(block.resistance), block.x + 5, block.y + 14);
      }
    }

    if (paddle) {
      ctx.fillStyle = '#17202a';
      ctx.beginPath();
      ctx.roundRect(paddle.x, paddle.y, paddle.width, paddle.height, 6);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (ball) {
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.shadowColor = '#f1c40f';
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillRect(12, 12, 176, 36);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(`Puntos: ${score}   Vidas: ${lives}`, 22, 35);

    if (gameOver) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = 'bold 32px sans-serif';
      ctx.fillText(blocks.every(block => !block.alive) ? '¡Web destruida!' : 'Fin de la partida', window.innerWidth / 2, window.innerHeight / 2);
      ctx.font = '16px sans-serif';
      ctx.fillText('Abre el popup de WebBreakout para volver a jugar o desactivarlo', window.innerWidth / 2, window.innerHeight / 2 + 34);
      ctx.textAlign = 'start';
    }
  }

  function gameLoop(time) {
    if (!active) return;
    const delta = lastTime ? Math.min(time - lastTime, 34) : 16.67;
    lastTime = time;
    if (!gameOver) updateBall();
    updateParticles(delta);
    draw();
    if (active) animationId = requestAnimationFrame(gameLoop);
  }

  function startGame() {
    if (active) return;
    blocks = detectBlocks();
    if (!blocks.length) {
      chrome.runtime.sendMessage({ action: 'gameStatus', status: 'No se encontraron elementos jugables en esta página.' }).catch(() => {});
      return;
    }

    active = true;
    gameOver = false;
    score = 0;
    lives = 3;
    particles = [];
    lastTime = 0;

    canvas = document.createElement('canvas');
    canvas.id = 'webbreakout-canvas';
    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      margin: '0',
      padding: '0',
      border: '0'
    });
    (document.documentElement || document.body).appendChild(canvas);
    ctx = canvas.getContext('2d');
    paddle = {
      x: window.innerWidth / 2 - CONFIG.paddleWidth / 2,
      y: window.innerHeight - CONFIG.paddleBottom - CONFIG.paddleHeight,
      width: CONFIG.paddleWidth,
      height: CONFIG.paddleHeight
    };
    resizeCanvas();
    resetBall();

    window.addEventListener('mousemove', movePaddle, { passive: true });
    window.addEventListener('resize', resizeCanvas, { passive: true });
    window.addEventListener('scroll', resizeCanvas, { passive: true });
    animationId = requestAnimationFrame(gameLoop);
    chrome.runtime.sendMessage({ action: 'gameStatus', status: 'WebBreakout activo' }).catch(() => {});
  }

  function stopGame() {
    active = false;
    if (animationId) cancelAnimationFrame(animationId);
    animationId = 0;
    window.removeEventListener('mousemove', movePaddle);
    window.removeEventListener('resize', resizeCanvas);
    window.removeEventListener('scroll', resizeCanvas);
    canvas?.remove();
    canvas = null;
    ctx = null;
    blocks = [];
    particles = [];
    paddle = null;
    ball = null;
    chrome.runtime.sendMessage({ action: 'gameStatus', status: 'WebBreakout desactivado' }).catch(() => {});
  }

  function cleanup() {
    stopGame();
    chrome.runtime.onMessage.removeListener(messageListener);
    delete window.__webBreakout;
  }

  function messageListener(message) {
    if (message?.action === 'activate') startGame();
    if (message?.action === 'deactivate') stopGame();
    if (message?.action === 'toggle') active ? stopGame() : startGame();
  }

  chrome.runtime.onMessage.addListener(messageListener);
  window.__webBreakout = { cleanup, startGame, stopGame };
})();
