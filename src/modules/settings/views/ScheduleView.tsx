import { useSettings } from '../../../lib/SettingsContext'
import { SettingSelect } from '../components/SettingSelect'

export function ScheduleView() {
  const { s, update } = useSettings()

  return (
    <div>
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">日程</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-4">
        日程模块打开时停在哪个视图，以及日历默认用日 / 周 / 月 / 季哪一档。
      </p>

      <div className="space-y-7 max-w-xl">
        <div data-setting-anchor="schedule.defaultView">
          <SettingSelect
            title="默认视图"
            description="打开日程模块时默认停留的视图；在模块里切换后也会记住。"
            value={s.scheduleView}
            onChange={v => update('scheduleView', v)}
            options={[
              { id: 'today', label: '今天', desc: '今日任务 + 时间线', isDefault: true },
              { id: 'inbox', label: '收集箱', desc: '没有日期的任务' },
              { id: 'upcoming', label: '即将', desc: '未来日期的任务' },
              { id: 'calendar', label: '日历', desc: '日 / 周 / 月 / 季' },
              { id: 'workflows', label: '工作流', desc: '工作流列表' },
              { id: 'done', label: '已完成', desc: '已完成任务' },
            ]}
          />
        </div>

        <div data-setting-anchor="schedule.calendarMode">
          <SettingSelect
            title="日历默认模式"
            description="进入日历视图时默认显示的粒度。"
            value={s.scheduleCalendarMode}
            onChange={v => update('scheduleCalendarMode', v)}
            options={[
              { id: 'day', label: '日', desc: '当天任务 + 阶段' },
              { id: 'week', label: '周', desc: '工作流泳道 + 7 天任务', isDefault: true },
              { id: 'month', label: '月', desc: '任务 chip + 工作流色线' },
              { id: 'quarter', label: '季', desc: '14 周工作流泳道' },
            ]}
          />
        </div>
      </div>
    </div>
  )
}
