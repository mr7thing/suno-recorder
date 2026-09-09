// ===================================================================
// Suno Recorder — Service worker
// -------------------------------------------------------------------
// 状态协调 + 下载执行。不接触音频数据本身。
// ===================================================================

// ---------- 单一真相源 ----------
const state = { recording: false, streams: 0, ready: false };

// ---------- 消息总线 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return false;

  switch (msg.type) {
    case 'SUNO_REC_READY':
      state.ready = true;
      broadcast();
      return false;

    case 'SUNO_REC_STREAM':
      state.streams++;
      broadcast();
      return false;

    case 'SUNO_REC_RESULT':
      if (msg.cmd === 'start' && msg.result?.ok) state.recording = true;
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
      forwardToTab(msg);
      return false;

    default:
      return false;
  }
});

// ---------- 转发命令到当前 tab ----------
function forwardToTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  });
}

// ---------- 广播状态给 popup ----------
function broadcast() {
  chrome.runtime.sendMessage({ type: 'SUNO_REC_STATE', ...state })
    .catch(() => {});
}

// ---------- 执行下载 ----------
async function download(dataUrl, mimeType) {
  const ts = new Date().toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const ext = pickExt(mimeType);
  const filename = `suno-recorder/suno-${ts}.${ext}`;
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true,
  });
}

function pickExt(mime = '') {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  return 'bin';
}
