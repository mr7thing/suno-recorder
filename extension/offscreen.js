// ===================================================================
// Suno Recorder — Offscreen 转码器（ffmpeg.wasm）
// -------------------------------------------------------------------
// 全链路日志：每个阶段输出 [OS-xxx] 标记，便于定位卡点
// ===================================================================

console.log('[OS-001] offscreen.js 开始加载');
console.log('[OS-002] FFmpegWASM 类型:', typeof FFmpegWASM,
  FFmpegWASM ? 'keys=' + Object.keys(FFmpegWASM).join(',') : 'undefined');

const { FFmpeg } = FFmpegWASM;
const ffmpeg = new FFmpeg();
let loaded = false;
let loading = null;

// ---------- 加载 ffmpeg-core ----------
function ensureLoaded() {
  if (loaded) { console.log('[OS-100] ffmpeg 已加载，跳过'); return Promise.resolve(); }
  if (loading) { console.log('[OS-101] ffmpeg 加载中，等待'); return loading; }
  loading = (async () => {
    const base = chrome.runtime.getURL('vendor/');
    console.log('[OS-102] ffmpeg.load 开始');
    console.log('[OS-103] coreURL:', base + 'ffmpeg-core.js');
    console.log('[OS-104] wasmURL:', base + 'ffmpeg-core.wasm');
    const t0 = performance.now();
    ffmpeg.on('progress', ({ progress }) => {
      console.log('[OS-105] ffmpeg progress:', (progress * 100).toFixed(1) + '%');
      chrome.runtime.sendMessage({ type: 'SUNO_OFFSCREEN_PROGRESS', progress }).catch(() => {});
    });
    ffmpeg.on('log', ({ message }) => {
      console.log('[OS-106] ffmpeg log:', message);
    });
    try {
      await ffmpeg.load({
        coreURL: base + 'ffmpeg-core.js',
        wasmURL: base + 'ffmpeg-core.wasm',
      });
      loaded = true;
      console.log('[OS-107] ffmpeg.load 完成，耗时', ((performance.now() - t0) / 1000).toFixed(2) + 's');
    } catch (e) {
      console.error('[OS-108] ffmpeg.load 失败:', e.message, e.stack);
      throw e;
    }
  })();
  return loading;
}

// ---------- 元数据 → ffmpeg -metadata ----------
function metadataArgs(meta = {}) {
  const args = [];
  if (meta.title) args.push('-metadata', `title=${meta.title}`);
  if (meta.artist) args.push('-metadata', `artist=${meta.artist}`);
  args.push('-metadata', 'album=Suno');
  const date = parseDate(meta.createdAt);
  if (date) args.push('-metadata', `date=${date}`);
  args.push('-metadata', 'genre=AI Generated');
  if (meta.lyrics) args.push('-metadata', `lyrics=${meta.lyrics}`);
  if (meta.modelVersion) args.push('-metadata', `TXXX:Suno-Version=${meta.modelVersion}`);
  return args;
}

function parseDate(s) {
  if (!s) return '';
  const m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return '';
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// ---------- base64 dataUrl → Uint8Array ----------
function dataUrlToUint8(dataUrl) {
  const t0 = performance.now();
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  console.log('[OS-200] dataUrl 长度:', dataUrl.length, 'base64 长度:', b64.length);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  console.log('[OS-201] Uint8Array 生成完成，大小:', bytes.length, 'bytes，耗时',
    ((performance.now() - t0) / 1000).toFixed(2) + 's');
  return bytes;
}

// ---------- Uint8Array → base64 ----------
function uint8ToBase64(bytes) {
  const t0 = performance.now();
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(bin);
  console.log('[OS-202] base64 编码完成，输出长度:', b64.length, '耗时',
    ((performance.now() - t0) / 1000).toFixed(2) + 's');
  return b64;
}

// ---------- 转码主流程 ----------
async function transcode({ dataUrl, metadata }) {
  console.log('[OS-300] transcode 开始，metadata:', JSON.stringify({
    title: metadata?.title, artist: metadata?.artist,
    modelVersion: metadata?.modelVersion, lyricsLen: metadata?.lyrics?.length,
  }));

  await ensureLoaded();

  const webmBytes = dataUrlToUint8(dataUrl);

  console.log('[OS-301] writeFile input.webm 开始');
  const t1 = performance.now();
  await ffmpeg.writeFile('input.webm', webmBytes);
  console.log('[OS-302] writeFile 完成，耗时', ((performance.now() - t1) / 1000).toFixed(2) + 's');

  const args = [
    '-y', '-i', 'input.webm',
    '-c:a', 'libmp3lame', '-b:a', '320k',
    '-id3v2_version', '3',
    ...metadataArgs(metadata),
    'output.mp3',
  ];
  console.log('[OS-303] ffmpeg.exec args:', JSON.stringify(args));

  const t2 = performance.now();
  await ffmpeg.exec(args);
  console.log('[OS-304] ffmpeg.exec 完成，耗时', ((performance.now() - t2) / 1000).toFixed(2) + 's');

  console.log('[OS-305] readFile output.mp3 开始');
  const mp3Bytes = await ffmpeg.readFile('output.mp3');
  console.log('[OS-306] readFile 完成，MP3 大小:', mp3Bytes.length, 'bytes');

  const mp3DataUrl = 'data:audio/mpeg;base64,' + uint8ToBase64(mp3Bytes);

  console.log('[OS-307] 清理临时文件');
  await ffmpeg.deleteFile('input.webm');
  await ffmpeg.deleteFile('output.mp3');

  console.log('[OS-308] transcode 完成');
  return mp3DataUrl;
}

// ---------- 监听 background 消息 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[OS-400] 收到消息，type:', msg?.type);
  if (msg?.type !== 'SUNO_OFFSCREEN_TRANSCODE') return false;
  transcode(msg)
    .then((mp3DataUrl) => {
      console.log('[OS-401] 转码成功，回传 dataUrl 长度:', mp3DataUrl.length);
      sendResponse({ ok: true, dataUrl: mp3DataUrl });
    })
    .catch((e) => {
      console.error('[OS-402] 转码失败:', e.message, e.stack);
      sendResponse({ ok: false, error: e.message });
    });
  return true; // 异步响应
});

console.log('[OS-999] offscreen.js 加载完成，消息监听器已注册');
