# Clash Momo 2.0.4-5 验收记录

本记录对应 2026 年 11 月 3 日的正式发布。应用版本保持 2.0.4，仅将打包 revision 增至 5（macOS r5），配套内核仍为 1.19.33-4。

## 固定来源与改动

| 项目                 | 固定值                                     |
| -------------------- | ------------------------------------------ |
| 客户端标签           | `clash-momo-v2.0.4-5`                      |
| 客户端提交           | `f5e9a14bc9d743c4738f2f37b71325ee7c6fed95` |
| 内核标签             | `mihomomo-v1.19.33-4`                      |
| 内核提交             | `bff94c11042c507ec0049bd43f8d495efd3e62d1` |
| 应用 ID              | `world.fansionia.clash-momo`               |
| 首个独立界面修复提交 | `c24ba27c226408bd3b7b5359b8ccb0a2c5956172` |

- 恢复窗口缩放问号提示；设置及内核页按平台显示 pacman、Homebrew 或内置内核更新说明，并处理窄窗口换行。
- 概览增加代理下载、代理上传和总代理流量。按相同查询范围和筛选条件，用完整总量减去最终出口为 DIRECT 的总量，避免代理排行榜截断漏算；不更改内核 API 或数据库格式。
- macOS helper 使用 Rust，保留 Protocol 1、CLI、服务路径和既有数据格式。增加目录文件描述符保护、流式快照、有界日志和并发、租约取消及 SystemConfiguration 操作；快照提交失败时一起恢复磁盘、元数据和运行态，失租时保持停止。
- Windows 安装版提供 CNB（默认）或 GitHub 更新，默认启动后及每 24 小时检查，仅提示；下载与安装分别确认。便携版只下载经校验的 ZIP，由用户退出后手动替换。
- Tizi 保持撤回，实验分支、旧标签和旧附件保留，既有账户和加密账本不删除；本轮未修改 tizi-server 或内核源码。

## 正式发布与公开附件

