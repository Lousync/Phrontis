import { useSettings } from '../../../lib/SettingsContext'
import { SETTINGS } from '../../../lib/settings'
import { NumberField } from '../components/fields/NumberField'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'

/** 设置 → 通用与行为：界面缩放 / 外壳布局（Workbench 灰度）/ 自动保存信息 */
export function GeneralView() {
  const { s, update } = useSettings()

  const zoomPct = Math.round(s.zoom * 100)

  return (
    <div>
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">通用与行为</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-6">启动、缩放、外壳与基础行为</p>

      {/* 启动行为（仓库选择页，Obsidian 式） */}
      <div className="mb-8" data-setting-anchor="startup.vaultPicker">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">启动行为</h3>
        <div className="max-w-md space-y-4">
          <label className="flex items-center justify-between gap-4 cursor-pointer">
            <span className="text-[13px] text-[var(--text-primary)] leading-relaxed">
              每次启动选择仓库
              <span className="block text-[11px] text-[var(--text-muted)] mt-0.5 leading-relaxed">
                进入应用时先显示仓库选择页，可从已有仓库一键进入；关闭后直连上次的仓库。
              </span>
            </span>
            <SettingSwitch checked={!!s.startupVaultPicker} onChange={(v) => update('startupVaultPicker', v)} />
          </label>
        </div>
      </div>

      {/* 界面缩放 */}
      <div className="mb-8" data-setting-anchor="advanced.zoom">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">界面缩放</h3>
        <NumberField
          value={zoomPct}
          onCommit={(pct) => update('zoom', pct / 100)}
          min={SETTINGS.zoom.min}
          max={SETTINGS.zoom.max}
          step={SETTINGS.zoom.step}
          unit="%"
          presets={[100, 110, 125, 150]}
          defaultValue={Math.round(SETTINGS.zoom.default * 100)}
        />
        <p className="text-[11px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
          窗口态的缩放比例；步进 ±5%。缩放作用于整个界面（文字、控件、间距一起放大），当前 {zoomPct}%。
        </p>
        <label className="mt-4 flex max-w-md items-center justify-between gap-4 cursor-pointer" data-setting-anchor="advanced.zoomMaxBoost">
          <span className="text-[13px] text-[var(--text-primary)] leading-relaxed">
            最大化时自动放大
            <span className="block text-[11px] text-[var(--text-muted)] mt-0.5 leading-relaxed">
              窗口最大化 / 全屏时在基础缩放上再放大 30%（默认 100% → 130%），避免大屏下字显得小；关闭后两态用同一档。
            </span>
          </span>
          <SettingSwitch checked={s.uiZoomMaximizedBoost !== false} onChange={(v) => update('uiZoomMaximizedBoost', v)} />
        </label>
      </div>

      {/* 外壳布局（Workbench 灰度 R1-W1） */}
      <div className="mb-8" data-setting-anchor="advanced.workbench">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">外壳布局</h3>
        <div className="max-w-md space-y-4">
          <label className="flex items-center justify-between gap-4 cursor-pointer">
            <span className="text-[13px] text-[var(--text-primary)] leading-relaxed">
              启用 Workbench 布局
              <span className="block text-[11px] text-[var(--text-muted)] mt-0.5 leading-relaxed">
                实验性 VS Code 外壳布局，可随时切回。
              </span>
            </span>
            <SettingSwitch checked={!!s.uiWorkbench} onChange={(v) => update('uiWorkbench', v)} />
          </label>
        </div>
      </div>

      {/* 自动保存 */}
      <div data-setting-anchor="advanced.autosave">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">自动保存</h3>
        <div className="max-w-md">
          <NumberField
            value={s.autoSaveDebounceMs}
            onCommit={(v) => update('autoSaveDebounceMs', v)}
            min={100}
            max={30000}
            step={100}
            unit="ms"
            presets={[500, 1000, 2000, 5000]}
            defaultValue={2000}
          />
          <p className="text-[11px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
            停止输入后 {s.autoSaveDebounceMs / 1000} 秒自动保存（可直接输入毫秒）。
          </p>
        </div>
      </div>
    </div>
  )
}
