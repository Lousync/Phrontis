import { useEffect, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import { bookMarketProbeSource, bookMarketSaveCredential } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import type { BookAuthType, BookSourceConnectivity, BookSourceInfo } from '../../types'
import { SHEET_BTN, SHEET_BTN_GHOST, SHEET_FLD, SHEET_INFO, SHEET_INP, SHEET_LABEL, SHEET_TIP, Sheet } from './SheetShell'

/**
 * 凭据弹层（原型 `renderCredSheet`）。
 *
 * ★★ 安全不变量：凭据**只**经 `bookMarketSaveCredential` 进主进程的 secretStore（密文文件），
 *   绝不写进源描述、绝不进日志 / 错误文案 / toast。这里保存成功后立刻把本地 state 清空，
 *   保存完就再从渲染层内存里消失（下一次要改必须重新输入 —— 因为主进程也不会回传明文）。
 */
export function CredentialSheet({ source, rootId, onClose, onSaved }: {
  source: BookSourceInfo | null
  rootId: string
  onClose: () => void
  /** 保存并测试完成（书源列表据此刷新三态） */
  onSaved: (id: string, state: BookSourceConnectivity) => void
}) {
  // 退场动画期间 `source` 已是 null，但面板还要画完 —— 记住最后一项（ModalShell 的用法约定）
  const last = useRef<BookSourceInfo | null>(null)
  if (source) last.current = source
  const shown = source ?? last.current

  const [authKind, setAuthKind] = useState<BookAuthType>('basic')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  // 每次打开时按该源的认证方式重置表单（切换源不能带着上一家的输入）
  useEffect(() => {
    if (!source) return
    setAuthKind(source.authType ?? 'basic')
    setUsername('')
    setPassword('')
    setToken('')
  }, [source])

  const save = async () => {
    if (!shown || busy) return
    const cred = authKind === 'basic'
      ? { type: 'basic' as const, username: username.trim(), password }
      : { type: 'bearer' as const, token: token.trim() }
    if (authKind === 'basic' && (!cred.username || !cred.password)) {
      showToast({ type: 'warning', message: '用户名与密码都要填' })
      return
    }
    if (authKind === 'bearer' && !cred.token) {
      showToast({ type: 'warning', message: 'Token 不能为空' })
      return
    }
    setBusy(true)
    const r = await bookMarketSaveCredential(rootId, shown.id, cred)
    // 立刻清空本地副本：密文已交给主进程，渲染层不需要（也不该）继续持有
    setUsername(''); setPassword(''); setToken('')
    if (!r.ok) {
      setBusy(false)
      // ★ 注意 toast 的 `detail` 字段不是「补充说明」而是**帮助章节 id**（Toast.tsx 会拿它
      //   去 navigateToHelp）—— 错误原因必须并进 message，塞进 detail 会变成一次莫名其妙的帮助跳转。
      showToast({ type: 'error', message: `凭据保存失败${r.error ? `：${r.error}` : ''}` })
      return
    }
    const probe = await bookMarketProbeSource(rootId, shown.id, 'test')
    setBusy(false)
    const state = probe.state
    showToast({
      type: state === 'ok' ? 'success' : 'warning',
      message: state === 'ok'
        ? `${shown.name}：凭据已保存 · 连接正常`
        : `${shown.name}：凭据已保存 · 连接仍失败（检查地址与用户名 / Token）`,
    })
    onSaved(shown.id, state)
    onClose()
  }

  return (
    <Sheet
      open={!!source}
      title={shown ? `${shown.name} · 凭据` : '凭据'}
      onClose={onClose}
      footer={<>
        <button type="button" className={SHEET_BTN_GHOST} onClick={onClose}>取消</button>
        <button type="button" className={SHEET_BTN} disabled={busy} onClick={() => { void save() }}>
          {busy ? '保存中…' : '保存并测试'}
        </button>
      </>}
    >
      {shown && (
        <>
          <div className={SHEET_INFO}>
            该源要求 <b className="font-medium text-[var(--text-secondary)]">{authKind === 'basic' ? 'Basic 认证（用户名 + 密码）' : 'Bearer Token'}</b>。
            没有凭据时，检索与下载都会收到 401 —— 所以「测试」的结论会是「需要凭据」而不是「连接失败」。
          </div>

          <div className={SHEET_FLD}>
            <label className={SHEET_LABEL}>认证方式</label>
            <div className="flex gap-2">
              {([['basic', 'Basic 认证', '用户名 + 密码'], ['bearer', 'Bearer Token', '直接填 Token']] as const).map(([k, n, d]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setAuthKind(k)}
                  className={`flex-1 rounded-[8px] border p-2.5 text-left transition-colors ${authKind === k ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]' : 'border-[var(--border-color)] hover:bg-[var(--bg-hover)]'}`}
                >
                  <span className="mb-0.5 block text-[12.5px] font-medium text-[var(--text-primary)]">{n}</span>
                  <span className="block text-[11px] leading-[1.5] text-[var(--text-muted)]">{d}</span>
                </button>
              ))}
            </div>
          </div>

          {authKind === 'basic' ? (
            <>
              <div className={SHEET_FLD}>
                <label className={SHEET_LABEL}>用户名</label>
                <input className={SHEET_INP} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="calibre 用户名" autoComplete="off" spellCheck={false} />
              </div>
              <div className={SHEET_FLD}>
                <label className={SHEET_LABEL}>密码</label>
                <input className={SHEET_INP} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
              </div>
            </>
          ) : (
            <div className={SHEET_FLD}>
              <label className={SHEET_LABEL}>Token</label>
              <input className={`${SHEET_INP} font-mono`} value={token} onChange={(e) => setToken(e.target.value)} placeholder="粘贴 Token" autoComplete="off" spellCheck={false} />
              <div className={SHEET_TIP}>以 <code className="rounded bg-[var(--bg-tertiary)] px-1 font-mono text-[11px]">Authorization: Bearer &lt;token&gt;</code> 发送；仅在发起请求时注入，不落进任何仓库文件。</div>
            </div>
          )}

          <div className="mt-2 flex items-center gap-2 rounded-[7px] bg-[var(--bg-tertiary)] px-2.5 py-2 text-[11.5px] text-[var(--text-muted)]">
            <Lock size={13} strokeWidth={1.7} />
            凭据存入系统加密区（Windows DPAPI，绑定当前账户）· 不写入仓库文件 · 不随源配置导出或出现在日志里
          </div>
        </>
      )}
    </Sheet>
  )
}
