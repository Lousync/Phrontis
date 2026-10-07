import { useEffect, useState } from 'react'
import {
  Archive, ArrowLeft, ArrowRight, BellRing, Bot, BookOpen, CalendarDays, Check,
  Database, GraduationCap, Keyboard, MessageCircle, Moon, Network, PenLine,
  ShieldCheck, Sparkles, Sun, Wrench,
} from 'lucide-react'
import { PluginIcon } from './ModuleIcons'
import { useSettings } from '../../lib/SettingsContext'

/** 模块图标组件类型：内置 lucide 与 StyleAware 的 PluginIcon 都要能装下。
 *  `typeof PenLine` 是 lucide 的组件类型，装不下 PluginIcon（普通函数组件）——
 *  2026-09-22 B-9 起放宽为「只要 size / className」。渲染处只用这两个 prop。 */
type ModuleIconComp = React.ComponentType<{ size?: number; className?: string }>

const MODULES: { icon: ModuleIconComp; name: string; desc: string }[] = [
  { icon: PenLine, name: '编辑器', desc: 'Markdown 正文写作 · 唯一写入方' },
  { icon: BookOpen, name: '博客 · 日志', desc: '每日写作、标签与周月总结' },
  { icon: CalendarDays, name: '任务', desc: '日程安排与四象限管理' },
  { icon: Network, name: '知识库', desc: '双链笔记、PDF 与知识网络' },
  { icon: MessageCircle, name: '说说', desc: '轻量动态与相册记录' },
  { icon: GraduationCap, name: 'AI 教学', desc: '会话学习、视觉转写与自动出题' },
  { icon: Wrench, name: '工具箱', desc: '番茄钟、习惯打卡、数据导出等 8 个工具' },
  { icon: Bot, name: 'AI 助手', desc: '本地模型驱动，边看边问（Ctrl+J）' },
  { icon: PluginIcon, name: '插件', desc: '主题 / 预设 / 知识包官方市场' },
]

/** 2026-09-26：引导「场景选择」步骤与 `activityBarHidden` 写入链路已整体删除 ——
 *  该键唯一的读取方（`resolveStartupTab`）随「启动时默认显示」设置项退役，
 *  勾选不再有任何效果。旧「精简活动栏」的活由 v3.4.0 三栏外壳 + 图标条右键显隐接棒。 */

const SHORTCUTS = [
  { keys: 'Ctrl N', desc: '当前模块新建（日志 / 任务 / 知识页）' },
  { keys: 'Ctrl J', desc: '唤起 / 收起 AI 助手侧栏' },
  { keys: 'Ctrl B', desc: '展开 / 收起侧边栏' },
  { keys: 'Ctrl 滚轮', desc: '缩放界面（设置中可调）' },
  { keys: 'Ctrl Alt P', desc: '密码本快速填充悬浮窗' },
]

