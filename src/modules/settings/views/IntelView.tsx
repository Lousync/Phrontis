import { Radar } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import { SettingSelect } from '../components/SettingSelect'
import { NumberField } from '../components/fields/NumberField'
import { SOURCE_META, INTEL_SOURCE_KEYS } from '../../../lib/intelPure'

/**
 * 设置 → 模块 › 情报（v3.12.0，docs/intel-module-plan.md §8）。
 * 抓取节奏 / 8 源开关 / 体量控制；抓取器与 scheduler 一律 getSetting('intel.*') 取值（不硬编码）。
 * 每行挂 data-setting-anchor（模块顶栏 ⚙ 与设置搜索共用锚点）。
 */
export function IntelView() {
  const { s, update } = useSettings()

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
}
