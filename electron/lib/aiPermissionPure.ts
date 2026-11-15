/**
 * 三层权限矩阵（纯逻辑）—— P0-B §2.2。
 *
 * 三层的职责互不重叠：
 *  · **全局**（settings）：`aiVaultFilePerm` off/read/write 是硬否决 + 默认值；`terminal.aiExec` 同。
 *  · **工作区信任**（本机 `workspace-trust.json`，按 rootId）：allow / deny / null（未表态）。
 *  · **仓库策略**（`.knowbase/config.json#aiPolicy`）：逐扩展名收窄，只能更严。
 *
 * 生效 = 全局不否决 × 工作区未拒绝 × 仓库策略允许。
 *
 * 关键取舍（2026-11-15 拍板）：
 *  · `null` 表示「还没问过」——写工具**不从模型视野移除**，调用时返回明确提示，
 *    让模型能引导用户点顶部的一次性卡；只有 `deny` / 全局 `off` 才让工具消失。
 *  · 终端信任只决定「能不能用」，不决定「自动执行」：每条命令仍逐条确认。
 *
 * 契约：`.AGENT/scripts/ai-harness/verify-ai-permission.mjs`
 */

export type GlobalFilePerm = 'off' | 'read' | 'write'
export type TrustLevel = 'allow' | 'deny' | null

export interface WorkspaceTrust {
  fileWrite: TrustLevel
  shellExec: TrustLevel
}

export const DEFAULT_WORKSPACE_TRUST: WorkspaceTrust = { fileWrite: null, shellExec: null }

export interface PermissionInput {
  globalFilePerm: GlobalFilePerm
  /** settings `terminal.aiExec` */
  globalExec: boolean
  trust: WorkspaceTrust
  /** terminal 模块权限为 off = 硬否决（优先于所有层） */
  terminalModuleOff?: boolean
  /** 终端模块未启用（菜单里没开）——与权限无关，单独判定 */
  terminalModuleDisabled?: boolean
}

export interface PermissionState {
  /** 文件读取是否可用（全局 off 即否） */
  fileRead: boolean
  /** 文件写入是否可用（不区分具体扩展名；逐文件仍要过仓库策略） */
  fileWrite: boolean
  /** 终端执行工具是否可用 */
  exec: boolean
  /** 写工具是否进入模型视野（null 时仍进入，调用时报「尚未授权」） */
  writeToolsVisible: boolean
  /** 终端工具是否进入模型视野 */
  execToolsVisible: boolean
  /** 是否应显示「一次性开启」卡（任一项仍待用户表态） */
  needsTrustPrompt: boolean
  /** 写文件待表态（全局 read + 本仓库 null） */
  pendingFileTrust: boolean
  /** 执行命令待表态（全局 aiExec 关 + 本仓库 null） */
  pendingExecTrust: boolean
  /** 只读标记（用户明确选过「保持只读」） */
  readOnlyMarked: boolean
}

/**
 * 纯计算。逐扩展名/大小的收窄不在这里——调用方拿 `fileWrite` 之后再问
 * `evaluateAiFile(..., policy)`，两段合起来才是最终放行。
 */
export function evaluatePermission(input: PermissionInput): PermissionState {
  const global = input.globalFilePerm
  const trust = input.trust ?? DEFAULT_WORKSPACE_TRUST
  const terminalOff = input.terminalModuleOff === true || input.terminalModuleDisabled === true

  const fileRead = global !== 'off'
  const fileWrite = global === 'off'
    ? false
    : trust.fileWrite === 'deny'
      ? false
      : trust.fileWrite === 'allow'
        ? true
        : global === 'write'

  const exec = terminalOff
    ? false
    : trust.shellExec === 'deny'
      ? false
      : trust.shellExec === 'allow'
        ? true
        : input.globalExec === true

  const writeToolsVisible = global !== 'off' && trust.fileWrite !== 'deny'
  const execToolsVisible = !terminalOff && (trust.shellExec === 'allow' || (trust.shellExec === null && input.globalExec === true))

  // 只对「靠默认值也拿不到授权」的项提问：
  //  · 全局 write / aiExec=true 已经是「默认可写 / 默认可用」，不该再打断；
  //  · 用户已明确 deny 是表态，过。
  const pendingFileTrust = global === 'read' && trust.fileWrite === null
  const pendingExecTrust = !terminalOff && input.globalExec !== true && trust.shellExec === null

  return {
    fileRead,
    fileWrite,
    exec,
    writeToolsVisible,
    execToolsVisible,
    needsTrustPrompt: pendingFileTrust || pendingExecTrust,
    pendingFileTrust,
    pendingExecTrust,
    readOnlyMarked: trust.fileWrite === 'deny',
  }
}

/** 一次性开启：写文件 + 执行命令同时授予（拍板：一张卡） */
export function trustAll(): WorkspaceTrust {
  return { fileWrite: 'allow', shellExec: 'allow' }
}

/** 保持只读：写与命令都拒，之后不再提示 */
export function trustReadOnly(): WorkspaceTrust {
  return { fileWrite: 'deny', shellExec: 'deny' }
}

/** 非法值归一（读盘时用，避免旧数据把状态搞成第三态） */
export function normalizeTrustLevel(v: unknown): TrustLevel {
  return v === 'allow' || v === 'deny' ? v : null
}

export function normalizeWorkspaceTrust(raw: unknown): WorkspaceTrust {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return { fileWrite: normalizeTrustLevel(o.fileWrite), shellExec: normalizeTrustLevel(o.shellExec) }
}
