/**
 * secretBox 真实密文格式探针（必须在 Electron 主进程里跑，safeStorage 只在 Electron 可用）
 *
 * 用途：核实「Electron safeStorage 在 Windows 上究竟产出什么格式的密文」这一事实，
 *       避免再次出现「照注释以为密文 = DPAPI 直签产物 → 外部工具复刻格式 → 全量解密失败」的事故。
 *
 * 跑法（两条都必须照做）：
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe .AGENT/scripts/secret-format/probe.cjs
 *
 *   ① 必须先 unset ELECTRON_RUN_AS_NODE —— AI 沙箱的 shell 会注入该变量（值为 1），
 *      此时 electron.exe 以「纯 Node 模式」启动：process.type 为 undefined、
 *      require('electron') 返回的只是 electron.exe 路径字符串（typeof 为 string）→ app 为 undefined。
 *      三组对照实测：原样 → typeof string；unset 后 → process.type='browser'、typeof object；显式置 1 → 复现失败。
 *   ② 入口用 .cjs 而非 .mjs —— Electron 33 的 ESM 主进程加载 CJS 依赖会炸 cjsPreparseModuleExports
 *      （Cannot read properties of undefined (reading 'exports')）。
 *
 * 产物：  stdout 一份 JSON + tmp/secret-probe-result.json（供脚本/人工读取）
 *
 * 实测基线（2026-09-13，Electron 33.2.0 / Chromium 130.0.6723.118 / win32）：
 *   密文 = 'v10'(3B) + nonce(12B) + AES-256-GCM(密文 + tag 16B)，总长 = 31 + UTF-8 明文字节数
 *   样本 'probe-测试-abc123'（19B）→ 密文 50B，头部 hex 7631306b…（= 'v10k'），回环解密 OK
 *   密钥 = <userData>/Local State 的 os_crypt.encrypted_key（DPAPI 保护后的 AES 密钥，非密文本身）
 *
 * 声明：只读探测——加密一个样本串并回环解密，不写任何应用数据、不打印任何真实密钥内容。
 */
const { app, safeStorage } = require('electron')
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join, dirname } = require('node:path')

app.setName('knowbase') // 让 userData 指向应用真实目录，便于核对 Local State 位置

/** 只检查 Local State 里有没有 os_crypt.encrypted_key，绝不打印其内容 */
function inspectLocalState(userData) {
  const p = join(userData, 'Local State')
  if (!existsSync(p)) return { path: p, exists: false }
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8'))
    const k = j && j.os_crypt ? j.os_crypt.encrypted_key : undefined
    return {
      path: p,
      exists: true,
      hasOsCryptKey: typeof k === 'string' && k.length > 0,
      keyChars: typeof k === 'string' ? k.length : 0,
    }
  } catch (e) {
    return { path: p, exists: true, parseError: String((e && e.message) || e) }
  }
}

app.whenReady().then(() => {
  const out = {
    when: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userData: app.getPath('userData'),
    isEncryptionAvailable: false,
  }

  try {
    out.isEncryptionAvailable = safeStorage.isEncryptionAvailable()
    if (out.isEncryptionAvailable) {
      // 探针样本带中文，确认与编码无关
      const sample = 'probe-测试-abc123'
      const enc = safeStorage.encryptString(sample)
      out.cipherLen = enc.length
      out.cipherHeadAscii = enc.subarray(0, 4).toString('latin1') // 期望 'v10' + 1 字节 nonce
      out.cipherHeadHex = enc.subarray(0, 16).toString('hex')
      out.cipherStructHint = `nonce(12) + AES-256-GCM(ciphertext+tag(16)) 推定，实测总长 ${enc.length} 字节`
      out.roundTripOk = safeStorage.decryptString(enc) === sample
      out.verdict =
        enc.subarray(0, 3).toString('latin1') === 'v10'
          ? 'Chromium os_crypt v10：AES-256-GCM（密钥由 DPAPI 保护）—— 与「DPAPI 直签密文」的旧注释不符'
          : '前缀非 v10，需人工复核'
    } else {
      out.verdict = 'safeStorage 不可用（非用户会话/无凭据），本机无法给出密文样本'
    }
  } catch (e) {
    out.error = String((e && e.message) || e)
  }

  // 应用真实目录（dev 与正式两份都看一眼）
  const appdata = process.env.APPDATA || ''
  out.localState = {
    production: inspectLocalState(join(appdata, 'knowbase')),
    dev: inspectLocalState(join(appdata, 'knowbase (dev)')),
  }

  console.log(JSON.stringify(out, null, 2))
  try {
    const dest = join(process.cwd(), 'tmp', 'secret-probe-result.json')
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, JSON.stringify(out, null, 2))
  } catch {
    /* 落盘失败不影响 stdout 结论 */
  }

  app.quit()
})
