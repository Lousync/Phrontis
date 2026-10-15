#!/usr/bin/env node
/**
 * 契约验证：存量 AI 会话「认领」行为（docs/agent-sessions-vault-plan.md §4、§6）。
 *
 * 与静态那份（verify-agent-vault-scope.mjs）的分工：那份锁「接线对不对」，这份**真跑**
 * 一遍文件搬运 —— 认领是**一次性、不可回滚**的动作（成功后源文件就被改名了），
 * 幂等性、校验失败不搬走、损坏不静默丢消息这三条只有真跑才验得出来。
 *
 * 两个被测模块都是「零相对 import」的纯模块（只用 fs / path），所以 node 可以直接加载
 * `.ts`（Node 24 原生类型剥离）。这也是当初坚持零相对 import 的原因：node 的 ESM
 * 不做扩展名补全，内部一旦出现 `./xxx` 就 ERR_MODULE_NOT_FOUND。
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/agent-vault/verify-agent-session-migrate.mjs
 * 期望：末行 PASS 且 exit=0
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { adoptLegacyGlobalAgentStore } from '../../../electron/lib/agentSessionMigrate.ts'
import { migrateLegacyMessages, readMessages } from '../../../electron/lib/agentMessageStore.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`[OK]   ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`)
  }
}

/** 建一对临时目录：全局数据目录 + 仓库 agent 目录 */
const temps = []
function mk() {
  const root = mkdtempSync(join(tmpdir(), 'kb-agent-adopt-'))
  temps.push(root)
  const globalDir = join(root, 'userData', 'data')
  const vaultDir = join(root, 'vault', '.knowbase', 'agent')
  mkdirSync(globalDir, { recursive: true })
  return { root, globalDir, vaultDir }
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'))
const msg = (id, sid, content) => JSON.stringify({ id, session_id: sid, role: 'user', content, trace_json: null, created_at: '2026-10-13 10:00:00' })

function writeGlobalV2(g, rows, messagesBySession) {
  writeFileSync(join(g, 'agent-sessions.json'), JSON.stringify(rows), 'utf-8')
  if (messagesBySession) {
    const dir = join(g, 'agent-messages')
    mkdirSync(dir, { recursive: true })
    for (const [sid, lines] of Object.entries(messagesBySession)) {
      writeFileSync(join(dir, `${sid}.jsonl`), lines.join('\n') + '\n', 'utf-8')
    }
  }
}

try {
  console.log('=== 1. 没有存量：什么都不做 ===')
  {
    const { globalDir, vaultDir } = mk()
    const r = adoptLegacyGlobalAgentStore({ globalDir, vaultAgentDir: vaultDir })
    check('返回未认领', r.adopted === false && r.sessions === 0 && r.messages === 0)
    check('不在仓库里造目录', !existsSync(vaultDir))
  }

  console.log('=== 2. v2 认领：索引 + 分文件消息整体搬进仓库 ===')
  let g2
  {
    const t = mk()
    g2 = t
    const rows = [{ id: 's1', title: '甲乙', source: 'assistant' }, { id: 's2', title: '丙丁', source: 'aiTeaching' }]
    writeGlobalV2(t.globalDir, rows, { s1: [msg('m1', 's1', 'A'), msg('m2', 's1', 'B')], s2: [msg('m3', 's2', 'C')] })
    // 源字节要在认领**之前**取：认领成功后全局目录已被改名（agent-messages -> agent-messages.migrated）
    const srcS1 = readFileSync(join(t.globalDir, 'agent-messages', 's1.jsonl'))
    const r = adoptLegacyGlobalAgentStore({ globalDir: t.globalDir, vaultAgentDir: t.vaultDir })
    check('adopted=true 且条数正确', r.adopted === true && r.sessions === 2 && r.messages === 3, JSON.stringify(r))
    const dstIndex = join(t.vaultDir, 'sessions.json')
    check('仓库侧索引落盘且行序不变', existsSync(dstIndex) && JSON.stringify(readJson(dstIndex)) === JSON.stringify(rows))
    check('索引文件名是 sessions.json（不是 agent-sessions.json）', !existsSync(join(t.vaultDir, 'agent-sessions.json')))
    check('消息按会话分文件落 messages/', readdirSync(join(t.vaultDir, 'messages')).sort().join(',') === 's1.jsonl,s2.jsonl')
    check('消息文件与源字节一致', readFileSync(join(t.vaultDir, 'messages', 's1.jsonl')).equals(srcS1))
    // ★ 这条是整个脚本最重要的一条：用**读端的 API** 把认领进去的消息读回来。
    //   认领器与读端各有一个「消息子目录名」常量，写读不一致的后果是「认领成功但消息全看不见」
    //   （只比对路径字符串是抓不到的 —— 2026-10-13 实际踩过一次：认领写 messages/、读端找 agent-messages/）。
    const back = readMessages(t.vaultDir, 's1')
    check('读端 API 能读回认领的消息（跨模块目录名一致）', back.length === 2 && back[0].content === 'A' && back[1].content === 'B', JSON.stringify(back.map((m) => m.content)))
  }

  console.log('=== 3. 幂等：再调一次不会给第二个仓库复制一份 ===')
  {
    const r2 = adoptLegacyGlobalAgentStore({ globalDir: g2.globalDir, vaultAgentDir: g2.vaultDir })
    check('第二次返回未认领', r2.adopted === false && r2.sessions === 0)
    check('仓库侧索引未被改动（仍 2 条）', readJson(join(g2.vaultDir, 'sessions.json')).length === 2)
    check('全局索引已改名留存', !existsSync(join(g2.globalDir, 'agent-sessions.json')) && existsSync(join(g2.globalDir, 'agent-sessions.json.migrated.json')))
    check('全局消息目录已改名留存（不删）', !existsSync(join(g2.globalDir, 'agent-messages')) && existsSync(join(g2.globalDir, 'agent-messages.migrated')))
    check('留存文件内容与原件一致（2 会话）', readJson(join(g2.globalDir, 'agent-sessions.json.migrated.json')).length === 2)
    // 关键性质：换一个仓库再调，不会搬第二份
    const other = mk()
    const r3 = adoptLegacyGlobalAgentStore({ globalDir: g2.globalDir, vaultAgentDir: other.vaultDir })
    check('换仓库再调也不会复制第二份', r3.adopted === false && !existsSync(other.vaultDir))
  }

  console.log('=== 4. v1 全量消息文件：原样拷入 + 交给既有拆分器 ===')
  {
    const t = mk()
    const rows = [{ id: 's9', title: '戊己', source: 'assistant' }]
    writeFileSync(join(t.globalDir, 'agent-sessions.json'), JSON.stringify(rows), 'utf-8')
    // v1：全体消息一个文件
    writeFileSync(join(t.globalDir, 'agent-messages.json'), JSON.stringify([JSON.parse(msg('v1a', 's9', 'X')), JSON.parse(msg('v1b', 's9', 'Y'))]), 'utf-8')
    const r = adoptLegacyGlobalAgentStore({ globalDir: t.globalDir, vaultAgentDir: t.vaultDir })
    check('认领成功（v1 阶段消息数为 0，拆分在下一步）', r.adopted === true && r.sessions === 1)
    check('v1 文件被原样拷进仓库目录', existsSync(join(t.vaultDir, 'agent-messages.json')))
    check('全局 v1 文件也改名留存', existsSync(join(t.globalDir, 'agent-messages.migrated.json')))
    // 仓库侧随后由 ensureMigrated 拆分（此处直接调，等价于 repo 层认领后那一步）
    const legacy = migrateLegacyMessages(t.vaultDir)
    check('拆分出 2 条消息', !!legacy && legacy.sessions === 1 && legacy.messages === 2, JSON.stringify(legacy))
    check('v1 文件拆完改名留存（仓库内）', !existsSync(join(t.vaultDir, 'agent-messages.json')) && existsSync(join(t.vaultDir, 'agent-messages.migrated.json')))
    check('消息落到 messages/s9.jsonl', existsSync(join(t.vaultDir, 'messages', 's9.jsonl')))
  }

  console.log('=== 5. 索引损坏：抛错且原地不动（绝不把数据搬没） ===')
  {
    const t = mk()
    writeFileSync(join(t.globalDir, 'agent-sessions.json'), '{ 这不是 JSON', 'utf-8')
    let threw = false
    try {
      adoptLegacyGlobalAgentStore({ globalDir: t.globalDir, vaultAgentDir: t.vaultDir })
    } catch {
      threw = true
    }
    check('损坏索引触发抛错', threw)
    check('全局文件仍在原地（未改名）', existsSync(join(t.globalDir, 'agent-sessions.json')) && !existsSync(join(t.globalDir, 'agent-sessions.json.migrated.json')))
    check('仓库侧没有落任何索引', !existsSync(join(t.vaultDir, 'sessions.json')))
  }

  console.log('=== 6. 合并路径：仓库已有会话 + 重试认领 ===')
  {
    const t = mk()
    const srcRows = [{ id: 'a', title: '源甲' }, { id: 'b', title: '源乙' }]
    writeGlobalV2(t.globalDir, srcRows, { a: [msg('ma', 'a', 'A')] })
    // 仓库里已经有一条别的会话（模拟上一轮已认领过一部分 / 用户已有新会话）
    mkdirSync(t.vaultDir, { recursive: true })
    writeFileSync(join(t.vaultDir, 'sessions.json'), JSON.stringify([{ id: 'z', title: '仓库自有' }]), 'utf-8')
    const r = adoptLegacyGlobalAgentStore({ globalDir: t.globalDir, vaultAgentDir: t.vaultDir })
    const merged = readJson(join(t.vaultDir, 'sessions.json'))
    check('认领到已有索引上（3 条）', r.adopted === true && merged.length === 3, JSON.stringify(merged.map((x) => x.id)))
    check('源在前、仓库自有的在后', merged.map((x) => x.id).join(',') === 'a,b,z')
    // 消息合并：源 a.jsonl 与仓库 a.jsonl 里有同 id 的一条 —— 去重
    mkdirSync(join(t.vaultDir, 'messages'), { recursive: true })
    const dup = JSON.parse(msg('ma', 'a', 'A'))
    writeFileSync(join(t.vaultDir, 'messages', 'a.jsonl'), JSON.stringify(dup) + '\n' + msg('mz', 'a', 'Z') + '\n', 'utf-8')
    // 再放一份源（改名留存已发生，重建一份模拟重试）
    writeGlobalV2(t.globalDir, [{ id: 'a', title: '源甲' }], { a: [msg('ma', 'a', 'A')] })
    const r2 = adoptLegacyGlobalAgentStore({ globalDir: t.globalDir, vaultAgentDir: t.vaultDir })
    const lines = readFileSync(join(t.vaultDir, 'messages', 'a.jsonl'), 'utf-8').split('\n').filter((x) => x.trim())
    check('重复消息按 id 去重（ma 只留一条）', r2.adopted === true && lines.filter((l) => l.includes('"ma"')).length === 1)
    check('仓库原有消息不丢（mz 还在）', lines.some((l) => l.includes('"mz"')))
  }

  console.log('=== 7. 合并路径遇损坏行：抛错，不静默丢消息 ===')
  {
    const t = mk()
    writeGlobalV2(t.globalDir, [{ id: 'a', title: '源甲' }], { a: [msg('ma', 'a', 'A'), '{坏行'] })
    mkdirSync(join(t.vaultDir, 'messages'), { recursive: true })
    writeFileSync(join(t.vaultDir, 'messages', 'a.jsonl'), msg('mz', 'a', 'Z') + '\n', 'utf-8')
    let threw = false
    try {
      adoptLegacyGlobalAgentStore({ globalDir: t.globalDir, vaultAgentDir: t.vaultDir })
    } catch {
      threw = true
    }
    check('损坏行触发抛错', threw)
    check('全局索引未改名（可重试）', existsSync(join(t.globalDir, 'agent-sessions.json')))
  }
} finally {
  for (const t of temps) {
    try {
      rmSync(t, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响判定 */
    }
  }
}

console.log('')
if (fail === 0) {
  console.log(`PASS  ${pass} 项断言全部通过`)
  process.exit(0)
}
console.log(`FAIL  ${fail} 项失败 / 共 ${pass + fail} 项`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(1)
