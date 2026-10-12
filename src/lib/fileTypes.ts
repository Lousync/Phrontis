// 文件类型 → 展示信息
export interface FileTypeInfo {
  ext: string
  label: string      // "C++"
  badge: string      // "CPP"
  icon: string       // "code" | "file" | "text" — which lucide icon to use
  color: string      // tailwind-like "var(--accent)"
  placeholder: string // Monaco placeholder
  monacoLang: string  // Monaco language ID
}

const INFO: Record<string, FileTypeInfo> = {
  '':   { ext: '',   label: 'Markdown',  badge: 'MD',   icon: 'file',     color: 'var(--accent)',        placeholder: '开始写 Markdown... 使用 [[页面名]] 创建链接', monacoLang: 'markdown' },
  'md': { ext: 'md', label: 'Markdown',  badge: 'MD',   icon: 'file',     color: 'var(--accent)',        placeholder: '开始写 Markdown... 使用 [[页面名]] 创建链接', monacoLang: 'markdown' },
  'txt':{ ext: 'txt',label: '纯文本',     badge: 'TXT',  icon: 'text',     color: 'var(--text-muted)',     placeholder: '开始编写...',                       monacoLang: 'plaintext' },
  'pdf':{ ext: 'pdf',label: 'PDF',        badge: 'PDF',  icon: 'file',     color: '#e74c3c',               placeholder: 'PDF 阅读器',                      monacoLang: 'plaintext' },
  'cpp':{ ext: 'cpp',label: 'C++',        badge: 'CPP',  icon: 'code',     color: 'var(--warning)',        placeholder: '开始写 C++ 代码...',               monacoLang: 'cpp' },
  'c':  { ext: 'c',  label: 'C',          badge: 'C',    icon: 'code',     color: 'var(--warning)',        placeholder: '开始写 C 代码...',                 monacoLang: 'c' },
  'h':  { ext: 'h',  label: 'C/C++ 头文件', badge: 'H',    icon: 'code',     color: 'var(--warning)',        placeholder: '开始写 C/C++ 头文件...',           monacoLang: 'c' },
  'hpp':{ ext: 'hpp',label: 'C++ Header', badge: 'HPP',  icon: 'code',     color: 'var(--warning)',        placeholder: '开始写 C++ 头文件...',             monacoLang: 'cpp' },
  'py': { ext: 'py', label: 'Python',     badge: 'PY',   icon: 'code',     color: 'var(--success)',        placeholder: '开始写 Python 代码...',            monacoLang: 'python' },
  'js': { ext: 'js', label: 'JavaScript', badge: 'JS',   icon: 'code',     color: '#f0db4f',              placeholder: '开始写 JavaScript 代码...',       monacoLang: 'javascript' },
  'jsx':{ ext: 'jsx',label: 'React JSX',  badge: 'JSX',  icon: 'code',     color: '#61dafb',              placeholder: '开始写 React JSX...',              monacoLang: 'javascript' },
  'ts': { ext: 'ts', label: 'TypeScript', badge: 'TS',   icon: 'code',     color: '#3178c6',              placeholder: '开始写 TypeScript 代码...',        monacoLang: 'typescript' },
  'tsx':{ ext: 'tsx',label: 'React TSX',  badge: 'TSX',  icon: 'code',     color: '#3178c6',              placeholder: '开始写 React TSX...',              monacoLang: 'typescript' },
  'json':{ext: 'json',label: 'JSON',      badge: 'JSON', icon: 'data',     color: 'var(--warning)',        placeholder: '开始编辑 JSON...',                 monacoLang: 'json' },
  'html':{ext: 'html',label: 'HTML',      badge: 'HTML', icon: 'web',      color: '#e34c26',              placeholder: '开始写 HTML...',                  monacoLang: 'html' },
  'css':{ ext: 'css', label: 'CSS',       badge: 'CSS',  icon: 'web',      color: '#264de4',              placeholder: '开始写 CSS...',                   monacoLang: 'css' },
  'java':{ext: 'java',label: 'Java',      badge: 'JAVA', icon: 'code',     color: '#b07219',              placeholder: '开始写 Java 代码...',             monacoLang: 'java' },
  'rs': { ext: 'rs', label: 'Rust',       badge: 'RS',   icon: 'code',     color: '#dea584',              placeholder: '开始写 Rust 代码...',             monacoLang: 'rust' },
  'go': { ext: 'go', label: 'Go',         badge: 'GO',   icon: 'code',     color: '#00add8',              placeholder: '开始写 Go 代码...',               monacoLang: 'go' },
  'sh': { ext: 'sh', label: 'Shell',      badge: 'SH',   icon: 'terminal', color: 'var(--text-secondary)', placeholder: '开始写 Shell 脚本...',            monacoLang: 'shell' },
  'bat':{ ext: 'bat',label: 'Batch',      badge: 'BAT',  icon: 'terminal', color: 'var(--text-secondary)', placeholder: '开始写 Batch 脚本...',            monacoLang: 'bat' },
  'sql':{ ext: 'sql', label: 'SQL',       badge: 'SQL',  icon: 'data',     color: 'var(--accent)',        placeholder: '开始写 SQL...',                   monacoLang: 'sql' },
  'xml':{ ext: 'xml', label: 'XML',       badge: 'XML',  icon: 'data',     color: 'var(--warning)',        placeholder: '开始编辑 XML...',                  monacoLang: 'xml' },
  'yaml':{ext: 'yaml',label: 'YAML',      badge: 'YAML', icon: 'data',     color: 'var(--danger)',         placeholder: '开始编辑 YAML...',                 monacoLang: 'yaml' },
  'yml':{ ext: 'yml', label: 'YAML',      badge: 'YML',  icon: 'data',     color: 'var(--danger)',         placeholder: '开始编辑 YAML...',                 monacoLang: 'yaml' },
  'r':  { ext: 'r',  label: 'R',          badge: 'R',    icon: 'code',     color: '#276dc3',              placeholder: '开始写 R 代码...',                monacoLang: 'r' },
  'rb': { ext: 'rb', label: 'Ruby',       badge: 'RB',   icon: 'code',     color: '#cc342d',              placeholder: '开始写 Ruby 代码...',             monacoLang: 'ruby' },
  'php':{ ext: 'php',label: 'PHP',        badge: 'PHP',  icon: 'code',     color: '#777bb3',              placeholder: '开始写 PHP 代码...',              monacoLang: 'php' },
  'lua':{ ext: 'lua',label: 'Lua',        badge: 'LUA',  icon: 'code',     color: '#000080',              placeholder: '开始写 Lua 代码...',              monacoLang: 'lua' },
  /* ---- 以下于 2026-10-12 补齐（批 1「文本类文件可编辑」）----
     动机：这些扩展名原先没有条目 ⇒ `getFileTypeInfo` 走兜底 `monacoLang: 'markdown'`，
     于是一个 `.csv` / `.log` 在 Monaco 里按 Markdown 高亮（错得很难看）。
     ★ 只补 `INFO`（展示 + 高亮），**不补 `FILE_LANG_OPTIONS`** ——
     那份是「转换文件格式」菜单（把 .md 改成 .py 之类），往里加 csv/log 是没有语义的。
     语言 id 一律取 Monaco 内建 basic-languages 里确实存在的那个。 */
  'cc': { ext:'cc', label:'C++ 源文件', badge:'CC',   icon:'code',     color:'var(--warning)',        placeholder:'开始写 C++ 代码...',    monacoLang:'cpp' },
  'cs': { ext:'cs', label:'C#',        badge:'CS',   icon:'code',     color:'#178600',               placeholder:'开始写 C# 代码...',     monacoLang:'csharp' },
  'swift':{ext:'swift',label:'Swift',  badge:'SWIFT',icon:'code',     color:'#f05138',               placeholder:'开始写 Swift 代码...',  monacoLang:'swift' },
  'kt': { ext:'kt', label:'Kotlin',    badge:'KT',   icon:'code',     color:'#a97bff',               placeholder:'开始写 Kotlin 代码...', monacoLang:'kotlin' },
  'ps1':{ ext:'ps1',label:'PowerShell',badge:'PS1',  icon:'terminal', color:'var(--text-secondary)', placeholder:'开始写 PowerShell 脚本...', monacoLang:'powershell' },
  'vue':{ ext:'vue',label:'Vue',       badge:'VUE',  icon:'web',      color:'#41b883',               placeholder:'开始写 Vue 单文件组件...', monacoLang:'html' },
  'scss':{ext:'scss',label:'SCSS',     badge:'SCSS', icon:'web',      color:'#c6538c',               placeholder:'开始写 SCSS...',        monacoLang:'scss' },
  'toml':{ext:'toml',label:'TOML',     badge:'TOML', icon:'data',     color:'var(--warning)',        placeholder:'开始编辑 TOML...',      monacoLang:'ini' },
  'ini':{ ext:'ini',label:'INI',       badge:'INI',  icon:'data',     color:'var(--text-muted)',     placeholder:'开始编辑 INI...',       monacoLang:'ini' },
  'cfg':{ ext:'cfg',label:'配置',       badge:'CFG',  icon:'data',     color:'var(--text-muted)',     placeholder:'开始编辑配置...',       monacoLang:'ini' },
  'conf':{ext:'conf',label:'配置',      badge:'CONF', icon:'data',     color:'var(--text-muted)',     placeholder:'开始编辑配置...',       monacoLang:'ini' },
  'csv':{ ext:'csv',label:'CSV',       badge:'CSV',  icon:'data',     color:'var(--success)',        placeholder:'开始编辑 CSV...',       monacoLang:'plaintext' },
  'tsv':{ ext:'tsv',label:'TSV',       badge:'TSV',  icon:'data',     color:'var(--success)',        placeholder:'开始编辑 TSV...',       monacoLang:'plaintext' },
  'log':{ ext:'log',label:'日志',       badge:'LOG',  icon:'text',     color:'var(--text-muted)',     placeholder:'日志文件',              monacoLang:'plaintext' },
  'text':{ext:'text',label:'纯文本',     badge:'TEXT', icon:'text',     color:'var(--text-muted)',     placeholder:'开始编写...',           monacoLang:'plaintext' },
  'markdown':{ext:'markdown',label:'Markdown',badge:'MD',icon:'file',color:'var(--accent)',        placeholder:'开始写 Markdown...',    monacoLang:'markdown' },
  'xmind':{ext:'xmind',label:'XMind 思维导图',badge:'XMind',icon: 'file', color: '#f86a5c',             placeholder: 'XMind 思维导图 — 外部应用打开',  monacoLang: 'plaintext' },
  /* ---- 以下于 2026-10-13 补齐（批 3「图片渲染与查看」）----
     动机：这批之前 `INFO` 里**一个图片条目都没有** ⇒ 图片走兜底：
     `label` 等于大写扩展名、badge 与色块都是灰的、`monacoLang` 是 plaintext。
     图片本身现在有了查看器，元信息卡与「过大 / 解码失败」卡都要用这里的 label / color。
     ★ 只补 `INFO`，**不补 `FILE_LANG_OPTIONS`** —— 那份是「转换文件格式」菜单
     （把 .md 改成 .py 之类），把 .md 改成 .png 是没有语义的（同批 1 补 csv/log 的取舍）。
     `monacoLang` 对图片无意义（永远不进 Monaco），给 plaintext；
     唯一的例外是 svg —— 它的源码态要落 Monaco，给 xml 才有高亮。 */
  'png': { ext:'png',  label:'PNG 图片',  badge:'PNG',  icon:'file', color:'#4a9eff', placeholder:'PNG 图片',  monacoLang:'plaintext' },
  'jpg': { ext:'jpg',  label:'JPEG 图片', badge:'JPG',  icon:'file', color:'#f0932b', placeholder:'JPEG 图片', monacoLang:'plaintext' },
  'jpeg':{ ext:'jpeg', label:'JPEG 图片', badge:'JPG',  icon:'file', color:'#f0932b', placeholder:'JPEG 图片', monacoLang:'plaintext' },
  'gif': { ext:'gif',  label:'GIF 动图',  badge:'GIF',  icon:'file', color:'#a55eea', placeholder:'GIF 动图',  monacoLang:'plaintext' },
  'webp':{ ext:'webp', label:'WebP 图片', badge:'WEBP', icon:'file', color:'#26de81', placeholder:'WebP 图片', monacoLang:'plaintext' },
  'bmp': { ext:'bmp',  label:'BMP 位图',  badge:'BMP',  icon:'file', color:'#8395a7', placeholder:'BMP 位图',  monacoLang:'plaintext' },
  'avif':{ ext:'avif', label:'AVIF 图片', badge:'AVIF', icon:'file', color:'#45aaf2', placeholder:'AVIF 图片', monacoLang:'plaintext' },
  'svg': { ext:'svg',  label:'SVG 矢量图',badge:'SVG',  icon:'file', color:'#ff9f43', placeholder:'SVG 矢量图', monacoLang:'xml' },
}

