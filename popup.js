
const webBtn = document.getElementById("webBtn");
const arcadeBtn = document.getElementById("arcadeBtn");
const deactivateBtn = document.getElementById("deactivateBtn");
const startRow = document.getElementById("startRow");
const statusEl = document.getElementById("status");

// El orden importa: los módulos se registran en __WebBreakout y content.js,
// que va el último, los usa.
const CONTENT_FILES = ["scene.js", "destruction.js", "audio.js", "arcade.js", "game.js", "content.js"];

let isActive = false;
let busy = false;
let lastStatus = null;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    throw new Error("No se ha encontrado la pestaña activa.");
  }

  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error(
      "Abre una página web normal. Chrome no permite jugar en esta página."
    );
  }

  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "getStatus" });
    return;
  } catch {
    // El content script aún no está en la página: se inyecta a continuación.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_FILES
    });
  } catch (error) {
    throw new Error(
      "No se puede ejecutar WebBreakout en esta página: " +
        (error?.message || "error desconocido.")
    );
  }
}

async function sendGameMessage(tabId, message) {
  await ensureContentScript(tabId);
  const result = await chrome.tabs.sendMessage(tabId, message);
  if (!result) {
    throw new Error("La página no ha respondido. Recárgala e inténtalo de nuevo.");
  }
  return result;
}

async function captureTab(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    throw new Error(
      "No se ha podido capturar la pestaña: " +
        (error?.message || "error desconocido.")
    );
  }
}

async function refreshStatus() {
  try {
    const tab = await getActiveTab();
    const result = await chrome.tabs.sendMessage(tab.id, {
      action: "getStatus"
    });

    isActive = Boolean(result?.active);
    lastStatus = isActive ? result : null;
  } catch {
    isActive = false;
    lastStatus = null;
  }

  updateUI();
}

function updateUI() {
  const showing = isActive;
  startRow.style.display = showing ? "none" : "flex";
  deactivateBtn.style.display = showing ? "block" : "none";

  if (!isActive) {
    statusEl.textContent = "Elige un modo para jugar.";
    return;
  }

  statusEl.textContent =
    lastStatus && typeof lastStatus.percentDestroyed === "number"
      ? `Juego activado · ${Math.floor(lastStatus.percentDestroyed)} % destruido`
      : "Juego activado";
}

async function activate(mode) {
  if (busy) return;
  busy = true;
  setBusy(true);
  statusEl.textContent = mode === "arcade" ? "Iniciando modo arcade..." : "Capturando la página...";

  try {
    const tab = await getActiveTab();

    let screenshot = null;
    if (mode !== "arcade") {
      screenshot = await captureTab(tab.windowId);
      statusEl.textContent = "Preparando objetivos visuales...";
    }

    const result = await sendGameMessage(tab.id, {
      action: "activate",
      screenshot,
      mode
    });

    if (!result.ok) {
      throw new Error(result.error || "No se ha podido activar WebBreakout.");
    }

    isActive = true;
    lastStatus = null;
    updateUI();
  } catch (error) {
    console.error("Error en WebBreakout:", error);
    statusEl.textContent = error.message || "Se ha producido un error.";
  } finally {
    busy = false;
    setBusy(false);
  }
}

async function deactivate() {
  if (busy) return;
  busy = true;
  setBusy(true);
  statusEl.textContent = "Desactivando...";

  try {
    const tab = await getActiveTab();
    const result = await sendGameMessage(tab.id, { action: "deactivate" });

    if (result.ok === false) {
      throw new Error(result.error || "No se ha podido desactivar el juego.");
    }

    isActive = false;
    lastStatus = null;
    updateUI();
  } catch (error) {
    console.error("Error en WebBreakout:", error);
    statusEl.textContent = error.message || "Se ha producido un error.";
  } finally {
    busy = false;
    setBusy(false);
  }
}

function setBusy(on) {
  webBtn.disabled = on;
  arcadeBtn.disabled = on;
  deactivateBtn.disabled = on;
}

webBtn.addEventListener("click", () => activate("web"));
arcadeBtn.addEventListener("click", () => activate("arcade"));
deactivateBtn.addEventListener("click", deactivate);

refreshStatus();
