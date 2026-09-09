// ===================================================================
// Suno Recorder — Service worker
// -------------------------------------------------------------------
// 双保险：content_scripts 自动注入 + action.onClicked 兜底注入
// ===================================================================

console.log('[Suno Recorder] background service worker started');

// ---------- 点扩展图标：兜底注入 ----------
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[Suno Recorder] action.onClicked, tab:', tab.url);
  if (!tab.id) return;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content_iso.js'],
    });
    console.log('[Suno Recorder] inject ok, results:', results.length);
  } catch (e) {
    console.error('[Suno Recorder] inject failed:', e.message);
  }
});

// ---------- 接收下载请求 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'SUNO_REC_DOWNLOAD') return false;
  console.log('[Suno Recorder] download request, size:', msg.dataUrl?.length);
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
