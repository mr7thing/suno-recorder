// ===================================================================
// Suno Recorder — 方案 B: 注入到 Play 旁，点击 = Play + 录制
// -------------------------------------------------------------------
// 点击录制按钮 → click Suno Play → MutationObserver 监听 audio.src
// → src 变 blob 的瞬间 captureStream + MediaRecorder.start()
// 从真实音频第一帧开始，零遗漏
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
    phase: 'idle',      // idle | waiting | recording | processing
    recorder: null,
    chunks: [],
    audio: null,
    srcObserver: null,
  };

  // ---------- 找 Suno 的 Play 按钮 ----------
  function findSunoPlayBtn() {
    const btns = Array.from(document.querySelectorAll('button'));
    // 优先 aria-label="Play"，兜底 textContent="Play"
    return btns.find(b => b.getAttribute('aria-label') === 'Play')
        || btns.find(b => b.textContent.trim() === 'Play')
        || null;
  }

  // ---------- 找主 audio（blob URL + 长时长） ----------
  function findMainAudio() {
    const audios = Array.from(document.querySelectorAll('audio'));
    return audios.find(a => a.src && a.src.startsWith('blob:') && a.duration > 10)
        || audios.find(a => a.src && a.src.startsWith('blob:'))
        || null;
  }

  // ---------- 提取歌名 ----------
  function songTitle() {
    const h1 = document.querySelector('h1');
    if (h1?.textContent?.trim()) return h1.textContent.trim();
    // 兜底: 页面标题去掉 "| Suno" 后缀
    return document.title.replace(/\s*\|\s*Suno.*$/i, '').trim();
  }

  // ---------- 提取元数据（歌名/歌词/作者/创作时间/模型版本） ----------
  function extractMetadata() {
    const title = songTitle();

    // 歌词：找含 [Verse]/[Chorus] 等标记的 p.whitespace-pre-wrap
    const lyrics = (() => {
      const ps = Array.from(document.querySelectorAll('p.whitespace-pre-wrap'));
      const p = ps.find(p => /\[(Verse|Chorus|Intro|Outro|Bridge|Prechorus|Hook|Interlude)\]/i.test(p.textContent));
      return p ? p.textContent.trim() : '';
    })();

    // 作者：h1 附近容器内的链接，排除导航词
    const artist = (() => {
      const h1 = document.querySelector('h1');
      if (!h1) return 'Suno';
      const container = h1.closest('div, section, article') || h1.parentElement;
      if (!container) return 'Suno';
      const navWords = /^(Home|Explore|Create|Studio|Library|Login|Log in|Labs|More|Earn Credits)$/i;
      const links = Array.from(container.querySelectorAll('a'));
      const authorLink = links.find(a => {
        const t = a.textContent.trim();
        return t && !navWords.test(t)
          && !a.href.includes('/song/') && !a.href.includes('/home');
      });
      return authorLink ? authorLink.textContent.trim() : 'Suno';
    })();

    // 创作时间：span[title] 匹配日期
    const createdAt = (() => {
      const spans = Array.from(document.querySelectorAll('span[title]'));
      const span = spans.find(s => /\d{4}年\d{1,2}月\d{1,2}日/.test(s.title));
      return span ? span.title.trim() : '';
    })();

    // 模型版本：span 文本匹配 V\d+
    const modelVersion = (() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const span = spans.find(s => /^V\d+$/.test(s.textContent.trim()));
      return span ? span.textContent.trim() : '';
    })();

    return { title, lyrics, artist, createdAt, modelVersion };
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

  // ==================================================================
  // 开始：点击 Suno Play + 监听 src 变化 + 精确录制
  // ==================================================================
  async function start() {
    // 如果已有 blob audio（用户已点过 Play），直接录
    const existing = findMainAudio();
    if (existing) {
      console.log('[Suno Recorder] audio 已存在，直接录制');
      return beginRecording(existing);
    }

    // 找 Suno Play 按钮
    const playBtn = findSunoPlayBtn();
    if (!playBtn) {
      setPhase('idle', '未找到 Suno Play 按钮，请确保在歌曲页面');
      return;
    }

    setPhase('waiting', '点击 Play 并等待音频加载…');
    console.log('[Suno Recorder] clicking Suno Play, waiting for blob src…');

    // 设置 src 监听器——等 audio.src 变 blob
    setupSrcWatcher((audio) => {
      console.log('[Suno Recorder] blob src detected, starting recorder');
      beginRecording(audio);
    });

    // 点击 Suno Play
    playBtn.click();
  }

  // ---------- 监听 audio.src 变 blob ----------
  function setupSrcWatcher(onBlobReady) {
    if (state.srcObserver) state.srcObserver.disconnect();

    // 用 MutationObserver 监听 audio 元素的 src 属性变化
    state.srcObserver = new MutationObserver((muts) => {
      for (const mut of muts) {
        if (mut.type === 'attributes' && mut.attributeName === 'src') {
          const audio = mut.target;
          if (audio.src && audio.src.startsWith('blob:') && audio.duration > 10) {
            cleanup();
            onBlobReady(audio);
            return;
          }
        }
      }
    });

    const cleanup = () => {
      state.srcObserver?.disconnect();
      state.srcObserver = null;
      bodyObserver.disconnect();
    };

    // 监听现有 audio 的 src 属性
    document.querySelectorAll('audio').forEach(a => {
      state.srcObserver.observe(a, { attributes: true, attributeFilter: ['src'] });
    });

    // 兜底: 监听新出现的 audio 元素（可能整个元素被替换）
    const bodyObserver = new MutationObserver(() => {
      const audio = findMainAudio();
      if (audio) { cleanup(); onBlobReady(audio); }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    // 10 秒超时
    setTimeout(() => {
      if (state.phase === 'waiting') {
        cleanup();
        setPhase('idle', '10秒内未检测到音频，请手动点 Play');
      }
    }, 10000);
  }

  // ---------- 真正开始录制 ----------
  function beginRecording(audio) {
    let stream;
    try {
      stream = audio.mozCaptureStream ? audio.mozCaptureStream() : audio.captureStream();
    } catch (e) {
      setPhase('idle', 'captureStream 失败: ' + e.message);
      return;
    }
    if (stream.getAudioTracks().length === 0) {
      setPhase('idle', '无音频轨道');
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
    // 确保 audio 在播放
    if (audio.paused) audio.play().catch(() => {});
    setPhase('recording');
    console.log('[Suno Recorder] recording started, mime:', mime);
  }

  // ---------- 停止 ----------
  function stop() {
    console.log('[CS-010] stop() 被调用，当前 phase:', state.phase);
    if (state.phase === 'waiting') {
      state.srcObserver?.disconnect();
      state.srcObserver = null;
      setPhase('idle', '已取消');
      return;
    }
    if (!state.recorder) {
      console.log('[CS-011] state.recorder 为空，无法停止');
      setPhase('idle', '无录制进行中');
      return;
    }
    if (state.phase !== 'recording') {
      console.log('[CS-012] phase 不是 recording，跳过 stop');
      return;
    }
    console.log('[CS-013] state.recorder.state:', state.recorder.state);
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
      console.log('[CS-001] 录制完成，blob size:', blob.size, 'dataUrl 长度:', dataUrl.length);
      const metadata = extractMetadata();
      const mime = state.recorder.mimeType || 'audio/webm;codecs=opus';
      console.log('[CS-002] 元数据:', JSON.stringify({
        title: metadata.title, artist: metadata.artist,
        modelVersion: metadata.modelVersion, lyricsLen: metadata.lyrics.length,
      }));
      setPhase('processing', '转码中…');
      state.recorder = null;
      chrome.runtime.sendMessage({
        type: 'SUNO_REC_DOWNLOAD',
        dataUrl,
        mimeType: mime,
        metadata,
      }, (resp) => {
        if (chrome.runtime.lastError) {
          console.error('[CS-004] sendMessage 失败:', chrome.runtime.lastError.message);
          console.error('[CS-005] background 未响应，降级直接下载 webm');
          downloadWebmFallback(dataUrl, mime, metadata.title);
          return;
        }
        console.log('[CS-006] background 确认收到:', JSON.stringify(resp));
      });
      console.log('[CS-003] 已发送 SUNO_REC_DOWNLOAD');
    };
    state.recorder.stop();
    if (state.audio && !state.audio.paused) state.audio.pause();
  }

  // 兜底：background 不可用时直接下载 webm
  function downloadWebmFallback(dataUrl, mime, title) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = mime.includes('webm') ? 'webm' : 'bin';
    const filename = `suno-recorder/${(title || 'suno-' + ts).replace(/[\\/:*?"<>|]/g, '_')}.${ext}`;
    chrome.downloads.download({ url: dataUrl, filename, saveAs: true }).then(() => {
      setPhase('idle', '已保存 webm（转码未运行）');
    }).catch((e) => {
      setPhase('idle', '下载失败: ' + e.message);
    });
  }

  // ---------- 接收 background 转码状态回传 ----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg?.type) return;
    switch (msg.type) {
      case 'SUNO_REC_PROGRESS':
        setPhase('processing', msg.message || '转码中…');
        break;
      case 'SUNO_REC_DONE':
        setPhase('idle', '✓ 已保存: ' + (msg.path || ''));
        break;
      case 'SUNO_REC_ERROR':
        setPhase('idle', '✗ ' + (msg.message || '转码失败'));
        break;
    }
  });

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
    #__suno_rec_btn.wait { background: #f59e0b; }
    #__suno_rec_btn.rec { background: #dc2626; animation: sr-pulse 1.5s infinite; }
    #__suno_rec_btn.proc { background: #6b7280; cursor: wait; }
    #__suno_rec_btn .sr-icon {
      display: inline-block; width: 14px; height: 14px; border-radius: 50%;
      background: #fff;
    }
    #__suno_rec_btn.rec .sr-icon { background: #fee2e2; }
    #__suno_rec_btn.wait .sr-icon { background: #fef3c7; animation: sr-spin 1s linear infinite; }
    @keyframes sr-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,.5); }
      50% { box-shadow: 0 0 0 12px rgba(220,38,38,0); }
    }
    @keyframes sr-spin { to { transform: rotate(360deg); } }
    #__suno_rec_tip {
      position: fixed; bottom: 76px; right: 24px; z-index: 2147483647;
      padding: 6px 12px; border-radius: 6px;
      font: 12px/1.4 system-ui; color: #fff;
      background: rgba(0,0,0,.75); max-width: 280px;
      opacity: 0; transition: opacity .3s; pointer-events: none;
    }
    #__suno_rec_tip.show { opacity: 1; }
  `;
  (document.head || document.documentElement).appendChild(style);

  const btn = document.createElement('div');
  btn.id = '__suno_rec_btn';
  btn.innerHTML = '<span class="sr-icon"></span><span class="sr-label">播放+录制</span>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    console.log('[CS-009] 按钮点击，phase:', state.phase);
    if (state.phase === 'idle') start();
    else if (state.phase === 'recording') stop();
    else if (state.phase === 'waiting') stop();
    // processing 状态忽略点击，防止误操作
  });

  const tip = document.createElement('div');
  tip.id = '__suno_rec_tip';

  function setPhase(phase, msg) {
    state.phase = phase;
    btn.className = phase === 'waiting' ? 'wait'
                   : phase === 'recording' ? 'rec'
                   : phase === 'processing' ? 'proc' : '';
    const label = btn.querySelector('.sr-label');
    if (!label) return;
    if (phase === 'idle') label.textContent = '播放+录制';
    if (phase === 'waiting') label.textContent = '取消';
    if (phase === 'recording') label.textContent = '停止录制';
    if (phase === 'processing') label.textContent = '转码中…';
    if (msg) {
      tip.textContent = msg;
      tip.classList.add('show');
      setTimeout(() => tip.classList.remove('show'), 3000);
    }
  }

  document.documentElement.appendChild(tip);
  document.documentElement.appendChild(btn);

  // MutationObserver 兜底：按钮被冲掉则重新加回
  const observer = new MutationObserver(() => {
    if (!document.getElementById('__suno_rec_btn')) {
      document.documentElement.appendChild(btn);
      document.documentElement.appendChild(tip);
    }
  });
  observer.observe(document.documentElement, { childList: true });

  console.log('[Suno Recorder] 方案 B 按钮已注入, audio count:',
    document.querySelectorAll('audio').length);
})();
