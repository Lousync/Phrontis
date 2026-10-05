/**
 * N-1「手册通道」—— 纯函数与常量（**零依赖，专为让契约脚本 import**）
 *
 * 主进程实现（含 LLM 分类调用）在 `manualChannel.ts`，从本文件 import 后复用。
 * 契约脚本 `.AGENT/scripts/ai-assistant/verify-manual-channel.mjs` 直接 strip-types 后 import。
 */

/**
 * 首条消息的通道分类结果（三分类）：
 *   manual = 问本软件（Phrontis）自身怎么用 / 某功能在哪 / 行为不符预期；
 *   agent  = 要 AI 操作本软件数据（创建 / 修改 / 删除 / 检索仓库内容）；
 *   tech   = 第三方软件 / 编程 / 通用知识的技术问答（nvim、Python、git、算法…）。
 * 三分类只为**提高分类准确率**（避免二选一被迫把通用问题判成 manual）；实际通道仍两条：
 * manual 走手册通道，agent 与 tech 都走通用助手（tech 不单独成通道）。
 */
export type ManualIntent = 'manual' | 'agent' | 'tech'

/** 手册通道唯一挂载的工具 */
export const MANUAL_CHANNEL_TOOL = 'builtin.help.search'
/** 手册通道轮数上限（拍板：≤2-3 轮） */
export const MANUAL_MAX_ROUNDS = 3
/** 手册通道单次检索结果总量上限（字符），超出截断 */
export const MANUAL_MAX_RESULT_CHARS = 6000
/** 手册通道默认返回篇数 */
export const MANUAL_SEARCH_LIMIT = 2

/**
 * 本地操作意图词表（拍板 ③：问句+操作混杂 → 落通用通道，超集原则）。
 * 命中任一即判 `agent`，跳过 LLM 分类。宁宽勿漏（漏判只是多花一次分类调用）。
 */
const OP_WORDS = [
  '创建', '新建', '建一个', '建个', '建一篇', '删除', '删掉', '移除', '修改', '改一下', '改成', '编辑',
  '添加', '加一条', '加入', '加个', '设为', '设置为', '更新', '替换', '重命名', '改名', '移动', '归类',
  '帮我写', '写一篇', '写个', '写入', '保存到', '存到', '导出', '导入', '生成文件', '生成一篇',
  '打卡', '记录一下', '记录下', '帮我记', '安排', '排一下', '加个待办', '建个待办', '打开文件',
  '补上', '补写', '补一下', '发布', '收进', '整理成', '整理一下', '归档',
]

/** 是否含操作意图（纯函数） */
export function hasOperationIntent(text: string): boolean {
  const t = String(text ?? '')
  if (!t) return false
  return OP_WORDS.some((w) => t.includes(w))
}

/** 分类 few-shot 判例（供契约脚本核对方向与数量） */
export const FEW_SHOT: Array<[string, ManualIntent]> = [
  ['知识库为什么看不到我的文件？', 'manual'],
  ['怎么备份数据？', 'manual'],
  ['快捷键都有哪些？', 'manual'],
  ['这个软件怎么用', 'manual'],
  ['AI 助手的权限在哪里设置？', 'manual'],
  ['帮我建一篇笔记《线性代数复习》', 'agent'],
  ['把今天的日记补上', 'agent'],
  ['创建一条明天下午三点的待办', 'agent'],
  ['帮我总结一下这个仓库', 'agent'],
  // 第三类：第三方软件 / 编程 / 通用技术问答 —— 既不是问本软件，也不是操作数据
  ['nvim 怎么用分词器', 'tech'],
  ['Python 里怎么读写文件', 'tech'],
  ['git rebase 怎么用', 'tech'],
  ['解释一下快速排序的时间复杂度', 'tech'],
]

/** 手册通道 system 提示词（替代通用助手人设；不注入教学/感知/出题/工件规则） */
export function buildManualSystemPrompt(): string {
  return [
    '你是 Phrontis（本地知识管理桌面软件）的「使用帮助」助手。',
    '用户现在是在问「这个软件本身怎么用」，而不是要你操作数据。规则：',
    '1. 先调用 builtin.help.search 检索官方手册，再依据手册内容回答；不要凭猜测描述软件行为，手册里没有的就直说没有。',
    '2. 回答简洁、可直接照做（分步），不要长篇大论，不要展开无关内容。',
    '3. 本通道不执行任何操作：不要调用写类工具、不要声称已创建/修改/删除任何东西。',
    '4. 若用户其实是要你操作软件数据（创建/修改/删除/检索仓库内容等），用一句话说明「这属于助手操作」即可——系统会自动切换到通用助手。',
    '5. 回答使用简体中文。',
  ].join('\n')
}
