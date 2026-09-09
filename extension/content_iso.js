// ===================================================================
// Suno Recorder — Page UI + Recorder
// -------------------------------------------------------------------
// 自动注入（content_scripts document_idle）
// + 兜底注入（action.onClicked → scripting.executeScript）
// 按钮挂到 documentElement，不被 React 重渲染冲掉
// ===================================================================

(() => {
  'use strict';
  if (window.__sunoRecorderBtn) {
    console.log('[Suno Recorder] 已注入，跳过');
    return;
  }
  window.__sunoRecorderBtn = true;

  // ---------- 状态 ----------
  const state = {
    phase: 'idle',
    recorder: null,
    chunks: [],
    audio: null,
  };

  // ---------- 找主 audio ----------
  function findMainAudio() {
    const audios = Array.from(document.querySelectorAll('audio'));
    return audios.find(a => a.src && a.src.startsWith('blob:') && a.duration > 10)
        || audios.find(a => a.src && a.src.startsWith('blob:'))
        || null;
  }

  function pickMime() {
    const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    return c.find(m => {
      try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
    }) || '';
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // ---------- 开始 ----------
  async function start() {
    const audio = findMainAudio();
    if (!audio) { setPhase('idle', '未找到音频元素，请先点 Suno 的 Play 按钮'); return; }

    let stream;
    try {
      stream = audio.mozCaptureStream ? audio.mozCaptureStream() : audio.captureStream();
    } catch (e) {
      setPhase('idle', 'captureStream 失败: ' + e.message);
      return;
    }
    if (stream.getAudioTracks().length === 0) {
      setPhase('idle', '无音频轨道，请先播放');
      return;
    }

    state.audio = audio;
    state.chunks = [];
    const mime = pickMime();
    state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    state.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.chunks.push(e.data);
    };
    state.recorder.start(1000);
    if (audio.paused) audio.play().catch(() => {});
    setPhase('recording');
    console.log('[Suno Recorder] recording started, mime:', mime);
  }

  // ---------- 停止 ----------
  function stop() {
    if (!state.recorder) return;
    setPhase('processing');

    state.recorder.onstop = async () => {
      const blob = new Blob(state.chunks, { type: state.recorder.mimeType });
      console.log('[Suno Recorder] stopped, chunks:', state.chunks.length, 'size:', blob.size);
      if (blob.size === 0) {
        setPhase('idle', '录到 0 字节，可能音频未播放');
        state.recorder = null;
        return;
      }
      const dataUrl = await blobToDataURL(blob);
      chrome.runtime.sendMessage({
        type: 'SUNO_REC_DOWNLOAD',
        dataUrl,
        mimeType: state.recorder.mimeType,
      });
      setPhase('idle', '已下载 ' + (blob.size / 1024).toFixed(0) + ' KB');
      state.recorder = null;
    };
    state.recorder.stop();
    if (state.audio && !state.audio.paused) state.audio.pause();
  }

  // ==================================================================
  // 注入 UI
  // ==================================================================
  const style = document.createElement('style');
  style.textContent = `
    #__suno_rec_btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
      display: flex; align-items: center; gap: 8px;
      padding: 12px 20px; border-radius: 999px;
      font: 600 14px/1 system-ui, -apple-system, sans-serif;
      cursor: pointer; user-select: none;
      box-shadow: 0 4px 20px rgba(0,0,0,.3);
      transition: all .2s; color: #fff;
      background: #4f46e5;
    }
    #__suno_rec_btn:hover { transform: scale(1.05); }
    #__suno_rec_btn.rec { background: #dc2626; animation: sr-pulse 1.5s infinite; }
    #__suno_rec_btn.proc { background: #6b7280; cursor: wait; }
    #__suno_rec_btn .sr-icon {
      display: inline-block; width: 14px; height: 14px; border-radius: 50%;
      background: #fff;
    }
    #__suno_rec_btn.rec .sr-icon { background: #fee2e2; }
    @keyframes sr-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,.5); }
      50% { box-shadow: 0 0 0 12px rgba(220,38,38,0); }
    }
    #__suno_rec_tip {
      position: fixed; bottom: 76px; right: 24px; z-index: 2147483647;
      padding: 6px 12px; border-radius: 6px;
      font: 12px/1.4 system-ui; color: #fff;
      background: rgba(0,0,0,.75); max-width: 280px;
      opacity: 0; transition: opacity .3s; pointer-events: none;
    }
    #__suno_rec_tip.show { opacity: 1; }
  `;
  // style 加到 head，不存在则加到 documentElement
  (document.head || document.documentElement).appendChild(style);

  const btn = document.createElement('div');
  btn.id = '__suno_rec_btn';
  btn.innerHTML = '<span class="sr-icon"></span><span class="sr-label">播放+录制</span>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (state.phase === 'idle') start();
    else if (state.phase === 'recording') stop();
  });

  const tip = document.createElement('div');
  tip.id = '__suno_rec_tip';

  function setPhase(phase, msg) {
    state.phase = phase;
    btn.className = phase === 'recording' ? 'rec'
                   : phase === 'processing' ? 'proc' : '';
    const label = btn.querySelector('.sr-label');
    if (!label) return;
    if (phase === 'idle') label.textContent = '播放+录制';
    if (phase === 'recording') label.textContent = '停止录制';
    if (phase === 'processing') label.textContent = '处理中…';
    if (msg) {
      tip.textContent = msg;
      tip.classList.add('show');
      setTimeout(() => tip.classList.remove('show'), 3000);
    }
  }

  // 按钮加到 documentElement（html 元素），不被 React body 重渲染冲掉
  document.documentElement.appendChild(tip);
  document.documentElement.appendChild(btn);

  // MutationObserver 兜底：如果按钮被冲掉，重新加回
  const observer = new MutationObserver(() => {
    if (!document.getElementById('__suno_rec_btn')) {
      document.documentElement.appendChild(btn);
      document.documentElement.appendChild(tip);
    }
  });
  observer.observe(document.documentElement, { childList: true });

  console.log('[Suno Recorder] 浮动按钮已注入, audio count:',
    document.querySelectorAll('audio').length);
})();
