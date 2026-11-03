Clash Momo 2.0.4-5（macOS r5），配套内核仍为 Mihomomo 1.19.33-4。

- 恢复窗口缩放问号提示，设置及内核设置按 Arch、macOS、Windows 显示正确的更新方式。
- 用量概览新增代理下载量、代理上传量、总代理流量。代理流量按最终出口非 DIRECT 计算，与所选时间范围和筛选条件一致。
- macOS 网络服务 helper 改用 Rust，保留协议和既有数据，优化快照内存、文件访问安全及网络设置操作。
- Windows 安装版支持应用内更新：默认使用 CNB 镜像，可切换 GitHub Release；默认启动后及每 24 小时检查，仅提示，由用户分别确认下载和安装。
- Windows 便携版支持检查更新及下载 ZIP，退出后手动替换程序文件，保留 PORTABLE 和 data。安装版和便携版均内置精确配套的 mihomomo.exe，无需另装内核。
- 更新清单使用 Ed25519 签名，下载文件验证大小与 SHA-256。Windows 程序仍未进行 Authenticode 签名，同时提供 SHA-256 校验文件。
- 2.0.4-4 尚无应用内更新功能，首次需要手动安装本版本；安装版升级、重装及默认卸载保留用户数据。
- macOS 请更新 Clash Momo 应用，然后在“内核设置 → 更新网络服务”授权安装 Rust helper，并同步受保护的内核副本。内核继续使用 1.19.33-4。
- Arch 和 macOS 继续既有 fansionia packages 分发；packages 新增的 Windows 同步仅镜像 Clash Momo 的安装包、便携包及更新元数据，不提供额外 Windows 包管理渠道。

Tizi 功能保持撤回，已有 Tizi 账户和加密账本继续保留。请将客户端与配套内核一起更新，避免使用旧 2.0.4-3 客户端搭配新内核。

交互式 UAC 确认/取消、完整 Windows 客户端 TUN 路由、macOS 桌面授权与全流量 DNS 恢复，必须以实际桌面实测记录为准；管理员 runner 的验证不代表这些交互已经覆盖。详细验收和性能测量将在验证记录中列出。
