/**
 * lidar-harness 核心引擎 — SLAM/PGO 式多层级编码 Agent 验证
 *
 * 四层架构（映射自 README）：
 *   Tier 0  复杂度门控   —— 简单任务跳过重度验证
 *   Tier 1  局部回环检测 —— TodoWrite / git commit / git 变更 信号（含自适应 git-only 降级）
 *   Tier 2  全局 PGO     —— typecheck + lint → 错误签名归一化 → 增量注入 → 收敛
 *   Tier 3  多视角审查   —— 由胶水层（plugin）实现，本引擎仅上报 needsReview
 *
 * 安全：命令基线锁定（package.json scripts 哈希）+ SAFE_PREFIXES 白名单 + 无 shell argv 执行。
 * 收敛：shown 集合单调增长，必然终止。
 *
 * 纯 TS 实现，零运行时依赖。仅依赖 node 内置模块。
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /** 总开关，默认 true */
  enabled: boolean
  /** typecheck 命令 argv；null = 从 package.json scripts 自动检测（基线时锁定） */
  typecheckCmd: string[] | null
  /** lint 命令 argv；null = 自动检测 */
  lintCmd: string[] | null
  /** 新错误数 ≥ noiseFloor 才上报 needsReview（Tier 3 门槛），默认 3 */
  noiseFloor: number
  /** 可执行文件白名单，默认覆盖常见包管理器与检查器 */
  safePrefixes: string[]
  /** 简单任务判定阈值 */
  simpleTask: { maxTurnChars: number; maxDiffFiles: number; maxDiffLines: number }
  /** 单条命令超时（ms），默认 120_000 */
  commandTimeoutMs: number
  /** 状态持久化目录，默认 ~/.local/share/lidar-harness */
  dataDir: string
}

export type Complexity = "simple" | "medium" | "complex"

export interface PhaseSignals {
  todoCompleted: boolean
  gitCommit: boolean
  gitFilesChanged: string[]
  adaptive: boolean
}

export interface RunCommandResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface ProjectBaseline {
  projectKey: string
  typecheckSigs: string[]
  lintSigs: string[]
  gitHead: string
  scriptsHash: string
  createdAt: number
}

export interface TurnEvidence {
  cwd: string
  turnText: string
  todoCompleted: boolean
  gitCommitChanged: boolean
  gitFilesChanged: string[]
  gitDiffLines: number
  /** true = 跳过 Tier 0/1 门控直接执行 Tier 2（供 on-demand 工具使用） */
  force?: boolean
}

export interface VerifyOutcome {
  tier: number
  skipped: boolean
  skipReason?: string
  phaseSignals: PhaseSignals
  newErrors: string[]
  newErrorCount: number
  totalSeen: number
  converged: boolean
  needsReview: boolean
  securityAlert?: string
  /** true = 至少一个检查的 baseline 因命令不安全而未建立，当前 newErrors 可能包含历史错误 */
  baselineIncomplete?: boolean
  baseline: ProjectBaseline
  durationMs: number
}

interface PersistedState {
  projectKey: string
  cwd: string
  baseline: ProjectBaseline | null
  shownTypecheck: string[]
  shownLint: string[]
  adaptive: boolean
  adaptiveTurns: number
  lastRunAt: number
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: HarnessOptions = {
  enabled: true,
  typecheckCmd: null,
  lintCmd: null,
  noiseFloor: 3,
  safePrefixes: ["bun", "bunx", "npx", "npm", "pnpm", "yarn", "deno", "tsc", "eslint", "biome"],
  simpleTask: { maxTurnChars: 60, maxDiffFiles: 1, maxDiffLines: 20 },
  commandTimeoutMs: 120_000,
  dataDir: path.join(os.homedir(), ".local", "share", "lidar-harness"),
}

// ---------------------------------------------------------------------------
// 纯函数：签名归一化 / 解析 / 增量 / 复杂度 / 安全
// ---------------------------------------------------------------------------

/** 把一条错误块归一化为稳定签名：去 ANSI/\r、折叠空白、位置编号 → N、时间戳 → TS、时长 → DUR */
export function normalizeErrorSignature(raw: string): string {
  let s = raw
    // 去 ANSI 转义
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    // 去 \r
    .replace(/\r/g, "")
    // ISO 时间戳
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "TS")
    // 时长（0.3s / 12ms / in 123ms / 1.2s elapsed）
    .replace(/\d+(\.\d+)?\s?(ms|s)\b/g, "DUR")
    .replace(/\bin \d+ms\b/g, "DUR")
  // 位置编号：path:12:5 → path:N:N（优先匹配路径后的行:列）
  s = s.replace(/(:\d+)(:\d+)/g, ":N:N")
  // 兼容旧格式 path(12,5)
  s = s.replace(/\((\d+),(\d+)\)/g, "(N,N)")
  // 折叠空白
  s = s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, " ").trim()
  return s
}

