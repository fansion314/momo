# 新团购 tizi 服务端

> 当前 yama 采用并行测试部署：旧静态订阅、Basic Auth、转换器保持不变；仅新 API 经独立用户代理提供。参见 [测试部署记录](deploy/yama-test-deployment-2026-10-30.md)。本文正式 Caddy 迁移段落仅供未来切换参考，测试阶段不要执行。

独立 Rust/Cargo 程序，位于 momo 的 `tizi-server` 分支。仅手动构建、测试、发布；没有新增 CI 工作流，也不加入客户端构建。保持默认 sccache wrapper 启用。

```sh
cd server
cargo test --locked
cargo build --release --locked
```

维护端 CLI 直接访问同一个 SQLite 数据库，可与服务进程同时运行。所有命令使用同一数据库定位规则：显式 `--database PATH` → `TIZI_DATABASE` → 普通用户的 `$XDG_DATA_HOME/tizi-server/tizi.db`（需绝对路径）→ `$HOME/.local/share/tizi-server/tizi.db`。root 未显式配置时默认 `/var/lib/tizi-server/tizi.db`。默认路径不依赖当前目录。数据库、验证码 pepper 文件、WAL 和邮件队列都应仅由服务用户访问；建议独立系统用户和 0700 数据目录。初始化生成随机 `.pepper` 文件，0600 权限；不要将它、数据库、SMTP 凭据提交源码。

```sh
# 普通用户默认使用 ~/.local/share/tizi-server/tizi.db
tizi-server init
tizi-server serve --listen 127.0.0.1:9876

tizi-server pending
tizi-server approve alice@example.com
tizi-server reject unwanted@example.com
tizi-server users
tizi-server devices alice@example.com
tizi-server revoke DEVICE_UUID
tizi-server disable alice@example.com

tizi-server publish --file /srv/your-converted-subscription.yaml
tizi-server stats --day 2026-10-30
tizi-server cycles
tizi-server cycle-open --name '第二期'
tizi-server stats --cycle 1
tizi-server backup --output /secure-backup/tizi-20261030.db
```

`init` 以当前北京时间 07:00 结算日建立初始周期。`cycle-open` 总是在下一个北京时间 07:00 生效；同一开始日重复创建会拒绝。周期占比的分母为该周期所有账户的客户端上报总量，未上报设备单独标记 `overdue_devices`。禁用用户历史用量保留。离线设备补报可修正已结束周期；这里不是即时用量，也不能证明恶意修改客户端后的真实流量。

## 邮件和注册

部署前配置 `SMTP_HOST`、`SMTP_PORT`（默认 587）、`SMTP_FROM`、`SMTP_USERNAME`、`SMTP_PASSWORD`。587 使用强制 STARTTLS，465 使用隐式 TLS；不提供明文 SMTP 降级。`serve` 缺少配置会拒绝启动。注册申请只入待审批队列；管理员同意后才生成邮件。验证码有效 10 分钟、最多尝试 5 次、60 秒内不重复签发；单邮箱每小时最多 10 封，公开接口另有频率限制。密码长度 10–128 字符，Argon2id 随机盐保存。

邮件写入持久 outbox，由服务进程异步发送，失败在有效期内指数退避重试；重启不丢队列。过期队列自动清理，日志不会打印验证码或 SMTP 错误详情。重复审批或用户再次申请可在冷却结束后重发。密码重置不需要管理员同意，成功后撤销既有设备；用户需重新登录。设备撤销后若账户仍有效，可用账户密码重新登录同一设备。禁用账户则所有设备与重置功能均不可用。

## 与 clash-convert / Caddy 衔接

保持 clash-convert 下载、合并、Subconverter、节点注入和 Caddy Header 更新链路。Rust 服务不读取机场余额，也不生成 `Subscription-Userinfo`。Caddy 继续负责 `upload/download/total/expire`，其中流量单位是字节、到期时间是 Unix 秒；这反映机场套餐信息，与按人上报的账本是两个来源。

在 clash-convert 成功执行后的运维包装脚本中增加：

```sh
clash-convert --config /path/to/config.toml &&
  tizi-server --database /var/lib/tizi-server/tizi.db publish --file /srv/your-converted-subscription.yaml
```

选择实际对用户发布的转换输出文件，不要误用服务器自身的 `server-config.yaml`。`publish` 验证大小（最多 10 MiB）、UTF-8、YAML 和节点入口后，在事务中替换当前版本；失败保留旧版。不会监视/读取转换中的文件。CLI 需要具备读取该文件及写服务数据库的权限，可由同一运维用户运行或受限 sudo 到服务用户。

参考 `deploy/Caddyfile.example`：域名的 TLS、压缩、日志以及原 Header handler 保留；删除覆盖所有路径的 Basic Auth、公开 file_server，改为反代 Rust。Subconverter 的文件源改为内部回环入口；若它运行在容器中，改用仅内部容器网络可达的地址和文件服务，不能继续使用公开订阅域名。Caddy Admin API 同样只允许可信内部访问。上线前运行 `caddy validate`，并通过真实域名验证 `Subscription-Userinfo` 仍由 clash-convert 更新且没有重复或空值覆盖。

