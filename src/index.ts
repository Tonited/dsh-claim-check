// dsh-claim-check —— 宿主半。
//
// 把 claim-check 的「闸门 3（意图）」和「闸门 2 的预算」从脚本层提升到 harness 层。
//
// 脚本层（claim-check/scripts/*.mjs）只能**事后**比对哈希；本插件在工具调用被派发之前
// 就拦住，并把每一次**越权尝试**写进日志。这条差别是本质的：
//
//   - 事后比对只能回答"判据被改过吗"；
//   - 事前拦截 + 尝试日志能回答"它**试过**吗"。
//
// 而"尝试"是这套体系里信噪比最高的观测量：通过率分不清"做不到"和"选择不做"，
// 尝试可以；而且两者是解耦的（锁死评测器能让得逞率归零，尝试率却可能纹丝不动）。
//
// 本插件**不替代**脚本：证据块、锚点统计、契约完整性仍由 scripts/ 负责。它补的正是
// 脚本够不到的那两级（见 claim-check/templates/file-ownership.md 的强制阶梯）：
//
//   级别 1 物理隔离      —— 不靠插件
//   级别 2 git 钩子      —— 不靠插件
//   级别 3 事前拦截+尝试 —— 本插件
//
// 设计上刻意保持"哑"：它不做任何判断题，只比对路径与命令字面量。原因是任何需要解释
// 意图的判断都会变成新的可被博弈的判据——那正是这套体系要防的东西。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 插件名；与 cordis.patch.yml 的 entry name 一致。 */
export const name = 'dsh-claim-check'

/** 依赖的服务：只有 tools。本插件不碰会话、不碰模型。 */
export const inject = ['tools']

/** 判定文件的默认相对路径。 */
export const DEFAULT_JUDGMENT = 'contract/contract.judgment.md'

/** 证据目录的默认相对路径；append-only，实现者不得写。 */
export const DEFAULT_EVIDENCE = 'evidence'

/** 一个调用被判定为"对受保护资源的操作"时的描述。 */
export interface ClaimCheckHit {
  /** 被触碰的受保护路径（相对工作区根），或 null。 */
  readonly target: string | null
  /** 触碰方式。 */
  readonly action: 'read' | 'write'
  /** 命中的原因，写进拒绝理由与日志。 */
  readonly reason: string
}

/** 插件配置（全部可选；也接受等价的环境变量）。 */
export interface ClaimCheckConfig {
  /** 总开关；默认由环境变量决定（见 isEnabled）。 */
  readonly enabled?: boolean
  /** 工作区根目录；默认 DSH_CLAIM_CHECK_ROOT ?? process.cwd()。 */
  readonly root?: string
  /** 判定文件相对路径。 */
  readonly judgmentPath?: string
  /** 证据目录相对路径。 */
  readonly evidenceDir?: string
  /** 越权尝试日志相对路径。 */
  readonly logPath?: string
  /**
   * 判定执行次数上限。
   * 语义与脚本层一致：反复执行并观察结果，是把隐藏判据反推出来的主要途径。
   */
  readonly budget?: number
  /**
   * 是否禁止实现者**读**判定。
   * 默认 true。注意宿主只能做到路径级比对，真正的隔离仍应靠"判据不在实现者工作视图内"。
   */
  readonly hideJudgmentFromImplementer?: boolean
}

/** 解析后的配置。 */
interface Resolved {
  /** 候选工作区根目录；第一个来自配置/环境变量，其余为兜底。 */
  readonly roots: readonly string[]
  readonly judgmentPath: string
  readonly evidenceDir: string
  readonly logPath: string
  readonly budget: number
  readonly hideJudgment: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯逻辑（全部导出，便于在没有 DSH 的情况下用 node:test 直接测）
// ─────────────────────────────────────────────────────────────────────────────

/** 把任意路径归一成工作区相对的 posix 形式；越出工作区则返回 null。 */
export function toWorkspaceRelative(root: string, target: string): string | null {
  if (typeof target !== 'string' || target.length === 0) return null
  const absRoot = resolve(root)
  const abs = isAbsolute(target) ? resolve(target) : resolve(absRoot, target)
  const rel = relative(absRoot, abs)
  if (rel === '') return null
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/** 给定工作区相对路径，判断它是否落在受保护范围内。 */
export function classifyPath(rel: string | null, cfg: Pick<Resolved, 'judgmentPath' | 'evidenceDir'>): 'judgment' | 'evidence' | null {
  if (rel === null) return null
  if (rel === cfg.judgmentPath) return 'judgment'
  const evidencePrefix = cfg.evidenceDir.endsWith('/') ? cfg.evidenceDir : `${cfg.evidenceDir}/`
  if (rel === cfg.evidenceDir || rel.startsWith(evidencePrefix)) return 'evidence'
  return null
}

/**
 * 从工具参数里提取"被操作的路径"。
 *
 * 只认字面量字段——不做任何解释性推断。认不出来的参数一律当作"没有触碰受保护路径"，
 * 因为误伤一个正常调用的代价高于放过一次尝试（后者仍会被证据链与事后比对发现）。
 */
export function extractPaths(toolName: string, args: unknown): string[] {
  const out: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) out.push(v)
  }
  if (args === null || typeof args !== 'object') return out
  const record = args as Record<string, unknown>

