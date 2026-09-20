import { useSettings } from '../../../lib/SettingsContext'
import { FONT_OPTIONS, FONT_CSS_MAP } from '../../../lib/settings'
import { SettingSelect } from '../components/SettingSelect'
import { NumberField } from '../components/fields/NumberField'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'

export function EditorView() {
  const { s, update } = useSettings()

  return (
    <div>
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">编辑器</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-6">自定义编辑器行为和外观</p>

      <div className="mb-8" data-setting-anchor="editor.font">
        <SettingSelect
          title="字体样式"
          description="编辑器正文使用的字体"
          value={s.editorFont}
          onChange={id => {
            update('editorFont', id)
            if (FONT_CSS_MAP[id]) {
              document.documentElement.style.setProperty('--font-sans', FONT_CSS_MAP[id])
            }
          }}
          options={FONT_OPTIONS.map(f => ({
            id: f.id,
            label: f.label,
            desc: FONT_CSS_MAP[f.id].split(',')[0].replace(/'/g, ''),
            // 用该字体本身渲染预览字样，直观展示效果
            icon: <span className="text-[13px]" style={{ fontFamily: FONT_CSS_MAP[f.id] }}>Aa</span>,
            isDefault: f.id === 'system',
          }))}
        />
      </div>

      <div className="mb-8" data-setting-anchor="editor.fontSize">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">字号</h3>
        <NumberField
          value={s.editorFontSize}
          onCommit={(v) => update('editorFontSize', v)}
          min={10}
          max={40}
          step={1}
          unit="px"
          presets={[12, 13, 14, 15, 16, 18, 20]}
          defaultValue={13}
        />
        <p className="text-[11px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
          可直接输入任意字号（10-40px），或点预设档位；输入越界会提示且不生效。
        </p>
      </div>

      <div data-setting-anchor="editor.lineNumbers">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">显示</h3>
        <label className="flex items-center justify-between gap-4 cursor-pointer max-w-md">
          <span className="text-[13px] text-[var(--text-primary)]">显示行号</span>
          <SettingSwitch checked={s.showLineNumbers} onChange={(v) => update('showLineNumbers', v)} />
        </label>
        <div data-setting-anchor="editor.markdownDim" className="mt-2.5">
          <label className="flex items-center justify-between gap-4 cursor-pointer max-w-md">
            <span className="text-[13px] text-[var(--text-primary)]">Markdown 标记淡化（光标行保留原始标记）</span>
            <SettingSwitch checked={s.markdownDim} onChange={(v) => update('markdownDim', v)} />
          </label>
        </div>
        <div data-setting-anchor="editor.treeGuides" className="mt-4 max-w-md">
          <SettingSelect
            title="侧栏层级参考线"
            description="编辑器 / 知识库 / AI教学 左栏多层树的层级竖线，辅助辨认嵌套归属"
            value={(s.sidebarTreeGuides as string) ?? 'line'}
            onChange={(v) => update('sidebarTreeGuides', v)}
            options={[
              { id: 'line', label: '实线', isDefault: true },
              { id: 'dashed', label: '虚线' },
              { id: 'none', label: '关闭' },
            ]}
          />
        </div>
        <p className="text-[11px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
          编辑 .md 时光标所在行之外的格式标记（**、#、链接、[[双链]] 等）会淡化显示，
          被包裹的内容以加粗/斜体/链接色呈现——写作时更接近阅读效果。
        </p>
        <div data-setting-anchor="editor.folderFocus" className="mt-4 max-w-md">
          <SettingSelect
            title="目录聚焦样式"
            description="目录聚焦开启时（编辑器/知识库侧栏的准星按钮），非当前路径分支的呈现方式"
            value={(s.folderFocusStyle as string) ?? 'skeleton'}
            onChange={(v) => update('folderFocusStyle', v)}
            options={[
              { id: 'skeleton', label: '骨架式', desc: '其余分支保留占位条，悬停显示原名', isDefault: true },
              { id: 'hidden', label: '隐藏式', desc: '只保留当前目录链，更干净' },
            ]}
          />
        </div>
      </div>

      {/* AI 内联建议设置已迁往「AI 工具 → 模型」页（2026-09-20 反馈：统一设置管理） */}
    </div>
  )
}
