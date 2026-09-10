# Suno Recorder — 架构镜像

## 设计哲学
**截获而非重采样**——直接 hook Web Audio / MediaElement API 拿到数字音频流，
避免麦克风录制造成的 D/A→A/D 双重损失。工程上的诚实：数字世界的问题用数字方案。
**就地交互**——操作放在上下文中，用户不离开视线找扩展图标。

## 当前架构 (v0.5.0 — WASM 版)

```
suno-recorder/
├── extension/
│   ├── manifest.json      # MV3，offscreen + wasm-unsafe-eval CSP
│   ├── background.js      # service worker: 注入 + offscreen 转码编排 + native host 兜底
│   ├── content_iso.js     # ISOLATED world: 浮动按钮 + 录制 + 元数据嗅探
│   ├── offscreen.html     # ffmpeg.wasm 宿主页面
│   ├── offscreen.js       # ffmpeg.wasm 转码逻辑（浏览器内 webm→MP3）
│   ├── vendor/            # ffmpeg.wasm 核心文件
│   │   ├── ffmpeg.js           # @ffmpeg/ffmpeg UMD API
│   │   ├── 814.ffmpeg.js       # Worker chunk
│   │   ├── ffmpeg-core.js      # @ffmpeg/core
│   │   └── ffmpeg-core.wasm    # WASM 二进制 (~32MB)
│   └── icon.png
└── native-host/           # Native Host（兜底，offscreen 失败时启用）
    ├── host.js
    ├── run.bat
    ├── install.ps1
    └── smoke-test.js
```

## 数据流（主路径：ffmpeg.wasm）

```
[用户点页面浮动按钮]
       │  play() + captureStream + MediaRecorder
       ▼
[content_iso.js] ──blob→dataUrl──▶ [background.js]
                                          │
                              chrome.offscreen.createDocument()
                                          │
                              [offscreen.html + ffmpeg.wasm]
                              ├─ ffmpeg.load(coreURL, wasmURL)
                              ├─ writeFile(input.webm)
                              ├─ exec(-c:a libmp3lame -b:a 320k -metadata ...)
                              └─ readFile(output.mp3) → base64 dataUrl
                                          │
                              [background.js]
                              ├─ chrome.downloads.download(mp3 dataUrl)
                              ├─ setBadge ✓
                              └─ sendTab SUNO_REC_DONE
```

## 模块职责（单一职责原则）

| 文件 | 职责 | 不做什么 |
|------|------|----------|
| content_iso.js | UI 注入 + 录制 + 元数据嗅探 | 不直接下载/转码 |
| background.js | 注入触发 + 转码编排 + 下载 + 兜底 | 不接触音频字节 |
| offscreen.js | ffmpeg.wasm 加载与转码执行 | 不关心 DOM/下载 |
| host.js (兜底) | 本地 FFmpeg 转码（offscreen 失败时） | — |

## 关键设计决策

1. **ffmpeg.wasm 主路径（v0.5 核心变更）**
   用 offscreen document 承载 ffmpeg.wasm，浏览器内完成 webm→MP3 转码。
   优势：零安装（无需 Node/注册表/FFmpeg），开箱即用。
   代价：转码慢 5-10x，扩展体积 +32MB，内存 ~150MB。

2. **Offscreen 而非 content script**
   ffmpeg.wasm 依赖 Web Worker，页面 CSP 会拦截 content script 创建的 Worker。
   offscreen document 在扩展自有上下文运行，CSP 允许 `wasm-unsafe-eval`。

3. **Native Host 双层兜底**
   offscreen 失败 → 自动降级 native host → 再失败 → 直接下载 webm。
   用户永远不会空手而归。

4. **元数据嗅探与 ID3 嵌入**（与 native host 路径共用逻辑）
   content_iso.js extractMetadata() 提取 title/lyrics/artist/date/modelVersion，
   offscreen.js 和 host.js 都将其映射为 ffmpeg -metadata 参数。

## 实测验证 (2026-09-10)

- native-host smoke-test: webm→MP3 + 全部 ID3 标签 ✓
- ffmpeg.wasm vendor 文件下载完整（ffmpeg.js 4KB + core.js 114KB + core.wasm 32MB）
- manifest CSP `wasm-unsafe-eval` 已配置
- offscreen 权限已添加

## 演进路径

- **优化**: ffmpeg.wasm 多线程版（需 SharedArrayBuffer + COOP/COEP）
- **优化**: 转码进度实时回传 UI
- **批量**: 队列录制多首歌曲

## 历史设计决策（v0.1-v0.4）

1. **方案 B：播放+录制原子化**
   点击浮动按钮 = click Suno Play + MutationObserver 监听 audio.src
   → src 变 blob 瞬间 captureStream + MediaRecorder.start()
   从真实音频第一帧开始，零遗漏、零空白、零后处理。

2. **退出三条件（Native Messaging 宿主关键陷阱）**
   `process.exit()` 会截断未 flush 的管道写入。
   退出需同时满足：stdin 关闭 + 任务清零 + 写入全部 flush（pendingWrites===0）。

3. **双保险注入**
   content_scripts（document_idle）自动注入 + action.onClicked 兜底注入。
   按钮挂到 documentElement + MutationObserver 防 React 冲掉。

4. **分片传输规避 Native Messaging 1MB 上限**
   完整歌曲 base64 后超 1MB，被 Chrome 丢弃。按 256KB 分片 + chunk_ack 流控。