  switch (toolName) {
    case 'read':
    case 'write':
    case 'edit':
    case 'str_replace_editor':
      push(record.file_path)
      push(record.path)
      break
    case 'read_image':
    case 'present':
      push(record.file_path)
      push(record.path)
      break
    case 'grep':
    case 'glob':
      push(record.path)
      break
    default:
      break
  }
  return out
}

/**
 * `bash` / `pwsh` 的命令文本是否触碰受保护路径（写或读）。
 *
 * 这是**字面量包含**检查，不是 shell 解析。理由：解析 shell 会引入解释器，而解释器
 * 就是新的博弈面。宁可漏，不可误判——漏掉的那些仍会在证据链与哈希比对里留下痕迹。
 */
export function bashTouches(text: unknown, relPaths: readonly string[]): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  for (const p of relPaths) {
    if (text.includes(p)) return true
    // 也认 basename，覆盖 `> judgment.md` 这类相对写法
    const base = p.split('/').pop()
    if (base !== undefined && base.length > 3 && text.includes(base)) return true
  }
  return false
}

/**
 * 从 bash 命令文本里识别"这是一次判定执行"。
 *
 * 与 scripts/evidence.mjs 的口径故意保持一致：命令里出现这些词就算判定。宽进严出——
 * 多算几次判定只会让预算更早触发（更保守），不会放过真正的反复查询。
 */
export function isJudgmentCommand(text: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  return /judg|contract|verify|judge/i.test(text)
}

/**
 * 核心判定：这次工具调用是否触碰受保护资源、以及该怎么处置。
 *
 * 返回 null 表示不干预。纯函数，无副作用——副作用（计数、写日志）在 apply 里做，
 * 这样这段逻辑可以被完整单测。
 *
 * 传入的是**候选 root 列表**：逐个尝试解析，第一个能把目标路径解释成受保护相对路径的
 * 胜出。这是为了消掉一个静默失效——若 agent 用相对路径而 DSH 的 cwd 与工作区不一致，
 * 单 root 会把它解析到工作区之外，守卫就永远不触发。
 */
export function inspect(
  toolName: string,
  args: unknown,
  cfg: Pick<Resolved, 'roots' | 'judgmentPath' | 'evidenceDir' | 'hideJudgment'>,
): ClaimCheckHit | null {
  const isShell = toolName === 'bash' || toolName === 'pwsh'

  if (isShell) {
    const command = (args as Record<string, unknown> | null)?.['command']
    const paths = [cfg.judgmentPath, cfg.evidenceDir]
    if (!bashTouches(command, paths)) return null
    // 命令里出现受保护路径：按"写"处理（重定向、rm、sed -i、cp 都归入这一类）。
    // bash 走的是名称匹配而非路径解析，因此不需要 root——但返回值里给一个当前能解析的。
    const rel = firstResolvable(cfg, cfg.judgmentPath)
    return {
      target: rel,
      action: 'write',
      reason: `命令文本触碰受保护路径（${cfg.judgmentPath} 或 ${cfg.evidenceDir}/）`,
    }
  }

  for (const raw of extractPaths(toolName, args)) {
    for (const root of cfg.roots) {
      const rel = toWorkspaceRelative(root, raw)
      const kind = classifyPath(rel, cfg)
      if (kind === null) continue

      const writable = toolName === 'write' || toolName === 'edit' || toolName === 'str_replace_editor'
      if (writable) {
        return {
          target: rel,
          action: 'write',
          reason: kind === 'judgment' ? '判据不是实现者能改的' : '证据目录是 append-only 的',
        }
      }
      if (kind === 'judgment' && cfg.hideJudgment) {
        return { target: rel, action: 'read', reason: '判据对实现者不可见（改了它就没有独立判定）' }
      }
      if (kind === 'evidence') {
        return { target: rel, action: 'read', reason: '证据只由 evidence.mjs 写入与读取' }
      }
    }
  }
  return null
}

