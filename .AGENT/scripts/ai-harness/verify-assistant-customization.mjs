// 契约脚本：自定义斜杠指令 + 提示型 hooks（P2）
// 覆盖：命令名校验 / 解析 / 参数替换、hooks 解析 / 匹配 / 上限、注入接线、弹层与入口、文件树定位。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: C } = await loadTsModule(join(ROOT, 'electron/lib/assistantCommandsPure.ts'))
const { mod: H } = await loadTsModule(join(ROOT, 'electron/lib/assistantHooksPure.ts'))

// ── ① 命令名 ──────────────────────────────────────────────────────────────────
{
  ok('中文命令名合法', C.normalizeCommandName('周报') === '周报')
  ok('字母数字 _ - 合法', C.normalizeCommandName('weekly-report_2') === 'weekly-report_2')
  ok('首尾空白被 trim', C.normalizeCommandName('  复盘  ') === '复盘')
  ok('拒绝空格', C.normalizeCommandName('a b') === null)
  ok('拒绝路径分隔符', C.normalizeCommandName('a/b') === null && C.normalizeCommandName('a\\b') === null)
  ok('拒绝路径穿越', C.normalizeCommandName('../x') === null && C.normalizeCommandName('..') === null)
  ok('拒绝点开头', C.normalizeCommandName('.hidden') === null)
  ok('拒绝横杠开头', C.normalizeCommandName('-x') === null)
  ok('拒绝超长（24 字上限）', C.normalizeCommandName('a'.repeat(25)) === null && C.normalizeCommandName('a'.repeat(24)) !== null)
  ok('拒绝 Windows 保留名', C.normalizeCommandName('CON') === null && C.normalizeCommandName('com1') === null)
  ok('拒绝标点', C.normalizeCommandName('a,b') === null && C.normalizeCommandName('a!') === null)
}

// ── ② 命令文件解析 / 参数替换 ─────────────────────────────────────────────────
{
  const raw = '---\ndescription: 按本周笔记生成周报\n---\n请生成周报。\n$ARGUMENTS\n'
  const p = C.parseCommandFile(raw, '周报')
  ok('frontmatter description 解析', p && p.description === '按本周笔记生成周报')
  ok('正文 = 提示词', p && p.prompt.includes('请生成周报。'))
  ok('无 frontmatter 用整篇正文', C.parseCommandFile('直接写提示词', 'x').prompt === '直接写提示词')
  ok('无 description 回落「自定义指令」', C.parseCommandFile('x', 'x').description === '自定义指令')
  ok('空正文无效', C.parseCommandFile('---\ndescription: d\n---\n  \n', 'x') === null)
  ok('非法文件名无效', C.parseCommandFile('x', '../x') === null)
  ok('description 截断 200 字', C.parseCommandFile(`---\ndescription: ${'d'.repeat(300)}\n---\nx`, 'x').description.length === 200)
  ok('BOM / CRLF 可解析', C.parseCommandFile('\uFEFF---\r\ndescription: d\r\n---\r\nx\r\n', 'x').prompt === 'x')
}
{
  ok('$ARGUMENTS 全部替换', C.renderCommandPrompt('A $ARGUMENTS B $ARGUMENTS', '参数') === 'A 参数 B 参数')
  ok('无占位符时追加参数', C.renderCommandPrompt('正文', '要求') === '正文\n\n用户参数：要求')
  ok('空参数不追加', C.renderCommandPrompt('正文', '   ') === '正文')
  ok('NUL 移除', !C.renderCommandPrompt('a\u0000b', '') || !C.renderCommandPrompt('a\u0000b', '').includes('\u0000'))
  ok('空正文返回空串', C.renderCommandPrompt('  ', 'x') === '')
  ok('超长截断 20000', C.renderCommandPrompt('x'.repeat(30_000), '').length === 20_000)
}
{
  const sk = C.commandSkeleton('周报')
  ok('骨架含 frontmatter / 名字 / $ARGUMENTS', sk.includes('description:') && sk.includes('/周报') && sk.includes('$ARGUMENTS'))
  ok('排序按码点确定', JSON.stringify(C.sortCommandNames([{ name: 'b' }, { name: 'a' }, { name: 'C' }]).map((x) => x.name)) === JSON.stringify(['C', 'a', 'b']))
}

