/**
 * 图标条顶部两枚（看板 / 工作台）的几何。
 *
 * **为什么单独一个文件**：形状是这个图标的唯一真相，手绘包（`ModuleIcons.tsx`，1.6 笔法）与
 * 经典细线包（`sidebarIcons.tsx` 的 classic140，1.5 笔法）共用同一套；两处各抄一遍必然漂移。
 * 放 `lib/` 而不是 `components/shared/` 是因为 `ModuleIcons` 与 `sidebarIcons` 互相 import 会成环。
 *
 * **两包怎么区分**：只差笔宽与圆角 —— 手绘包 rx 大一点（更像项目自己的手绘笔法），
 * 经典细线包 rx 收到接近 1（lucide 的圆角语言）。形状同构，切设置时看得出变了，又不会认成另一个模块。
 *
 * **看板 = 首页五控件的缩略**（`src/modules/dashboard/index.tsx`）：左列「今日纸」flex-1 +「使用热力图」定高，
 * 右列 AI 课程 / 工作台窗口 / AI 用量三块叠放。左上 9.8×10（与左下 4 高之比 ≈ 2.5 : 1）。
 * ★ 两处刻意的取舍（原型 `tmp/rail-board-workbench-icons/board-v3.html` 定稿）：
 * ① 右列画到 **33%** 宽，真实布局约 23% —— 照真实比例右列在 22px 下只有 3.5px，三块会细到看不见；
 * ② **不加外框** —— 工作台那枚已经是「框 + 左竖带 + 正文线」，看板再套框就贴太近；
 *    让看板靠「五个块的比例」被认出来，和工作台的「框内结构」分成两类
 *    （第一轮用了 lucide `LayoutGrid` + `LayoutPanelLeft`，两枚都读作「方框 + 分割」才看混的）。
 */

/** 看板：五个块的比例就是这枚图标本身。`classic` = 经典细线包变体（圆角收紧） */
export function DashboardShape({ classic = false }: { classic?: boolean }) {
  const rBig = classic ? 1 : 1.7
  const rMid = classic ? 0.9 : 1.4
  const rSmall = classic ? 0.8 : 1.3
  return (
    <>
      {/* 左列：今日纸（长）+ 使用热力图（矮） */}
      <rect x="3.4" y="4" width="9.8" height="10" rx={rBig} />
      <rect x="3.4" y="16" width="9.8" height="4" rx={rMid} />
      {/* 右列：AI 课程 / 工作台窗口 / AI 用量 */}
      <rect x="15" y="4" width="5.6" height="4" rx={rSmall} />
      <rect x="15" y="10" width="5.6" height="4" rx={rSmall} />
      <rect x="15" y="16" width="5.6" height="4" rx={rSmall} />
    </>
  )
}

/** 工作台：三栏外壳的缩略 —— 左侧竖带（书签 / 文件树）+ 正文三行 */
export function WorkbenchShape({ classic = false }: { classic?: boolean }) {
  return (
    <>
      <rect x="3.4" y="4" width="17.2" height="16" rx={classic ? 1.6 : 2.2} />
      <path d="M9.3 4v16" />
      <path d="M12.6 9.2h5" />
      <path d="M12.6 12.6h5" />
      <path d="M12.6 16h3.1" />
    </>
  )
}
