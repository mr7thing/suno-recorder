// ===================================================================
// Suno Recorder — Bridge (ISOLATED world)
// -------------------------------------------------------------------
// 按需注入，中转 MAIN world 与 service worker 的消息
// ===================================================================

(() => {
  'use strict';
  if (window.__sunoIsoReady) return;
  window.__sunoIsoReady = true;

  // ---------- MAIN -> service worker ----------
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data || {};
    switch (msg.type) {
      case 'SUNO_REC_READY':
      case 'SUNO_REC_RESULT':
        chrome.runtime.sendMessage(msg).catch(() => {});
        break;
      case 'SUNO_REC_BLOB':
        chrome.runtime.sendMessage({
          type: 'SUNO_REC_DOWNLOAD',
          dataUrl: msg.dataUrl,
          mimeType: msg.mimeType,
        }).catch(() => {});
        break;
    }
  });

  // ---------- service worker -> MAIN ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'SUNO_REC_PING') {
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === 'SUNO_REC_CMD') {
      window.postMessage(msg, '*');
    }
    return false;
  });
})();