/** 首次启动的新手引导 — 全屏分步向导，完成或跳过后由父级写入 onboardingDone */
export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const { s, update } = useSettings()
  const [step, setStep] = useState(0)
  const total = 6

  /** 完成/跳过统一收口（无落库动作，纯回调） */
  const finish = () => {
    onComplete()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        if (step < total - 1) setStep(v => v + 1)
        else finish()
      } else if (e.key === 'ArrowLeft' && step > 0) {
        e.preventDefault()
        setStep(v => v - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, finish])

  const next = () => (step < total - 1 ? setStep(v => v + 1) : finish())

  return (
    <div className="fixed inset-0 z-[90] bg-[var(--bg-primary)] flex items-center justify-center select-none">
      <div className="w-full max-w-[560px] mx-6 -mt-10">
        {/* 进度圆点 */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {Array.from({ length: total }).map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all duration-200 ${i === step ? 'w-6 bg-[var(--accent)]' : 'w-1.5 bg-[var(--border-color)]'}`}
            />
          ))}
        </div>

        {/* 步骤内容 */}
        <div key={step} className="onboarding-step">
          {step === 0 && (
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center mx-auto mb-5">
                <Sparkles size={32} className="text-[var(--accent)]" />
              </div>
              <h1 className="text-[22px] font-semibold text-[var(--text-primary)] mb-2">欢迎使用 Phrontis</h1>
              <p className="text-[13px] text-[var(--text-muted)] leading-relaxed max-w-[380px] mx-auto">
                一款<strong className="text-[var(--text-secondary)]">本地优先</strong>的个人知识管理应用——
                数据全部保存在你自己的电脑上，无需注册、没有云端。
                <br />花一分钟了解它能做什么。
              </p>
            </div>
          )}

          {step === 1 && (
            <div>
              <StepTitle icon={<Sparkles size={15} />} title="核心功能一览" />
              <div className="grid grid-cols-2 gap-2.5">
                {MODULES.map(m => (
                  <div key={m.name} className="flex items-start gap-2.5 p-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
                    <div className="shrink-0 mt-0.5"><m.icon size={16} className="text-[var(--accent)]" /></div>
                    <div>
                      <div className="text-[12px] font-medium text-[var(--text-primary)]">{m.name}</div>
                      <div className="text-[11px] text-[var(--text-muted)] leading-snug mt-0.5">{m.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <StepTitle icon={<Bot size={15} />} title="AI 助手与插件" />
              <div className="space-y-2.5">
                <InfoRow icon={<Bot size={14} />} title="AI 助手 · 边看边问"
                  desc="Ctrl+J 随时唤起；设置 → AI 工具 中配置本地（Ollama）或在线模型，支持 CC Switch 一键导入。对话可调用本地工具并全程留痕" />
                <InfoRow icon={<PluginIcon size={14} />} title="插件 · 官方市场"
                  desc="插件页一键安装主题、番茄预设与知识包（如 408 考研学习空间，一键导入 148 页学习内容）；S/A/B 三级安全审核" />
                <InfoRow icon={<ShieldCheck size={14} />} title="按模块授权"
                  desc="设置 → AI 工具 → 权限 中按模块控制 AI 能力边界（禁止 / 只读 / 读写），未授权模块 AI 完全无法触达" />
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <StepTitle icon={<Sparkles size={15} />} title="按喜好快速设置" />
              <div className="space-y-4">
                <QuickRow label="界面主题">
                  <ChoiceGroup
                    options={[{ id: 'dark', label: '深色', icon: Moon }, { id: 'light', label: '浅色', icon: Sun }]}
                    value={s.theme}
                    onChange={v => update('theme', v)}
                  />
                </QuickRow>
                <QuickRow label="打卡提醒">
                  <ChoiceGroup
                    options={[{ id: 'on', label: '开启', icon: BellRing }, { id: 'off', label: '关闭' }]}
                    value={s.checkinReminderEnabled ? 'on' : 'off'}
                    onChange={v => update('checkinReminderEnabled', v === 'on')}
                  />
                </QuickRow>
                <p className="text-[11px] text-[var(--text-disabled)]">以上均可随时在 设置 中修改</p>
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <StepTitle icon={<ShieldCheck size={15} />} title="数据与安全" />
              <div className="space-y-2.5">
                <InfoRow icon={<Database size={14} />} title="数据仅存本机"
                  desc="所有内容保存在本机数据库中，不经过任何服务器" />
                <InfoRow icon={<Archive size={14} />} title="定期备份"
                  desc="「导出」模块一键备份全部数据为 ZIP；将备份包拖入窗口即可恢复" />
              </div>
            </div>
          )}

          {step === 5 && (
            <div>
              <StepTitle icon={<Keyboard size={15} />} title="快捷键加速，准备出发" />
              <div className="space-y-2 mb-6">
                {SHORTCUTS.map(sc => (
                  <div key={sc.keys} className="flex items-center gap-3">
                    <kbd className="min-w-[92px] text-center px-2 py-1 rounded bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[11px] font-mono text-[var(--text-primary)]">{sc.keys}</kbd>
                    <span className="text-[12px] text-[var(--text-secondary)]">{sc.desc}</span>
                  </div>
                ))}
              </div>
              <p className="text-[12px] text-[var(--text-muted)]">更多技巧见左下角设置菜单的「帮助」。</p>
            </div>
          )}
        </div>

        {/* 底部控制栏 */}
        <div className="flex items-center mt-10">
          {step < total - 1 ? (
            <button
              onClick={finish}
              className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              跳过引导
            </button>
          ) : <span />}
          <div className="flex-1" />
          {step > 0 && (
            <button
              onClick={() => setStep(v => v - 1)}
              className="flex items-center gap-1 px-3.5 py-2 text-[12px] text-[var(--text-secondary)] border border-[var(--border-color)] rounded-md hover:bg-[var(--bg-hover)] transition-colors"
            >
              <ArrowLeft size={13} />上一步
            </button>
          )}
          <button
            onClick={next}
            className="flex items-center gap-1.5 px-4 py-2 text-[12px] font-medium text-white bg-[var(--accent)] rounded-md hover:bg-[var(--accent-hover)] transition-colors ml-2.5"
          >
            {step < total - 1 ? <>下一步<ArrowRight size={13} /></> : <>开始使用<Check size={13} /></>}
          </button>
        </div>
      </div>
    </div>
  )
}

function StepTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="text-[var(--accent)]">{icon}</span>
      <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{title}</h2>
    </div>
  )
}

function QuickRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] text-[var(--text-primary)]">{label}</span>
      {children}
    </div>
  )
}

function ChoiceGroup({ options, value, onChange }: {
  options: { id: string; label: string; icon?: React.ComponentType<{ size?: number }> }[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <div className="flex gap-1.5">
      {options.map(o => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`flex items-center gap-1 px-2.5 py-1.5 text-[12px] rounded-md border transition-colors ${
            value === o.id
              ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
              : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
          }`}
        >
          {o.icon && <o.icon size={12} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

function InfoRow({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-2.5 p-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <div className="shrink-0 mt-0.5 text-[var(--accent)]">{icon}</div>
      <div>
        <div className="text-[12px] font-medium text-[var(--text-primary)]">{title}</div>
        <div className="text-[11px] text-[var(--text-muted)] leading-snug mt-0.5">{desc}</div>
      </div>
    </div>
  )
}
