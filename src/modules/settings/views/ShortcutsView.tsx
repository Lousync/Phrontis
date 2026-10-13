/**
 * 设置 → 快捷键「指令表」。
 *
 * ★ 2026-10-13 起本表**不再手写**：数据源是 src/lib/commandRegistry.ts（唯一真源）。
 *   改键位 / 改文案 / 加命令一律改真源，**不要在这里加行** —— 手写行会让真源变成一份没人读的
 *   清单，而设置页、AI 手册、命令面板又会各自漂回去（§44 记的那 8 处不符就是这么来的）。
 *
 * 守卫：
 *   · 结构（组数 / 条数 / 键帽 token / 锚点可解析 / 撞车）→ .AGENT/scripts/commands/verify-commands-registry.mjs
 *   · 内容判据（这批键位归哪个组、死键有没有复活、代码里那个分支还在不在、手册同步没）
 *     → .AGENT/scripts/settings/verify-shortcuts-table.mjs
 *
 * 背景与 8 组逐行对账的判据：docs/ui-updates.md §44；真源方案：docs/command-registry-plan.md。
 */
import { COMMAND_GROUPS, commandsOfGroup } from '../../../lib/commandRegistry'

export function ShortcutsView() {
  return (
    <div>
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">快捷键</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-6">所有可用的键盘快捷键一览</p>

      <div className="space-y-8">
        {COMMAND_GROUPS.map((g) => (
          <Group key={g.id} anchor={g.anchor} label={g.label}>
            {commandsOfGroup(g.id).map((c) => (
              <Row key={c.id} chords={c.keys} desc={c.desc} />
            ))}
          </Group>
        ))}
      </div>
    </div>
  )
}

function Group({ anchor, label, children }: { anchor: string; label: string; children: React.ReactNode }) {
  return (
    <div data-setting-anchor={anchor}>
      <h3 className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
        {label}
      </h3>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

/**
 * 一行快捷键。
 * - `chords` = 多组同效组合键（真源里就是 `string[][]`）。一组时渲染成一排键帽；
 *   多组时组间用 `/` 分隔（如 `Ctrl+P` / `Ctrl` + 反引号 / `Ctrl+Shift+F`）——
 *   少了这个分隔，三个同效键会挤成七枚键帽、读不出「三选一」的意思。
 */
function Row({ chords, desc }: { chords: string[][]; desc: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[13px] text-[var(--text-primary)]">{desc}</span>
      <div className="flex items-center gap-1 shrink-0">
        {chords.map((g, gi) => (
          <span key={gi} className="flex items-center gap-1">
            {gi > 0 && <span className="px-0.5 text-[10px] text-[var(--text-secondary)]">/</span>}
            {g.map((k, i) => (
              <span
                key={i}
                className="kb-kbd px-1.5 py-0.5 text-[11px] rounded min-w-[20px] justify-center"
              >
                {k}
              </span>
            ))}
          </span>
        ))}
      </div>
    </div>
  )
}
