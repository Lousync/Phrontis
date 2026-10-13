/**
 * 设置 → 快捷键「指令表」。
 *
 * ★ 2026-10-13 逐行对账（这是本表第一次与代码实际判定对齐，来源见每组的来源锚）：
 *   对账前本表有 8 处与代码不符，逐条修掉并留下判据，别再改回去：
 *   ① `Ctrl+P` 被归在「知识库 — 阅读」叫「知识库快速搜索」——`App.tsx:304` 是**全局**拦截，
 *      与模块无关；帮助手册一直把它记在「全局」（手册是对的，表是错的）→ 已归位并与
 *      `Ctrl` + 反引号、`Ctrl+Shift+F` 合成一行（三者同效，都指向左栏搜索态）。
 *   ② `Ctrl` + 反引号 原写「全局搜索底部面板（仅 Workbench 布局）」——顶栏搜索框删除那一轮
 *      改成左栏搜索态后，**「底部面板」这个东西已经不存在了**，描述过期 → 已改。
 *   ③ `Ctrl+Shift+F` 代码里存在（`App.tsx:309`）但表里**整条缺失** → 已随 ① 一并补齐。
 *   ④ 「编辑器模块」整组失效：模块已于 2026-09-20 阶段四**物理退役**
 *      （`.AGENT/scripts/notes-merge/verify-notes-inline-edit.mjs` 有断言锁 `src/modules/editor` 不存在）。
 *      组内核验结果：
 *        · `Ctrl+S` 保存当前文件 —— 模块没了，与知识库的「立即保存」重复 → 删
 *        · `Ctrl+Shift+S` 保存全部打开文件 —— 全仓**没有任何处理**（grep 仅命中两张表和
 *          `sections.tsx` 的 keywords），是条死键 → 删
 *        · `Alt+A` —— 实际是**笔记编辑态**的内联建议手动触发（`PageEditor.tsx:623`）→ 移入「知识库 — 编辑器」
 *        · `Ctrl+F` / `PageDown` / `PageUp` —— 实际都是 **PDF 阅读器**的（`PdfReaderView.tsx:1193-1199`）
 *          → 独立成「PDF 阅读器」组；`Ctrl+F` 不再是「PDF 阅读器内搜索」这种挂在编辑器名下的写法
 *   ⑤ 密码本 `Ctrl+Alt+P` 原写「可在设置改键」——`src/lib/settings.ts`（设置唯一真源）里
 *      **没有这个设置项**，`electron/main/passwordFiller.ts:143` 是直接读 `settings.json` 的裸键
 *      `fillPopupShortcut`。也就是说「可改键」这个功能不存在，只能手改 JSON → 已删该表述
 *      （**变成真的可改键**是另一件事，属新功能，未做）。
 *   ⑥ `Ctrl` `/` 只写了 Markdown 预览，漏了同效的 `Ctrl+E`（`PageEditor.tsx:852` 同一分支）→ 已补。
 *   ⑦ 全局缺 `Ctrl+Shift+J`（AI 全屏学堂）/ `Ctrl+Alt+B`（切工作台右栏）/ `Ctrl+Z`·`Ctrl+Shift+Z`·`Ctrl+Y`
 *      （文件操作撤销重做）→ **未补**，属「漏登记」而非「写错了」，随 L1 真源化一并处理。
 *   ⑧ 博客里 `Ctrl+O` 另有一处绑定（`blog/index.tsx:315` 切换大纲），与全局快速打开同键
 *      → **未改**，改键属用户可见行为变更，待拍板。
 *
 * 来源锚（对账时按这些文件核）：
 *   全局 = `src/App.tsx:298-318`（面板/搜索/快速打开）、`:1322`（Ctrl+B）、`:1413-1422`（Ctrl+J）、
 *          `:1302-1311`（缩放）、`electron/main/dayPanelWindow.ts:436-438`（Ctrl+Alt+S 等系统级）
 *   知识库 = `src/modules/knowledge/index.tsx:1553-1666`、`components/PageEditor.tsx:623/842/852/992/997`
 *   PDF = `src/components/shared/pdf/PdfReaderView.tsx:1190-1199`
 *   博客 = `src/modules/blog/index.tsx:218-237`、`components/MarkdownEditor.tsx:217-219`
 *   日程 = `src/modules/schedule/index.tsx:628`
 *   密码本 = `electron/main/passwordFiller.ts:143`
 */
