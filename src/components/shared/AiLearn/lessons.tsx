import type { ReactNode } from 'react'
import type { TabName } from '../../../types'

/**
 * AI 学堂 · 上手路径教程数据
 *
 * 定位：这里是 UI 资产，主进程不需要知道内容。用户在「第几步」通过
 * AgentContextInfo 传给主进程（见 docs/ai-learn-center-design.md §6）。
 *
 * 内容原则（§7.6）：可判定、可执行、覆盖误用、可互链。
 * P3 阶段会把这批文案与 resources/help/ 下的《快速上手》收敛为同一份真相源。
 */

/** 「动手做」：点了先收起学堂再跳目标模块（避免浮层压住目标） */
export interface LessonAction {
  label: string
  /** 目标模块；缺省 = 不跳转（该步的动作用户就在学堂里完成，如「问 AI」） */
  goto?: TabName
}

export interface Lesson {
  /** 步骤序号，从 1 起 */
  n: number
  title: string
  /** 展示用时长，如 '2 分钟' */
  minutes: string
  /** 这一步做完应该达到什么 —— 同时会作为提问上下文注入 AI */
  goal: string
  /** 关联的 help 文档 id（P2 接通手册检索后生效） */
  docId?: string
  body: ReactNode
  action?: LessonAction
  /** 右栏快捷提问 chips */
  ask?: string[]
}

/** 讲义里的关键提醒块（对应原型里的蓝色左边框 callout） */
function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="my-3 rounded-r-lg border-l-[3px] border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_9%,transparent)] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
      {title && <b className="text-[var(--text-primary)]">{title}</b>}
      {children}
    </div>
  )
}

/** 讲义里的代码/结构块 */
function Code({ children }: { children: ReactNode }) {
  return (
    <pre className="my-3 overflow-x-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-[var(--text-secondary)]">
      {children}
    </pre>
  )
}

const P = ({ children }: { children: ReactNode }) => (
  <p className="my-2.5 text-[13px] leading-[1.85] text-[var(--text-secondary)]">{children}</p>
)

const B = ({ children }: { children: ReactNode }) => (
  <b className="font-medium text-[var(--text-primary)]">{children}</b>
)

const C = ({ children }: { children: ReactNode }) => (
  <code className="rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1 font-mono text-[12px]">{children}</code>
)

