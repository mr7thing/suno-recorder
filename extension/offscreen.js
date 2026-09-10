// ===================================================================
// Suno Recorder — Offscreen 转码器（ffmpeg.wasm）
// -------------------------------------------------------------------
// 在扩展自有上下文运行 ffmpeg.wasm，规避页面 CSP 对 Worker 的限制。
// 协议: background → offscreen (transcode) → done/error
// ===================================================================

const { FFmpeg } = FFmpegWASM;

const ffmpeg = new FFmpeg();
let loaded = false;
let loading = null;

// 加载 ffmpeg-core（懒加载，首次转码时触发）
function ensureLoaded() {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    const base = chrome.runtime.getURL('vendor/');
    ffmpeg.on('progress', ({ progress }) => {
      chrome.runtime.sendMessage({ type: 'SUNO_OFFSCREEN_PROGRESS', progress });
    });
    await ffmpeg.load({
      coreURL: base + 'ffmpeg-core.js',
      wasmURL: base + 'ffmpeg-core.wasm',
    });
    loaded = true;
  })();
  return loading;
}

// 元数据 → ffmpeg -metadata 参数
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

// base64 dataUrl → Uint8Array
function dataUrlToUint8(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Uint8Array → base64
function uint8ToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function transcode({ dataUrl, metadata }) {
  await ensureLoaded();

  const webmBytes = dataUrlToUint8(dataUrl);
  await ffmpeg.writeFile('input.webm', webmBytes);

  const args = [
    '-y', '-i', 'input.webm',
    '-c:a', 'libmp3lame', '-b:a', '320k',
    '-id3v2_version', '3',
    ...metadataArgs(metadata),
    'output.mp3',
  ];

  await ffmpeg.exec(args);

  const mp3Bytes = await ffmpeg.readFile('output.mp3');
  const mp3DataUrl = 'data:audio/mpeg;base64,' + uint8ToBase64(mp3Bytes);

  // 清理
  await ffmpeg.deleteFile('input.webm');
  await ffmpeg.deleteFile('output.mp3');

  return mp3DataUrl;
}

// 监听 background 消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'SUNO_OFFSCREEN_TRANSCODE') return false;
  transcode(msg)
    .then((mp3DataUrl) => sendResponse({ ok: true, dataUrl: mp3DataUrl }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // 异步响应
});

console.log('[Suno Recorder] offscreen ready');
