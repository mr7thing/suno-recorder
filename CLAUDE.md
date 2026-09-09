# Suno Recorder — 架构镜像

## 设计哲学
**截获而非重采样**——直接 hook Web Audio / MediaElement API 拿到数字音频流，
避免麦克风录制造成的 D/A→A/D 双重损失。工程上的诚实：数字世界的问题用数字方案。

## Phase 1: MVP 架构 (v0.2+)

```
extension/
├── manifest.json      # MV3 入口，permissions + host_permissions（无 content_scripts）
├── content_main.js    # MAIN world: 直接 captureStream + MediaRecorder
├── content_iso.js     # ISOLATED world: 消息桥接
├── background.js      # service worker: 按需注入 + 状态协调 + 下载
├── popup.html         # UI: 开始/停止/状态指示
└── popup.js           # UI 逻辑
```

## 数据流（单向，无循环依赖）

```
[popup.js] ──SUNO_REC_CMD──→ [background.js]
                                 │
                          ensureInjected(tabId)
                          ├─ executeScript(content_iso.js, ISOLATED)
                          └─ executeScript(content_main.js, MAIN)
                                 │
                          tabs.sendMessage(SUNO_REC_CMD)
                                 │
                          [content_iso.js] ──postMessage──→ [content_main.js]
                                                                 │
                                                          findMainAudio()
                                                          captureStream()
                                                          MediaRecorder.start()
                                                                 │
[background.js] ←─sendMessage─ [content_iso.js] ←─postMessage─ [content_main.js]
      │
chrome.downloads.download(dataUrl)
      │
[本地 .webm 文件]
```

## 模块职责（单一职责原则）

| 文件 | 职责 | 不做什么 |
|------|------|----------|
| content_main.js | 音频流捕获 + 录制 | 不调用 chrome.* API |
| content_iso.js | 消息桥接 | 不做业务逻辑 |
| background.js | 按需注入 + 状态 + 下载 | 不接触音频数据 |
| popup.{html,js} | 用户操作 | 不直接做录制 |

## 关键设计决策

1. **按需注入（v0.2 核心变更）**
   不依赖 manifest content_scripts 自动注入（有时序问题：页面已打开时不追溯注入）。
   改用 `chrome.scripting.executeScript` 在用户点击时注入，永远新鲜。
   注入守卫 `if (window.__sunoRecorder) return` 防重复初始化。

2. **直接 captureStream（简化）**
   不依赖 play 事件注册 stream。start() 时直接 `audio.captureStream()` 拿当前流。
   实测验证：blob URL audio 的 captureStream 返回 live track，无需先 play。

3. **data URL 跨边界传输**
   Blob 跨 world 用 structured clone 不稳，base64 data URL 最稳健。
   Phase 2 改用 Native Messaging 直传 ArrayBuffer。

4. **注入守卫**
   content_main.js: `if (window.__sunoRecorder) return`
   content_iso.js: `if (window.__sunoIsoReady) return`
   防重复注入导致 listener 叠加。

## 实测验证 (2026-09-09)

在 suno.com/song/911df597-... 页面验证：
- 播放元素: `<audio src="blob:https://suno.com/...">` (209.88s, 无 DRM)
- `captureStream()` ✅ 可用
- `MediaRecorder` + `audio/webm;codecs=opus` ✅ 受支持
- 端到端录制 5 秒 → blob size 209,975 bytes ✅ 有真实音频数据

## 演进路径

- **Phase 2**: background → Native Messaging → 本地 FFmpeg 自动转 MP3
- **Phase 3**: 批量队列；ID3 标签；自动从页面提取歌名
