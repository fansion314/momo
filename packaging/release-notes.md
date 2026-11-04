Mihomomo 1.19.33-5 修复 macOS 服务模式的功能兼容，与 Clash Momo 2.0.4-6 配套。

- 恢复服务模式的 GeoData、LightGBM 模型维护 API，保留模型更新校验和既有历史数据。
- NTP 的显式 `write-to-system` 设置在服务模式与普通运行中保持一致，不再被静默关闭。
- 公共控制器、WebUI 和生命周期管理由新版 Clash Momo 的普通用户进程接入；受保护内核继续通过本地 socket 与 helper 通信。
- Tizi 功能保持撤回，已有账户和账本不删除。

- Arch Linux x86_64 与 macOS 15+ ARM64 继续通过 fansionia packages 分发。
- 新增 Windows 10/11 x64 内核 ZIP、来源清单和 SHA-256。Windows 仅发布 GitHub Release；Clash Momo Windows 安装包和便携包已内置此版本内核，无需另装。
- macOS 用户升级内核后，请在 Clash Momo 内核设置中更新网络服务，使受保护的内核副本同步升级。
- Windows 原生 CI 检查内核启动、实际代理通信、流量历史持久化、TUN 创建/通信/清理；管理员 runner 不代表人工完成过 UAC 确认/取消交互。
