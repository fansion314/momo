Mihomomo 1.19.34-1（macOS r6）同步包含 MetaCubeX v1.19.34 的 vernesong/Alpha 快照，与 Clash Momo 2.0.4-9 配套。

- 固定上游快照 `2e6fc107c403ca607714f1613a758e66f12d16e9`，以上一快照为基线应用增量补丁。
- 新增 Snell v6、Shadowsocks 多用户监听和密钥生成，修复 HTTP CONNECT 首包、HTTPUpgrade 链接转换、SSH 连接关闭及 TUN 自动路由。
- 同步上游 EasyTier、sing、sing-tun 与 uTLS 依赖；保留 Smart、流量历史、每日聚合及 macOS 受保护服务功能。
- Tizi 功能保持撤回，已有账户和账本不删除。

Arch Linux x86_64、macOS 15+ ARM64 和 Windows 10/11 x64 继续提供正式资产与 SHA-256。Arch 包附带签名；macOS 内核采用 ad-hoc 签名。Windows 客户端内置精确配套内核，无需另装。

macOS 用户升级内核与客户端后，请在 Clash Momo“内核设置 → 更新网络服务”完成授权，使受保护副本同步升级。原生 CI 验证不能代替人工 UAC、桌面授权和物理网络验收。
