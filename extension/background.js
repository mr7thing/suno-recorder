// ===================================================================
// Suno Recorder — Service worker
// -------------------------------------------------------------------
// 状态协调 + 按需注入 + 下载执行
// ===================================================================

const state = { recording: false, ready: false, hasAudio: false };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return false;

  switch (msg.type) {
    case 'SUNO_REC_READY':
      state.ready = true;
      broadcast();
      return false;

    case 'SUNO_REC_RESULT':
      if (msg.cmd === 'start') {
        state.recording = !!msg.result?.ok;
        if (msg.result?.error) state.lastError = msg.result.error;
      }
      if (msg.cmd === 'stop') state.recording = false;
      broadcast();
      return false;

    case 'SUNO_REC_DOWNLOAD':
      void download(msg.dataUrl, msg.mimeType);
      return false;

    case 'SUNO_REC_GET_STATE':
      sendResponse(state);
      return true;

    case 'SUNO_REC_CMD':
      void handleCommand(msg);
      return false;

    default:
      return false;
  }
});

// ---------- 处理命令：先注入再转发 ----------
async function handleCommand(msg) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;

  await ensureInjected(tab.id);
  // 50ms 等 listener 就位
  await sleep(50);
  await chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
}

// ---------- 按需注入：确保 content scripts 在运行 ----------
async function ensureInjected(tabId) {
  // 先 ping content_iso.js——通了说明已注入
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SUNO_REC_PING' });
    return; // 已注入
  } catch {
    // 未注入，继续
  }

  // 注入 ISOLATED world 桥接
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content_iso.js'],
    world: 'ISOLATED',
  });

  // 注入 MAIN world 核心
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content_main.js'],
    world: 'MAIN',
  });
}

// ---------- 广播状态给 popup ----------
function broadcast() {
  chrome.runtime.sendMessage({ type: 'SUNO_REC_STATE', ...state })
    .catch(() => {});
}

// ---------- 下载 ----------
async function download(dataUrl, mimeType) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = pickExt(mimeType);
  const filename = `suno-recorder/suno-${ts}.${ext}`;
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
}

function pickExt(mime = '') {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  return 'bin';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
