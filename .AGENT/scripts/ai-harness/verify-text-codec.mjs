// 契约脚本：文本编码 / 换行保真（P0-A §3.2 / v3.31.0）
// 覆盖：BOM 检测、严格 UTF-8、UTF-16LE/BE、GBK 读写策略、CRLF 保真、.bat 强制 CRLF。
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: C, dir } = await loadTsModule(join(ROOT, 'electron/lib/textFileCodecPure.ts'))

const utf8 = (s) => new TextEncoder().encode(s)
const u16le = (s, bom = true) => {
  const body = Buffer.from(s, 'utf16le')
  return new Uint8Array(bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body)
}

// ── ① 探测 ─────────────────────────────────────────────────────────────────────
ok('纯 ASCII 判 utf-8', C.detectEncoding(utf8('hello')) === 'utf-8')
ok('UTF-8 BOM 识别', C.detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])) === 'utf-8-bom')
ok('UTF-16LE BOM 识别', C.detectEncoding(new Uint8Array([0xff, 0xfe, 0x61, 0x00])) === 'utf-16le')
ok('UTF-16BE BOM 识别', C.detectEncoding(new Uint8Array([0xfe, 0xff, 0x00, 0x61])) === 'utf-16be')
ok('NUL 判二进制', C.detectEncoding(new Uint8Array([0x61, 0x00, 0x62])) === 'binary')
ok('非法 UTF-8 判 unknown', C.detectEncoding(new Uint8Array([0xd6, 0xd0])) === 'unknown')

// ── ② 解码 ─────────────────────────────────────────────────────────────────────
const bomFile = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('你好\r\nworld\r\n')])
const d1 = C.decodeTextFile(bomFile)
ok('UTF-8 BOM 解码保留 bom 标记', d1.ok && d1.bom === true && d1.encoding === 'utf-8')
ok('解码文本不含 BOM 字符', d1.ok && d1.text === '你好\r\nworld\r\n')
ok('CRLF 文件 EOL 判定为 \\r\\n', d1.ok && d1.eol === '\r\n')

const d2 = C.decodeTextFile(u16le('嗨\n第二行'))
ok('UTF-16LE 自动解码', d2.ok && d2.encoding === 'utf-16le' && d2.text === '嗨\n第二行')

const be = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])
const d3 = C.decodeTextFile(be)
ok('UTF-16BE 自动解码', d3.ok && d3.encoding === 'utf-16be' && d3.text === 'hi')

const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
const d4 = C.decodeTextFile(gbkBytes)
ok('GBK 未显式指定 → 拒绝（不猜编码）', d4.ok === false && /encoding/.test(d4.error))
const d5 = C.decodeTextFile(gbkBytes, { encoding: 'gbk' })
ok('GBK 显式指定 → 解码成功', d5.ok && d5.text === '中文' && d5.encoding === 'gbk')

// ── ③ 编码写回 ─────────────────────────────────────────────────────────────────
const e1 = C.encodeTextFile('a\nb\n', { encoding: 'utf-8', bom: false, eol: '\r\n' })
ok('LF → CRLF 归一', e1.ok && Buffer.from(e1.buffer).toString('utf8') === 'a\r\nb\r\n')
const e2 = C.encodeTextFile('x\r\ny', { encoding: 'utf-8', eol: '\r\n' })
ok('已是 CRLF 不重复膨胀（CRCRLF 防线）', e2.ok && Buffer.from(e2.buffer).toString('utf8') === 'x\r\ny')
const e3 = C.encodeTextFile('.bat 内容', { encoding: 'utf-8', relPath: 'run.bat', eol: '\n' })
ok('.bat 强制 CRLF（无视传入 eol）', e3.ok && e3.eol === '\r\n')
const e4 = C.encodeTextFile('a', { encoding: 'utf-8', bom: true })
ok('写回带 BOM', e4.ok && e4.buffer[0] === 0xef && e4.buffer[1] === 0xbb && e4.buffer[2] === 0xbf)
const e5 = C.encodeTextFile('hi', { encoding: 'utf-16le' })
ok('UTF-16LE 写回带 BOM', e5.ok && e5.buffer[0] === 0xff && e5.buffer[1] === 0xfe)
ok('UTF-16LE 字节序正确', Buffer.from(e5.buffer.subarray(2)).toString('utf16le') === 'hi')
const e6 = C.encodeTextFile('hi', { encoding: 'utf-16be' })
ok('UTF-16BE 写回字节序正确', e6.ok && Array.from(e6.buffer.subarray(2)).join(',') === '0,104,0,105')
const e7 = C.encodeTextFile('中文', { encoding: 'gbk' })
ok('GBK 写入明确拒绝（不做有损转码）', e7.ok === false && /GBK/.test(e7.error))

// ── ③b 缺省 eol：不能被静默改写（编辑器 / 插件写入同一出口）──────────────────────
const e8 = C.encodeTextFile('a\r\nb\r\n', { encoding: 'utf-8' })
ok('未指定 eol 时保留 CRLF（不静默转 LF）', e8.ok && Buffer.from(e8.buffer).toString('utf8') === 'a\r\nb\r\n')
const e9 = C.encodeTextFile('a\nb\n', { encoding: 'utf-8' })
ok('未指定 eol 时保留 LF', e9.ok && Buffer.from(e9.buffer).toString('utf8') === 'a\nb\n')

// ── ④ 往返一致 ─────────────────────────────────────────────────────────────────
const round = '第一行\r\n第二行\r\n'
const enc = C.encodeTextFile(round, { encoding: 'utf-8', bom: false, eol: '\r\n' })
const dec = C.decodeTextFile(enc.buffer)
ok('UTF-8 CRLF 往返一致', dec.ok && dec.text === round && dec.bom === false)

rmSync(dir, { recursive: true, force: true })
report('verify-text-codec')
