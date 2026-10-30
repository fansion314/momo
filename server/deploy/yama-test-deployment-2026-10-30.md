# yama 测试部署：保留旧服务

用户最终约束：测试阶段保持原静态订阅、Basic Auth 用户/密码、clash-convert 配置与包装脚本完全不变。新功能与旧服务并行，不执行正式迁移。

## 当前架构

- 原 Caddy 服务继续处理 `sub.yama.fansionia.world`，保留原静态文件、Basic Auth 和 clash-convert 动态设置的 `Subscription-Userinfo`。
- 独立 Rust 用户服务 `tizi-server.service` 监听 `127.0.0.1:9876`。
- 独立用户 Caddy `tizi-proxy.service` 监听 `127.0.0.1:9878`，管理接口仅 `127.0.0.1:2021`，反代 Rust。
- 独立 `tizi-header-mirror.timer` 每 60 秒只读原 Caddy `localhost:2019/config/` 的该域名 Header，再更新独立代理的配置。原 Caddy、转换器及文件不被此任务写入。源读取失败时保留最近有效 Header。
- Cloudflare Tunnel 路由由主 Agent 单独配置：仅 `tizi.fansionia.world` 的 `/v1/*` 与 `/healthz` 去独立测试代理；旧的静态订阅路径继续走原 origin。
- 没有内部静态文件新监听器或 Docker 网络改动；测试代理不依赖 Docker bridge 启动顺序。

## 服务与数据

在 yama 以 `fansion` 登录后，无需每次传数据库路径：

```sh
tizi-server pending
tizi-server approve person@example.com
tizi-server users
tizi-server devices person@example.com
tizi-server stats
```

这些命令默认访问 `/home/fansion/.local/share/tizi-server/tizi.db`，与当前服务单元显式指定的数据库相同。审批是真实操作，会发送注册验证码；核对邮箱后再运行。需要临时操作其他数据库时，使用 `--database` 或 `TIZI_DATABASE` 显式覆盖。

用户服务使用现有 `fansion` 用户，`loginctl` 已确认 `Linger=yes`。数据目录为 `/home/fansion/.local/share/tizi-server`，目录 0700，配置/数据库/pepper 0600，二进制 `/home/fansion/.local/bin/tizi-server`。

SMTP 设置在 yama 本机从 Taskbell 已有通知邮件配置读取，写入独立 0600 EnvironmentFile；没有输出、提交凭据，也未发送真实测试邮件。任务只添加独立应用服务和 Header 同步定时器，不自动编译。

Rust 当前发布配置来自读取现有 `/srv/新团购tizi` 后手动 `publish`。旧转换流程没有添加新发布命令。需要更新测试订阅快照时，手动执行：

```sh
/home/fansion/.local/bin/tizi-server \
  --database /home/fansion/.local/share/tizi-server/tizi.db \
  publish --file /srv/新团购tizi
```

## 恢复记录（持久恢复已完成）

最初按正式迁移计划修改过 Caddy runtime，且用户执行过 root 安装；用户明确测试阶段保留旧服务后，已立刻恢复原静态+Basic Auth runtime，并将转换器配置和包装脚本按私有备份逐字节恢复。原凭据未改变。旧 migration 入口已停用，避免误执行再次迁移。

私有备份位于 yama `/home/fansion/.local/share/tizi-server/backups/20261030-160422`，包含原 Caddyfile、原 runtime JSON（含当时动态 Header）、转换器配置、包装脚本和原生成文件。备份目录 0700、文件 0600；备份可能含敏感内容，不能上传仓库。

用户已执行准备好的 root 恢复命令：

```sh
sudo /home/fansion/.local/share/tizi-server/restore-caddy.sh
```

脚本源可参考同目录 `yama-restore-caddy.py`：验证原配置、备份现状、按原 UID/GID/mode 原子替换、reload，再保留已恢复的动态 runtime Header。成功后生成 `legacy-durable-restored` 标记。原 `install-caddy.sh` 也已改为同一恢复动作，避免旧命令再次迁移。

已核实原 `/etc/caddy/Caddyfile` 与私有原备份逐字节相等，且 `legacy-durable-restored` 标记存在。原服务的运行时及磁盘配置均已恢复，独立测试代理不依赖原 Caddy 新增路由。

