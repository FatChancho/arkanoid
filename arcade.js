/*
 * arcade.js — Modo arcade: niveles de ladrillos al estilo Arkanoid.
 *
 * Cuando se destruye toda la web empieza el modo arcade. Este módulo genera el
 * escenario de cada nivel como un LIENZO (fondo + ladrillos) y la lista de
 * objetivos equivalente, para que entren por la misma tubería que la captura
 * de una web: createSampler / createEngine / createSceneLayer de
 * destruction.js. Así se reutilizan tal cual la destrucción, los fragmentos
 * (con el color real de cada ladrillo), los objetos, el láser y el revelado.
 *
 * LADRILLOS (cada letra de un patrón)
 *   W blanco 50 · O naranja 60 · C cian 70 · G verde 80 · R rojo 90 ·
 *   B azul 100 · M magenta 110 · Y amarillo 120   → 1 golpe
 *   S plateado: 2 golpes (se agrieta tras el primero); puntos = 50 × nivel (mín. 100)
 *   X dorado: indestructible; la bola rebota y no cuenta para pasar de nivel
 *   .  hueco
 *
 * NIVELES
 *   1-9   diseños a mano (filas, pirámide, ajedrez, diamante, invasor,
 *         escalera, muros, corazón, marco).
 *   10+   procedurales y simétricos, con semilla fija por nivel (el mismo
 *         nivel sale siempre igual); más plateados y dorados según sube.
 * Todos pasan una comprobación de alcanzabilidad: ningún grupo de ladrillos
 * destruibles puede quedar totalmente encerrado por dorados (se cambia un
 * dorado vecino por uno plateado).
 *
 * El nivel ocupa 13 columnas y se adapta al tamaño del escenario (viewport en
 * el momento de la captura): rejilla en la zona alta, nunca más abajo del 58 %
 * de la altura.
 */
