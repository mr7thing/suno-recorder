// ===================================================================
// Suno Recorder — Page-context hook (MAIN world)
// -------------------------------------------------------------------
// 双 hook 策略：HTMLMediaElement + AudioContext
// 所有音频流最终汇入单一 MediaStreamAudioDestinationNode
// 录制通过 MediaRecorder 产出 webm/opus blob，转 data URL 给 ISOLATED
// ===================================================================

(() => {
  'use strict';

  // ---------- 单一真相源 ----------
  const state = {
    streams: new Set(),   // 所有捕获到的 MediaStream
    recorder: null,
    chunks: [],
    recording: false,
  };

  // ==================================================================
  // Hook 1: HTMLMediaElement
  // 在 audio/video 元素触发 play 时自动捕获其 stream
  // ==================================================================
  const observeMedia = (media) => {
    if (media.__sunoMarked) return;
    media.__sunoMarked = true;
    media.addEventListener('play', () => {
      try {
        const stream = media.mozCaptureStream
          ? media.mozCaptureStream()
          : media.captureStream();
        registerStream(stream, 'media');
      } catch (_) {
        // captureStream 可能因 CORS 失败，AudioContext hook 会兜底
      }
    });
  };

  const scanAllMedia = () =>
    document.querySelectorAll('audio, video').forEach(observeMedia);

  scanAllMedia();
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.tagName === 'AUDIO' || n.tagName === 'VIDEO') observeMedia(n);
        if (n.querySelectorAll) {
          n.querySelectorAll('audio, video').forEach(observeMedia);
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ==================================================================
  // Hook 2: AudioContext constructor (via Proxy, 保留原型链)
  // 每个新 ctx 挂载一个 __sunoDest (MediaStreamAudioDestinationNode)
  // ==================================================================
  const wrapContext = (Orig) => {
    if (!Orig) return Orig;
    return new Proxy(Orig, {
      construct(target, args, newTarget) {
        const ctx = Reflect.construct(target, args, newTarget);
        try {
          const dest = ctx.createMediaStreamDestination();
          ctx.__sunoDest = dest;
          registerStream(dest.stream, 'audioctx');
        } catch (_) {
          // OfflineAudioContext 等不需要录音的上下文
        }
        return ctx;
      },
    });
  };

  if (window.AudioContext) {
    window.AudioContext = wrapContext(window.AudioContext);
  }
  if (window.webkitAudioContext) {
    window.webkitAudioContext = wrapContext(window.webkitAudioContext);
  }

  // 劫持 AudioNode.prototype.connect：
  // 任何 source 连到 ctx.destination 时，同时分流到 ctx.__sunoDest
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...args) {
    const result = origConnect.apply(this, [target, ...args]);
    if (target &&
        target.context &&
        target.context.__sunoDest &&
        target === target.context.destination) {
      try {
        origConnect.apply(this, [target.context.__sunoDest, ...args]);
      } catch (_) { /* 已连接则跳过 */ }
    }
    return result;
  };

  // ==================================================================
  // 注册 stream + 状态广播
  // ==================================================================
  function registerStream(stream, source) {
    if (!stream || state.streams.has(stream)) return;
    state.streams.add(stream);
    postToIso({ type: 'SUNO_REC_STREAM', source });
  }

  // ==================================================================
  // 录制控制
  // ==================================================================
  async function start() {
    if (state.recording) return { ok: false, error: 'already-recording' };
    if (state.streams.size === 0) return { ok: false, error: 'no-stream' };

    const tracks = [...state.streams].flatMap((s) => s.getAudioTracks());
    if (tracks.length === 0) return { ok: false, error: 'no-audio-tracks' };

    state.chunks = [];
    const mixed = new MediaStream(tracks);
    const mime = pickMime();
    state.recorder = new MediaRecorder(mixed, mime ? { mimeType: mime } : {});
    state.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) state.chunks.push(e.data);
    };
    state.recorder.start(1000); // 1s 一个分片，保证中断也能存
    state.recording = true;
    return { ok: true, mime };
  }

  function stop() {
    if (!state.recording || !state.recorder) return { ok: false };
    return new Promise((resolve) => {
      state.recorder.onstop = async () => {
        const blob = new Blob(state.chunks, { type: state.recorder.mimeType });
        const dataUrl = await blobToDataURL(blob);
        postToIso({
          type: 'SUNO_REC_BLOB',
          dataUrl,
          mimeType: state.recorder.mimeType,
        });
        state.recording = false;
        state.recorder = null;
        resolve({ ok: true, size: blob.size });
      };
      state.recorder.stop();
    });
  }

  function status() {
    return {
      recording: state.recording,
      streamCount: state.streams.size,
    };
  }

  function pickMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ==================================================================
  // ISOLATED <-> MAIN 通信
  // ==================================================================
  function postToIso(payload) {
    window.postMessage(payload, '*');
  }

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

  // 通知 ISOLATED：MAIN world 已就绪
  postToIso({ type: 'SUNO_REC_READY' });
})();
