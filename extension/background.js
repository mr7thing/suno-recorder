// ===================================================================
// Suno Recorder — Service worker (v0.5.0)
// -------------------------------------------------------------------
// 主路径: offscreen document + ffmpeg.wasm 浏览器内转码
// 兜底:   native host (若 offscreen 失败)
// ===================================================================

console.log('[Suno Recorder] background service worker started');

const NM_HOST = 'com.suno.recorder';
const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_REASON = 'AUDIO_PROCESSING';
const TIMEOUT_MS = 300000; // 转码总超时 5 分钟（wasm 较慢）

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

// ---------- 统一消息入口 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[BG-000] 收到消息，type:', msg?.type, 'sender tab:', sender.tab?.id);

  // content → background: 下载请求
  if (msg?.type === 'SUNO_REC_DOWNLOAD') {
    const tabId = sender.tab?.id;
    console.log('[BG-001] SUNO_REC_DOWNLOAD，dataUrl 长度:', msg.dataUrl?.length,
      'title:', msg.metadata?.title, 'tabId:', tabId);
    sendResponse({ received: true });
    // fire-and-forget，但保持 SW 活跃
    void handleDownload(msg, tabId).catch((e) => {
      console.error('[BG-005] handleDownload 异常:', e.message);
    });
    return false; // 已同步响应，不需要异步
  }

  // offscreen → background: 转码进度
  if (msg?.type === 'SUNO_OFFSCREEN_PROGRESS') {
    setBadge('…', '#f59e0b');
    return false;
  }

  return false;
});

function sendTab(tabId, msg) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, msg).catch((e) => {
    console.warn('[BG-002] sendTab 失败:', e.message);
  });
}

async function handleDownload(msg, tabId) {
  console.log('[BG-010] handleDownload 开始');
  try {
    await transcodeViaOffscreen(msg, tabId);
    console.log('[BG-011] handleDownload 完成');
  } catch (e) {
    console.warn('[BG-003] offscreen 失败:', e.message);
    sendTab(tabId, { type: 'SUNO_REC_PROGRESS', message: 'WASM 失败: ' + e.message });
    try {
      console.log('[BG-012] 尝试 native host');
      await transcodeViaHost(msg, tabId);
    } catch (e2) {
      console.warn('[BG-004] native host 也失败:', e2.message);
      setBadge('!', '#dc2626');
      setTimeout(() => setBadge(''), 5000);
      sendTab(tabId, { type: 'SUNO_REC_ERROR', message: e2.message });
      console.log('[BG-013] 兜底下载 webm');
      await downloadWebm(msg.dataUrl, msg.mimeType, msg.metadata);
    }
  }
}

// ---------- Offscreen + ffmpeg.wasm 转码 ----------
async function transcodeViaOffscreen({ dataUrl, metadata }, tabId) {
  console.log('[BG-100] transcodeViaOffscreen 开始');
  await ensureOffscreen();

  // PING 等待 offscreen listener 就绪（最多 10 秒）
  await pingOffscreen();
  console.log('[BG-101] offscreen 就绪，发送转码消息，dataUrl 长度:', dataUrl.length);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.error('[BG-102] WASM 转码超时（5 分钟）');
      reject(new Error('WASM 转码超时（5 分钟）'));
    }, TIMEOUT_MS);

    chrome.runtime.sendMessage({
      type: 'SUNO_OFFSCREEN_TRANSCODE',
      dataUrl,
      metadata,
    }, (resp) => {
      clearTimeout(timeoutId);
      if (chrome.runtime.lastError) {
        console.error('[BG-104] sendMessage runtime error:', chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      console.log('[BG-103] 收到 offscreen 响应，ok:', resp?.ok,
        resp?.ok ? ('dataUrl 长度: ' + resp.dataUrl.length) : ('error: ' + resp?.error));
      if (!resp?.ok) {
        reject(new Error(resp?.error || 'offscreen 转码失败'));
        return;
      }
      const filename = `suno-recorder/${sanitize(metadata?.title) || 'suno-' + Date.now()}.mp3`;
      console.log('[BG-105] 开始下载 MP3:', filename);
      chrome.downloads.download({ url: resp.dataUrl, filename }, (downloadId) => {
        console.log('[BG-106] 下载已触发，downloadId:', downloadId);
        setBadge('✓', '#10b981');
        notify(metadata?.title || 'Suno 录制', 'MP3 已保存（WASM 转码）');
        sendTab(tabId, { type: 'SUNO_REC_DONE', path: filename });
        setTimeout(() => setBadge(''), 5000);
        resolve();
      });
    });
  });
}

