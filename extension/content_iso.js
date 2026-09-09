// ===================================================================
// Suno Recorder — Bridge (ISOLATED world)
// -------------------------------------------------------------------
// 中转 MAIN world 和 service worker 之间的消息
// 不做任何业务逻辑，只翻译消息
// ===================================================================

(() => {
  'use strict';

  // ---------- MAIN -> service worker ----------
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data || {};
    switch (msg.type) {
      case 'SUNO_REC_READY':
      case 'SUNO_REC_STREAM':
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
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'SUNO_REC_CMD') {
      window.postMessage(msg, '*');
    }
  });
})();
