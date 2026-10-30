import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { Button, Checkbox, Chip, Input, Spinner, Tab, Tabs } from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import type { TiziAction, TiziStatus, TiziUsage } from '../../../shared/tizi'
import { TIZI_DEFAULT_SERVER } from '../../../shared/tizi'

async function request<T>(action: TiziAction, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await window.electron.ipcRenderer.invoke('tiziAction', action, payload)
  if (result && typeof result === 'object' && 'invokeError' in result) {
    throw new Error(String(result.invokeError))
  }
  return result as T
}

function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const index = value > 0 ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0
  return `${(value / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[index]}`
}

export default function TiziPage(): React.JSX.Element {
  const {
    data: status,
    error: statusError,
    mutate: mutateStatus
  } = useSWR<TiziStatus>('tizi/local-status', () => request<TiziStatus>('status'), {
    refreshInterval: 60000,
    revalidateOnFocus: true,
    dedupingInterval: 1000
  })
  const {
    data: usage,
    error: usageError,
    isLoading: usageLoading,
    mutate: mutateUsage
  } = useSWR<TiziUsage>(
    status?.logged_in ? ['tizi/usage', status.device_id] : null,
    () => request<TiziUsage>('usage'),
    {
      refreshInterval: 60000,
      revalidateOnFocus: false,
      dedupingInterval: 10000
    }
  )
  const [mode, setMode] = useState('login')
  const [serverUrl, setServerUrl] = useState(TIZI_DEFAULT_SERVER)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState('我的电脑')
  const [consent, setConsent] = useState(false)
  const [requestId, setRequestId] = useState('')
  const [approval, setApproval] = useState('')
  const [busyAction, setBusyAction] = useState<TiziAction | null>(null)
  const busy = busyAction !== null
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const refresh = (): void => {
      void mutateStatus().catch(() => undefined)
    }
    // Revalidate on return even inside SWR's deduplication window: another page
    // may have selected a different profile while this page was unmounted.
    refresh()
    const unsubscribe = ['appConfigUpdated', 'profileConfigUpdated', 'core-started'].map((event) =>
      window.electron.ipcRenderer.on(event, refresh)
    )
    return () => unsubscribe.forEach((dispose) => dispose())
  }, [mutateStatus])

  async function run(action: TiziAction, payload: Record<string, unknown> = {}): Promise<void> {
    setBusyAction(action)
    setError('')
    setNotice('')
    try {
      const result = await request<Record<string, unknown>>(action, payload)
      if (action === 'register') {
        setRequestId(String(result.request_id))
        setApproval('pending')
        setNotice('申请已提交，管理员同意后才会向邮箱发送验证码。')
      } else if (action === 'registration-status') {
        setApproval(String(result.status))
      } else if (action === 'complete-registration') {
        setPassword('')
        setCode('')
        setMode('login')
        setNotice('注册完成，请登录并绑定此设备。')
      } else if (action === 'reset-request') {
        setNotice('如果该邮箱已注册，重置验证码将发送到邮箱。')
      } else if (action === 'reset-confirm') {
        setPassword('')
        setCode('')
        setMode('login')
        setNotice('密码已重置，请重新登录。')
      } else if (action === 'activate') {
        setNotice('团购订阅已启用，可在订阅列表中切换，并在代理组页面选择节点。')
      } else if (action === 'deactivate') {
        setNotice('已切回私人订阅。')
      } else {
        setNotice(action === 'sync' ? '已完成补报检查。' : '操作完成。')
      }
      if (action === 'login' || action === 'logout') setPassword('')
      if ('logged_in' in result) {
        await mutateStatus(result as unknown as TiziStatus, { revalidate: false })
      }
      await mutateStatus()
      void mutateUsage().catch(() => undefined)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(
        message.includes('Tizi service is unreachable')
          ? '无法连接团购服务，请检查网络和 DNS 设置后重试。已有缓存订阅会继续保留。'
          : message
      )
    } finally {
      setBusyAction(null)
    }
  }

  const credentials = { server_url: serverUrl, email: email.trim(), password }
  const subscription = status?.subscription
  const usageFailureMessage =
    usageError instanceof Error ? usageError.message : String(usageError ?? '')
  const usageFailureReason = /unauthorized|revoked|\b401\b/.test(usageFailureMessage)
    ? '设备认证未通过，请重新登录。'
    : /unreachable|ENOTFOUND|EAI_AGAIN|timeout|DNS/i.test(usageFailureMessage)
      ? '暂时无法连接用量服务，请检查网络和 DNS 设置后重试。'
      : '本次用量请求未成功，请稍后重试。'
  const days = usage?.days ?? []
  const settlementDay = new Date(Date.now() + 3600000).toISOString().slice(0, 10)
  const healthNames: Record<string, string> = {
    healthy: '正常',
    incomplete: '记录不完整',
    unknown: '尚未取得'
  }
  const maxDay = Math.max(1, ...days.map((day) => day.upload_bytes + day.download_bytes))
  const approvalText: Record<string, string> = {
    pending: '等待管理员审批',
    approved: '已批准，请检查邮箱中的验证码',
    registered: '注册已完成，可以登录',
    rejected: '申请未通过，请联系管理员'
  }

  return (
    <BasePage title="新团购tizi订阅服务">
      <div className="mx-auto max-w-4xl space-y-6 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-divider pb-4">
          <div>
            <h1 className="text-xl font-semibold">一起使用，清楚记账</h1>
            <p className="mt-1 text-sm text-default-500">
              每天北京时间 07:00 结算，各设备的团购代理用量合并到同一账户。
            </p>
          </div>
          <Chip size="sm" color={status?.active ? 'primary' : 'default'} variant="flat">
            {!status ? '读取状态中' : status.active ? '正在使用团购订阅' : '使用私人订阅'}
          </Chip>
        </div>
        {error && (
          <div role="alert" className="rounded-lg bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="rounded-lg bg-primary/10 p-3 text-sm">
            {notice}
          </div>
        )}
        {status && (!status.supported || !status.keyReady) && (
          <p className="rounded-lg bg-warning/10 p-3 text-sm">
            请安装启用团购功能并配置构建密钥的配套 Mihomomo 内核。
          </p>
        )}
        {status?.supported && status.keyReady && (status.managed_config_version ?? 0) < 2 && (
          <p className="rounded-lg bg-warning/10 p-3 text-sm">
            当前内核尚不支持完整的团购 DNS 和 Smart 设置。请升级 mihomomo 至 1.19.33-3
            或更新版本；macOS 还需在内核设置中更新网络服务。
          </p>
        )}
        {!status ? (
          <div
            role="status"
            aria-live="polite"
            className="flex min-h-48 items-center justify-center gap-3 text-default-500"
          >
            {statusError ? (
              <>
                <span>无法读取本机登录状态。</span>
                <Button size="sm" onPress={() => void mutateStatus()}>
                  重试
                </Button>
              </>
            ) : (
              <>
                <Spinner size="sm" />
                <span>正在读取登录状态…</span>
              </>
            )}
          </div>
        ) : !status.logged_in ? (
          <div className="max-w-xl space-y-4">
            <Tabs
              aria-label="账户操作"
              selectedKey={mode}
              onSelectionChange={(key) => {
                setMode(String(key))
                setPassword('')
                setCode('')
              }}
            >
              <Tab key="login" title="登录" />
              <Tab key="register" title="申请注册" />
              <Tab key="reset" title="重置密码" />
            </Tabs>
            <Input
              label="服务地址"
              type="url"
              value={serverUrl}
              onValueChange={setServerUrl}
              isDisabled={busy}
            />
            <Input
              label="邮箱"
              type="email"
              autoComplete="email"
              value={email}
              onValueChange={setEmail}
              isDisabled={busy}
            />
            {mode === 'register' && (
              <>
                <Button
                  isDisabled={busy || !email.trim()}
                  onPress={() =>
                    void run('register', { server_url: serverUrl, email: email.trim() })
                  }
                >
                  提交注册申请 / 重新发送已批准的验证码
                </Button>
                {requestId && (
                  <div className="space-y-2 border-l-2 border-primary pl-3">
                    <p className="text-sm">{approvalText[approval] || '查询申请状态'}</p>
                    <Button
                      size="sm"
                      isDisabled={busy}
                      onPress={() =>
                        void run('registration-status', {
                          server_url: serverUrl,
                          request_id: requestId
                        })
                      }
                    >
                      查询审批状态
                    </Button>
                  </div>
                )}
              </>
            )}
            {mode !== 'login' && (
              <Input
                label="邮箱验证码"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onValueChange={setCode}
                isDisabled={busy}
              />
            )}
            <Input
              label={mode === 'login' ? '密码' : '设置新密码'}
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onValueChange={setPassword}
              isDisabled={busy}
            />
            {mode === 'login' && (
              <>
                <Input
                  label="设备名称"
                  value={deviceName}
                  onValueChange={setDeviceName}
                  isDisabled={busy}
                />
                <Checkbox isSelected={consent} onValueChange={setConsent} isDisabled={busy}>
                  <span className="text-sm">
                    同意绑定此设备并上报团购代理的每日上下载总量；域名、IP、进程和访问明细不会上传。
                  </span>
                </Checkbox>
              </>
            )}
            <div className="flex flex-wrap gap-2">
              {mode === 'login' && (
                <Button
                  color="primary"
                  isLoading={busy}
                  isDisabled={
                    !consent ||
                    !email.trim() ||
                    !password ||
                    status?.keyReady === false ||
                    status?.supported === false
                  }
                  onPress={() => void run('login', { ...credentials, device_name: deviceName })}
                >
                  登录并绑定设备
                </Button>
              )}
              {mode === 'register' && (
                <Button
                  color="primary"
                  isLoading={busy}
                  isDisabled={!code || !password || !email.trim()}
                  onPress={() => void run('complete-registration', { ...credentials, code })}
                >
                  验证邮箱并完成注册
                </Button>
              )}
              {mode === 'reset' && (
                <>
                  <Button
                    isDisabled={busy || !email.trim()}
                    onPress={() =>
                      void run('reset-request', { server_url: serverUrl, email: email.trim() })
                    }
                  >
                    发送重置验证码
                  </Button>
                  <Button
                    color="primary"
                    isLoading={busy}
                    isDisabled={!code || !password || !email.trim()}
                    onPress={() => void run('reset-confirm', { ...credentials, code })}
                  >
                    重置密码
                  </Button>
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold">{status.email}</h2>
                  <p className="text-xs text-default-500">本机设备：{status.device_id}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    color="primary"
                    isDisabled={busy}
                    isLoading={busyAction === 'activate' || busyAction === 'deactivate'}
                    onPress={() => void run(status.active ? 'deactivate' : 'activate')}
                  >
                    {busyAction === 'activate'
                      ? '正在启用团购订阅…'
                      : busyAction === 'deactivate'
                        ? '正在切换私人订阅…'
                        : status.active
                          ? '返回私人订阅'
                          : '使用团购订阅'}
                  </Button>
                  <Button
                    size="sm"
                    isDisabled={busy}
                    isLoading={busyAction === 'refresh'}
                    onPress={() => void run('refresh')}
                  >
                    更新订阅
                  </Button>
                  <Button size="sm" isDisabled={busy} onPress={() => void run('sync')}>
                    立即补报
                  </Button>
                  <Button size="sm" isDisabled={busy} onPress={() => void run('logout')}>
                    退出登录
                  </Button>
                </div>
              </div>
              <p className="text-sm text-default-500">
                待报日期：{status.pending_days ?? '—'}；本地记录状态：
                {healthNames[status.health || 'unknown'] || '记录不完整'}
                。离线时继续使用缓存订阅，联网后自动补报。
              </p>
            </section>
            {subscription && (
              <section className="rounded-lg border border-divider p-4">
                <h2 className="font-semibold">共享套餐余额与截止日期</h2>
                <div className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                  <div>
                    套餐已用
                    <strong className="mt-1 block text-lg">
                      {bytes(subscription.upload + subscription.download)}
                    </strong>
                  </div>
                  <div>
                    套餐剩余
                    <strong className="mt-1 block text-lg">
                      {subscription.total > 0
                        ? bytes(
                            Math.max(
                              0,
                              subscription.total - subscription.upload - subscription.download
                            )
                          )
                        : '未提供'}
                    </strong>
                  </div>
                  <div>
                    截止日期
                    <strong className="mt-1 block text-lg">
                      {subscription.expire > 0
                        ? new Date(subscription.expire * 1000).toLocaleDateString()
                        : '未提供'}
                    </strong>
                  </div>
                </div>
                <p className="mt-2 text-xs text-default-500">
                  来源于订阅套餐信息，与下方个人设备上报的统计口径不同。
                </p>
              </section>
            )}
            {usageLoading && !usage && (
              <div role="status" className="flex items-center gap-2 text-sm text-default-500">
                <Spinner size="sm" />
                正在加载用量，订阅操作仍可使用。
              </div>
            )}
            {usageError && (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 rounded-lg bg-warning/10 p-3 text-sm"
              >
                <div>
                  <p>
                    {usage
                      ? '用量更新失败，当前显示上次成功获取的数据。'
                      : '尚未取得服务端用量数据。'}
                  </p>
                  <p className="mt-1 text-xs text-default-500">{usageFailureReason}</p>
                </div>
                <Button size="sm" onPress={() => void mutateUsage()}>
                  重试用量加载
                </Button>
              </div>
            )}
            {usage && (
              <>
                <section>
                  <h2 className="mb-3 font-semibold">个人周期用量</h2>
                  <div className="divide-y divide-divider">
                    {(usage?.cycles ?? []).map((cycle) => (
                      <div key={cycle.id} className="flex items-center justify-between gap-3 py-3">
                        <div>
                          <p>{cycle.name}</p>
                          <p className="text-xs text-default-500">
                            {cycle.start_day} 至{' '}
                            {cycle.end_day ||
                              (cycle.start_day > settlementDay ? '待生效' : '当前周期')}
                          </p>
                        </div>
                        <div className="text-right">
                          <strong>{bytes(cycle.upload_bytes + cycle.download_bytes)}</strong>
                          <p className="text-xs text-default-500">
                            上传 {bytes(cycle.upload_bytes)} / 下载 {bytes(cycle.download_bytes)}
                          </p>
                        </div>
                      </div>
                    ))}
                    {!usage?.cycles?.length && (
                      <p className="py-4 text-sm text-default-500">
                        尚无周期统计，首次完成每日上报后显示。
                      </p>
                    )}
                  </div>
                </section>
                <section>
                  <h2 className="mb-3 font-semibold">已上报的每日用量</h2>
                  <p className="mb-3 text-xs text-default-500">
                    今天尚未结算的流量将在下个 07:00 后上报；未上报日期不代表零用量。
                  </p>
                  <div className="space-y-3">
                    {days.slice(-31).map((day) => (
                      <div
                        key={day.day}
                        className="grid grid-cols-[6rem_1fr_7rem] items-center gap-3 text-sm"
                      >
                        <span>{day.day}</span>
                        <div className="h-2 overflow-hidden rounded bg-default-100">
                          <div
                            className="h-full rounded bg-primary"
                            style={{
                              width: `${(100 * (day.upload_bytes + day.download_bytes)) / maxDay}%`
                            }}
                          />
                        </div>
                        <span className="text-right">
                          {bytes(day.upload_bytes + day.download_bytes)}
                        </span>
                      </div>
                    ))}
                    {!days.length && (
                      <p className="py-4 text-sm text-default-500">暂无已上报记录。</p>
                    )}
                  </div>
                </section>
                <section>
                  <h2 className="mb-3 font-semibold">已绑定设备</h2>
                  <div className="divide-y divide-divider">
                    {(usage?.devices ?? []).map((device) => (
                      <div
                        key={device.device_id}
                        className="flex justify-between gap-3 py-3 text-sm"
                      >
                        <div>
                          {device.name}
                          <p className="text-xs text-default-500">{device.device_id}</p>
                        </div>
                        <span>{device.health || '尚未上报'}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </BasePage>
  )
}
