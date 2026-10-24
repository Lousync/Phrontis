import { BlogView } from './BlogView'
import { ReminderView } from './ReminderView'
import { ScheduleView } from './ScheduleView'
import { IntelView } from './IntelView'

/**
 * 设置 → 模块设置：业务模块专属偏好（博客 / 日程任务 / 打卡提醒 / 情报）。
 *
 * 2026-10-13：AI教学三项（产物根目录 / 删除联动 / 视觉转写模型）已迁到「AI 工具 → 教学」——
 * 它们是 AI 设置，留在这里造成"AI 设置分散在两处"，找模型配置的人不会往模块设置翻。
 */
export function ModulesView() {
  return (
    <div>
      <div className="mb-8">
        <BlogView />
      </div>
      <div className="mb-8">
        <ScheduleView />
      </div>
      <div className="mb-8">
        <IntelView />
      </div>
      <ReminderView />
    </div>
  )
}
