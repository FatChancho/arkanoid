/*
 * scene.js — Detección y agrupación de objetivos visuales.
 *
 * Lee el DOM, los estilos calculados y la geometría de la página y devuelve
 * una lista de "objetivos": piezas visuales coherentes (logo, imagen, titular,
 * bloque de texto, botón, tarjeta, fondo...) con su forma aproximada en
 * píxeles CSS del viewport. No dibuja nada y no modifica el DOM.
 *
 * REGLAS DE AGRUPACIÓN (resumen; los comentarios de cada función las detallan)
 *
 *  G1. Hojas atómicas. Son una sola pieza y nunca se descomponen:
 *      img, picture>img, video, canvas, svg (raíz), object/embed/iframe,
 *      controles (button, input, select, textarea, [role=button]...) y
 *      [role=img].
 *  G2. Bloques de texto. Un elemento de nivel bloque que contiene texto en
 *      línea es UNA pieza: absorbe todos sus descendientes en línea (span, a,
 *      b, em...). Su forma son los rectángulos de sus líneas de texto, no la
 *      caja entera. Los hijos que no son en línea (bloques, imágenes,
 *      controles) siguen siendo piezas independientes.
 *  G3. Tarjeta. Un contenedor con decoración propia (fondo, borde en 3+
 *      lados, sombra o imagen de fondo) que cabe en un tamaño de tarjeta y
 *      contiene 2..14 piezas absorbe esas piezas y pasa a ser UNA tarjeta.
 *      No absorbe otras tarjetas ni fondos, ni piezas que sobresalgan de su
 *      caja. Si contiene una sola pieza que ya cubre >= 85 % de su caja, no
 *      se crea nada nuevo.
 *  G4. Lo que NO se agrupa. body/html, contenedores sin decoración y
 *      contenedores demasiado grandes se aplanan: sus hijos suben como piezas
 *      separadas. Un contenedor grande con imagen de fondo (o fondo sólido
 *      distinto del de la página) añade además una pieza "background".
 *  G5. Elementos vacíos con imagen de fondo CSS (por ejemplo, un logo hecho
 *      con background-image o con un sprite) son una imagen o un logo.
 *
 * DUPLICADOS: dos piezas con IoU >= 0.8 son la misma; se conserva la de
 * mayor prioridad de tipo. Las piezas que se solapan menos (texto sobre una
 * imagen) se conservan; el motor de destrucción decide a quién pertenece cada
 * región mediante capas (ver destruction.js).
 *
 * LIMITACIONES CONOCIDAS
 *  - No se recorre Shadow DOM.
 *  - Los pseudo-elementos (::before/::after) y las fuentes de iconos no son
 *    visibles para el DOM y no generan objetivos.
 *  - El recorte por overflow usa la caja de borde del ancestro, no la de
 *    padding, y no contempla clip-path ni transformaciones del ancestro.
 *  - Se recorren como máximo `nodeBudget` elementos.
 */
