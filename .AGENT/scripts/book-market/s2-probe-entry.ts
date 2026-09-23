// S2 网络层探针的 `net2` 入口 —— 把真实实现暴露给 probe-s2-search.cjs。
// 跑法见探针头注（esbuild 打包成 CJS → 裸 electron 执行）。
// 2026-09-23 由 tmp/ 收编至此 —— 原先只存在于 tmp/（gitignore），清理即丢、探针无法复现。
export {
  bookSourceList,
  bookSourceInfos,
  bookSourceGet,
  bookSourceUpsert,
  bookSourceSetEnabled,
  bookSourceSaveCredential,
  bookSourceClearCredential,
  bookSourceCredentialFor,
} from '../../../electron/lib/kbStore/bookSourceVaultRepo'
export { probeSourceConnectivity, searchBookSources } from '../../../electron/lib/bookMarket/sourceClient'
export { getBookMarketSession } from '../../../electron/lib/bookMarket/netSession'
export { setCurrentVault } from '../../../electron/lib/kbStore/vaultContext'
