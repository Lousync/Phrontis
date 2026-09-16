/**
 * 契约验证：AI 教学「画像更新建议」的合并写入与节流（v3.2.0 第 20 项）。
 *
 * 为什么需要它 —— 本项的三个症状（触发过频 / 更新混层 / 只能接受或忽略）里，
 * **「混层」是最危险的那个**：上层画像被整篇覆盖一次就不可逆，而这类缺陷的静默形态是
 * 「界面显示写入成功、文件也确实写了」—— 跑一遍界面根本看不出来。
 * 所以把两条红线钉死在纯函数上，并**用真实实现执行**（不复刻算法）：
 *   ① 上层 `mergeOnly` 时 `update` / `remove` 必须**字节级零副作用**；
 *   ② 渲染层解析不出来的条目数组**不得**回落成「整篇全文」被写进 PROFILE.md。
 * 另有一条容易被忽略的：`update` 的 `from` 原文对不上时是「跳过」还是「降级新增」，
 * 走错分支的表现是「AI 提的信息凭空消失」，同样静默。
 *
 * 运行（项目根目录）：
 *   node .AGENT/scripts/ai-teaching/verify-profile-patch.mjs [仓库路径]
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

const PATCH_REL = 'electron/lib/profilePatch.ts'
const PARSE_REL = 'src/modules/ai-teaching/profilePatchParse.ts'
const MAIN_REL = 'src/modules/ai-teaching/index.tsx'
const PROFILE_REL = 'electron/lib/aiTeachingProfile.ts'
const PRELOAD_REL = 'electron/preload/index.ts'
const IPC_REL = 'src/lib/ipc.ts'
const TYPES_REL = 'src/types/index.ts'
const SETTINGS_REL = 'src/lib/settings.ts'
const SECURITY_REL = 'src/modules/settings/views/SecurityView.tsx'

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const info = (msg) => console.log('  · ' + msg)

// ---------------------------------------------------------------- 真实实现装载
async function loadModule(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-patch-'))
  const tmp = path.join(tmpDir, path.basename(rel).replace(/\.ts$/, '.mjs'))
  fs.writeFileSync(tmp, stripTypeScriptTypes(src, { mode: 'strip' }))
  return { mod: await import(pathToFileURL(tmp).href), tmpDir }
}
const { mod: patch, tmpDir: d1 } = await loadModule(PATCH_REL)
const { mod: parse, tmpDir: d2 } = await loadModule(PARSE_REL)
const { parseProfileSections, normalizeField, applyProfileEntries } = patch
const { parseProfileFence, layerAllows, profileThrottleAllows, profileThrottleNote, userRoundCount, PROFILE_THROTTLE_ROUNDS, PROFILE_THROTTLE_MS } = parse

const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const mainCode = stripComments(src(MAIN_REL))
const profileCode = stripComments(src(PROFILE_REL))
const patchCode = stripComments(src(PATCH_REL))
const parseCode = stripComments(src(PARSE_REL))
const count = (s, sub) => s.split(sub).length - 1

// ---------------------------------------------------------------- 夹具
const BASE = [
  '# 学习者画像 · 本主题',
  '',
  '## 当前水平',
  '- 能读懂 Python 基础语法',
  '',
  '## 薄弱点',
  '- 递归的边界条件',
  '',
  '## 学习进度',
  '- 递归入门',
  '',
  '## 学习目标',
  '',
  '## 偏好',
  '',
].join('\n')
const BASE_LF = BASE

console.log('\n=== 1. 切段：只认二级标题，不新建字段（真实实现执行）===')
const secs = parseProfileSections(BASE)
check('切出 5 个小节', secs.length === 5, JSON.stringify(secs.map((s) => s.field)))
check('小节名不含 ## 前缀', secs.every((s) => !s.field.startsWith('#')), JSON.stringify(secs.map((s) => s.field)))
check('空小节（学习目标）也切出来了', secs.some((s) => s.field === '学习目标'), '')
check('normalizeField 能剥掉 ## 前缀', normalizeField('## 薄弱点') === '薄弱点', normalizeField('## 薄弱点'))
const rNew = applyProfileEntries(BASE, [{ field: '新字段', op: 'add', text: '随便写点什么' }])
check('落到不存在的小节 → 跳过（AI 不得重排画像结构）', rNew.applied.length === 0 && rNew.skipped.length === 1 && rNew.skipped[0].reason.includes('没有'), JSON.stringify(rNew.skipped))
check('落到不存在的小节 → 原文件零改动', rNew.text === BASE_LF, '')

console.log('\n=== 2. add：追加到小节正文末尾 + 同文本去重（真实实现执行）===')
const rAdd = applyProfileEntries(BASE, [{ field: '薄弱点', op: 'add', text: '闭包与作用域' }])
check('add 落到正确小节', rAdd.text.includes('## 薄弱点\n- 递归的边界条件\n- 闭包与作用域'), rAdd.text.slice(0, 200))
check('add 不会串到别的小节', !rAdd.text.includes('## 学习进度\n- 闭包与作用域'), '')
check('add 只 applied 1 条', rAdd.applied.length === 1 && rAdd.skipped.length === 0, JSON.stringify(rAdd))
const rDup = applyProfileEntries(BASE, [{ field: '薄弱点', op: 'add', text: '递归的边界条件' }])
check('同小节已有相同内容 → 去重跳过', rDup.applied.length === 0 && rDup.skipped[0].reason.includes('去重'), JSON.stringify(rDup.skipped))
check('去重后原文件零改动', rDup.text === BASE_LF, '')
const rAdd0 = applyProfileEntries(BASE, [{ field: '学习目标', op: 'add', text: '能独立做中等题' }])
check('add 到空小节 → 插在标题下一行', rAdd0.text.includes('## 学习目标\n- 能独立做中等题'), rAdd0.text.slice(0, 240))

console.log('\n=== 3. update：命中替换 / 未命中降级为新增（拍板口径，真实实现执行）===')
const rUp = applyProfileEntries(BASE, [{ field: '学习进度', op: 'update', from: '递归入门', text: '递归与分治已能独立做中等题' }])
check('命中 → 整行替换', rUp.text.includes('- 递归与分治已能独立做中等题') && !rUp.text.includes('- 递归入门'), rUp.text.slice(0, 240))
check('命中 → applied 1 条且无 note', rUp.applied.length === 1 && !rUp.applied[0].note, JSON.stringify(rUp.applied))
const rUp2 = applyProfileEntries(BASE, [{ field: '学习进度', op: 'update', from: '压根不存在', text: '新进度' }])
check('未命中 → 降级为新增（不丢 AI 提的信息）', rUp2.applied.length === 1 && rUp2.text.includes('- 新进度'), JSON.stringify(rUp2.applied))
check('未命中 → 结果里注明「已改为新增」', rUp2.applied[0]?.note?.includes('已改为新增') === true, JSON.stringify(rUp2.applied))
const rUp3 = applyProfileEntries(BASE, [{ field: '学习进度', op: 'update', from: '压根不存在', text: '递归入门' }])
check('未命中且该小节已有相同内容 → 跳过（不重复登记）', rUp3.applied.length === 0 && rUp3.text === BASE_LF, JSON.stringify(rUp3))

console.log('\n=== 4. remove：命中删行 / 未命中跳过（真实实现执行）===')
const rRm = applyProfileEntries(BASE, [{ field: '当前水平', op: 'remove', text: '能读懂 Python 基础语法' }])
check('命中 → 整行删除', !rRm.text.includes('能读懂 Python 基础语法'), '')
check('命中 → 别的行原样', rRm.text.includes('- 递归的边界条件'), '')
const rRm2 = applyProfileEntries(BASE, [{ field: '当前水平', op: 'remove', text: '不存在的内容' }])
check('未命中 → 跳过并回报', rRm2.applied.length === 0 && rRm2.skipped[0].reason.includes('未找到'), JSON.stringify(rRm2.skipped))
check('未命中 → 原文件零改动', rRm2.text === BASE_LF, '')

console.log('\n=== 5. 上层 mergeOnly：update / remove 必须字节级零副作用（本项红线）===')
for (const op of ['update', 'remove']) {
  const e = op === 'update'
    ? { field: '学习进度', op: 'update', from: '递归入门', text: '被改坏了' }
    : { field: '当前水平', op: 'remove', text: '能读懂 Python 基础语法' }
  const r = applyProfileEntries(BASE, [e], { mergeOnly: true })
  check(`mergeOnly · ${op} 被拒绝（applied 0 / skipped 1）`, r.applied.length === 0 && r.skipped.length === 1, JSON.stringify(r))
  check(`mergeOnly · ${op} 对原文件**字节级零副作用**`, r.text === BASE_LF, JSON.stringify(r.text.slice(0, 120)))
  check(`mergeOnly · ${op} 的跳过原因写明「只允许追加」`, r.skipped[0]?.reason?.includes('只允许追加') === true, r.skipped[0]?.reason ?? '')
}
const rMoAdd = applyProfileEntries(BASE, [{ field: '薄弱点', op: 'add', text: '生成器' }], { mergeOnly: true })
check('mergeOnly · add 仍然放行（上层允许追加）', rMoAdd.applied.length === 1 && rMoAdd.text.includes('- 生成器'), JSON.stringify(rMoAdd.applied))
const rMix = applyProfileEntries(BASE, [
  { field: '薄弱点', op: 'add', text: '生成器' },
  { field: '当前水平', op: 'remove', text: '能读懂 Python 基础语法' },
], { mergeOnly: true })
check('mergeOnly · 混着来时只放行 add（另一条被挡）', rMix.applied.length === 1 && rMix.skipped.length === 1, JSON.stringify(rMix))
const rCrlf = applyProfileEntries(BASE.replace(/\n/g, '\r\n'), [{ field: '薄弱点', op: 'add', text: '生成器' }])
check('CRLF 输入被归一为 LF', !rCrlf.text.includes('\r'), '')

console.log('\n=== 6. 渲染层解析：条目 / 全文 / 无效 三态（真实实现执行）===')
const p1 = parseProfileFence('[{"field":"薄弱点","op":"add","text":"递归边界"}]')
check('合法 JSON 数组 → entries', p1.mode === 'entries' && p1.entries.length === 1, JSON.stringify(p1))
const p2 = parseProfileFence('[{"field":"薄弱点","op":"add","text":"x"},]')
check('尾逗号容错 → 仍解得出条目', p2.mode === 'entries' && p2.entries.length === 1, JSON.stringify(p2))
const p3 = parseProfileFence('好的，我的建议如下：\n[{"field":"薄弱点","op":"add","text":"x"}]\n以上。')
check('围栏里夹了前后话 → 取首 [ 到末 ] 再解', p3.mode === 'entries' && p3.entries.length === 1, JSON.stringify(p3))
const p4 = parseProfileFence('# 学习者画像 · 本主题\n## 薄弱点\n- 递归')
check('旧形态（整篇 md 全文）→ fulltext 且原文不失真', p4.mode === 'fulltext' && p4.text.startsWith('# 学习者画像'), JSON.stringify(p4).slice(0, 120))
const p5 = parseProfileFence('')
check('空围栏 → invalid', p5.mode === 'invalid', JSON.stringify(p5))
const p6 = parseProfileFence('[{"field":"a","op":"typo","text":"x"}]')
check('**看着像数组却一条都解不出来 → invalid**（绝不回落成全文被写进 PROFILE.md）', p6.mode === 'invalid', JSON.stringify(p6))
const p7 = parseProfileFence('[{"field":"薄弱点","op":"add","text":"中文，带全角逗号：还有冒号"}]')
check('全角标点属正文内容，不得被「修」成半角', p7.mode === 'entries' && p7.entries[0].text === '中文，带全角逗号：还有冒号', JSON.stringify(p7))
const p8 = parseProfileFence('[{"field":"## 薄弱点","op":"update","from":"原文","text":"新文"}]')
check('field 带 ## 前缀被剥掉；update 的 from 被保留', p8.entries[0].field === '薄弱点' && p8.entries[0].from === '原文', JSON.stringify(p8))
const p9 = parseProfileFence('[{"field":"","op":"add","text":"x"},{"field":"薄弱点","op":"add","text":"y"}]')
check('缺 field 的坏条目被剔除，好条目保留', p9.mode === 'entries' && p9.entries.length === 1 && p9.entries[0].field === '薄弱点', JSON.stringify(p9))

console.log('\n=== 7. 层级权限：本主题可整段替换，上层只追加 ===')
check('session 放行 add', layerAllows('session', 'add') === true, '')
check('session 放行 update（拍板：本主题层允许整段替换字段）', layerAllows('session', 'update') === true, '')
check('session 放行 remove', layerAllows('session', 'remove') === true, '')
check('workspace 只放行 add', layerAllows('workspace', 'add') === true && layerAllows('workspace', 'update') === false && layerAllows('workspace', 'remove') === false, '')
check('global 只放行 add', layerAllows('global', 'add') === true && layerAllows('global', 'update') === false && layerAllows('global', 'remove') === false, '')

console.log('\n=== 8. 节流闸门：8 轮 / 30 分钟取先到 ===')
check('无记账状态 → 放行', profileThrottleAllows(undefined, 0, 0) === true, '')
const st = { mutedRound: 5, mutedTs: 1_000 }
check('刚忽略（同轮）→ 不放行', profileThrottleAllows(st, 5, 1_000) === false, '')
check(`过 ${PROFILE_THROTTLE_ROUNDS - 1} 轮 → 仍不放行`, profileThrottleAllows(st, 5 + PROFILE_THROTTLE_ROUNDS - 1, 1_000) === false, '')
check(`过 ${PROFILE_THROTTLE_ROUNDS} 轮 → 放行`, profileThrottleAllows(st, 5 + PROFILE_THROTTLE_ROUNDS, 1_000) === true, '')
check('未满 30 分钟 → 不放行', profileThrottleAllows(st, 5, 1_000 + PROFILE_THROTTLE_MS - 60_000) === false, '')
check('满 30 分钟 → 放行（**取先到**：轮数没到也放行）', profileThrottleAllows(st, 6, 1_000 + PROFILE_THROTTLE_MS) === true, '')
check('记账字段是残缺的（只有 time）→ 仍能按时间判定', profileThrottleAllows({ mutedTs: 1_000 }, 0, 1_000 + PROFILE_THROTTLE_MS) === true, '')
check('记账字段全空 → 放行（不把用户永久锁死）', profileThrottleAllows({}, 0, 0) === true, '')
check('剩余量提示非空（窗口内）', profileThrottleNote(st, 6, 1_000).includes('轮') === true, profileThrottleNote(st, 6, 1_000))
check('窗口已过 → 提示为空', profileThrottleNote(st, 5 + PROFILE_THROTTLE_ROUNDS, 1_000) === '', '')
check('userRoundCount 只数 user 消息', userRoundCount([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }]) === 2, '')

console.log('\n=== 9. 负向：不再出现的旧写法（剥注释后）===')
check('index.tsx 已无 profDismissed（旧「忽略只对当轮有效」的实现）', count(mainCode, 'profDismissed') === 0, `count=${count(mainCode, 'profDismissed')}`)
check('index.tsx 已无 acceptProfileSuggestion（旧整篇写入入口）', count(mainCode, 'acceptProfileSuggestion') === 0, `count=${count(mainCode, 'acceptProfileSuggestion')}`)
check('index.tsx 不再调用 aiTeachProfileWriteGlobal（上层不得被整篇覆盖）', count(mainCode, 'aiTeachProfileWriteGlobal') === 0, `count=${count(mainCode, 'aiTeachProfileWriteGlobal')}`)
check('index.tsx 不再调用 aiTeachProfileWriteWorkspace（同上）', count(mainCode, 'aiTeachProfileWriteWorkspace') === 0, `count=${count(mainCode, 'aiTeachProfileWriteWorkspace')}`)
check('index.tsx 的卡片不再用 mx-2（改为与输入框同容器）', !/profileSuggestion[\s\S]{0,400}?mx-2/.test(mainCode) && count(mainCode, 'mx-2') >= 0, '')
check('注入协议不再要求「本主题画像全文」', !profileCode.includes('本主题画像全文'), '')
check('注入协议改口为「变化条目」', profileCode.includes('变化条目'), '')
check('注入协议要求「没有新信息就不要输出」', profileCode.includes('没有新信息就不要输出'), '')
check('profilePatch.ts 的 mergeOnly 拒绝对齐入口（在 op 校验之后、切段之前）', (() => {
  const body = /export function applyProfileEntries[\s\S]*?\n  return \{/.exec(patchCode)?.[0] ?? ''
  return body.includes('mergeOnly') && body.indexOf('mergeOnly') < body.indexOf('parseProfileSections')
})(), '')
check('profilePatchParse.ts 未出现会被误装载的值导入（只许 import type）', !/^\s*import\s+(?!type)/m.test(parseCode), '')
check('profilePatch.ts 零 import（保证脚本能单文件装载）', !/^\s*import\s/m.test(patchCode), '')

console.log('\n=== 10. 接线：四处桥接 + 卡片 + 设置项 ===')
check('主进程注册了 aiTeachProfile:applyPatch', profileCode.includes("aiTeachProfile:applyPatch"), '')
check('主进程对未知层级直接拒绝', profileCode.includes('未知写入层级'), '')
check('主进程按层传 mergeOnly（非 session 即上层）', profileCode.includes('mergeOnly: layer !== \'session\''), '')
check('preload 桥接齐', src(PRELOAD_REL).includes('aiTeachProfileApplyPatch'), '')
check('types 声明齐（方法 + 条目类型）', src(TYPES_REL).includes('aiTeachProfileApplyPatch') && src(TYPES_REL).includes('AiTeachProfileEntry'), '')
check('ipc.ts 封装齐', src(IPC_REL).includes('aiTeachProfileApplyPatch'), '')
check('设置项 skipProfileDeleteConfirm 存在', src(SETTINGS_REL).includes('skipProfileDeleteConfirm'), '')
check('设置项默认 false（= 默认要确认）', /skipProfileDeleteConfirm: \{ default: false/.test(src(SETTINGS_REL)), '')
check('安全设置页有该开关', src(SECURITY_REL).includes('skipProfileDeleteConfirm'), '')
check('index.tsx 用新解析', mainCode.includes('parseProfileFence('), '')
check('index.tsx 用层级权限判定置灰', mainCode.includes('layerAllows(profLayer, r.op)'), '')
check('index.tsx 走合并写入而非整篇覆盖', mainCode.includes('aiTeachProfileApplyPatch('), '')
check('index.tsx 的忽略写入节流记账', mainCode.includes("mutedBy: by") && mainCode.includes('muteProfileSuggestion('), '')
check('删除类条目走全局确认框', mainCode.includes('showGlobalConfirm(') && mainCode.includes('skipProfileDeleteConfirm'), '')
check('节流状态接进 nav（按会话持久化）', mainCode.includes('profile: { mutedRound'), '')
check('卡片与输入框同容器宽度', count(mainCode, 'max-w-[820px] mx-auto px-3') >= 2, `count=${count(mainCode, 'max-w-[820px] mx-auto px-3')}`)
check('安静入口存在（节流窗口内不打断但不错过）', mainCode.includes('条画像更新待确认') && mainCode.includes('profQuiet'), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.detail && !c.pass ? '  → ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

info('已知残留（不判失败）：左栏会话列表的画像徽章按「有待确认建议」显示，与卡片同一份 `profPending` 判据，')
info('  但不区分节流窗口 —— 窗口内徽章仍亮、点进去是安静入口。若要彻底一致属新口径。')

for (const d of [d1, d2]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ } }
process.exit(failed.length === 0 ? 0 : 1)
