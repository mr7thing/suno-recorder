// ===================================================================
// Suno Recorder — Service worker
// -------------------------------------------------------------------
// 点扩展图标 → 注入 content_iso.js 到当前 tab
// 接收 content_iso.js 的下载请求 → chrome.downloads
// ===================================================================

// ---------- 点扩展图标：注入录制脚本 ----------
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content_iso.js'],
      world: 'ISOLATED',
    });
  } catch (e) {
    console.error('[Suno Recorder] inject failed:', e);
  }
});

// ---------- 接收下载请求 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'SUNO_REC_DOWNLOAD') return false;
  void download(msg.dataUrl, msg.mimeType);
  return false;
});

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