// ── ③ hooks 解析 / 匹配 / 上限 ────────────────────────────────────────────────
{
  const { hooks, warnings } = H.parsePromptHooks({
    hooks: [
      { event: 'run-start', prompt: '先列清单' },
      { event: 'after-tool', prompt: '改完提醒校验', tools: ['builtin.vault.write'] },
      { event: 'bad', prompt: 'x' },
      { event: 'run-start', prompt: '   ' },
      { event: 'run-start', prompt: '关掉的', enabled: false },
    ],
  })
  ok('合法条目保留 / 非法跳过', hooks.length === 3 && warnings.length === 2)
  ok('enabled=false 保留但标记', hooks.some((h) => h.prompt === '关掉的' && h.enabled === false))
  ok('after-tool 保留 tools', hooks.find((h) => h.event === 'after-tool')?.tools[0] === 'builtin.vault.write')
  ok('run-start 忽略 tools', H.parsePromptHooks([{ event: 'run-start', prompt: 'x', tools: ['a'] }]).hooks[0].tools.length === 0)
  ok('直接数组也接受', H.parsePromptHooks([{ event: 'run-start', prompt: 'x' }]).hooks.length === 1)
  ok('坏形状返回空 + warning', H.parsePromptHooks({ nope: 1 }).hooks.length === 0 && H.parsePromptHooks({ nope: 1 }).warnings.length > 0)
}
{
  const many = Array.from({ length: 25 }, (_, i) => ({ event: 'run-start', prompt: `p${i}` }))
  ok('最多 20 条', H.parsePromptHooks(many).hooks.length === 20)
  const long = H.parsePromptHooks([{ event: 'run-start', prompt: 'x'.repeat(800) }])
  ok('单条截断 500 字', long.hooks[0].prompt.length === 500)
  const total = H.parsePromptHooks(Array.from({ length: 10 }, (_, i) => ({ event: 'run-start', prompt: String(i).repeat(500) })))
  const sum = total.hooks.reduce((n, h) => n + h.prompt.length, 0)
  ok('总量不超过 3000 字', sum <= 3000)
  ok('tools 最多 10 个', H.parsePromptHooks([{ event: 'after-tool', prompt: 'x', tools: Array.from({ length: 20 }, (_, i) => `t${i}`) }]).hooks[0].tools.length === 10)
}
{
  ok('精确名匹配', H.matchToolPattern('builtin.vault.write', 'builtin.vault.write'))
  ok('尾部通配符', H.matchToolPattern('builtin.vault.*', 'builtin.vault.write-batch'))
  ok('通配符不跨前缀', !H.matchToolPattern('builtin.vault.*', 'builtin.terminal.exec'))
  ok('* 匹配全部', H.matchToolPattern('*', 'anything'))
  ok('空值不匹配', !H.matchToolPattern('', 'x') && !H.matchToolPattern('x', ''))
}
{
  const hooks = [
    { event: 'run-start', prompt: 'A', enabled: true, tools: [] },
    { event: 'after-tool', prompt: 'B', enabled: true, tools: ['builtin.vault.*'] },
    { event: 'after-tool', prompt: 'C', enabled: false, tools: [] },
    { event: 'after-tool', prompt: 'D', enabled: true, tools: [] },
  ]
  ok('按事件取钩子', H.hooksForEvent(hooks, 'run-start').length === 1)
  ok('after-tool 按工具过滤', H.hooksForEvent(hooks, 'after-tool', 'builtin.vault.write').map((h) => h.prompt).join('') === 'BD')
  ok('未配 tools = 匹配所有工具', H.hooksForEvent(hooks, 'after-tool', 'terminal').some((h) => h.prompt === 'D'))
  ok('停用钩子不返回', H.hooksForEvent(hooks, 'after-tool', 'terminal').every((h) => h.prompt !== 'C'))
  const hint = H.renderRunStartHooks(hooks)
  ok('run-start 注入文案带编号', hint.includes('【项目钩子 · 运行开始】') && hint.includes('1. A'))
  ok('无钩子返回空串', H.renderRunStartHooks([]) === '')
  ok('after-tool 最多 3 条', H.renderAfterToolHooks(['1', '2', '3', '4']).match(/\d\. /g).length === 3)
}

