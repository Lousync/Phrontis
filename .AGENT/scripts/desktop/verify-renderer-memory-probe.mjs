/**
 * 契约：渲染进程原生内存取证基建（v3.16.1 F-1）。
 *
 * 失败模式：OOM 崩溃时 JS heap 只有 31.4MB，而进程组峰值 4.2GB —— 增长在原生堆，
 * `JSHeapUsedSize` / `Nodes` 都看不到；外部 ps 采样重启即断，崩溃后 RSS 归零，
 * 没有「涨到过多大」的证据。修法不是猜一个分配点，而是把采样做进主进程并让崩溃日志自带上下文。
 *
 * 本脚本跑真实纯函数（格式化 / 轮转判据），并静态锁主进程接线、窗口生命周期与显式 env 开关。
 *
 * 跑法：node --experimental-strip-types --no-warnings .AGENT/scripts/desktop/verify-renderer-memory-probe.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'
import {
  formatMemorySample, formatMetricsSnapshot, shouldRotateMemoryLog,
  MEMORY_LOG_MAX_BYTES, MEMORY_SAMPLE_INTERVAL_MS,
} from '../../../electron/lib/rendererMemoryProbePure.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const read = (p) => stripComments(readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n'))

const probe = read('electron/lib/rendererMemoryProbe.ts')
const main = read('electron/main/index.ts')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

console.log('=== A. 纯函数行为（真实实现，不是源码字符串）===')
{
  const line = formatMemorySample({
    at: '2026-11-02T10:33:30.000Z', pid: 12345,
    rssKb: 528460, peakRssKb: 642000, jsHeapUsedKb: 32153.6,
  })
  ok(line === '2026-11-02T10:33:30.000Z pid=12345 rss=528460 peak=642000 jsHeap=32154',
    'A1 单行固定字段顺序：at pid rss peak jsHeap', line)

  const empty = formatMemorySample({
    at: '2026-11-02T10:33:30.000Z', pid: null,
    rssKb: null, peakRssKb: null, jsHeapUsedKb: null,
  })
  ok(empty === '2026-11-02T10:33:30.000Z pid=- rss=- peak=- jsHeap=-',
    'A2 缺值写 `-` 而不是 0（避免误读成「内存为零」）', empty)

  const metrics = formatMetricsSnapshot([
    { type: 'Browser', pid: 1, memory: { workingSetSize: 100, peakWorkingSetSize: 120 } },
    { type: 'Tab', name: 'Phrontis', pid: 2, memory: { workingSetSize: 528460, peakWorkingSetSize: 642000 } },
  ])
  ok(metrics === 'Browser pid=1 ws=100 peak=120; Tab(Phrontis) pid=2 ws=528460 peak=642000',
    'A3 崩溃快照保留进程类型 / 名称 / pid / 当前 / 峰值', metrics)

  ok(MEMORY_SAMPLE_INTERVAL_MS === 30_000, 'A4 采样间隔 = 30 秒（长回合够密，日志不爆）')
  ok(MEMORY_LOG_MAX_BYTES === 1024 * 1024, 'A5 日志 1MB 轮转')
  ok(shouldRotateMemoryLog(MEMORY_LOG_MAX_BYTES - 1) === false, 'A6 未到上限不轮转')
  ok(shouldRotateMemoryLog(MEMORY_LOG_MAX_BYTES) === true, 'A7 到达上限立即轮转（>=）')
  ok(shouldRotateMemoryLog(Number.NaN) === false, 'A8 异常 size 不轮转（宁可不转也不删证据）')
}

console.log('\n=== B. 采样模块（electron 依赖部分）===')
ok(/export function startRendererMemoryProbe\(/.test(probe), 'B1 导出 startRendererMemoryProbe')
ok(/app\.getAppMetrics\(\)\.filter\(\(m\) => m\.type === 'Tab'\)/.test(probe),
  'B2 取渲染进程（type === Tab）的 native 内存')
ok(/tabs\.find\(\(x\) => x\.pid === pid\) \?\? tabs\[0\]/.test(probe),
  'B3 优先按 pid 精确匹配，多窗口时不会抓错进程')
ok(/workingSetSize/.test(probe) && /peakWorkingSetSize/.test(probe),
  'B4 同时记录当前 RSS 与历史峰值（崩溃后 RSS 归零，peak 仍有效）')
ok(/performance\.memory\.usedJSHeapSize/.test(probe),
  'B5 JS heap 只作对照字段（已知长期平稳，不是主指标）')
ok(/rename\(file, prev\)/.test(probe) && /`\$\{file\}\.1`/.test(probe),
  'B6 超过上限转 `.1`（与 crash-log 同口径，只留一代）')
ok(/void tick\(\)/.test(probe), 'B7 启动后立即采一次（不必等第一个 30 秒）')
ok(/win\.isDestroyed\(\)/.test(probe) && /stop: \(\) =>/.test(probe),
  'B8 窗口销毁 / 主动 stop 后不再采样')
ok(!/heapProfiler|HeapProfiler|takeHeapSnapshot/.test(probe),
  'B9 负向：采样模块不主动触发 GC / heap snapshot（会改变运行形态）')
ok(/s\.rssKb != null \|\| s\.jsHeapUsedKb != null/.test(probe),
  'B10 页面 ready 前的空样本不写盘（避免 pid=0 / 全空行污染时间线）')

console.log('\n=== C. 主进程接线 ===')
ok(/startRendererMemoryProbe, formatMemorySample, formatMetricsSnapshot/.test(main),
  'C1 主进程 import 采样与格式化函数')
ok(/rendererMemProbe = startRendererMemoryProbe\(mainWindow\)/.test(main),
  'C2 窗口创建后启动采样')
ok(/rendererMemProbe\?\.stop\(\)[\s\S]{0,80}?rendererMemProbe = null/.test(main),
  'C3 窗口 closed 时停止采样并清引用（不泄漏定时器）')
ok(/rendererMemProbe\?\.latest\(\)/.test(main), 'C4 崩溃时读取「崩溃前最后一次样本」')
ok(/__kbLogCrashLine\?\.\('renderer-mem-last'/.test(main), 'C5 最近样本写进 crash-log')
ok(/__kbLogCrashLine\?\.\('app-metrics-at-crash'/.test(main)
  && /formatMetricsSnapshot\(app\.getAppMetrics\(\)\)/.test(main),
  'C6 崩溃时记录全进程 metrics（多窗口 / GPU / utility 一并留痕）')
ok(/__kbLogCrashLine = logCrash/.test(main), 'C7 复用 crash-log 的轮转与落盘口径')
{
  const iClean = main.indexOf("if (details.reason === 'clean-exit' || isQuitting) return")
  const iMem = main.indexOf("__kbLogCrashLine?.('renderer-mem-last'")
  ok(iClean > 0 && iMem > iClean, 'C9 正常退出不写内存上下文（clean-exit 判断在取证之前）')
}
ok(/KNOWBASE_NATIVE_HEAP_PROFILE === '1'/.test(main)
  && /appendSwitch\('enable-heap-profiling', 'native'\)/.test(main),
  'C8 原生 heap profile 只做显式 env 开关（默认零开销）')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
