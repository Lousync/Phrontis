export function ShortcutsView() {
  return (
    <div>
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">快捷键</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-6">所有可用的键盘快捷键一览</p>

      <div className="space-y-8">
        <Group anchor="shortcuts.global" label="全局">
          <Row keys={['Ctrl', 'B']} desc="展开 / 折叠侧栏" />
          <Row keys={['Escape']} desc="关闭弹窗 / 从编辑器返回列表" />
          <Row keys={['Ctrl', 'Shift', 'P']} desc="命令面板" />
          <Row keys={['Ctrl', 'O']} desc="快速打开 / 切换文件（知识页索引）" />
          <Row keys={['Ctrl', '`']} desc="全局搜索底部面板（仅 Workbench 布局）" />
          <Row keys={['Ctrl', '=']} desc="界面放大" />
          <Row keys={['Ctrl', '-']} desc="界面缩小" />
          <Row keys={['Ctrl', 'J']} desc="AI 助手面板开关" />
          <Row keys={['Ctrl', 'Alt', 'S']} desc="日程与打卡侧栏开关（系统级）" />
        </Group>

        <Group anchor="shortcuts.kbEditor" label="知识库 — 编辑器">
          <Row keys={['Ctrl', 'S']} desc="立即保存当前页面" />
          <Row keys={['Ctrl', '/']} desc="切换 Markdown 预览（仅 md / txt 文件）" />
          <Row keys={['Escape']} desc="关闭弹窗后返回页面列表" />
        </Group>

        <Group anchor="shortcuts.kbSidebar" label="知识库 — 侧栏">
          <Row keys={['F2']} desc="重命名选中的目录 / 笔记本 / 章节" />
          <Row keys={['Delete']} desc="删除选中的目录 / 笔记本 / 章节" />
          <Row keys={['Ctrl', 'C']} desc="复制选中的页面 / 目录到内部剪贴板（非输入框时）" />
          <Row keys={['Ctrl', 'X']} desc="剪切选中的页面 / 目录（非输入框时）" />
          <Row keys={['Ctrl', 'V']} desc="粘贴内部剪贴板到选中目标（非输入框时）" />
        </Group>

        <Group anchor="shortcuts.kbTabs" label="知识库 — Tab 管理">
          <Row keys={['Ctrl', 'N']} desc="新建零散页面" />
          <Row keys={['Ctrl', 'W']} desc="关闭当前打开的 Tab 页" />
          <Row keys={['Ctrl', 'Tab']} desc="切换到下一个 Tab" />
          <Row keys={['Ctrl', 'Shift', 'Tab']} desc="切换到上一个 Tab" />
        </Group>

        <Group anchor="shortcuts.kbReading" label="知识库 — 阅读">
          <Row keys={['Ctrl', 'Shift', 'R']} desc="沉浸阅读进出" />
          <Row keys={['Ctrl', 'P']} desc="知识库快速搜索" />
          <Row keys={['Escape']} desc="沉浸阅读退出" />
        </Group>

        <Group anchor="shortcuts.editorModule" label="编辑器模块">
          <Row keys={['Ctrl', 'S']} desc="保存当前文件" />
          <Row keys={['Ctrl', 'Shift', 'S']} desc="保存全部打开文件" />
          <Row keys={['Ctrl', 'F']} desc="PDF 阅读器内搜索" />
          <Row keys={['PageDown', '空格']} desc="PDF 下一页" />
          <Row keys={['PageUp']} desc="PDF 上一页" />
        </Group>

        <Group anchor="shortcuts.blogKeys" label="博客">
          <Row keys={['Ctrl', 'N']} desc="新建 / 打开今日文章" />
          <Row keys={['Ctrl', 'S']} desc="保存并关闭编辑器" />
          <Row keys={['Ctrl', '/']} desc="切换 Markdown 预览" />
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
          <Row keys={['Ctrl', 'Alt', 'P']} desc="密码填充弹窗开关（系统级；可在设置改键）" />
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

function Row({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[13px] text-[var(--text-primary)]">{desc}</span>
      <div className="flex items-center gap-1 shrink-0">
        {keys.map((k, i) => (
          <span key={i} className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[var(--text-secondary)] min-w-[20px] justify-center">
            {k}
          </span>
        ))}
      </div>
    </div>
  )
}
