/**
 * 内置工具的中文动作标签（**唯一真源**）。
 *
 * 主进程 `agentService` 用它生成 `agent:stream` 的 `tool-start.label`；
 * 渲染层生成态事件流、完成态过程摘要也用它，避免出现「生成中叫『读取文件』、
 * 完成后叫『vault.read』」的两套口径。
 */
export const TOOL_ACTION_LABELS: Record<string, string> = {
  'builtin.vault.list': '浏览目录',
  'builtin.vault.read': '读取文件',
  'builtin.vault.search': '搜索内容',
  'builtin.vault.resolve-ref': '解析引用',
  'builtin.vault.write': '写入文件',
  'builtin.vault.edit': '修改文件',
  'builtin.vault.rename': '重命名',
  'builtin.vault.trash': '移入回收站',
  'builtin.knowledge.search': '检索知识库',
  'builtin.knowledge.create-page': '新建知识页',
  'builtin.blog.create-entry': '新建日记',
  'builtin.schedule.list-todos': '查看待办',
  'builtin.schedule.create-todo': '创建待办',
  'builtin.schedule.update-todo': '修改待办',
  'builtin.schedule.delete-todo': '删除待办',
  'builtin.schedule.list-workflows': '查看工作流',
  'builtin.schedule.get-workflow': '读取工作流',
  'builtin.schedule.create-workflow': '创建工作流',
  'builtin.schedule.update-workflow': '修改工作流',
  'builtin.schedule.delete-workflow': '删除工作流',
  'builtin.schedule.mutate-stage': '编辑工作流阶段',
  'builtin.schedule.reorder-stages': '重排工作流阶段',
  'builtin.schedule.mutate-checkpoint': '编辑工作流检查点',
  'builtin.checkin.check-habit': '习惯打卡',
  'builtin.habits.stats': '统计习惯',
  'builtin.pomodoro.summary': '统计番茄',
  'builtin.web.search': '联网搜索',
  'builtin.web.read': '读取网页',
  'builtin.help.search': '检索帮助',
  'builtin.tool.request': '申请工具',
  'visual.html': '生成示意图',
  'mindmap': '生成思维导图',
  'image': '生成图片',
}

/** 工具名 → 中文动作标签；未知工具回退为去掉 `builtin.` 的短名 */
export function toolActionLabel(name?: string): string {
  const s = String(name ?? '')
  return TOOL_ACTION_LABELS[s] ?? (s.startsWith('builtin.') ? s.slice(8) : s || '工具')
}
