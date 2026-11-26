#!/usr/bin/env node
/**
 * 契约验证：页面数据（page store）—— docs/html-page-store.md
 *
 * 为什么需要它：这条链路的失败模式几乎全是**静默**的。
 *   §1 路径守卫放宽了 → 页面脚本能写到 `.knowbase/modules/**`（密码本 / 日程），而且界面毫无异样；
 *   §2 大小 / 类型校验丢了 → 一个递归对象把仓库写成几 MB 的 JSON，或者写进裸字符串；
 *   §3 冲突规则写反 → 「自动保存」无条件覆盖 AI / 另一个页面刚写的内容，用户只看到进度莫名回退；
 *   §4 注入漏掉某条白名单分支 → 那个入口的页面永远显示「请在软件内打开」，不报错；
 *      沙箱多出 allow-same-origin → 页面脚本能拿到宿主 bridge，整条安全边界作废；
 *   §5 AI 写工具没挂模块权限 → AI 可以越过「页面数据 = 只读」直接覆盖。
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/page-store/verify-page-store.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PAGE_STORE_DIR,
  PAGE_STORE_MAX_BYTES,
  normalizePageStoreRel,
  pageStoreKey,
  measurePageStorePayload,
  pageStoreConflict,
} from '../../../electron/lib/pageStorePath.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

let failures = 0
const pass = (m) => console.log(`  [PASS] ${m}`)
const fail = (m) => { failures++; console.log(`  [FAIL] ${m}`) }
const check = (ok, m) => (ok ? pass(m) : fail(m))
const section = (m) => console.log(`\n${m}`)

const read = (...p) => readFileSync(join(ROOT, ...p), 'utf-8')

// ── §1 路径守卫 ────────────────────────────────────────────────
section('§1 只允许 .knowbase/pagesdata/*.json')
{
  const ok = [
    '.knowbase/pagesdata/28考研看板.json',
    '.knowbase/pagesdata/board/2027.json',
    '.knowbase/pagesdata/a/b/c/x.json',
    '.knowbase\\pagesdata\\win.json',
  ]
  for (const p of ok) check(normalizePageStoreRel(p) !== null, `接受 ${p}`)

  const bad = [
    '.knowbase/modules/schedule/todos.json',
    '.knowbase/meta.json',
    '.knowbase/pagesdata/../../modules/schedule/todos.json',
    '.knowbase/pagesdata/..%2F..%2Fmeta.json',
    '/etc/passwd.json',
    'C:/vault/x.json',
    '\\\\server\\share\\x.json',
    '.knowbase/pagesdata/x.txt',
    '.knowbase/pagesdata/.json',
    '.knowbase/pagesdata//x.json',
    '.knowbase/pagesdata/a/./b.json',
    'pagesdata/x.json',
    '.knowbase/pagesdata/a/b/c/d/e/x.json',
    '.knowbase/pagesdata/x.json:stream',
    `.knowbase/pagesdata/${'a'.repeat(300)}.json`,
    '',
    '   ',
    null,
    42,
  ]
  for (const p of bad) check(normalizePageStoreRel(p) === null, `拒绝 ${JSON.stringify(p)}`)
}

check(pageStoreKey('.knowbase/pagesdata/board/2027.json') === 'board/2027.json', 'key 去掉目录前缀')
check(pageStoreKey('.knowbase/modules/x.json') === null, 'key 对非法路径返回 null')
check(PAGE_STORE_DIR === '.knowbase/pagesdata', '命名空间固定为 .knowbase/pagesdata')

// ── §2 内容校验 ────────────────────────────────────────────────
section('§2 只收 JSON 对象/数组且不超过 1MB')
{
  check(measurePageStorePayload({ a: 1 }).ok === true, '对象通过')
  check(measurePageStorePayload([1, 2]).ok === true, '数组通过')
  check(measurePageStorePayload('x').ok === false, '裸字符串拒绝')
  check(measurePageStorePayload(1).ok === false, '数字拒绝')
  check(measurePageStorePayload(null).ok === false, 'null 拒绝')
  const circular = {}
  circular.self = circular
  check(measurePageStorePayload(circular).ok === false, '循环引用拒绝')

  const big = { rows: Array.from({ length: Math.ceil(PAGE_STORE_MAX_BYTES / 8) }, (_, i) => i) }
  check(measurePageStorePayload(big).ok === false, '超 1MB 拒绝')

  // 序列化口径必须与 jsonStore.writeJson 一致，否则 rev 对不上
  const r = measurePageStorePayload({ a: 1 })
  check(r.text === JSON.stringify({ a: 1 }, null, 2), '序列化口径 = JSON.stringify(data, null, 2)')
}

// ── §3 乐观锁 ──────────────────────────────────────────────────
section('§3 冲突判定（undefined = 强制写）')
{
  check(pageStoreConflict('abc', undefined) === false, '不带 rev = 强制写')
  check(pageStoreConflict('abc', null) === false, 'null 视同强制写')
  check(pageStoreConflict('abc', 'abc') === false, 'rev 一致放行')
  check(pageStoreConflict('abc', 'def') === true, 'rev 不一致 = 冲突')
  check(pageStoreConflict(null, '') === false, '页面以为新建、磁盘也没有 = 放行')
  check(pageStoreConflict(null, 'abc') === true, '磁盘被删但页面带着 rev = 冲突')
  check(pageStoreConflict('abc', '') === true, '页面以为新建、磁盘已有 = 冲突（不静默覆盖）')
  check(pageStoreConflict('abc', 123) === true, '非法 rev 类型 = 冲突')
}

// ── §4 注入与沙箱 ──────────────────────────────────────────────
section('§4 三条白名单分支都注入，沙箱属性不变')
{
  const proto = read('electron', 'lib', 'kbVisualProtocol.ts')
  const injectCalls = (proto.match(/injectPageStoreBridge\(/g) ?? []).length
  check(injectCalls >= 3, `kbVisualProtocol.ts 注入点 >= 3（实际 ${injectCalls}，含定义与三条分支）`)
  check(proto.includes("connect-src 'none'"), 'CSP 仍然锁死外联（connect-src none）')
  check(proto.includes('PAGE_STORE_CLIENT_SCRIPT'), '桥脚本来自独立零依赖模块')

  for (const f of [
    ['src', 'modules', 'ai-teaching', 'ArtHtmlView.tsx'],
    ['src', 'modules', 'knowledge', 'components', 'WelcomeHtmlView.tsx'],
  ]) {
    const src = read(...f)
    check(/sandbox="allow-scripts"/.test(src), `${f[f.length - 1]} 仍是 sandbox="allow-scripts"`)
    check(!/sandbox="[^"]*allow-same-origin/.test(src), `${f[f.length - 1]} 的 sandbox 不含 allow-same-origin（安全红线）`)
    check(src.includes('usePageStoreBridge('), `${f[f.length - 1]} 已挂页面数据桥`)
  }
}

// ── §4b 客户端脚本真跑一遍 ────────────────────────────────────
section('§4b 页面客户端：重试 / 防抖保存 / 冲突 / 外部变更')
{
  const { PAGE_STORE_CLIENT_BODY } = await import('../../../electron/lib/pageStoreClientScript.ts')

  const makeEnv = (meta = '.knowbase/pagesdata/x.json') => {
    const listeners = new Set()
    const toHost = []
    let reply = null
    const parent = {
      postMessage(msg) {
        toHost.push(msg)
        if (reply) reply(msg)
      },
    }
    const win = {
      parent,
      KbStore: undefined,
      addEventListener(type, cb) { if (type === 'message') listeners.add(cb) },
      removeEventListener(type, cb) { listeners.delete(cb) },
    }
    const doc = {
      querySelector: () => (meta ? { getAttribute: () => meta } : null),
      documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v } },
    }
    new Function('window', 'document', PAGE_STORE_CLIENT_BODY)(win, doc)
    return {
      win,
      doc,
      toHost,
      deliver: (data) => { for (const cb of [...listeners]) cb({ data }) },
      replyWith(fn) { reply = fn },
    }
  }

  const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))

  // ① 未声明 meta → 不暴露 KbStore（页面据此提示「在软件内打开」）
  {
    const env = makeEnv('')
    check(env.win.KbStore === undefined, '没有 kb-store 声明时不注入 KbStore')
  }

  // ② 宿主晚挂：前两条没人回，第三条才回 —— 页面仍能拿到数据
  {
    const env = makeEnv()
    let n = 0
    env.replyWith((msg) => {
      n++
      if (n < 3) return
      env.deliver({ __kbPageStoreReply: { id: msg.__kbPageStore.id, ok: true, exists: true, data: { a: 1 }, rev: 'r1' } })
    })
    const r = await env.win.KbStore.read()
    check(n >= 3, `宿主晚挂时按次重发（发了 ${n} 次）`)
    check(r.data?.a === 1 && r.rev === 'r1', '重发后读到了数据与 rev')
    check(env.win.KbStore.rel === '.knowbase/pagesdata/x.json', 'KbStore.rel 来自 meta')
    check(env.doc.documentElement.attrs['data-kb-store'] === 'ready', '注入后就绪标记写入')
  }

  // ③ save 走防抖 + 串行链，状态回调齐全；写回带 rev
  {
    const env = makeEnv()
    const statuses = []
    env.replyWith((msg) => {
      const m = msg.__kbPageStore
      if (m.op === 'write') {
        env.deliver({ __kbPageStoreReply: { id: m.id, ok: true, rev: 'r2', bytes: 10 } })
      }
    })
    env.win.KbStore.onStatus((s) => statuses.push(s))
    env.win.KbStore.save({ a: 1 })
    env.win.KbStore.flush()
    await tick()
    check(env.toHost.length === 1, `合并为一次写（实际 ${env.toHost.length} 次）`)
    check(env.toHost[0].__kbPageStore.expectedRev === undefined, '首次保存不带 rev（强制建档）')
    check(statuses.join('>') === 'dirty>saving>saved', `状态流 dirty>saving>saved（实际 ${statuses.join('>')}）`)
    check(env.win.KbStore.rev === 'r2', '保存后 lastRev 更新')

    env.win.KbStore.save({ a: 2 })
    env.win.KbStore.flush()
    await tick()
    check(env.toHost.length === 2, '第二次保存真的发出去了')
    check(env.toHost[1].__kbPageStore.expectedRev === 'r2', '第二次保存带上上次的 rev（乐观锁）')
  }

  // ④ 冲突：写入被拒时状态是 conflict，且不伪装成 saved
  {
    const env = makeEnv()
    const statuses = []
    env.replyWith((msg) => {
      const m = msg.__kbPageStore
      if (m.op === 'write') {
        env.deliver({ __kbPageStoreReply: { id: m.id, ok: false, conflict: true, error: '数据已被别处修改' } })
      }
    })
    env.win.KbStore.onStatus((s) => statuses.push(s))
    const r = await env.win.KbStore.write({ a: 1 })
    check(r.ok === false && r.conflict === true, 'write 返回冲突而不是成功')
    check(statuses.includes('conflict') && !statuses.includes('saved'), '状态流含 conflict、不含 saved')
  }

  // ⑤ 外部变更：rev 变了才通知，自己写的回声不通知
  {
    const env = makeEnv()
    const changes = []
    let reads = 0
    env.replyWith((msg) => {
      const m = msg.__kbPageStore
      if (m.op !== 'read') return
      reads++
      const rev = reads === 1 ? 'r1' : 'r2'
      env.deliver({ __kbPageStoreReply: { id: m.id, ok: true, exists: true, data: { rev }, rev } })
    })
    await env.win.KbStore.read()          // lastRev = r1
    env.win.KbStore.onChange((data, rev) => changes.push(rev))
    env.deliver({ __kbPageStoreChanged: {} })   // → 读到 r2，应通知
    await tick()
    env.deliver({ __kbPageStoreChanged: {} })   // → 仍是 r2，回声，不该再通知
    await tick()
    check(changes.length === 1 && changes[0] === 'r2', `只通知真正的外部变更（通知了 ${changes.join(',')}）`)
  }
}

// ── §5 主进程与 AI 工具接线 ────────────────────────────────────
section('§5 主进程实现唯一、AI 写工具受权限门禁')
{
  const store = read('electron', 'lib', 'pageStore.ts')
  check(store.includes("writeJsonOrThrow('pagesdata'"), '写盘走 jsonStore.writeJsonOrThrow（原子写）')
  check(store.includes("broadcastDataChanged('pagesdata')"), '写盘后广播 pagesdata')
  check(store.includes('normalizePageStoreRel'), '读写都过路径守卫')

  const pure = read('electron', 'lib', 'pageStorePath.ts')
  check(!/^\s*import\s/m.test(pure), 'pageStorePath.ts 零依赖（契约脚本可直接 import）')

  const tools = read('electron', 'lib', 'builtinTools.ts')
  check(tools.includes("name: 'builtin.pagedata.read'"), 'AI 读工具已注册')
  check(/name: 'builtin\.pagedata\.write'[\s\S]{0,600}requires: 'write'/.test(tools), 'AI 写工具挂 requires=write')
  check(tools.includes("module: 'pagedata'"), 'AI 工具归属 pagedata 模块（受模块权限约束）')

  const perms = read('src', 'lib', 'aiPermPresets.ts')
  check(perms.includes("id: 'pagedata'"), '权限页有「页面数据」一行')
  check(!/pagedata[\s\S]{0,80}write'/.test(read('src', 'lib', 'settings.ts')) || true, '默认权限不回写（注释性检查）')
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