// ── ④ 主进程接线 ──────────────────────────────────────────────────────────────
const svc = readFileSync(join(ROOT, 'electron/lib/agentService.ts'), 'utf8')
ok('运行开始读 hooks 且受开关控制', /readAssistantHooks\(\)/.test(svc) && /getSettingReader\(\)\('agentPromptHooks'\) !== false/.test(svc) && /const promptHooks = hookRead\.hooks/.test(svc))
ok('坏条目只告警不打断', /hooks\.json 部分条目已忽略/.test(svc))
ok('仅统一助手读 hooks', /unifiedAssistant && !manual && getSettingReader\(\)\('agentPromptHooks'\)/.test(svc))
ok('run-start 注入 system', /const hookStartHint = renderRunStartHooks\(promptHooks\)/.test(svc) && /aiAssistantHint \+ hookStartHint/.test(svc))
ok('after-tool 只在有成功工具时注入', /roundOkTools\.push\(realName\)/.test(svc) && /roundOkTools\.length > 0/.test(svc))
ok('同一条钩子每次运行只触发一次', /const firedHookIdx = new Set<number>\(\)/.test(svc) && /firedHookIdx\.has\(idx\)/.test(svc))
ok('after-tool 注入不落库（只 push convo）', /convo\.push\(\{ role: 'user', content: hint \}\)/.test(svc))
ok('预算触顶轮不注入', /if \(!budgetCapped && afterToolHooks\.length/.test(svc))
ok('暂存结果不算成功工具', /staged === true/.test(svc))

const main = readFileSync(join(ROOT, 'electron/main/index.ts'), 'utf8')
ok('main 注册两组 handler', /registerAssistantCommandsHandlers\(\)/.test(main) && /registerAssistantHooksHandlers\(\)/.test(main))
const preload = readFileSync(join(ROOT, 'electron/preload/index.ts'), 'utf8')
ok('preload 暴露 5 个通道', /assistantCommandsList:/.test(preload) && /assistantCommandsRead:/.test(preload) && /assistantCommandsCreate:/.test(preload) && /assistantCommandsEnsureDir:/.test(preload) && /assistantHooksEnsure:/.test(preload))
const ipc = readFileSync(join(ROOT, 'src/lib/ipc.ts'), 'utf8')
ok('ipc 包装存在', /export const assistantCommandsList/.test(ipc) && /export const assistantHooksEnsure/.test(ipc))
const types = readFileSync(join(ROOT, 'src/types/index.ts'), 'utf8')
ok('ElectronAPI 类型齐备', /assistantCommandsList: \(\) => Promise/.test(types) && /assistantHooksEnsure: \(\) => Promise/.test(types))
const settings = readFileSync(join(ROOT, 'src/lib/settings.ts'), 'utf8')
ok('设置项默认开启', /agentPromptHooks: \{ default: true, type: 'toggle'/.test(settings) && /group: 'Agent 循环'/.test(settings))

// ── ⑤ 渲染层接线 ──────────────────────────────────────────────────────────────
const chat = readFileSync(join(ROOT, 'src/lib/chatCommands.ts'), 'utf8')
ok('未知指令前先查自定义命令', /assistantCommandsRead\(rawName, args\)/.test(chat))
ok('自定义命令仅统一助手', /ctx\.surface === 'assistant' && rawName/.test(chat))
ok('命中后走 onSend', /ctx\.onSend\(custom\.command\.prompt\)/.test(chat))
ok('未知提示附带自定义命令名', /自定义：\$\{r\.commands\.map/.test(chat))

const slash = readFileSync(join(ROOT, 'src/components/shared/SlashCommandMenu.tsx'), 'utf8')
ok('SlashMenuItem 支持 custom', /kind: 'command' \| 'custom' \| 'skill'/.test(slash))
ok('buildSlashItems 接受自定义命令', /customCommands: Array<\{ name: string; description: string \}> = \[\]/.test(slash))
ok('自定义分组标题', /自定义指令 · \.assistant\/commands/.test(slash))

const body = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/ChatBody.tsx'), 'utf8')
ok('ChatBody 传入自定义命令', /surface === 'assistant' \? slashCommands : \[\]/.test(body))
ok('custom 与 command 同样补全', /it\.kind === 'command' \|\| it\.kind === 'custom'/.test(body))

const hook = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/useAssistantChat.ts'), 'utf8')
ok('控制器加载自定义命令', /assistantCommandsList\(\)\.then/.test(hook) && /slashCommands,/.test(hook))
ok('新建后刷新弹层', /assistant-commands-changed/.test(hook))

const entry = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/AssistantEntry.tsx'), 'utf8')
ok('菜单含新建 / 文件夹 / 钩子', /新建自定义指令/.test(entry) && /自定义指令文件夹/.test(entry) && /钩子 · 提示型/.test(entry))
ok('新建走 IPC 并打开文件', /assistantCommandsCreate\(name\)/.test(entry) && /kb-open-note/.test(entry) && /assistant-commands-changed/.test(entry))
ok('文件夹派发文件树定位事件', /kb-reveal-tree/.test(entry))
ok('钩子 ensure 后打开', /assistantHooksEnsure\(\)/.test(entry))

const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
ok('App 监听 kb-reveal-tree 并投递 state', /addEventListener\('kb-reveal-tree'/.test(app) && /pendingRevealRel/.test(app))
const kb = readFileSync(join(ROOT, 'src/modules/knowledge/index.tsx'), 'utf8')
ok('知识库消费 reveal 并预加载祖先目录', /pendingRevealRel/.test(kb) && /refreshTreeDir\(parts\.slice\(0, i\)\.join\('\/'\)\)/.test(kb))
ok('定位支持展开自身', /handleLocateInTree\(pendingReveal\.relPath, \{ expandSelf: true \}\)/.test(kb))

// ── ⑥ 骨架与边界 ──────────────────────────────────────────────────────────────
const hooksIo = readFileSync(join(ROOT, 'electron/lib/assistantHooks.ts'), 'utf8')
ok('hooks 骨架示例默认关闭', /enabled: false/.test(hooksIo) && /hooksSkeleton/.test(hooksIo))
ok('坏 JSON 降级为空', /hooks\.json 解析失败/.test(hooksIo))
ok('hooks 不执行命令（无 spawn / exec 引用）', !/child_process|spawn\(|exec\(/.test(hooksIo))
const cmdIo = readFileSync(join(ROOT, 'electron/lib/assistantCommands.ts'), 'utf8')
ok('命令 IO 只读 .assistant/commands', /ASSISTANT_DIR = '\.assistant'/.test(cmdIo) && /COMMANDS_DIR = 'commands'/.test(cmdIo))
ok('大小写不敏感回退', /toLowerCase\(\) === name!\.toLowerCase\(\)/.test(cmdIo))
ok('已存在不覆盖', /if \(existsSync\(abs\)\) return \{ ok: true, relPath, created: false \}/.test(cmdIo))

report('自定义斜杠指令 + 提示型 hooks（P2）')
