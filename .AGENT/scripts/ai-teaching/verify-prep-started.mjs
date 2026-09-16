/**
 * 契约验证：AI 教学「准备态」的 `started` 标记不再被草稿 / 折叠态回退（v3.2.0 第 19 项）。
 *
 * 为什么需要它 —— 本缺陷的形态是「**静默的、一次性的状态污染**」：
 *   ① 判据只在**重新打开会话**时读 localStorage（保活架构下切 Tab 都不读），跑一遍界面看不出来；
 *   ② 命中一次就**永久坏**：开讲只发生一次，之后再无写回 true 的机会；
 *   ③ 修复本身是「删掉一个字段」，回归时同样只是一行删改，没有任何显式报错。
 * 所以把「写入语义」钉死在纯函数上，并用**真实实现**执行验证（import `prepPolicy.ts`），不复刻判定逻辑：
 *   · `withDraft` / `withFold` 的返回值里**不得出现 `started`** —— 结构保证，不靠调用方自觉；
 *   · `decidePrepLanding` 必须用「会话真实消息数」给快照兜底（有消息 + 快照说未开讲 = 自愈）。
 *
 * 运行（项目根目录）：
 *   node .AGENT/scripts/ai-teaching/verify-prep-started.mjs [仓库路径]
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const POLICY_REL = 'src/modules/ai-teaching/prepPolicy.ts'
const MAIN_REL = 'src/modules/ai-teaching/index.tsx'

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const info = (msg) => console.log('  · ' + msg)

// ---------------------------------------------------------------- 真实实现装载
const policySrc = fs.readFileSync(path.join(ROOT, POLICY_REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-verify-'))
const tmpFile = path.join(tmpDir, 'prepPolicy.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(policySrc, { mode: 'strip' }))
const { decidePrepLanding, withDraft, withFold, withStarted } = await import(pathToFileURL(tmpFile).href)

const mainSrc = fs.readFileSync(path.join(ROOT, MAIN_REL), 'utf8')
const mainCode = stripComments(mainSrc)   // 负向 / 接线断言一律在剥注释后的文本上做
const policyCode = stripComments(policySrc)
const count = (s, sub) => s.split(sub).length - 1

console.log('\n=== 1. decidePrepLanding：落点判定与兜底自愈（真实实现执行）===')
const land = (prep, n) => decidePrepLanding(prep, n)
const cases = [
  ['prep 缺失 + 无消息 → 正常态（不是准备态）', land(undefined, 0), (r) => r.mode === 'chat' && r.correctStarted === false],
  ['prep 缺失 + 有消息 → 正常态', land(undefined, 7), (r) => r.mode === 'chat' && r.correctStarted === false],
  ['started:true + 无消息 → 正常态', land({ started: true }, 0), (r) => r.mode === 'chat' && r.correctStarted === false],
  ['started:true + 有消息 → 正常态', land({ started: true, draft: 'd' }, 7), (r) => r.mode === 'chat' && r.correctStarted === false],
  ['started 缺省（只有草稿）→ 正常态，且不误判为需校正', land({ draft: 'd' }, 0), (r) => r.mode === 'chat' && r.correctStarted === false],
  ['started:false + 无消息 → 真准备态', land({ started: false, draft: 'd' }, 0), (r) => r.mode === 'prepare'],
  ['started:false + 有消息 → 正常态 + 需校正（本缺陷的自愈路径）', land({ started: false, draft: 'd' }, 5), (r) => r.mode === 'chat' && r.correctStarted === true],
]
for (const [name, got, ok] of cases) check(name, ok(got), JSON.stringify(got))

console.log('\n=== 2. withDraft / withFold：结构上不碰 started（本缺陷的正面回归）===')
const wd1 = withDraft({ started: true, draft: 'a', srcOpen: true }, 'b')
check('withDraft：started:true 不被回退（缺陷本体）', wd1.started === true, JSON.stringify(wd1))
check('withDraft：只改 draft，其余字段原样', wd1.draft === 'b' && wd1.srcOpen === true, JSON.stringify(wd1))
const wd2 = withDraft({ started: false, draft: 'a' }, 'b')
check('withDraft：started:false 保持 false', wd2.started === false, JSON.stringify(wd2))
const wd3 = withDraft(undefined, 'b')
check('withDraft：无快照时不凭空造 started', wd3.started === undefined && wd3.draft === 'b', JSON.stringify(wd3))
const wf1 = withFold({ started: true, draft: 'a' }, true, false)
check('withFold：started:true 不被回退（缺陷本体）', wf1.started === true, JSON.stringify(wf1))
check('withFold：只改两个折叠位，草稿原样', wf1.srcOpen === true && wf1.reqOpen === false && wf1.draft === 'a', JSON.stringify(wf1))
const wf2 = withFold({ started: false }, true, true)
check('withFold：started:false 保持 false', wf2.started === false, JSON.stringify(wf2))
const wf3 = withFold(undefined, true, true)
check('withFold：无快照时不凭空造 started', wf3.started === undefined, JSON.stringify(wf3))

console.log('\n=== 3. withStarted：只由「开讲」置 true，且保留其它字段 ===')
const ws1 = withStarted({ draft: 'x', srcOpen: true, reqOpen: false })
check('withStarted：置 true 并保留草稿 / 折叠位', ws1.started === true && ws1.draft === 'x' && ws1.srcOpen === true && ws1.reqOpen === false, JSON.stringify(ws1))
const ws2 = withStarted({ started: false })
check('withStarted：false → true', ws2.started === true, JSON.stringify(ws2))
const ws3 = withStarted(undefined)
check('withStarted：无快照 → 只出 started:true', ws3.started === true && Object.keys(ws3).length === 1, JSON.stringify(ws3))

console.log('\n=== 4. 时序竞态重放：残留的防抖写入不得压回开讲标记 ===')
let snap = { started: false, draft: '按场景模板预填的首条消息' }
check('重放前置：新建会话快照 = started:false', snap.started === false, JSON.stringify(snap))
snap = withStarted(snap)                                   // ② 「开始对话」
check('重放②：开讲后 started:true', snap.started === true, JSON.stringify(snap))
snap = withDraft(snap, '残留定时器回写的草稿')                  // ③ 300ms 后防抖到期
check('重放③：残留写入后 started 仍为 true（修复前此处会变 false）', snap.started === true, JSON.stringify(snap))
snap = withFold(snap, true, false)                         // 折叠条也被点过
check('重放④：折叠写入后 started 仍为 true', snap.started === true, JSON.stringify(snap))
check('重放⑤：草稿内容确实被更新（不是靠「不写入」蒙对）', snap.draft === '残留定时器回写的草稿', JSON.stringify(snap))
check('重放⑥：落点判定回到正常态而非准备态', decidePrepLanding(snap, 9).mode === 'chat', JSON.stringify(decidePrepLanding(snap, 9)))

console.log('\n=== 5. 负向：全仓 / 主文件不得再出现「回退 started」的写法（剥注释后）===')
check('index.tsx 里 `started: false` 有且仅有 1 处（= 新建任务那条）', count(mainCode, 'started: false') === 1, `count=${count(mainCode, 'started: false')}`)
const newTaskAt = mainCode.indexOf('const newTask = useCallback')
const falseAt = mainCode.indexOf('started: false')
check('那唯一一处在「新建任务」函数之后（确为新建语义）', newTaskAt >= 0 && falseAt > newTaskAt, `newTaskAt=${newTaskAt} falseAt=${falseAt}`)
check('index.tsx 里 `started: true` 不再手工出现（一律走 withStarted）', count(mainCode, 'started: true') === 0, `count=${count(mainCode, 'started: true')}`)
check('prepPolicy.ts 的 withDraft 体内不出现 started（结构保证）', !/export function withDraft[\s\S]*?\n\}/.exec(policyCode)[0].includes('started'), '')
check('prepPolicy.ts 的 withFold 体内不出现 started（结构保证）', !/export function withFold[\s\S]*?\n\}/.exec(policyCode)[0].includes('started'), '')
check('prepPolicy.ts 里 `started:` 只出现 1 次（withStarted 的返回值）', count(policyCode, 'started:') === 1, `count=${count(policyCode, 'started:')}`)

console.log('\n=== 6. 接线：主文件确实用上了纯函数与兜底数据 ===')
check('import 了 prepPolicy 的四个符号', mainCode.includes("from './prepPolicy'") && ['decidePrepLanding', 'withDraft', 'withFold', 'withStarted'].every((s) => new RegExp(`\\b${s}\\b`).test(mainCode)), '')
check('openSession 用 decidePrepLanding 判定落点', mainCode.includes('decidePrepLanding(prep, msgCount)'), '')
check('openSession 仍按 prepare 分支还原草稿 / 折叠位', mainCode.includes("landing.mode === 'prepare'"), '')
check('correctStarted 时回写校正（自愈落地）', mainCode.includes('if (landing.correctStarted) writeNav('), '')
check('refreshMessages 返回 rows.length（兜底数据来源）', /return rows\.length/.test(mainCode), '')
check('openSession 取到消息条数并交给判定', mainCode.includes('const msgCount = await refreshMessages(sid)'), '')
check('草稿 / 折叠写入改走 withDraft / withFold', mainCode.includes('prep: withDraft(prev, text)') && mainCode.includes('prep: withFold(prev, nextSrc, nextReq)'), '')
check('开讲改走 withStarted', mainCode.includes('prep: withStarted(prev)'), '')
const spAt = mainCode.indexOf('const startPreparedChat = useCallback')
const spBody = spAt >= 0 ? mainCode.slice(spAt, mainCode.indexOf('}, [input', spAt)) : ''
check('startPreparedChat 内先清防抖定时器再写标记', spBody.includes('clearTimeout(prepDraftTimer.current)') && spBody.indexOf('clearTimeout(prepDraftTimer.current)') < spBody.indexOf('withStarted('), '')
check('清定时器后置 null（避免重复 clear / 陈旧句柄）', spBody.includes('prepDraftTimer.current = null'), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.detail && !c.pass ? '  → ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

info('已知残留（不判失败）：左栏会话列表的「准备中」徽章仍按快照直读（index.tsx 两处 `readNav(s.id).prep?.started === false`），')
info('  未进入会话前可能滞后一拍；一旦进入该会话即被本次兜底自愈回写校正，无需额外处理。')

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
