# Clash Momo

Clash Momo 是基于 Clash Party 的 Mihomo 图形客户端，配套使用 Mihomo Smart 派生内核 Mihomomo。当前维护和发布目标为 **Arch Linux x86_64** 与 **macOS 15+ Apple Silicon**，应用 ID 为 `world.fansionia.clash-momo`。

## 安装与启动

配置 [Fansionia 软件包仓库](https://github.com/fansion314/packages#arch-linux--cachyos直接用-pacman)后安装：

```sh
sudo pacman -Syu
sudo pacman -S clash-momo
clash-momo
```

`clash-momo` 依赖 `mihomomo >= 1.19.33`和系统的 `electron`；可单独用 `sudo pacman -S mihomomo` 安装内核，并用 `mihomomo -v` 检查版本。应用使用 `/usr/bin/electron` 和唯一内核 `/usr/bin/mihomomo`，软件包不携带 Electron 或其他内核。内核包安装或升级时为该可执行文件设置网络能力，无需 setuid。系统托盘、系统代理和 TUN 的使用仍取决于桌面环境及系统配置。

软件包还安装 systemd-resolved 的 polkit 规则，使本地活动会话中 `wheel` 组用户可以无密码修改默认 `Mihomo` 接口的 DNS、路由域和默认路由设置及恢复这些设置。该授权对接口名生效，并不限于本应用进程；其他接口和其他操作不在授权范围。它需要 systemd-resolved 向 polkit 提供接口详情的版本。自定义 TUN 接口名不会自动获授权，管理员可按实际名称自行配置精确的 polkit 规则；非 `wheel` 用户仍需正常认证。

启动后导入配置或订阅，在应用中管理代理组、规则和系统代理。Sub-Store、覆写和 Smart 能力来自上游项目及配套内核。

## macOS 安装与网络服务

通过 Fansionia Homebrew tap 安装独立的 `mihomomo` Formula（≥ 1.19.33）及 Clash Momo Cask：

```sh
brew tap fansion314/packages https://github.com/fansion314/packages.git
brew install --cask fansion314/packages/clash-momo
```

也可从 [Releases](https://github.com/fansion314/momo/releases) 下载 Apple Silicon 应用归档，解压后把应用移入 `/Applications`，并单独安装 `brew install fansion314/packages/mihomomo`。内核固定从 `/opt/homebrew/opt/mihomomo/bin/mihomomo` 读取；应用检查内核版本与服务协议，不携带第二份普通内核。此版本要求 macOS 15 或更高，不支持 Intel Mac。

发布应用没有 Developer ID 签名或 Apple 公证，首次启动可能受到 Gatekeeper 限制；确认下载来源后，按 macOS「系统设置 → 隐私与安全性」的提示允许打开。应用以普通用户运行，不要使用 `sudo` 启动，也不要为内核设置 setuid。

- 尚未安装服务时可以使用普通用户代理内核；首次启用 TUN、系统代理或 DNS 修改时安装独立网络服务，并由 macOS 弹出管理员认证。取消认证会保留普通模式。
- 「设置 → 内核」显示服务状态，提供安装／更新、卸载及服务日志。升级应用或 Homebrew 内核后，如果文件摘要或协议不匹配，需要重新授权更新服务；不会自动把用户可写的可执行文件作为 root 运行。管理员授权时，安装器将固定 Formula 内核与 helper 复制到受保护目录。
- 服务身份为 `world.fansionia.clash-momo`，通过受权限保护的 Unix socket 与主进程通信。主进程每 2 秒续约；失联超过 10 秒，服务停止内核并恢复原来的系统代理和 DNS。正常退出也会执行停止和恢复；轻量模式保留主进程及续约。
- 服务运行数据位于 `/Library/Application Support/world.fansionia.clash-momo/data`。首次接管先确认普通内核退出，再导入配置、资源和流量历史，避免两个内核写同一数据库。配置快照只读取有界的普通文件，拒绝符号链接；系统服务不会执行配置里的启动／退出 shell 钩子，也不开放公共控制器。
- 卸载服务前会停止内核，将流量历史和缓存恢复到用户工作目录，恢复网络设置，然后回到普通模式并关闭 TUN／系统代理。服务目录保留以便恢复；删除 Cask 本身不会等同于清理服务，请先在应用中卸载服务。

macOS 归档构建、安装授权、TUN 路由、系统代理／DNS 恢复和休眠唤醒需要在真实 macOS 上验收；单元测试通过不等于这些系统集成行为已验收。

## 窗口与流量历史

- **轻量模式**释放主窗口和悬浮窗的渲染进程，同时保留应用主进程、托盘和正在运行的同一个内核；可通过托盘重新打开窗口。也可在设置中配置自动进入轻量模式。
- **窗口缩放**可在设置中调整，范围为 50%–200%，步长为 1%。
- **流量历史**由内核记录到本地 SQLite 数据库。客户端默认启用记录，原始连接与采样默认保留 30 天，可在流量页面调整；按日聚合长期保留，不受原始数据清理影响。日统计按首次初始化时固定的时区和采样观测时间归属，不能精确还原跨日流量；一次日粒度查询最多 366 个日历日。已有流量在启用前或记录间断期间不会补录。
- 关闭本地记录会停止记录；此时历史查询 API 不可用（返回 HTTP 503），状态接口仍可访问。它不会将已有历史补齐或自动删除。记录队列满、磁盘错误或进程异常也可能造成缺失；状态接口提供相应信息。详情见 [内核流量历史文档](https://github.com/fansion314/momo/blob/mihomomo/docs/traffic-history.md)。

## 构建和发布维护

源码和发布共用 `fansion314/momo`：客户端维护在 `clash-momo` 分支，内核维护在 `mihomomo` 分支。本次标签分别为 `clash-momo-v2.0.4-1` 和 `mihomomo-v1.19.33-1`；先发布内核。版本跟踪 Clash Party 稳定版及原版 Mihomo 稳定版，实际源码基线、智能内核来源链和准确提交记录在 `UPSTREAM.json`，保留已有改进；同版本修订递增打包号，macOS 修订单独记录。CI 收齐 Arch 与 macOS 产物后统一发布不可变 Release。Arch 包验证安装、签名、内核能力和系统 Electron 原生模块；macOS 验证 ARM64 应用签名及专用服务。图形授权与实际网络行为另行验收。发布需要 `ARCH_SIGNING_PRIVATE_KEY`、`ARCH_SIGNING_PASSPHRASE`、`ARCH_SIGNING_KEY_ID`，以及用于通知下游的 GitHub App `DISTRIBUTION_APP_ID` 和 `DISTRIBUTION_APP_PRIVATE_KEY`。已发布的标签和资产不可覆盖。

源码配方位于 `packaging/arch`。`scripts/prepare-arch.mjs` 对资源进行校验；MetaCubeX 地理数据的上游 `latest` 资源被替换时，校验会失败，需审阅后更新固定摘要。

分支历史仅保留一条上游快照基线和后续维护提交，上游来源记录在 `UPSTREAM.json`。更新时在干净工作区 fetch 对应上游分支，生成 `UPSTREAM.json` 所记提交到新上游提交的完整二进制补丁，以 `git apply --3way --index` 应用，审阅冲突并运行验证，更新来源记录后创建新的维护提交。不要直接 merge 上游分支或推送上游 refs，以免重新引入旧历史；macOS 构建和发布使用本项目专用流水线，不恢复上游的其他平台发布工作流。

## 致谢与许可

Clash Momo 基于 [Clash Party](https://github.com/mihomo-party-org/clash-party)，配套内核基于 [Mihomo Smart](https://github.com/vernesong/mihomo) 及其 [Mihomo](https://github.com/MetaCubeX/mihomo) 上游。网络信息布局与解锁检测移植自 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev)，适配本项目的 Electron 与 HeroUI 实现。感谢所有上游项目和贡献者。本项目与上游项目无关联，按 [GPL-3.0](LICENSE) 发布。