export function getFileTypeInfo(ext: string): FileTypeInfo {
  const key = ext.replace(/^\./, '').toLowerCase()
  // 兜底 `monacoLang` 由 'markdown' 改成 'plaintext'（2026-10-12）：未知扩展名按 Markdown 高亮
  // 是纯粹的误导（`.dat` / `.bak` 会被上标题目录、加粗等规则染色）。plaintext 至少不撒谎。
  return INFO[key] || { ext: key, label: key || 'Markdown', badge: (key || 'MD').toUpperCase(), icon: 'file', color: 'var(--text-muted)', placeholder: '开始编辑...', monacoLang: 'plaintext' }
}

export const FILE_LANG_OPTIONS = [
  { ext: '',  label: 'Markdown' },
  { ext: 'txt', label: '纯文本' },
  { ext: 'cpp', label: 'C++' },
  { ext: 'c',   label: 'C' },
  { ext: 'h',   label: 'C/C++ 头文件' },
  { ext: 'py',  label: 'Python' },
  { ext: 'js',  label: 'JavaScript' },
  { ext: 'ts',  label: 'TypeScript' },
  { ext: 'json', label: 'JSON' },
  { ext: 'html', label: 'HTML' },
  { ext: 'css',  label: 'CSS' },
  { ext: 'java', label: 'Java' },
  { ext: 'rs',   label: 'Rust' },
  { ext: 'go',   label: 'Go' },
  { ext: 'sh',   label: 'Shell' },
  { ext: 'sql',  label: 'SQL' },
  { ext: 'xml',  label: 'XML' },
  { ext: 'yaml', label: 'YAML' },
]
