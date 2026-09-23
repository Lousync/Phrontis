import { useEffect, useState } from 'react'
import { Sun, Moon, Flame } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { THEME_OPTIONS, BLOG_SIZE_OPTIONS, KNOWLEDGE_SIDEBAR_SIZE_OPTIONS, applyThemeClass } from '../../../lib/settings'
import { STARTABLE_MODULE_IDS, labelOf } from '../../../lib/appModules'
import { BlogIcon, ScheduleIcon, KnowledgeIcon, MomentsIcon, ToolboxIcon, EditorIcon, AiTeachingIcon, PluginIcon, BookMarketIcon, IconPreview } from '../../../components/shared/ModuleIcons'
import { ensurePluginThemeStyles, type PluginThemeWithVars } from '../../../lib/pluginService'
import { BUILTIN_ICON_PACKS, usePluginIconPacks, type IconModuleId } from '../../../lib/sidebarIcons'
import { pluginListDeleteFxSkins } from '../../../lib/ipc'
import { SettingSelect } from '../components/SettingSelect'
import type { DeleteFxSkin, TabName } from '../../../types'

const THEME_ICONS: Record<string, React.ReactNode> = {
  dark:  <Moon size={24} />,
  light: <Sun size={24} />,
}
const THEME_DESCS: Record<string, string> = {
  dark:  'VS Code 风格深色配色，适合夜间使用',
  light: '明亮清爽的浅色配色，适合日间使用',
}

/** 「启动时默认显示」按钮的图标表：成员来自 appModules 的 `startable`，这里只管画什么 */
const STARTUP_ICONS: Record<string, React.ReactNode> = {
  editor: <EditorIcon size={16} />,
  knowledge: <KnowledgeIcon size={16} />,
  blog: <BlogIcon size={16} />,
  schedule: <ScheduleIcon size={16} />,
  moments: <MomentsIcon size={16} />,
  aiTeaching: <AiTeachingIcon size={16} />,
  toolbox: <ToolboxIcon size={16} />,
  plugins: <PluginIcon size={16} />,
  bookMarket: <BookMarketIcon size={16} />,
}