## 已验证

- Linux release 手动构建并保持 sccache；通过 `CFLAGS=-std=gnu11` 避免引入新 GLIBC 字符转换符号，最高 GLIBC 需求 2.34，yama 系统 2.36。
- 构建产物 SHA256：`fb1b905774b8a848887d556606a9e9013562eec7c25b860df900d8a4750716ea`；传输后再次校验，实际 `--version`、`ldd` 与服务启动成功。
- 原静态入口：未认证 401，使用原本既有凭据 200，原 Header 保留；转换器配置和包装脚本逐字节等于原备份。
- 新 Rust `/healthz` 200，独立代理 `/healthz` 200、未认证 `/v1/subscription` 401、普通文件路径 404；独立代理 Header 与原服务精确一致。
- `tizi-server`、`tizi-proxy`、`tizi-header-mirror.timer` 均 active。
- 使用独立服务 EnvironmentFile 完成 SMTP STARTTLS、证书校验、账户认证与 NOOP，全部成功；未执行 MAIL/RCPT/DATA，没有发送任何邮件或创建注册/审批记录。真实邮件投递仍未测试。
- Cloudflare 路径分流上线后，公网 `tizi.fansionia.world/proxies.yaml`：未认证 401，原凭据认证 200，两种响应的原 Subscription-Userinfo 字段均正常。

Cloudflare Tunnel 配置由版本 18 更新到 19，仅在原 `tizi.fansionia.world` 兜底规则前增加路径规则 `^/(v1/.*|healthz)$`，目标 `http://127.0.0.1:9878`。原域名兜底、其他域名和 DNS 均未修改。变更前配置见 `yama-tunnel-before.json`。

公网验收（原生客户端 User-Agent）：`https://tizi.fansionia.world/healthz` 返回 200/ok；`/v1/subscription` 返回 401，且不再要求旧 Basic Auth；旧 `/proxies.yaml` 在公开域名和原 origin 均返回 401/Basic Auth。以上响应均保留 `Subscription-Userinfo`。原 Caddyfile 持久恢复已再次逐字节核对。

## 注册审批

用户在测试客户端提交邮箱申请后，在管理机执行：

```sh
ssh yama 'tizi-server pending'
ssh yama 'tizi-server approve user@example.com'
```

第二条命令会按产品流程向该申请邮箱发送验证码，应替换为实际申请地址。部署验收没有执行真实邮箱审批或投递。

## CLI 默认数据库修复（同日手动更新）

统一数据库定位规则已部署：`--database` 优先，其次 `TIZI_DATABASE`；普通用户按绝对 `XDG_DATA_HOME` 或 HOME 的 `.local/share`，root 未覆盖时使用系统 `/var/lib/tizi-server/tizi.db`。yama 的 HOME 为 `/home/fansion`，未设置 XDG_DATA_HOME/TIZI_DATABASE，因此 `tizi-server pending` 直接访问现有部署数据库。`init`、`serve` 和所有管理命令使用同一定位器；现有用户服务显式数据库参数保持不变。

- 本地 macOS 与 Linux x86_64 共 15 项测试通过（11 项 API/计量测试 + 4 项纯函数路径规则测试），严格 Clippy 与格式检查通过。
- 新手动构建产物 SHA256：`2c7cdc159589ce8736b0d53239a6bef5571f7b8f8d9e2f3495800fe6543ccc0e`，最高 GLIBC 需求仍为 2.34。
- 仅原子替换 tizi-server 二进制并重启独立 Rust 服务；现有用户、设备、用量、周期、outbox 行和 pepper 均核对未改变，数据库 quick_check 为 ok。未执行 init、注册、审批或测试邮件。
- 原 Caddyfile、转换器配置/包装脚本以及原用户服务单元哈希均未变化。
- 已执行实际 `ssh yama 'tizi-server pending'`，退出 0，返回空列表（当前没有待审批申请）。
- 私有回滚备份：`/home/fansion/.local/share/tizi-server/backups/cli-default-20261030-170544`，包含在线数据库备份、pepper、更新前 0.1.0 二进制及 SHA 元数据，均留在受保护目录中。
