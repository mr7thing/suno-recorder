# Suno Recorder — 架构镜像

## 设计哲学
**截获而非重采样**——直接 hook Web Audio / MediaElement API 拿到数字音频流，
避免麦克风录制造成的 D/A→A/D 双重损失。工程上的诚实：数字世界的问题用数字方案。
**就地交互**——操作放在上下文中，用户不离开视线找扩展图标。

## 当前架构 (v0.4.0)

```
suno-recorder/
├── extension/
│   ├── manifest.json      # MV3，nativeMessaging + notifications
│   ├── background.js      # service worker: 注入 + 转码编排 + 下载兜底
│   ├── content_iso.js     # ISOLATED world: 浮动按钮 + 录制 + 歌名提取
│   └── icon.png
└── native-host/
    ├── host.js            # Node.js: Native Messaging 宿主 + FFmpeg 转 MP3
    ├── run.bat            # 宿主启动器
    ├── install.ps1        # 注册表 + manifest 安装
    └── smoke-test.js      # 回归测试
```

## 数据流（单向，5 个节点）

```
[用户点页面浮动按钮]
       │  play() + captureStream + MediaRecorder
       ▼
[content_iso.js] ──blob→dataUrl──▶ [background.js]
                                          │
                              connectNative('com.suno.recorder')
                                          │
                              port.postMessage({type:'convert', dataUrl, title})
                                          ▼
                            [native-host/host.js (Node.js)]
                              ├─ base64 解码 → tmp.webm
                              ├─ spawn ffmpeg -c:a libmp3lame -b:a 320k
                              └─ 写入 Downloads/suno-recorder/歌名.mp3
                                          │
                              port 回传 hello/progress/done/error
                                          ▼
                            [background.js]
                              ├─ setBadge (… / ✓ / !)
                              ├─ chrome.notifications (保存路径)
                              └─ 失败兜底: chrome.downloads.download(.webm)
```

## 模块职责（单一职责原则）

| 文件 | 职责 | 不做什么 |
|------|------|----------|
| content_iso.js | UI 注入 + 录制 + 歌名提取 | 不直接下载/转码 |
| background.js | 注入触发 + 转码编排 + 下载兜底 | 不接触音频字节 |
| host.js | base64 解码 + FFmpeg 转码 + 文件落盘 | 不关心 DOM |

## 关键设计决策

1. **方案 B：播放+录制原子化**
   点击浮动按钮 = click Suno Play + MutationObserver 监听 audio.src
   → src 变 blob 瞬间 captureStream + MediaRecorder.start()
   从真实音频第一帧开始，零遗漏、零空白、零后处理。

2. **Native Messaging 直传，而非 dataUrl 下载**
   Phase 1 用 dataUrl 经 chrome.downloads 落 webm（base64 膨胀 + 需手动转码）。
   Phase 2 改用 chrome.runtime.connectNative 直传 dataUrl 给本地 Node 宿主，
   宿主内解码后直接 ffmpeg → MP3，一步到位。

3. **退出三条件（Native Messaging 宿主关键陷阱）**
   `process.exit()` 会截断未 flush 的管道写入。
   退出需同时满足：stdin 关闭 + 任务清零 + 写入全部 flush（pendingWrites===0）。
   实测踩坑：hello/progress 收到，done 消息被截断 → 宿主成功但扩展以为失败。

4. **双保险注入**
   content_scripts（document_idle）自动注入 + action.onClicked 兜底注入。
   按钮挂到 documentElement + MutationObserver 防 React 冲掉。

5. **错误兜底**
   Native Host 不可用/转码失败 → 自动降级为 chrome.downloads.download(.webm)，
   用户至少拿到原始音频，不会空手而归。

## 实测验证 (2026-09-10)

### Phase 1 录制
- Suno blob URL audio (209.88s, 无 DRM)
- captureStream() + MediaRecorder(audio/webm;codecs=opus) ✅
- 端到端 5 秒 → 209,975 bytes webm ✅

### Phase 2 转码 (smoke-test.js)
- ffmpeg 生成 2s 正弦 webm → host.js → MP3 82,660 bytes
- ffprobe 验证 format=mp3, duration=2.04s ✅
- 文件名 `测试歌曲 <smoke>` → sanitize → `测试歌曲 smoke.mp3` ✅
- hello/progress/done 三种消息正确回传 ✅
