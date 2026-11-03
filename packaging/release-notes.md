稳定版撤回 Tizi 团购订阅功能，保留本地流量历史、Smart 和 macOS 特权服务模式。已有流量数据库与普通订阅兼容；不清除 Tizi 账户或账本。Tizi 实验成果保存在 `codex/experimental-tizi-mihomomo` 分支，历史发布保持不变。

- Arch Linux x86_64 与 macOS 15+ ARM64 继续通过 fansionia packages 分发。
- 新增 Windows 10/11 x64 内核 ZIP、来源清单和 SHA-256。Windows 仅发布 GitHub Release；Clash Momo Windows 安装包和便携包已内置此版本内核，无需另装。
- macOS 用户升级内核后，请在 Clash Momo 内核设置中更新网络服务，使受保护的内核副本同步升级。
- Windows 原生 CI 检查内核启动、实际代理通信、流量历史持久化、TUN 创建/通信/清理；管理员 runner 不代表人工完成过 UAC 确认/取消交互。