export function ShortcutsView() {
  return (
    <div>
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">快捷键</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-6">所有可用的键盘快捷键一览</p>

      <div className="space-y-8">
        <Group anchor="shortcuts.global" label="全局">
          <Row keys={['Ctrl', 'B']} desc="展开 / 折叠侧栏" />
          <Row keys={['Escape']} desc="关闭弹窗 / 返回列表" />
          <Row keys={['Ctrl', 'Shift', 'P']} desc="命令面板" />
          <Row keys={['Ctrl', 'O']} desc="快速打开文件（按标题 / 路径搜仓库页面）" />
          {/* 三个键同效（App.tsx:304 与 :309 同一去向）：左栏搜索态。原表把这仨拆散了，且 Ctrl+P 错挂在知识库下 */}
          <Row alts={[['Ctrl', 'P'], ['Ctrl', '`'], ['Ctrl', 'Shift', 'F']]}
            desc="全局搜索（左栏搜索态：标题、正文、目录、标签）" />
          <Row keys={['Ctrl', '=']} desc="界面放大" />
          <Row keys={['Ctrl', '-']} desc="界面缩小" />
          <Row keys={['Ctrl', 'J']} desc="AI 助手开关（工作台右栏；整窗模块下为悬浮助手）" />
          <Row keys={['Ctrl', 'Alt', 'S']} desc="日程与打卡小窗开关（系统级）" />
        </Group>

        <Group anchor="shortcuts.kbEditor" label="知识库 — 编辑器">
          <Row keys={['Ctrl', 'S']} desc="立即保存当前页面" />
          <Row alts={[['Ctrl', '/'], ['Ctrl', 'E']]} desc="阅读 ⇄ 编辑切换（仅 md / txt 文件）" />
          <Row keys={['Escape']} desc="关闭弹窗后返回页面列表" />
          {/* 2026-10-11 笔记区顶栏改造的配套快捷键（拍板 D2 页面历史 / E2 插图脚注的键盘补偿） */}
          <Row keys={['Alt', '←']} desc="页面历史：后退（笔记区顶栏最左那颗箭头）" />
          <Row keys={['Alt', '→']} desc="页面历史：前进" />
          {/* Alt+A 原挂在已退役的「编辑器模块」组下；实际判定在 PageEditor.tsx:623（知识库编辑态） */}
          <Row keys={['Alt', 'A']} desc="AI 内联续写建议：立即要一条（Tab 采纳 / Esc 拒绝；平时停顿会自动出）" />
          <Row keys={['Ctrl', 'Shift', 'I']} desc="插入图片（顶栏 ⋮ 里也有）" />
          <Row keys={['Ctrl', 'Alt', 'F']} desc="插入脚注（先选中词语；顶栏 ⋮ 里也有）" />
        </Group>

        <Group anchor="shortcuts.kbSidebar" label="知识库 — 侧栏">
          <Row keys={['F2']} desc="重命名选中的目录 / 笔记本 / 章节" />
          <Row keys={['Delete']} desc="删除选中的目录 / 笔记本 / 章节" />
          <Row keys={['Ctrl', 'C']} desc="复制选中的页面 / 目录到内部剪贴板（非输入框时）" />
          <Row keys={['Ctrl', 'X']} desc="剪切选中的页面 / 目录（非输入框时）" />
          <Row keys={['Ctrl', 'V']} desc="粘贴内部剪贴板到选中目标（非输入框时）" />
        </Group>

        <Group anchor="shortcuts.kbTabs" label="知识库 — Tab 管理">
          <Row keys={['Ctrl', 'N']} desc="新建知识页（文件树内联命名，落点跟随选中目录）" />
          <Row keys={['Ctrl', 'W']} desc="关闭当前打开的 Tab 页" />
          <Row keys={['Ctrl', 'Tab']} desc="切换到下一个 Tab" />
          <Row keys={['Ctrl', 'Shift', 'Tab']} desc="切换到上一个 Tab" />
        </Group>

        <Group anchor="shortcuts.kbReading" label="知识库 — 阅读">
          <Row keys={['Ctrl', 'Shift', 'R']} desc="沉浸阅读进出" />
          <Row keys={['Escape']} desc="沉浸阅读退出" />
        </Group>

        {/* 原「编辑器模块」组：模块 2026-09-20 已物理退役，组内只剩 PDF 三行是真的，故改组为 PDF 阅读器 */}
        <Group anchor="shortcuts.pdfKeys" label="PDF 阅读器">
          <Row keys={['Ctrl', 'F']} desc="PDF 阅读器内搜索" />
          <Row alts={[['PageDown'], ['空格']]} desc="PDF 下一页" />
          <Row keys={['PageUp']} desc="PDF 上一页" />
        </Group>

        <Group anchor="shortcuts.blogKeys" label="博客">
          <Row keys={['Ctrl', 'N']} desc="新建 / 打开今日文章" />
          <Row keys={['Ctrl', 'S']} desc="保存并关闭编辑器" />
          <Row keys={['Ctrl', '/']} desc="切换 Markdown 预览" />
          {/* 2026-10-13 改键：原 Ctrl+O 与全局「快速打开文件」撞车（两条 window 监听都会跑） */}
          <Row keys={['Ctrl', 'Alt', 'O']} desc="切换大纲（编辑器 / 详情态）" />
          <Row keys={['Escape']} desc="从编辑器 / 详情返回列表" />
          <Row keys={['Delete']} desc="删除当前查看的文章" />
        </Group>

        <Group anchor="shortcuts.scheduleKeys" label="日程">
          <Row keys={['Ctrl', 'N']} desc="打开新建任务弹窗" />
          <Row keys={['Escape']} desc="关闭弹窗（编辑 / 四象限 / 标签管理）" />
          <Row keys={['Ctrl', 'Alt', 'Up']} desc="日程侧栏置顶停靠（系统级）" />
          <Row keys={['Ctrl', 'Alt', 'Down']} desc="日程侧栏切为桌面小组件（系统级）" />
        </Group>

        <Group anchor="shortcuts.passwordKeys" label="密码本">
          {/* 原写「可在设置改键」——设置里没有这个项（settings.ts 无 fillPopupShortcut），只能手改 settings.json */}
          <Row keys={['Ctrl', 'Alt', 'P']} desc="密码填充弹窗开关（系统级）" />
        </Group>
      </div>
    </div>
  )
}