// PING offscreen，确认 listener 已注册（createDocument resolve 时机不保证脚本执行完）
function pingOffscreen(retries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      chrome.runtime.sendMessage({ type: 'SUNO_OFFSCREEN_PING' }, (resp) => {
        if (chrome.runtime.lastError || !resp?.pong) {
          if (left <= 0) {
            reject(new Error('offscreen 500ms×20 次 PING 无响应，页面加载异常'));
            return;
          }
          setTimeout(() => attempt(left - 1), 500);
          return;
        }
        resolve();
      });
    };
    attempt(retries);
  });
}

let offscreenCreating = null;

async function ensureOffscreen() {
  // 显式检查 API 存在性，给出可定位的错误
  if (!chrome.offscreen?.createDocument) {
    throw new Error('chrome.offscreen API 不可用（manifest 缺 offscreen 权限或 Chrome <109）');
  }
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = (async () => {
    let existing = [];
    if (chrome.runtime.getContexts) {
      existing = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      }).catch((e) => {
        console.warn('[BG-205] getContexts 失败:', e.message);
        return [];
      });
    } else {
      // Chrome <116 兜底：用 clients.matchAll 探测
      const cls = await clients.matchAll({ includeUncontrolled: true }).catch(() => []);
      existing = cls.filter((c) => c.url === chrome.runtime.getURL(OFFSCREEN_URL));
    }
    console.log('[BG-200] 现有 offscreen 数量:', existing.length);
    if (existing.length === 0) {
      console.log('[BG-201] 创建 offscreen document:', OFFSCREEN_URL);
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: [OFFSCREEN_REASON],
          justification: '使用 ffmpeg.wasm 将 webm 转码为 MP3',
        });
        console.log('[BG-202] offscreen document 创建完成');
      } catch (e) {
        console.error('[BG-203] createDocument 失败:', e.message);
        throw e;
      }
    }
  })();
  try { await offscreenCreating; } finally { offscreenCreating = null; }
}

// ---------- Native Host 兜底转码 ----------
function transcodeViaHost({ dataUrl, mimeType, metadata }, tabId) {
  return new Promise((resolve, reject) => {
    try {
      const port = chrome.runtime.connectNative(NM_HOST);
      let settled = false;
      let offset = 0, seq = 0, inflight = 0;
      const CHUNK = 256 * 1024;
      const MAX_INFLIGHT = 4;

      const timeoutId = setTimeout(() => finish(new Error('转码超时（120s）')), 120000);

      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        try { port.disconnect(); } catch {}
        if (err) reject(err); else resolve();
      }
      function sendNext() {
        while (inflight < MAX_INFLIGHT && offset < dataUrl.length) {
          port.postMessage({ type: 'chunk', seq, data: dataUrl.slice(offset, offset + CHUNK) });
          offset += CHUNK; seq++; inflight++;
        }
        if (offset >= dataUrl.length && inflight === 0) port.postMessage({ type: 'convert_end' });
      }

      port.onMessage.addListener((m) => {
        switch (m.type) {
          case 'hello':
            port.postMessage({ type: 'convert_start', metadata, mimeType, total: dataUrl.length });
            sendNext(); break;
          case 'chunk_ack': inflight--; sendNext(); break;
          case 'progress':
            setBadge('…', '#f59e0b');
            sendTab(tabId, { type: 'SUNO_REC_PROGRESS', message: m.message }); break;
          case 'done':
            setBadge('✓', '#10b981');
            notify(metadata?.title || 'Suno 录制', 'MP3 已保存: ' + m.path);
            sendTab(tabId, { type: 'SUNO_REC_DONE', path: m.path });
            setTimeout(() => setBadge(''), 5000);
            finish(null); break;
          case 'error':
            sendTab(tabId, { type: 'SUNO_REC_ERROR', message: m.message });
            finish(new Error(m.message)); break;
        }
      });
      port.onDisconnect.addListener(() => {
        finish(new Error(chrome.runtime.lastError?.message || 'host 退出'));
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ---------- 兜底：直接下载 webm ----------
async function downloadWebm(dataUrl, mimeType, metadata) {
  const title = metadata?.title;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = title ? sanitize(title) : 'suno-' + ts;
  const filename = `suno-recorder/${base}.${pickExt(mimeType)}`;
  console.log('[BG-500] 兜底下载 webm:', filename);
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
  notify(title || 'Suno 录制', '转码失败，已保存原始 webm');
}

function pickExt(mime = '') {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  return 'bin';
}

function sanitize(name) {
  return (name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

// ---------- UI ----------
function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
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