/** 把命令输出拆成独立的错误块签名（tsc / eslint stylish / biome 三种格式） */
export function parseCommandOutput(output: string): string[] {
  const lines = output.replace(/\r/g, "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").split("\n")
  const isSeed = (line: string, prev: string): boolean => {
    const hasLoc = /(:\d+:\d+)|(\(\d+,\d+\))/.test(line)
    const hasSeverity = /error|warning|lint/i.test(line)
    if (hasLoc && hasSeverity) return true
    // eslint stylish：缩进的 "  12:5  error  msg  rule"（前一行通常为路径）
    if (/^\s+\d+:\d+\s+(error|warning)/i.test(line)) return true
    return false
  }

  const blocks: string[] = []
  let current: string[] = []
  let lastSeed = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const prev = i > 0 ? lines[i - 1] : ""
    if (isSeed(line, prev)) {
      lastSeed = blocks.length
      current = [line]
      blocks.push(current.join("\n"))
    } else if (lastSeed >= 0 && current.length < 3) {
      current.push(line)
      blocks[lastSeed] = current.join("\n")
    }
  }

  let sigs = blocks.map(normalizeErrorSignature).filter((s) => s.length > 0)
  // 兜底：没有任何位置化种子时，退回"包含 error/warning 的行"
  if (sigs.length === 0) {
    sigs = lines
      .filter((l) => /error|warning/i.test(l))
      .slice(0, 20)
      .map(normalizeErrorSignature)
      .filter((s) => s.length > 0)
  }
  // 去重（保持顺序）
  return [...new Set(sigs)]
}

/** 计算 current 中不在 prevSigs 里的签名（增量），保序去重 */
export function computeDelta(prevSigs: ReadonlySet<string>, current: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const sig of current) {
    if (prevSigs.has(sig) || seen.has(sig)) continue
    seen.add(sig)
    out.push(sig)
  }
  return out
}

/** 复杂度分类：重构/迁移关键词或大 diff → complex；短文本 + 小 diff → simple；其余 medium */
export function classifyComplexity(
  turnText: string,
  diffFiles: number,
  diffLines: number,
  opts: HarnessOptions,
): Complexity {
  const text = (turnText ?? "").trim()
  if (
    diffFiles > 5 ||
    /refactor|migrat|架构|重构|迁移|multi-?file/i.test(text)
  ) {
    return "complex"
  }
  if (
    text.length <= opts.simpleTask.maxTurnChars &&
    diffFiles <= opts.simpleTask.maxDiffFiles &&
    diffLines <= opts.simpleTask.maxDiffLines
  ) {
    return "simple"
  }
  return "medium"
}

/** package.json scripts 的稳定哈希（排序后序列化 → sha256） */
export function hashScripts(scripts: Record<string, string>): string {
  const sorted: Record<string, string> = {}
  for (const k of Object.keys(scripts).sort()) sorted[k] = scripts[k]
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex")
}