export function AppearanceView() {
  const { s, update } = useSettings()
  const [pluginThemes, setPluginThemes] = useState<PluginThemeWithVars[]>([])
  const [eggInput, setEggInput] = useState('')
  // 彩蛋:输入正确口令激活角标;输入其他值确认则还原(隐式开关),界面无任何标注
  const applyEgg = () => { update('badgeEggActivated', eggInput === 'YHAz'); setEggInput('') }
  const pluginIconPacks = usePluginIconPacks()

  const [fxSkins, setFxSkins] = useState<DeleteFxSkin[]>([])
  useEffect(() => {
    let alive = true
    pluginListDeleteFxSkins().then(list => alive && setFxSkins(list)).catch(() => {})
    return () => { alive = false }
  }, [])
  const fxSkinOptions = [
    { id: 'builtin', name: '内置红色进度条', desc: '纯红色吞噬进度条 · 与删除进度同步' },
    ...fxSkins.map(s => ({ id: s.id || s.pluginId || '', name: s.name || s.pluginId || '', desc: `来自插件「${s.pluginId}」` })),
  ]

  const iconPacks = [
    ...BUILTIN_ICON_PACKS.map(p => ({ id: p.id, label: p.label, desc: '' })),
    ...pluginIconPacks.map(p => ({ id: p.id, label: p.label, desc: `来自插件「${p.pluginName}」` })),
  ]
  // 预览用的模块抽样
  const PREVIEW_MODULES: IconModuleId[] = ['blog', 'schedule', 'knowledge', 'toolbox', 'moments']

  useEffect(() => {
    ensurePluginThemeStyles().then(setPluginThemes).catch(() => {})
    // 插件模块安装/启禁/卸载主题插件后同步刷新
    const refresh = () => { ensurePluginThemeStyles().then(setPluginThemes).catch(() => {}) }
    window.addEventListener('plugins-changed', refresh)
    return () => window.removeEventListener('plugins-changed', refresh)
  }, [])

  const allThemes: { id: string; label: string; desc: string; icon: React.ReactNode }[] = [
    ...THEME_OPTIONS.map(t => ({ id: t.id, label: t.label, desc: THEME_DESCS[t.id] || '', icon: THEME_ICONS[t.id] || <Sun size={24} /> })),
    ...pluginThemes.map(t => ({ id: t.id, label: t.name, desc: `来自插件「${t.pluginName}」`, icon: <PluginIcon size={24} /> })),
  ]

  return (
    <div>
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">外观</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-6">自定义应用的外观和主题</p>

      <div className="mb-8" data-setting-anchor="appearance.theme">
        <SettingSelect
          title="应用主题"
          description="深色 / 浅色配色，以及插件提供的主题包"
          value={s.theme}
          onChange={id => { update('theme', id); applyThemeClass(id) }}
          options={allThemes.map(t => ({
            id: t.id,
            label: t.label,
            desc: t.desc,
            icon: <span className="[&>svg]:h-[18px] [&>svg]:w-[18px]">{t.icon}</span>,
            isDefault: t.id === 'dark',
          }))}
        />
      </div>

      {/* 删除动画皮肤(插件可通过 deleteFx 贡献追加自定义龙头/粒子/颜色) */}
      <div className="mb-8" data-setting-anchor="appearance.deleteFx">
        <SettingSelect
          title="删除动画皮肤"
          description="知识库删除条目时的吞噬特效外观。"
          value={s.deleteFxSkin}
          onChange={id => update('deleteFxSkin', id)}
          options={fxSkinOptions.map(fx => ({
            id: fx.id,
            label: fx.name,
            desc: fx.desc,
            icon: <Flame size={14} />,
            isDefault: fx.id === 'builtin',
          }))}
        />
      </div>

      {/* 侧边栏图标风格(插件可通过 sidebarIcons 贡献追加,新包自动出现在列表末尾) */}
      <div className="mb-8" data-setting-anchor="appearance.sidebarIcons">
        <SettingSelect
          title="侧边栏图标风格"
          description="活动栏模块图标风格。"
          value={s.sidebarIconStyle}
          onChange={id => update('sidebarIconStyle', id)}
          options={iconPacks.map(pack => ({
            id: pack.id,
            label: pack.label,
            desc: pack.desc || undefined,
            icon: (
              <span className="flex items-center gap-1.5">
                {PREVIEW_MODULES.map(m => (
                  <IconPreview key={m} moduleId={m} packId={pack.id} size={14} />
                ))}
              </span>
            ),
            isDefault: pack.id === 'default',
          }))}
        />
      </div>

      {/* AI 助手输入样式（批次5 反馈轮：原型 ai-input-style-prototype.html V1-V9 全量落地） */}
      <div className="mb-8" data-setting-anchor="appearance.assistantInputStyle">
        <SettingSelect
          title="AI 助手输入样式"
          description="AI 助手对话输入框（侧栏 / 右栏 / aiChat 共用）的外观方案。"
          value={typeof s.assistantInputStyle === 'string' ? s.assistantInputStyle : 'v1'}
          onChange={id => update('assistantInputStyle', id)}
          options={[
            { id: 'v1', label: '浅灰填充', desc: '无边框浅灰底，聚焦时底色加深（默认）', isDefault: true },
            { id: 'v2', label: '白卡描边', desc: '白底细边框，聚焦时描边转主题色' },
            { id: 'v3', label: '白卡描边 + 光晕', desc: '描边外发光，聚焦状态最醒目' },
            { id: 'v4', label: '白卡投影', desc: '无边框靠阴影分层，聚焦时投影抬升' },
            { id: 'v5', label: '灰底胶囊', desc: '大圆角胶囊形，聚焦底色加深' },
            { id: 'v6', label: '透明底描边（内凹）', desc: '默认嵌入页面，聚焦浮现浅底' },
            { id: 'v7', label: '双层嵌套', desc: '外灰壳 + 内白输入条，聚焦内条描边' },
            { id: 'v8', label: '下划线极简', desc: '无底无框只留底线，聚焦线变主题色' },
            { id: 'v9', label: '灰底聚焦描边', desc: '平时无边框，聚焦时才显描边' },
          ]}
        />
      </div>

      <div className="mb-8" data-setting-anchor="appearance.startupTab">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">启动时默认显示</h3>
        <p className="text-[11px] text-[var(--text-muted)] mb-3">每次打开应用时，自动切换到该模块。若该模块被隐藏或不可用，则回退到桌面。</p>
        <div className="grid grid-cols-3 gap-2 max-w-sm">
          {(function () {
            // 候选来自唯一真相源（`startable` 标记），不再手抄一份 ——
            // 旧清单少了「桌面」和「AI教学」，而 App 那份候选表同样没有它们，
            // 于是这里选了也白选（会被启动逻辑静默忽略）。
            const TABS: { id: TabName; label: string; icon: React.ReactNode }[] =
              STARTABLE_MODULE_IDS.map(id => ({ id, label: labelOf(id), icon: STARTUP_ICONS[id] }))
            return TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => update('startupTab', tab.id)}
                className={`flex items-center gap-1.5 px-2.5 py-2 rounded text-[12px] border transition-colors ${
                  s.startupTab === tab.id
                    ? 'border-[var(--accent)] bg-[var(--bg-selected)] text-[var(--text-primary)]'
                    : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <span className={s.startupTab === tab.id ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>
                  {tab.icon}
                </span>
                {tab.label}
              </button>
            ))
          })()}
        </div>
      </div>

      <div className="mb-8" data-setting-anchor="appearance.blogCardSize">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">博客卡片大小</h3>
        <div className="flex gap-1.5 max-w-xs">
          {BLOG_SIZE_OPTIONS.map(bs => (
            <button
              key={bs.id}
              onClick={() => update('blogCardSize', bs.id)}
              className={`flex-1 px-2 py-2 rounded text-[12px] border transition-colors ${
                s.blogCardSize === bs.id
                  ? 'border-[var(--accent)] bg-[var(--bg-selected)] text-[var(--text-primary)]'
                  : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              {bs.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-8" data-setting-anchor="appearance.knowledgeSidebarItemSize">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">知识库侧边栏条目</h3>
        <p className="text-[11px] text-[var(--text-muted)] mb-3">知识库侧边栏树形条目（空间/笔记本/章节/页面）的行高与字号；标准档保持默认外观。</p>
        <div className="flex gap-1.5 max-w-xs">
          {KNOWLEDGE_SIDEBAR_SIZE_OPTIONS.map(ks => (
            <button
              key={ks.id}
              onClick={() => update('knowledgeSidebarItemSize', ks.id)}
              className={`flex-1 px-2 py-2 rounded text-[12px] border transition-colors ${
                s.knowledgeSidebarItemSize === ks.id
                  ? 'border-[var(--accent)] bg-[var(--bg-selected)] text-[var(--text-primary)]'
                  : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              {ks.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 mb-2">
        <input
          value={eggInput}
          onChange={e => setEggInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') applyEgg() }}
          className="w-32 px-2 py-1 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        <button
          onClick={applyEgg}
          className="px-3 py-1 text-[11px] rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          确定
        </button>
      </div>
    </div>
  )
}
