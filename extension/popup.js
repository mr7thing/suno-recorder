// ===================================================================
// Suno Recorder — Popup UI
// -------------------------------------------------------------------
// 命令发送 + 状态接收，不直接做录制
// ===================================================================

const $ = (sel) => document.querySelector(sel);

let recording = false;
let ready = false;

// ---------- 接收状态 ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.type) return;
  if (msg.type === 'SUNO_REC_READY') {
    ready = true;
    updateUI();
  } else if (msg.type === 'SUNO_REC_STATE') {
    recording = !!msg.recording;
    ready = true;
    updateUI();
  } else if (msg.type === 'SUNO_REC_RESULT') {
    if (msg.cmd === 'start') recording = !!msg.result?.ok;
    if (msg.cmd === 'stop') recording = false;
    updateUI();
  }
});

// ---------- 发送命令 ----------
$('#toggle').addEventListener('click', () => {
  const cmd = recording ? 'stop' : 'start';
  chrome.runtime.sendMessage({ type: 'SUNO_REC_CMD', cmd });
});

// ---------- UI 渲染 ----------
function updateUI() {
  const btn = $('#toggle');
  const dot = $('#dot');
  const status = $('#status');
  const hint = $('#hint');

  if (!ready) {
    btn.disabled = true;
    btn.textContent = '开始录制';
    btn.className = 'primary';
    dot.className = 'dot';
    status.textContent = '未在 Suno 页面';
    hint.textContent = '请在 suno.com 歌曲页面打开本扩展。';
    return;
  }

  btn.disabled = false;
  if (recording) {
    btn.textContent = '停止录制';
    btn.className = 'danger';
    dot.className = 'dot rec';
    status.textContent = '录制中…';
    hint.textContent = '点击停止后会自动下载 webm 文件。';
  } else {
    btn.textContent = '开始录制';
    btn.className = 'primary';
    dot.className = 'dot live';
    status.textContent = '就绪';
    hint.textContent = '在 Suno 页面播放歌曲后点击开始。';
  }
}

// ---------- 初始拉取状态 ----------
chrome.runtime.sendMessage({ type: 'SUNO_REC_GET_STATE' }, (resp) => {
  if (chrome.runtime.lastError || !resp) return;
  recording = !!resp.recording;
  ready = !!resp.ready;
  updateUI();
});

updateUI();