function Group({ anchor, label, children }: { anchor: string; label: string; children: React.ReactNode }) {
  return (
    <div data-setting-anchor={anchor}>
      <h3 className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
        {label}
      </h3>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

/**
 * 一行快捷键。
 * - `keys`  = 一个组合键，逐枚键帽渲染
 * - `alts`  = 多组同效组合键，组间用 `/` 分隔（如 `Ctrl+P` / `Ctrl` + 反引号 / `Ctrl+Shift+F`）
 *   没有这个参数时，三个同效键会挤成七枚键帽、读不出「三选一」的意思。
 */
function Row({ keys, alts, desc }: { keys?: string[]; alts?: string[][]; desc: string }) {
  const groups = alts ?? (keys ? [keys] : [])
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[13px] text-[var(--text-primary)]">{desc}</span>
      <div className="flex items-center gap-1 shrink-0">
        {groups.map((g, gi) => (
          <span key={gi} className="flex items-center gap-1">
            {gi > 0 && <span className="px-0.5 text-[10px] text-[var(--text-disabled)]">/</span>}
            {g.map((k, i) => (
              <span
                key={i}
                className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[var(--text-secondary)] min-w-[20px] justify-center"
              >
                {k}
              </span>
            ))}
          </span>
        ))}
      </div>
    </div>
  )
}
