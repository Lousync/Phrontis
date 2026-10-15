import { useState, type ReactNode } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'
import { aiTeachSrcSofficeProbe } from '../../../lib/ipc'
import { HelpHint } from '../../../components/shared/HelpHint'

/**
 * 设置 → AI → 工具 · 高级（2026-10-13 按原型「28 项去向表」归位；2026-10-14 改成「一行一物」）。
 *
 * 搬来这里的每一项原型都标了出处：
 *   · sofficePath —— 「工具 · 高级 · LibreOffice 路径（**原在「模型」页**）」。
 *     它管的是 pptx 视觉转写的前置，跟"选哪个模型"没关系，留在模型页属于混域。
 *   · webCrawlMaxPages / webCrawlDelayMs —— 「工具 · 高级」，此前是 `ui:false`，
 *     即整份代码里没有任何入口（只能手改 settings.json）。
 *
 * ★ 初版为了「锚点必须常驻」把三项**常显**（`Collapsible` 关着时内层不挂载，锚点就不在 DOM 里）。
 *   2026-10-14 折叠化之后这条约束改由 `SettingsGroup` 的 `anchorIds` 保证：
 *   声明的锚点落进组里时组会自动展开，锚点随之挂载 —— 于是三项也能进折叠，不必再占首屏。
 *   ⚠ 但 `data-setting-anchor` 必须**字面量写在视图里**：契约脚本是扫源码文本数锚点的，
 *   走 props 传值（`anchor={…}`）两边都认不出来。
 */
const SOFFICE_SOURCE_LABEL: Record<string, string> = {
  setting: '此处填写的路径',
  env: '环境变量 SOFFICE_PATH',
  registry: 'Windows 注册表（安装器写入）',
  candidate: '常见安装位置',
  path: '系统 PATH',
}

export function AiToolsAdvanced() {
  const { s, update } = useSettings()
  // LibreOffice 探测结果：纯即时反馈，不持久化（路径本身存在设置里）
  const [sofficeProbe, setSofficeProbe] = useState<{ ok: boolean; path?: string; source?: string } | null>(null)
  const [sofficeTesting, setSofficeTesting] = useState(false)

  const testSoffice = async () => {
    if (sofficeTesting) return
    setSofficeTesting(true)
    try {
      setSofficeProbe(await aiTeachSrcSofficeProbe(s.sofficePath ?? ''))
    } catch (e) {
      showToast({ type: 'error', message: `检测失败：${(e as Error).message}` })
    } finally {
      setSofficeTesting(false)
    }
  }

  return (
    <div className="max-w-md rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5">
      <div data-setting-anchor="aiTools.sofficePath" className="border-t border-[var(--border-color)] first:border-t-0">
        <ARow label="LibreOffice 路径"
          hint="AI 教学素材（pptx / docx）的视觉转写需先经本机 LibreOffice 转换为 PDF。留空表示自动探测（Windows 注册表、常见安装位置、系统 PATH）；安装在自定义目录时填写 soffice.exe 的绝对路径，填写后点击「检测」即可验证。">
          <input
            value={s.sofficePath ?? ''}
            onChange={e => { void update('sofficePath', e.target.value); setSofficeProbe(null) }}
            placeholder="D:\tools\LibreOffice\program\soffice.exe"
            spellCheck={false}
            className="flex-1 min-w-0 px-2.5 py-1.5 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-[var(--accent)]"
          />
          <button onClick={() => { void testSoffice() }} disabled={sofficeTesting}
            className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors">
            {sofficeTesting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 检测
          </button>
        </ARow>
        {/* 探测结果是**即时反馈**（不是常驻说明）：当场告诉用户"找到了没有、从哪儿找到的" */}
        {sofficeProbe && (
          <p className="pb-2.5 -mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
            {sofficeProbe.ok
              ? <>已找到：<span className="text-[var(--text-secondary)] break-all">{sofficeProbe.path}</span>（来源：{SOFFICE_SOURCE_LABEL[sofficeProbe.source ?? ''] ?? sofficeProbe.source}）</>
              : '未找到：请确认已安装 LibreOffice，或在上方填写 soffice.exe 完整路径后重新检测'}
          </p>
        )}
      </div>

      {/* 网页抓取（此前 ui:false：整份代码没有任何入口，只能手改 settings.json） */}
      <div data-setting-anchor="aiTools.crawlPages" className="border-t border-[var(--border-color)]">
        <ARow label="单次抓取页数上限" hint="用于「展开网页」批量抓取素材；1 ~ 200。">
          <input type="number" min={1} max={200} value={String(s.webCrawlMaxPages ?? 80)}
            onChange={e => { void update('webCrawlMaxPages', Math.min(200, Math.max(1, Math.floor(Number(e.target.value) || 80)))) }}
            className="w-24 shrink-0 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-right outline-none focus:border-[var(--accent)]" />
        </ARow>
      </div>

      <div data-setting-anchor="aiTools.crawlDelay" className="border-t border-[var(--border-color)]">
        <ARow label="每页间隔（毫秒）" hint="默认值 300，范围 0 ~ 5000；抓取间隔不宜设为 0，否则易被目标站点限流。">
          <input type="number" min={0} max={5000} value={String(s.webCrawlDelayMs ?? 300)}
            onChange={e => { void update('webCrawlDelayMs', Math.min(5000, Math.max(0, Math.floor(Number(e.target.value) || 0)))) }}
            className="w-24 shrink-0 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-right outline-none focus:border-[var(--accent)]" />
        </ARow>
      </div>
    </div>
  )
}

/** 高级里的一行：左「标签 + ⓘ」、右「控件」 */
function ARow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 py-2.5">
      <span className="w-[120px] shrink-0 flex items-center gap-1.5 text-[13px] text-[var(--text-primary)]">
        <span className="truncate">{label}</span>
        {hint ? <HelpHint text={hint} /> : null}
      </span>
      <div className="flex-1 min-w-0 flex items-center gap-2 justify-end">{children}</div>
    </div>
  )
}
