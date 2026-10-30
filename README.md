# Mihomomo

Mihomomo 是 Clash Momo 使用的代理内核，基于 [Mihomo Smart](https://github.com/vernesong/mihomo) 和 [Mihomo](https://github.com/MetaCubeX/mihomo) 上游维护；本项目与 MetaCubeX 无关联。当前发布目标为 **Arch Linux x86_64**。

## 安装与使用

配置 [Fansionia 软件包仓库](https://github.com/fansion314/packages#arch-linux--cachyos直接用-pacman)后安装：

```sh
sudo pacman -Syu
sudo pacman -S mihomomo
mihomomo -v
```

软件包提供 `/usr/bin/mihomomo`。安装和升级时使用 `setcap` 授予 `cap_net_admin`、`cap_net_raw` 和 `cap_net_bind_service`，不设置 setuid。图形客户端可安装 `clash-momo` 并运行同名命令。

## 流量历史与 Smart

Mihomomo 保留 Smart 代理选择与元数据，增加本地 SQLite 流量历史和按日聚合。原始记录默认保留 30 天，按日聚合长期保留；数据归属采样观测时刻，不推算跨日流量。独立运行内核时记录默认关闭；Clash Momo 默认启用记录，关闭后历史查询 API 返回 503，状态接口仍可用。按日查询最多覆盖 366 个日历日，聚合时区在数据库初始化时固定。

配置、API、记录边界和数据迁移详见 [流量历史文档](docs/traffic-history.md)。Smart 行为及其上游功能请参考 [Mihomo Smart](https://github.com/vernesong/mihomo)；Mihomo 的通用配置和控制接口请参考 [上游文档](https://wiki.metacubex.one/)。

## 维护与发布

源码和发布位于 `fansion314/momo` 的 `mihomomo` 分支。包版本为 `1.19.33-1`，标签为 `mihomomo-v1.19.33-1`。CI 在 Arch 中以普通用户执行检查、构建、安装和能力验证，然后签名软件包并发布配方包。发布需要仓库的 `ARCH_SIGNING_PRIVATE_KEY`、`ARCH_SIGNING_PASSPHRASE`、`ARCH_SIGNING_KEY_ID`，以及用于通知下游的 GitHub App `DISTRIBUTION_APP_ID` 和 `DISTRIBUTION_APP_PRIVATE_KEY`。已发布的标签和资产不可覆盖。

分支历史仅保留一条上游快照基线和后续维护提交，上游来源记录在 `UPSTREAM.json`。更新时在干净工作区 fetch 对应上游分支，生成 `UPSTREAM.json` 所记提交到新上游提交的完整二进制补丁，以 `git apply --3way --index` 应用，审阅冲突并运行验证，更新来源记录后创建新的维护提交。不要直接 merge 上游分支或推送上游 refs，以免重新引入旧历史；不要恢复上游多平台发布工作流。

## 致谢与许可

感谢 [Mihomo Smart](https://github.com/vernesong/mihomo)、[Mihomo](https://github.com/MetaCubeX/mihomo)、[Clash](https://github.com/Dreamacro/clash)、[sing-box](https://github.com/SagerNet/sing-box)、[go-shadowsocks2](https://github.com/riobard/go-shadowsocks2)、[v2ray-core](https://github.com/v2ray/v2ray-core)、[wireguard-go](https://github.com/WireGuard/wireguard-go)、[clash-plus-pro](https://github.com/yaling888/clash-plus-pro) 和所有贡献者。

本项目依照 [GPL-3.0](LICENSE) 发布。上游 README 的原始命名声明保存在 [NOTICE.upstream.md](NOTICE.upstream.md)。


### Momo macOS 受管模式

`mihomomo --momo-capabilities` 输出 JSON 能力协议：`protocol: 1`、`version` 和 `managedMode`（仅 macOS 为 true）。常规 CLI 与 Linux 启动方式保持原有行为。

macOS 专用 helper 以 root 启动 `mihomomo --momo-managed -d <workdir> -f <workdir>/config.yaml -ext-ctl-unix <workdir>/core.sock`。工作目录必须位于 `/Library/Application Support/world.fansionia.clash-momo/` 下，由 root 所有且权限为 `0700`；所有祖先及已有资源都必须由 root 所有、不可被组或其他用户写入。符号链接、普通文件硬链接、特殊设备和目录外路径会被拒绝。helper 必须把配置及其引用资源复制为独立的受保护文件，不能直接引用用户目录。

该模式只开放 `0600` Unix 控制 socket，忽略配置中的其他控制器及外部 UI，禁止 shell hooks、内核自重启和升级；配置重载、provider、数据库及 geo/model 文件读取仍受路径约束。helper 应提供最小环境，仅按需传递 `CLASH_AGE_SECRET_KEY`，不继承路径安全绕过变量。
