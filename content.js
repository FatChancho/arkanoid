/*
 * content.js — Orquestador del content script.
 *
 * Se inyecta desde popup.js junto con scene.js, destruction.js, audio.js,
 * arcade.js y game.js (en ese orden; comparten el mismo mundo aislado). Aquí solo hay:
 *   - el protocolo de mensajes con el popup,
 *   - la secuencia de arranque (captura -> objetivos -> motor -> juego),
 *   - la limpieza completa al desactivar.
 *
 * La captura (chrome.tabs.captureVisibleTab) NO se hace aquí: solo se puede
 * pedir desde el contexto de la extensión, así que el popup la hace y la
 * envía en el mensaje "activate".
 *
 * Mensajes (popup -> content), todos responden { ok, ... }:
 *   getStatus   -> { ok, active, state, score, lives, destroyedTargets, ... }
 *   activate    { screenshot?: dataURL, mode: "web"|"arcade" } -> { ok, active } | { ok:false, error }
 *   deactivate  -> { ok, active:false }
 *   restart     -> { ok, active }
 */
(() => {
  if (window.__webBreakoutInstalled) return;
  window.__webBreakoutInstalled = true;

  const WB = globalThis.__WebBreakout;
  let session = null;
  let starting = false;

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(new Error("No se ha podido cargar la captura de pantalla."));
      image.src = src;
    });
  }

  function modulesReady() {
    return Boolean(WB && WB.Scene && WB.Destruction && WB.Game);
  }

  /** Inicia el juego en modo web (screenshot obligatorio). */
  async function startWebGame(screenshot) {
    if (typeof screenshot !== "string" || !screenshot.startsWith("data:image/")) {
      throw new Error("No se ha recibido una captura válida de la página.");
    }

    const image = await loadImage(screenshot);
    const stage = { width: window.innerWidth, height: window.innerHeight };

    // La captura y el viewport deben tener la misma proporción; si no, la
    // ventana cambió entre la captura y la activación.
    const imageRatio = image.naturalWidth / image.naturalHeight;
    const viewRatio = stage.width / stage.height;
    if (!(Math.abs(imageRatio / viewRatio - 1) <= 0.05)) {
      throw new Error("La captura no coincide con el tamaño actual de la ventana. Inténtalo de nuevo.");
    }

    // 1. Objetivos (antes de crear el canvas, para que no estorbe).
    const detected = WB.Scene.detectTargets();
    if (!detected.targets.length) {
      throw new Error("No se han encontrado objetivos visuales en esta página.");
    }

    // 2. Motor de destrucción y capa del escenario.
    const sampler = WB.Destruction.createSampler({
      image,
      stageWidth: stage.width,
      stageHeight: stage.height
    });
    const engine = WB.Destruction.createEngine({
      width: stage.width,
      height: stage.height,
      targets: detected.targets,
      sampler,
      playAreaBottom: WB.Game.playAreaBottom(stage.height)
    });
    if (!engine.targets.length) {
      throw new Error("No hay superficie destruible suficiente en esta página.");
    }
    const sceneLayer = WB.Destruction.createSceneLayer({
      image,
      stageWidth: stage.width,
      stageHeight: stage.height
    });

    // 3. Juego en modo web (transición a arcade al destruirla).
    const game = WB.Game.create({
      engine,
      sceneLayer,
      image,
      stage,
      startMode: "web",
      onExit: stopGame,
      onError: stopGame
    });

    session = { game, engine, sceneLayer, detected };
    game.start();
  }

  /** Inicia el juego directamente en modo arcade (sin captura ni objetivos web). */
  function startArcadeGame() {
    const stage = { width: window.innerWidth, height: window.innerHeight };

    // Motor sin objetivos web (la pelota no tiene nada que destruir en la web;
    // el modo arcade construye sus propios mundos con arcade.js).
    const engine = WB.Destruction.createEngine({
      width: stage.width,
      height: stage.height,
      targets: [],
      sampler: null,
      playAreaBottom: WB.Game.playAreaBottom(stage.height)
    });

    // Capa de escena vacía: sin imagen, solo pinta negro (el modo arcade
    // usa su propio canvas de ladrillos y no necesita la captura de la web).
    const noop = () => {};
    const sceneLayer = {
      canvas: null,
      reset: noop,
      erase: noop,
      draw: noop,
      dispose: noop,
      width: stage.width,
      height: stage.height,
      scaleX: 1,
      scaleY: 1
    };

    const game = WB.Game.create({
      engine,
      sceneLayer,
      image: null,
      stage,
      startMode: "arcade",
      onExit: stopGame,
      onError: stopGame
    });

    session = { game, engine, sceneLayer, detected: null };
    game.start();
  }

  async function startGame(screenshot, mode) {
    if (session) return;
    if (starting) throw new Error("WebBreakout ya se está activando.");
    if (!modulesReady()) {
      throw new Error("No se han cargado los módulos de WebBreakout. Recarga la página.");
    }

    starting = true;
    try {
      if (mode === "arcade") {
        startArcadeGame();
      } else {
        await startWebGame(screenshot);
      }
    } catch (error) {
      session = null;
      throw error;
    } finally {
      starting = false;
    }
  }

  function stopGame() {
    if (!session) return;
    const { game, sceneLayer } = session;
    session = null;
    game.stop();
    sceneLayer.dispose();
  }

  function getStatus() {
    if (!session) return { ok: true, active: false };
    const s = session.game.getStatus();
    return {
      ok: true,
      active: session.game.isActive(),
      state: s.state,
      score: s.score,
      lives: s.lives,
      destroyedTargets: s.destroyedTargets,
      remainingTargets: s.remainingTargets,
      totalTargets: s.totalTargets,
      percentDestroyed: s.percentDestroyed,
      music: s.music,
      mode: s.mode,
      level: s.level
    };
  }

  function messageListener(message, sender, sendResponse) {
    if (!message || typeof message.action !== "string") return;

    if (message.action === "activate") {
      startGame(message.screenshot, message.mode || "web")
        .then(() => sendResponse({ ok: true, active: true }))
        .catch((error) =>
          sendResponse({
            ok: false,
            active: false,
            error: error.message || "No se ha podido iniciar el juego."
          })
        );
      return true;
    }

    if (message.action === "deactivate") {
      try {
        stopGame();
        sendResponse({ ok: true, active: false });
      } catch (error) {
        sendResponse({ ok: false, active: Boolean(session), error: error.message });
      }
      return false;
    }

    if (message.action === "getStatus") {
      sendResponse(getStatus());
      return false;
    }

    if (message.action === "restart") {
      if (session) session.game.restart();
      sendResponse({ ok: Boolean(session), active: Boolean(session) });
      return false;
    }

    sendResponse({ ok: false, error: "Acción desconocida: " + message.action });
    return false;
  }

  chrome.runtime.onMessage.addListener(messageListener);

  window.__webBreakout = {
    startGame,
    stopGame,
    getStatus,
    // Solo visible desde el mundo aislado de la extensión (la página no lo ve); lo usan las pruebas.
    getGame: () => (session ? session.game : null)
  };
})();

