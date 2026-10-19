import { ipcMain, safeStorage } from 'electron'

/**
 * 机密值加密封装（与密码本同一机制：Electron safeStorage）。
 *
 * ⚠️ 密文不是「Windows DPAPI 直签产物」—— DPAPI 只保护密钥，不直接加密值。
 * Windows 上 safeStorage 的底层是 Chromium os_crypt：
 *   · AES 密钥（32B 随机）经 DPAPI 保护后存 <userData>/Local State 的 os_crypt.encrypted_key；
 *   · 值密文 = 'v10'(3B) + nonce(12B) + AES-256-GCM(密文 + tag 16B)，总长 = 31 + UTF-8 明文字节数。
 * 实测基线（2026-09-13 / Electron 33.2.0 / Chromium 130 / win32）：
 *   样本 'probe-测试-abc123'(19B) → 密文 50B，头部 hex 7631306b…（即 'v10k'），回环解密 OK。
 *   探针脚本：.AGENT/scripts/secret-format/probe.cjs（跑法与全部实测数据见脚本头注释）。
 *   ⚠️ 外部工具如需复刻/校验本格式，必须按上面这条链路实现，不要照「DPAPI 加密」字样自行拼格式——
 *      2026-09-13 已因此出过一次事故：老备份导入时按纯 DPAPI 加密密码，应用侧解密全部失败，
 *      而 decryptSecret 按设计吞异常返回空串 → 用户侧表现为「条目都在、密码全空」。
 *
 * ---- Linux 段（2026-10-19 · Linux 平台化阶段 1，实测 Electron 33.2.0 / Chromium 130 / Ubuntu 26.04）----
 *   · 后端 = `gnome_libsecret`（系统钥匙串），**密文头 = 'v11'，不是 'v10'** ——
 *     原先这里硬断言 'v10'，于是在 Linux 上每次启动都报一条**假故障**（见 assertSecretBoxRoundTrip）。
 *   · 结构同样是 'v11'(3B) + nonce(12B) + AES-256-GCM(密文 + tag 16B)，总长 = 31 + UTF-8 明文字节数
 *     （探针实测：样本 4B → 35B，头部 hex 763131…，回环解密 OK）。期望头按平台给，见 KNOWN_CIPHER_HEADS。
 *   · 没有系统钥匙串（gnome-keyring / kwallet 都没跑）时 Chromium 退回 `basic_text` ——
 *     后端名会由 self-test 打出来：那是**写死口令的混淆**、不是真加密，值得单独提醒一句。
 *
 * 库内格式：'enc1:' + base64(上面的密文字节)；无前缀视为历史明文，读取时原样返回。
 * 与 passwordRepo 保持格式兼容，但不互相引用（避免模块耦合）。
 *
 * ★ 跨平台不可解密（已拍板决策 #10）：密钥在**本机钥匙串**里，不进仓库、不进备份 ⇒
 *   从 Windows / macOS 带来的 'enc1:' 密文在 Linux（以及反方向）**必然解不开**。
 *   这种情况**不再静默返回空串**：decodeSecret 给出 'undecryptable' 三态，经 IPC 透到界面显式提示
 *   （密码本与 LLM 账户页；渲染层文案见 src/modules/toolbox/components/PasswordVault.tsx 与
 *   src/modules/settings/views/AiModelsTab.tsx）。原先吞异常返回空串，表象是「条目都在、密码全空」。
 */
const ENC_PREFIX = 'enc1:'

/**
 * 各平台 safeStorage 密文头的**实测基线**（未列出的平台只做回环自检、不做头断言 ——
 * 宁可少断言，也不要把一个没实测过的新平台报成故障）。
 */
const KNOWN_CIPHER_HEADS: Record<string, readonly string[]> = {
  win32: ['v10'],
  // Linux：gnome_libsecret / kwallet → 'v11'；basic_text（无钥匙串）→ 'v10'（弱保护，另有后端告警）
  linux: ['v10', 'v11'],
}

export function encryptSecret(plain: string): string {
  if (!plain) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch { /* fall through */ }
  return plain // 加密不可用时退回明文(功能优先，与密码本策略一致)
}

/**
 * 解密三态（见文件头「跨平台不可解密」段）：
 *   · 'empty' 空值（没存过）· 'plaintext' 历史明文原样返回 · 'encrypted' 正常解出明文
 *   · 'undecryptable' **有密文但本机解不开**（多来自其他系统；调用方必须显式提示，别给空串了事）
 */
export type SecretDecodeState = 'empty' | 'plaintext' | 'encrypted' | 'undecryptable'

export interface SecretDecode {
  state: SecretDecodeState
  /** 解出的明文；'empty' / 'undecryptable' 时为 '' */
  value: string
}

