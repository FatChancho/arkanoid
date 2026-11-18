/*
 * destruction.js — Motor de destrucción por regiones.
 *
 * Tres piezas independientes, sin dependencias del juego:
 *
 *  1. createSampler    Lee los colores de la captura original (solo lectura).
 *  2. createSceneLayer Capa del escenario: copia de la captura sobre la que se
 *                      BORRA lo destruido. Se dibuja esta capa, nunca la
 *                      captura original, así los daños persisten entre frames.
 *  3. createEngine     Máscaras de destrucción, colisión y estado.
 *
 * MODELO DE MÁSCARAS
 * Cada objetivo de scene.js llega con una forma (rect, rrect, rects) en px CSS.
 * El motor la rasteriza en un mapa de PROPIEDAD de baja resolución: cada celda
 * (2 px CSS en un portátil típico) pertenece como máximo a UN objetivo, el de
 * la capa más alta (a igual capa, el más pequeño). De ahí salen tres garantías:
 *   - Una región solapada nunca se cuenta ni se borra dos veces.
 *   - Destruir un objetivo solo borra celdas suyas: el contenido de otro
 *     objetivo (texto sobre una imagen, por ejemplo) no desaparece.
 *   - El área destruida nunca supera el área destruible (<= 100 %).
 * Las celdas son resolución de máscara, NO objetivos: el objetivo es la pieza
 * visual completa y la colisión se hace contra rectángulos fusionados (runs)
 * de su región viva, no contra celdas ni píxeles.
 *
 * FRAGMENTACIÓN
 * Un objetivo pequeño (<= smallArea) se destruye con un impacto. Uno grande se
 * parte en N regiones de área parecida (cortes recursivos con jitter
 * determinista). Cada impacto destruye UNA región; la resistencia del objetivo
 * es N.
 *
 * LADRILLOS (MODO ARCADE)
 * Un objetivo de entrada puede llevar `hp` (golpes que aguanta; 1 por defecto)
 * y `solid` (indestructible):
 *   - hp > 1: la región no se parte; cada golpe devuelve `damaged: true` y
 *     solo el último la destruye.
 *   - solid: colisiona como cualquier otro, pero `hit()` devuelve null y no
 *     cuenta en las estadísticas (ni en el total, ni en el porcentaje).
 *
 * SILUETAS
 * Para logos, SVG y canvas, y PNG/SVG/WebP pequeños, la forma se afina con la
 * captura: se marcan las celdas cuyo color difiere del fondo (estimado en el
 * borde de la caja), se cierran huecos de ~6 px para que las letras formen una
 * pieza y se engorda 1 celda. Limitación: solo funciona si el fondo alrededor
 * es de color uniforme; sobre fotos o degradados se usa la caja (con sus
 * esquinas redondeadas). No es el contorno vectorial exacto.
 *
 * LIMITACIONES
 *  - Todo lo que queda por debajo de la línea de la pala (p. ej. el pie de
 *    página de Google) es inalcanzable para la pelota y no se considera
 *    destruible; permanece intacto en pantalla.
 *  - La resolución de máscara es de 1-4 px CSS: los bordes pueden desviarse
 *    hasta una celda respecto al contorno real.
 *  - El borrado se redondea a píxeles de la captura (como mucho 1 px de más
 *    en los bordes entre dos regiones).
 */
