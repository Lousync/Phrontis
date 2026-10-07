import { useMemo } from 'react'
import { useSettings } from '../../../lib/SettingsContext'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'

/**  插件安全等级（固定顺序，UI toggle 写入时也按此序拼接） */
const LEVEL_ORDER = ['S', 'A', 'B', 'C'] as const
type LevelKey = typeof LEVEL_ORDER[number]

/** 设置 → 安全与隐私：删除确认 / 插件安全 */
export function SecurityView() {
  const { s, update } = useSettings()

  /** 当前启用的等级集合（来自 settings 字符串 'S,A,B'） */
  const levelsStr = s.pluginAllowedLevels ?? 'S,A,B'
  const selectedLevels = useMemo(
    () => new Set<LevelKey>(levelsStr.split(',').map(t => t.trim().toUpperCase()).filter(t => (LEVEL_ORDER as readonly string[]).includes(t)) as LevelKey[]),
    [levelsStr],
  )
  const toggleLevel = (lv: LevelKey) => {
    const next = new Set(selectedLevels)
    if (next.has(lv)) next.delete(lv); else next.add(lv)
    void update('pluginAllowedLevels', LEVEL_ORDER.filter(l => next.has(l)).join(','))
  }

  return (
    <div>
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">安全与隐私</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-6">误删防护与插件安全策略</p>

      {/* 删除确认 */}
      <div className="mb-8" data-setting-anchor="advanced.deleteConfirm">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">删除确认</h3>
        <div className="space-y-2.5 max-w-sm">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[13px] text-[var(--text-primary)]">跳过博客删除确认对话框</span>
            <SettingSwitch checked={s.skipDeleteConfirm_blog} onChange={(v) => update('skipDeleteConfirm_blog', v)} />
          </label>
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[13px] text-[var(--text-primary)]">跳过知识库页面删除确认对话框</span>
            <SettingSwitch checked={s.skipDeleteConfirm_knowledge} onChange={(v) => update('skipDeleteConfirm_knowledge', v)} />
          </label>
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[13px] text-[var(--text-primary)]">跳过目录/笔记本删除确认对话框</span>
            <SettingSwitch checked={s.skipDeleteConfirm_knowledgeCategory} onChange={(v) => update('skipDeleteConfirm_knowledgeCategory', v)} />
          </label>
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[13px] text-[var(--text-primary)]">跳过章节删除确认对话框</span>
            <SettingSwitch checked={s.skipDeleteConfirm_chapter} onChange={(v) => update('skipDeleteConfirm_chapter', v)} />
          </label>
          {/* v3.2.0 第 20 项：AI 教学「画像更新建议」里删除类条目的二次确认 */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[13px] text-[var(--text-primary)]">跳过画像更新删除确认对话框</span>
            <SettingSwitch checked={s.skipProfileDeleteConfirm} onChange={(v) => update('skipProfileDeleteConfirm', v)} />
          </label>
        </div>
        <p className="text-[11px] text-[var(--text-muted)] mt-2 leading-relaxed">
          关闭"跳过"即恢复删除前的确认弹窗，防止误删。
        </p>
      </div>

      {/* 插件安全 */}
      <div className="space-y-3 max-w-md">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">插件安全</h3>
        <div data-setting-anchor="security.pluginLevels">
          <label className="block text-[12px] text-[var(--text-secondary)] mb-1.5">允许的插件安全等级</label>
          <div className="flex flex-wrap gap-1.5">
            {LEVEL_ORDER.map(lv => {
              const on = selectedLevels.has(lv)
              return (
                <button
                  key={lv}
                  type="button"
                  onClick={() => toggleLevel(lv)}
                  className={`px-3 py-1.5 rounded text-[12px] border transition-colors ${
                    on
                      ? lv === 'C'
                        ? 'border-[var(--warning)] bg-[var(--warning)]/10 text-[var(--warning)]'
                        : 'border-[var(--accent)] bg-[var(--bg-selected)] text-[var(--text-primary)]'
                      : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                  title={
                    lv === 'C' ? 'C 级能力插件需逐项授权' :
                    lv === 'S' ? 'S 级（系统级）' :
                    lv === 'A' ? 'A 级（高权限）' : 'B 级（普通）'
                  }
                >
                  {lv} 级
                </button>
              )
            })}
          </div>
          <p className={`text-[11px] mt-1.5 leading-relaxed ${
            selectedLevels.has('C') ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'
          }`}>
            {selectedLevels.has('C')
              ? '已启用 C 级插件——能力插件将按模块逐项申请授权'
              : '点按钮切换启用等级；勾上 C 表示愿意逐项授权能力插件'}
          </p>
        </div>
        <div data-setting-anchor="security.pluginSignature">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[13px] text-[var(--text-primary)]">市场插件强制签名校验</span>
            <SettingSwitch checked={!!s.pluginRequireSignature} onChange={(v) => update('pluginRequireSignature', v)} />
          </label>
        </div>
        <div data-setting-anchor="security.pluginKeys">
          <label className="block text-[12px] text-[var(--text-secondary)] mb-1">受信公钥 keyring</label>
          <textarea
            value={s.pluginTrustedKeys ?? ''}
            onChange={(e) => update('pluginTrustedKeys', e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder='JSON（如 {"author1":"公钥"}）或 keyId=公钥 逗号分隔'
            className="w-full px-2.5 py-1.5 text-[12px] font-mono bg-[var(--input-bg)] border border-[var(--border-color)] rounded outline-none focus:border-[var(--accent)] text-[var(--text-primary)] resize-y"
          />
        </div>
      </div>
    </div>
  )
}
