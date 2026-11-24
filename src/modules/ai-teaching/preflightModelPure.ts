/**
 * AI 教学 · 开段预检「本课程模型」行的纯函数层。
 *
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/方案与调研/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` B2 / B3（工作区默认 + 精选）
 *
 * ⚠️ 本文件**只允许 `import type`**（甚至可以一个 import 都没有）—— 类型导入会被 Node 的
 * 类型剥离整体擦除；一旦出现普通值导入，契约脚本（strip 后直接 import 真实实现）装载时会
 * 留下无法解析的裸 import。解析口径本身不在这里重写：`resolveWorkspaceModel` 才是唯一真相，
 * 本文件只负责「把解析结果压成一行文案」和「把三段候选压成可渲染的分组」。
 */

export interface ModelLineView {
  /** 生效条目名；没有可用条目时为「未配置」 */
  label: string
  /** 来源标记：本课程默认 / 全局默认 / 精选；none 或对话已覆盖时为空串 */
  sourceLabel: string
  /** 绑定里指向已删条目（不自动改绑定，只提示） */
  warn: boolean
  /** 警告说明（`warn === false` 时为空串） */
  warnText: string
}

type ModelSource = 'workspace' | 'global' | 'curated' | 'none'

/** 与 `resolveWorkspaceModel().source` 一一对应；`none` 不出标记（行内已显示「未配置」） */
const SOURCE_LABEL: Record<ModelSource, string> = {
  workspace: '本课程默认',
  global: '全局默认',
  curated: '精选',
  none: '',
}

/** 失效绑定的说明按「现在实际在用谁」给，避免说一句与右侧模型名矛盾的话 */
const WARN_TEXT: Record<ModelSource, string> = {
  workspace: '部分绑定已失效，已跳过已删条目',
  global: '原绑定已失效，暂用全局默认',
  curated: '原绑定已失效，暂用精选模型',
  none: '原绑定已失效，请重新选择模型',
}

/**
 * 预检行文案。`conversationOverridden` 为真时**抑制来源标记** ——
 * 此刻生效的是对话临时模型，仍标「本课程默认」会让用户以为改课程默认就能换它。
 */
export function modelLineView(input: {
  resolved: { entry?: { name?: string }; source: ModelSource; staleBinding: boolean }
  conversationOverridden: boolean
}): ModelLineView {
  const resolved = input?.resolved
  const source: ModelSource = resolved?.source ?? 'none'
  const rawName = resolved?.entry?.name
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  const stale = resolved?.staleBinding === true
  return {
    label: name || '未配置',
    sourceLabel: input?.conversationOverridden === true ? '' : SOURCE_LABEL[source] ?? '',
    warn: stale,
    warnText: stale ? WARN_TEXT[source] ?? WARN_TEXT.none : '',
  }
}

interface RowLike {
  id: string
  name?: string
}

function rowId(item: unknown): string {
  const id = item && typeof (item as RowLike).id === 'string' ? (item as RowLike).id : ''
  return id.trim()
}

/** 搜索 / 去重后保留原条目对象（渲染层只读 id / name） */
export function rowsForQuery(items: RowLike[], query: string): RowLike[] {
  const list = Array.isArray(items) ? items : []
  const q = String(query ?? '').trim().toLowerCase()
  const out: RowLike[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const id = rowId(item)
    if (!id || seen.has(id)) continue
    const name = typeof item.name === 'string' ? item.name : ''
    if (q && !id.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) continue
    seen.add(id)
    out.push(item)
  }
  return out
}

/**
 * 选择器三段：本课程精选 → 全局精选 → 全部模型。
 * 去重优先级同顺序（ws > global > all），空组不输出，组内保持传入顺序。
 */
export function pickerSections(input: {
  workspace: RowLike[]
  global: RowLike[]
  all: RowLike[]
  query: string
}): Array<{ id: 'ws' | 'global' | 'all'; title: string; items: RowLike[] }> {
  const seen = new Set<string>()
  const take = (items: RowLike[]): RowLike[] => {
    const out: RowLike[] = []
    for (const item of rowsForQuery(items, input?.query ?? '')) {
      const id = rowId(item)
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(item)
    }
    return out
  }

  const sections: Array<{ id: 'ws' | 'global' | 'all'; title: string; items: RowLike[] }> = [
    { id: 'ws', title: '本课程精选', items: take(input?.workspace) },
    { id: 'global', title: '全局精选', items: take(input?.global) },
    { id: 'all', title: '全部模型', items: take(input?.all) },
  ]
  return sections.filter((s) => s.items.length > 0)
}
