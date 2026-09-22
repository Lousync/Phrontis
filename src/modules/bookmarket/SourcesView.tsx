import { useEffect, useState } from 'react'
import type { BookSourceConnectivity, BookSourceInfo } from '../../types'
import { useSettings } from '../../lib/SettingsContext'
import { showToast } from '../../lib/toast'
import { CONN_META, connOf } from './shared'

/**
 * 书市 · 书源页（原型 `#sourcesPane`）：源清单 + 三条信息卡 + 存储 + 网络。
 *
 * ★ 代理不走新 IPC：唯一写路径是设置机制（`settings.bookMarketProxy`，S3 拍板），
 *   这里只 `getSetting` / `update`。所以这个输入框与「设置 → 书市 → 书市代理」是**同一个值**，
 *   不存在两处配置源。文案里那句「不影响 AI 对话与更新」是实情：主进程给它单开了一个
 *   session partition，`defaultSession` 的代理一个字都没动。
 */

/** 启停开关（原型 `.sw`）—— 只动 transform / 颜色（铁律 13） */
function Switch({ on, onToggle, title }: { on: boolean; onToggle: () => void; title: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={title}
      onClick={onToggle}
      className={`relative h-[19px] w-[34px] flex-none rounded-full transition-colors ${on ? 'bg-[var(--accent)]' : 'bg-[var(--border-color)]'}`}
    >
      <span
        className="absolute left-[2px] top-[2px] block h-[15px] w-[15px] rounded-full bg-white transition-transform duration-[180ms]"
        style={{ transform: on ? 'translateX(15px)' : 'none' }}
      />
    </button>
  )
}

const tagCls = 'rounded-[4px] bg-[var(--bg-tertiary)] px-1.5 py-[1px] text-[10px] font-normal text-[var(--text-muted)]'
/** 类型标签的高亮版（OPDS）—— 不写 `!bg-…` 覆盖：Tailwind v4 的 important 修饰符是**后缀**（`bg-…!`），
 *  前缀写法在 v4 静默失效。直接给出完整的一套，比覆盖更稳。 */
const tagAccentCls = 'rounded-[4px] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-1.5 py-[1px] text-[10px] font-normal text-[var(--accent)]'
const btnGhost = 'h-[26px] rounded-[7px] border border-[var(--border-color)] px-2.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'

