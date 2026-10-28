# Clash Momo

Clash Momo 是基于 Clash Party 的 Mihomo 图形客户端，配套使用 Mihomo Smart 派生内核 Mihomomo。当前维护和发布目标为 **Arch Linux x86_64**，应用 ID 为 `world.fansionia.clash-momo`。

## 安装与启动

配置 [Fansionia 软件包仓库](https://github.com/fansion314/packages#arch-linux--cachyos直接用-pacman)后安装：

```sh
sudo pacman -Syu
sudo pacman -S clash-momo
clash-momo
```

`clash-momo` 依赖 `mihomomo`（发布验收使用 `0.1.0-2`）和系统的 `electron`；可单独用 `sudo pacman -S mihomomo` 安装内核，并用 `mihomomo -v` 检查版本。应用使用 `/usr/bin/electron` 和唯一内核 `/usr/bin/mihomomo`，软件包不携带 Electron 或其他内核。内核包安装或升级时为该可执行文件设置网络能力，无需 setuid。系统托盘、系统代理和 TUN 的使用仍取决于桌面环境及系统配置。

软件包还安装 systemd-resolved 的 polkit 规则，使本地活动会话中 `wheel` 组用户可以无密码修改默认 `Mihomo` 接口的 DNS、路由域和默认路由设置及恢复这些设置。该授权对接口名生效，并不限于本应用进程；其他接口和其他操作不在授权范围。它需要 systemd-resolved 向 polkit 提供接口详情的版本。自定义 TUN 接口名不会自动获授权，管理员可按实际名称自行配置精确的 polkit 规则；非 `wheel` 用户仍需正常认证。

启动后导入配置或订阅，在应用中管理代理组、规则和系统代理。Sub-Store、覆写和 Smart 能力来自上游项目及配套内核。

## 窗口与流量历史

- **轻量模式**释放主窗口和悬浮窗的渲染进程，同时保留应用主进程、托盘和正在运行的同一个内核；可通过托盘重新打开窗口。也可在设置中配置自动进入轻量模式。
- **窗口缩放**可在设置中调整，范围为 50%–200%，步长为 1%。
- **流量历史**由内核记录到本地 SQLite 数据库。客户端默认启用记录，原始连接与采样默认保留 30 天，可在流量页面调整；按日聚合长期保留，不受原始数据清理影响。日统计按首次初始化时固定的时区和采样观测时间归属，不能精确还原跨日流量；一次日粒度查询最多 366 个日历日。已有流量在启用前或记录间断期间不会补录。
- 关闭本地记录会停止记录；此时历史查询 API 不可用（返回 HTTP 503），状态接口仍可访问。它不会将已有历史补齐或自动删除。记录队列满、磁盘错误或进程异常也可能造成缺失；状态接口提供相应信息。详情见 [内核流量历史文档](https://github.com/fansion314/momo/blob/mihomomo/docs/traffic-history.md)。

## 构建和发布维护

源码和发布共用 `fansion314/momo`：客户端维护在 `clash-momo` 分支，内核维护在 `mihomomo` 分支。首个版本的标签分别为 `clash-momo-v0.1.0-2` 和 `mihomomo-v0.1.0-2`；先发布内核。CI 在 Arch 中以普通用户运行检查和构建，并验证安装、包签名、内核能力及系统 Electron 原生模块，然后签名软件包并发布配方包。图形启动与托盘行为在 xjtuse 原生桌面验收，不在 CI 重复执行。发布需要 `ARCH_SIGNING_PRIVATE_KEY`、`ARCH_SIGNING_PASSPHRASE`、`ARCH_SIGNING_KEY_ID`，以及用于通知下游的 GitHub App `DISTRIBUTION_APP_ID` 和 `DISTRIBUTION_APP_PRIVATE_KEY`。已发布的标签和资产不可覆盖。

源码配方位于 `packaging/arch`。`scripts/prepare-arch.mjs` 对资源进行校验；MetaCubeX 地理数据的上游 `latest` 资源被替换时，校验会失败，需审阅后更新固定摘要。

分支历史仅保留一条上游快照基线和后续维护提交，上游来源记录在 `UPSTREAM.json`。更新时在干净工作区 fetch 对应上游分支，生成 `UPSTREAM.json` 所记提交到新上游提交的完整二进制补丁，以 `git apply --3way --index` 应用，审阅冲突并运行验证，更新来源记录后创建新的维护提交。不要直接 merge 上游分支或推送上游 refs，以免重新引入旧历史；不要恢复上游多平台发布工作流。

## 致谢与许可

Clash Momo 基于 [Clash Party](https://github.com/mihomo-party-org/clash-party)，配套内核基于 [Mihomo Smart](https://github.com/vernesong/mihomo) 及其 [Mihomo](https://github.com/MetaCubeX/mihomo) 上游。感谢所有上游项目和贡献者。本项目与上游项目无关联，按 [GPL-3.0](LICENSE) 发布。
