# Suno Recorder — 架构镜像

## 设计哲学
**截获而非重采样**——直接 hook Web Audio / MediaElement API 拿到数字音频流，
避免麦克风录制造成的 D/A→A/D 双重损失。工程上的诚实：数字世界的问题用数字方案。
**就地交互**——操作放在上下文中，用户不离开视线找扩展图标。

## Phase 1: MVP 架构 (v0.3+)

```
extension/
├── manifest.json      # MV3，action 无 popup（点图标触发注入）
├── content_iso.js     # ISOLATED world: 注入浮动按钮 + 录制 + chrome API
└── background.js      # service worker: 注入触发 + 下载
```

## 数据流（单向，3 个节点）

```
[用户点扩展图标] ──→ [background.js: action.onClicked]
                          │
                   scripting.executeScript(content_iso.js, ISOLATED)
                          │
                   [content_iso.js 注入浮动按钮到页面右下角]
                          │
                   [用户点"播放+录制"按钮]
                          │
                   findMainAudio() → play() + captureStream()
                   MediaRecorder.start()
                          │
                   [用户点"停止录制"]
                          │
                   recorder.stop() → Blob → dataURL
                          │
              chrome.runtime.sendMessage(SUNO_REC_DOWNLOAD)
                          │
              [background.js: chrome.downloads.download]
                          │
                   [本地 .webm 文件]
```

## 模块职责（单一职责原则）

| 文件 | 职责 | 不做什么 |
|------|------|----------|
| content_iso.js | UI 注入 + 录制 + 发消息 | 不直接下载 |
| background.js | 注入触发 + 下载 | 不接触音频数据 |

## 关键设计决策

1. **单文件录制逻辑（v0.3 核心变更）**
   ISOLATED world 可访问 DOM + chrome API + MediaRecorder，
   不再需要 MAIN world 中转。content_main.js / content_iso.js
   双文件合一为 content_iso.js。架构从 5 文件降到 2 文件。

2. **浮动按钮注入**
   position: fixed 右下角，不依赖页面 DOM 结构。
   三态：idle(蓝) → recording(红脉冲) → processing(灰)。
   点击即播放+录制原子启动，再点即停止+下载。

3. **action.onClicked 触发注入**
   manifest 不设 default_popup → 点击扩展图标触发 onClicked。
   用 chrome.scripting.executeScript 按需注入。
   注入守卫 `if (window.__sunoRecorderBtn) return` 防重复。

4. **播放+录制原子化**
   start() 里 play() 和 recorder.start() 同步调用，
   确保从第 0 秒开始录制，不遗漏开头。

## 实测验证 (2026-09-09)

- 播放元素: `<audio src="blob:https://suno.com/...">` (209.88s, 无 DRM)
- `captureStream()` ✅ 可用
- `MediaRecorder` + `audio/webm;codecs=opus` ✅ 受支持
- 端到端录制 5 秒 → blob size 209,975 bytes ✅ 有真实音频数据

## 演进路径

- **Phase 2**: background → Native Messaging → 本地 FFmpeg 自动转 MP3
- **Phase 3**: 批量队列；ID3 标签；自动从页面提取歌名
