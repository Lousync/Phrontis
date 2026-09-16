/**
 * 契约脚本共用的源码扫描助手：**剥注释、保留字符串字面量与正则字面量**。
 *
 * 为什么需要它（v3.2.0 条目 14 踩到的坑，2026-09-16）：
 *   负向断言（「这个标识符全仓零残留」）必须先把注释剥掉，否则**说明文字会被当成真实代码** ——
 *   例如 `electron/lib/kbStore/habitVaultRepo.ts` 里那句「原先这里三个成员
 *   （HabitLinkRow / vaultHabitLinksAll …）已一并移除」，会被当成「还在用」。
 *   而 `src/types/index.ts` 的注释里恰好写着 `HabitLinkSource / HabitLink` 两个类型名，是现成靶子。
 *
 *   ⚠️ **必须识别正则字面量**，否则整块断言会静默失效：
 *   `scripts/import-backup-to-vault.mjs:45` 有 `const invalidName = /[\\/:*?"<>|\x00-\x1f]/g`，
 *   朴素扫描器会把里面的 `"` 当成字符串起点 → 之后所有 `//` 注释都不再被剥掉
 *   → 注释里那句「不再产出 links.json」被当成真实代码，负向断言**假失败**。
 *   教训：这个函数是负向断言的地基。地基错了会得到**看似有理的 FAIL**，比漏报更难查 ——
 *   所以宁可多写 20 行状态机，也不要图省事用 `split('//')`。
 *
 * 行号在剥离后仍一一对应（注释被替换为等量换行），便于报出命中行。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 正则字面量只可能出现在这些「期待表达式」的位置；变量名之后或 `)` 之后都是除号 */
const REGEX_START_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>'])
const REGEX_START_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw'])

export function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  let state = 'code'
  let quote = ''
  let inClass = false
  let lastSig = ''   // 最近一个非空白代码字符
  let word = ''      // 正在累积的标识符（判 return / typeof 这类前缀）
  const emit = (ch) => {
    if (ch === undefined) return
    out += ch
    if (/\s/.test(ch)) return
    lastSig = ch
    word = /[A-Za-z0-9_$]/.test(ch) ? word + ch : ''
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue }
      if (c === '/' && (lastSig === '' || REGEX_START_CHARS.has(lastSig) || REGEX_START_WORDS.has(word))) {
        inClass = false
        emit(c); state = 'regex'; i++; continue
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; emit(c); state = 'str'; i++; continue }
      emit(c); i++; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; emit('\n') }
      i++; continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue }
      if (c === '\n') emit('\n')
      i++; continue
    }
    if (state === 'regex') {
      if (c === '\\') { emit(c); emit(d); i += 2; continue }
      if (c === '[') { inClass = true; emit(c); i++; continue }
      if (c === ']') { inClass = false; emit(c); i++; continue }
      if (c === '/' && !inClass) { emit(c); state = 'code'; i++; continue }
      if (c === '\n') { state = 'code'; emit('\n'); i++; continue } // 兜底：正则不跨行
      emit(c); i++; continue
    }
    // state === 'str'
    if (c === '\\') { emit(c); emit(d); i += 2; continue }
    if (c === quote) { emit(c); state = 'code'; i++; continue }
    emit(c); i++; continue
  }
  return out
}

/**
 * 递归收集目录下的源码文件（默认扩展名 .ts/.tsx/.mjs/.js/.cjs），跳过 node_modules / dist / out。
 * 返回绝对路径数组；调用方自行决定是否再按 `skip` 谓词过滤（例如跳过脚本自身所在目录）。
 */
export function walkSourceFiles(dir, { exts = ['.ts', '.tsx', '.mjs', '.js', '.cjs'], skip = () => false } = {}, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (skip(p)) continue
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'out') continue
      walkSourceFiles(p, { exts, skip }, acc)
    } else if (exts.includes(path.extname(ent.name))) {
      acc.push(p)
    }
  }
  return acc
}
