/**
 * 大书体积分档（B-16 · 2026-09-22）。
 *
 * 为什么单独一个**零依赖**文件（照 `electron/lib/releaseNotes/judge.ts` 的先例）：判据与
 * **用户能看到的文案**都在这里，契约脚本要能直接 `import` 断言它（`node --experimental-strip-types`
 * 不做 TS 式无扩展名解析 ⇒ 本文件**不得出现任何 import**，连 `import type` 都别加 —— 加了就要求
 * 被导入的那个文件也可解析）。渲染侧 `EpubReaderView` 也 import 同一份，于是「阈值」与「文案」
 * 全应用只有一份，不存在两处各写一个数。
 *
 * 分档的由来（数字全部来自 2026-09-22 实测，见 `docs/pending-fixes.md` 的 B-16 记录）：
 * foliate 必须拿到**整本字节**才能翻开第一页（没有范围读通道），于是
 *   · 渲染侧峰值内存 ≈ **2× 文件体积**（改造后：Uint8Array 一份 + `new File()` 一份）；
 *   · 读取链路速率 ≈ **120MB/s** 量级（IPC 传输 ~160MB/s 是硬天花板，见记录表）。
 * ⇒ 128MB 以内无感（改造后实测 96MB「点卡 → ready」≈ 0.8s，其中体积增量仅 ~0.35s ——
 *   改造前同一本 1.6–2.0s）；再往上应先问一句（用户可能并不想为看一眼封面等好几秒、
 *   吃 1GB 内存）；384MB 以上即使点了确认也多半把机器拖卡，直接拒绝。
 */

/** 静默上限：≤ 此值直接打开（= 一期落码时定下的原 128MB 闸门，本批次**未抬**） */
export const BOOK_SILENT_MAX = 128 * 1024 * 1024

/** 硬上限：> 此值**即使确认也拒绝**（防解压炸弹 / 防把机器拖死） */
export const BOOK_HARD_MAX = 384 * 1024 * 1024

/**
 * 读取速率的估值（MB/s），只用于确认框里的「预计约 N 秒」。
 * ★ 与实测挂钩：改造后 96MB 的读取链路约 0.7–0.8s（IPC 160MB/s 天花板下，实测见探针
 *   `probe-cbz-bigbook.mjs` 的耗时分解）。这里取 120 是**留冗余**的写法 ——
 *   宁可让用户等得比预告短，不要反过来。改这里请同步重跑该探针。
 */
export const READ_EST_MBPS = 120

/** 峰值内存倍数（改造后的实测口径：Uint8Array + File 各一份）—— 同「宁可报多不报少」 */
export const PEAK_MEM_RATIO = 2

/** 分档结果：`ok` = 直接开；`confirm` = 先问一句；`refuse` = 直接拒绝 */
export type BookSizeTier = 'ok' | 'confirm' | 'refuse'

/** 字节 → 整数 MB（文案口径；向上取整，1.2MB 也报 2MB 而不是 1MB） */
export function mbOf(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 1048576))
}

/**
 * 三档判定。边界含**上**端点：恰好 128MB 不进确认档、恰好 384MB 不进拒绝档
 * （「128 MB 以内的电子书」这句话要成立，落码时按 ≤ 实现）。
 * 非有限 / 负数按 `ok` 处理（调用方拿到的是 stat 出来的真实 size，真出现异常值说明上游已坏，
 * 此处不做第二道守卫 —— 拒绝档的文案是给用户看的，不该被拿来做输入校验）。
 */
export function bookSizeTier(bytes: number): BookSizeTier {
  if (!Number.isFinite(bytes) || bytes <= BOOK_SILENT_MAX) return 'ok'
  if (bytes <= BOOK_HARD_MAX) return 'confirm'
  return 'refuse'
}

/** 预计耗时（秒，向上取整、至少 1 秒）—— 与 `READ_EST_MBPS` 同源，别在别处另算一份 */
export function estReadSeconds(bytes: number): number {
  return Math.max(1, Math.ceil(mbOf(bytes) / READ_EST_MBPS))
}

/** 预计内存占用（人类可读：< 1GB 报 MB，否则报 GB） */
export function estPeakMemText(bytes: number): string {
  const mb = mbOf(bytes) * PEAK_MEM_RATIO
  return mb < 1024 ? `${mb} MB` : `${(mb / 1024).toFixed(1)} GB`
}

/** 确认框正文（体积 + 预计耗时 + 预计内存，三样都给 —— 让用户有据可依地决定） */
export function bigBookConfirmText(name: string, bytes: number): string {
  const title = String(name ?? '').trim() || '这本电子书'
  return `《${title}》共 ${mbOf(bytes)} MB。翻开前需要把整本读进内存：预计约 ${estReadSeconds(bytes)} 秒，` +
    `期间约占用 ${estPeakMemText(bytes)} 内存，界面会短暂无响应。`
}

/** 拒绝档文案（说清多大、上限多少、怎么办；不出现「请联系管理员」这类空话） */
export function tooBigText(bytes: number): string {
  return `文件过大（${mbOf(bytes)} MB）：上限 ${Math.floor(BOOK_HARD_MAX / 1048576)} MB。` +
    '建议先转成 PDF 或拆成多本再导入。'
}

/** 「已取消」后停在 error 态时的文案（可再点「仍要打开」重来，不是死路）—— 文案里点明下一步 */
export function bigBookDeclinedText(name: string, bytes: number): string {
  const title = String(name ?? '').trim() || '这本电子书'
  return `已取消打开《${title}》（${mbOf(bytes)} MB）。想继续看的话，点下面的「仍要打开」。`
}
