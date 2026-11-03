撤销尚未成熟的 Tizi 团购功能，恢复普通订阅与本地流量统计，保留轻量模式和 macOS ARM64 特权网络服务。普通订阅、设置及流量历史保留；既有 Tizi 账户和账本不删除，实验代码已保存至独立实验分支。

- Windows 10/11 x64 新增 NSIS 安装版及便携 ZIP，均内置精确配套的 mihomomo 1.19.33-4，用户无需另外安装内核。
- Windows 便携版解压即可运行，数据保存在程序旁的 data 目录；安装版数据保存在 %APPDATA%\clash-momo，升级、重装和默认卸载均保留数据。
- Windows 普通代理无需管理员权限；启用 TUN 时沿用 Clash Party 的 UAC 重启流程。程序尚未进行 Authenticode 签名，提供 SHA-256 校验文件。
- macOS 用户升级后，请在“内核设置”中更新网络服务，使其受保护的内核副本同步至 1.19.33-4。
- Arch Linux 和 macOS 继续原有 fansionia packages 分发；Windows 仅发布 GitHub Release。

交互式 UAC 确认/取消需在实际桌面环境验收；管理员 CI runner 的验证不代表覆盖该交互。
