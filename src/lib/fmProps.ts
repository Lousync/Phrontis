/**
 * 「笔记属性」的 frontmatter 读改（2026-10-13 页面菜单能力补齐批 4）。
 *
 * 为什么单独成文件（零依赖）：这两个函数是**纯函数**，只在字符串上进进出出 —— 放这儿才能被
 * `.AGENT/scripts/page-menu/verify-page-menu.mjs` 直接 import 做真值断言（放进 PageEditor.tsx
 * 就只能靠源码文本猜，而这里是「会不会静默毁数据」的地方，必须真跑）。
 *
 * ★ 核心纪律：**绝不重建整块前缀**。YAML 的列表 / 嵌套是多行结构，按「解析成键值对再拼回去」
 *   的常规做法会把它压平成一行 —— 那是**静默毁数据**（用户看不出，直到下次用 YAML 解析）。
 *   所以这里按**行号做外科手术**：只动被标记的那几行，其余字节原样保留。
 *
 * 三类行：
 *   · 单行 `key: value` → 可改、可删（把键清空即删除）；
 *   · 值跨行的（下一行缩进，或以 `- ` 开头）→ 只读；
 *   · `id` → 只读（身份：2026-09-20 身份统一后没有「草稿」概念，id 丢了就是另一篇）。
 */

export interface FmPropRow {
  key: string
  value: string
  /** 在 frontmatter 内部行数组里的下标；**-1 = 新增行**（写到闭合 `---` 之前） */
  line: number
  readonly?: boolean
}

/** frontmatter 前缀的形状：`---\n…\n---\n`（与 `src/lib/frontmatter.ts` 的 splitFrontmatter 同一口径） */
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/

/** 拆出属性行；解析不到 frontmatter 返回空数组（调用方据此提示「这一页还没有属性」） */
export function parseFmPropRows(prefix: string): FmPropRow[] {
  const m = FM_RE.exec(prefix)
  if (!m) return []
  const lines = m[1].split('\n')
  const rows: FmPropRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const mm = /^([A-Za-z_][\w.-]*):[ \t]*(.*)$/.exec(lines[i])
    if (!mm) continue
    const next = lines[i + 1] ?? ''
    const multiline = /^[ \t]/.test(next) || /^-[ \t]/.test(next.trim())
    rows.push({ key: mm[1], value: mm[2], line: i, readonly: mm[1] === 'id' || multiline })
  }
  return rows
}

/** 把（改过的）行写回前缀：只动被标记的那些行，其余字节原样保留 */
export function applyFmPropRows(prefix: string, rows: FmPropRow[]): string {
  const m = FM_RE.exec(prefix)
  if (!m) return prefix
  const lines = m[1].split('\n')
  const touched = rows.filter((r) => !r.readonly)
  // 先处理已有行：**从后往前**改，行号才不串（升序会把刚写进去的新行号当旧行号二次改写）
  for (const r of [...touched].filter((r) => r.line >= 0).sort((a, b) => b.line - a.line)) {
    if (!r.key.trim()) lines.splice(r.line, 1) // 键清空 = 删除这一条
    else lines[r.line] = `${r.key.trim()}: ${r.value}`
  }
  // 新增行：插在闭合 `---` 之前（即内部行数组末尾）
  for (const r of touched.filter((r) => r.line < 0 && r.key.trim())) lines.push(`${r.key.trim()}: ${r.value}`)
  return prefix.replace(FM_RE, `---\n${lines.join('\n')}\n---`)
}
