# Clash Momo 2.0.4-7 发布与验收记录

r7 为已撤回的未发布候选，后续原生验收发现的资源回传/重启问题已在 r8 修复并正式发布。本文保留推进过程，最终结果见 [r8 验收记录](validation-2.0.4-8.md)。

## 固定来源

| 项目         | 来源                                                       |
| ------------ | ---------------------------------------------------------- |
| 客户端标签   | `clash-momo-v2.0.4-7`                                      |
| 客户端源码   | `71023bcb1bbcfd3df373c6a06064eb923c12dfc7`                 |
| 内核标签     | `mihomomo-v1.19.33-5`                                      |
| 内核源码     | `843abbe5bb61a2e5752c21f9f47d60d71d191efb`                 |
| 内核 CI 编排 | `4e14021aa8ecd5138d48bc7e88b1ae7e5d002c06`；未改写发布标签 |
| 应用 ID      | `world.fansionia.clash-momo`                               |

修复范围见 [macOS 功能审计](macos-functionality-audit-2026-11-04.md)。客户端 r6 候选因后续发现的 TLS 客户端证书选项兼容问题撤回，保留原标签与未发布 draft（Release ID 434158212），没有重写历史。r7 对齐了原内核的客户端证书模式，并验证了缺证书被拒、受信任证书通过。

## 验证结果

- Format、Lint、node/web/test 类型检查及 Git hooks 正常执行，未跳过 hooks。最终 Vitest：730 通过、1 跳过（Windows 原生专用检查）。
- macOS Rust helper：30 项通过，fmt/clippy 无错误。普通用户测试中的 root 专用分支可能提前返回，因此不冒充本机实际特权安装验收。
- 经规定助手增量同步到既有 `xjtuse-arch-dev`，排除 out、extra、node_modules、target 等本机产物。容器 root 下 29 项 helper 测试及 clippy 全部通过，实际覆盖受保护文件、事务、会话和资源导出。Rust wrapper 保持 sccache。
- 完整 macOS r7 app 构建成功，deep/strict codesign、ARM64、revision 7、应用 ID 和 Electron 下 sysproxy-rs 实际加载通过。未在用户系统安装或替换应用、helper、Homebrew 内核，未修改系统代理/DNS。
- 原生 macOS 内核在隔离临时目录实测：中文且带斜杠的分组切换、取消固定、规则禁用、WebUI 存储读写删除、payload 完整重载全部通过，没有启用 TUN 或写系统时间。
- 本机 Go 1.27.3 全量测试在上游 XHTTP H1 Encryption 并发测试出现 closed pipe/reset；受影响的 constant/config/hub/route 测试通过。干净 Go 1.26 CI 的 Linux、macOS、Windows 全量及规定竞态检查均成功，该本机问题没有复现。
- 新增 `packaging/macos/smoke.mjs`：在一次性 macOS runner 中点击真实节点卡片，使用无 preload 的独立 WebUI 验证 CORS、WebSocket、切换、存储、重载、重启和退出清理，并保存截图及 JSON。客户端该项原生 CI 尚待成功，不宣称已经完成 GUI 验收。

## 已正式发布的配套内核