/** 命令白名单校验：可执行文件在 safePrefixes 内，且无 shell 元字符 */
export function isCommandSafe(
  cmd: string[],
  safePrefixes: string[],
): { safe: boolean; reason?: string } {
  if (!cmd || cmd.length === 0) return { safe: false, reason: "空命令" }
  if (!safePrefixes.includes(cmd[0])) {
    return { safe: false, reason: `可执行文件 "${cmd[0]}" 不在白名单 ${safePrefixes.join("/")} 内` }
  }
  for (const token of cmd) {
    if (/[;&|><`$(){}*?\n]/.test(token)) {
      return { safe: false, reason: `命令包含非法字符: ${token}` }
    }
  }
  return { safe: true }
}

/** 从 package.json scripts 检测 typecheck/lint 命令并展开为 argv */
export function detectAutoCommands(
  scripts: Record<string, string>,
): { typecheck?: string[]; lint?: string[] } {
  const out: { typecheck?: string[]; lint?: string[] } = {}
  const keys = Object.keys(scripts ?? {})
  const expand = (cmdStr: string): string[] | undefined => {
    const parts = cmdStr.split(/\s+/).filter(Boolean)
    if (parts.length === 0) return undefined
    // bunx 是 `bun x` 的别名；Windows 下无 bunx.exe，spawn 需用 ["bun","x",...]
    if (parts[0] === "bunx") return ["bun", "x", ...parts.slice(1)]
    if (parts[0] === "bun" && parts[1] === "run") return ["bun", ...parts.slice(2)]
    if (parts[0] === "npm" && parts[1] === "run") return ["npm", "run", ...parts.slice(2)]
    if (parts[0] === "pnpm") return ["pnpm", ...parts.slice(1)]
    if (parts[0] === "yarn") return ["yarn", ...parts.slice(1)]
    return parts
  }
  const typecheckKey =
    keys.find((k) => k === "typecheck") ?? keys.find((k) => /^(typecheck|type-check|tsc|check)$/.test(k))
  if (typecheckKey) {
    const cmd = expand(scripts[typecheckKey])
    if (cmd) {
      if (!cmd.includes("--noEmit")) cmd.push("--noEmit")
      out.typecheck = cmd
    }
  }
  const lintKey = keys.find((k) => k === "lint") ?? keys.find((k) => /^(lint|eslint)$/.test(k))
  if (lintKey) {
    const cmd = expand(scripts[lintKey])
    if (cmd) out.lint = cmd
  }
  return out
}

/** 把增量错误格式化为紧凑 markdown 行（🔴 typecheck / 🟡 lint），每条 ≤140 字符 */
export function formatFindings(errors: string[], kind: "typecheck" | "lint"): string[] {
  const mark = kind === "typecheck" ? "🔴" : "🟡"
  return errors.map((e) => {
    const max = 140
    const line = `${mark} ${e}`
    return line.length > max ? `${line.slice(0, max - 3)}…` : line
  })
}

// ---------------------------------------------------------------------------
// I/O：命令执行
// ---------------------------------------------------------------------------

function runCommand(cwd: string, cmd: string[], timeoutMs: number): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(cmd[0], cmd.slice(1), { cwd, shell: false, windowsHide: true })
    } catch (e) {
      resolve({ ok: false, code: null, stdout: "", stderr: String(e), timedOut: false })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child!.kill("SIGKILL")
    }, timeoutMs)
    child.stdout?.on("data", (d) => (stdout += d.toString()))
    child.stderr?.on("data", (d) => (stderr += d.toString()))
    child.on("error", () => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, stdout, stderr, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr, timedOut })
    })
  })
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export class Harness {
  private readonly opts: HarnessOptions
  private readonly cache = new Map<string, { baseline: ProjectBaseline; state: PersistedState }>()

  constructor(opts?: Partial<HarnessOptions>) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts }
  }

  private projectKey(cwd: string): string {
    return createHash("sha256").update(cwd).digest("hex").slice(0, 16)
  }

  private statePath(cwd: string): string {
    return path.join(this.opts.dataDir, `${this.projectKey(cwd)}.json`)
  }

  private loadState(cwd: string): PersistedState | null {
    try {
      const p = this.statePath(cwd)
      if (!existsSync(p)) return null
      return JSON.parse(readFileSync(p, "utf8")) as PersistedState
    } catch {
      return null
    }
  }

  private saveState(cwd: string, state: PersistedState) {
    try {
      mkdirSync(this.opts.dataDir, { recursive: true })
      const p = this.statePath(cwd)
      const tmp = `${p}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8")
      renameSync(tmp, p)
    } catch {
      /* 持久化失败不影响本次运行 */
    }
  }

  private readScripts(cwd: string): Record<string, string> {
    try {
      const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"))
      return (pkg?.scripts ?? {}) as Record<string, string>
    } catch {
      return {}
    }
  }

  private async gitHead(cwd: string): Promise<string> {
    const r = await runCommand(cwd, ["git", "rev-parse", "HEAD"], 10_000)
    return r.ok ? r.stdout.trim() : ""
  }

  /** 采集基线（幂等）：已存在则直接返回 */
  async initialize(cwd: string): Promise<ProjectBaseline> {
    const key = this.projectKey(cwd)
    const cached = this.cache.get(cwd)
    if (cached) return cached.baseline

    const state = this.loadState(cwd)
    if (state) {
      const baseline: ProjectBaseline =
        state.baseline ?? {
          projectKey: key,
          typecheckSigs: state.shownTypecheck,
          lintSigs: state.shownLint,
          gitHead: "",
          scriptsHash: "",
          createdAt: state.lastRunAt,
        }
      this.cache.set(cwd, { baseline, state })
      return baseline
    }

    const scripts = this.readScripts(cwd)
    const auto = detectAutoCommands(scripts)
    const typecheckCmd = this.opts.typecheckCmd ?? auto.typecheck ?? null
    const lintCmd = this.opts.lintCmd ?? auto.lint ?? null

    const tcSafe = typecheckCmd ? isCommandSafe(typecheckCmd, this.opts.safePrefixes) : null
    const lintSafe = lintCmd ? isCommandSafe(lintCmd, this.opts.safePrefixes) : null
    if (tcSafe && !tcSafe.safe) {
      console.warn(`[lidar-harness] initialize: skipping typecheck baseline — ${tcSafe.reason}`)
    }
    if (lintSafe && !lintSafe.safe) {
      console.warn(`[lidar-harness] initialize: skipping lint baseline — ${lintSafe.reason}`)
    }
    const [tcOut, lintOut, head] = await Promise.all([
      (typecheckCmd && tcSafe?.safe) ? runCommand(cwd, typecheckCmd, this.opts.commandTimeoutMs) : null,
      (lintCmd && lintSafe?.safe) ? runCommand(cwd, lintCmd, this.opts.commandTimeoutMs) : null,
      this.gitHead(cwd),
    ])

    const baseline: ProjectBaseline = {
      projectKey: key,
      typecheckSigs: tcOut ? parseCommandOutput(`${tcOut.stdout}\n${tcOut.stderr}`) : [],
      lintSigs: lintOut ? parseCommandOutput(`${lintOut.stdout}\n${lintOut.stderr}`) : [],
      gitHead: head,
      scriptsHash: hashScripts(scripts),
      createdAt: Date.now(),
    }
    if (typecheckCmd && !tcSafe?.safe) {
      console.warn(
        `[lidar-harness] typecheck 基线未建立（命令不安全），后续所有 typecheck 错误将被视为新增直到配置合法命令。`
      )
    }
    if (lintCmd && !lintSafe?.safe) {
      console.warn(
        `[lidar-harness] lint 基线未建立（命令不安全），后续所有 lint 错误将被视为新增直到配置合法命令。`
      )
    }
    const freshState: PersistedState = {
      projectKey: key,
      cwd,
      baseline,
      shownTypecheck: [],
      shownLint: [],
      adaptive: false,
      adaptiveTurns: 0,
      lastRunAt: Date.now(),
    }
    this.cache.set(cwd, { baseline, state: freshState })
    this.saveState(cwd, freshState)
    return baseline
  }

  /** 每轮对话结算后调用 */
  async afterTurn(evidence: TurnEvidence): Promise<VerifyOutcome> {
    const t0 = Date.now()
    const { cwd, force } = evidence
    const fallback: VerifyOutcome = {
      tier: 0,
      skipped: true,
      skipReason: "disabled",
      phaseSignals: { todoCompleted: false, gitCommit: false, gitFilesChanged: [], adaptive: false },
      newErrors: [],
      newErrorCount: 0,
      totalSeen: 0,
      converged: true,
      needsReview: false,
      baseline: await this.initialize(cwd),
      durationMs: Date.now() - t0,
    }
    if (!this.opts.enabled) return fallback

    let cached = this.cache.get(cwd)
    if (!cached) {
      await this.initialize(cwd)
      cached = this.cache.get(cwd)!
    }
    const { baseline, state } = cached

    // ---- 安全：scripts 哈希锁定 ----
    let securityAlert: string | undefined
    const scriptsNow = this.readScripts(cwd)
    if (baseline.scriptsHash && baseline.scriptsHash !== hashScripts(scriptsNow)) {
      securityAlert =
        "⚠️ 检测到 package.json scripts 在会话期间被修改（命令基线锁定被破坏）。已跳过本轮验证命令执行，防止注入的脚本被静默运行。请人工确认 scripts 变更后重新初始化基线（删除状态目录或重启 opencode）。"
    }

    // ---- Tier 0 复杂度门控 ----
    const complexity = classifyComplexity(evidence.turnText, evidence.gitFilesChanged.length, evidence.gitDiffLines, this.opts)
    const tier0Skipped = complexity === "simple" && !force
    if (tier0Skipped) {
      return {
        ...fallback,
        tier: 0,
        skipped: true,
        skipReason: `simple task (turnText=${evidence.turnText.length}ch, files=${evidence.gitFilesChanged.length}, lines=${evidence.gitDiffLines})`,
        baseline,
        durationMs: Date.now() - t0,
      }
    }

    // ---- Tier 1 阶段信号（局部回环检测）----
    const phaseSignals: PhaseSignals = {
      todoCompleted: evidence.todoCompleted,
      gitCommit: evidence.gitCommitChanged,
      gitFilesChanged: evidence.gitFilesChanged,
      adaptive: state.adaptive,
    }
    const anySignal = evidence.todoCompleted || evidence.gitCommitChanged || evidence.gitFilesChanged.length > 0

    // 自适应降级：连续 2 轮无 todo 信号 → git-only 模式
    if (!evidence.todoCompleted) {
      state.adaptiveTurns += 1
      if (state.adaptiveTurns >= 2) state.adaptive = true
    } else {
      state.adaptiveTurns = 0
    }
    phaseSignals.adaptive = state.adaptive

    const tier1Skipped = !anySignal && !state.adaptive && !force
    if (tier1Skipped) {
      return {
        ...fallback,
        tier: 1,
        skipped: true,
        skipReason: "no phase signal (no todo completion, no git commit, no file changes)",
        phaseSignals,
        baseline,
        durationMs: Date.now() - t0,
      }
    }

    // ---- 安全拦截：scripts 被篡改则不执行命令 ----
    if (securityAlert) {
      return {
        ...fallback,
        tier: 2,
        skipped: true,
        skipReason: "security: scripts hash mismatch",
        phaseSignals,
        securityAlert,
        baseline,
        durationMs: Date.now() - t0,
      }
    }

    // ---- Tier 2 全局 PGO：typecheck + lint 增量检测 ----
    const typecheckCmd = this.opts.typecheckCmd ?? detectAutoCommands(this.readScripts(cwd)).typecheck ?? null
    const lintCmd = this.opts.lintCmd ?? detectAutoCommands(this.readScripts(cwd)).lint ?? null

    let newErrors: string[] = []
    let totalSeen = state.shownTypecheck.length + state.shownLint.length

    const runCheck = async (
      cmd: string[] | null,
      baselineSigs: string[],
      shownKey: "shownTypecheck" | "shownLint",
      kind: "typecheck" | "lint",
    ): Promise<string[]> => {
      if (!cmd) return []
      const safe = isCommandSafe(cmd, this.opts.safePrefixes)
      if (!safe.safe) {
        return [`⚠️ 跳过 ${kind}：${safe.reason}`]
      }
      const r = await runCommand(cwd, cmd, this.opts.commandTimeoutMs)
      // 命令执行失败（超时、spawn 错误、非零退出）时不能静默为"已收敛"：
      // 必须上报失败，否则检查工具未运行成功却让 converged=true（fail-open）。
      if (r.timedOut) {
        return [`⚠️ ${kind} 命令超时（${this.opts.commandTimeoutMs}ms），本轮验证结果不可信`]
      }
      if (r.code === null) {
        // spawn 失败（可执行文件不存在等）
        const errMsg = r.stderr.trim().slice(0, 200) || "spawn error"
        return [`⚠️ ${kind} 命令无法启动（${errMsg}），本轮验证结果不可信`]
      }
      const parsed = parseCommandOutput(`${r.stdout}\n${r.stderr}`)
      // 非零退出且无任何可解析的错误签名：checker 可能静默失败，不能视为"无新错误"
      if (!r.ok && r.code !== null && parsed.length === 0) {
        return [
          `⚠️ ${kind} 命令以非零退出（exit ${r.code}）但无可解析输出，本轮验证结果不可信`,
        ]
      }
      const prev = new Set([...baselineSigs, ...state[shownKey]])
      const delta = computeDelta(prev, parsed)
      state[shownKey].push(...delta)
      return formatFindings(delta, kind)
    }

    const [tcDelta, lintDelta] = await Promise.all([
      runCheck(typecheckCmd, baseline.typecheckSigs, "shownTypecheck", "typecheck"),
      runCheck(lintCmd, baseline.lintSigs, "shownLint", "lint"),
    ])
    newErrors = [...tcDelta, ...lintDelta]
    totalSeen = state.shownTypecheck.length + state.shownLint.length

    state.lastRunAt = Date.now()
    this.saveState(cwd, state)

    return {
      tier: 2,
      skipped: false,
      phaseSignals,
      newErrors,
      newErrorCount: newErrors.length,
      totalSeen,
      converged: newErrors.length === 0 && !newErrors.some((e) => e.startsWith("⚠️")),
      needsReview: newErrors.length >= this.opts.noiseFloor,
      securityAlert,
      baselineIncomplete:
        (baseline.typecheckSigs.length === 0 && typecheckCmd !== null) ||
        (baseline.lintSigs.length === 0 && lintCmd !== null),
      baseline,
      durationMs: Date.now() - t0,
    }
  }

  async dispose(): Promise<void> {
    for (const [cwd, { state }] of this.cache) this.saveState(cwd, state)
    this.cache.clear()
  }
}
