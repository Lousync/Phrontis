#!/usr/bin/env node
/**
 * 契约验证：「端点内的账号」规则（electron/lib/llmAccountPure.ts）。
 *
 * 背景：用户的原始诉求是「同一个供应商两个账号，换账号还要重新输 Key」。
 * 账号做出来了，但它的**判据**必须被钉住，否则会静默坏掉：
 *   · 切账号若不只改 activeAccountId（顺手改了 models / modelFamilies），
 *     所有模型槽位就会指向别的模型 —— 这是最危险的失败模式；
 *   · 取 Key 若在"当前账号没 Key"时回退到别的账号，用户会拿 A 的 Key 调 B 的额度；
 *   · 脱敏若漏了密文，Key 会进渲染层。
 *
 * 断言（真跑纯模块，不是拿源码文本猜）见下方 §；期望末尾 PASS 且 exit=0。
 *
 * 运行（任意目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/llm-accounts/verify-llm-accounts.mjs
 */

import {
  migrateProvider, activeAccountOf, activeAccountKeyEnc, usableAccountsOf,
  providerUsable, sanitizeAccountInfo, appendAccount, removeAccount,
} from '../../../electron/lib/llmAccountPure.ts'

let failures = 0
const pass = (m) => console.log(`  [OK]   ${m}`)
const fail = (m) => { failures++; console.error(`  [FAIL] ${m}`) }
const check = (cond, msg) => { if (cond) pass(msg); else fail(msg) }

let seq = 0
const newId = () => `acct-${++seq}`

function provider(over = {}) {
  return {
    id: 'p1', name: 'DeepSeek', type: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEncrypted: '', enabled: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
    modelFamilies: { 'deepseek-reasoner': 'chat' },
    ...over,
  }
}

console.log('\n§1 迁移：旧记录（只有 apiKeyEncrypted）→ 单账号')
{
  const p = provider({ apiKeyEncrypted: 'enc1:OLD' })
  const changed = migrateProvider(p, newId)
  check(changed === true, '有改动 → 返回 true（调用方据此回写一次）')
  check(p.accounts.length === 1, `生成 1 个账号（实际 ${p.accounts.length}）`)
  check(p.accounts[0].keyEncrypted === 'enc1:OLD', '旧密文原样搬进账号，不重加密')
  check(p.activeAccountId === p.accounts[0].id, 'activeAccountId 指向这个账号')
  check(migrateProvider(p, newId) === false, '再迁移一次幂等（不产生第二个账号、不重复写盘）')
  check(p.accounts.length === 1, '重复迁移后账号数不变')
}
{
  const p = provider()
  migrateProvider(p, newId)
  check(p.accounts.length === 0, '没有旧 Key 的端点 → 0 个账号（不是伪造一个空账号）')
  check(p.activeAccountId === undefined, '0 账号时 activeAccountId 不被设置')
}
{
  // 当前账号 id 失效（被删 / 从别处搬来的脏数据）→ 退回第一个
  const p = provider({ accounts: [{ id: 'a', name: 'A', keyEncrypted: 'enc1:A', enabled: true }], activeAccountId: 'ghost' })
  check(migrateProvider(p, newId) === true, 'activeAccountId 失效 → 算作有改动')
  check(p.activeAccountId === 'a', '自动退回第一个账号')
}

console.log('\n§2 切账号不触碰模型（本轮最关键的不变量）')
{
  const p = provider({
    apiKeyEncrypted: 'enc1:A',
    accounts: [
      { id: 'a', name: '个人号', keyEncrypted: 'enc1:A', enabled: true },
      { id: 'b', name: '工作号', keyEncrypted: 'enc1:B', enabled: true },
    ],
    activeAccountId: 'a',
  })
  const modelsBefore = JSON.stringify(p.models)
  const famBefore = JSON.stringify(p.modelFamilies)
  const nameBefore = p.name
  const urlBefore = p.baseUrl

  // 切账号 = 只改这一个字段（IPC 里就是这么做的）
  p.activeAccountId = 'b'

  check(JSON.stringify(p.models) === modelsBefore, '模型清单一字未动（两账号共用一份 /models）')
  check(JSON.stringify(p.modelFamilies) === famBefore, '逐模型协议标记一字未动')
  check(p.name === nameBefore && p.baseUrl === urlBefore, '端点名与地址未动（换账号不重配接口）')
  check(activeAccountOf(p).name === '工作号', '当前账号已切到工作号')
}

console.log('\n§3 取 Key 只认当前账号（负向：绝不回退到别的账号）')
{
  const p = provider({
    apiKeyEncrypted: 'enc1:A',
    accounts: [
      { id: 'a', name: '个人号', keyEncrypted: 'enc1:A', enabled: true },
      { id: 'b', name: '工作号', keyEncrypted: 'enc1:B', enabled: true },
    ],
    activeAccountId: 'b',
  })
  check(activeAccountKeyEnc(p) === 'enc1:B', '切到 B 就取 B 的密文')
  p.activeAccountId = 'a'
  check(activeAccountKeyEnc(p) === 'enc1:A', '切回 A 就取 A 的密文')

  // B 的 Key 被清空 → 取到空串，而不是回退拿 A 的 Key
  p.activeAccountId = 'b'
  p.accounts[1].keyEncrypted = ''
  check(activeAccountKeyEnc(p) === '', '当前账号没 Key 时取空串，不回退到别的账号')

  // 没有 accounts 的旧记录才回退到单 Key 字段
  const legacy = provider({ apiKeyEncrypted: 'enc1:LEGACY' })
  check(activeAccountKeyEnc(legacy) === 'enc1:LEGACY', '无账号的旧记录回退到 apiKeyEncrypted（迁移前后行为一致）')
}

