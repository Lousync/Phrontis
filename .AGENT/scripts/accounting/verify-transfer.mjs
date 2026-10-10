#!/usr/bin/env node
/**
 * 契约验证：记账「转账」（2026-10-09）。
 *
 * 缺陷面：把「资金从一个账户转到另一个账户」记成**两笔收支**（源支出 + 目标收入），
 * 会让本月收支/结余/分类占比/趋势全被虚高（转账不是收入也不是支出）。正解是新增
 * `type='transfer'`：payment=转出、toPayment=转入，**不计收支、不影响总额**，只把余额挪过去。
 *
 * 断言两类：
 *   A. 纯函数真实实现（strip-types import `src/lib/accountingPure.ts`，零依赖）——
 *      余额口径：转账在账户间移动、不计 income/expense、总额不变、未归户单列；
 *   B. 接线静态断言 —— 类型/主进程 create·update·parse·import·balances·query / AI 工具枚举。
 *
 * 运行（仓库根）：node .AGENT/scripts/accounting/verify-transfer.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- A. 纯函数真实实现 ----------
const PURE_REL = 'src/lib/accountingPure.ts'
const pureSrc = read(PURE_REL)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-verify-'))
const tmpFile = path.join(tmpDir, 'accountingPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))
const { computeAccountBalances, sumAmount } = await import(pathToFileURL(tmpFile).href)

const accounts = [
  { id: 'a', name: '微信', color: '#f00', initialBalance: 100, builtin: true },
  { id: 'b', name: '现金', color: '#0f0', initialBalance: 0, builtin: true },
]
const tx = [
  { id: '1', date: '2026-10-01', time: '', type: 'expense', amount: 30, category: '餐饮', payment: '微信', merchant: '', note: '', createdAt: '', updatedAt: '' },
  { id: '2', date: '2026-10-01', time: '', type: 'income', amount: 50, category: '生活费', payment: '微信', merchant: '', note: '', createdAt: '', updatedAt: '' },
  { id: '3', date: '2026-10-02', time: '', type: 'transfer', amount: 20, category: '', payment: '微信', toPayment: '现金', merchant: '', note: '', createdAt: '', updatedAt: '' },
]

check('sumAmount 支出只算 expense（不含转账）', sumAmount(tx, 'expense') === 30, String(sumAmount(tx, 'expense')))
check('sumAmount 收入只算 income（不含转账）', sumAmount(tx, 'income') === 50, String(sumAmount(tx, 'income')))

const { list, total } = computeAccountBalances(accounts, tx)
const wx = list.find((a) => a.name === '微信')
const cash = list.find((a) => a.name === '现金')
check('转账：转出账户扣款（微信 100+50-30-20=100）', wx?.balance === 100, `wx=${wx?.balance}`)
check('转账：转入账户加款（现金 0+20=20）', cash?.balance === 20, `cash=${cash?.balance}`)
check('转账：不影响收/支字段（微信 收50 支30）', wx?.income === 50 && wx?.expense === 30, `in=${wx?.income} out=${wx?.expense}`)
check('转账：总额不变（=100+50-30=120）', total === 120, `total=${total}`)

// 未归户：转入账户不存在 → 单列「未指定」，净额为 0（源减、落加，总额不变）
const tx2 = [{ id: '4', date: '2026-10-03', time: '', type: 'transfer', amount: 15, category: '', payment: '微信', toPayment: '不存在的账户', merchant: '', note: '', createdAt: '', updatedAt: '' }]
const r2 = computeAccountBalances(accounts, tx2)
const loose = r2.list.find((a) => a.loose)
check('未归户：转入账户不存在 → 单列未指定且余额 +15', !!loose && loose.balance === 15, JSON.stringify(loose))
check('未归户：转出账户仍 -15', r2.list.find((a) => a.name === '微信')?.balance === 85, '')
check('未归户：总额不变（100）', r2.total === 100, `total=${r2.total}`)

// ---------- B. 接线静态断言 ----------
const srcTypes = read('src/types/index.ts')
const srcRepo = read('electron/lib/kbStore/accountingVaultRepo.ts')
const srcPanel = read('src/modules/accounting/AccountingPanel.tsx')
const srcViews = read('src/modules/accounting/views.tsx')
const srcTools = read('electron/lib/builtinTools.ts')

check('类型：新增 AccountingTxType（含 transfer）', /AccountingTxType = 'expense' \| 'income' \| 'transfer'/.test(srcTypes), '')
check('类型：交易/创建/解析带 toPayment', (srcTypes.match(/toPayment\?: string/g) || []).length >= 3, '')
check('主进程：TransactionRow / CreateTransactionInput 支持 transfer + toPayment', /AccountingTxType/.test(srcRepo) && /toPayment\?: string/.test(srcRepo), '')
check('主进程：create 校验转出≠转入', /转出与转入账户不能相同/.test(srcRepo), '')
check('主进程：parse 接受 transfer 且校验转入账户', /transfer' \? toPaymentRaw/.test(srcRepo) || /type === 'transfer' && !toPaymentRaw/.test(srcRepo), '')
check('主进程：balances 转账感知（tOut/tIn）', /tOut \+= t.amount/.test(srcRepo) && /tIn \+= t.amount/.test(srcRepo), '')
check('主进程：query/periodStats 转账不计收支', (srcRepo.match(/转账不计收支/g) || []).length >= 2, '')
check('渲染层：记账面板有「转账」档', /setType\('transfer'\)/.test(srcPanel) && /转出账户|转入账户/.test(srcPanel), '')
check('渲染层：流水对转账单列样式（↔ / 转账）', /isTransfer \? 'text-\[var\(--text-secondary\)\]'/.test(srcViews) && /转账/.test(srcViews), '')
check('AI 工具：query enum 含 transfer', /enum: \['expense', 'income', 'transfer'\]/.test(srcTools), '')

// ---------- 汇总 ----------
let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${!c.pass && c.detail ? '  -> ' + c.detail : ''}`)
}
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed}/${checks.length} 断言通过`)
process.exit(failed === 0 ? 0 : 1)
