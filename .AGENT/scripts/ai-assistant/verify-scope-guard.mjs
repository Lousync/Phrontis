/**
 * AI助手（v3.9.0）作用域收敛契约。
 *
 * 直接 import 真实实现（vaultScope.ts 是零依赖纯模块），并用源码接线断言守住：
 * ① 作用域语义（前缀/后代/文件即前缀/空=放行）② vault.* 工具确实挂了读写 scope 强制
 * ③ agentService 确实把 scope/propose 透传进工具上下文 ④ 会话来源 aiAssistant 已入白名单。
 *
 * 用法：node --experimental-strip-types .AGENT/scripts/ai-assistant/verify-scope-guard.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { normalizeRelPath, isWithinVaultScope, enforceVaultScope } from '../../../electron/lib/kbStore/vaultScope.ts'
import { suggestScope, tokenizeQuery } from '../../../electron/lib/aiAssistantScopeSuggestPure.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

console.log('=== A. 作用域语义（vaultScope 纯函数） ===')
const cases = [
  { rel: 'a/b/c.md', scope: ['a'], want: true, why: '目录前缀覆盖后代' },
  { rel: 'a/b/c.md', scope: ['a/b'], want: true, why: '多级前缀覆盖后代' },
  { rel: 'a/b/c.md', scope: ['a/b/c.md'], want: true, why: '文件即其自身前缀' },
  { rel: 'a/b.md', scope: ['a/b.md'], want: true, why: '精确命中文件路径' },
  { rel: 'a/b.md', scope: ['a'], want: true, why: '目录前缀覆盖其下文件' },
  { rel: 'ab/c.md', scope: ['a'], want: false, why: '前缀不得跨目录名（ab ≠ a/）' },
  { rel: 'x/y.md', scope: ['a', 'x'], want: true, why: '多前缀任一命中' },
  { rel: 'x/y.md', scope: [], want: true, why: '空 scope = 未限定 = 放行' },
  { rel: '../etc/passwd', scope: ['a'], want: false, why: '越界路径归一失败 = 拒绝' },
]
for (const c of cases) ok(isWithinVaultScope(c.rel, c.scope) === c.want, `A ${c.why}: ${c.rel} in ${JSON.stringify(c.scope)}`, `want ${c.want}`)
ok(normalizeRelPath('a\\b\\c.md') === 'a/b/c.md', 'A 反斜杠归一为斜杠')
ok(normalizeRelPath('/a/') === 'a', 'A 去首尾斜杠')
ok(normalizeRelPath('C:/x') === null, 'A 盘符路径拒绝')
ok(normalizeRelPath('a/../b') === null, 'A 含 .. 拒绝')

let threw = false
try { enforceVaultScope('x/y.md', ['a']) } catch { threw = true }
ok(threw, 'A enforceVaultScope 越界抛错')

console.log('\n=== B. vault.* 工具挂了读写 scope 强制 ===')
const bt = read('electron/lib/builtinTools.ts')
ok(/import\s*\{[^}]*assertCanRead[^}]*assertCanWrite[^}]*\}\s*from\s*'\.\/aiAssistantScope'/.test(bt),
  'B1 builtinTools 引入 assertCanRead / assertCanWrite')
ok(/assertCanRead\(rel, ctx\)/.test(bt), 'B2 vault.list 读前断言作用域')
ok(/assertCanRead\(rel, ctx\)/.test(bt) && /async \(args, ctx\)/.test(bt), 'B3 vault.read 收 ctx 并断言')
ok(/readPredicate\(ctx\)/.test(bt), 'B4 vault.search / resolve-ref 用批读谓词过滤')
const writeAsserts = (bt.match(/assertCanWrite\(/g) || []).length
ok(writeAsserts >= 5, 'B5 写工具均挂 assertCanWrite（write/edit/rename×2/trash）', `实得 ${writeAsserts}`)

console.log('\n=== C. agentService 透传 scope / propose ===')
const svc = read('electron/lib/agentService.ts')
ok(/scope:\s*aiScope,\s*propose:\s*aiPropose/.test(svc), 'C1 工具上下文注入 scope+propose')
ok(/source === 'aiAssistant'/.test(svc) && /buildScopeManifest/.test(svc), 'C2 清单按 aiAssistant 注入')
ok(/source === 'aiAssistant' \? 'aiAssistant'/.test(svc), 'C3 newSession 来源白名单含 aiAssistant')

console.log('\n=== D. 会话来源类型与仓库侧一致 ===')
const repo = read('electron/lib/agentSessionRepo.ts')
const types = read('src/types/index.ts')
ok(/AgentSessionSource = 'assistant' \| 'aiTeaching' \| 'schedule' \| 'aiAssistant'/.test(repo), 'D1 仓库侧类型含 aiAssistant')
ok(/AgentSessionSource = 'assistant' \| 'aiTeaching' \| 'schedule' \| 'aiAssistant'/.test(types), 'D2 渲染层类型含 aiAssistant')

console.log('\n=== E. 描述圈选建议（§3.5 纯匹配） ===')
const entries = [
  { relPath: '学习空间/C++教学/指针.md', title: '指针', tags: ['C++'] },
  { relPath: '学习空间/C++教学/引用.md', title: '引用', tags: ['C++'] },
  { relPath: '生活/周记/2026-10.md', title: '十月周记', tags: ['日记'] },
  { relPath: '附件/图片.png', title: '图', entryKind: 'file' },
]
ok(tokenizeQuery('整理 C++ 教学/指针').includes('指针'), 'E1 分词切出中文词')
ok(tokenizeQuery('C++ 教学').includes('教学') && tokenizeQuery('C++ 教学').includes('c++'), 'E2 分词保留 C++ 与教学')
{
  const r = suggestScope('把指针那篇整理一下', entries)
  ok(r.length >= 1 && r[0].relPath === '学习空间/C++教学/指针.md', 'E3 标题命中排首位', JSON.stringify(r.map((x) => x.relPath)))
  ok(!r.some((x) => x.relPath === '附件/图片.png'), 'E4 entryKind=file 不参与建议')
}
{
  const r = suggestScope('C++', entries)
  ok(r.some((x) => x.relPath === '学习空间/C++教学/指针.md') && !r.some((x) => x.relPath === '生活/周记/2026-10.md'),
    'E5 标签/路径命中但不误伤', JSON.stringify(r.map((x) => x.relPath)))
}
ok(suggestScope('zzzz-不存在-zzzz', entries).length === 0, 'E6 无匹配返回空')
ok(suggestScope('', entries).length === 0, 'E7 空查询返回空')

console.log('\n=== F. 建议 IPC 与渲染层接线 ===')
const svc2 = read('electron/lib/agentService.ts')
ok(/aiAssistant:scope:suggest/.test(svc2) && /suggestScope\(/.test(svc2), 'F1 主进程注册 scope:suggest')
ok(/aiAssistantScopeSuggest/.test(read('electron/preload/index.ts')), 'F2 preload 暴露')
ok(/aiAssistantScopeSuggest/.test(read('src/lib/ipc.ts')), 'F3 ipc.ts 封装')
ok(/adoptScopeCard/.test(read('src/modules/ai-assistant/index.tsx')), 'F4 模块接建议卡')

console.log('\n=== G. 作用域随会话（每任务各圈各的 / 运行中锁定 / 四入口守卫） ===')
const preload = read('electron/preload/index.ts')
const ipc = read('src/lib/ipc.ts')
// 为什么锁这一段：这三件事**改错了都不报错** ——
//   ① 作用域若退回组件本地 state → 切任务会带着上一个任务的范围跑（静默错范围，模型照跑）；
//   ② 运行中允许改 → 用户以为换了范围，本轮其实早按快照跑完（表象「改了没用」）；
//   ③ 只拦首次发送 → 「继续 / 重新生成」绕过圈定，而空 scope 在主进程侧 = 不设限（全库可读写）。
ok(/scope\?:\s*string\[\]/.test(repo), 'G1 会话行带 scope 字段（作用域存会话，不是全局设置）')
{
  const i = repo.indexOf('export function updateAgentSessionScope')
  const body = i < 0 ? '' : repo.slice(i, repo.indexOf('\n}', i))
  ok(i >= 0 && !/updated_at/.test(body), 'G2 落库不碰 updated_at（勾选是编辑动作，不该把任务顶到列表最上）', 'updated_at 只允许出现在函数外的文档注释里')
  ok(/seen\.has\(s\)/.test(body) && /clean\.length >= 500/.test(body), 'G3 落库归一：去重 + 上限 500')
  ok(/row\.scope = clean/.test(body) && /writeSessions\(sessions\)/.test(body), 'G4 写回走 writeSessions（与其余会话字段同一通道）')
}
ok(/ipcMain\.handle\('agent:setSessionScope'/.test(svc), 'G5 主进程注册 agent:setSessionScope')
ok(/ipcMain\.handle\('agent:renameSession'/.test(svc), 'G6 主进程注册 agent:renameSession')
ok(preload.includes('agentSetSessionScope') && preload.includes('agentRenameSession'), 'G7 preload 暴露两条通道')
ok(types.includes('agentSetSessionScope') && types.includes('agentRenameSession'), 'G8 types 声明两条通道')
ok(/export const agentSetSessionScope/.test(ipc) && /export const agentRenameSession/.test(ipc), 'G9 ipc.ts 封装两条通道')
{
  const hook2 = read('src/modules/ai-assistant/useAiAssistant.ts')
  ok(/scopeCache/.test(hook2) && /flushScope/.test(hook2), 'G10 切会话先 flush + 留最新值缓存（防抖窗口内切走再切回不显旧值）')
  ok(/isSessionRunning\(id\)\)\s*return/.test(hook2), 'G11 运行中拒绝改作用域（本轮已按开头快照跑）')
  const retBlock = hook2.slice(hook2.lastIndexOf('return {'))
  ok(/\bscope, setScope,/.test(retBlock) && /renameSession/.test(retBlock), 'G12 hook 返回 scope / setScope / renameSession（漏了就是半截重构，tsc 直接红）')
}
{
  const mod2 = read('src/modules/ai-assistant/index.tsx')
  ok(/runGuarded\(\{ kind: 'regenerate' \}/.test(mod2) && /runGuarded\(\{ kind: 'resume' \}/.test(mod2) && /runGuarded\(\{ kind: 'edit'/.test(mod2), 'G13 重新生成 / 继续 / 编辑重发也过作用域守卫（空 scope = 不设限，只拦首次发送会漏）')
  ok(/disabled=\{api\.pending\}/.test(mod2), 'G14 运行中作用域面板置灰（与 hook 侧拒绝改动对称）')
  ok(/onDoubleClick/.test(mod2) && /api\.renameSession\(/.test(mod2), 'G15 双击任务条目改名')
  ok(!/const \[scope, setScope\]/.test(mod2), 'G16 负向：模块不再自持 scope state（真源只在 hook / 会话行）')
}

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