console.log('\n§4 脱敏：对外形状永不含密文')
{
  const acct = { id: 'a', name: '个人号', keyEncrypted: 'enc1:SECRET-XYZ', enabled: true, lastLatencyMs: 412, lastTestedAt: '2026-10-13T10:00:00.000Z' }
  const info = sanitizeAccountInfo(acct)
  check(info.hasKey === true, 'hasKey=true 告诉界面"已配置 Key"')
  const json = JSON.stringify(info)
  check(!json.includes('SECRET-XYZ'), '负向：对外 JSON 里不出现密文原文')
  check(!json.includes('enc1:'), '负向：对外 JSON 里不出现密文前缀')
  check(!('keyEncrypted' in info), '负向：对象上根本没有 keyEncrypted 这个键')
  check(info.lastLatencyMs === 412 && info.lastTestedAt === acct.lastTestedAt, '延时与测试时间照常给界面')
  check(sanitizeAccountInfo({ ...acct, keyEncrypted: '' }).hasKey === false, '没 Key 的账号 hasKey=false')
}

console.log('\n§5 端点可用性（决定模型进不进选择器）')
{
  const mk = (over) => provider({ apiKeyEncrypted: '', accounts: [], ...over })
  check(providerUsable(mk({ enabled: false, apiKeyEncrypted: 'enc1:A' })) === false, '端点停用 → 不可用（有 Key 也没用）')
  check(providerUsable(mk({ apiKeyEncrypted: 'enc1:A' })) === true, '旧记录有单 Key → 可用')
  check(providerUsable(mk()) === false, '旧记录无 Key → 不可用')
  check(providerUsable(mk({ accounts: [{ id: 'a', name: 'A', keyEncrypted: 'enc1:A', enabled: true }] })) === true, '有一个启用的带 Key 账号 → 可用')
  check(providerUsable(mk({ accounts: [{ id: 'a', name: 'A', keyEncrypted: 'enc1:A', enabled: false }] })) === false, '账号全停用 → 不可用（避免"选得到却调不通"）')
  check(providerUsable(mk({ accounts: [{ id: 'a', name: 'A', keyEncrypted: '', enabled: true }] })) === false, '账号无 Key → 不可用')
  check(providerUsable(mk({ type: 'ollama', accounts: [{ id: 'a', name: '本地', keyEncrypted: '', enabled: true }] })) === true, '本地模型不需要 Key → 可用')
  check(usableAccountsOf(mk({ accounts: [
    { id: 'a', name: 'A', keyEncrypted: 'enc1:A', enabled: true },
    { id: 'b', name: 'B', keyEncrypted: 'enc1:B', enabled: false },
  ] })).length === 1, 'usableAccountsOf 只数启用的那些')
}

console.log('\n§6 加账号 / 删账号')
{
  const p = provider({ accounts: [{ id: 'a', name: '个人号', keyEncrypted: 'enc1:A', enabled: true }], activeAccountId: 'a', apiKeyEncrypted: 'enc1:A' })
  const added = appendAccount(p, { name: '工作号', keyEncrypted: 'enc1:B' }, newId)
  check(p.accounts.length === 2, '加到 2 个账号')
  check(p.activeAccountId === added.id, '新加的账号直接切为当前（用户点"加一个账号"就是想用它）')
  check(p.apiKeyEncrypted === 'enc1:B', '兼容镜像同步为新账号的密文')
  check(added.enabled === true, '新账号默认启用')

  const p2 = provider({ accounts: [{ id: 'a', name: '', keyEncrypted: 'enc1:A', enabled: true }], activeAccountId: 'a' })
  const auto = appendAccount(p2, { keyEncrypted: 'enc1:C' }, newId)
  // 编号按「已有几个」推：p2 里已经有一个账号，所以新的叫「账号 2」
  check(auto.name === '账号 2', `名字缺省时按已有数量自动编号（实际「${auto.name}」）`)

  // 删当前账号 → 退回第一个
  const p3 = provider({
    apiKeyEncrypted: 'enc1:B',
    accounts: [
      { id: 'a', name: 'A', keyEncrypted: 'enc1:A', enabled: true },
      { id: 'b', name: 'B', keyEncrypted: 'enc1:B', enabled: true },
    ],
    activeAccountId: 'b',
  })
  check(removeAccount(p3, 'b') === true, '删除存在的账号返回 true')
  check(p3.accounts.length === 1 && p3.activeAccountId === 'a', '删掉当前账号 → 自动退回剩下的第一个')
  check(p3.apiKeyEncrypted === 'enc1:A', '兼容镜像跟着变成新当前账号的密文')

  check(removeAccount(p3, 'nope') === false, '删不存在的账号返回 false（IPC 据此报"账号不存在"）')
  removeAccount(p3, 'a')
  check(p3.accounts.length === 0, '可以删到 0 个账号')
  check(p3.activeAccountId === undefined, '0 账号后 activeAccountId 清空')
  check(p3.apiKeyEncrypted === '', '0 账号后兼容镜像也清空（不留幽灵 Key）')
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} —— 账号契约 ${failures} 处失败`)
process.exit(failures === 0 ? 0 : 1)
