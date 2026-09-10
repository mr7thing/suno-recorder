// ===================================================================
// Suno Recorder — Service worker
// -------------------------------------------------------------------
// 双保险注入 + 分片传输（规避 Native Messaging 1MB 上限）+ 转码编排
// 失败兜底：直接下载 webm
// ===================================================================

console.log('[Suno Recorder] background service worker started');

const NM_HOST = 'com.suno.recorder';
const CHUNK_SIZE = 256 * 1024; // 256KB 一片，远低于 1MB 上限
const TIMEOUT_MS = 120000;     // 转码总超时 120s

// ---------- 点扩展图标：兜底注入 ----------
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content_iso.js'],
    });
  } catch (e) {
    console.error('[Suno Recorder] inject failed:', e.message);
  }
});

// ---------- 接收下载请求 ----------
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'SUNO_REC_DOWNLOAD') return false;
  const tabId = sender.tab?.id;
  console.log('[Suno Recorder] download request, dataUrl len:', msg.dataUrl?.length,
    'title:', msg.metadata?.title, 'tabId:', tabId);
  void handleDownload(msg, tabId);
  return false;
});

function sendTab(tabId, msg) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function handleDownload(msg, tabId) {
  try {
    await convertViaHost(msg, tabId);
  } catch (e) {
    console.warn('[Suno Recorder] native host 失败，兜底下载 webm:', e.message);
    setBadge('!', '#dc2626');
    setTimeout(() => setBadge(''), 5000);
    sendTab(tabId, { type: 'SUNO_REC_ERROR', message: e.message });
    await downloadWebm(msg.dataUrl, msg.mimeType);
  }
}

// ---------- Native Host 转码（分片传输） ----------
function convertViaHost({ dataUrl, mimeType, metadata }, tabId) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NM_HOST);
    let settled = false;
    let offset = 0;
    let seq = 0;
    let inflight = 0;
    const MAX_INFLIGHT = 4; // 流控：最多 4 片在途

    const timeoutId = setTimeout(() => {
      if (!settled) finish(new Error('转码超时（120s）'));
    }, TIMEOUT_MS);

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      try { port.disconnect(); } catch {}
      if (err) { setBadge('!', '#dc2626'); reject(err); }
      else resolve();
    }

    function sendNext() {
      while (inflight < MAX_INFLIGHT && offset < dataUrl.length) {
        const chunk = dataUrl.slice(offset, offset + CHUNK_SIZE);
        port.postMessage({ type: 'chunk', seq, data: chunk });
        offset += CHUNK_SIZE;
        seq++;
        inflight++;
      }
      if (offset >= dataUrl.length && inflight === 0) {
        port.postMessage({ type: 'convert_end' });
      }
    }

    port.onMessage.addListener((m) => {
      switch (m.type) {
        case 'hello':
          console.log('[Suno Recorder] host hello, ffmpeg:', m.ffmpeg);
          // 先发元数据，再开始分片
          port.postMessage({ type: 'convert_start', metadata, mimeType, total: dataUrl.length });
          sendNext();
          break;
        case 'chunk_ack':
          inflight--;
          sendNext();
          break;
        case 'progress':
          setBadge('…', '#f59e0b');
          sendTab(tabId, { type: 'SUNO_REC_PROGRESS', message: m.message });
          break;
        case 'done':
          setBadge('✓', '#10b981');
          notify(metadata?.title || 'Suno 录制', 'MP3 已保存: ' + m.path);
          sendTab(tabId, { type: 'SUNO_REC_DONE', path: m.path });
          setTimeout(() => setBadge(''), 5000);
          finish(null);
          break;
        case 'error':
          sendTab(tabId, { type: 'SUNO_REC_ERROR', message: m.message });
          finish(new Error(m.message));
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || 'host 进程退出';
      finish(new Error(err));
    });
  });
}

// ---------- 兜底：直接下载 webm ----------
async function downloadWebm(dataUrl, mimeType) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `suno-recorder/suno-${ts}.${pickExt(mimeType)}`;
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
}

function pickExt(mime = '') {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  return 'bin';
}

// ---------- UI ----------
function setBadge(text, color) {
  const opt = { text };
  if (color) opt.backgroundColor = color;
  chrome.action.setBadgeText(opt);
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title,
    message,
  });
}