export const LESSONS: Lesson[] = [
  {
    n: 1,
    title: '认准三个区',
    minutes: '30 秒',
    goal: '分清「活动栏 / 编辑区 / 知识库」各自负责什么',
    docId: '快速上手',
    action: { label: '去笔记区看看', goto: 'knowledge' },
    ask: ['这三个区最常搞混的是哪一步？', '我可以只用知识库吗？'],
    body: (
      <>
        <P><B>活动栏</B>（最左侧一列图标）决定你现在进哪个模块，<C>Ctrl B</C> 可以收起侧边栏腾地方。</P>
        <P><B>编辑区</B>是唯一能写正文的地方：左边文件树管文件，右边写内容，<B>自动保存，不用 Ctrl S</B>。</P>
        <P><B>知识库</B>只负责阅读与组织：双链、标签、知识网络、全文搜索都在这里。</P>
        <Note title="一句话心智：">编辑区写，知识库读。后面 90% 的「为什么找不到」都源于这一句没记住。</Note>
      </>
    ),
  },
  {
    n: 2,
    title: '写下第一页',
    minutes: '2 分钟',
    goal: '真的在仓库目录里落下一个 .md 文件',
    docId: '博客写作',
    action: { label: '新建第一篇笔记', goto: 'knowledge' },
    ask: ['新建文件有哪几种方式？', '文件默认存在哪个目录？'],
    body: (
      <>
        <P>在编辑区左侧文件树点 <C>+</C> 新建文件，或直接按 <C>Ctrl N</C>。名字随意，例如 <C>我的第一篇笔记.md</C>。</P>
        <P>写点什么，停手一秒 —— 编辑区右下角会闪一下「已保存」。这个文件真实落在你选的仓库文件夹里，可以用资源管理器打开确认。</P>
        <Note title="常问：文件存哪了？">存在你自己选的那个仓库文件夹里。它就是一个普通 <C>.md</C> 文件，用 VS Code、Typora 也能直接打开。</Note>
      </>
    ),
  },
  {
    n: 3,
    title: '让它出现在知识库',
    minutes: '3 分钟',
    goal: '理解「什么样的文件才算知识库页面」',
    docId: '常见问题',
    action: { label: '在笔记区中打开该文件', goto: 'knowledge' },
    ask: ['这一步为什么要写 id？', '给我一个 frontmatter 模板'],
    body: (
      <>
        <P>如果你刚切到知识库，发现<B>空空如也</B> —— 这不是 bug。</P>
        <P>知识库只收录<B>带 frontmatter <C>id</C> 的 .md 文件</B>。没有 id 的文件被当作<B>草稿</B>，只在编辑区可见。给文件顶部加三行就够了：</P>
        <Code>{'---\nid: my-first-note\ntitle: 我的第一篇笔记\n---'}</Code>
        <P>保存后再看知识库，它出现了。</P>
        <Note title="为什么这么设计？">草稿机制让你可以随便写、随便存，只有当你明确「这篇要进知识库」时才正式收录 —— 避免半成品把知识库塞满。</Note>
      </>
    ),
  },
  {
    n: 4,
    title: '建立第一条连接',
    minutes: '3 分钟',
    goal: '让两篇笔记之间出现一条线',
    docId: '博客标签',
    action: { label: '给笔记加个标签', goto: 'knowledge' },
    ask: ['标签和双链该用哪个？', '双链写错了会怎样？'],
    body: (
      <>
        <P><B>标签</B> <C>#考研408</C> 用来分类，知识库里可以按标签筛选。</P>
        <P><B>双链</B> <C>[[虚拟存储器]]</C> 指向另一篇页面；被指向的页面会自动出现一条反向链接。</P>
        <P>切到「知识网络」，你会看到节点与连线 —— 这就是你的知识地图。</P>
      </>
    ),
  },
  {
    n: 5,
    title: '让 AI 帮你干活',
    minutes: '3 分钟',
    goal: '知道 AI 能做什么、不能做什么',
    docId: 'AI Skill 技能',
    action: { label: '就在这里问一句' },
    ask: ['AI 能直接改我的文件吗？', '权限在哪里设置？'],
    body: (
      <>
        <P><C>Ctrl J</C> 唤起 AI 侧栏；选中任意文字还会浮出「问 AI」。侧栏头部右上角的 <B>⤢ 按钮</B>就是本模块的主角 —— 点它，侧栏原地扩成整个工作区。</P>
        <P>AI 不只是聊天：它能调用工具读你的文件、写文件、整理笔记。每条回复下方可以展开<B>调用轨迹</B>，写完还会列出<B>本次已改动 N 项</B>，可点开对应文件。</P>
        <P>权限按模块控制：设置 → AI 工具 → 权限。某个模块设为「禁止」，AI 就完全看不到它。</P>
        <Note title="写盘后会自动广播刷新。">界面立刻更新。如果没更新，说明这次其实没写成功 —— 别急着信「已完成」。</Note>
      </>
    ),
  },
  {
    n: 6,
    title: '备份与找回',
    minutes: '2 分钟',
    goal: '知道数据存在哪，出事了能救回来',
    docId: '常见问题',
    action: { label: '导出一次备份', goto: 'toolbox' },
    ask: ['备份包含附件吗？', '误删的文件去哪找？'],
    body: (
      <>
        <P>数据全部在本机，没有云端。仓库本身就是一个文件夹，直接复制即备份。</P>
        <P>「工具箱 → 导出」可以打一个 ZIP 包；把包拖回窗口就是恢复。</P>
        <P>删掉的文件进系统回收站，软件内的「回收站」模块也能找回。</P>
      </>
    ),
  },
]

/** 总步数（多处展示用） */
export const LESSON_TOTAL = LESSONS.length

export function getLesson(n: number): Lesson {
  return LESSONS.find(l => l.n === n) ?? LESSONS[0]
}
