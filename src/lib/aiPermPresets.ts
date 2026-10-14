/**
 * 模块权限的纯规则（2026-10-13，零依赖）。
 *
 * 为什么单独一个文件：权限预设的**档位语义**是"给了 AI 多少能力"的判据本身，
 * 必须能被契约脚本真跑（`.AGENT/scripts/ai-perms/verify-ai-perms.mjs`），
 * 而不是拿源码文本猜。同 llmAccountPure.ts / skillPackPure.ts 的既有做法。
 *
 * 三条不变量（契约负向断言锁的）：
 *   1. `all`（完全信任）**绝不给没有写操作的模块发写权限** —— 那等于发一个不存在的许可，
 *      界面会显示"读写"而实际什么都没有，用户以为开了、其实没有（番茄专注就是这种模块）；
 *   2. `safe`（最保守）连仓库文件一起收回只读 —— 只改模块不改仓库文件等于没保守住；
 *   3. 预设只产出 'off' / 'read' / 'write' 三个合法值，不产出别的档位名
 *      （原型专门注了一句「别把档位名和权限值混用」）。
 */

export type Perm = 'off' | 'read' | 'write'

export interface ModuleDef {
  id: string
  label: string
  desc: string
  /** 空串 = 该模块目前没有写操作（"读写"这一档对它没有意义） */
  writeDesc: string
}

export const MODULES: ModuleDef[] = [
  { id: 'knowledge', label: '知识库',   desc: '搜索与阅读页面',       writeDesc: '新建页面、向已有页面追加内容' },
  { id: 'blog',      label: '博客/日记', desc: '查询日记',             writeDesc: '按日期新建日记（每天一篇）' },
  { id: 'schedule',  label: '日程',     desc: '查询待办事项',         writeDesc: '创建待办' },
  { id: 'checkin',   label: '习惯打卡', desc: '习惯列表与统计',       writeDesc: '按名称为今天打卡' },
  { id: 'quiz',      label: '错题本',   desc: '查询错题与薄弱点统计', writeDesc: '按错误类型打标签、写错因备注、加入分组、组卷成练习页' },
  { id: 'bookMarket', label: '书市',    desc: '书源列表与检索状态',   writeDesc: '按草案预填「新建书源」表单（不自动落库）' },
  { id: 'pomodoro',  label: '番茄专注', desc: '专注统计',             writeDesc: '' },
  { id: 'accounting', label: '记账',    desc: '查询收支流水与统计',   writeDesc: '导入、新增与修改流水（AI 记账）' },
]
// 注：bookmarks 模块已随 2026-09-09 工具重构退役（bookmarks.search → vault.search）；
// 旧设置数据中残留的 bookmarks 键无害（无工具引用即不生效），解析层自动忽略。

export const PERM_LABEL: Record<Perm, string> = {
  off: '禁止',
  read: '只读',
  write: '读写',
}

/** 权限预设档位（原型三个按钮；注意别把档位名与权限值混用） */
export type PermPreset = 'safe' | 'daily' | 'all'

/** 日常档位里允许 AI 直接记账 / 排期的两个模块 */
export const DAILY_WRITE_MODULES = ['schedule', 'accounting']

/**
 * 按档位算出新的模块权限表。**纯函数**：不改入参、不碰设置，返回值直接落盘。
 * `safe` 的副作用（仓库文件也收回只读）由调用方一并做 —— 这里只算模块表，
 * 因为仓库文件是**另一个键**（aiVaultFilePerm），混进来会让这个函数不再纯。
 */
export function presetModulePerms(mode: PermPreset): Record<string, Perm> {
  const next: Record<string, Perm> = {}
  for (const m of MODULES) {
    if (mode === 'safe') next[m.id] = 'read'
    else if (mode === 'daily') next[m.id] = DAILY_WRITE_MODULES.includes(m.id) ? 'write' : 'read'
    else next[m.id] = m.writeDesc ? 'write' : 'read'
  }
  return next
}

/** 解析存量设置：只收三个合法值，其余（含已退役模块）忽略 */
export function parsePerms(raw: string): Record<string, Perm> {
  try {
    const o = JSON.parse(raw || '{}')
    const out: Record<string, Perm> = {}
    for (const [k, v] of Object.entries(o)) {
      if (v === 'off' || v === 'read' || v === 'write') out[k] = v
    }
    return out
  } catch { return {} }
}

/** 某个档位下"读写"是否对它有意义 */
export function hasWriteOp(moduleId: string): boolean {
  return !!MODULES.find(m => m.id === moduleId)?.writeDesc
}
