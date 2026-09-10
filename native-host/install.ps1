# ===================================================================
# Suno Recorder — Native Messaging Host 安装脚本
# -------------------------------------------------------------------
# 用法: .\install.ps1 -ExtensionId "扩展ID"
# 扩展 ID 在 chrome://extensions 页面查看（开发者模式）
# ===================================================================

param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'

$hostDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $hostDir 'com.suno.recorder.json'
$batPath = Join-Path $hostDir 'run.bat'

# ---------- 校验扩展 ID 格式 ----------
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "扩展 ID 格式错误：应为 32 个字母 (a-p)。在 chrome://extensions 查看。"
}

# ---------- 写 manifest ----------
$manifest = @{
  name = 'com.suno.recorder'
  description = 'Suno Recorder Native Host - webm to mp3 converter'
  path = $batPath
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json

$manifest | Out-File -FilePath $manifestPath -Encoding ascii
Write-Host "[OK] manifest: $manifestPath"

# ---------- 注册 HKCU 注册表 ----------
$regKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.suno.recorder'
if (-not (Test-Path $regKey)) { New-Item -Path $regKey -Force | Out-Null }
Set-ItemProperty -Path $regKey -Name '(default)' -Value $manifestPath
Write-Host "[OK] registry: $regKey"

# ---------- 验证 node 可用 ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Write-Host "[OK] node: $($node.Source)" }
else { Write-Host "[WARN] node 不在 PATH，请编辑 run.bat 指向 node.exe 绝对路径" }

# ---------- 验证 ffmpeg 可用 ----------
$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ff -or (Test-Path 'C:\workapp\ffmpeg\bin\ffmpeg.exe')) {
  Write-Host "[OK] ffmpeg 可用"
} else {
  Write-Host "[WARN] ffmpeg 未找到，请安装: winget install Gyan.FFmpeg"
}

Write-Host "`n安装完成。重启 Chrome 后生效。"
