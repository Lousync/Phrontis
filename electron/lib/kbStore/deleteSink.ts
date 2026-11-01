/**
 * vault 条目删除通知（手机伴侣墓碑的数据源）。
 *
 * 层向：kbStore 在最底层，不能反向依赖 phoneCompanion —— 所以用这个极简观察者：
 * repo 的删除函数（schedule 级联删 / 7 天清理 / 结算撤销、accounting 删流水）
 * 在真正删掉行之后 emit，phoneCompanion 启动时注册 sink 把删除落成墓碑
 * （tombstoneVaultRepo）。没人注册时 emit 是 no-op，零成本。
 */

export type VaultDeleteSink = (domain: string, ids: string[]) => void

let sink: VaultDeleteSink | null = null

export function setVaultDeleteSink(fn: VaultDeleteSink | null): void {
  sink = fn
}

export function emitVaultDeletes(domain: string, ids: string[]): void {
  if (!sink || ids.length === 0) return
  try {
    sink(domain, ids)
  } catch (e) {
    // 墓碑记录失败不阻断删除本身（删除已生效；墓碑缺失的最坏后果是该条在手机上滞留）
    console.error('[deleteSink] emit failed', domain, ids.length, e)
  }
}
