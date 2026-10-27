#!/usr/bin/env node
/**
 * B-44：整卷提问卡的「其他补充」可见落点 / Enter 语义 / 分槽 —— 结构契约静态断言。
 *
 * 为什么静态断言：这是一段纯交互 UI（没有可抽的纯函数），而 B-44 的每个失败面都是
 * **静默**的——自定义答案写进 askPicks 但屏幕上不渲染、Enter 被 IME 截走、↑ 吞掉
 * 未提交文字、翻页把上一题草稿带过去、覆盖后两边都不高亮。逐条钉死，防回退。
 *
 * 跑法：node .AGENT/scripts/ai-teaching/verify-ask-custom.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const t = readFileSync(join(ROOT, 'src/modules/ai-teaching/index.tsx'), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`) }
}

console.log('\n[数据模型：按题分槽 + 自定义标记]')
check('补充草稿按题号存（Record<number,string>）',
  /const \[askCustomDrafts, setAskCustomDrafts\] = useState<Record<number, string>>\(\{\}\)/.test(t))
check('补充编辑态按题号存（Record<number,boolean>）',
  /const \[askCustomOpen, setAskCustomOpen\] = useState<Record<number, boolean>>\(\{\}\)/.test(t))
check('自定义答案有独立标记（不与选项文本混判）',
  /const \[askCustomPicks, setAskCustomPicks\] = useState<Record<number, boolean>>\(\{\}\)/.test(t))
check('换 ask 重置点选 / 翻页 / 草稿 / 编辑态 / 自定义标记',
  /setAskPicks\(\{\}\); setAskPage\(0\); setAskCustomDrafts\(\{\}\); setAskCustomOpen\(\{\}\); setAskCustomPicks\(\{\}\); setAskCollapsed\(false\)/.test(t))
check('旧全局单份 askCustom 字符串已删除',
  !/const \[askCustom, setAskCustom\]/.test(t) && !/setAskCustom\(''\)/.test(t))
check('旧 customMode / allPicked 混合判定已删除',
  !/customMode/.test(t) && !/allPicked/.test(t))

console.log('\n[A. 自定义答案有可见落点（根因 1 / 2 / 3）]')
check('hasCustomAnswer 由独立标记决定（文本恰好等于选项也仍算补充）',
  /const hasCustomAnswer = exam && pickedCur !== undefined && askCustomPicks\[page\] === true/.test(t))
check('选项高亮排除自定义标记（任意时刻只有一条高亮）',
  /const picked = exam \? pickedCur === o && askCustomPicks\[page\] !== true : false/.test(t))
check('补充答案行有 data-wb 锚点', /data-wb="aiTeachAskCustomAnswer"/.test(t))
check('补充答案行用 .kb-item-in 入场动效',
  /className="kb-item-in w-full flex items-center gap-2\.5/.test(t))
check('补充答案行有笔形图标 + 答案文本', /<PenLine size=\{11\} \/>/.test(t) && /\{pickedCur\}/.test(t))
check('补充答案行提供显式「编辑」入口（不是隐藏的 customMode 分支）',
  /hasCustomAnswer && \(/.test(t) && /onClick=\{openCustom\}/.test(t) && />编辑</.test(t))
check('编辑入口回填已有自定义答案',
  /hasCustomAnswer \? \(pickedCur \?\? ''\) : \(p\[page\] \?\? ''\)/.test(t))
check('覆盖旧答案给一次 Toast 轻反馈',
  /if \(prev !== undefined && prev !== v\) \{[\s\S]{0,240}?showToast\(\{ type: 'info'/.test(t))
check('首次补充不弹 Toast（由行入场可见）',
  /prev !== undefined && prev !== v/.test(t))

console.log('\n[B. Enter 语义（根因 4 / 6）]')
check('Enter 判 IME 组合态', /e\.key === 'Enter' && !e\.nativeEvent\.isComposing/.test(t))
check('Enter preventDefault 后提交', /e\.preventDefault\(\); submitCustom\(\)/.test(t))
check('Esc 组合态交给 IME，不收起提问卡',
  /e\.nativeEvent\.isComposing\) \{ e\.stopPropagation\(\); return \}/.test(t))
check('Esc 正常态取消补充编辑', /e\.preventDefault\(\); e\.stopPropagation\(\); cancelCustom\(\)/.test(t))
check('提交流程：写 askPicks',
  /setAskPicks\(p => \(\{ \.\.\.p, \[page\]: v \}\)\)/.test(t))
check('提交流程：打自定义标记',
  /setAskCustomPicks\(p => \(\{ \.\.\.p, \[page\]: true \}\)\)/.test(t))
check('提交流程：清本题草稿',
  /setAskCustomDrafts\(p => \{ const next = \{ \.\.\.p \}; delete next\[page\]; return next \}\)/.test(t))
check('提交流程：收起本题输入',
  /setAskCustomOpen\(p => \(\{ \.\.\.p, \[page\]: false \}\)\)/.test(t))
check('单题模式仍是 sendAskAnswer（不改成记录式）',
  /if \(!exam\) \{[\s\S]{0,260}?sendAskAnswer\(v\)/.test(t))

console.log('\n[C. 取消 / 回编（根因 2）]')
check('取消保留原答案：有自定义答案时回填，否则清草稿',
  /if \(hasCustomAnswer\) next\[page\] = pickedCur \?\? ''[\s\S]{0,120}?else delete next\[page\]/.test(t))
check('「其他补充…」只在没有补充答案时出现（有答案走行内编辑）',
  /\{!customOpen && !hasCustomAnswer && \(/.test(t))
check('补过草稿后按钮提示「继续编辑补充…」',
  /customDraft\.trim\(\) \? '继续编辑补充…' : '其他补充…'/.test(t))
check('点选项会移除自定义标记（选项与补充互斥）',
  /setAskCustomPicks\(p => \{ const next = \{ \.\.\.p \}; delete next\[page\]; return next \}\)/.test(t))

console.log('\n[D. 整卷 ↑ 不吞未提交文字（根因 4）]')
check('↑ 读取当前题输入框草稿', /const draft = customOpen \? customDraft\.trim\(\) : ''/.test(t))
check('↑ 先把草稿记到本题再统一发送',
  /if \(draft\) \{[\s\S]{0,420}?submitAskExam\(\{ page, value: draft \}\)/.test(t))
check('submitAskExam 支持 override 合并（避免 setState 异步漏答）',
  /const submitAskExam = useCallback\(\(override\?: \{ page: number; value: string \}\) => \{/.test(t) &&
  /const picks = override \? \{ \.\.\.askPicks, \[override\.page\]: override\.value \} : askPicks/.test(t))
check('草稿计入可提交数（未记录也能点 ↑）',
  /const draftFillsAnswer = exam && customOpen && !!customDraft\.trim\(\) && askPicks\[page\] === undefined/.test(t) &&
  /const submitCount = pickedCount \+ \(draftFillsAnswer \? 1 : 0\)/.test(t) &&
  /const canSubmitExam = !exam \|\| \(submitCount >= n && !otherDraftPending\)/.test(t))
check('其他页未确认补充会阻止整卷 ↑（跨页不静默丢字）',
  /const otherDraftPending = exam && Object\.entries\(askCustomOpen\)\.some/.test(t))
check('底部状态提示「有未确认补充」', /otherDraftPending \? ' · 有未确认补充'/.test(t))
check('↑ 标题提示翻回该题确认', /还有未确认的补充：翻回该题按 Enter 或取消/.test(t))
check('↑ disabled 使用 canSubmitExam（单题仍需编辑态 + 非空）',
  /disabled=\{pending \|\| \(exam \? !canSubmitExam : !\(customOpen && customDraft\.trim\(\)\)\)\}/.test(t))
check('底部状态显示「含当前补充，可提交」',
  /draftFillsAnswer \? ' · 含当前补充，可提交' : ' · 可提交'/.test(t))
check('↑ 标题显示实际提交计数', /统一发送全部回答（\$\{submitCount\}\/\$\{n\}）/.test(t))

console.log('\n[E. 分槽与输入接线（根因 5）]')
check('输入框绑定当前题草稿（不会被上一题串走）',
  /onChange=\{e => setAskCustomDrafts\(p => \(\{ \.\.\.p, \[page\]: e\.target\.value \}\)\)\}/.test(t))
check('输入框有 data-wb 锚点', /data-wb="aiTeachAskCustomInput"/.test(t))
check('输入框 autoFocus + 受控 + pending 禁用',
  /autoFocus value=\{customDraft\} disabled=\{pending\}/.test(t))
check('「其他补充…」入口有 data-wb 锚点', /data-wb="aiTeachAskCustomOpen"/.test(t))
check('编辑态显示「编辑中」而不是重复按钮', /编辑中/.test(t))

console.log('\n========================================')
if (fail === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fail} 项 FAIL（另有 ${pass} 项 PASS）`)
  process.exit(1)
}
