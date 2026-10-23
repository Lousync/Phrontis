/**
 * AI助手（v3.9.0）作用域收敛契约。
 *
 * 直接 import 真实实现（vaultScope.ts 是零依赖纯模块），并用源码接线断言守住：
 * ① 作用域语义（前缀/后代/文件即前缀/空=放行）② vault.* 工具确实挂了读写 scope 强制
 * ③ agentService 确实把 scope/propose 透传进工具上下文 ④ 会话来源 aiAssistant 已入白名单
 * ⑤ 左栏「集合语义 + 前缀压缩」的纯函数与面板接线（§H，方案 docs/ai-assistant-scope-rail-plan.md）。
 *
 * 用法：node --experimental-strip-types .AGENT/scripts/ai-assistant/verify-scope-guard.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { normalizeRelPath, isWithinVaultScope, enforceVaultScope } from '../../../electron/lib/kbStore/vaultScope.ts'
import { suggestScope, tokenizeQuery } from '../../../electron/lib/aiAssistantScopeSuggestPure.ts'
import {
  SCOPE_ENTRY_SOFT_CAP, prunePrefixes, coveredBy, coverageOf, addToScope, batchAdd, removeFromScope,
} from '../../../src/modules/ai-assistant/scopeSetPure.ts'
import { stripComments } from '../shared/strip-comments.mjs'

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
ok(/scope:\s*aiScope/.test(svc) && /propose:\s*aiPropose/.test(svc) && /scopeAll/.test(svc),
  'C1 工具上下文注入 scope+scopeAll+propose')
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
  const norm = repo.slice(repo.indexOf('export function normalizeSessionScope'), repo.indexOf('export function updateAgentSessionScope'))
  ok(/seen\.has\(s\)/.test(norm) && /clean\.length >= 500/.test(norm), 'G3 落库归一：去重 + 上限 500')
  ok(/row\.scope = clean/.test(body) && /writeSessions\(sessions\)/.test(body), 'G4 写回走 writeSessions（与其余会话字段同一通道）')
}
ok(/ipcMain\.handle\('agent:setSessionScope'/.test(svc), 'G5 主进程注册 agent:setSessionScope')
ok(/ipcMain\.handle\('agent:renameSession'/.test(svc), 'G6 主进程注册 agent:renameSession')
ok(preload.includes('agentSetSessionScope') && preload.includes('agentRenameSession'), 'G7 preload 暴露两条通道')
ok(types.includes('agentSetSessionScope') && types.includes('agentRenameSession'), 'G8 types 声明两条通道')
ok(/export const agentSetSessionScope/.test(ipc) && /export const agentRenameSession/.test(ipc), 'G9 ipc.ts 封装两条通道')
{
  const hook2 = read('src/components/shared/AssistantPanel/useAssistantChat.ts')
  ok(/scopePendingRef/.test(hook2) && /flushScope/.test(hook2), 'G10 切会话先 flush + 留最新值缓存（防抖窗口内切走再切回不显旧值）')
  ok(/isSessionRunning\(activeIdRef\.current\)\)\s*return/.test(hook2) && /isSessionRunning\(id\)\)\s*return/.test(hook2),
    'G11 运行中拒绝改作用域（本轮已按开头快照跑）')
  const retBlock = hook2.slice(hook2.lastIndexOf('return {'))
  ok(/\bscope,/.test(retBlock) && /setScope,/.test(retBlock) && /scopeAll,/.test(retBlock) && /renameSession/.test(retBlock),
    'G12 hook 返回 scope / scopeAll / setScope / renameSession（漏了就是半截重构，tsc 直接红）')
}
{
  const mod2 = read('src/modules/ai-assistant/index.tsx')
  ok(/runGuarded\(\{ kind: 'regenerate' \}/.test(mod2) && /runGuarded\(\{ kind: 'resume' \}/.test(mod2) && /runGuarded\(\{ kind: 'edit'/.test(mod2), 'G13 重新生成 / 继续 / 编辑重发也过作用域守卫（空 scope = 不设限，只拦首次发送会漏）')
  ok(/disabled=\{api\.pending\}/.test(mod2), 'G14 运行中作用域面板置灰（与 hook 侧拒绝改动对称）')
  ok(/onDoubleClick/.test(mod2) && /api\.renameSession\(/.test(mod2), 'G15 双击任务条目改名（F-4 拍板：按设计保留，这条是锁不是待改项）')
  ok(!/const \[scope, setScope\]/.test(mod2), 'G16 负向：模块不再自持 scope state（真源只在 hook / 会话行）')
}

console.log('\n=== H. 集合语义纯函数与左栏接线（F-2 / F-3 / F-5） ===')
const K = (m) => (rel) => m[rel]
const sorted = (a) => a.slice().sort().join('|')
{
  ok(sorted(prunePrefixes(['a', 'a/b', 'a/b/c.md'])) === 'a', 'H1 prunePrefixes 吃掉被覆盖的后代')
  ok(sorted(prunePrefixes(['a/b', 'a'])) === 'a', 'H2 prunePrefixes 与入参顺序无关')
  {
    const once = prunePrefixes(['x/y', 'x', 'q', 'q/r'])
    ok(sorted(once) === 'q|x', 'H3 多条同时压缩', sorted(once))
    ok(sorted(prunePrefixes(once)) === sorted(once), 'H4 prunePrefixes 幂等（不能让清单越存越长）')
  }
  ok(sorted(prunePrefixes(['a/b', 'a/b', 'a\\b', 'a/b/'])) === 'a/b', 'H5 去重 + 反斜杠 / 尾斜杠归一')
  ok(sorted(prunePrefixes(['', '/', 'x'])) === 'x', 'H6 空条目丢弃')
  ok(sorted(prunePrefixes(['a', 'ab'])) === 'a|ab', 'H7 压缩不得跨目录名（ab 不是 a 的后代）')
}
{
  ok(coveredBy(['a'], 'a/b/c.md') === 'a', 'H8 覆盖判定：目录前缀盖后代')
  ok(coveredBy(['a/b'], 'a/b') === 'a/b', 'H9 条目自身算被覆盖')
  ok(coveredBy(['a/b', 'a'], 'a/b/c.md') === 'a', 'H10 多个前缀都盖住时取最外层（「来自 X」要显示用户实际勾下的那层）')
  ok(coveredBy(['a'], 'ab/c.md') === undefined, 'H11 覆盖判定不跨目录名')
}
const T1 = { '': ['A', 'B'], A: ['A/a.md', 'A/b.md', 'A/sub'], 'A/sub': ['A/sub/s1.md', 'A/sub/s2.md'], B: ['B/img.png'], E: [] }
const k1 = K(T1)
{
  ok(coverageOf(['A'], 'A', k1) === 'all', 'H12 条目本身 → 实勾')
  ok(coverageOf(['A'], 'A/a.md', k1) === 'all', 'H13 被祖先前缀盖住的子项 → 也显示实勾（F-2 的第一个症状）')
  ok(coverageOf([], 'A', k1) === 'none', 'H14 空作用域 → 未勾')
  ok(coverageOf(['A/a.md', 'A/b.md', 'A/sub'], 'A', k1) === 'all', 'H15 子项全选中 → 父目录也是实勾')
  ok(coverageOf(['A/a.md'], 'A/sub', k1) === 'none', 'H16 兄弟分支不受影响')
  ok(coverageOf(['A/sub/s1.md'], 'A/sub', k1) === 'partial', 'H17 部分覆盖 → 半选')
  ok(coverageOf(['A/sub/s1.md'], 'A', k1) === 'partial', 'H18 半选沿树往上冒（勾深层时顶层要能看出来）')
  ok(coverageOf(['C/deep/x.md'], 'C', k1) === 'none', 'H19 负向口径：子项未知退化为未勾（方案 §3.2，不为此扫全库）')
  ok(coverageOf(['E/x.md'], 'E', k1) === 'none', 'H20 已加载空目录判 none，不当成「全部覆盖」')
}
{
  const r = removeFromScope(['A'], 'A/a.md', k1)
  ok(sorted(r) === 'A/b.md|A/sub', 'H21 大目录里单独取消一项 → 炸开成兄弟', sorted(r))
  ok(r && coveredBy(r, 'A/a.md') === undefined, 'H22 炸开后被取消的那项确实出圈')
  ok(r && coveredBy(r, 'A/b.md') === 'A/b.md' && coveredBy(r, 'A/sub/s1.md') === 'A/sub', 'H23 炸开必须保住其余兄弟（含子树）')
}
{
  const r = removeFromScope(['A'], 'A/sub/s1.md', k1)
  ok(sorted(r) === 'A/a.md|A/b.md|A/sub/s2.md', 'H24 取消更深一层 → 沿路径逐层炸', sorted(r))
  ok(r && coveredBy(r, 'A/sub/s2.md') === 'A/sub/s2.md', 'H25 同层兄弟仍选中')
}
ok(sorted(removeFromScope(['A'], 'A', k1)) === '', 'H26 整棵移出 = 该前缀消失')
{
  const t2 = { C: ['C/deep'] }   // C/deep 从未列过子项
  ok(removeFromScope(['C'], 'C/deep/x.md', K(t2)) === null, 'H27 负向：子项未知时返回 null，不交半成品（半成品=静默缩范围）')
  const t3 = { E: [] }
  ok(sorted(removeFromScope(['E'], 'E/x.md', K(t3))) === '', 'H28 已列出且确为空目录 → 前缀就地消失（undefined 与空数组口径必须不同）')
  const big = { BIG: Array.from({ length: 500 }, (_, i) => `BIG/${i}.md`) }
  ok(removeFromScope(['BIG'], 'BIG/0.md', K(big)) === null, `H29 炸开超软上限（${SCOPE_ENTRY_SOFT_CAP}）→ null 交调用方提示，而非留给落库在 500 条静默截断`)
}
{
  ok(sorted(addToScope(['A/b.md'], 'A')) === 'A', 'H30 勾上层 → 内部冗余条目被压掉')
  ok(sorted(addToScope(['A'], 'A/a.md')) === 'A', 'H31 已覆盖的行再勾不产生重复条目（旧代码在这里是静默 return）')
  ok(sorted(batchAdd(['A'], ['A/x.md', 'B'])) === 'A|B', 'H32 批量加入同样压回前缀')
  ok(SCOPE_ENTRY_SOFT_CAP < 500, 'H33 软上限必须低于落库硬截断 500，否则余量为零、界面显示数 ≠ 重开后数')
}
{
  const pane = read('src/modules/ai-assistant/ScopePane.tsx')
  const bare = stripComments(pane)
  ok(/indeterminate/.test(pane), 'H34 三态复选框在位（半选要靠它，checked 只有真/假）')
  ok(/childrenRaw/.test(pane) && /rawRef/.test(pane), 'H35 未过滤子项清单与同步镜像都在位（炸开读它，不读树的过滤结果）')
  ok(/全选顶层/.test(pane) && /全选可见/.test(pane) && /全部取消/.test(pane), 'H36 三个批量动作都在（同位单按钮按语境换语义）')
  ok(/SCOPE_ENTRY_SOFT_CAP/.test(pane), 'H37 软上限前置守卫接到面板')
  ok(!/scope\.map\(/.test(bare) && !/flex-wrap/.test(bare), 'H38 负向：chip 行已删，选择态只有树里一处表达（F-5 = C）')
  const mdLines = bare.split('\n').filter((l) => /MD_EXTS/.test(l))
  ok(mdLines.length === 2 && mdLines.every((l) => !/Raw|batchAdd|removeFromScope/.test(l)),
    'H39 负向：MD_EXTS 只喂显示，绝不掺进炸开/全选路径（掺了会把非 md 文件静默挤出作用域）', `命中 ${mdLines.length} 行`)
  ok(!/scope\.some\(/.test(bare) && !/coveredBy\([^)]*\)\)\s*return/.test(bare),
    'H40 负向：被覆盖的行不再静默 return（F-2 根因，点不动的那条早退）')
  ok(/api\.setScope\(prunePrefixes\(paths\)\)/.test(stripComments(read('src/modules/ai-assistant/index.tsx'))),
    'H41 建议卡采用时也过一遍压缩（8 条文件路径里若含彼此所在目录，应塌成前缀）')
}

{
  /**
   * H42 / H43 炸开不变量**穷举**（几棵全形状小树 × 所有 ≤3 条前缀组合 × 每个已覆盖目标）：
   * 随机只碰得到运气形状，这里要的是「一项都没多动」的保证 ——
   *   取消后的可读集合 == 取消前的可读集合 减去（该子树 + 其祖先链）。
   * 祖先行必须一起脱离实勾（退成半选），这是炸开的定义，不是偏差。
   * 子项全量列好时 removeFromScope 一律不许返回 null：返回了就是接线侧 ensurePath 漏了某层。
   */
  const shape = (width, depth) => {
    const universe = [], tree = {}
    const grow = (base, d) => {
      if (d === 0) return
      for (let i = 0; i < width; i++) {
        const rel = base ? `${base}/c${i}` : `r${i}`
        universe.push(rel)
        tree[rel] = []
        grow(rel, d - 1)
      }
    }
    grow('', depth)
    for (const key of Object.keys(tree)) {
      tree[key] = universe.filter((x) => x.startsWith(`${key}/`) && x.split('/').length === key.split('/').length + 1)
    }
    return { universe, kids: K(tree) }
  }
  let cases = 0, diffFail = 0, relStillIn = 0, blocked = 0
  for (const [w, d] of [[2, 3], [3, 2], [2, 2]]) {
    const { universe, kids } = shape(w, d)
    const has = (scope, x) => !!coveredBy(scope, x)
    for (let m = 1; m < (1 << universe.length); m++) {
      if (m.toString(2).split('1').length - 1 > 3) continue
      const before = prunePrefixes(universe.filter((_, i) => m & (1 << i)))
      for (const target of universe.filter((x) => has(before, x))) {
        cases++
        const after = removeFromScope(before, target, kids)
        if (after === null) { blocked++; continue }
        for (const x of universe) {
          const inSubtree = x === target || x.startsWith(`${target}/`)
          const isAncestor = target.startsWith(`${x}/`)
          if ((has(before, x) && !inSubtree && !isAncestor) !== has(after, x)) { diffFail++; break }
        }
        if (coverageOf(after, target, kids) !== 'none') relStillIn++
      }
    }
  }
  ok(cases > 500 && diffFail === 0 && blocked === 0,
    `H42 炸开不变量穷举（${cases} 个组合）：可读集合 = 原集合减去该子树及其祖先链，其余一项不动`,
    `偏差 ${diffFail}，子项齐全却做不了 ${blocked}`)
  ok(relStillIn === 0, 'H43 穷举：刚取消的节点回到未勾（祖先不会残留成实勾）', `${relStillIn} 例未清`)
}

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
