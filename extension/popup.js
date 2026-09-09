// ===================================================================
// Suno Recorder — Popup UI
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
    ready = !!msg.ready;
    updateUI();
  } else if (msg.type === 'SUNO_REC_RESULT') {
    if (msg.cmd === 'start') {
      recording = !!msg.result?.ok;
      if (!recording && msg.result?.error) {
        $('#hint').textContent = '错误: ' + msg.result.error;
      }
    }
    if (msg.cmd === 'stop') recording = false;
    updateUI();
  }
});

// ---------- 发送命令 ----------
$('#toggle').addEventListener('click', () => {
  const cmd = recording ? 'stop' : 'start';
  $('#toggle').disabled = true;
  $('#toggle').textContent = '注入中…';
  chrome.runtime.sendMessage({ type: 'SUNO_REC_CMD', cmd });
  // 1 秒后自动恢复按钮（防卡死）
  setTimeout(() => { $('#toggle').disabled = false; updateUI(); }, 1500);
});

// ---------- UI ----------
function updateUI() {
  const btn = $('#toggle');
  const dot = $('#dot');
  const status = $('#status');
  const hint = $('#hint');

  if (!ready) {
    btn.disabled = false;
    btn.textContent = '开始录制';
    btn.className = 'primary';
    dot.className = 'dot';
    status.textContent = '点击开始自动注入';
    hint.textContent = '首次点击会注入录制脚本到页面。请确保在 suno.com 歌曲页面。';
    return;
  }

  btn.disabled = false;
  if (recording) {
    btn.textContent = '停止录制';
    btn.className = 'danger';
    dot.className = 'dot rec';
    status.textContent = '录制中…';
    hint.textContent = '点击停止后自动下载 webm 文件。';
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
