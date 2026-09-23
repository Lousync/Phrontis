import { ShieldCheck, AlertTriangle, Wrench, FileText } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'

type Perm = 'off' | 'read' | 'write'

interface ModuleDef {
  id: string
  label: string
  desc: string
  writeDesc: string
}

const MODULES: ModuleDef[] = [
  { id: 'knowledge', label: '知识库',   desc: '搜索与阅读页面',       writeDesc: '新建页面、向已有页面追加内容' },
  { id: 'blog',      label: '博客/日记', desc: '查询日记',             writeDesc: '按日期新建日记（每天一篇）' },
  { id: 'schedule',  label: '日程',     desc: '查询待办事项',         writeDesc: '创建待办' },
  { id: 'checkin',   label: '习惯打卡', desc: '习惯列表与统计',       writeDesc: '按名称为今天打卡' },
  { id: 'quiz',      label: '错题本',   desc: '查询错题与薄弱点统计', writeDesc: '按错误类型打标签、写错因备注、加入分组、组卷成练习页' },
  { id: 'bookMarket', label: '书市',    desc: '书源列表与检索状态',   writeDesc: '按草案预填「新建书源」表单（不自动落库）' },
  { id: 'pomodoro',  label: '番茄专注', desc: '专注统计',             writeDesc: '（暂无写操作）' },
]
// 注：bookmarks 模块已随 2026-09-09 工具重构退役（bookmarks.search → vault.search）；
// 旧设置数据中残留的 bookmarks 键无害（无工具引用即不生效），解析层自动忽略。

const PERM_LABEL: Record<Perm, string> = {
  off: '禁止',
  read: '只读',
  write: '读写',
}

function parsePerms(raw: string): Record<string, Perm> {
  try {
    const o = JSON.parse(raw || '{}')
    const out: Record<string, Perm> = {}
    for (const [k, v] of Object.entries(o)) {
      if (v === 'off' || v === 'read' || v === 'write') out[k] = v
    }
    return out
  } catch { return {} }
}

/** 设置 → AI 工具 → 权限：按模块 + 仓库文件域控制 AI 能动什么 */
export function AiPermissionsTab() {
  const { s, update } = useSettings()
  const perms = parsePerms(s.aiModulePermissions ?? '{}')
  const anyWrite = MODULES.some(m => perms[m.id] === 'write')
  const vaultPerm: Perm = s.aiVaultFilePerm === 'off' || s.aiVaultFilePerm === 'read' || s.aiVaultFilePerm === 'write' ? s.aiVaultFilePerm : 'read'

  const setPerm = (moduleId: string, perm: Perm) => {
    const next = { ...perms, [moduleId]: perm }
    void update('aiModulePermissions', JSON.stringify(next))
    showToast({ type: 'info', message: `已将「${MODULES.find(m => m.id === moduleId)?.label}」对 AI 设为${PERM_LABEL[perm]}` })
  }

  const setVaultPerm = (perm: Perm) => {
    void update('aiVaultFilePerm', perm)
    showToast({ type: 'info', message: `已将「仓库文件」对 AI 设为${PERM_LABEL[perm]}` })
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">模块权限</h2>
        <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">
          控制 AI 助手对各模块的能力边界：<b>禁止</b>=工具完全不可见；<b>只读</b>=仅查询类操作；
          <b>读写</b>=允许写入类操作。所有 AI 操作均留有审计记录，写入实时生效。
          <span className="text-[var(--text-secondary)]">修改即时生效，无需重启。</span>
        </p>
        {anyWrite && (
          <div className="flex items-start gap-2 mt-3 px-3 py-2.5 rounded-md bg-yellow-500/10 border border-yellow-600/40 max-w-md">
            <AlertTriangle size={15} className="text-yellow-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-yellow-200/90 leading-relaxed">
              已开放写入权限的模块：AI 的写操作将<b>直接生效</b>（如真实创建日记/待办、修改知识库页面）。请仅对信任的场景开启。
            </p>
          </div>
        )}
      </div>

      <div className="space-y-2 max-w-md">
        <div className="flex items-center gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <FileText size={14} className={vaultPerm === 'off' ? 'text-[var(--text-disabled)] shrink-0' : 'text-[var(--accent)] shrink-0'} />
          <span className="min-w-0 flex-1">
            <span className={`block text-[13px] ${vaultPerm === 'off' ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>仓库文件</span>
            <span className="block text-[11px] text-[var(--text-muted)] truncate">
              {vaultPerm === 'write' ? '列目录 / 读写仓库内 .md 等文本（写入能力随 vault 写工具上线生效）' : '列目录与阅读仓库内文本文件（vault.* 只读工具）'}
            </span>
          </span>
          <select value={vaultPerm} onChange={e => setVaultPerm(e.target.value as Perm)}
            className="px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)] shrink-0">
            <option value="off">禁止</option>
            <option value="read">只读</option>
            <option value="write">读写</option>
          </select>
        </div>

        {MODULES.map(m => {
          const cur: Perm = perms[m.id] ?? 'read'
          return (
            <div key={m.id} className="flex items-center gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <Wrench size={14} className={cur === 'off' ? 'text-[var(--text-disabled)] shrink-0' : 'text-[var(--accent)] shrink-0'} />
              <span className="min-w-0 flex-1">
                <span className={`block text-[13px] ${cur === 'off' ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>{m.label}</span>
                <span className="block text-[11px] text-[var(--text-muted)] truncate">
                  {cur === 'write' && m.writeDesc !== '（暂无写操作）' ? m.writeDesc : m.desc}
                </span>
              </span>
              <select value={cur} onChange={e => setPerm(m.id, e.target.value as Perm)}
                className="px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)] shrink-0">
                <option value="off">禁止</option>
                <option value="read">只读</option>
                <option value="write">读写</option>
              </select>
            </div>
          )
        })}
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-[var(--text-disabled)] max-w-md">
        <ShieldCheck size={12} />
        外部 MCP 工具不受本页约束（其启停在「MCP」页签单独控制）。
      </p>
    </div>
  )
}