- [正式 Release](https://github.com/fansion314/momo/releases/tag/clash-momo-v2.0.4-5)。
- [精确源码三平台检查 41630677679](https://github.com/fansion314/momo/actions/runs/41630677679)：全部成功。
- [正式发布 41632569809](https://github.com/fansion314/momo/actions/runs/41632569809)：三平台检查、Arch 构建、签名、发布及分发通知全部成功。

公开发布后独立下载全部 14 项附件，逐一核对 GitHub SHA-256 digest、大小及校验文件；另验证 Arch detached signature、macOS app ID/r5 和 helper 文件、Windows 便携包内精确内核及完整许可证、Ed25519 更新签名和绑定的附件/内核来源。Windows 更新清单的可信 key ID 为 `momo-windows-2026`，公钥同时固定在客户端和 packages 源码中；私钥仅位于 momo 发布流程的 Actions secret。

## Windows 原生验收

[正式 Windows 任务](https://github.com/fansion314/momo/actions/runs/41632569809/job/125905624944) 45 项检查全部通过，并完成以下实际程序验证：

- 安装版和便携版均包含精确配套的 mihomomo.exe、资源和许可证；验证客户端实际启动该子进程、named-pipe API、真实代理请求、统计入库、重启保留及退出后进程清理。
- NSIS 安装、重装、默认卸载保留数据；便携目录实际移动后重启保留数据。路径覆盖中文、空格、单引号与 `$()` 字面字符。
- 受保护安装副本的大小和 SHA-256 复验、SYSTEM/Admin ACL、原目录参数、原进程退出等待和 staging 清理；在更新进程存活时真实改名旧安装目录，证明未继续占用该目录。
- 受控、未发布的 revision 4 更新夹具验证 CNB 元数据、坏签名、坏下载拒绝、下载/安装分别确认，实际安装正式 revision 5 包，并观察原目录客户端重启和历史保留。
- 原调用者重启夹具比对 SID、TokenElevationType、提升状态和 SessionId。安装完成通过随机命名管道通知普通权限监听器，由该监听器启动客户端；不依赖 Explorer，不新增 Windows 服务。
- 实际便携客户端从 GitHub 来源发现版本并保存 ZIP，核对文件摘要，确认未自动安装；启动初始化不会误取消已经开始的手动下载。
- 独立下载未修改的公开 `-4` 安装包，复核 API digest 与校验文件，以真实旧程序生成测试流量与普通本地订阅，再手动覆盖安装 `-5`，核验订阅、配置和流量历史保留，运行新客户端代理及重启验收。
- 800×700 实际窗口截图覆盖更新设置、内核设置及九张流量卡片；Windows 内核页无 pacman 文案，DIRECT-only 测试数据的三项代理量为零。

公开旧版安装包 SHA-256 为 `5f0c8482bd21d3b3de6a2c0459719d818ffa37a8d7dbcbc55139966ebd27c725`。受控 revision 4 夹具与真实公开旧版覆盖升级是两项独立测试；旧 `-4` 本身不具备新更新器。

## macOS 安全、升级与资源占用

[正式 macOS 任务](https://github.com/fansion314/momo/actions/runs/41632569809/job/125905624763) 完成 29 项原生测试、Rust fmt/clippy、安全及并发回归，并实测：Go→Rust 服务升级、旧 SQLite 数据保留、重复安装、UID/session/API 边界、真实内核/历史 API、utun 创建及清理、租约到期停止和实际应用/Homebrew 内核启动。原生网络往返使用专用、已禁用的一次性网络服务，覆盖代理与 DNS 恢复。

事务回归通过真实原生子进程，覆盖 imports/migrated 写盘故障与首次启动、同密钥重载、换密钥重启、失租取消的 8 种组合。验证失败后数据和元数据恢复；有效旧会话恢复旧内核，取消会话保持停止；恢复失败保留受保护备份。

同一 runner、没有运行内核的 helper 基准：

| 场景       | Go helper RSS | Rust helper RSS |
| ---------- | ------------: | --------------: |
| 空闲中位数 |      8992 KiB |        4112 KiB |
| 续租中位数 |      9096 KiB |        4160 KiB |

空闲 RSS 下降约 54%。独立解析约 64 MiB decoded / 89,478,484 字节 wire 快照的测试，进程峰值为 6,045,696 字节（5.77 MiB），相对解析前的峰值增量为 2,113,536 字节（2.02 MiB）。该项测量独立测试进程，不是整套客户端或内核的内存。CPU 读数接近短时采样精度，不据此宣称稳定的 CPU 降幅。

macOS 用户更新应用和 Homebrew 内核后，应通过“内核设置 → 更新网络服务”授权同步 Rust helper 和受保护的内核副本。

## 下游分发验收

[联合分发 41635636995](https://github.com/fansion314/packages/actions/runs/41635636995) 的 15 个任务全部成功，完成以下实际消费者验收：

- Homebrew GitHub 主源实际安装、升级、重装并启动客户端，确认配套核心与流量历史就绪；CNB 候选安装、公开双源切换及完整 tap 安装均通过。
- AUR 源码与二进制配方均为 2.0.4-5、源提交 f5e9a14b，二进制配方通过真实打包安装，依赖继续为 mihomomo >=1.19.33-4。
- pacman 主源和 CNB 镜像的候选与正式域名真实安装均通过；客户端为 2.0.4-5，配套内核为 1.19.33-4。主站与镜像 active 均为 `9f3a274eb24b21d4148072584122873f`，清理后保留此前成功快照 `cb00632dd59d9bd4cf710adea48190b9` 和新快照，mirror pending 为空、cleanup_pending=false。
- Windows 首次实际同步上传 7 个新对象，未改写旧附件；匿名完整回读后，实际运行 CNB 下载的安装版和便携版，验证内核、代理请求、历史、重启、重装及默认卸载保留数据，再公开独立 windows-updates 分支。
- Windows 公共更新清单位于 `https://cnb.cool/fansionia/packages/-/git/raw/windows-updates/clash-momo/windows-x64/latest.json`；公开信封与 GitHub 完全同字节，Ed25519 签名、客户端源码和配套内核身份独立复核成功。CNB Windows 分支为 `1a98f6d0bf3325dbf300325b1dc80d4112a0db7c`，未改写 Homebrew main。
- [重复同步 41638326513](https://github.com/fansion314/packages/actions/runs/41638326513) 成功，实际 changed=false，仅重新核对小型公共清单，没有重复上传或再次安装大包。镜像脚本使用命令级 core.autocrlf=false 保留签名信封原字节；23 项镜像测试包含真实 Git 换行转换往返回归。

Windows 镜像仅服务 Clash Momo 的安装包、便携包和更新元数据，不同步独立 Mihomomo Windows 包，不新增 Windows 包管理渠道。

## 明确未覆盖项

- 真实桌面的 UAC 确认/取消、不同管理员账户凭据，以及物理 Windows 10/11 设备交互；管理员 CI 和模拟分支不等同于这些场景。
- Windows 客户端完整 TUN 路由、DNS、外部网络通信；macOS 桌面授权、休眠唤醒、默认路由及全流量 DNS 恢复。utun 与禁用网络服务验收有意隔离这些全局设置。
- 使用真实用户的生产数据库、加密 Tizi 账户和账本进行完整升级；本轮旧版数据来自公开旧程序生成的测试数据库及普通订阅。
- Windows 程序没有 Authenticode 签名；更新元数据的 Ed25519 签名与安装程序代码签名是不同机制。
