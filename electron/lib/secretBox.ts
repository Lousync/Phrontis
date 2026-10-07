import { safeStorage } from 'electron'

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
 * 库内格式：'enc1:' + base64(上面的密文字节)；无前缀视为历史明文，读取时原样返回。
 * 与 passwordRepo 保持格式兼容，但不互相引用（避免模块耦合）。
 */
const ENC_PREFIX = 'enc1:'

export function encryptSecret(plain: string): string {
  if (!plain) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch { /* fall through */ }
  return plain // 加密不可用时退回明文(功能优先，与密码本策略一致)
}

export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return ''
  if (!stored.startsWith(ENC_PREFIX)) return stored // 历史明文
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    return '' // 解密失败(如密文来自其他机器)，不把密文当有效值返回
  }
}

/**
 * 加密自检：encrypt → 密文格式断言 → decrypt 回环。
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
    if (head !== 'v10') {
      console.warn(
        `[secretBox] 自检失败：密文头部期望 'v10'，实际 '${head}'（长度 ${enc.length}）——` +
        'safeStorage 密文格式可能已变化，请复核本文件头注释与 .AGENT/scripts/secret-format/probe.cjs',
      )
      return false
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
