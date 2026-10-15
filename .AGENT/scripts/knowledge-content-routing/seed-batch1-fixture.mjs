/**
 * 批 1 实机验收用的 fixture 播种（散落在仓库**正文区**的非 md 文件）
 *
 * 为什么需要它：既有的 `tmp/vault-fixture`（`.AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs` 造）
 * 只覆盖「书」——PDF 全在 `.books/` 下，而 `.books` 是点前缀目录，**知识库索引会跳过**
 * （`knowledgeIndex.ts` 系统目录规则）。批 1 要验的恰恰是「散落在仓库里的 PDF / 代码 / 文本」，
 * 所以必须往正文区放文件。
 *
 * 用法：
 *   node .AGENT/scripts/knowledge-content-routing/seed-batch1-fixture.mjs
 *   node .AGENT/scripts/knowledge-content-routing/seed-batch1-fixture.mjs --with-big
 *
 * --with-big 额外造两个大文件（约 62MB），用来验「>10MB 只读 / >50MB 打不开」两条降级路径。
 * 默认不造 —— 它们只是为了让门槛分支跑起来，平时白占磁盘。
 *
 * 产物全部落在 `tmp/vault-fixture/批1探针/`（`tmp/` 已被 .gitignore:45 忽略，不进版本控制）。
 * 本脚本**只写 fixture 目录**，不碰任何真实仓库。
 */
import { mkdirSync, writeFileSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FIXTURE = join(ROOT, 'tmp', 'vault-fixture')
const DIR = join(FIXTURE, '批1探针')
const WITH_BIG = process.argv.includes('--with-big')

const log = (s) => console.log('[batch1-fixture] ' + s)

if (!existsSync(FIXTURE)) {
  log(`fixture 仓库不存在：${FIXTURE}`)
  log('先跑：node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books --ud "knowbase (dev probe-app)"')
  process.exit(1)
}

mkdirSync(DIR, { recursive: true })

/* ---------- 文本类：应落「可编辑」 ---------- */

writeFileSync(join(DIR, '脚本.py'), `# 批 1 fixture：文本类应落「可编辑」
# 判定要点：保存走 ws:writeFile，非 md **不注入 frontmatter** —— 改完存盘，本文件开头不该多出 --- 头。

import json
import sys


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


if __name__ == "__main__":
    print(load(sys.argv[1]))
`, 'utf8')

writeFileSync(join(DIR, '说明.txt'), `批 1 fixture：纯文本

改前：点开先看到「元信息卡」，再点一次「查看内容」才是只读正文（两跳 + 只读）。
改后：点开直接进可编辑页签。

注意：本文件开头若被写入 --- 之类的 frontmatter 头，就是保存通道串到 md 分支了。
`, 'utf8')

writeFileSync(join(DIR, '数据.csv'), `date,subject,minutes,note
2026-10-08,认知负荷理论,95,第一遍
2026-10-09,认知负荷理论,120,做笔记
2026-10-10,间隔重复,60,复习
2026-10-11,间隔重复,75,复习
`, 'utf8')

writeFileSync(join(DIR, '配置.json'), `{
  "note": "批 1 fixture：非导图的普通 JSON，应落可编辑文本落点",
  "editor": { "fontSize": 13, "writingMode": "source" }
}
`, 'utf8')

/* ---------- HTML：应落沙箱渲染，且 ⋮ 里有「看源码」 ---------- */

writeFileSync(join(DIR, '归档页面.html'), `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>批 1 fixture</title></head>
<body>
  <h1>归档页面</h1>
  <p>改前：只能沙箱渲染。改后：⋮ →「看源码」可切到源码编辑。</p>
</body>
</html>
`, 'utf8')

/* ---------- 图片：批 3 之前应落元信息卡 ---------- */
/* 1×1 的合法 PNG（base64 内嵌，避免依赖任何图像库）；批 3 要验渲染时再换成有内容的图 */
writeFileSync(join(DIR, '示意图.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
))

/* ---------- 二进制：应落元信息卡 ---------- */
writeFileSync(join(DIR, '资料包.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]))

/* ---------- PDF：散落在正文区（关键 —— .books 下那份索引看不到） ---------- */
const bookPdf = join(FIXTURE, '.books', 'Reader Sample (light).pdf')
if (existsSync(bookPdf)) {
  copyFileSync(bookPdf, join(DIR, '论文.pdf'))
  log(`PDF 已从 .books 复制到正文区：批1探针/论文.pdf（${Math.round(statSync(bookPdf).size / 1024)} KB）`)
} else {
  log('⚠ 没找到 .books/Reader Sample (light).pdf —— 请手工把任意一个真实 PDF 放到：')
  log('   ' + join(DIR, '论文.pdf'))
  log('   （或先跑 seed-probe-vault.mjs --add-books 生成它，再重跑本脚本）')
}

/* ---------- 大文件（可选）：验两条降级路径 ---------- */
if (WITH_BIG) {
  const line = '[2026-10-12 09:41:02] INFO  batch1 fixture filler line for the 10MB threshold test\n'
  const times = Math.ceil((11 * 1024 * 1024) / Buffer.byteLength(line))
  writeFileSync(join(DIR, '大日志.log'), line.repeat(times), 'utf8')
  log('大日志.log 已造（约 11 MB）—— 应落「只读 + 提示条」（>10MB，editable:false）')

  writeFileSync(join(DIR, '超大.bin'), Buffer.alloc(52 * 1024 * 1024, 0x00))
  log('超大.bin 已造（52 MB）—— 应落元信息卡（>50MB，truncated:true，不读内容）')
} else {
  log('（跳过大文件；要验 >10MB / >50MB 两条降级路径请加 --with-big）')
}

log('')
log('fixture 就绪：' + DIR)
log('文件清单：')
for (const n of ['脚本.py', '说明.txt', '数据.csv', '配置.json', '归档页面.html', '示意图.png', '资料包.zip']) {
  const p = join(DIR, n)
  if (existsSync(p)) log(`  · ${n}  (${statSync(p).size} B)`)
}
if (existsSync(join(DIR, '论文.pdf'))) log('  · 论文.pdf')
if (existsSync(join(DIR, '大日志.log'))) log('  · 大日志.log')
if (existsSync(join(DIR, '超大.bin'))) log('  · 超大.bin')
