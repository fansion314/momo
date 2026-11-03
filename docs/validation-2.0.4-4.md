# Clash Momo 2.0.4-4 验收记录

本记录整理 2026 年 11 月 3 日正式发布的 CI 结果和公开附件复核。各项结论仅限下述环境与范围；未覆盖项单独列出。本文是验收记录，不是实施计划。

## 版本与来源

| 项目           | 固定版本或源提交                                                                |
| -------------- | ------------------------------------------------------------------------------- |
| 客户端标签     | `clash-momo-v2.0.4-4`                                                           |
| 客户端源提交   | `f769c662e7d86f7bc5de10574f0577ab3e719b4f`                                      |
| 配套内核标签   | `mihomomo-v1.19.33-4`                                                           |
| 配套内核源提交 | `bff94c11042c507ec0049bd43f8d495efd3e62d1`                                      |
| 应用标识       | `world.fansionia.clash-momo`                                                    |
| Windows 产物   | x64 NSIS 安装包、便携 ZIP，均内置上述固定内核                                   |
| macOS 产物     | ARM64，打包修订 `r4`，最低系统版本 15.0；内核使用独立安装的软件包及特权网络服务 |
| Arch 产物      | x86_64 pacman 软件包；运行时使用系统 Electron 与独立 `mihomomo` 软件包          |

以上 SHA 是对应正式标签的源提交，不是后续分支最新提交。本文新增后的仓库提交也不改变这两个正式标签的来源。

## 实验分支与历史发布

通过 GitHub Git refs API 核对，以下实验分支仍指向回退前的源提交：

- `codex/experimental-tizi-clash-momo` → `3ce41d7b5ef88087cc80571e8a872c7b1e7e8b78`。
- `codex/experimental-tizi-mihomomo` → `1baac3bbd2099ccc41aeba9f25c07f8ffd116ec7`。

旧客户端 `clash-momo-v2.0.4-3` 与旧内核 `mihomomo-v1.19.33-3` 均保持公开，各 6 项附件，Release 的 `updated_at` 分别仍为 `2026-10-30T16:25:28Z`、`2026-10-30T16:20:32Z`。新发布采用向前回退提交，未改写这些历史标签或附件；`tizi-server` 未参与本轮改动。

## 正式发布与 CI 证据