(() => {
  "use strict";

  const WB = (globalThis.__WebBreakout = globalThis.__WebBreakout || {});

  const DEFAULTS = {
    maxCells: 1000000,
    cellSize: 0,
    minOwnedArea: 100,
    smallArea: 12000,
    areaPerChunk: 6000,
    maxChunks: 12,
    silhouetteMaxCells: 250000,
    closingRadiusPx: 6,
    silhouetteBackdropTolerance: 40,
    silhouetteDiff: 48,
    silhouetteMinRatio: 0.03,
    silhouetteMaxRatio: 0.93,
    fragmentAreaDivisor: 1600,
    minFragments: 6,
    maxFragments: 36
  };

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
    };
  }

  function defaultCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  /* ------------------------------------------------------------------ */
  /* 1. Muestreo de la captura                                           */
  /* ------------------------------------------------------------------ */

  function createSampler({ image, stageWidth, stageHeight, makeCanvas }) {
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    if (!w || !h) throw new Error("La captura de pantalla está vacía.");

    const canvas = (makeCanvas || defaultCanvas)(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    canvas.width = 0;
    canvas.height = 0;

    const scaleX = w / stageWidth;
    const scaleY = h / stageHeight;

    function pixel(x, y, out) {
      const px = clamp(Math.floor(x * scaleX), 0, w - 1);
      const py = clamp(Math.floor(y * scaleY), 0, h - 1);
      const i = (py * w + px) * 4;
      out[0] = data[i];
      out[1] = data[i + 1];
      out[2] = data[i + 2];
      return out;
    }

    /** Color medio de una región del escenario (rejilla de hasta 4x4 muestras). */
    function average(x, y, width, height) {
      const n = 4;
      let r = 0;
      let g = 0;
      let b = 0;
      const tmp = [0, 0, 0];
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          pixel(x + ((i + 0.5) / n) * width, y + ((j + 0.5) / n) * height, tmp);
          r += tmp[0];
          g += tmp[1];
          b += tmp[2];
        }
      }
      const k = n * n;
      return [Math.round(r / k), Math.round(g / k), Math.round(b / k)];
    }

    return { width: w, height: h, scaleX, scaleY, data, pixel, average };
  }

  /* ------------------------------------------------------------------ */
  /* 2. Capa del escenario                                               */
  /* ------------------------------------------------------------------ */

  function createSceneLayer({ image, stageWidth, stageHeight, makeCanvas }) {
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    const canvas = (makeCanvas || defaultCanvas)(w, h);
    const ctx = canvas.getContext("2d");
    const sx = w / stageWidth;
    const sy = h / stageHeight;

    function reset() {
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0, w, h);
    }

    /** Borra rectángulos (px CSS del escenario). Dos rectángulos contiguos
     *  comparten borde exacto porque ambos se redondean igual. */
    function erase(rects) {
      for (const r of rects) {
        const x0 = Math.round(r.x * sx);
        const y0 = Math.round(r.y * sy);
        const x1 = Math.round((r.x + r.w) * sx);
        const y1 = Math.round((r.y + r.h) * sy);
        if (x1 > x0 && y1 > y0) ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
      }
    }

    function draw(target, dx, dy, dw, dh) {
      target.drawImage(canvas, dx, dy, dw, dh);
    }

    function dispose() {
      canvas.width = 0;
      canvas.height = 0;
    }

    reset();
    return { canvas, reset, erase, draw, dispose, width: w, height: h, scaleX: sx, scaleY: sy };
  }

  /* ------------------------------------------------------------------ */
  /* 3. Motor de destrucción                                             */
  /* ------------------------------------------------------------------ */

  function fillRectCells(m, cell, rx, ry, rw, rh) {
    const cMin = Math.max(m.c0, Math.ceil(rx / cell - 0.5));
    const cMax = Math.min(m.c0 + m.bw - 1, Math.ceil((rx + rw) / cell - 0.5) - 1);
    const rMin = Math.max(m.r0, Math.ceil(ry / cell - 0.5));
    const rMax = Math.min(m.r0 + m.bh - 1, Math.ceil((ry + rh) / cell - 0.5) - 1);
    for (let r = rMin; r <= rMax; r++) {
      const base = (r - m.r0) * m.bw - m.c0;
      for (let c = cMin; c <= cMax; c++) m.mask[base + c] = 1;
    }
  }

  function fillRoundedCells(m, cell, rect, radii) {
    const x1 = rect.x + rect.width;
    const y1 = rect.y + rect.height;
    const [tl, tr, br, bl] = radii;
    const outside = (px, py, cx, cy, rx, ry) => {
      const dx = (cx - px) / rx;
      const dy = (cy - py) / ry;
      return dx * dx + dy * dy > 1;
    };

    const cMin = Math.max(m.c0, Math.ceil(rect.x / cell - 0.5));
    const cMax = Math.min(m.c0 + m.bw - 1, Math.ceil(x1 / cell - 0.5) - 1);
    const rMin = Math.max(m.r0, Math.ceil(rect.y / cell - 0.5));
    const rMax = Math.min(m.r0 + m.bh - 1, Math.ceil(y1 / cell - 0.5) - 1);

    for (let r = rMin; r <= rMax; r++) {
      const py = (r + 0.5) * cell;
      for (let c = cMin; c <= cMax; c++) {
        const px = (c + 0.5) * cell;
        if (tl.rx > 0 && tl.ry > 0 && px < rect.x + tl.rx && py < rect.y + tl.ry &&
            outside(px, py, rect.x + tl.rx, rect.y + tl.ry, tl.rx, tl.ry)) continue;
        if (tr.rx > 0 && tr.ry > 0 && px > x1 - tr.rx && py < rect.y + tr.ry &&
            outside(px, py, x1 - tr.rx, rect.y + tr.ry, tr.rx, tr.ry)) continue;
        if (br.rx > 0 && br.ry > 0 && px > x1 - br.rx && py > y1 - br.ry &&
            outside(px, py, x1 - br.rx, y1 - br.ry, br.rx, br.ry)) continue;
        if (bl.rx > 0 && bl.ry > 0 && px < rect.x + bl.rx && py > y1 - bl.ry &&
            outside(px, py, rect.x + bl.rx, y1 - bl.ry, bl.rx, bl.ry)) continue;
        m.mask[(r - m.r0) * m.bw + (c - m.c0)] = 1;
      }
    }
  }

  /** Rasteriza la forma de un objetivo en una rejilla local de celdas.
   *  maxRow: última fila jugable (la pelota no llega por debajo de la pala). */
  function rasterize(t, cell, cols, rows, maxRow) {
    const R = t.rect;
    const c0 = Math.max(0, Math.floor(R.x / cell));
    const r0 = Math.max(0, Math.floor(R.y / cell));
    const c1 = Math.min(cols - 1, Math.ceil((R.x + R.width) / cell) - 1);
    const r1 = Math.min(maxRow, Math.ceil((R.y + R.height) / cell) - 1);
    const bw = c1 - c0 + 1;
    const bh = r1 - r0 + 1;
    if (bw <= 0 || bh <= 0) return null;

    const m = { c0, r0, bw, bh, mask: new Uint8Array(bw * bh) };
    const shape = t.shape || { kind: "rect" };

    if (shape.kind === "rects") {
      for (const r of shape.rects) fillRectCells(m, cell, r.x, r.y, r.width, r.height);
    } else if (shape.kind === "rrect") {
      fillRoundedCells(m, cell, R, shape.radii);
    } else {
      fillRectCells(m, cell, R.x, R.y, R.width, R.height);
    }
    return m;
  }

  function morph(src, bw, bh, k, dilate) {
    const tmp = new Uint8Array(src.length);
    const out = new Uint8Array(src.length);

    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let v = dilate ? 0 : 1;
        for (let d = -k; d <= k; d++) {
          const xx = x + d;
          if (xx < 0 || xx >= bw) continue; // fuera: neutro en ambos casos
          const s = src[y * bw + xx];
          if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
        }
        tmp[y * bw + x] = v;
      }
    }
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let v = dilate ? 0 : 1;
        for (let d = -k; d <= k; d++) {
          const yy = y + d;
          if (yy < 0 || yy >= bh) continue;
          const s = tmp[yy * bw + x];
          if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
        }
        out[y * bw + x] = v;
      }
    }
    return out;
  }

  /**
   * Afina la máscara de un objetivo a la silueta del contenido (ver cabecera).
   * Devuelve true si la máscara se ha modificado.
   */
  function applySilhouette(m, cell, sampler, opts) {
    const { mask, bw, bh, c0, r0 } = m;
    let total = 0;
    for (let i = 0; i < mask.length; i++) total += mask[i];
    if (!total || total > opts.silhouetteMaxCells) return false;

    const x0 = c0 * cell;
    const y0 = r0 * cell;
    const w = bw * cell;
    const h = bh * cell;
    const px = [0, 0, 0];

    // Color del fondo: mediana de las muestras del perímetro de la caja.
    const ring = [];
    const step = Math.max(2, cell);
    for (let x = x0 + 1; x < x0 + w - 1; x += step) {
      ring.push(sampler.pixel(x, y0 + 1, [0, 0, 0]));
      ring.push(sampler.pixel(x, y0 + h - 2, [0, 0, 0]));
    }
    for (let y = y0 + 1; y < y0 + h - 1; y += step) {
      ring.push(sampler.pixel(x0 + 1, y, [0, 0, 0]));
      ring.push(sampler.pixel(x0 + w - 2, y, [0, 0, 0]));
    }
    if (ring.length < 8) return false;

    const median = [0, 1, 2].map((ch) => {
      const v = ring.map((p) => p[ch]).sort((a, b) => a - b);
      return v[v.length >> 1];
    });
    const dist = (p) =>
      Math.abs(p[0] - median[0]) + Math.abs(p[1] - median[1]) + Math.abs(p[2] - median[2]);

    const near = ring.filter((p) => dist(p) <= opts.silhouetteBackdropTolerance).length;
    if (near / ring.length < 0.85) return false; // fondo no uniforme

    const occ = new Uint8Array(mask.length);
    const offsets = [0.25, 0.75];
    for (let j = 0; j < bh; j++) {
      for (let i = 0; i < bw; i++) {
        if (!mask[j * bw + i]) continue;
        const cx = (c0 + i) * cell;
        const cy = (r0 + j) * cell;
        let on = 0;
        for (const oy of offsets) {
          for (const ox of offsets) {
            sampler.pixel(cx + ox * cell, cy + oy * cell, px);
            if (dist(px) > opts.silhouetteDiff) on = 1;
          }
        }
        occ[j * bw + i] = on;
      }
    }

    const k = Math.max(1, Math.round(opts.closingRadiusPx / cell));
    let shaped = morph(occ, bw, bh, k, true);
    shaped = morph(shaped, bw, bh, k, false);
    shaped = morph(shaped, bw, bh, 1, true);

    let kept = 0;
    for (let i = 0; i < shaped.length; i++) {
      shaped[i] = shaped[i] && mask[i] ? 1 : 0;
      kept += shaped[i];
    }
    const ratio = kept / total;
    if (kept < 6 || ratio < opts.silhouetteMinRatio || ratio > opts.silhouetteMaxRatio) {
      return false;
    }
    mask.set(shaped);
    return true;
  }

  /**
   * Convierte celdas (índices ordenados de menor a mayor) en rectángulos
   * disjuntos: primero tiras horizontales y luego fusión vertical de tiras
   * idénticas. Una región rectangular produce un único rectángulo.
   */
  function cellsToRects(cells, cols, cell, width, height) {
    const rects = [];
    let prev = new Map();
    let curr = new Map();
    let currRow = -2;
    const n = cells.length;
    let i = 0;

    while (i < n) {
      const start = cells[i];
      const row = (start / cols) | 0;
      let end = start;
      let j = i + 1;
      while (j < n && cells[j] === end + 1 && ((cells[j] / cols) | 0) === row) {
        end = cells[j];
        j++;
      }

      if (row !== currRow) {
        prev = row === currRow + 1 ? curr : new Map();
        curr = new Map();
        currRow = row;
      }

      const c0 = start - row * cols;
      const c1 = end - row * cols;
      const key = c0 + ":" + c1;
      const above = prev.get(key);
      if (above) {
        above.h += cell;
        curr.set(key, above);
      } else {
        const rect = { x: c0 * cell, y: row * cell, w: (c1 - c0 + 1) * cell, h: cell };
        rects.push(rect);
        curr.set(key, rect);
      }
      i = j;
    }

    for (const r of rects) {
      r.w = Math.min(r.w, width - r.x);
      r.h = Math.min(r.h, height - r.y);
    }
    return rects.filter((r) => r.w > 0 && r.h > 0);
  }

  /** Reparte celdas en `parts` regiones de área parecida con cortes rectos. */
  function splitCells(cells, cols, parts, rng, out) {
    if (parts <= 1 || cells.length < 2) {
      out.push(cells);
      return;
    }

    let minC = Infinity;
    let maxC = -1;
    let minR = Infinity;
    let maxR = -1;
    for (let k = 0; k < cells.length; k++) {
      const r = (cells[k] / cols) | 0;
      const c = cells[k] - r * cols;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }

    const alongX = maxC - minC >= maxR - minR;
    const size = alongX ? maxC - minC + 1 : maxR - minR + 1;
    if (size < 2) {
      out.push(cells);
      return;
    }

    const leftParts = Math.floor(parts / 2);
    const ratio = clamp(leftParts / parts + (rng() - 0.5) * 0.16, 0.2, 0.8);
    const goal = cells.length * ratio;

    const hist = new Int32Array(size);
    for (let k = 0; k < cells.length; k++) {
      const r = (cells[k] / cols) | 0;
      hist[alongX ? cells[k] - r * cols - minC : r - minR]++;
    }

    let acc = 0;
    let cut = 0;
    while (cut < size - 1 && acc + hist[cut] <= goal) {
      acc += hist[cut];
      cut++;
    }
    cut = clamp(cut, 1, size - 1);
    acc = 0;
    for (let b = 0; b < cut; b++) acc += hist[b];

    const left = new Int32Array(acc);
    const right = new Int32Array(cells.length - acc);
    let li = 0;
    let ri = 0;
    for (let k = 0; k < cells.length; k++) {
      const r = (cells[k] / cols) | 0;
      const bin = alongX ? cells[k] - r * cols - minC : r - minR;
      if (bin < cut) left[li++] = cells[k];
      else right[ri++] = cells[k];
    }

    if (!left.length || !right.length) {
      out.push(cells);
      return;
    }
    splitCells(left, cols, leftParts, rng, out);
    splitCells(right, cols, parts - leftParts, rng, out);
  }

  function boundsOfRects(rects) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
      if (r.x < x0) x0 = r.x;
      if (r.y < y0) y0 = r.y;
      if (r.x + r.w > x1) x1 = r.x + r.w;
      if (r.y + r.h > y1) y1 = r.y + r.h;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * Crea el motor.
   *  config = { width, height, targets, sampler?, options? }
   *  width/height: tamaño del escenario en px CSS (viewport en la captura).
   *  playAreaBottom: y por debajo de la cual nada es destruible (línea de la pala).
   *  targets: salida de Scene.detectTargets().targets.
   */
  function createEngine(config) {
    const opts = Object.assign({}, DEFAULTS, config.options || {});
    const width = config.width;
    const height = config.height;
    const sampler = config.sampler || null;

    const cell =
      opts.cellSize || Math.max(1, Math.ceil(Math.sqrt((width * height) / opts.maxCells)));
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    const cellArea = cell * cell;
    // Lo que queda por debajo de la línea de la pala no se puede alcanzar:
    // no es superficie destruible ni cuenta para el porcentaje.
    const playBottom = config.playAreaBottom === undefined ? height : config.playAreaBottom;
    const maxRow = Math.min(rows - 1, Math.ceil(playBottom / cell) - 1);
    const owner = new Uint16Array(cols * rows);

    const input = config.targets.slice(0, 65000);
    const boxArea = (t) => t.rect.width * t.rect.height;

    // Orden de pintado: capa ascendente; a igual capa, el grande primero para
    // que el pequeño (más específico) conserve sus celdas.
    const order = input
      .map((t, i) => i)
      .sort(
        (a, b) =>
          input[a].layer - input[b].layer ||
          boxArea(input[b]) - boxArea(input[a]) ||
          input[a].order - input[b].order
      );

    let silhouettes = 0;
    for (const i of order) {
      const t = input[i];
      const m = rasterize(t, cell, cols, rows, maxRow);
      if (!m) continue;
      if (t.silhouette && sampler && applySilhouette(m, cell, sampler, opts)) silhouettes++;
      for (let j = 0; j < m.bh; j++) {
        const rowBase = (m.r0 + j) * cols + m.c0;
        for (let k = 0; k < m.bw; k++) {
          if (m.mask[j * m.bw + k]) owner[rowBase + k] = i + 1;
        }
      }
    }

    // Reparte las celdas entre sus propietarios; descarta objetivos que se
    // quedan sin área jugable.
    const counts = new Uint32Array(input.length + 1);
    for (let i = 0; i < owner.length; i++) if (owner[i]) counts[owner[i]]++;

    const cellLists = new Array(input.length);
    for (let i = 0; i < input.length; i++) {
      if (counts[i + 1] * cellArea >= opts.minOwnedArea) {
        cellLists[i] = new Int32Array(counts[i + 1]);
      }
    }
    const fill = new Uint32Array(input.length + 1);
    for (let idx = 0; idx < owner.length; idx++) {
      const o = owner[idx];
      if (!o) continue;
      const list = cellLists[o - 1];
      if (list) list[fill[o]++] = idx;
      else owner[idx] = 0;
    }

    const targets = [];
    let totalCells = 0;
    let destructible = 0;

    for (let i = 0; i < input.length; i++) {
      const cells = cellLists[i];
      if (!cells) continue;
      const t = input[i];
      const area = cells.length * cellArea;

      const solid = Boolean(t.solid);
      const hp = Math.max(1, Math.floor(t.hp) || 1);
      const n =
        solid || hp > 1 || area <= opts.smallArea
          ? 1
          : clamp(Math.round(Math.sqrt(area / opts.areaPerChunk)), 2, opts.maxChunks);

      const parts = [];
      splitCells(cells, cols, n, mulberry32(fnv1a(t.id)), parts);

      const chunks = [];
      parts.forEach((part, k) => {
        const rects = cellsToRects(part, cols, cell, width, height);
        if (!rects.length) return;
        chunks.push({
          id: t.id + "#" + k,
          index: chunks.length,
          cells: part,
          area: part.length * cellArea,
          rects,
          bounds: boundsOfRects(rects),
          alive: true
        });
      });
      if (!chunks.length) continue;

      const bounds = boundsOfRects(chunks.map((c) => c.bounds));
      if (!solid) {
        totalCells += cells.length;
        destructible++;
      }
      targets.push({
        id: t.id,
        key: t.key,
        type: t.type,
        label: t.label,
        layer: t.layer,
        ownerId: i + 1,
        index: targets.length,
        area,
        chunks,
        bounds,
        resistance: solid ? Infinity : hp > 1 ? hp : chunks.length,
        aliveChunks: chunks.length,
        destroyed: false,
        destroyedArea: 0,
        solid,
        hp,
        maxHp: hp,
        points: t.points || 0,
        color: t.color || null
      });
    }

    const initialOwner = owner.slice();
    let destroyedCells = 0;
    let destroyedTargets = 0;

    function stats() {
      const percent = totalCells ? Math.min(100, (destroyedCells / totalCells) * 100) : 0;
      return {
        totalTargets: destructible,
        destroyedTargets,
        remainingTargets: destructible - destroyedTargets,
        totalArea: totalCells * cellArea,
        destroyedArea: destroyedCells * cellArea,
        percentDestroyed: percent
      };
    }

    /**
     * Contacto entre un círculo y la región viva más cercana.
     * Devuelve null o { target, chunk, rect, nx, ny, depth, px, py } donde
     * (nx, ny) es la normal que apunta del objetivo hacia el círculo y depth
     * lo que se solapa. Solo se devuelve UN contacto: el más profundo.
     */
    function queryCircle(cx, cy, r) {
      const r2 = r * r;
      const bx0 = cx - r;
      const bx1 = cx + r;
      const by0 = cy - r;
      const by1 = cy + r;
      let best = null;
      let bestD2 = Infinity;

      for (const t of targets) {
        if (t.destroyed) continue;
        const tb = t.bounds;
        if (bx1 < tb.x || bx0 > tb.x + tb.w || by1 < tb.y || by0 > tb.y + tb.h) continue;

        for (const ch of t.chunks) {
          if (!ch.alive) continue;
          const cb = ch.bounds;
          if (bx1 < cb.x || bx0 > cb.x + cb.w || by1 < cb.y || by0 > cb.y + cb.h) continue;

          for (const rc of ch.rects) {
            const px = cx < rc.x ? rc.x : cx > rc.x + rc.w ? rc.x + rc.w : cx;
            const py = cy < rc.y ? rc.y : cy > rc.y + rc.h ? rc.y + rc.h : cy;
            const dx = cx - px;
            const dy = cy - py;
            const d2 = dx * dx + dy * dy;
            if (d2 > r2 || d2 >= bestD2) continue;
            bestD2 = d2;
            best = { target: t, chunk: ch, rect: rc, px, py, dx, dy };
          }
        }
      }
      if (!best) return null;

      let nx;
      let ny;
      let depth;
      if (bestD2 > 1e-9) {
        const d = Math.sqrt(bestD2);
        nx = best.dx / d;
        ny = best.dy / d;
        depth = r - d;
      } else {
        // Centro dentro del rectángulo: sale por el lado de menor penetración.
        const rc = best.rect;
        const left = cx - rc.x;
        const right = rc.x + rc.w - cx;
        const top = cy - rc.y;
        const bottom = rc.y + rc.h - cy;
        const m = Math.min(left, right, top, bottom);
        nx = 0;
        ny = 0;
        if (m === top) ny = -1;
        else if (m === bottom) ny = 1;
        else if (m === left) nx = -1;
        else nx = 1;
        depth = r + m;
      }
      return {
        target: best.target,
        chunk: best.chunk,
        rect: best.rect,
        px: best.px,
        py: best.py,
        nx,
        ny,
        depth
      };
    }

    function makeFragments(chunk, impact, forcedCount) {
      const count =
        forcedCount ||
        clamp(Math.round(chunk.area / opts.fragmentAreaDivisor), opts.minFragments, opts.maxFragments);
      const rects = chunk.rects;
      const weights = rects.map((r) => r.w * r.h);
      const totalW = weights.reduce((a, b) => a + b, 0);
      const ix = impact ? impact.x : chunk.bounds.x + chunk.bounds.w / 2;
      const iy = impact ? impact.y : chunk.bounds.y + chunk.bounds.h / 2;
      const fragments = [];

      for (let n = 0; n < count; n++) {
        let pick = Math.random() * totalW;
        let ri = 0;
        while (ri < rects.length - 1 && pick > weights[ri]) pick -= weights[ri++];
        const rc = rects[ri];

        const size = 6 + Math.random() * 8;
        const w = Math.min(size, rc.w);
        const h = Math.min(size * (0.7 + Math.random() * 0.6), rc.h);
        const x = rc.x + Math.random() * (rc.w - w);
        const y = rc.y + Math.random() * (rc.h - h);

        let rgb = [128, 128, 128];
        if (sampler) rgb = sampler.average(x, y, w, h);

        const angle = Math.atan2(y + h / 2 - iy, x + w / 2 - ix) + (Math.random() - 0.5) * 1.2;
        const speed = 1.5 + Math.random() * 4;
        fragments.push({
          x, y, w, h,
          sx: x, sy: y,
          color: "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")",
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 1.5,
          rot: (Math.random() - 0.5) * 0.6,
          vr: (Math.random() - 0.5) * 0.35,
          life: 1,
          decay: 0.011 + Math.random() * 0.014
        });
      }
      return fragments;
    }

    /** Destruye la región del contacto. Un contacto destruye como mucho una región. */
    function hit(contact, impact) {
      if (!contact) return null;
      const t = contact.target;
      const ch = contact.chunk;
      if (t.solid || t.destroyed || !ch.alive) return null;

      // Ladrillo de varios golpes: aguanta, suelta unas chispas y se queda.
      if (t.hp > 1) {
        t.hp--;
        return {
          target: t,
          chunk: ch,
          targetDestroyed: false,
          damaged: true,
          hpLeft: t.hp,
          rects: [],
          area: 0,
          fragments: makeFragments(ch, impact, 5)
        };
      }

      ch.alive = false;
      for (let k = 0; k < ch.cells.length; k++) owner[ch.cells[k]] = 0;
      destroyedCells += ch.cells.length;
      t.aliveChunks--;
      t.destroyedArea += ch.area;
      if (t.aliveChunks === 0) {
        t.destroyed = true;
        destroyedTargets++;
      }

      return {
        target: t,
        chunk: ch,
        targetDestroyed: t.destroyed,
        rects: ch.rects,
        area: ch.area,
        fragments: makeFragments(ch, impact)
      };
    }

    function reset() {
      owner.set(initialOwner);
      destroyedCells = 0;
      destroyedTargets = 0;
      for (const t of targets) {
        t.destroyed = false;
        t.aliveChunks = t.chunks.length;
        t.destroyedArea = 0;
        t.hp = t.maxHp;
        for (const ch of t.chunks) ch.alive = true;
      }
    }

    function targetAt(x, y) {
      const c = clamp(Math.floor(x / cell), 0, cols - 1);
      const r = clamp(Math.floor(y / cell), 0, rows - 1);
      const o = owner[r * cols + c];
      return o ? targets.find((t) => t.ownerId === o) || null : null;
    }

    return {
      cell,
      cols,
      rows,
      targets,
      stats,
      queryCircle,
      hit,
      reset,
      targetAt,
      info: { silhouettes, inputTargets: input.length }
    };
  }

  WB.Destruction = {
    createEngine,
    createSampler,
    createSceneLayer,
    DEFAULTS,
    // Expuestas para las pruebas y para quien quiera reutilizarlas.
    internals: { cellsToRects, splitCells, rasterize, applySilhouette, morph }
  };
})();