export function SourcesView({ sources, conn, testing, onTest, onToggle, onCredentials, onEdit, onDelete }: {
  sources: BookSourceInfo[]
  conn: Record<string, BookSourceConnectivity>
  /** 正在测试的源 id（按钮文案变「测试中」并禁用） */
  testing: string | null
  onTest: (s: BookSourceInfo) => void
  onToggle: (s: BookSourceInfo) => void
  onCredentials: (s: BookSourceInfo) => void
  onEdit: (s: BookSourceInfo) => void
  onDelete: (s: BookSourceInfo) => void
}) {
  const { s: settings, update } = useSettings()
  const [proxy, setProxy] = useState(settings.bookMarketProxy)
  // 设置是异步从主进程拉回来的（初始值只是默认值），拉回来之后要把输入框对齐 ——
  // 只在挂载时 useState 会永远显示空串（用户会以为自己的代理没存上）
  useEffect(() => { setProxy(settings.bookMarketProxy) }, [settings.bookMarketProxy])

  return (
    <div className="px-4 py-4">
      <div className="mb-3 flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
        书源 · 预置的只有公版与公共目录
        <span className="h-px flex-1 bg-[var(--border-color)]" />
      </div>

      {sources.map((s) => {
        const c = connOf(s, conn)
        const meta = CONN_META[c]
        return (
          <div
            key={s.id}
            className={`kb-item-in mb-2.5 flex items-center gap-2.5 rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] p-3 ${s.enabled ? '' : 'opacity-55'}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-[var(--text-primary)]">
                {s.name}
                <span className={s.kind === 'opds' ? tagAccentCls : tagCls}>
                  {s.kind === 'opds' ? 'OPDS' : '自定义源'}
                </span>
                {s.builtin && <span className={tagCls}>预置</span>}
                {s.authType ? (
                  <span className="rounded-[4px] border border-[var(--warning)] bg-[var(--warning-bg)] px-1.5 py-[1px] text-[10px] font-normal text-[var(--warning)]">
                    {s.hasCredential ? '凭据已存' : '需要凭据'}
                  </span>
                ) : (
                  <span className={tagCls}>无需登录</span>
                )}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--text-muted)]" title={s.url}>{s.url}</div>
            </div>

            <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: meta.dot }} />
            <span className="w-[58px] flex-none text-[11px] text-[var(--text-muted)]">{meta.label}</span>

            <button type="button" disabled={testing === s.id} onClick={() => onTest(s)} className={`${btnGhost} disabled:opacity-60`}>
              {testing === s.id ? '测试中' : '测试'}
            </button>
            {s.authType ? (
              <button type="button" onClick={() => onCredentials(s)} className={btnGhost}>
                {s.hasCredential ? '改凭据' : '填凭据'}
              </button>
            ) : (
              <span className="w-[56px] flex-none" />
            )}
            {!s.builtin && (
              <button type="button" onClick={() => onEdit(s)} className={btnGhost}>编辑</button>
            )}
            {s.builtin ? (
              <button type="button" disabled title="预置源不可删除，可停用" className="h-[26px] cursor-not-allowed rounded-[7px] border border-[var(--border-color)] px-2.5 text-[12px] text-[var(--text-disabled)]">删除</button>
            ) : (
              <button type="button" onClick={() => onDelete(s)} className={btnGhost}>删除</button>
            )}
            <Switch on={s.enabled} onToggle={() => onToggle(s)} title={s.enabled ? '停用（不再参与检索）' : '启用'} />
          </div>
        )
      })}

      <div className="mt-4 block rounded-[8px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[11.5px] leading-[1.7] text-[var(--text-muted)]">
        <b className="font-medium text-[var(--text-secondary)]">预置源可停用、不可删除</b> —— 它们随应用版本分发
        （Gutenberg / Standard Ebooks），删掉下次更新还会回来；不想让它参与检索就<b className="font-medium text-[var(--text-secondary)]">停用</b>。
        自己添加的源可随时删除。
      </div>
      <div className="mt-2.5 block rounded-[8px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[11.5px] leading-[1.7] text-[var(--text-muted)]">
        凭据保存在系统加密区（Windows 下由 DPAPI 绑定当前账户），不写进仓库文件，导出源配置时也不会带上。
        <br />本应用不预置、不推荐、不分发任何侵权书源；自定义源只做声明式字段映射，不执行脚本、不抓 HTML。
      </div>
      <div className="mt-2.5 block rounded-[8px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[11.5px] leading-[1.7] text-[var(--text-muted)]">
        <b className="font-medium text-[var(--text-secondary)]">礼貌抓取：</b>公版站的带宽是捐赠来的。因此检索请求限并发 2、带可识别的 User-Agent，
        并遵守站点的 robots 约定 —— 这也是这里不做「整站镜像 / 批量抓取」的原因。下载队列一次只跑一个。
      </div>

      <div className="mb-3 mt-6 flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
        存储
        <span className="h-px flex-1 bg-[var(--border-color)]" />
      </div>
      <div className="block rounded-[8px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[11.5px] leading-[1.7] text-[var(--text-muted)]">
        书籍写入 <code className="rounded bg-[var(--bg-secondary)] px-1 py-[1px] font-mono text-[11px]">&lt;vault&gt;/.books/</code>，
        文件名用「作者 - 书名.扩展名」（路径非法字符自动替换为下划线）；元数据集中一份
        <code className="mx-1 rounded bg-[var(--bg-secondary)] px-1 py-[1px] font-mono text-[11px]">.books/.meta.json</code>
        （书名 / 作者 / 封面 / 来源 / 下载时间 / 大小），封面图存
        <code className="mx-1 rounded bg-[var(--bg-secondary)] px-1 py-[1px] font-mono text-[11px]">.books/.covers/</code>，元数据里只记相对引用。
        {/* 2026-09-22 口径订正：原型的「在书架里删书」路径**不存在**（§1.3 已核实），
            实际是「用户在文件管理器里删 → 元数据自愈回收」（方案 §4.4）。旧文案会让人去找一个没有的按钮。 */}
        书就在仓库里，用文件管理器删掉后，残留的元数据条目与封面会在下次扫描时自动回收（<b className="font-medium text-[var(--text-secondary)]">不进应用暂存区</b>）。
        下载的书若文件已存在，会先问你要<b className="font-medium text-[var(--text-secondary)]">覆盖</b>还是<b className="font-medium text-[var(--text-secondary)]">另存副本</b>（文件名加 (2)），不静默覆盖、也不静默改名。
      </div>

      <div className="mb-3 mt-6 flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
        网络
        <span className="h-px flex-1 bg-[var(--border-color)]" />
      </div>
      <div className="flex items-center gap-2.5 rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] p-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[var(--text-primary)]">HTTP 代理</div>
          <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">留空 = 直连（系统代理由 Chromium 层面处理）· 只作用于书市，不影响 AI 对话与更新</div>
        </div>
        <input
          value={proxy}
          onChange={(e) => setProxy(e.target.value)}
          spellCheck={false}
          placeholder="http://127.0.0.1:7890"
          className="h-[30px] w-[230px] select-text rounded-[7px] border border-[var(--border-color)] bg-[var(--input-bg)] px-2.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        <button
          type="button"
          onClick={() => {
            update('bookMarketProxy', proxy.trim())
            // 代理是 `affects: 'live'` 的设置项：settings:set 里直接挂 applyBookMarketProxy，写完即刻生效
            // toast 的 detail 是帮助章节 id（不是补充说明），所以这里只说完整的一句话
            showToast({ type: 'success', message: proxy.trim() ? '代理已保存 · 书市请求将走此代理（不影响 AI 对话与更新）' : '代理已清空 · 书市直连' })
          }}
          className={btnGhost}
        >
          保存
        </button>
      </div>
      <div className="mt-2.5 block rounded-[8px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[11.5px] leading-[1.7] text-[var(--text-muted)]">
        代理由你自己填写，用于访问自建书库或公版站点。应用不会自动配置代理，也不会为绕开某个站点的访问限制做任何特殊处理。
      </div>
    </div>
  )
}
