import { aggregateErrors, ipcRing, netRing, logRing } from './capture'
import { runSelfTest, type SelfTestReport } from './selftest'

/**
 * AI 体检报告 —— 一条命令产出喂给 LLM 的标准开场上下文。
 *
 * 设计目标：输出控制在 ~2KB 量级（大字段一律不给原文），塞进任何模型上下文
 * 都不心疼；结构面向「先看失败、再看慢、再看脏数据」的排查顺序。
 *
 * R6 去库化：schema/迁移/db 路径字段随 connection.ts 移除。
 */

export interface HealthReport {
  summary: {
    ok: boolean
    failedChecks: string[]
    errorCount: number
    netErrorCount: number
  }
  selftest: Pick<SelfTestReport, 'passed' | 'failed' | 'items'>
  errorsTop: Array<{ count: number; message: string }>
  slowIpc: Array<{ channel: string; durationMs: number; ok: boolean }>
  netErrors: Array<{ url: string; status: number; error?: string }>
}

export async function buildReport(): Promise<HealthReport> {
  const selftest = await runSelfTest()

  const failedChecks = selftest.items.filter((i) => !i.ok).map((i) => i.name)
  const errors = aggregateErrors(true)
  const slowIpc = ipcRing
    .list()
    .filter((i) => i.durationMs > 100)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10)
    .map((i) => ({ channel: i.channel, durationMs: i.durationMs, ok: i.ok }))
  const netErrors = netRing
    .list()
    .filter((i) => !i.ok)
    .slice(-5)
    .map((i) => ({ url: i.url, status: i.status, error: i.error }))

  return {
    summary: {
      ok: selftest.failed === 0 && errors.length === 0,
      failedChecks,
      errorCount: errors.reduce((s, e) => s + e.count, 0),
      netErrorCount: netErrors.length,
    },
    selftest: { passed: selftest.passed, failed: selftest.failed, items: selftest.items },
    errorsTop: errors.slice(0, 5).map((e) => ({ count: e.count, message: e.message.slice(0, 160) })),
    slowIpc,
    netErrors,
  }
}