- [客户端公开 Release](https://github.com/fansion314/momo/releases/tag/clash-momo-v2.0.4-4)。
- [内核公开 Release](https://github.com/fansion314/momo/releases/tag/mihomomo-v1.19.33-4)。
- [内核正式发布流水线 41560698360](https://github.com/fansion314/momo/actions/runs/41560698360)：成功。
- [客户端正式发布流水线 41566166861](https://github.com/fansion314/momo/actions/runs/41566166861)：检查、三平台任务、发布及分发通知任务均成功。
- [格式、ESLint、TypeScript、单元测试及 helper race 检查](https://github.com/fansion314/momo/actions/runs/41566166861/job/125688189511)：成功。
- [Windows 原生构建及运行验收](https://github.com/fansion314/momo/actions/runs/41566166861/job/125688189602)：成功。
- [macOS ARM64 原生构建及服务验收](https://github.com/fansion314/momo/actions/runs/41566166861/job/125688189551)：成功。
- [Arch x86_64 构建及安装验收](https://github.com/fansion314/momo/actions/runs/41566166861/job/125690506727)：成功。
- [客户端签名与发布任务](https://github.com/fansion314/momo/actions/runs/41566166861/job/125691449674)：成功。

## Windows x64

正式流水线使用原生 Windows runner，完成以下验证：

- 目录、管理员检测、权限处理、UAC 命令编码相关的 21 项单元测试通过。
- 使用固定的 `mihomomo-v1.19.33-4` 公开附件，核验 GitHub digest、SHA-256 校验文件、内核 manifest 和可执行文件摘要后打包。
- 生成 NSIS 安装包和带 `PORTABLE` 标记的便携 ZIP。
- 在包含中文和空格的路径启动便携客户端，确认数据目录为程序旁的 `data`；迁移整个便携目录后重新启动，已有流量历史继续保留。
- 实际启动打包后的 Electron 客户端，确认其直接启动的子进程来自包内 `resources/sidecar/mihomomo.exe`，同时核对完整路径和真实 Electron 主进程 PID。
- 通过 named-pipe API 确认内核版本及流量历史就绪；经客户端启动的本地 HTTP 代理产生真实流量，确认历史统计增加、数据库文件存在且重启后数据保留。
- 客户端退出后检查包内内核进程已结束。
- 静默安装 NSIS 包，运行同一套客户端、代理与历史验收；同目录重装和默认静默卸载保留用户数据标记，卸载后应用可执行文件被移除。
- 安装版与便携版均逐字节核验打包的完整客户端 GPL 文件。

配套内核还单独通过[原生 Windows 内核验收](https://github.com/fansion314/momo/actions/runs/41560698360/job/125671188035)：创建真实 TUN 适配器，为 `198.18.0.0/15` 添加窄范围路由，通过普通 socket 访问合成目标 `198.19.0.1`，经 TUN 转发至本地模拟 HTTP 出站并核对响应及流量历史，最后关闭 TUN 并确认适配器清理。该项覆盖独立内核的实际 TUN 通信，不代表客户端的 UAC 重启、全局路由或 DNS 已完成交互验收。Windows 产物尚无 Authenticode 签名，已提供 SHA-256 校验文件。

正式日志两次输出 `Actual client, bundled core, named-pipe API, local proxy, traffic history and restart passed`，分别对应便携版与安装版；最终输出 `Native Windows install, reinstall, uninstall, portable and bundled-core verification passed.`。

## macOS ARM64

正式流水线在原生 ARM64 runner 上完成应用构建、打包、`codesign --verify --deep --strict` 及 sysproxy 原生模块加载。另使用 Homebrew 内核运行实际应用启动验收。

特权服务验证使用一次性 runner 和真实配套内核，覆盖：

- 安装 helper，并复现旧服务留下的“root 所有目录、普通用户所有 socket”布局，确认升级安装移除旧 socket。
- 重装 helper 后再次运行服务验收。
- 绑定 UID、会话令牌、重复会话拒绝、错误令牌拒绝、快照路径越界拒绝，以及其他 UID 无法访问服务 socket。
- 启动真实受管内核，读取版本与流量历史状态，热重载配置；拒绝经控制器执行升级、重启及任意文件配置加载。
- 在 `auto-route: false`、DNS 关闭的配置下创建真实 `utun` 设备；停止续租后确认服务终止内核并清理该设备。
- 在专用、已禁用的一次性网络服务上验证原生 PAC URL 清除；不以该测试替代用户日常网络配置验收。

上述测试验证服务与设备生命周期边界，不代表已验证真实默认路由、全流量转发或用户桌面授权交互。

## Arch Linux x86_64

正式流水线在一次性 Arch 容器中，以普通构建用户完成源码包构建，并验证：

- 从公开 Release 获取独立内核软件包及 detached signature，在隔离 keyring 中核验签名，安装配套内核。
- 客户端包名、版本和架构正确；安装后内核具有 `cap_net_bind_service,cap_net_admin,cap_net_raw=ep`。
- 使用系统 Electron 加载客户端安装目录中的 sysproxy 原生模块；确认未误用客户端目录下的 Electron。
- 必需图标、地理数据、Sub-Store 资源和 sysproxy 文件存在；客户端包不额外携带内核可执行文件。
- 生成源码及二进制 AUR 配方；用本轮实际产物完成二进制配方打包、安装和原生模块加载检查。

本轮正式 Arch CI 未运行图形桌面、托盘、实际代理流量或 TUN 路由验收。此前的原生桌面证据见 [2026-10-27 Arch 验收记录](validation.md)，不能直接视为本轮正式标签重新完成了同样的桌面测试。

## 公开附件复核

发布完成后，主代理独立下载并复核客户端全部 12 项公开附件，对全部附件比对 GitHub SHA-256 digest，对发布的 `.sha256` 校验文件逐一验证对应文件。另完成：

- 核验 Windows 便携包中的 manifest 与内置内核精确字节，确认对应固定配套内核。
- 核验 Windows 包内完整客户端、内核及 Wintun 许可证；客户端许可证比对考虑 Git checkout 造成的 CRLF/LF 差异。
- 对公开 Arch 客户端包完成 GPG detached signature 验签。
- 独立复核配套内核全部 8 项公开附件的摘要、校验文件及相应签名。

这些检查确认已公开的字节与验收对象相符。下游分发验收结果如下。

## 下游分发验收

[联合分发流水线 41567282063](https://github.com/fansion314/packages/actions/runs/41567282063) 最终为 `completed/success`，14 个任务均成功，完成以下消费者验收：

- Homebrew 主源、CNB 镜像候选及公开镜像均完成实际安装；真实客户端启动配套内核，日志确认 `Clash Momo started Mihomomo 1.19.33 and traffic history is ready.`。公开镜像完成双源切换、来源验证及完整 tap 安装测试。
- AUR 源码与二进制配方均核对为 `2.0.4-4`，客户端来源为固定提交 `f769c662`，依赖 `mihomomo>=1.19.33-4`；二进制配方完成实际打包安装。
- pacman 主站、镜像的候选及正式域名安装均成功，实际安装客户端 `2.0.4-4` 和内核 `1.19.33-4`，安装文件完整。正式域名的仓库数据库和签名已独立下载，摘要与 manifest 一致，数据库内两个软件包版本正确。
- 发布后快照 `active` 与本次候选均为 `eeebd850a74028262cceb49813f53bd6`；镜像 `pending` 为空、`cleanup_pending=false`。清理后保留新快照与此前成功快照 `abe40bc1798194ce9e54432db72b1201`，共两份。
- Windows 只存在于 GitHub Release 附件，本轮未新增 Windows 软件源或 fansionia packages 安装渠道。

## 明确未覆盖项

- Windows 桌面 UAC 的真实确认、取消及重启交互；CI 仅通过模拟调用验证分支和命令编码，原生 runner 本身运行于管理员上下文，也未实测普通非管理员账户的完整启动流程。
- Windows 客户端实际启用 TUN 后的系统路由、DNS 与外部网络转发。
- macOS 用户真实网络上的全流量转发、默认路由与 DNS 行为，以及通过桌面授权提示安装或更新服务的交互。CI 的真实 `utun` 验收刻意关闭自动路由与 DNS。
- 使用真实旧生产数据库、加密账户文件及账本完成整套跨版本升级。旧 `tiziActive`、`tizi-managed` 和 `type: managed` 的兼容逻辑有单元测试，覆盖普通订阅恢复、无普通订阅时回到空配置，以及占位历史文件和加密账户文件保持不变；这不等同于真实生产数据迁移验收。
- Windows 流量历史保留验证使用本轮新建的真实数据库；安装、重装和卸载保留验证也不等同于从旧版生产环境升级。
- Arch 本轮正式 CI 的图形桌面、托盘及真实网络路径，范围如上。

## 复跑入口

以下脚本描述对应自动验收步骤，应在其要求的一次性 CI 或隔离环境中运行：

- [正式跨平台发布流程](../.github/workflows/release-arch.yml) 与 [检查流程](../.github/workflows/ci.yml)。
- [Windows 构建、安装与卸载验收](../packaging/windows/build-ci.ps1)、[实际客户端 smoke](../packaging/windows/smoke.mjs)、[内核获取与核验](../packaging/windows/prepare-core.mjs)。
- [macOS 构建与打包](../packaging/macos/build-ci.sh)、[服务安装及重装](../packaging/macos/test-service-ci.sh)、[真实服务与 utun 验收](../packaging/macos/test-service-ci.py)、[隔离网络服务 PAC 验收](../packaging/macos/test-network-ci.sh)。服务脚本只允许在一次性 GitHub macOS runner 上执行。
- [Arch 构建与安装](../packaging/arch/build-ci.sh)；[原生图形验收脚本](../packaging/arch/gui-smoke.sh)是独立入口，本轮正式 Arch CI 未调用。
- [旧受控订阅兼容测试](../src/main/config/profile.test.ts) 与 [旧应用配置归一化测试](../src/shared/appConfig.test.ts)。
- [发布附件核验脚本](../scripts/verify-release-assets.mjs) 用于发布草稿晋升前比对，公开发布后的独立下载复核另行执行。
