Clash Momo 2.0.4-9（macOS r9），配套内核为 Mihomomo 1.19.34-1（macOS r6）。

- 升级包含 MetaCubeX v1.19.34 的 Alpha 内核快照，保留 Smart、流量历史、每日聚合及现有平台适配。
- 节点编辑器支持选择新内核提供的 Snell 6。
- Arch 源码与二进制配方要求新内核；Windows 安装版、便携版内置此精确配套版本。
- macOS 服务验收按配套元数据检查实际内核版本，并回归既有 helper 升级、节点切换和控制器行为。

macOS 请先升级配套内核与应用，再在“内核设置 → 更新网络服务”授权同步受保护副本。Tizi 继续保持撤回，已有账户和加密账本保留。

Windows 安装版和便携版继续支持签名更新清单、大小及 SHA-256 校验，默认 CNB 镜像，可切换 GitHub。安装版确认后下载和安装，便携版退出后手动替换程序文件，保留 PORTABLE 和 data。Windows 程序未进行 Authenticode 签名；macOS 使用 ad-hoc 签名。

原生 CI 不能代替交互式 UAC、macOS 桌面授权与物理网络验收。现有用户数据、应用身份及配置目录保持兼容。
