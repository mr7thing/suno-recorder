// ===================================================================
// Suno Recorder — Service worker
// -------------------------------------------------------------------
// 双保险：content_scripts 自动注入 + action.onClicked 兜底注入
// 下载优先走 Native Host 转 MP3，失败兜底下载 webm
// ===================================================================

console.log('[Suno Recorder] background service worker started');

const NM_HOST = 'com.suno.recorder';

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
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'SUNO_REC_DOWNLOAD') return false;
  console.log('[Suno Recorder] download request, size:', msg.dataUrl?.length, 'title:', msg.title);
  void handleDownload(msg);
  return false;
});

async function handleDownload(msg) {
  try {
    await convertViaHost(msg);
  } catch (e) {
    console.warn('[Suno Recorder] native host 不可用，兜底下载 webm:', e.message);
    await downloadWebm(msg.dataUrl, msg.mimeType);
  }
}

// ---------- Native Host 转码 ----------
function convertViaHost({ dataUrl, mimeType, title }) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NM_HOST);
    let settled = false;

    port.onMessage.addListener((m) => {
      switch (m.type) {
        case 'hello':
          console.log('[Suno Recorder] host hello, ffmpeg:', m.ffmpeg);
          break;
        case 'progress':
          setBadge('…', '#f59e0b');
          break;
        case 'done':
          settled = true;
          port.disconnect();
          setBadge('✓', '#10b981');
          notify(title || 'Suno 录制', 'MP3 已保存: ' + m.path);
          setTimeout(() => setBadge(''), 5000);
          resolve();
          break;
        case 'error':
          settled = true;
          port.disconnect();
          setBadge('!', '#dc2626');
          reject(new Error(m.message));
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || 'host 进程退出';
      if (!settled) reject(new Error(err));
    });

    port.postMessage({ type: 'convert', dataUrl, mimeType, title });
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

// ---------- UI 反馈 ----------
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