(() => {
  "use strict";

  const WB = (globalThis.__WebBreakout = globalThis.__WebBreakout || {});

  const OPTIONS = {
    minWidth: 18,
    minHeight: 12,
    minTextHeight: 10,
    minArea: 360,
    maxTargets: 250,
    nodeBudget: 30000,
    maxCardAreaRatio: 0.38,
    maxCardWidthRatio: 0.92,
    maxCardPieces: 14,
    cardOverflowTolerance: 6,
    cardCoverKeep: 0.85,
    minBackgroundAreaRatio: 0.04,
    maxBackgroundAreaRatio: 0.9,
    maxBackgrounds: 6,
    duplicateIoU: 0.8,
    lineGapFactor: 0.9,
    silhouetteMaxArea: 90000,
    canvasId: "webbreakout-game-canvas"
  };

  const SVG_NS = "http://www.w3.org/2000/svg";

  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "template", "head", "meta", "link",
    "title", "br", "wbr", "area", "map", "datalist", "option", "optgroup",
    "source", "track", "param", "base"
  ]);

  const INLINE_FLOW = new Set(["inline", "contents"]);

  const CONTROL_ROLES = new Set([
    "button", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "switch", "checkbox", "radio", "combobox", "searchbox", "textbox",
    "slider", "spinbutton", "option"
  ]);

  // Orden de pintado aproximado: capas altas ganan las regiones solapadas.
  const TYPE_LAYER = {
    background: 0,
    image: 1, video: 1, canvas: 1, svg: 1, embed: 1,
    card: 2,
    logo: 3, control: 3,
    heading: 4, link: 4, text: 4
  };

  // Qué pieza se conserva cuando dos son duplicadas.
  const TYPE_PRIORITY = {
    logo: 10, control: 9, card: 8,
    image: 7, svg: 7, canvas: 7, video: 7,
    embed: 6, heading: 6, link: 5, text: 4, background: 1
  };

  const LOGO_RE = /logo(?!ut|n)|brand(?:mark|ing)|wordmark|masthead/i;

  /* ------------------------------------------------------------------ */
  /* Geometría                                                           */
  /* ------------------------------------------------------------------ */

  function area(r) {
    return Math.max(0, r.width) * Math.max(0, r.height);
  }

  function intersection(a, b) {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.width, b.x + b.width);
    const y1 = Math.min(a.y + a.height, b.y + b.height);
    return x1 > x0 && y1 > y0
      ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      : null;
  }

  function iou(a, b) {
    const i = intersection(a, b);
    if (!i) return 0;
    const ia = area(i);
    return ia / (area(a) + area(b) - ia);
  }

  function unionRects(rects) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.width);
      y1 = Math.max(y1, r.y + r.height);
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  function containsRect(outer, inner, tol) {
    return (
      inner.x >= outer.x - tol &&
      inner.y >= outer.y - tol &&
      inner.x + inner.width <= outer.x + outer.width + tol &&
      inner.y + inner.height <= outer.y + outer.height + tol
    );
  }

  /** Recorta una caja (DOMRect o similar) al viewport y a los recortes activos. */
  function visibleRect(r, clips, vw, vh) {
    let x0 = Math.max(0, r.left);
    let y0 = Math.max(0, r.top);
    let x1 = Math.min(vw, r.right);
    let y1 = Math.min(vh, r.bottom);
    for (const c of clips) {
      x0 = Math.max(x0, c.rect.left);
      y0 = Math.max(y0, c.rect.top);
      x1 = Math.min(x1, c.rect.right);
      y1 = Math.min(y1, c.rect.bottom);
    }
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  function bigEnough(box, o, minHeight) {
    return (
      box.width >= o.minWidth &&
      box.height >= (minHeight || o.minHeight) &&
      area(box) >= o.minArea
    );
  }

  /* ------------------------------------------------------------------ */
  /* Estilos                                                             */
  /* ------------------------------------------------------------------ */

  function parseColor(str) {
    if (!str || str === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    let m = str.match(
      /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/
    );
    if (m) {
      let a = m[4] === undefined ? 1 : parseFloat(m[4]);
      if (m[5] === "%") a /= 100;
      return { r: +m[1], g: +m[2], b: +m[3], a };
    }
    m = str.match(/\/\s*([\d.]+)(%?)\s*\)\s*$/);
    if (m) {
      const a = m[2] === "%" ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
      return { r: NaN, g: NaN, b: NaN, a };
    }
    return { r: NaN, g: NaN, b: NaN, a: 1 };
  }

  function colorsDiffer(a, b) {
    if (Number.isNaN(a.r) || Number.isNaN(b.r)) return true;
    return (
      Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) > 36
    );
  }

  function paintInfo(cs) {
    const bg = parseColor(cs.backgroundColor);
    const hasBgImage = Boolean(cs.backgroundImage) && cs.backgroundImage !== "none";
    let borderSides = 0;
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      const style = cs["border" + side + "Style"];
      if (
        parseFloat(cs["border" + side + "Width"]) > 0 &&
        style !== "none" &&
        style !== "hidden" &&
        parseColor(cs["border" + side + "Color"]).a > 0.04
      ) {
        borderSides++;
      }
    }
    const hasBorder = borderSides >= 3;
    const hasShadow = Boolean(cs.boxShadow) && cs.boxShadow !== "none";
    return {
      bg,
      bgAlpha: bg.a,
      hasBgImage,
      hasBorder,
      hasShadow,
      decorated: bg.a > 0.04 || hasBgImage || hasBorder || hasShadow
    };
  }

  function parseRadius(value, w, h) {
    const parts = String(value || "0").trim().split(/\s+/);
    const toPx = (token, base) =>
      token.endsWith("%")
        ? (parseFloat(token) / 100) * base
        : parseFloat(token) || 0;
    return {
      rx: toPx(parts[0], w),
      ry: parts.length > 1 ? toPx(parts[1], h) : toPx(parts[0], h)
    };
  }

  /** Forma de una caja con sus esquinas redondeadas (relativa a `box`). */
  function shapeFromStyle(cs, rect, box) {
    if (
      Math.abs(rect.width - box.width) > 2 ||
      Math.abs(rect.height - box.height) > 2
    ) {
      return { kind: "rect" };
    }
    const w = box.width;
    const h = box.height;
    const tl = parseRadius(cs.borderTopLeftRadius, w, h);
    const tr = parseRadius(cs.borderTopRightRadius, w, h);
    const br = parseRadius(cs.borderBottomRightRadius, w, h);
    const bl = parseRadius(cs.borderBottomLeftRadius, w, h);
    const radii = [tl, tr, br, bl];
    if (radii.every((r) => r.rx <= 0 || r.ry <= 0)) return { kind: "rect" };

    const ratio = (side, sum) => (sum > 0 ? side / sum : Infinity);
    const f = Math.min(
      1,
      ratio(w, tl.rx + tr.rx),
      ratio(w, bl.rx + br.rx),
      ratio(h, tl.ry + bl.ry),
      ratio(h, tr.ry + br.ry)
    );
    return {
      kind: "rrect",
      radii: radii.map((r) => ({ rx: r.rx * f, ry: r.ry * f }))
    };
  }

  /* ------------------------------------------------------------------ */
  /* Utilidades DOM                                                      */
  /* ------------------------------------------------------------------ */

  function clipsOverflow(cs) {
    const clipping = (v) => v !== "visible";
    return clipping(cs.overflowX) || clipping(cs.overflowY);
  }

  function shortText(str, max) {
    return String(str || "").replace(/\s+/g, " ").trim().slice(0, max || 60);
  }

  function domPath(el) {
    const parts = [];
    for (
      let n = el;
      n && n.nodeType === 1 && n !== document.documentElement;
      n = n.parentElement
    ) {
      let idx = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
        idx++;
      }
      parts.push(n.localName + (n.id ? "#" + n.id : "") + ":" + idx);
    }
    return parts.reverse().join(">");
  }

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function classifyLeaf(el) {
    const tag = el.localName;

    if (el.namespaceURI === SVG_NS) {
      return tag === "svg" ? { kind: "svg" } : null;
    }

    switch (tag) {
      case "img": return { kind: "image" };
      case "video": return { kind: "video" };
      case "canvas": return { kind: "canvas" };
      case "object":
      case "embed":
      case "iframe": return { kind: "embed" };
      case "button":
      case "select":
      case "textarea":
      case "meter":
      case "progress":
      case "summary": return { kind: "control" };
      case "input": {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "hidden") return { kind: "skip" };
        if (type === "image") return { kind: "image" };
        return { kind: "control" };
      }
      default: break;
    }

    const role = el.getAttribute("role");
    if (role === "img") return { kind: "image", byRole: true };
    if (role && CONTROL_ROLES.has(role)) return { kind: "control", byRole: true };
    return null;
  }

  function logoHints(el) {
    const clip = (v) => (v ? String(v).slice(0, 200) : "");
    const src = el.getAttribute("src") || "";
    const bits = [
      el.id,
      el.getAttribute("class"),
      el.getAttribute("alt"),
      el.getAttribute("title"),
      el.getAttribute("aria-label"),
      el.getAttribute("data-testid"),
      el.getAttribute("name"),
      src.startsWith("data:") ? "" : src
    ];

    if (el.namespaceURI === SVG_NS) {
      const title = el.querySelector("title");
      if (title) bits.push(title.textContent);
      const use = el.querySelector("use");
      if (use) bits.push(use.getAttribute("href") || use.getAttribute("xlink:href"));
      if (el.querySelector('[id*="logo" i], [class*="logo" i]')) bits.push("logo");
    }

    const link = el.closest("a");
    if (link) {
      bits.push(link.id, link.getAttribute("class"), link.getAttribute("aria-label"), link.getAttribute("title"));
    }

    let parent = el.parentElement;
    for (let i = 0; i < 2 && parent; i++, parent = parent.parentElement) {
      bits.push(parent.id, parent.getAttribute("class"));
    }

    return bits.map(clip).filter(Boolean).join(" ");
  }

  /**
   * Un logo se reconoce por (1) nombres (id, clase, alt, title, aria-label,
   * <title> de un SVG, ruta de la imagen) o (2) por ser un medio dentro de un
   * enlace a la portada del propio sitio en la parte alta de la página.
   */
  function accessibleName(el) {
    let name = el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title");
    if (!name && el.namespaceURI === SVG_NS) {
      const title = el.querySelector("title");
      if (title) name = title.textContent;
    }
    return shortText(name, 80).toLowerCase();
  }

  function looksLikeLogo(el, rect, S) {
    if (LOGO_RE.test(logoHints(el))) return true;

    // Nombre accesible igual al nombre del sitio (alt="Google" en google.com).
    const name = accessibleName(el);
    if (name && S.brandNames.has(name)) return true;

    const link = el.closest("a[href]");
    if (link && rect.top < S.vh * 0.25) {
      try {
        const url = new URL(link.getAttribute("href"), location.href);
        if (url.origin === location.origin && url.pathname === "/" && !url.search) {
          return true;
        }
      } catch {
        // href no analizable: no es una portada.
      }
    }
    return false;
  }

  function mayHaveTransparency(el, box, o) {
    if (area(box) > o.silhouetteMaxArea) return false;
    const src = (el.currentSrc || el.getAttribute("src") || "").toLowerCase();
    return /\.(svg|png|webp|gif)(\?|#|$)/.test(src) || /^data:image\/(svg|png|webp|gif)/.test(src);
  }

  /** Comprueba que el elemento (o un descendiente/ancestro) está arriba en algún punto. */
  function isTopmost(el, rects, S) {
    const samples = [];
    for (const r of rects.slice(0, 3)) {
      const f = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
      for (const [fx, fy] of f) {
        samples.push([r.x + r.width * fx, r.y + r.height * fy]);
      }
    }
    for (const [x, y] of samples) {
      const px = Math.min(S.vw - 1, Math.max(0, x));
      const py = Math.min(S.vh - 1, Math.max(0, y));
      const hit = document.elementFromPoint(px, py);
      if (hit && (el === hit || el.contains(hit) || hit.contains(el))) return true;
    }
    return false;
  }

  function makePiece(S, props) {
    return Object.assign(
      { layer: TYPE_LAYER[props.type], order: S.order++, silhouette: false, label: "" },
      props
    );
  }

  /* ------------------------------------------------------------------ */
  /* Recorrido del DOM                                                   */
  /* ------------------------------------------------------------------ */

  function isInlineFlow(node, S) {
    if (SKIP_TAGS.has(node.localName) || node.id === S.opt.canvasId) return false;
    if (classifyLeaf(node)) return false;
    return INLINE_FLOW.has(S.style(node).display);
  }

  function hasInlineText(parent, S) {
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3) {
        if (/\S/.test(node.nodeValue)) return true;
      } else if (node.nodeType === 1 && isInlineFlow(node, S) && hasInlineText(node, S)) {
        return true;
      }
    }
    return false;
  }

  /** Une los rectángulos de texto que están en la misma línea. */
  function mergeLines(rects, gapFactor) {
    const lines = rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));

    const mergeable = (a, b) => {
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapY < 0.5 * Math.min(a.height, b.height)) return false;
      const gap = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
      return gap <= gapFactor * Math.max(a.height, b.height);
    };

    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < lines.length && !changed; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          if (mergeable(lines[i], lines[j])) {
            const u = unionRects([lines[i], lines[j]]);
            lines[i] = u;
            lines.splice(j, 1);
            changed = true;
            break;
          }
        }
      }
    }
    return lines.sort((a, b) => a.y - b.y || a.x - b.x);
  }

  /** Pieza de texto a partir de una lista de nodos de texto. */
  function textPiece(el, cs, nodes, chars, linkChars, clips, S, forceType) {
    if (!nodes.length) return null;
    if (parseColor(cs.color).a < 0.05) return null;
    if (parseFloat(cs.fontSize) < 6) return null;

    const range = document.createRange();
    const raw = [];
    for (const node of nodes) {
      range.selectNodeContents(node);
      const list = range.getClientRects();
      for (let i = 0; i < list.length; i++) {
        const r = visibleRect(list[i], clips, S.vw, S.vh);
        if (r && r.width >= 2 && r.height >= 2) raw.push(r);
      }
    }
    if (!raw.length) return null;

    const lines = mergeLines(raw, S.opt.lineGapFactor);
    const bounds = unionRects(lines);
    if (bounds.width < S.opt.minWidth || bounds.height < S.opt.minTextHeight) {
      S.stats.tooSmall++;
      return null;
    }
    if (!isTopmost(el, lines, S)) {
      S.stats.occluded++;
      return null;
    }

    const tag = el.localName;
    let type = forceType;
    if (!type) {
      const linkRatio = chars ? linkChars / chars : 0;
      type = "text";
      if (/^h[1-6]$/.test(tag) || el.getAttribute("role") === "heading") type = "heading";
      else if (tag === "a" || linkRatio >= 0.9) type = "link";
    }

    return makePiece(S, {
      el,
      type,
      rect: bounds,
      shape: { kind: "rects", rects: lines },
      label: shortText(el.textContent)
    });
  }

  /**
   * Piezas de un bloque de texto. Si el bloque es casi todo enlaces separados
   * (un menú de <a> en línea), cada enlace es su propia pieza; en cualquier
   * otro caso el bloque entero es una pieza.
   */
  function buildTextPieces(el, cs, collector, clips, S) {
    const isHeading = /^h[1-6]$/.test(el.localName) || el.getAttribute("role") === "heading";
    const linkRatio = collector.chars ? collector.linkChars / collector.chars : 0;

    if (!isHeading && el.localName !== "a" && collector.links.length >= 2 && linkRatio >= 0.9) {
      const out = [];
      for (const link of collector.links) {
        const p = textPiece(link.el, S.style(link.el), link.nodes, 0, 0, clips, S, "link");
        if (p) out.push(p);
      }
      return out;
    }

    const own = textPiece(el, cs, collector.nodes, collector.chars, collector.linkChars, clips, S, null);
    return own ? [own] : [];
  }

  function makeLeafPiece(el, cs, leaf, clips, S) {
    const rect = el.getBoundingClientRect();
    const box = visibleRect(rect, clips, S.vw, S.vh);
    if (!box) {
      S.stats.offscreen++;
      return null;
    }
    if (!bigEnough(box, S.opt)) {
      S.stats.tooSmall++;
      return null;
    }
    if (!isTopmost(el, [box], S)) {
      S.stats.occluded++;
      return null;
    }

    let type;
    switch (leaf.kind) {
      case "svg": type = "svg"; break;
      case "canvas": type = "canvas"; break;
      case "video": type = "video"; break;
      case "embed": type = "embed"; break;
      case "control": type = "control"; break;
      default: type = "image"; break;
    }

    if (type !== "control" && type !== "embed" && looksLikeLogo(el, rect, S)) {
      type = "logo";
    }

    const silhouette =
      type === "logo" ||
      type === "svg" ||
      type === "canvas" ||
      (type === "image" && el.localName === "img" && mayHaveTransparency(el, box, S.opt));

    return makePiece(S, {
      el,
      type,
      rect: box,
      shape: shapeFromStyle(cs, rect, box),
      silhouette,
      label: shortText(
        el.getAttribute("alt") ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.value ||
        el.textContent
      )
    });
  }

  function walkChildren(parent, clips, S, collector, link) {
    let pieces = [];
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3) {
        if (collector) {
          const len = node.nodeValue.replace(/\s+/g, "").length;
          if (len) {
            collector.nodes.push(node);
            collector.chars += len;
            if (link) {
              collector.linkChars += len;
              link.nodes.push(node);
            }
          }
        }
        continue;
      }
      if (node.nodeType !== 1) continue;

      if (collector && isInlineFlow(node, S)) {
        S.visited++;
        const ncs = S.style(node);
        if (ncs.visibility !== "visible" || parseFloat(ncs.opacity) < 0.05) continue;
        let childLink = link;
        if (node.localName === "a") {
          childLink = { el: node, nodes: [] };
          collector.links.push(childLink);
        }
        pieces = pieces.concat(walkChildren(node, clips, S, collector, childLink));
      } else {
        pieces = pieces.concat(walk(node, clips, S));
      }
    }
    return pieces;
  }

  function walk(el, clips, S) {
    if (S.visited >= S.opt.nodeBudget) {
      S.stats.budgetExceeded = true;
      return [];
    }
    S.visited++;

    if (SKIP_TAGS.has(el.localName) || el.id === S.opt.canvasId) return [];

    const cs = S.style(el);
    if (cs.display === "none" || parseFloat(cs.opacity) < 0.05) {
      S.stats.hidden++;
      return [];
    }

    // Recortes que afectan a este elemento.
    let activeClips = clips;
    if (cs.position === "fixed") {
      activeClips = [];
    } else if (cs.position === "absolute" && clips.length) {
      const block = el.offsetParent || document.documentElement;
      activeClips = clips.filter((c) => c.el.contains(block));
    }

    const hidden = cs.visibility !== "visible";

    // G1. Hojas atómicas.
    let leaf = classifyLeaf(el);
    if (leaf && leaf.byRole) {
      // Un role=button enorme es un contenedor de diseño, no una hoja.
      const r = el.getBoundingClientRect();
      if (r.width * r.height > S.opt.maxCardAreaRatio * S.vw * S.vh) leaf = null;
    }
    if (leaf) {
      if (hidden || leaf.kind === "skip") return [];
      const piece = makeLeafPiece(el, cs, leaf, activeClips, S);
      return piece ? [piece] : [];
    }

    const rect = el.getBoundingClientRect();
    let childClips = activeClips;
    if (clipsOverflow(cs)) {
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= S.vw || rect.top >= S.vh) {
        return [];
      }
      childClips = activeClips.concat({ el, rect });
    }

    // G2. Bloque de texto.
    const isTextRoot = !hidden && !INLINE_FLOW.has(cs.display) && hasInlineText(el, S);
    let pieces;
    if (isTextRoot) {
      const collector = { nodes: [], chars: 0, linkChars: 0, links: [] };
      const rootLink = el.localName === "a" ? { el, nodes: [] } : null;
      const childPieces = walkChildren(el, childClips, S, collector, rootLink);
      pieces = buildTextPieces(el, cs, collector, childClips, S).concat(childPieces);
    } else {
      pieces = walkChildren(el, childClips, S, null, null);
    }

    return finishContainer(el, cs, rect, activeClips, pieces, hidden, S);
  }

  /**
   * G3, G4 y G5: decide si un contenedor se convierte en tarjeta, añade un
   * fondo, o simplemente deja pasar a sus hijos.
   */
  function finishContainer(el, cs, rect, clips, pieces, hidden, S) {
    if (hidden) return pieces;
    const tag = el.localName;
    if (tag === "body" || tag === "html") return pieces;

    const paint = paintInfo(cs);
    if (!paint.decorated) return pieces;

    const box = visibleRect(rect, clips, S.vw, S.vh);
    if (!box) return pieces;

    const o = S.opt;
    const boxArea = area(box);
    const vpArea = S.vw * S.vh;
    const fitsCard =
      boxArea <= o.maxCardAreaRatio * vpArea &&
      box.width <= o.maxCardWidthRatio * S.vw &&
      boxArea >= o.minArea;

    /* G5 y bloques de color vacíos */
    if (!pieces.length) {
      if (!bigEnough(box, o) || boxArea > o.maxBackgroundAreaRatio * vpArea) return pieces;

      if (paint.hasBgImage) {
        if (!isTopmost(el, [box], S)) return pieces;
        const type = !fitsCard
          ? "background"
          : looksLikeLogo(el, rect, S) ? "logo" : "image";
        return [makePiece(S, {
          el,
          type,
          rect: box,
          shape: shapeFromStyle(cs, rect, box),
          silhouette: type === "logo",
          label: shortText(el.getAttribute("aria-label") || el.getAttribute("title"))
        })];
      }

      const solid = paint.bgAlpha >= 0.5 && colorsDiffer(paint.bg, S.bodyBg);
      if (fitsCard && (solid || paint.hasBorder || paint.hasShadow) && isTopmost(el, [box], S)) {
        return [makePiece(S, {
          el,
          type: "card",
          rect: box,
          shape: shapeFromStyle(cs, rect, box),
          label: shortText(el.getAttribute("aria-label") || el.getAttribute("title"))
        })];
      }
      return pieces;
    }

    /* Una sola pieza dentro de un contenedor decorado */
    if (pieces.length === 1) {
      const p = pieces[0];
      const cover = area(intersection(p.rect, box) || { width: 0, height: 0 }) / boxArea;
      if (cover >= o.cardCoverKeep || !fitsCard) return pieces;
      if (p.type === "card" || p.type === "background") return pieces;
      if (!containsRect(box, p.rect, o.cardOverflowTolerance)) return pieces;

      // La pieza no es lo único visible: el aspecto lo da la caja (p. ej. una
      // "píldora" con texto). La caja pasa a ser la pieza.
      const type = p.type === "link" ? "control" : p.type === "text" || p.type === "heading" ? "card" : p.type;
      return [makePiece(S, {
        el,
        type,
        rect: box,
        shape: shapeFromStyle(cs, rect, box),
        silhouette: false,
        label: p.label
      })];
    }

    /* G3. Tarjeta */
    const groupable =
      fitsCard &&
      pieces.length <= o.maxCardPieces &&
      pieces.every((p) => p.type !== "card" && p.type !== "background") &&
      pieces.every((p) => containsRect(box, p.rect, o.cardOverflowTolerance));

    if (groupable) {
      S.stats.cardsFormed++;
      S.stats.grouped += pieces.length;
      return [makePiece(S, {
        el,
        type: "card",
        rect: box,
        shape: shapeFromStyle(cs, rect, box),
        label: shortText(pieces.map((p) => p.label).filter(Boolean).join(" "))
      })];
    }

    /* G4. Aplanar, y añadir un fondo si es fiable */
    if (boxArea >= o.minBackgroundAreaRatio * vpArea && boxArea <= o.maxBackgroundAreaRatio * vpArea) {
      const solid = paint.bgAlpha >= 0.5 && colorsDiffer(paint.bg, S.bodyBg);
      if ((paint.hasBgImage || solid) && isTopmost(el, [box], S)) {
        return [makePiece(S, {
          el,
          type: "background",
          rect: box,
          shape: shapeFromStyle(cs, rect, box),
          label: ""
        })].concat(pieces);
      }
    }
    return pieces;
  }

  /* ------------------------------------------------------------------ */
  /* Ensamblado final                                                    */
  /* ------------------------------------------------------------------ */

  function dedupe(pieces, S) {
    const sorted = pieces.slice().sort(
      (a, b) => TYPE_PRIORITY[b.type] - TYPE_PRIORITY[a.type] || a.order - b.order
    );
    const kept = [];
    for (const p of sorted) {
      let dup = false;
      for (const q of kept) {
        if (p.el === q.el || iou(p.rect, q.rect) >= S.opt.duplicateIoU) {
          dup = true;
          break;
        }
      }
      if (dup) S.stats.duplicates++;
      else kept.push(p);
    }
    return kept;
  }

  /** Nombres con los que el sitio se identifica: título, og:site_name y dominio. */
  function collectBrandNames() {
    const names = new Set();
    const add = (v) => {
      const s = shortText(v, 80).toLowerCase();
      if (s.length >= 3) names.add(s);
    };
    const title = document.title || "";
    add(title);
    title.split(/\s[|\-–—·:]\s/).forEach(add);
    const og = document.querySelector('meta[property="og:site_name"]');
    if (og) add(og.getAttribute("content"));
    const labels = location.hostname.replace(/^www\./, "").split(".");
    add(labels[0]);
    if (labels.length >= 2) add(labels[labels.length - 2]);
    return names;
  }

  function effectiveBackground() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const c = parseColor(getComputedStyle(el).backgroundColor);
      if (c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  /**
   * Detecta los objetivos del viewport actual.
   * Devuelve { targets, stats, viewport }. Cada objetivo contiene:
   *   id, key, type, rect {x,y,width,height}, shape, silhouette, layer, order,
   *   label y `el` (solo para depuración; el resto del juego no lo usa).
   */
  function detectTargets(userOptions) {
    const opt = Object.assign({}, OPTIONS, userOptions || {});
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const styleCache = new WeakMap();

    const S = {
      opt,
      vw,
      vh,
      order: 0,
      visited: 0,
      bodyBg: effectiveBackground(),
      brandNames: collectBrandNames(),
      stats: {
        hidden: 0, offscreen: 0, tooSmall: 0, occluded: 0, duplicates: 0,
        cardsFormed: 0, grouped: 0, budgetExceeded: false
      },
      style(el) {
        let cs = styleCache.get(el);
        if (!cs) {
          cs = getComputedStyle(el);
          styleCache.set(el, cs);
        }
        return cs;
      }
    };

    const root = document.body || document.documentElement;
    let pieces = walk(root, [], S);

    // Limita los fondos a los más grandes.
    const backgrounds = pieces
      .filter((p) => p.type === "background")
      .sort((a, b) => area(b.rect) - area(a.rect));
    const dropped = new Set(backgrounds.slice(opt.maxBackgrounds));
    pieces = pieces.filter((p) => !dropped.has(p));

    pieces = dedupe(pieces, S);
    pieces = pieces.filter(
      (p) => Number.isFinite(p.rect.x) && p.rect.width > 0 && p.rect.height > 0
    );

    if (pieces.length > opt.maxTargets) {
      pieces = pieces
        .sort(
          (a, b) =>
            TYPE_PRIORITY[b.type] - TYPE_PRIORITY[a.type] ||
            area(b.rect) - area(a.rect)
        )
        .slice(0, opt.maxTargets);
    }

    pieces.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.order - b.order);

    const used = new Set();
    const counts = {};
    const targets = pieces.map((p) => {
      const key = domPath(p.el);
      let id = p.type + "-" + fnv1a(key + "|" + p.type).toString(36);
      while (used.has(id)) id += "x";
      used.add(id);
      counts[p.type] = (counts[p.type] || 0) + 1;
      return {
        id,
        key,
        type: p.type,
        rect: p.rect,
        shape: p.shape,
        silhouette: p.silhouette,
        layer: p.layer,
        order: p.order,
        label: p.label,
        el: p.el
      };
    });

    S.stats.visited = S.visited;
    S.stats.counts = counts;

    return { targets, stats: S.stats, viewport: { width: vw, height: vh } };
  }

  WB.Scene = { detectTargets, OPTIONS };
})();
