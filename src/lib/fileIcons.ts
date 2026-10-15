/**
 * vscode-icons file type icons — CC BY 4.0
 * Source: https://github.com/vscode-icons/vscode-icons
 */
import defaultSvg from '../assets/default.svg?raw'
import mdSvg from '../assets/md.svg?raw'
import txtSvg from '../assets/txt.svg?raw'
import pdfSvg from '../assets/pdf.svg?raw'
import cppSvg from '../assets/cpp.svg?raw'
import cSvg from '../assets/c.svg?raw'
import hSvg from '../assets/h.svg?raw'
import hppSvg from '../assets/hpp.svg?raw'
import pySvg from '../assets/py.svg?raw'
import jsSvg from '../assets/js.svg?raw'
import jsxSvg from '../assets/jsx.svg?raw'
import tsSvg from '../assets/ts.svg?raw'
import tsxSvg from '../assets/tsx.svg?raw'
import jsonSvg from '../assets/json.svg?raw'
import htmlSvg from '../assets/html.svg?raw'
import cssSvg from '../assets/css.svg?raw'
import javaSvg from '../assets/java.svg?raw'
import rsSvg from '../assets/rs.svg?raw'
import goSvg from '../assets/go.svg?raw'
import shSvg from '../assets/sh.svg?raw'
import batSvg from '../assets/bat.svg?raw'
import sqlSvg from '../assets/sql.svg?raw'
import xmlSvg from '../assets/xml.svg?raw'
import yamlSvg from '../assets/yaml.svg?raw'
import rSvg from '../assets/r.svg?raw'
import rbSvg from '../assets/rb.svg?raw'
import phpSvg from '../assets/php.svg?raw'
import luaSvg from '../assets/lua.svg?raw'
// 图片（批 3，2026-10-13）：这批之前**一个图片图标都没有** ⇒ 文件树里每张图都显示通用文件图标，
// 而那正是用户看到的第一眼。八种可渲染格式共用一个图标（按格式各画一个的收益远小于成本）。
import imageSvg from '../assets/image.svg?raw'

export const FILE_ICONS: Record<string, string> = {
  '': mdSvg,   // empty = Markdown (manually created pages)
  md: mdSvg,
  txt: txtSvg,
  pdf: pdfSvg,
  cpp: cppSvg,
  c: cSvg,
  h: hSvg,
  hpp: hppSvg,
  py: pySvg,
  js: jsSvg,
  jsx: jsxSvg,
  ts: tsSvg,
  tsx: tsxSvg,
  json: jsonSvg,
  html: htmlSvg,
  css: cssSvg,
  java: javaSvg,
  rs: rsSvg,
  go: goSvg,
  sh: shSvg,
  bat: batSvg,
  sql: sqlSvg,
  xml: xmlSvg,
  yaml: yamlSvg,
  yml: yamlSvg,
  r: rSvg,
  rb: rbSvg,
  php: phpSvg,
  lua: luaSvg,
  // 图片（批 3）：与 src/lib/imageFormats.ts 的 IMAGE_RENDER_EXTS 一一对应 ——
  // 那份是「能渲染哪些」，这份是「文件树里画哪个图标」，两处必须同步扩。
  png: imageSvg,
  jpg: imageSvg,
  jpeg: imageSvg,
  gif: imageSvg,
  webp: imageSvg,
  bmp: imageSvg,
  avif: imageSvg,
  svg: imageSvg,
}

export function getFileIcon(ext: string): string {
  const key = ext.replace(/^\./, '').toLowerCase()
  return FILE_ICONS[key] || defaultSvg
}
