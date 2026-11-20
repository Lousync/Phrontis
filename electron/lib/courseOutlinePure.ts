/**
 * AI 教学重构 P0 · `课程.md` v2 大纲纯函数（解析 / 重写 / 校验 / 差异 / 保护 / 拓扑排序）
 *
 * 契约面：
 * - `parseCourseMd` / `rewriteCourseMd` —— 向后兼容 **4 列旧格式**（原样往返）与
 *   **6 列 v2 格式**（`type` / `requires`，第 7 列起 `extra` 原样回写）；
 * - `validateOutline` —— 空名称 / 非法 type / 先修缺失 / 自引用 / 环 / 重复 id；
 * - `diffOutlines` —— 只产出 `OutlineDiffOp` 联合里的类型；
 * - `protectLearned` —— 已学知识点拒绝删除 / 改名（方案 §39.3）；
 * - `topoOrderUnits` —— 章内按先修稳定重排，非法输入原样返回（不抛错）。
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §2.5、
 *       `/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` §39。
 * 契约脚本：`.AGENT/scripts/ai-teaching/verify-outline-v2.mjs`。
 *
 * 行格式：
 * ```text
 * # 课程：{title}
 * - 目标: {goal}                     # 可选
 * - 依据: {anchor}                   # 可选
 *
 * ## [c1] 章名                      # 章 id 可选（旧文件无 id）
 * - 章目标: {...}                    # 可选，独立一行，不当知识点
 * - u1 | 名称 | 目标 | 出处 | type | requires[,requires] | extra...
 * ```
 *
 * 取舍说明（改动必须同步契约脚本）：
 * - **名称 / 目标 / 出处里不允许出现 `|`**。解析按 `|` 切列，多余段按列位自然落位：
 *   第 5 列 type、第 6 列 requires、第 7 列起进 `extra`，重写时逐字回写 —— 即「保留原文」
 *   而非报错；写盘侧（`rewriteCourseMd`）把字段内的 `|` 换成全角 `／`，保证不再产生歧义。
 * - 旧 4 列行不补 `concept` / 空 requires 列：列数由模块内 Symbol 记录（不污染共享类型、
 *   不进 JSON），只有语义真的变化（type 改了 / 有先修 / 有 extra）才扩列。
 *   Symbol 随结构化克隆丢失时退化为标准 6 列输出（语义不变）。
 * - `requires` 兼容中文逗号；重写优先复用源列原文（空格 / 逗号风格不变）。
 *
 * 纯函数、零运行时依赖（只允许 `import type`）；可被 stripTypeScriptTypes 后直接 import。
 */

import type {
  ChapterBlock,
  CourseOutlineV2,
  OutlineDiffOp,
  OutlineValidationIssue,
  UnitRow,
  UnitType,
} from './aiTeachingTypesPure'

/** 合法知识点类型（顺序即 `UnitType` 联合顺序） */
const UNIT_TYPES: readonly UnitType[] = ['memory', 'concept', 'procedure', 'design']

/** 解析期列形态（`cols` = 源行有几列，最多记到 6 列；第 7 列起进 extra） */
interface UnitShape {
  cols: number
  typeRaw?: string
  reqRaw?: string
}

/** 私有标记键：Symbol 不进 JSON、不污染 `UnitRow` 共享类型 */
const UNIT_SHAPE = Symbol('aiTeaching.unitShape')
/** 章行是否带 `[cN]`（旧文件无 id，重写时保持无 id，保证逐字往返） */
const CHAPTER_IDLESS = Symbol('aiTeaching.chapterIdless')

type UnitRowInternal = UnitRow & { [UNIT_SHAPE]?: UnitShape }
type ChapterInternal = ChapterBlock & { [CHAPTER_IDLESS]?: boolean }

/** 字段清洗：去换行、`|` 换全角、去首尾空白（与现有 `aiTeachingCoursePure.cleanField` 同口径） */
function cleanField(v: unknown): string {
  return String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '／')
    .trim()
}