export function decodeSecret(stored: string | null | undefined): SecretDecode {
  if (!stored) return { state: 'empty', value: '' }
  if (!stored.startsWith(ENC_PREFIX)) return { state: 'plaintext', value: stored } // 历史明文
  try {
    return {
      state: 'encrypted',
      value: safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')),
    }
  } catch {
    // 解不开 ≠ 没有值：调用方按 'undecryptable' 显示提示（见头注释）
    return { state: 'undecryptable', value: '' }
  }
}

/** 明文取值（签名保持兼容）。⚠️ 解不开时同样返回空串 —— 要区分请走 decodeSecret / isSecretUndecryptable。 */
export function decryptSecret(stored: string | null | undefined): string {
  return decodeSecret(stored).value
}

/** 「有值但本机解不开」—— 界面据此显示「无法解密」而不是静默空串 */
export function isSecretUndecryptable(stored: string | null | undefined): boolean {
  return decodeSecret(stored).state === 'undecryptable'
}

/** 当前生效的加密后端名（Linux：gnome_libsecret / kwallet / basic_text …；无该 API 的平台返回 'unknown'） */
export function secretStorageBackend(): string {
  try {
    const fn = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend
    if (typeof fn !== 'function') return 'unknown'
    return String(fn.call(safeStorage) || 'unknown')
  } catch { return 'unknown' }
}

/** 后端是否提供真加密（Linux 的 basic_text = 写死口令的混淆，值得单独提醒） */
export function isSecretStorageStrong(): boolean {
  return secretStorageBackend() !== 'basic_text'
}

export interface SecretPlatformInfo {
  platform: NodeJS.Platform
  /** safeStorage 在当前环境是否可用（不可用时按明文存储，功能优先） */
  encryptionAvailable: boolean
  /** 后端名（见 secretStorageBackend） */
  backend: string
}

/** 密文机制的平台自检信息（界面提示条据此说清「本机用什么在加密」） */
export function secretPlatformInfo(): SecretPlatformInfo {
  let available = false
  try { available = safeStorage.isEncryptionAvailable() } catch { available = false }
  return { platform: process.platform, encryptionAvailable: available, backend: secretStorageBackend() }
}

/**
 * IPC：密文平台信息（`secret:platformInfo`）。
 * 注册在本文件而不是 passwordRepo：两份密文实现**有意不互相引用**，平台信息属于「机制侧」这一份。
 */
export function registerSecretBoxHandlers(): void {
  ipcMain.handle('secret:platformInfo', () => secretPlatformInfo())
}

/**
 * 加密自检：encrypt → 密文格式断言（按平台）→ decrypt 回环。
 * 应用启动时调用一次（见 electron/main/index.ts）——用来兜住「safeStorage 行为/密文 schema 变化」
 * 或「有人误改了格式」，让问题在启动期就暴露，而不是等到用户发现「密码全空」。
 * 只告警不阻断：加密不可用（无头/无凭据）时本就退化为明文存储，此时跳过自检不算失败。
 *
 * @returns true 通过 / false 异常 / null 跳过（当前环境 safeStorage 不可用）
 */
export function assertSecretBoxRoundTrip(): boolean | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const sample = 'secretbox-selftest'
    const enc = safeStorage.encryptString(sample)
    const head = enc.subarray(0, 3).toString('latin1')
    const expected = KNOWN_CIPHER_HEADS[process.platform]
    if (expected && !expected.includes(head)) {
      console.warn(
        `[secretBox] 自检失败：${process.platform} 上密文头部期望 ${expected.join(' / ')}，` +
        `实际 '${head}'（长度 ${enc.length}，后端 ${secretStorageBackend()}）——` +
        'safeStorage 密文格式可能已变化，请复核本文件头注释与 .AGENT/scripts/secret-format/probe.cjs',
      )
      return false
    }
    if (process.platform === 'linux' && head === 'v10' && !isSecretStorageStrong()) {
      // 不是故障（功能可用），但保护强度与用户预期差得远，值得在启动期说清
      console.warn(
        `[secretBox] 注意：本机加密后端为 ${secretStorageBackend()}（没有系统钥匙串）——` +
        '这档密文是写死口令的混淆，不是真加密；密码与 API Key 的保护强度等于「文件可读即可解」。' +
        '装好 gnome-keyring / kwallet 后重启应用即换回系统钥匙串。',
      )
    }
    if (safeStorage.decryptString(enc) !== sample) {
      console.warn('[secretBox] 自检失败：encrypt → decrypt 回环结果不一致')
      return false
    }
    return true
  } catch (e) {
    console.warn('[secretBox] 自检异常：', e)
    return false
  }
}