/** 在候选 root 里找第一个能把该相对路径解析成工作区内路径的 root。 */
function firstResolvable(
  cfg: Pick<Resolved, 'roots'>,
  relPath: string,
): string | null {
  for (const root of cfg.roots) {
    const rel = toWorkspaceRelative(root, relPath)
    if (rel !== null) return rel
  }
  return null
}

/** 读判定预算计数器。 */
export function readJudgmentRuns(logPath: string): number {
  const counter = join(logPath, '.judgment-runs.json')
  try {
    if (!existsSync(counter)) return 0
    const parsed = JSON.parse(readFileSync(counter, 'utf8')) as { runs?: unknown[] }
    return Array.isArray(parsed.runs) ? parsed.runs.length : 0
  } catch {
    return 0
  }
}

/** 记一次判定执行。 */
export function recordJudgmentRun(logPath: string, entry: Record<string, unknown>): void {
  const counter = join(logPath, '.judgment-runs.json')
  let state: { runs: unknown[] } = { runs: [] }
  try {
    if (existsSync(counter)) {
      const parsed = JSON.parse(readFileSync(counter, 'utf8')) as { runs?: unknown[] }
      if (Array.isArray(parsed.runs)) state = { runs: parsed.runs }
    }
  } catch {
    state = { runs: [] }
  }
  state.runs.push(entry)
  writeFileSync(counter, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * 把一次尝试追加到日志。
 *
 * append-only，且**失败不抛出**：插件在工具派发路径上，抛异常会打断整个会话。日志写不
 * 进去是遗憾，但让工具调用失败是更大的伤害。
 */
export function appendAttempt(logPath: string, record: Record<string, unknown>): void {
  try {
    mkdirSync(logPath, { recursive: true })
    appendFileSync(join(logPath, 'attempts.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // 静默：见上面的理由
  }
}

/** 从 agent 对象里安全地取出可序列化的身份字段（agent 可能带循环引用，不能直接 JSON）。 */
export function identityOf(agent: unknown): { id: string | null, session: string | null } {
  if (agent === null || typeof agent !== 'object') return { id: null, session: null }
  const record = agent as Record<string, unknown>
  const asText = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null
  const session = record['session']
  return {
    id: asText(record['id']) ?? asText(record['name']),
    session:
      asText(session) ??
      (session !== null && typeof session === 'object'
        ? asText((session as Record<string, unknown>)['id'])
        : null),
  }
}

/** 是否启用。默认只在显式给出 DSH_CLAIM_CHECK 或 DSH_CLAIM_CHECK_ROOT 时启用。 */
export function isEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env['DSH_CLAIM_CHECK']) || Boolean(env['DSH_CLAIM_CHECK_ROOT'])
}

/**
 * 把配置与环境变量合成一份解析后的配置。
 *
 * `roots` 是**候选列表**：显式配置/环境变量优先，其余为兜底，去重后按顺序尝试。
 * 多个候选存在的唯一理由是消掉"cwd 与工作区不一致"导致的静默失效。
 *
 * `logPath` 落在**活动工作区**（含 contract/ 的那个候选）下，而不是显式传入的 root ——
 * 否则当显式 root 指错、守卫靠兜底候选命中时，日志会被写到没人看的地方。
 */
export function resolveConfig(
  config: ClaimCheckConfig = {},
  env: Record<string, string | undefined> = process.env,
): Resolved {
  const explicit = config.root ?? env['DSH_CLAIM_CHECK_ROOT']
  const candidates = [explicit, process.cwd(), '/mnt/d/MyProject']
  const roots: string[] = []
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0 && !roots.includes(c)) roots.push(c)
  }

  const active = firstRootWithContract(roots)
  const budgetRaw = config.budget ?? Number(env['DSH_CLAIM_CHECK_BUDGET'] ?? 3)
  return {
    roots,
    judgmentPath: config.judgmentPath ?? DEFAULT_JUDGMENT,
    evidenceDir: config.evidenceDir ?? DEFAULT_EVIDENCE,
    logPath: join(active ?? explicit ?? roots[0] ?? process.cwd(), config.logPath ?? DEFAULT_EVIDENCE),
    budget: Number.isFinite(budgetRaw) && budgetRaw >= 0 ? budgetRaw : 3,
    hideJudgment: config.hideJudgmentFromImplementer !== false,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 插件入口。
 *
 * 注册一个 `ToolGuard`（单调 deny：任何 guard 都不能把别人的 deny 翻回 allow），
 * 并在判定执行上强制预算。不做任何解释性判断。
 */
export function apply(ctx: {
  logger?: { info: (msg: string) => void, warn: (msg: string) => void }
  tools: { guard: (fn: (exec: unknown) => string | undefined) => () => void }
  extend?: (opts: { fiber: unknown }) => { tools: { guard: (fn: (exec: unknown) => string | undefined) => () => void } }
  root?: { fiber: unknown }
}, config: ClaimCheckConfig = {}): void {
  if (!isEnabled()) {
    ctx.logger?.info(
      'dsh-claim-check: 未启用（设置 DSH_CLAIM_CHECK=1 或 DSH_CLAIM_CHECK_ROOT=<工作区>）',
    )
    return
  }

  const cfg = resolveConfig(config)
  const activeRoot = firstRootWithContract(cfg.roots)
  if (activeRoot === null) {
    // 这条 warning 是刻意的：本插件最危险的失效模式是"装上了但从不触发"。
    ctx.logger?.warn(
      `dsh-claim-check: 已启用，但候选工作区里都没有 contract/ 目录（试过 ${cfg.roots.join(', ')}）。` +
        `守卫不会拦截任何东西——请把 DSH_CLAIM_CHECK_ROOT 指向真正的工作区。`,
    )
    return
  }

  const guard = (exec: unknown): string | undefined => {
    if (exec === null || typeof exec !== 'object') return undefined
    const record = exec as Record<string, unknown>
    const toolName = typeof record['name'] === 'string' ? record['name'] : ''
    const args = record['arguments']
    const who = identityOf(record['agent'])

    // 判定的执行预算。放在路径检查之前：一次超预算的判定即便不碰受保护路径也要拦。
    if ((toolName === 'bash' || toolName === 'pwsh') && isJudgmentCommand((args as Record<string, unknown> | null)?.['command'])) {
      const used = readJudgmentRuns(cfg.logPath)
      if (used >= cfg.budget) {
        const reason =
          `判定执行预算已用尽（${used}/${cfg.budget}）。反复执行并观察结果，是把隐藏判据` +
          `反推出来的主要途径。要放宽就显式调高 DSH_CLAIM_CHECK_BUDGET 并说明理由。`
        appendAttempt(cfg.logPath, {
          ts: new Date().toISOString(),
          actor: who.id,
          session: who.session,
          tool: toolName,
          action: 'exec',
          target: null,
          result: 'denied',
          reason: 'budget',
        })
        return reason
      }
      recordJudgmentRun(cfg.logPath, {
        at: new Date().toISOString(),
        actor: who.id,
        tool: toolName,
      })
    }

    const hit = inspect(toolName, args, cfg)
    if (hit === null) return undefined

    const denied = hit.action === 'write' || (hit.action === 'read' && cfg.hideJudgment)
    appendAttempt(cfg.logPath, {
      ts: new Date().toISOString(),
      actor: who.id,
      session: who.session,
      tool: toolName,
      action: hit.action,
      target: hit.target,
      result: denied ? 'denied' : 'allowed',
      reason: hit.reason,
    })

    return denied ? `claim-check: ${hit.reason}` : undefined
  }

  const host = ctx.extend !== undefined && ctx.root !== undefined
    ? ctx.extend({ fiber: ctx.root.fiber })
    : ctx
  host.tools.guard(guard)

  ctx.logger?.info(
    `dsh-claim-check: 已启用 — 活动工作区=${activeRoot} 候选=${cfg.roots.length} ` +
      `判定=${cfg.judgmentPath} 预算=${cfg.budget} 隐藏判定=${cfg.hideJudgment}`,
  )
}

/** 返回第一个含 contract/ 的候选 root；都没有则 null。 */
function firstRootWithContract(roots: readonly string[]): string | null {
  for (const root of roots) {
    if (existsSync(join(root, 'contract'))) return root
  }
  return null
}
