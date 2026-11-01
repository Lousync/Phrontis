import { ipcMain, safeStorage } from 'electron'
import {
  setSecretCryptoBackend,
  secretPlatformInfo,
} from 'phrontis-core/secretBox'

/**
 * secretBox 宿主适配层（2026-11-01 kbcore 抽取）：
 * 加密逻辑本体迁至 phrontis-core/src/secretBox.ts（SecretCrypto 后端注入），
 * 本文件只做两件事——
 *   1. 模块加载即把 Electron safeStorage 注入为加密后端（先于任何读写）；
 *   2. 保持原有导出面与 IPC 注册，调用方 import 路径不变。
 */

setSecretCryptoBackend({
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plain) => safeStorage.encryptString(plain),
  decryptString: (data) => safeStorage.decryptString(data),
  getSelectedStorageBackend: () => {
    const fn = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend
    return typeof fn === 'function' ? String(fn.call(safeStorage)) : undefined as unknown as string
  },
})

export {
  encryptSecret,
  decryptSecret,
  decodeSecret,
  isSecretUndecryptable,
  secretStorageBackend,
  isSecretStorageStrong,
  secretPlatformInfo,
  assertSecretBoxRoundTrip,
  type SecretDecode,
  type SecretDecodeState,
  type SecretPlatformInfo,
  type SecretCrypto,
} from 'phrontis-core/secretBox'

/**
 * IPC：密文平台信息（`secret:platformInfo`）。
 * 注册保留在宿主侧：两份密文实现**有意不互相引用**，平台信息属于「机制侧」这一份。
 */
export function registerSecretBoxHandlers(): void {
  ipcMain.handle('secret:platformInfo', () => secretPlatformInfo())
}
