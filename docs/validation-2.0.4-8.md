# Clash Momo 2.0.4-8 发布与验收记录

2026-11-05 正式发布 Clash Momo 2.0.4-8（macOS r8），配套 Mihomomo 1.19.33-5。GitHub 正式附件、Homebrew 主源/CNB 镜像、paru 配方和 Windows 更新镜像已验证；全仓库 pacman 快照激活仍被第三方 Denial 上游 404 阻塞，未绕过该检查。

## 固定来源

| 项目             | 固定值                                     |
| ---------------- | ------------------------------------------ |
| 客户端标签       | `clash-momo-v2.0.4-8`                      |
| 客户端源码       | `e2f88616c8dafb08f6545fca411af36949b6ad7f` |
| 内核标签         | `mihomomo-v1.19.33-5`                      |
| 内核源码         | `843abbe5bb61a2e5752c21f9f47d60d71d191efb` |
| 应用 ID          | `world.fansionia.clash-momo`               |
| helper 实现/协议 | 实现 4，兼容 Protocol 1                    |

[正式客户端 Release](https://github.com/fansion314/momo/releases/tag/clash-momo-v2.0.4-8)；[配套内核 Release](https://github.com/fansion314/momo/releases/tag/mihomomo-v1.19.33-5)。r6/r7 保留原标签和未发布 draft，未改写历史，也未向普通更新用户发布。

## 修复范围

详细来源及影响项见 [macOS 功能审计](macos-functionality-audit-2026-11-04.md)。

- 修复中文、空格、Emoji、斜杠等编码分组名称被 helper 拦截，恢复切换、测速、Provider 更新及 Smart 权重访问。
- 普通用户进程提供 TCP/TLS/Unix 公共控制器、密钥认证、CORS、HTTP/WebSocket 和 WebUI；TLS 客户端证书选项及默认 CA 行为与内核一致。
- 补齐取消固定、规则禁用、Smart 缓存、GeoData/模型维护及 WebUI 状态存储。外部面板的重启、重载和升级由应用处理，受保护二进制替换仍沿用系统授权。
- 支持配置引用的用户可读目录外资源和符号链接，先在普通用户下验证/物化，再导入受保护目录；停止后按记录回传变化，保留运行期间用户另外更改的源文件。
- Smart 状态读取实际运行副本；配套内核保留用户显式 NTP 设置。操作失败显示错误，外部重载与生命周期操作串行，成功后刷新桌面。
- 原生 GUI 验收发现 r7 大资源回传拖慢重启：小块 base64 写入频繁触发背压，状态查询又等待生命周期锁。r8 使用有界 64 KiB 缓冲和内容摘要增量回传，状态从原子运行态与不可变安装信息读取，保持响应；旧数组导出请求仍兼容。

## 源码检查及隔离验证

- Format、Lint、node/web/test 类型检查、Git hooks 均通过，未绕过 hooks。Vitest 730 项通过、1 项按平台跳过；Windows 原生检查由 Windows CI 执行。
- macOS Rust helper 31 项测试、fmt/clippy 通过。普通用户运行时 root 专用测试可能提前返回，因此不将该汇总冒充本机 root 验收。
- 按 CROSS_PLATFORM 约定增量同步到既有 xjtuse-arch-dev，排除本机构建产物；隔离容器 root 下 30 项及 clippy 通过，实际覆盖大资源 HTTP 导出、未变内容跳过、持生命周期锁时 status/lease 仍响应、受保护文件、事务和会话。保持 sccache。
- 本机完整 ARM64 app 构建、deep/strict codesign、revision 8 和原生模块加载通过。没有在用户开发机安装/替换应用、网络服务或 Homebrew 内核，也没有修改实际代理/DNS。
- 本机 Go 1.27.3 的上游 XHTTP 并发测试曾出现 closed pipe/reset；配套内核 Go 1.26 三平台全量及规定竞态检查全部通过，干净环境没有复现。

## 原生安装包验收

[精确源码正式流程 41946696463](https://github.com/fansion314/momo/actions/runs/41946696463) 全部成功，三平台检查、Arch 构建、签名、发布和分发通知均完成。

macOS 原生 GUI 证据 `clash-momo-helper-validation/macos-controller.json` 九项全部为 true：正常关闭首次引导、点击真实节点卡片切到节点 B、无 preload 的独立 HTTP WebUI 切回节点 A、跨域、WebSocket、状态存储、完整重载、实际 PID 变化的重启及退出后内核停止。截图 `macos-proxy-selection.png` 和 `macos-external-webui.png` 已下载并目视核对。另覆盖 Go→Rust 升级、重复安装、SQLite 保留、真实 utun 创建/清理、UID/session 边界及 lease 到期。

Windows 验收证据确认受控 r7→r8 真实 NSIS 更新、签名/坏下载拒绝、下载/安装分别确认、普通权限调用者重启、原目录及配置/历史保留、便携 ZIP 下载；另独立下载并校验公开 r4 安装包，真实执行 r4→r8 覆盖升级并复核旧/新各自配套内核。测试编排修正了旧的 r4→r5 硬编码及旧包误按新内核校验的假设，未跳过升级验证。

以上是原生 CI 自动验收；开发机物理网络、人工授权确认/取消等没有冒充已完成。

## 公开附件独立验证

正式公开后下载全部 14 项附件，逐一核对 GitHub digest、大小及 checksum 文件；验证 Arch detached GPG、Windows Ed25519 更新签名及其 installer/portable 摘要和源码绑定。macOS 公开 tar.gz 解压后 deep/strict codesign、ID、revision 8 和没有内置额外内核均通过。Windows ZIP 内 exe 摘要、配套内核 tag 和完整许可证均通过，许可证按 CRLF/LF 规范化比对。

| 产物                  | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| macOS ARM64 r8 tar.gz | `d2619dce090dd6b84e21443df68a782b22d9ed45429741aac3b0d36758d89ae5` |
| Windows setup.exe     | `f464947d3ccf01ad3f5229c2edf91fc5f72f40a2967f894b362ef9988b8a6602` |
| Windows portable.zip  | `98e3be61132388d1a95d63463e08d953646aa3745fca66161a52994893fa69be` |
| Arch pkg.tar.zst      | `617b30b016d69e0a9f5cac24fe3d49fb76c0629cad6ebe2b690637fefdc39d6d` |

## 分发状态

[packages 分发 41948553132](https://github.com/fansion314/packages/actions/runs/41948553132)：

- Homebrew sync、CNB mirror 和 mirror-public 均成功；GitHub 主 tap 的 Cask 为 `2.0.4-8,8`，公开镜像安装/切换验收通过。逻辑 tap 继续为 fansionia/tap。
- paru source/bin 配方同步成功，aur/state/clash-momo.json 引用 r8。
- Windows 镜像成功；独立匿名读取 CNB 公共 feed，签名 payload 的 tag=clash-momo-v2.0.4-8、revision=8。
- pacman 快照签名、Pages 上传及 CNB 候选验证成功，但主候选下载 Denial/denial-flutter-engine 时 404；独立探测原始 URL 同样 404。该问题在本轮发布前任务 41940619871 已存在。全仓库 Worker 激活与 retention 保持未执行，没有删包或绕过既有验证要求；Clash Momo 的 GitHub Arch 包、签名和 paru 配方可用。

macOS 更新应用及配套内核后，应完全重启应用，并从“内核设置 → 更新网络服务”授权同步 helper 4 和受保护内核副本。
