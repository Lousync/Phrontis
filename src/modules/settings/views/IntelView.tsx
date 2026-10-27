import { useCallback, useEffect, useState } from 'react'
import { Radar, Trash2 } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import { SettingSelect } from '../components/SettingSelect'
import { NumberField } from '../components/fields/NumberField'
import { SOURCE_META, INTEL_SOURCE_KEYS, SECTION_META, SECTIONS } from '../../../lib/intelPure'
import type { IntelCustomSource, IntelSection } from '../../../types'
import { intelAddCustomSource, intelListCustomSources, intelRemoveCustomSource, intelToggleCustomSource } from '../../../lib/ipc'

/**
 * 设置 → 模块 › 情报（v3.12.0 / v3.13.0 报纸化，docs/intel-module-plan.md §8 + D12）。
 * 抓取节奏 / 13 源开关 / 体量控制 / 自定义 RSS 源编辑器；抓取器与 scheduler 一律 getSetting('intel.*') 取值（不硬编码）。
 * 每行挂 data-setting-anchor（模块顶栏 ⚙ 与设置搜索共用锚点）。
 */
export function IntelView() {
  const { s, update } = useSettings()
  const [customs, setCustoms] = useState<IntelCustomSource[]>([])
  const [draft, setDraft] = useState({ name: '', url: '', section: 'tech' as IntelSection })
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')

  const reloadCustoms = useCallback(async () => {
    try { setCustoms(await intelListCustomSources()) } catch { /* 无仓库时保持空 */ }
  }, [])
  useEffect(() => { void reloadCustoms() }, [reloadCustoms])

  const addCustom = useCallback(async () => {
    setAdding(true)
    setAddError('')
    try {
      const r = await intelAddCustomSource(draft)
      if (r.ok) { setDraft({ name: '', url: '', section: 'tech' }); await reloadCustoms() }
      else setAddError(r.error)
    } catch (err) {
      setAddError(String((err as Error)?.message ?? err).slice(0, 120))
    } finally {
      setAdding(false)
    }
  }, [draft, reloadCustoms])

  return (
    <div className="space-y-10">
      <div>
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">情报</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">
          抓取节奏、数据源与内容筛查。模块顶栏的「刷新」随时可手动拉新，不受这里的间隔影响。
        </p>

        <div className="space-y-7 max-w-xl">
          <div data-setting-anchor="intel.interval">
            <SettingSelect
              title="自动抓取间隔"
              description="后台按间隔自动拉新；「关闭」后仅手动刷新（应用运行时每 5 分钟检查一次到点）。"
              value={String(s['intel.interval'] ?? '3h')}
              onChange={v => update('intel.interval', v)}
              options={[
                { id: 'off', label: '关闭', desc: '不自动抓取，仅手动刷新' },
                { id: '1h', label: '每 1 小时', desc: '紧跟热点，请求量也最大' },
                { id: '3h', label: '每 3 小时', desc: '均衡档位（默认）', isDefault: true },
                { id: '1d', label: '每天', desc: '一天一轮，适合固定时段看资讯' },
              ]}
            />
          </div>

          <div data-setting-anchor="intel.limit">
            <div className="flex items-center justify-between gap-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] text-[var(--text-primary)]">每源单轮上限</span>
                <span className="text-[11px] text-[var(--text-muted)]">单次抓取每个源最多入库的条数；老条目滚动淘汰</span>
              </span>
              <NumberField
                value={Number(s['intel.limit'] ?? 20)}
                onCommit={(v) => update('intel.limit', v)}
                min={5}
                max={50}
                step={5}
                unit="条"
                presets={[10, 20, 30, 50]}
                defaultValue={20}
              />
            </div>
          </div>

          <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] cursor-pointer max-w-xl" data-setting-anchor="intel.filter">
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] text-[var(--text-primary)]">拦截营销与低质内容</span>
              <span className="text-[11px] text-[var(--text-muted)]">命中营销特征词的条目在入库前拦截（宁缺毋滥）</span>
            </span>
            <SettingSwitch checked={s['intel.filter'] !== false} onChange={(v) => update('intel.filter', v)} />
          </label>

          <div data-setting-anchor="intel.keep">
            <div className="flex items-center justify-between gap-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] text-[var(--text-primary)]">条目保留天数</span>
                <span className="text-[11px] text-[var(--text-muted)]">超期未收藏的条目自动清理；收藏条目不受影响</span>
              </span>
              <NumberField
                value={Number(s['intel.keep'] ?? 14)}
                onCommit={(v) => update('intel.keep', v)}
                min={1}
                max={90}
                step={1}
                unit="天"
                presets={[7, 14, 30, 90]}
                defaultValue={14}
              />
            </div>
          </div>

          <div data-setting-anchor="intel.hfBase">
            <label className="flex items-center justify-between gap-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] text-[var(--text-primary)]">HF API 基址</span>
                <span className="text-[11px] text-[var(--text-muted)]">HF Daily Papers 的 API 基址；大陆直连不稳时可配镜像（如 hf-mirror.com）</span>
              </span>
              <input
                type="text"
                value={s['intel.hfBase'] ?? 'https://huggingface.co'}
                onChange={e => update('intel.hfBase', e.target.value)}
                placeholder="https://huggingface.co"
                className="w-[260px] px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </label>
          </div>

          <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] cursor-pointer max-w-xl" data-setting-anchor="intel.translateOn">
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] text-[var(--text-primary)]">卡片英文自动翻译</span>
              <span className="text-[11px] text-[var(--text-muted)]">英文卡片的标题与摘要自动补一行中文灰字（走已配置的 LLM，同一文本只译一次）；中文条目自动跳过</span>
            </span>
            <SettingSwitch checked={s['intel.translateOn'] !== false} onChange={(v) => update('intel.translateOn', v)} />
          </label>

          <div data-setting-anchor="intel.translateBudget">
            <div className="flex items-center justify-between gap-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] text-[var(--text-primary)]">卡片翻译会话上限</span>
                <span className="text-[11px] text-[var(--text-muted)]">本次运行最多翻译的文本条数（防失控）；达到上限后本次运行不再翻译</span>
              </span>
              <NumberField
                value={Number(s['intel.translateBudget'] ?? 300)}
                onCommit={(v) => update('intel.translateBudget', v)}
                min={50}
                max={2000}
                step={50}
                unit="条"
                presets={[100, 300, 500, 1000]}
                defaultValue={300}
              />
            </div>
          </div>
        </div>
      </div>

      <div>
        <h2 className="flex items-center gap-1.5 text-[15px] font-medium text-[var(--text-primary)] mb-1">
          <Radar size={14} className="text-[var(--accent)]" />数据源
        </h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">
          全部免 Key 免登录；单源失败不影响其余源（顶栏会显示「N 源失败」）。
        </p>

        <div className="space-y-3 max-w-md">
          {INTEL_SOURCE_KEYS.map((key) => {
            const k = `intel.source.${key}` as const
            return (
              <label
                key={key}
                className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] cursor-pointer"
                data-setting-anchor={k}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: SOURCE_META[key].fg }} />
                    {SOURCE_META[key].label}
                  </span>
                  <span className="text-[11px] text-[var(--text-muted)]">{SOURCE_DESC[key] ?? ''}</span>
                </span>
                <SettingSwitch checked={s[k] !== false} onChange={(v) => update(k, v)} />
              </label>
            )
          })}
        </div>
      </div>

      <div>
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">自定义 RSS 源</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">
          添加任意 RSS/Atom 地址并归入版面；随仓库走（换仓库即换一套源）。上限 20 个，权重低于全部内置源。
        </p>

        <div className="space-y-2 max-w-xl">
          {customs.map((c) => (
            <div key={c.id} className="flex items-center gap-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-2.5">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-[13px] text-[var(--text-primary)]">
                  📰 <span className="truncate">{c.name}</span>
                  <span className="shrink-0 rounded bg-[var(--bg-tertiary)] px-1.5 py-[1px] text-[10px] text-[var(--text-muted)]">{SECTION_META[c.section].label}</span>
                </span>
                <span className="truncate text-[11px] text-[var(--text-muted)]" title={c.url}>{c.url}</span>
              </span>
              <SettingSwitch
                checked={c.enabled}
                onChange={() => { void intelToggleCustomSource(c.id).then(() => reloadCustoms()) }}
              />
              <button
                onClick={() => { void intelRemoveCustomSource(c.id).then(() => reloadCustoms()) }}
                title="删除该自定义源"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--danger)]"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}

          {/* 行内添加（铁律 25：常规表单不开弹窗） */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-[var(--border-color)] px-3.5 py-2.5">
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="名称（如 财新·一周）"
              className="w-[150px] px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <input
              type="text"
              value={draft.url}
              onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
              placeholder="https://…/feed.xml（RSS/Atom）"
              className="min-w-[220px] flex-1 px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <select
              value={draft.section}
              onChange={(e) => setDraft((d) => ({ ...d, section: e.target.value as IntelSection }))}
              className="px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-[var(--text-primary)] outline-none"
            >
              {SECTIONS.map((sec) => <option key={sec} value={sec}>{SECTION_META[sec].label}</option>)}
            </select>
            <button
              onClick={() => { void addCustom() }}
              disabled={adding || customs.length >= 20}
              title={customs.length >= 20 ? '已达上限 20 个' : '添加该源'}
              className="h-[30px] shrink-0 rounded-md border border-[var(--accent)] px-3 text-[12px] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 disabled:cursor-default disabled:opacity-40"
            >
              添加
            </button>
          </div>
          {addError && <p className="text-[11.5px] text-[var(--danger)]">{addError}</p>}
          {customs.length === 0 && !addError && (
            <p className="text-[11px] text-[var(--text-muted)]">还没有自定义源；添加后下一轮「刷新」即抓取其内容。</p>
          )}
        </div>
      </div>
    </div>
  )
}

const SOURCE_DESC: Record<string, string> = {
  github: '最近 7 天创建、Star 增长最快的仓库（官方 Search API，免 Key）',
  hn: 'Algolia 官方 API，热门讨论 + Show HN',
  arxiv: 'cs 类目最新论文，摘要走专用提取路径',
  openalex: '全学科开放学术索引，免 Key',
  weekly: 'ruanyf/weekly 最新一期内的文章与工具链接（GitHub API）',
  hf: '社区点赞筛选的每日 AI 论文；API 基址可配镜像',
  labs: 'DeepMind / OpenAI 官方 RSS + Anthropic 页面解析，标题前缀区分',
  qbitai: '中文 AI 资讯（官方 RSS，大陆可达）',
  cnblogs: '首页最新技术博客（官方 Atom）',
  csdn: '人工智能频道最新文章（公开页面解析）',
  chinanews: '时政·国内版面（滚动要闻 RSS）',
  chinanews_world: '国际版面（国际频道 RSS）',
  wallstcn: '财经版面（全球快讯 API，纯文快讯）',
}