- [Mihomomo 1.19.33-5](https://github.com/fansion314/momo/releases/tag/mihomomo-v1.19.33-5)。
- [成功发布流程 41867012876](https://github.com/fansion314/momo/actions/runs/41867012876)：三平台检查、Arch 构建、签名、发布及分发通知全部成功。
- 独立下载公开全部 8 项附件，逐一核对 GitHub digest、大小及三个平台的 checksum 文件，核对 macOS 内嵌来源提交，并用隔离 GPG keyring 验证 Arch detached signature。
- Windows ZIP SHA-256：`05deaa0e3886a50ebcf7a8eb3922464001a31cf25d39f1cc605e0ec2ad896e82`；独立核对其内嵌 tag、源码和 exe 摘要。
- macOS 内核 tar.gz SHA-256：`48af6c6fd1f0de5ac65dcaef508a2684a010ddda01ee4f2d29e10812d6d7c613`。
- packages 分发流程已触发，任务 `41872335563` 仍待完成；不把通知成功等同于镜像/客户端分发已验收。

## 客户端发布恢复点

- [客户端 r7 流程 41866371462](https://github.com/fansion314/momo/actions/runs/41866371462) 已在内核发布后重试。前序 Windows 失败是配套内核尚未发布造成的 404，Linux 检查成功；macOS ARM runner 多次因容量不足取消，已切换正式 macOS 26 ARM64，最低产品系统版本保持 15。
- 当前 GitHub 部分任务汇总状态滞后，job 明细和已结束日志与 run 状态不一致；按具体任务与日志判断，没有据此绕过检查。
- Arch 编排脚本仍硬编码旧内核 -4，已改为从 release.json 读取精确 coreTag，保留签名验证。Format/Lint/类型检查与 hooks 已通过，但提交签名失败，改动保留在暂存区。
- `ssh-add -l` 返回 The agent has no identities；`bw-agent status` 显示 session monitor=locked、vault unlocked=false、manual_lock=false。需要用户解锁桌面/密码库，未修改自动锁定策略，也未绕过签名。
- 解锁后提交暂存的 `packaging/arch/build-ci.sh`，推送 clash-momo 分支，从该分支 dispatch `release-arch.yml`，`release_tag=clash-momo-v2.0.4-7`。编排读取维护分支修正后的脚本，而产品源码仍绑定不可变 r7 标签。随后完成三平台原生检查、签名发布、公开附件验证及 packages 分发验收。

## 本地候选包

`dist/release/clash-momo-2.0.4-7-macos-arm64-r7.tar.gz`，187434109 字节，SHA-256 `d943ac8cc56bbd409b6dac7f49a331c5ec84c05b652d4f0ea7bd92b0c5c447e5`。已解压复验签名及 revision 7。该本地产物不是已经公开验收的正式客户端发布。

## 解锁后的发布推进

- `ac83a2f7` 已签名提交并推送 Arch 配套内核选择修复，全部 hooks 通过。
- Windows 上次失败定位到验收夹具硬编码 r4→r5（`7 !== 5`），不是产品运行失败。`d4e9fb22` 将夹具改为实际目标 revision 的前一版，并保留完整签名、坏下载拒绝、真实 NSIS 升级和数据保留验证；真实公开 r4→r7 升级仍单独验证。
- Windows 验收从发布编排提交的 `.validation-tools` 执行，构建的产品源码仍精确检出不可变 r7 标签；Arch 使用同一编排来源的 `.release-tools`。没有修改发布标签或产品源码。
- 最新完整发布：[41940924956](https://github.com/fansion314/momo/actions/runs/41940924956)，三平台均已开始执行。
- 配套内核 Homebrew 主源与 CNB mirror-public 验证已在 packages 任务 `41925070171` 成功。pacman 仍需随客户端最终分发独立确认。

- `da41634e` 修正 macOS 首次启动引导遮罩对真实节点点击验收的影响：通过可见关闭按钮正常关闭后再点击，失败时保留截图；服务升级/重装、真实 utun 与 lease 检查已在前序任务通过。
- `3b83356a` 修正真实 Windows r4 升级夹具的预期：旧客户端必须携带已验证的 -4 内核，新客户端必须携带 -5；继续检查二进制 SHA-256。受控前一 revision→r7 的真实 NSIS 更新已通过，修正没有跳过旧版验证。
- 最新完整发布由维护分支编排 [41942818246](https://github.com/fansion314/momo/actions/runs/41942818246)，仍绑定 r7 产品源码。

## r7 候选撤回原因

原生验收确认节点卡片、外部 WebUI、跨域和 WebSocket 成功，随后外部重启超过预算：helper 资源导出中的小块 base64 写入频繁触发通道等待，并持生命周期锁回传全部资源，状态查询也被阻塞。r7 未发布 draft 保留，正式候选前进到 r8，产品源码修复提交 e2f88616。

修复使用有界 64 KiB 缓冲、文件内容摘要增量回传及原子运行态/不可变元数据的独立状态查询，保留旧数组导出请求兼容。新增真实 HTTP 4 MiB 导出及未变文件跳过、持锁期间 status/lease 可响应的回归。macOS 31 项 Rust 测试及隔离 Linux root 30 项通过，clippy 无错误，Node 730 项通过。

r7 最后一次验收 41942818246 的 Windows 完整验证已成功；macOS 暴露上述产品问题，未绕过。r8 正式流程 41946696463 正在执行，本地 r8 app 已构建并通过 deep/strict 签名与 revision 8 核验。最终发布结果将记录在 r8 验收文档。
