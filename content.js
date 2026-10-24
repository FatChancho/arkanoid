/*
 * content.js — Orquestador del content script.
 *
 * Se inyecta desde popup.js junto con scene.js, destruction.js, audio.js y
 * game.js (en ese orden; comparten el mismo mundo aislado). Aquí solo hay:
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
 *   activate    { screenshot: dataURL } -> { ok, active } | { ok:false, error }
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

  async function startGame(screenshot) {
    if (session) return;
    if (starting) throw new Error("WebBreakout ya se está activando.");
    if (!modulesReady()) {
      throw new Error("No se han cargado los módulos de WebBreakout. Recarga la página.");
    }
    if (typeof screenshot !== "string" || !screenshot.startsWith("data:image/")) {
      throw new Error("No se ha recibido una captura válida de la página.");
    }

    starting = true;
    let sceneLayer = null;

    try {
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
      sceneLayer = WB.Destruction.createSceneLayer({
        image,
        stageWidth: stage.width,
        stageHeight: stage.height
      });

      // 3. Juego.
      const game = WB.Game.create({
        engine,
        sceneLayer,
        image,
        stage,
        onExit: stopGame,
        onError: stopGame
      });

      session = { game, engine, sceneLayer, detected };
      game.start();
    } catch (error) {
      if (sceneLayer) sceneLayer.dispose();
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
      percentDestroyed: s.percentDestroyed
    };
  }

  function messageListener(message, sender, sendResponse) {
    if (!message || typeof message.action !== "string") return;

    if (message.action === "activate") {
      startGame(message.screenshot)
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
    getStatus
  };
})();
