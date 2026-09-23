import { useEffect, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import { Collapsible } from '../../components/shared/Collapsible'
import { bookMarketProbeSource, bookMarketSaveCredential, bookMarketUpsertSource } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import type { BookAuthType, BookResponseType, BookSourceConnectivity, BookSourceDraft, BookSourceInfo, BookSourceKind, BookSourceMapping, BookSourcePatch } from '../../types'
import { SHEET_BTN, SHEET_BTN_GHOST, SHEET_FLD, SHEET_INFO, SHEET_INP, SHEET_LABEL, SHEET_TIP, Sheet } from './SheetShell'

/**
 * 新增 / 编辑书源（原型 `renderAddSheet`）。
 *
 * 三个口径：
 * ① **响应格式只选解析器**：OPDS 目录恒 `atom`（标准 OPDS 抽取，字段映射不参与），
 *    自定义源才在 JSON / Atom 之间选，HTML 明确不支持（页面抓取不做，方案 §三 边界）。
 * ② 映射是**声明式取值路径**：只取值，不执行表达式 / 脚本。留空字段在界面上显示为未知，不阻断检索。
 * ③ 凭据与源描述**分开写**：先 upsert 拿到源 id（新建时 id 由主进程生成），再单独
 *    `saveCredential`。编辑态若留空凭据则**不动**已存的那份（不会把已有的清掉）。
 *
 * ★ S5 已落地（2026-09-23）：AI 起草的草案经 `draft` 进来预填（见下面的重置 effect）。
 *   草案只在**新增态**参与（编辑态以源现值优先）；凭据三框恒为空 —— 草案里本就没有凭据字段。
 */

const AUTH_OPTIONS = [
  ['none', '无需登录', '公版与公共目录'],
  ['basic', 'Basic', 'Calibre-Web 默认'],
  ['bearer', 'Bearer', 'Komga / Kavita'],
] as const

const MAP_ROWS: Array<[keyof BookSourceMapping, string, string]> = [
  ['list', '条目列表', 'data.books[*]'],
  ['title', '书名', 'title'],
  ['author', '作者', 'author.name'],
  ['cover', '封面', 'cover_url'],
  ['summary', '简介', 'summary'],
  ['download', '下载地址', 'files[0].url'],
  ['format', '格式', 'files[0].format'],
]

/** 下拉里被禁用的那一档（HTML 抓取不做）—— 画出来是为了说明「不是没做，是不做」 */
function KindRadio({ on, title, desc, disabled, onClick }: { on: boolean; title: string; desc: string; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex-1 rounded-[8px] border p-2.5 text-left transition-colors ${on ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]' : 'border-[var(--border-color)]'} ${disabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-[var(--bg-hover)]'}`}
    >
      <span className="mb-0.5 block text-[12.5px] font-medium text-[var(--text-primary)]">{title}</span>
      <span className="block text-[11px] leading-[1.5] text-[var(--text-muted)]">{desc}</span>
    </button>
  )
}

export function SourceFormSheet({ open, source, rootId, draft, onClose, onSaved }: {
  open: boolean
  /** 编辑态传该源（新增传 null）；`draft` 与它互斥，两者都在时 source 优先 */
  source: BookSourceInfo | null
  rootId: string
  /** S5：AI 起草的预填草案（新增态用）。**不含凭据字段** —— 凭据只能用户手输 */
  draft?: BookSourceDraft | null
  onClose: () => void
  onSaved: (id: string, state: BookSourceConnectivity | null) => void
}) {
  const last = useRef<BookSourceInfo | null>(null)
  if (source) last.current = source
  const shown = source ?? last.current

  const [kind, setKind] = useState<BookSourceKind>('opds')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [responseType, setResponseType] = useState<BookResponseType>('json')
  const [searchUrl, setSearchUrl] = useState('{base}/search?q={query}&page={page}')
  const [map, setMap] = useState<Record<string, string>>({})
  const [authKind, setAuthKind] = useState<'none' | BookAuthType>('none')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  // 每次打开按来源重置（新增 = 空表单 / 草案；编辑 = 带入现值）—— 不留上一家的残留输入。
  // 草案只在**新增态**生效（编辑态以源现值优先）；凭据三框恒为空：
  // 草案结构上没有凭据字段（types 里 BookSourceDraft 的三点口径），这三行**不要动**。
  useEffect(() => {
    if (!open) return
    const s = source
    const d = source ? null : draft
    setKind(d?.kind ?? s?.kind ?? 'opds')
    setName(d?.name ?? s?.name ?? '')
    setUrl(d?.url ?? s?.url ?? '')
    setResponseType(d?.responseType ?? s?.responseType ?? 'json')
    setSearchUrl(d?.searchUrl || s?.searchUrl || '{base}/search?q={query}&page={page}')
    const m: Record<string, string> = {}
    for (const [k] of MAP_ROWS) m[k] = String(d?.mapping?.[k] ?? s?.mapping?.[k] ?? '')
    setMap(m)
    setAuthKind(d?.authType ?? s?.authType ?? 'none')
    setUsername(''); setPassword(''); setToken('')
  }, [open, source, draft])

  const isOpds = kind === 'opds'

  const save = async () => {
    if (busy) return
    if (!name.trim()) { showToast({ type: 'warning', message: '名称不能为空' }); return }
    if (!/^https?:\/\//i.test(url.trim())) { showToast({ type: 'warning', message: '地址要以 http:// 或 https:// 开头' }); return }

    let mapping: BookSourceMapping | null = null
    if (!isOpds) {
      const list = (map.list ?? '').trim()
      const title = (map.title ?? '').trim()
      const download = (map.download ?? '').trim()
      if (!list || !title || !download) {
        showToast({ type: 'warning', message: '字段映射至少要填「条目列表 / 书名 / 下载地址」' })
        return
      }
      mapping = {
        list, title, download,
        ...((map.author ?? '').trim() ? { author: map.author.trim() } : {}),
        ...((map.cover ?? '').trim() ? { cover: map.cover.trim() } : {}),
        ...((map.summary ?? '').trim() ? { summary: map.summary.trim() } : {}),
        ...((map.format ?? '').trim() ? { format: map.format.trim() } : {}),
      }
    }

    const patch: BookSourcePatch = {
      name: name.trim(),
      kind,
      url: url.trim(),
      searchUrl: isOpds ? '' : searchUrl.trim(),
      responseType: isOpds ? 'atom' : responseType,
      auth: authKind === 'none' ? null : { type: authKind, ref: '' },
      mapping,
    }

    setBusy(true)
    const r = await bookMarketUpsertSource(rootId, patch, shown?.id)
    if (!r.ok || !r.source) {
      setBusy(false)
      showToast({ type: 'error', message: `书源保存失败${r.error ? `：${r.error}` : ''}` })
      return
    }
    const id = r.source.id

    // 凭据：只在用户**这次填了**的时候写（编辑态留空 = 保持原凭据，绝不清空）
    const cred = authKind === 'basic'
      ? (username.trim() && password ? { type: 'basic' as const, username: username.trim(), password } : null)
      : authKind === 'bearer'
        ? (token.trim() ? { type: 'bearer' as const, token: token.trim() } : null)
        : null
    if (cred) {
      const cs = await bookMarketSaveCredential(rootId, id, cred)
      setUsername(''); setPassword(''); setToken('')
      if (!cs.ok) {
        setBusy(false)
        showToast({ type: 'warning', message: `书源已保存，但凭据没存上${cs.error ? `：${cs.error}` : ''}` })
        onSaved(id, null)
        onClose()
        return
      }
    }

    const probe = await bookMarketProbeSource(rootId, id, 'test')
    setBusy(false)
    showToast({
      type: probe.state === 'ok' ? 'success' : 'warning',
      message: `${name.trim()} 已保存 · ${probe.state === 'ok' ? '连接正常' : probe.state === 'need-credential' ? '还需要填凭据' : probe.state === 'forbidden' ? '访问被拒（该源可能不对外开放）' : '连接失败'}`,
    })
    onSaved(id, probe.state)
    onClose()
  }

  return (
    <Sheet
      open={open}
      title={shown ? '编辑书源' : '新增书源'}
      onClose={onClose}
      footer={<>
        <button type="button" className={SHEET_BTN_GHOST} onClick={onClose}>取消</button>
        <button type="button" className={SHEET_BTN} disabled={busy} onClick={() => { void save() }}>
          {busy ? '保存中…' : isOpds ? '添加并测试' : '保存并测试'}
        </button>
      </>}
    >
      <div className={SHEET_FLD}>
        <label className={SHEET_LABEL}>类型</label>
        <div className="flex gap-2">
          <KindRadio on={isOpds} title="OPDS 目录" desc="标准协议，填地址即可。推荐优先用这个。" onClick={() => setKind('opds')} />
          <KindRadio on={!isOpds} title="自定义源" desc="用字段映射描述 JSON / Atom 响应。" onClick={() => setKind('custom')} />
        </div>
      </div>

      <div className={SHEET_FLD}>
        <label className={SHEET_LABEL}>名称</label>
        <input className={SHEET_INP} value={name} onChange={(e) => setName(e.target.value)} placeholder={isOpds ? '例如：我的 Calibre-Web' : '例如：某站书目接口'} spellCheck={false} />
      </div>

      <div className={SHEET_FLD}>
        <label className={SHEET_LABEL}>地址</label>
        <input className={`${SHEET_INP} font-mono`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={isOpds ? 'http://192.168.1.20:8083/opds' : 'https://example.org/api'} spellCheck={false} />
      </div>

      {/* 自定义源才有的一整块（OPDS 走标准抽取，没有映射可填）——
          收起时不挂载子树（Collapsible 的懒语义），展开有高度动画 */}
      <Collapsible open={!isOpds} innerClassName="">{() => (
        <div className="mb-3.5">
          <div className={SHEET_FLD}>
            <label className={SHEET_LABEL}>响应格式</label>
            <div className="flex gap-2">
              <KindRadio on={responseType === 'json'} title="JSON" desc="数组或对象路径" onClick={() => setResponseType('json')} />
              <KindRadio on={responseType === 'atom'} title="Atom / XML" desc="按标准 OPDS 抽取" onClick={() => setResponseType('atom')} />
              <KindRadio on={false} title="HTML" desc="不支持 · 页面抓取不做" disabled />
            </div>
          </div>

          <div className={SHEET_FLD}>
            <label className={SHEET_LABEL}>检索 URL 模板</label>
            <input className={`${SHEET_INP} font-mono`} value={searchUrl} onChange={(e) => setSearchUrl(e.target.value)} spellCheck={false} />
            <div className={SHEET_TIP}>{'{base} 地址 · {query} 关键词 · {page} 页码 · {isbn} 编号'}</div>
          </div>

          <div className={SHEET_FLD}>
            <label className={SHEET_LABEL}>字段映射</label>
            {MAP_ROWS.map(([k, label, ph]) => (
              <div key={k} className="mb-2 grid grid-cols-[104px_1fr] items-center gap-2">
                <label className="text-[12px] text-[var(--text-secondary)]">{label}</label>
                <input
                  className={`${SHEET_INP} h-[29px] font-mono text-[12px]`}
                  value={map[k] ?? ''}
                  onChange={(e) => setMap((prev) => ({ ...prev, [k]: e.target.value }))}
                  placeholder={ph}
                  spellCheck={false}
                />
              </div>
            ))}
            <div className={SHEET_TIP}>留空的字段在界面上显示为未知，不会阻断检索。映射只做取值，不会执行任何表达式或脚本。</div>
          </div>
        </div>
      )}</Collapsible>

      <div className={SHEET_FLD}>
        <label className={SHEET_LABEL}>认证</label>
        <div className="flex gap-2">
          {AUTH_OPTIONS.map(([k, n, d]) => (
            <KindRadio key={k} on={authKind === k} title={n} desc={d} onClick={() => setAuthKind(k)} />
          ))}
        </div>
      </div>

      <Collapsible open={authKind !== 'none'} innerClassName="">{() => (
        <div className="mb-1">
          {authKind === 'basic' && (
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
          )}
          {authKind === 'bearer' && (
            <div className={SHEET_FLD}>
              <label className={SHEET_LABEL}>Token</label>
              <input className={`${SHEET_INP} font-mono`} value={token} onChange={(e) => setToken(e.target.value)} placeholder="粘贴 Token" autoComplete="off" spellCheck={false} />
            </div>
          )}
          {shown?.hasCredential && (
            <div className={SHEET_INFO}>
              该源已有凭据。<b className="font-medium text-[var(--text-secondary)]">留空即保持不变</b>，填了就覆盖。
            </div>
          )}
          <div className="mt-2 flex items-center gap-2 rounded-[7px] bg-[var(--bg-tertiary)] px-2.5 py-2 text-[11.5px] text-[var(--text-muted)]">
            <Lock size={13} strokeWidth={1.7} />
            凭据存入系统加密区（Windows DPAPI，绑定当前账户）· 不写入仓库文件 · 不随源配置导出或出现在日志里
          </div>
        </div>
      )}</Collapsible>
    </Sheet>
  )
}
