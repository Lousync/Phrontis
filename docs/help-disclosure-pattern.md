# 帮助文案渐进披露规范（Help Disclosure Pattern）

> 2026-09-11 定稿。**以后遇到「常驻说明文字太占位 / 太啰嗦，但删掉用户又不知道有这功能」的问题，一律按本规范处理**，不再临时发明方案。

## 1. 问题定义

界面中的解释性/引导性文字（操作说明、字段释义、功能介绍）常驻显示时造成视觉噪音；直接删除又损失新用户的可发现性。

## 2. 决策原则（按场景选形态）

| 场景 | 形态 | 已应用点位 |
|------|------|-----------|
| 工具条 / 底栏 / 窄条区域 | **A · swap-bar**：默认只显一个语义图标（13px, `text-disabled` 灰），悬停父容器图标淡出、单行说明淡入 | 日程表「待安排」托盘底栏（TaskTray） |
| 信息卡 / 设置卡（标题+正文结构） | **B · hover 展开卡**：默认只有「图标 + 标题 + 按钮」+ 标题旁 12px ⓘ；悬停整卡说明文字平滑展开 | AI 教学「学习者画像 · 三层」「全局要求」两卡 |
| 新手必须看到的强引导 | **C · 首启可见 +「知道了」**：默认显示完整提示，点击「知道了」后 localStorage 记忆永久收起，此后仅剩小问号可回看 | 尚未应用（新手引导类场景适用） |

**禁止**：为省空间直接删除说明；用醒目色标签/横幅承载说明；hover 之外加常驻文字开关入口。

## 3. 实现配方（Tailwind，均已在本仓验证）

### A · swap-bar（父容器加 `group`）

```tsx
<div className="group ...">  {/* 悬停感应范围 = 整个父容器 */}
  ...
  <div className="shrink-0 relative h-7 border-t border-[var(--border-color)]">
    <span className="absolute inset-0 flex items-center justify-center text-[var(--text-disabled)] transition-opacity duration-300 group-hover:opacity-0">
      <Info size={13} />
    </span>
    <span className="absolute inset-0 flex items-center justify-center px-3 text-[10.5px] text-[var(--text-disabled)] whitespace-nowrap overflow-hidden text-ellipsis opacity-0 translate-y-[3px] transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0">
      {一行说明文案}
    </span>
  </div>
</div>
```

要点：两层 `absolute inset-0` 叠放避免高度跳动；文字层 `whitespace-nowrap + text-ellipsis` 防撑高；语义图标优先选「能自解释」的（如拖拽场景用 ↔ MoveHorizontal 而非泛化问号），默认 ⓘ Info。

### B · hover 展开卡（父卡加 `group`）

```tsx
<div className="group ...rounded-xl border ... px-4 py-3.5">
  <div className="flex items-center gap-1.5 text-[13px] font-medium ...">
    {标题}
    <Info size={12} className="shrink-0 text-[var(--text-disabled)]" />
  </div>
  <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 group-hover:grid-rows-[1fr]">
    <div className="overflow-hidden">
      <div className="mt-1 text-[11.5px] text-[var(--text-muted)] leading-relaxed">{说明文字}</div>
    </div>
  </div>
</div>
```

要点：`grid-rows 0fr→1fr` 过渡实现平滑高度动画，**不要用 max-height 硬切**；说明文字一字不删，只是收起。

## 4. 视觉规范

- 图标：`Info`（lucide），12~13px，`text-[var(--text-disabled)]`，深浅主题自动适配；语义化候选见 `outputs/hint-icon-prototype.html`（↔/灯泡/手势等）
- 文字：`text-[10.5px]~[11.5px] text-[var(--text-muted)]~[var(--text-disabled)]`
- 动效：300ms ease；需尊重 `prefers-reduced-motion`（新场景如有关键动画记得加降级）
- 空态例外：组件空态本身的引导文案**保持常驻**（空态即引导，无噪音问题）

## 5. 推广点位（做一处勾一处）

- [x] 日程表「待安排」托盘底栏（TaskTray，A 形态打样）
- [x] AI 教学工作区选择页「学习者画像 / 全局要求」两卡（B 形态）
- [x] 设置 → AI 全部页签（B 形态，2026-10-13 文案减负）：抽了 `src/modules/settings/views/SectionHead.tsx`
      （标题 + 悬停展开说明 + 右侧操作位），模型 / 权限 / 工具 / 对话 / 用量 / 教学六页的常驻段落全部收进悬停；
      感应范围刻意只给标题行那一小条（小节内有长列表，整块响应会在划过控件时把内容顶走）。
      同时删掉了三类不该出现在界面上的字：复述标签的句子、开发者视角的设计理由、过期指路与历史括注。
      回归闸：`.AGENT/scripts/settings/verify-ai-tab-anchors.mjs` §8（标题后不得紧跟常驻说明段 +
      已删文案不许回来 + 空态与不可逆警告必须常驻）。
- [ ] 回收站模块说明文字
- [ ] 工具箱「数据导出」说明
- [ ] 今日工作台小窗提示
- [ ] 抽通用 `HelpHint` 组件（props: icon / text / 形态 A|B / 可选「知道了」记忆），以上点位迁移后逐个替换内联实现

## 6. 相关原型

- `outputs/help-disclosure-prototype.html`（5 方案对比，方案三+ 为本规范形态 A 的出处）
- `outputs/hint-icon-prototype.html`（图标 6 候选，定稿 = Info ⓘ）