/** 先修列切分：英文 / 中文逗号都认 */
function splitRequires(raw: unknown): string[] {
  return String(raw ?? '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function uniqueList(list: string[]): string[] {
  const out: string[] = []
  for (const s of list) if (!out.includes(s)) out.push(s)
  return out
}

/** 源先修列原文与当前语义是否一致（一致则重写时原样回写，保证幂等） */
function sameRequires(raw: string, requires: string[]): boolean {
  const a = uniqueList(splitRequires(raw))
  const b = uniqueList((requires ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * 解析 `课程.md`（v2 与旧 4 列格式共用一条路径）。
 * 容忍缺列 / 缺 id / CRLF；不抛错。空 id 的 `- ` 行跳过（无法定位知识点）。
 */
export function parseCourseMd(text: string): CourseOutlineV2 {
  const out: CourseOutlineV2 = { title: '', goal: '', anchor: '', chapters: [] }
  let cur: ChapterInternal | null = null

  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) continue

    const title = /^#\s*课程\s*[：:]\s*(.*)$/.exec(line)
    if (title) {
      out.title = title[1].trim()
      continue
    }

    const chapter = /^#{2,6}\s+(?:\[([A-Za-z0-9_-]+)\]\s*)?(.*)$/.exec(line)
    if (chapter) {
      const name = (chapter[2] ?? '').trim()
      const explicitId = (chapter[1] ?? '').trim()
      cur = {
        id: explicitId || `c${out.chapters.length + 1}`,
        name,
        objective: '',
        units: [],
      }
      if (!explicitId) cur[CHAPTER_IDLESS] = true
      out.chapters.push(cur)
      continue
    }

    // 章目标：独立一行，归到章，绝不当知识点
    const objective = /^[-*]\s*章目标\s*[：:]\s*(.*)$/.exec(line)
    if (objective && cur) {
      cur.objective = objective[1].trim()
      continue
    }

    const goal = /^[-*]?\s*目标\s*[：:]\s*(.*)$/.exec(line)
    if (goal) {
      out.goal = goal[1].trim()
      continue
    }

    const anchor = /^[-*]?\s*依据\s*[：:]\s*(.*)$/.exec(line)
    if (anchor) {
      out.anchor = anchor[1].trim()
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (!bullet || !cur) continue

    // 按 `|` 切列：多余段按列位落位（≥7 进 extra），不抛错、不丢文本
    const parts = bullet[1].split('|')
    const id = (parts[0] ?? '').trim()
    if (!id) continue

    const cols = Math.min(parts.length, 6)
    const typeRaw = parts.length >= 5 ? (parts[4] ?? '').trim() : undefined
    const reqRaw = parts.length >= 6 ? (parts[5] ?? '').trim() : undefined

    const row: UnitRowInternal = {
      id,
      name: (parts[1] ?? '').trim(),
      goal: (parts[2] ?? '').trim(),
      source: (parts[3] ?? '').trim(),
      // 非法 type 原样保留（validateOutline 报 bad-type），缺省 concept
      type: ((typeRaw || 'concept') as UnitType),
      requires: reqRaw === undefined ? [] : uniqueList(splitRequires(reqRaw)),
      extra: parts.length > 6 ? parts.slice(6).map((s) => s.trim()) : [],
    }
    row[UNIT_SHAPE] = { cols, typeRaw, reqRaw }
    cur.units.push(row)
  }

  return out
}

/** 单条知识点行（列数由解析期 Symbol 决定；语义变化时自动扩列） */
function unitLine(u: UnitRow): string {
  const shape = (u as UnitRowInternal)[UNIT_SHAPE]
  const cols = shape?.cols ?? 6
  const extra = (u.extra ?? []).map((s) => String(s ?? '').trim())

  const typeRaw = shape?.typeRaw
  const typeOut = typeRaw !== undefined && (typeRaw || 'concept') === u.type ? typeRaw : u.type
  const reqOut = shape?.reqRaw !== undefined && sameRequires(shape.reqRaw, u.requires)
    ? shape.reqRaw
    : (u.requires ?? []).map((s) => cleanField(s)).filter(Boolean).join(', ')

  const needType = cols >= 5 || typeOut !== 'concept' || reqOut !== '' || extra.length > 0
  const needRequires = cols >= 6 || reqOut !== '' || extra.length > 0

  const parts = [cleanField(u.id), cleanField(u.name), cleanField(u.goal), cleanField(u.source)]
  if (needType) parts.push(String(typeOut))
  if (needRequires) parts.push(reqOut)
  for (const e of extra) parts.push(e)

  // 末尾空列（如 `| concept |`）不产生行尾空格
  return `- ${parts.join(' | ').replace(/\s+$/, '')}`
}

/**
 * 重写 `课程.md`。对 `parseCourseMd` 的结果幂等：
 * 旧 4 列 / 无章 id / requires 列原文风格都原样保留（行尾空白统一，末尾恒一个 `\n`）。
 */
export function rewriteCourseMd(o: CourseOutlineV2): string {
  const lines: string[] = [`# 课程：${cleanField(o.title) || '未命名课程'}`]
  if (cleanField(o.goal)) lines.push(`- 目标: ${cleanField(o.goal)}`)
  if (cleanField(o.anchor)) lines.push(`- 依据: ${cleanField(o.anchor)}`)
  lines.push('')

  o.chapters.forEach((c, ci) => {
    const idless = (c as ChapterInternal)[CHAPTER_IDLESS] === true
    const name = cleanField(c.name) || `第${ci + 1}章`
    if (idless) {
      lines.push(`## ${name}`)
    } else {
      const cid = cleanField(c.id) || `c${ci + 1}`
      lines.push(`## [${cid}] ${name}`)
    }
    if (cleanField(c.objective)) lines.push(`- 章目标: ${cleanField(c.objective)}`)
    for (const u of c.units) lines.push(unitLine(u))
    lines.push('')
  })

  return lines.join('\n')
}

/** 校验：空名称 / 非法 type / 先修缺失 / 自引用 / 环 / 重复 unit id */
export function validateOutline(o: CourseOutlineV2): OutlineValidationIssue[] {
  const issues: OutlineValidationIssue[] = []
  const allIds = new Set<string>()
  for (const c of o.chapters ?? []) {
    for (const u of c.units ?? []) {
      const id = String(u.id ?? '').trim()
      if (id) allIds.add(id)
    }
  }

  const seen = new Set<string>()
  const reqMap = new Map<string, string[]>()
  const order: string[] = []

  for (const c of o.chapters ?? []) {
    for (const u of c.units ?? []) {
      const id = String(u.id ?? '').trim()
      if (!id) continue
      const requires = uniqueList((u.requires ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))
      if (seen.has(id)) {
        issues.push({ code: 'duplicate-unit-id', chapterId: c.id, unitId: id })
      } else {
        seen.add(id)
        order.push(id)
        reqMap.set(id, requires)
      }
      if (!String(u.name ?? '').trim()) {
        issues.push({ code: 'unit-empty-name', chapterId: c.id, unitId: id })
      }
      if (!UNIT_TYPES.includes(u.type)) {
        issues.push({ code: 'bad-type', chapterId: c.id, unitId: id, detail: String(u.type ?? '') })
      }
      for (const d of requires) {
        if (d === id) {
          issues.push({ code: 'requires-self', chapterId: c.id, unitId: id })
        } else if (!allIds.has(d)) {
          issues.push({ code: 'requires-missing', chapterId: c.id, unitId: id, detail: d })
        }
      }
    }
  }

  // 环检测：三色 DFS（自引用已单独报，跳过自环避免重复）
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const reported = new Set<string>()
  const visit = (id: string): void => {
    state.set(id, 1)
    stack.push(id)
    for (const dep of reqMap.get(id) ?? []) {
      if (dep === id) continue
      const st = state.get(dep)
      if (st === 1) {
        const at = stack.indexOf(dep)
        const cycle = stack.slice(at >= 0 ? at : 0)
        for (const x of cycle) {
          if (reported.has(x)) continue
          reported.add(x)
          issues.push({ code: 'requires-cycle', unitId: x, detail: cycle.join(' -> ') })
        }
      } else if (st === undefined) {
        visit(dep)
      }
    }
    stack.pop()
    state.set(id, 2)
  }
  for (const id of order) if (!state.has(id)) visit(id)

  return issues
}

function indexUnits(o: CourseOutlineV2): Map<string, { chapterId: string; unit: UnitRow }> {
  const map = new Map<string, { chapterId: string; unit: UnitRow }>()
  for (const c of o.chapters ?? []) {
    for (const u of c.units ?? []) {
      if (!map.has(u.id)) map.set(u.id, { chapterId: c.id, unit: u })
    }
  }
  return map
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * 大纲差异（只产出 `OutlineDiffOp` 里的类型）。
 * 章内顺序：只比较**两版都在同一章**的知识点相对次序，移动 / 增删不算重排。
 */
export function diffOutlines(a: CourseOutlineV2, b: CourseOutlineV2): OutlineDiffOp[] {
  const ops: OutlineDiffOp[] = []
  const aCh = new Map((a.chapters ?? []).map((c) => [c.id, c]))
  const bCh = new Map((b.chapters ?? []).map((c) => [c.id, c]))
  const aUnits = indexUnits(a)
  const bUnits = indexUnits(b)

  for (const c of b.chapters ?? []) {
    const old = aCh.get(c.id)
    if (!old) ops.push({ op: 'add-chapter', chapterId: c.id, name: c.name })
    else if (old.name !== c.name) ops.push({ op: 'rename-chapter', chapterId: c.id, from: old.name, to: c.name })
  }
  for (const c of a.chapters ?? []) {
    if (!bCh.has(c.id)) ops.push({ op: 'remove-chapter', chapterId: c.id, name: c.name })
  }

  for (const c of b.chapters ?? []) {
    for (const u of c.units ?? []) {
      const prev = aUnits.get(u.id)
      if (!prev) {
        ops.push({ op: 'add-unit', unitId: u.id, chapterId: c.id, name: u.name })
        continue
      }
      if (prev.chapterId !== c.id) {
        ops.push({ op: 'move-unit', unitId: u.id, fromChapterId: prev.chapterId, toChapterId: c.id })
      }
      if (prev.unit.name !== u.name) {
        ops.push({ op: 'rename-unit', unitId: u.id, from: prev.unit.name, to: u.name })
      }
      if (prev.unit.type !== u.type) {
        ops.push({ op: 'retype-unit', unitId: u.id, from: prev.unit.type, to: u.type })
      }
      if (!sameList(prev.unit.requires ?? [], u.requires ?? [])) {
        ops.push({ op: 'requires-change', unitId: u.id, from: [...(prev.unit.requires ?? [])], to: [...(u.requires ?? [])] })
      }
    }
  }
  for (const c of a.chapters ?? []) {
    for (const u of c.units ?? []) {
      if (bUnits.has(u.id)) continue
      ops.push({ op: 'remove-unit', unitId: u.id, chapterId: c.id, name: u.name })
    }
  }

  for (const c of b.chapters ?? []) {
    const old = aCh.get(c.id)
    if (!old) continue
    const commonIds = new Set(
      (c.units ?? []).filter((u) => aUnits.get(u.id)?.chapterId === c.id).map((u) => u.id),
    )
    const before = (old.units ?? []).filter((u) => commonIds.has(u.id)).map((u) => u.id)
    const after = (c.units ?? []).filter((u) => commonIds.has(u.id)).map((u) => u.id)
    if (!sameList(before, after)) ops.push({ op: 'reorder-units', chapterId: c.id })
  }

  return ops
}

/** 已学知识点保护：删除 / 改名一律拦下（其余放行） */
export function protectLearned(diff: OutlineDiffOp[], learnedUnitIds: string[]): {
  allowed: OutlineDiffOp[]
  blocked: OutlineDiffOp[]
} {
  const learned = new Set((learnedUnitIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))
  const allowed: OutlineDiffOp[] = []
  const blocked: OutlineDiffOp[] = []
  for (const op of diff ?? []) {
    const guarded = (op.op === 'remove-unit' || op.op === 'rename-unit') && learned.has(op.unitId)
    if (guarded) blocked.push(op)
    else allowed.push(op)
  }
  return { allowed, blocked }
}

function hasRequiresCycle(units: UnitRow[]): boolean {
  const ids = new Set(units.map((u) => u.id))
  const state = new Map<string, 0 | 1 | 2>()
  const visit = (id: string): boolean => {
    const st = state.get(id)
    if (st === 1) return true
    if (st === 2) return false
    state.set(id, 1)
    const u = units.find((x) => x.id === id)
    for (const dep of u?.requires ?? []) {
      if (!ids.has(dep) || dep === id) continue
      if (visit(dep)) return true
    }
    state.set(id, 2)
    return false
  }
  for (const u of units) if (visit(u.id)) return true
  return false
}

/** 章内稳定拓扑排序：每次取「先修都已就位」的最靠前一条（Kahn + 原序优先） */
function stableTopo(units: UnitRow[]): UnitRow[] {
  const local = new Set(units.map((u) => u.id))
  const picked = new Set<string>()
  const pending = units.slice()
  const out: UnitRow[] = []
  while (pending.length) {
    const i = pending.findIndex((u) => (u.requires ?? []).every((r) => !local.has(r) || picked.has(r)))
    if (i < 0) return units.slice()
    const [u] = pending.splice(i, 1)
    picked.add(u.id)
    out.push(u)
  }
  return out
}

/**
 * 章内按先修重排。仅在「无环且 requires 全部存在」时生效，否则原样返回入参（不抛错）。
 * 只动章内顺序：跨章先修不参与本章排序（章顺序由大纲决定）。
 */
export function topoOrderUnits(o: CourseOutlineV2): CourseOutlineV2 {
  const all: UnitRow[] = []
  for (const c of o.chapters ?? []) for (const u of c.units ?? []) all.push(u)

  const ids = new Set<string>()
  for (const u of all) {
    if (ids.has(u.id)) return o // 重复 id 属于非法输入
    ids.add(u.id)
  }
  for (const u of all) {
    for (const dep of u.requires ?? []) if (!ids.has(dep)) return o
  }
  if (hasRequiresCycle(all)) return o

  return {
    ...o,
    chapters: (o.chapters ?? []).map((c) => ({ ...c, units: stableTopo(c.units ?? []) })),
  }
}
