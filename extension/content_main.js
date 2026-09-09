// ===================================================================
// Suno Recorder — Page-context hook (MAIN world)
// -------------------------------------------------------------------
// 按需注入：background.js 通过 chrome.scripting.executeScript 调入
// 直接 captureStream(audioElement) → MediaRecorder → data URL
// ===================================================================

(() => {
  'use strict';

  // ---------- 注入守卫 ----------
  if (window.__sunoRecorder) return;

  const state = { recorder: null, chunks: [], recording: false };

  // ---------- 找主 audio 元素（blob URL + 长时长） ----------
  function findMainAudio() {
    const audios = Array.from(document.querySelectorAll('audio'));
    return audios.find(a => a.src && a.src.startsWith('blob:') && a.duration > 10)
        || audios.find(a => a.src && a.src.startsWith('blob:'))
        || null;
  }

  // ---------- 开始录制 ----------
  async function start() {
    if (state.recording) return { ok: false, error: 'already-recording' };

    const main = findMainAudio();
    if (!main) return { ok: false, error: 'no-audio-element' };

    let stream;
    try {
      stream = main.mozCaptureStream ? main.mozCaptureStream() : main.captureStream();
    } catch (e) {
      return { ok: false, error: 'capture-failed: ' + e.message };
    }

    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) return { ok: false, error: 'no-audio-tracks' };

    const mime = pickMime();
    state.chunks = [];
    state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    state.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.chunks.push(e.data);
    };
    state.recorder.start(1000);
    state.recording = true;

    console.log('[Suno Recorder] recording started, mime:', mime,
      'tracks:', tracks.length, 'audioPaused:', main.paused);
    return { ok: true, mime };
  }

  // ---------- 停止录制 ----------
  function stop() {
    if (!state.recording || !state.recorder) return { ok: false, error: 'not-recording' };

    return new Promise((resolve) => {
      state.recorder.onstop = async () => {
        const blob = new Blob(state.chunks, { type: state.recorder.mimeType });
        console.log('[Suno Recorder] recording stopped, chunks:', state.chunks.length,
          'size:', blob.size);
        const dataUrl = await blobToDataURL(blob);
        postToIso({ type: 'SUNO_REC_BLOB', dataUrl, mimeType: state.recorder.mimeType });
        state.recording = false;
        state.recorder = null;
        resolve({ ok: true, size: blob.size });
      };
      state.recorder.stop();
    });
  }

  // ---------- 状态 ----------
  function status() {
    return {
      recording: state.recording,
      hasAudio: !!findMainAudio(),
    };
  }

  // ---------- 工具 ----------
  function pickMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    return candidates.find(m => {
      try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
    }) || '';
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function postToIso(payload) {
    window.postMessage(payload, '*');
  }

  // ---------- 暴露 API + 消息监听 ----------
  window.__sunoRecorder = { start, stop, status };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const { type, cmd } = e.data || {};
    if (type !== 'SUNO_REC_CMD') return;
    const handler = { start, stop, status }[cmd];
    if (!handler) return;
    Promise.resolve(handler()).then((result) => {
      postToIso({ type: 'SUNO_REC_RESULT', cmd, result });
    });
  });

  postToIso({ type: 'SUNO_REC_READY' });
  console.log('[Suno Recorder] MAIN world hook ready');
})();
