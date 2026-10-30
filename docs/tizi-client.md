# 新团购 tizi 客户端

macOS 正式软件包使用 Homebrew tap `fansionia/tap`。更新内核使用
`brew upgrade --formula fansionia/tap/mihomomo`，更新客户端使用
`brew upgrade --cask fansionia/tap/clash-momo`。本次独立测试包内置配套内核，
使用独立配置目录与端口，不替换已安装的客户端或 Homebrew 内核。

正式客户端默认启用本模块。主进程、preload 与 renderer 使用同一个编译期开关；
设置 `MOMO_TIZI_ENABLED=false` 可构建不含团购入口的版本，关闭时不注册团购 IPC，也不访问服务器。
正常发布继续使用 `world.fansionia.clash-momo` 与系统 Homebrew 内核，不使用测试包的配置目录或端口。

客户端需要配套启用 `tizi` build tag 并注入本地加密构建密钥的 Mihomomo。
正式版本需要 `mihomomo-v1.19.33-3` 或更新的配套内核，以应用受管 DNS 与 Smart 策略。
Electron 不包含加密私钥，也不读取或导出完整团购订阅。客户端通过原生 JSON
接口处理注册、验证、登录、订阅更新和用量同步；密码只经标准输入传递，不写入进程参数或日志。

受管订阅激活后，客户端只生成 `tizi-managed` 状态目录引用与有限的运行设置。
节点与基础配置由内核从加密缓存读取。私人订阅和简易模式的节点编译不会参与受管配置，
选择私人订阅时完整重启内核。登录后，普通订阅列表显示“新团购tizi订阅服务”的只读元数据卡片，
可以像普通订阅一样选中；卡片不提供配置查看、编辑、删除或导出入口，后端也拒绝这些操作。
节点 YAML 从不进入普通订阅文件。使用团购时列表的有效当前配置为虚拟 `tizi-managed`，
磁盘中仍保留上一个私人配置 ID，切回私人订阅时恢复该选择。

受管内核保持静默日志。客户端通过本地 API 验证配置和实际代理出站已加载后才确认启动成功，
不依赖标准输出中的启动日志。账户本地状态、配置切换与远端用量查询分开处理，
远端请求超时或后台补报不会阻塞本地状态展示或激活操作。

团购配置尊重 DNS、Hosts、嗅探覆写开关及 nameserver-policy 设置；DNS 覆写启用时，
完整的用户 DNS 设置会与 TUN 设置一起送入内核，避免只劫持 DNS 却未启用解析器。
最终 DNS 禁用时内核清除 DNS 劫持。Smart 开关及 LightGBM、采集与大小参数以结构化策略送入内核，
由内核在内存中转换代理组；不会把订阅明文交给 JavaScript 覆写脚本。

受管订阅激活期间，远程控制器和 WebUI 不可用，应用内部 Unix socket/pipe 保留。
本地和 WebDAV 配置备份、恢复、备份管理与 Gist 配置同步由后端拒绝执行。
这些操作不修改用户原有备份或控制器设置，切回私人订阅后恢复。

macOS 安装了特权服务时，所有原生操作通过服务端固定的团购状态目录执行，
该目录位于普通配置快照目录之外，不接受用户快照覆盖。客户端持久保存首次绑定的状态目录，
启用或禁用服务导致目录变化时会拒绝团购操作；退出登录也不清除绑定，防止当天尚未结算的账本遗失。
当前不支持自动迁移，应恢复原运行方式完成上报后由管理员处理迁移。

特权服务运行团购配置时，普通用户进程不会对 root 专属账本目录执行本地 `-t` 预检查。
服务在启动或重载前始终以 root 身份对实际配置快照执行 `--momo-managed -t`；
此强制检查不受“启动时检查配置文件”选项影响，失败时拒绝应用配置并保留原状态。
私人配置、Linux 以及未使用特权服务的团购配置仍按原选项执行本地检查。

服务端接口见独立 `tizi-server` 分支。Caddy 继续由 clash-convert 设置
`Subscription-Userinfo`，客户端套餐额度/截止日期与个人每日、周期上报用量分别展示。

本地加密阻止直接查看和普通文件篡改，不承诺对设备所有者的主动逆向或修改程序提供可信计量。

## 独立 macOS ARM64 测试包

`packaging/macos/build-tizi-test.py` 从临时源码快照构建测试包，原工作区 `dist/` 不受影响：

```sh
python3 packaging/macos/build-tizi-test.py \
  --core-source /absolute/path/to/mihomomo \
  --key-file /private/path/to/build-keys \
  --output /absolute/path/to/new-output-directory
```

密钥文件权限必须为 `0600`，内容为 `key-id:base64-32-byte-key`。构建时只在临时 Go
源码中注入密钥，编译后删除，不把密钥放进 Electron 资源、命令行或 Go 构建元数据。

测试包标识为 `world.fansionia.clash-momo.tizi-test`，配置目录为
`clash-momo-tizi-test`，使用随包提供的配套内核；默认代理端口为
`17890`（mixed）、`17891`（SOCKS）和 `17892`（HTTP）。它不注册正式版的 URL
协议或文件关联，也不会连接、安装或卸载现有的 macOS 特权服务。
该包用于普通代理模式验证；TUN、系统代理和系统 DNS 的服务集成需要正式配套安装另行验收。