(() => {
  "use strict";

  const WB = (globalThis.__WebBreakout = globalThis.__WebBreakout || {});

  const COLS = 13;
  const GAP = 1;

  const BRICKS = {
    W: { fill: "#dfe5f0", hi: "#ffffff", lo: "#8d97ab", points: 50 },
    O: { fill: "#ff9a3c", hi: "#ffc37a", lo: "#b8571a", points: 60 },
    C: { fill: "#3fd0ff", hi: "#9be8ff", lo: "#1b82ad", points: 70 },
    G: { fill: "#4ade80", hi: "#9bf0b9", lo: "#1f8f4a", points: 80 },
    R: { fill: "#ff4d4d", hi: "#ff9a9a", lo: "#a81f1f", points: 90 },
    B: { fill: "#4d7cff", hi: "#9db8ff", lo: "#2147b8", points: 100 },
    M: { fill: "#d96bff", hi: "#eab3ff", lo: "#8a2fb3", points: 110 },
    Y: { fill: "#ffd84d", hi: "#ffeb99", lo: "#b08f10", points: 120 },
    S: { fill: "#b8c0cc", hi: "#eef2f8", lo: "#6f7888", hp: 2 },
    X: { fill: "#d4a017", hi: "#ffe27a", lo: "#7a5a05", solid: true }
  };

  const THEMES = [
    ["#16204a", "#0b1230"],
    ["#134545", "#0b2a2a"],
    ["#4a1630", "#2a0b1a"],
    ["#2f1654", "#1a0b2e"],
    ["#14411d", "#0b2410"],
    ["#47300f", "#2a1a0b"]
  ];

  const PATTERNS = [
    {
      name: "FILAS",
      rows: [
        "RRRRRRRRRRRRR",
        "OOOOOOOOOOOOO",
        "YYYYYYYYYYYYY",
        "GGGGGGGGGGGGG",
        "CCCCCCCCCCCCC"
      ]
    },
    {
      name: "PIRÁMIDE",
      rows: [
        "......S......",
        ".....OOO.....",
        "....YYYYY....",
        "...GGGGGGG...",
        "..CCCCCCCCC..",
        ".BBBBBBBBBBB."
      ]
    },
    {
      name: "AJEDREZ",
      rows: [
        "R.R.R.R.R.R.R",
        ".O.O.O.O.O.O.",
        "Y.Y.Y.Y.Y.Y.Y",
        ".G.G.G.G.G.G.",
        "C.C.C.C.C.C.C",
        ".B.B.B.B.B.B."
      ]
    },
    {
      name: "DIAMANTE",
      rows: [
        "......R......",
        ".....OOO.....",
        "....YYYYY....",
        "...GGGGGGG...",
        "....CCCCC....",
        ".....BBB.....",
        "......M......"
      ]
    },
    {
      name: "INVASOR",
      rows: [
        "..G.......G..",
        "...G.....G...",
        "..GGGGGGGGG..",
        ".GG.GGGGG.GG.",
        "GGGGGGGGGGGGG",
        "G.GGGGGGGGG.G",
        "G.G.......G.G",
        "...GG...GG..."
      ]
    },
    {
      name: "ESCALERA",
      rows: [
        "X............",
        "RX...........",
        "ORX..........",
        "YORX.........",
        "GYORX........",
        "CGYORX.......",
        "BCGYORX......"
      ]
    },
    {
      name: "MUROS",
      rows: [
        "X.SSS.X.SSS.X",
        "X.RRR.X.OOO.X",
        "X.YYY.X.GGG.X",
        "X.CCC.X.BBB.X"
      ]
    },
    {
      name: "CORAZÓN",
      rows: [
        "..MM.....MM..",
        ".MMMM...MMMM.",
        "MMMMMMMMMMMMM",
        "MMMMMMMMMMMMM",
        ".MMMMMMMMMMM.",
        "..MMMMMMMMM..",
        "...MMMMMMM...",
        "....MMMMM....",
        ".....MMM.....",
        "......M......"
      ]
    },
    {
      name: "MARCO",
      rows: [
        "XXXXXXXXXXXXX",
        ".SSSSSSSSSSS.",
        ".RRRRRRRRRRR.",
        ".OOOOOOOOOOO.",
        "..YYYYYYYYY.."
      ]
    }
  ];

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  const isDestructible = (ch) => ch !== "." && ch !== "X" && Boolean(BRICKS[ch]);

  /** Un nivel procedural, simétrico y con semilla fija. */
  function proceduralRows(level) {
    const rng = mulberry32(Math.imul(level, 2654435761) + 12345);
    const rows = 6 + (level % 4);
    const colors = "ROYGCBM";
    const silverP = Math.min(0.45, 0.08 + 0.025 * level);
    const goldCount = Math.min(5, Math.max(0, Math.floor((level - 8) / 3)));

    const grid = [];
    for (let r = 0; r < rows; r++) {
      const left = [];
      for (let c = 0; c < 7; c++) {
        const filled = c === 6 || rng() < 0.78;
        if (!filled) left.push(".");
        else if (rng() < silverP) left.push("S");
        else left.push(colors[(r + Math.floor(rng() * 2)) % colors.length]);
      }
      grid.push(left.concat(left.slice(0, 6).reverse()));
    }

    for (let k = 0; k < goldCount; k++) {
      const r = Math.floor(rng() * rows);
      grid[r][0] = "X";
      grid[r][COLS - 1] = "X";
    }
    return { name: "TRAMA " + level, rows: grid.map((row) => row.join("")) };
  }

  function patternFor(level) {
    if (level >= 1 && level <= PATTERNS.length) return PATTERNS[level - 1];
    return proceduralRows(Math.max(1, level));
  }

  /**
   * Garantiza que todo grupo de ladrillos destruibles tiene al menos un lado
   * abierto (un hueco o el borde de la rejilla). Si un grupo está totalmente
   * rodeado de dorados, cambia uno de esos dorados por uno plateado.
   */
  function ensureReachable(grid) {
    const rows = grid.length;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let fixed = 0;
    let again = true;

    while (again) {
      again = false;
      const seen = grid.map((row) => row.map(() => false));

      for (let r = 0; r < rows && !again; r++) {
        for (let c = 0; c < COLS && !again; c++) {
          if (seen[r][c] || !isDestructible(grid[r][c])) continue;
          const stack = [[r, c]];
          seen[r][c] = true;
          let exposed = false;
          const goldNeighbours = [];

          while (stack.length) {
            const [cr, cc] = stack.pop();
            for (const [dr, dc] of dirs) {
              const nr = cr + dr;
              const nc = cc + dc;
              if (nr < 0 || nr >= rows || nc < 0 || nc >= COLS || grid[nr][nc] === ".") {
                exposed = true;
              } else if (grid[nr][nc] === "X") {
                goldNeighbours.push([nr, nc]);
              } else if (!seen[nr][nc]) {
                seen[nr][nc] = true;
                stack.push([nr, nc]);
              }
            }
          }
          if (!exposed && goldNeighbours.length) {
            const [gr, gc] = goldNeighbours[0];
            grid[gr][gc] = "S";
            fixed++;
            again = true; // se vuelve a comprobar todo desde el principio
          }
        }
      }
    }
    return fixed;
  }

  /* ------------------------------------------------------------------ */
  /* Geometría                                                           */
  /* ------------------------------------------------------------------ */

  /** Rejilla de 13 columnas en la parte alta del escenario. */
  function layout(W, H, rows) {
    const side = Math.max(16, W * 0.04);
    const cellW = (W - 2 * side) / COLS;
    const top = Math.max(24, H * 0.1);
    const maxBottom = H * 0.58;
    let cellH = clamp(Math.round(H * 0.045), 16, 34);
    if (top + rows * cellH > maxBottom) {
      cellH = Math.max(12, Math.floor((maxBottom - top) / rows));
    }
    const fitRows = Math.max(1, Math.min(rows, Math.floor((maxBottom - top) / cellH)));
    return { side, cellW, cellH, top, maxBottom, rows: fitRows };
  }

  /* ------------------------------------------------------------------ */
  /* Dibujo                                                              */
  /* ------------------------------------------------------------------ */

  function paintBackground(ctx, W, H, level) {
    const [a, b] = THEMES[(level - 1) % THEMES.length];
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, a);
    grad.addColorStop(1, b);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Trama de rombos, como el fondo del arcade original.
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    for (let y = 0; y < H; y += 16) {
      for (let x = (y / 16) % 2 ? 8 : 0; x < W; x += 16) ctx.fillRect(x, y, 2, 2);
    }

    // Estrellas fijas por nivel.
    const rng = mulberry32(level * 7919);
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = "rgba(255,255,255," + (0.2 + rng() * 0.5).toFixed(2) + ")";
      const s = rng() < 0.15 ? 2 : 1;
      ctx.fillRect(Math.floor(rng() * W), Math.floor(rng() * H), s, s);
    }

    // Marco interior fino.
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);
  }

  function paintBrick(ctx, brick, damaged) {
    const { x, y, width: w, height: h } = brick.rect;
    const c = BRICKS[brick.type];
    const t = Math.max(1, Math.round(Math.min(3, h * 0.14)));

    ctx.fillStyle = "#0a0d16";
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = c.fill;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = c.hi;
    ctx.fillRect(x, y, w, t);
    ctx.fillRect(x, y, t, h);
    ctx.fillStyle = c.lo;
    ctx.fillRect(x, y + h - t, w, t);
    ctx.fillRect(x + w - t, y, t, h);
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fillRect(x + t, y + t, Math.max(1, w - 2 * t), Math.max(1, h * 0.22));

    if (brick.type === "S") {
      // Rayas diagonales de metal, recortadas al ladrillo.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + t, y + t, w - 2 * t, h - 2 * t);
      ctx.clip();
      ctx.strokeStyle = "rgba(70,80,100,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let sx = x - h; sx < x + w; sx += 8) {
        ctx.moveTo(sx, y + h);
        ctx.lineTo(sx + h, y);
      }
      ctx.stroke();
      ctx.restore();
    } else if (brick.type === "X") {
      ctx.fillStyle = "#4a3503";
      const r = Math.max(1, Math.round(h * 0.09));
      for (const [dx, dy] of [[t + 3, t + 3], [w - t - 3 - r, t + 3], [t + 3, h - t - 3 - r], [w - t - 3 - r, h - t - 3 - r]]) {
        ctx.fillRect(x + dx, y + dy, r, r);
      }
    }

    if (damaged) {
      ctx.fillStyle = "rgba(20,24,34,0.22)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#232a38";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const mx = x + w * 0.5;
      ctx.moveTo(mx - 2, y + 1);
      ctx.lineTo(mx + 3, y + h * 0.3);
      ctx.lineTo(mx - 3, y + h * 0.55);
      ctx.lineTo(mx + 2, y + h * 0.78);
      ctx.lineTo(mx - 1, y + h - 1);
      ctx.moveTo(mx + 3, y + h * 0.3);
      ctx.lineTo(mx + w * 0.22, y + h * 0.42);
      ctx.moveTo(mx - 3, y + h * 0.55);
      ctx.lineTo(mx - w * 0.2, y + h * 0.66);
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------------------ */
  /* API                                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Genera un nivel.
   *  stage: { width, height } en px CSS.   opts: { scale (resolución del lienzo), makeCanvas }
   *  Devuelve { level, name, cols, rows, bricks, byId, targets, canvas, scale,
   *             destructible, solids, speedFactor, layout }.
   */
  function build(level, stage, opts) {
    const o = opts || {};
    const W = stage.width;
    const H = stage.height;
    const ds = o.scale || 1;
    const pattern = patternFor(level);
    const grid = pattern.rows.map((row) => row.split(""));
    ensureReachable(grid);

    const lay = layout(W, H, grid.length);
    const bricks = [];
    const byId = {};
    const targets = [];
    let destructible = 0;
    let solids = 0;

    for (let r = 0; r < lay.rows; r++) {
      for (let c = 0; c < COLS; c++) {
        const ch = grid[r][c];
        if (!isDestructible(ch) && ch !== "X") continue;
        const def = BRICKS[ch];
        const id = "brick-" + level + "-" + r + "-" + c;
        const rect = {
          x: lay.side + c * lay.cellW + GAP,
          y: lay.top + r * lay.cellH + GAP,
          width: lay.cellW - 2 * GAP,
          height: lay.cellH - 2 * GAP
        };
        const points = def.solid ? 0 : ch === "S" ? Math.max(100, 50 * level) : def.points;
        const brick = { id, type: ch, row: r, col: c, rect, hp: def.hp || 1, solid: Boolean(def.solid), points };
        bricks.push(brick);
        byId[id] = brick;
        if (brick.solid) solids++;
        else destructible++;
        targets.push({
          id,
          key: id,
          type: "brick",
          label: ch,
          rect,
          shape: { kind: "rect" },
          silhouette: false,
          layer: 2,
          order: targets.length,
          hp: brick.hp,
          solid: brick.solid,
          points,
          color: def.fill
        });
      }
    }

    const canvas = o.makeCanvas ? o.makeCanvas(W * ds, H * ds) : document.createElement("canvas");
    canvas.width = Math.round(W * ds);
    canvas.height = Math.round(H * ds);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ds, 0, 0, ds, 0, 0);
    paintBackground(ctx, W, H, level);
    for (const brick of bricks) paintBrick(ctx, brick, false);

    return {
      level,
      name: pattern.name,
      cols: COLS,
      rows: lay.rows,
      bricks,
      byId,
      targets,
      canvas,
      scale: ds,
      destructible,
      solids,
      speedFactor: 1,
      layout: lay
    };
  }

  /** Repinta un ladrillo agrietado sobre la capa visible (tras un golpe que no lo destruye). */
  function paintDamage(world, target, ctx, scale) {
    const brick = world && world.byId[target.id];
    if (!brick) return;
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    paintBrick(ctx, brick, true);
    ctx.restore();
  }

  WB.Arcade = {
    build,
    paintDamage,
    patternFor,
    ensureReachable,
    PATTERNS,
    BRICKS,
    COLS
  };
})();