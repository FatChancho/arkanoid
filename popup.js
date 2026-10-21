
const toggleBtn = document.getElementById('toggleBtn');
const statusEl = document.getElementById('status');

let isActive = false;
let busy = false;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    throw new Error('No se ha encontrado la pestaña activa.');
  }

  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error(
      'Abre una página web normal. Chrome no permite ejecutar el juego en esta página.'
    );
  }

  return tab;
}

async function sendGameMessage(tabId, action) {
  try {
    return await chrome.tabs.sendMessage(tabId, { action });
  } catch {
    // No hay listener: inyectamos el script.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });

    // El script ya está cargado: enviamos el mensaje.
    return await chrome.tabs.sendMessage(tabId, { action });
  }
}

async function refreshStatus() {
  try {
    const tab = await getActiveTab();
    const result = await chrome.tabs.sendMessage(tab.id, {
      action: 'getStatus'
    });

    isActive = Boolean(result?.active);
    updateUI();
  } catch {
    isActive = false;
    updateUI();
  }
}

function updateUI() {
  toggleBtn.textContent = isActive
    ? 'Desactivar WebBreakout'
    : 'Activar WebBreakout';

  statusEl.textContent = isActive ? 'Juego activado' : 'Desactivado';
}

toggleBtn.addEventListener('click', async () => {
  if (busy) return;

  busy = true;
  toggleBtn.disabled = true;
  statusEl.textContent = 'Cargando...';

  try {
    const tab = await getActiveTab();
    const action = isActive ? 'deactivate' : 'activate';

    const result = await sendGameMessage(tab.id, action);

    if (result?.ok === false) {
      throw new Error(result.error || 'No se ha podido activar el juego.');
    }

    isActive = action === 'activate';
    updateUI();
  } catch (error) {
    console.error('Error al activar WebBreakout:', error);
    statusEl.textContent = error.message || 'Error al activar';
  } finally {
    busy = false;
    toggleBtn.disabled = false;
  }
});

refreshStatus();
