// 契约验证：卡片英文自动翻译的纯函数（intel-translate-plan.md §8）。
//
// 为什么需要它：isEnglishText 决定哪些条目值得花 token（中文源必须零消耗），
// parseTranslateArray 决定整批译文的取舍（长度不齐 = 整批丢弃，宁可少译不可错位）——
// 这两个判据错一个，要么白烧预算、要么把 A 条目的译文挂到 B 条目上（静默错译比不译更糟）。
// translate.ts 引了 electron（llmService），脚本只直跑零依赖的 intelPure 同一实现。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/intel-translate/verify-translate-pure.mjs
// 期望：输出 PASS 且 exit=0

import { isEnglishText, parseTranslateArray, intelTextHash } from '../../../src/lib/intelPure.ts'

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
}

// ===== isEnglishText：拉丁 ≥6 且 CJK <25% =====
check('纯英文标题', isEnglishText('Show HN: I built a CLI that turns notes into a zettelkasten'), true)
check('英文含型号数字', isEnglishText('GPT-5 turbo benchmarks leak: 3x faster inference'), true)
check('中英混合偏英（OpenAI 发布 GPT-5）', isEnglishText('OpenAI 发布 GPT-5'), true)
check('纯中文', isEnglishText('量子位：国产大模型今日发布'), false)
check('中文为主带缩写（AI 时代 的机遇与挑战）', isEnglishText('AI 时代的机遇与挑战'), false)
check('短串', isEnglishText('Hi'), false)
check('空串/空白', isEnglishText('   '), false)
check('非字符串入参（fetch 层脏数据兜底）', isEnglishText(null), false)

// ===== parseTranslateArray：剥 fence、等长字符串数组才过 =====
check('裸数组', parseTranslateArray('["甲","乙"]', 2), ['甲', '乙'])
check('code fence 包裹', parseTranslateArray('```json\n["甲","乙"]\n```', 2), ['甲', '乙'])
check('前后带寒暄', parseTranslateArray('好的，以下是翻译：\n["甲","乙"]\n希望有帮助', 2), ['甲', '乙'])
check('逐项 trim', parseTranslateArray('["  甲 ","乙"]', 2), ['甲', '乙'])
check('长度不齐 → null', parseTranslateArray('["甲"]', 2), null)
check('非 JSON → null', parseTranslateArray('翻译失败了', 1), null)
check('对象伪装 → null', parseTranslateArray('{"0":"甲"}', 1), null)
check('数组含非字符串 → null', parseTranslateArray('["甲", 3]', 2), null)
check('空数组但期望 0 条', parseTranslateArray('[]', 0), [])

// ===== intelTextHash：缓存键稳定性（同一文本终身只译一次的根基） =====
const h1 = intelTextHash('GPT-5 turbo benchmarks leak')
check('稳定 40 位 hex', [h1.length, /^[0-9a-f]{40}$/.test(h1)], [40, true])
check('同文本同 hash', intelTextHash('GPT-5 turbo benchmarks leak') === h1, true)
check('异文本异 hash', intelTextHash('GPT-5 turbo benchmarks leak!') === h1, false)
check('非字符串入参不炸且稳定', intelTextHash(undefined) === intelTextHash(undefined), true)

if (failed > 0) {
  console.log(`FAIL  ${failed} case(s) failed`)
  process.exit(1)
}
console.log('PASS  all translate pure cases')
