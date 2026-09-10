# Suno Recorder

Chrome 浏览器扩展：在 Suno 歌曲页面一键"播放+录制"，浏览器内自动转码 MP3，
自动嵌入歌名 / 作者 / 创作日期 / 模型版本 / 歌词等 ID3 标签。

---

## 重要声明（使用前必读）

1. **仅适用于 Suno 歌曲分享页面**
   本工具仅在 `https://suno.com/song/...` 格式的歌曲分享链接页面下工作。
   其他任何页面（Suno 工作台、列表页、第三方网站）均不受支持——
   扩展只匹配 suno.com 域名，且录制按钮依赖歌曲页面特有的音频元素结构。
   请务必在**歌曲分享页面环境**中使用。

2. **本工具采用"操作过程录制"方式工作**
   点击"播放+录制"后，工具会代替你点击页面 Play 按钮，截获页面音频流并实时录制：
   - 需等待音频加载完成（自动处理，通常数秒）；
   - 录制期间歌曲需保持播放（歌曲播完自动停止，暂停超 3 秒也会自动停止）；
   - 录制过程中请勿关闭或刷新页面；
   - 停止后自动进入转码，完成后 MP3 自动保存到浏览器下载目录。

3. **仅支持 Chrome 浏览器**
   依赖 Manifest V3、offscreen document、chrome.scripting 等专有 API，
   经 Chrome 120+ 实测验证。Firefox / Edge / Safari **不在支持范围**，
   不保证任何其他浏览器的兼容性表现。

4. **仅用于合理下载与个人创作后处理**
   本工具的目的是为**个人创作的音乐后处理提供便利**——
   方便创作者将自己生成的音乐保存为带完整元数据标签的 MP3，
   用于本地归档、剪辑、混音、发布等后续创作流程。
   请尊重 Suno 服务条款与内容版权，勿用于侵犯他人权利的用途。

---

## 功能特性

- **一键操作**：点一次"播放+录制"，自动点 Play、等加载、开始录制，从第一帧录起，零遗漏零空白
- **自动停止**：歌曲播完（`ended` 事件）或暂停超 3 秒自动停止并进入转码
- **浏览器内转码**：ffmpeg.wasm 跑在扩展 offscreen 页面，webm → MP3 (320kbps)，**零安装、零依赖**
- **ID3 元数据自动嵌入**：
  | 字段 | 来源 | ID3 帧 |
  |------|------|--------|
  | 歌名 | 页面 `<h1>` | TIT2 |
  | 作者 | 作者链接 | TPE1 |
  | 专辑 | 固定 "Suno" | TALB |
  | 创作日期 | 页面时间戳 | TDRC |
  | 模型版本 | `V6` 等标记 | TXXX:Suno-Version |
  | 歌词 | 歌词区块 | USLT |
- **文件名自动命名**：直接使用歌曲名，如 `Half Fire, Half Divine.mp3`
- **三层兜底**：WASM 转码 → 本地 Native Host（可选）→ 原始 webm，永不空手而归

## 安装

1. 下载或克隆本仓库到本地
2. 打开 Chrome，访问 `chrome://extensions`
3. 右上角开启 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择本仓库的 `extension/` 目录
5. 完成。无需安装 Node、FFmpeg 或任何其他依赖

## 使用

1. 在 Chrome 中打开 Suno **歌曲分享页面**（形如 `https://suno.com/song/xxxx`）
2. 页面右下角出现蓝色 **"播放+录制"** 浮动按钮
3. 点击按钮：
   - 按钮变橙（等待音频加载，自动点击页面 Play）
   - 变红并脉冲（录制中）
   - 变灰（转码中，首次约需 1-2 分钟，扩展图标显示橙色 `…`）
   - 恢复蓝色并提示"已保存"（扩展图标绿色 `✓`，弹窗通知保存路径）
4. MP3 保存至 `下载/suno-recorder/歌曲名.mp3`

> 转码速度说明：ffmpeg.wasm 为纯浏览器实现，速度约为原生的 1/5 ~ 1/10，
> 3 分钟歌曲约需 1-2 分钟。进度可从扩展图标的徽章与系统通知观察。

## 工作原理

```
[歌曲分享页面]
     │ 点击"播放+录制"
     ├─ content script 自动点击 Suno Play
     ├─ MutationObserver 监听 audio.src 变 blob（真实歌曲恒为 blob URL）
     ├─ 等待 loadedmetadata（消除 duration=NaN 窗口）
     ├─ audio.captureStream() 截获数字音频流（非麦克风重采样，无二次损失）
     └─ MediaRecorder 实时录制 → chunks
                │ 歌曲播完 / 暂停 3s / 手动停止
                ▼
[background service worker]
     ├─ 接收 dataUrl（base64）
     ├─ chrome.offscreen.createDocument(WORKERS)
     │        │
     │        ▼
     │   [offscreen.html + ffmpeg.wasm]
     │   writeFile → exec(libmp3lame 320k + ID3 metadata) → readFile
     │
     ├─ chrome.downloads.download(歌曲名.mp3)
     └─ 兜底：Native Host（Node + 本地 FFmpeg）→ 原始 webm
```

## 故障排查

| 现象 | 处理 |
|------|------|
| 按钮没出现 | 确认在 `suno.com/song/...` 页面；点一下扩展图标重新注入 |
| 提示"30秒内未检测到音频" | 手动点页面 Play 后再点浮动按钮 |
| 转码超时/失败 | 自动降级下载 webm；检查 `chrome://extensions` 的 Service Worker 控制台日志 |
| MP3 无声音 | 确认录制期间音频在播放且未静音页面标签 |
| 日志位置 | 页面控制台 `[CS-]`；Service Worker 控制台 `[BG-]`；offscreen 控制台 `[OS-]` |

## 可选：Native Host 兜底

WASM 路径已覆盖绝大多数场景。如需原生速度转码（快 5-10 倍）：

```powershell
cd native-host
.\install.ps1 -ExtensionId "你的32位扩展ID"
# 重启 Chrome 生效
```

详见 `native-host/` 内说明。

## 许可与免责

- 本工具不下载、不破解、不规避任何技术保护措施，仅对页面正常播放的音频进行浏览器内截取。
- 录制内容的权利与责任由使用者承担，请遵守 Suno 服务条款。
- 仅支持 Chrome。因浏览器差异、页面改版导致的功能异常不属于工具缺陷。

## 贡献与反馈

- 问题反馈：在 GitHub 仓库提交 Issue
- 代码贡献：欢迎 Pull Request
- 项目支持：在 GitHub 仓库 Star 项目