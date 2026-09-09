# Suno Recorder — 架构镜像

## 设计哲学
**截获而非重采样**——直接 hook Web Audio / MediaElement API 拿到数字音频流，
避免麦克风录制造成的 D/A→A/D 双重损失。工程上的诚实：数字世界的问题用数字方案。

## Phase 1: MVP 架构

```
extension/
├── manifest.json      # MV3 入口，定义权限/匹配/host
├── content_main.js    # MAIN world hook: 拦截 AudioContext + HTMLMediaElement
├── content_iso.js     # ISOLATED world 桥接: postMessage <-> chrome.runtime
├── background.js      # service worker: 状态协调 + 下载执行
├── popup.html         # UI: 开始/停止/状态指示
└── popup.js           # UI 逻辑: 命令发送 + 状态接收
```

## 数据流（单向，无循环依赖）

```
[Page audio source]
        │  (MAIN world hook)
        ▼
[MediaStream + MediaRecorder]  ──→  window.postMessage
        │
        ▼
[content_iso.js]  ──→  chrome.runtime.sendMessage
        │
        ▼
[background.js: chrome.downloads.download]
        │
        ▼
[本地 .webm 文件]  ──→  (用户手动 FFmpeg 转 MP3)  ──→  [.mp3]
```

## 模块职责（单一职责原则）

| 文件 | 职责 | 不做什么 |
|------|------|----------|
| content_main.js | 音频流捕获 + 录制 | 不调用 chrome.* API |
| content_iso.js | 消息桥接 | 不做业务逻辑 |
| background.js | 状态协调 + 下载 | 不接触音频数据本身 |
| popup.{html,js} | 用户操作 | 不直接做录制 |

## 关键设计决策

1. **双 hook（AudioContext + HTMLMediaElement）**
   Suno 实际播放技术未公开，双 hook 覆盖所有路径。
   `AudioNode.prototype.connect` 劫持确保所有送入 `ctx.destination` 的音频
   同时分流到录音 dest，不漏源头。

2. **Proxy 包装 AudioContext**
   保留原型链，`instanceof` 检查仍正常，零侵入。

3. **data URL 跨边界传输**
   Blob 跨 world 用 structured clone 不稳，base64 data URL 最稳健。
   Phase 2 改用 Native Messaging 直传 ArrayBuffer。

4. **document_start 注入**
   在页面任何 script 之前 hook，避免漏掉早期 AudioContext 创建。

## 演进路径

- **Phase 2**: background → Native Messaging → 本地 FFmpeg 自动转 MP3
- **Phase 3**: 替换 MediaRecorder 为更高码率/无损选项；批量队列；ID3 标签
