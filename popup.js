
const toggleBtn = document.getElementById("toggleBtn");
const statusEl = document.getElementById("status");

// El orden importa: los módulos se registran en __WebBreakout y content.js,
// que va el último, los usa.
const CONTENT_FILES = ["scene.js", "destruction.js", "audio.js", "game.js", "content.js"];

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
  toggleBtn.textContent = isActive
    ? "Desactivar WebBreakout"
    : "Activar WebBreakout";

  if (!isActive) {
    statusEl.textContent = "Desactivado";
    return;
  }

  statusEl.textContent =
    lastStatus && typeof lastStatus.percentDestroyed === "number"
      ? `Juego activado · ${Math.floor(lastStatus.percentDestroyed)} % destruido`
      : "Juego activado";
}

toggleBtn.addEventListener("click", async () => {
  if (busy) return;

  busy = true;
  toggleBtn.disabled = true;
  statusEl.textContent = isActive
    ? "Desactivando..."
    : "Capturando la página...";

  try {
    const tab = await getActiveTab();

    if (isActive) {
      const result = await sendGameMessage(tab.id, {
        action: "deactivate"
      });

      if (result.ok === false) {
        throw new Error(
          result.error || "No se ha podido desactivar el juego."
        );
      }

      isActive = false;
      lastStatus = null;
    } else {
      // La captura se hace desde el popup, no desde content.js.
      const screenshot = await captureTab(tab.windowId);

      statusEl.textContent = "Preparando objetivos visuales...";

      const result = await sendGameMessage(tab.id, {
        action: "activate",
        screenshot
      });

      if (!result.ok) {
        throw new Error(
          result.error || "No se ha podido activar WebBreakout."
        );
      }

      isActive = true;
      lastStatus = null;
    }

    updateUI();
  } catch (error) {
    console.error("Error en WebBreakout:", error);
    statusEl.textContent = error.message || "Se ha producido un error.";
  } finally {
    busy = false;
    toggleBtn.disabled = false;
  }
});

refreshStatus();