`deploy/tizi-server.service` 提供手动安装的 systemd 示例，`deploy/server.env.example` 为 SMTP 配置模板，实际 EnvironmentFile 权限设为 0600。现有生产服务未被本项目自动修改或部署。

## HTTP 协议

除 `/healthz` 外均位于 `/v1`。JSON 请求必须为 UTF-8；最大 1 MiB。错误格式 `{ "error": "unauthorized|invalid_request|conflict|rate_limited|..." }`，不会回显凭据。注册申请和密码重置请求不披露已注册邮箱状态。追踪令牌为随机 UUID、每次申请不同，完成注册后的新申请返回隐藏状态。客户端应保存首次申请获得的令牌。

| 方法和路径                    | 请求 / 返回                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------- |
| POST `/registration/request`  | `{email}` → `{request_id}`                                                   |
| POST `/registration/status`   | `{request_id}` → `{status: pending/approved/registered/rejected}`            |
| POST `/registration/complete` | `{email,code,password}` → `{ok:true}`                                        |
| POST `/password/request`      | `{email}` → `{ok:true}`                                                      |
| POST `/password/reset`        | `{email,code,password}` → `{ok:true}`                                        |
| POST `/login`                 | `{email,password,device_id,public_key,device_name}` → `{email,device_id}`    |
| GET `/subscription`           | 原始 YAML，仅经过有效设备签名认证后返回；Header 由 Caddy 追加                |
| POST `/usage/report`          | `{sequence,days:[{day,upload_bytes,download_bytes}],health?}` → `{sequence}` |
| GET `/me/usage`               | 当前账户所有设备的 `days`、`cycles`、`devices` 和 `email`                    |

登录请求使用所提交 Ed25519 公钥验签；绑定后请求使用服务端已保存公钥验签。四个 Header 为 `X-Tizi-Device`（UUID）、`X-Tizi-Timestamp`（Unix 秒）、`X-Tizi-Nonce`（UUID）、`X-Tizi-Signature`（标准 Base64 原始 64 字节签名）。公钥为标准 Base64 原始 32 字节。对以下 UTF-8 字节签名，末尾没有换行：

```text
TIZI1\nMETHOD\n/path?query\nDEVICE_UUID\nTIMESTAMP\nNONCE_UUID\nsha256hex(body)
```

实际分隔符为换行；空 GET body 的摘要也必须计算。签名覆盖原样请求路径及查询字符串和原始 body。时间偏差最多 300 秒，nonce 持久化去重，不能重放。登录外的订阅和计量请求不使用普通订阅 URL、Basic Auth 或共享构建密钥鉴权。

`days` 中 `day` 是北京时间 07:00 开始的结算日，`upload_bytes/download_bytes` 是该设备该日期的累计值，只含代理载荷字节，不含站点/进程/节点信息。序号递增，可跳号；相同序号必须有完全一致的原始 body 才能幂等重试（HTTP nonce 仍需重新生成）。累计值降低、重复日期、未来日期、负数、用户累计超过 JS 安全整数范围均拒绝并回滚。可提交空 days 作为健康心跳。支持上报当前日部分值，最终报告只能继续增加。

`/me/usage`：days 包含 `day/upload_bytes/download_bytes`；cycles 包含 `id/name/start_day/end_day/upload_bytes/download_bytes`；devices 包含 `device_id/name/last_report_at/sequence/health/health_details`。`health` 稳定为 `healthy/incomplete/unknown`，`health_details` 保留客户端提交的健康 JSON。服务端不将无报告的日子认定为可信的零用量。

## 备份和恢复

使用 `backup` 命令的 SQLite 在线备份，不直接复制正在运行的 `.db` 主文件；另外单独备份对应 `.pepper`、SMTP 配置和 Caddy 配置。备份目标不能已存在。恢复时先停服务、保存当前状态、还原数据库与配套 pepper 并修正属主/权限，再启动。已有设备公钥、nonce、序号、周期、发布配置与待发送邮件都在数据库中。

## 验证

`cargo test --locked` 覆盖审批前不发信、注册/重置、尝试次数、签名重放与 body 篡改、撤销、幂等/降低累计值、多设备聚合、延迟补报跨周期、数值边界、追踪令牌和 07:00 分界。SMTP 真实投递和公开 Caddy 域名的端到端验收需要部署者提供配置后执行，不会用真实邮箱发送测试邮件。

另有手动跨项目验证脚本，使用临时数据库、虚构账户、回环 Caddy 和本地代理目标：

```sh
python3 tests/native-integration.py --server target/debug/tizi-server --core /path/to/fixture-mihomomo --caddy /path/to/caddy
```

内核须启用 `tizi` 并使用测试专用构建密钥。脚本验证审批、设备认证、Header、加密缓存、真实代理字节计量、DIRECT 排除、关闭明细记录后仍能计量，以及控制端口和日志保护。它不会投递真实邮件，审批码从临时数据库读取，不代表 SMTP 投递验收。测试专用内核不得用于正式分发。
