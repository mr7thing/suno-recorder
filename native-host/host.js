// ===================================================================
// Suno Recorder — Native Messaging Host (Node.js)
// -------------------------------------------------------------------
// stdin 读取长度前缀 JSON → 解码 base64 webm → FFmpeg 转 MP3
// stdout 回写长度前缀 JSON（进度/完成/错误）
// 协议: 4 字节 native-order 长度 + UTF-8 JSON
// ===================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ---------- FFmpeg 定位 ----------
const FFMPEG_CANDIDATES = [
  'C:\\workapp\\ffmpeg\\bin\\ffmpeg.exe',
  'ffmpeg.exe', // PATH
];
function findFfmpeg() {
  for (const p of FFMPEG_CANDIDATES) {
    try {
      fs.accessSync(p.startsWith('C:') ? p : p);
      if (p.includes('\\')) return p;
    } catch { /* next */ }
  }
  return 'ffmpeg.exe';
}
const FFMPEG = findFfmpeg();

// ---------- 输出目录（SUNO_OUT_DIR 供测试覆盖） ----------
const OUT_DIR = process.env.SUNO_OUT_DIR
  || path.join(os.homedir(), 'Downloads', 'suno-recorder');

// ==================================================================
// Native Messaging 协议
// ==================================================================
// 关键: process.exit() 会截断未 flush 的管道写入。
// 跟踪 pendingWrites，写入回调完成后才允许退出。
let pendingWrites = 0;

function sendMessage(msg) {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  pendingWrites++;
  process.stdout.write(Buffer.concat([len, json]), () => {
    pendingWrites--;
    maybeExit();
  });
}

function readMessages(onMessage) {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const json = buf.slice(4, 4 + len).toString('utf8');
      buf = buf.slice(4 + len);
      try { onMessage(JSON.parse(json)); }
      catch (e) { sendMessage({ type: 'error', message: 'bad JSON: ' + e.message }); }
    }
  });
  // end 处理交给入口的 maybeExit（等待任务与写入完成）
}

// ==================================================================
// 转换流程: dataUrl → temp.webm → ffmpeg → OUT_DIR/xxx.mp3
// ==================================================================
async function convert({ dataUrl, mimeType, metadata = {} }) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const webmBuf = Buffer.from(b64, 'base64');
  if (webmBuf.length === 0) throw new Error('empty audio payload');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const name = sanitize(metadata.title) || timestamp();
  const outPath = uniquePath(path.join(OUT_DIR, name + '.mp3'));
  const tmpWebm = path.join(os.tmpdir(), 'suno-rec-' + Date.now() + '.webm');

  fs.writeFileSync(tmpWebm, webmBuf);
  sendMessage({ type: 'progress', message: `转码中 ${fmtMB(webmBuf.length)}…` });

  await runFfmpeg(tmpWebm, outPath, metadata);
  fs.unlinkSync(tmpWebm);

  sendMessage({ type: 'done', path: outPath, size: fs.statSync(outPath).size });
}

function runFfmpeg(input, output, meta) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', input,
      '-c:a', 'libmp3lame', '-b:a', '320k',
      '-id3v2_version', '3',
    ];

    // 标准 ID3 帧
    if (meta.title) args.push('-metadata', `title=${meta.title}`);
    if (meta.artist) args.push('-metadata', `artist=${meta.artist}`);
    args.push('-metadata', 'album=Suno');
    const date = parseDate(meta.createdAt);
    if (date) args.push('-metadata', `date=${date}`);
    args.push('-metadata', 'genre=AI Generated');
    if (meta.lyrics) args.push('-metadata', `lyrics=${meta.lyrics}`);

    // 自定义 TXXX 帧：Suno 模型版本
    if (meta.modelVersion) {
      args.push('-metadata', `TXXX:Suno-Version=${meta.modelVersion}`);
    }

    args.push(output);

    const ff = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', (e) => reject(new Error('ffmpeg 启动失败: ' + e.message)));

    // FFmpeg 超时保护：120s 未完成则 kill
    const killer = setTimeout(() => {
      try { ff.kill('SIGKILL'); } catch {}
      reject(new Error('ffmpeg 超时（120s）'));
    }, 120000);

    ff.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-400)}`));
    });
  });
}

// "2026年9月9日 22:51" → "2026-09-09"
function parseDate(s) {
  if (!s) return '';
  const m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return '';
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// ---------- 工具 ----------
function sanitize(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext);
  for (let i = 2; ; i++) {
    const cand = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
}

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

// ---------- 入口 ----------
// 退出三条件：stdin 关闭 + 任务清零 + 写入全部 flush
let stdinEnded = false;
let jobs = 0;
let session = null; // 分片传输会话 { metadata, mimeType, chunks }

function maybeExit() {
  if (stdinEnded && jobs === 0 && pendingWrites === 0) process.exit(0);
}

process.stdin.on('end', () => { stdinEnded = true; maybeExit(); });

readMessages((msg) => {
  switch (msg?.type) {
    case 'convert_start':
      session = { metadata: msg.metadata || {}, mimeType: msg.mimeType, chunks: [] };
      sendMessage({ type: 'chunk_ack' });
      break;

    case 'chunk':
      if (session) {
        session.chunks.push(msg.data);
        sendMessage({ type: 'chunk_ack', seq: msg.seq });
      }
      break;

    case 'convert_end':
      if (session) {
        const dataUrl = session.chunks.join('');
        const metadata = session.metadata;
        session = null;
        jobs++;
        convert({ dataUrl, metadata })
          .catch((e) => sendMessage({ type: 'error', message: e.message }))
          .finally(() => { jobs--; maybeExit(); });
      }
      break;

    case 'convert':
      // 兼容旧协议：单条消息直接转码
      jobs++;
      convert(msg)
        .catch((e) => sendMessage({ type: 'error', message: e.message }))
        .finally(() => { jobs--; maybeExit(); });
      break;
  }
});

sendMessage({ type: 'hello', ffmpeg: FFMPEG, outDir: OUT_DIR });
