// 最小复现：stdin EOF 后 spawn ffmpeg，事件循环是否挂得住
const { spawn } = require('child_process');

process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.error('[host] stdin end, spawning ffmpeg');
  const ff = spawn('C:\\workapp\\ffmpeg\\bin\\ffmpeg.exe',
    ['-y', '-i', 'test-input.webm', '-c:a', 'libmp3lame', 'test-repro.mp3'],
    { windowsHide: true });
  ff.on('error', (e) => console.error('[host] child ERROR', e.message));
  ff.on('exit', (c) => console.error('[host] child EXIT', c));
  ff.on('close', (c) => { console.error('[host] child CLOSE', c); process.exit(0); });
});
