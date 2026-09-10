// ===================================================================
// smoke-test.js — 独立测试 host.js 转码链路（不入扩展）
// 用后即删。流程: ffmpeg 生成正弦 webm → 帧封装 → 管道进 host.js
// ===================================================================

'use strict';
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TMP = __dirname;
const testWebm = path.join(TMP, 'test-input.webm');

// 1. 生成 2 秒正弦波 webm
const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-c:a', 'libopus', testWebm], { stdio: 'ignore' });
if (r.status !== 0) { console.error('FAIL: 生成测试 webm 失败'); process.exit(1); }
console.log('[1] 测试 webm 已生成:', fs.statSync(testWebm).size, 'bytes');

// 2. 帧封装: 4字节LE长度 + JSON（含完整 metadata）
const b64 = fs.readFileSync(testWebm).toString('base64');
const metadata = {
  title: 'Half Fire, Half Divine',
  artist: 'Uncle7',
  lyrics: '[Verse 1]\nMorning mist pushes the wooden frame\n[Chorus]\nHalf city warms with hearth and stew',
  createdAt: '2026年9月9日 22:51',
  modelVersion: 'V6',
};
const msg = Buffer.from(JSON.stringify({
  type: 'convert',
  dataUrl: 'data:audio/webm;base64,' + b64,
  mimeType: 'audio/webm;codecs=opus',
  metadata,
}), 'utf8');
const len = Buffer.alloc(4);
len.writeUInt32LE(msg.length, 0);

// 3. 管道进 host.js（输出到本目录，规避测试沙箱对 Downloads 的限制）
const host = spawn('node', [path.join(TMP, 'host.js')], {
  env: { ...process.env, SUNO_OUT_DIR: TMP },
});
let out = Buffer.alloc(0);
host.stdout.on('data', (c) => { out = Buffer.concat([out, c]); });
let errLog = '';
host.stderr.on('data', (c) => { errLog += c; });
host.on('close', (code) => {
  console.log('[2] host 退出码:', code, 'stdout 原始长度:', out.length);
  // 解析所有回包
  let buf = out, messages = [];
  while (buf.length >= 4) {
    const l = buf.readUInt32LE(0);
    if (buf.length < 4 + l) break;
    messages.push(JSON.parse(buf.slice(4, 4 + l).toString('utf8')));
    buf = buf.slice(4 + l);
  }
  console.log('[2] host 回包:', JSON.stringify(messages, null, 2));
  const done = messages.find(m => m.type === 'done');
  if (done && fs.existsSync(done.path) && fs.statSync(done.path).size > 1000) {
    // 验证是合法 mp3 + ID3 标签
    const probe = spawnSync('ffprobe', ['-v', 'error',
      '-show_entries', 'format=format_name,duration',
      '-show_entries', 'format_tags=title,artist,album,date,genre,lyrics',
      '-of', 'default=nw=1', done.path]);
    const tags = probe.stdout.toString().trim();
    console.log('[3] MP3 格式与标签:\n' + tags);

    // 断言关键字段存在
    const checks = {
      title: /title=Half Fire, Half Divine/.test(tags),
      artist: /artist=Uncle7/.test(tags),
      album: /album=Suno/.test(tags),
      date: /date=2026-09-09/.test(tags),
      genre: /genre=AI Generated/.test(tags),
      lyrics: /lyrics=\[Verse 1\]/.test(tags),
    };
    const allPass = Object.values(checks).every(Boolean);
    console.log('[4] 标签断言:', JSON.stringify(checks, null, 2));

    // 文件名应来自 title
    const fname = path.basename(done.path);
    const nameOk = fname.startsWith('Half Fire, Half Divine');
    console.log('[5] 文件名:', fname, nameOk ? '✓' : '✗');

    if (allPass && nameOk) {
      console.log('PASS ✓');
      fs.unlinkSync(testWebm);
      fs.unlinkSync(done.path);
      process.exit(0);
    } else {
      console.error('FAIL ✗ 标签断言未全部通过');
      process.exit(1);
    }
  } else {
    console.error('FAIL ✗ stderr:', errLog.slice(-500));
    process.exit(1);
  }
});

host.stdin.write(Buffer.concat([len, msg]));
host.stdin.end();
