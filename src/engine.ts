/**
 * lidar-harness 核心引擎 — SLAM/PGO 式多层级编码 Agent 验证
 *
 * 四层架构（映射自 README）：
 *   Tier 0  复杂度门控   —— 简单任务跳过重度验证
 *   Tier 1  局部回环检测 —— TodoWrite / git commit / git 变更 信号（含自适应 git-only 降级）
 *   Tier 2  全局 PGO     —— typecheck + lint → 错误签名归一化 → 增量注入 → 收敛
 *   Tier 3  多视角审查   —— 由胶水层（plugin）实现，本引擎仅上报 needsReview
 *
 * 安全：命令基线锁定（package.json scripts 哈希）+ safePrefixes 白名单 + 无 shell argv 执行
 *       + Windows .cmd shim 安全解析（不经过 cmd.exe 的字符串拼接，仅由 libuv 内部调用）。
 * 收敛：shown 集合单调增长（unsafe/timeout/spawn/no-output 等告警只注入一次），必然终止；
 *       检查器健康度与告警展示分离——检查器不健康的每一轮都如实标记
 *       converged=false 且 verificationIncomplete=true，不因告警去重而误判收敛。
 * 资源：输出按 Buffer 字节累计 + 上限截断，结算时用 StringDecoder 整体解码（跨 chunk UTF-8 正确）；
 *       超时强杀整棵进程树（Windows taskkill /T 检查 error/status/signal，失败回退 child.kill；
 *       POSIX 进程组），强杀失败在结果中如实标记（RunCommandResult.kill）。
 *
 * 纯 TS 实现，零运行时依赖。进程执行契约要求 **Bun 运行时**（Windows .cmd shim 安全启动
 * 依赖 Bun 的内部实现；Node.js 下 fail-fast 拒绝执行），仅使用运行时内置模块。
 */
import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs"
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
  /** 可执行文件白名单，默认覆盖常见包管理器与检查器；可按需扩展（ROS/CMake/Python） */
  safePrefixes: string[]
  /** 简单任务判定阈值 */
  simpleTask: { maxTurnChars: number; maxDiffFiles: number; maxDiffLines: number }
  /** 单条命令超时（ms），默认 120_000；超时强杀进程树 */
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

/** 超时强杀进程树的结果（如实反映 kill 是否成功） */
export interface KillTreeResult {
  /** 终止信号是否成功发出（taskkill / 进程组 kill / child.kill 任一成功） */
  ok: boolean
  /** 实际生效的终止方法 */
  method: "taskkill" | "process-group" | "child-kill"
  /** taskkill 失败原因（异常 / 被信号终止 / 非零退出；未走 taskkill 时为 undefined） */
  taskkillError?: string
  /** 回退 child.kill 失败原因（回退成功或未回退时为 undefined） */
  fallbackError?: string
}

export interface RunCommandResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** 输出超过上限被截断（可能遗漏部分错误） */
  truncated: boolean
  /** 超时强杀的详细结果（未发生强杀时为 undefined） */
  kill?: KillTreeResult
  /** 超时强杀失败（进程树可能未完全终止）；未发生强杀时为 false */
  killFailed: boolean
}

export interface ProjectBaseline {
  projectKey: string
  typecheckSigs: string[]
  lintSigs: string[]
  gitHead: string
  scriptsHash: string
  createdAt: number
  /** typecheck 基线是否成功建立（命令已运行且退出码 0 或存在可解析输出）；false = 后续错误视为新增 */
  typecheckBaselineOk: boolean
  /** lint 同上 */
  lintBaselineOk: boolean
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
  /** true = 至少一个检查的基线未成功建立（不安全/无法启动/超时/无输出），当前 newErrors 可能包含历史错误 */
  baselineIncomplete?: boolean
  /**
   * true = 本轮验证未完成：至少一个检查器不可用或结果不可信（不安全 / 无法启动 / 超时 /
   * 非零退出且无输出 / 输出截断）。与告警是否已注入无关——不健康的每一轮都如实标记，
   * 且 converged 同步为 false，绝不把失败静默当作收敛。
   */
  verificationIncomplete: boolean
  baseline: ProjectBaseline
  durationMs: number
}

/** 单检查器单轮运行结果：展示内容（告警只注入一次）与健康度（每轮如实上报）分离 */
interface CheckRunOutcome {
  /** 本轮要展示的增量错误/告警（告警只会注入一次，进入 shown 集合） */
  findings: string[]
  /** true = 检查器本轮不可用或结果不可信 */
  unhealthy: boolean
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
// 默认值与资源上限
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

/** 单条命令 stdout/stderr 各流输出上限（字节），超出截断并置 truncated */
export const MAX_OUTPUT_BYTES = 256 * 1024
/** 单次检查每轮最多注入的新错误条数；剩余部分下轮继续注入（保持收敛且不淹没上下文） */
export const MAX_NEW_PER_CHECK = 30

/**
 * 运行时契约：本引擎的进程执行**仅支持 Bun 运行时**。
 * Windows 下 .cmd/.bat shim 的启动依赖 Bun 的安全实现（不经 cmd.exe 字符串拼接）；
 * Node.js 环境不提供同等契约，因此 fail-fast 拒绝执行（不落入不安全的 ComSpec 拼接路径）。
 */
function requireBunRuntime(context: string): void {
  if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
    throw new Error(
      `[lidar-harness] ${context}：本引擎仅支持 Bun 运行时。` +
        `Windows 下 .cmd/.bat shim 的进程启动契约依赖 Bun 的安全实现；` +
        `Node.js 环境不支持（不做不安全的 ComSpec 字符串拼接）。请改用 Bun（bun test / opencode 插件）。`,
    )
  }
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
    // 时长（0.3s / 12ms / 1.2s elapsed；"in 123ms" 会先被此处归一）
    .replace(/\d+(\.\d+)?\s?(ms|s)\b/g, "DUR")
  // 位置编号：path:12:5 → path:N:N（优先匹配路径后的行:列）
  s = s.replace(/(:\d+)(:\d+)/g, ":N:N")
  // 兼容旧格式 path(12,5)
  s = s.replace(/\((\d+),(\d+)\)/g, "(N,N)")
  // 折叠空白
  s = s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, " ").trim()
  return s
}

/** 把命令输出拆成独立的错误块签名（tsc / eslint stylish / biome 三种格式）。
 *  trusted=false 表示没有位置化诊断、签名来自宽泛 fallback（任意含 error/warning 的行），
 *  此时非零退出不可被当作"已识别诊断"用于建立基线或判定 checker 健康。 */
export function parseCommandOutput(output: string): { sigs: string[]; trusted: boolean } {
  const lines = output.replace(/\r/g, "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").split("\n")
  const isSeed = (line: string): boolean => {
    const hasLoc = /(:\d+:\d+)|(\(\d+,\d+\))/.test(line)
    const hasSeverity = /error|warning|lint/i.test(line)
    if (hasLoc && hasSeverity) return true
    // eslint stylish：缩进的 "  12:5  error  msg  rule"（前一行通常为路径）
    if (/^\s+\d+:\d+\s+(error|warning)/i.test(line)) return true
    return false
  }

  const blocks: string[] = []
  let current: string[] = []
  const finalize = () => {
    if (current.length > 0) {
      blocks.push(current.join("\n"))
      current = []
    }
  }
  for (const line of lines) {
    if (isSeed(line)) {
      finalize()
      current = [line]
    } else if (current.length > 0 && current.length < 3) {
      // 延续种子块（最多 3 行，覆盖 tsc 的多行错误说明）
      current.push(line)
    } else {
      // 种子块已满或尚未开始：忽略游离行
      finalize()
    }
  }
  finalize()

  let sigs = blocks.map(normalizeErrorSignature).filter((s) => s.length > 0)
  let trusted = true
  // 兜底：没有任何位置化种子时，退回"包含 error/warning 的行"（trusted=false）
  if (sigs.length === 0) {
    sigs = lines
      .filter((l) => /error|warning/i.test(l))
      .slice(0, 20)
      .map(normalizeErrorSignature)
      .filter((s) => s.length > 0)
    trusted = false
  }
  // 去重（保持顺序）
  return { sigs: [...new Set(sigs)], trusted }
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

/** 命令白名单校验：可执行文件在 safePrefixes 内，且无 shell 元字符（含 cmd.exe 特殊字符） */
export function isCommandSafe(
  cmd: string[],
  safePrefixes: string[],
): { safe: boolean; reason?: string } {
  if (!cmd || cmd.length === 0) return { safe: false, reason: "空命令" }
  const exe = cmd[0]
  // Windows 下脚本可能写成 npm.cmd / tsc.cmd：剥掉 shim 扩展名再比对白名单
  const bare = exe.replace(/\.(exe|cmd|bat|com)$/i, "")
  if (!safePrefixes.includes(exe) && !safePrefixes.includes(bare)) {
    return { safe: false, reason: `可执行文件 "${exe}" 不在白名单 ${safePrefixes.join("/")} 内` }
  }
  for (const token of cmd) {
    // POSIX shell 元字符 + cmd.exe 特殊字符（%VAR% 展开 / ^ 转义 / " 引号）：一律拒绝，
    // 因为 Windows .cmd shim 最终会经 cmd.exe 执行，任何解释性字符都可能被利用。
    if (/[;&|><`$(){}*?\n"%^]/.test(token)) {
      return { safe: false, reason: `命令包含非法字符: ${token}` }
    }
  }
  return { safe: true }
}

/**
 * 把脚本命令字符串展开为 argv（去 shell 化）：
 *   bunx → bun x（Windows 无 bunx.exe，spawn 需用 bun x）
 *   bun run x → bun x
 *   npm run x → npm run x
 * 其余原样按空白切分。注意：这是"词法切分"，不含 shell 语义；含 shell 元字符的
 * 命令会在 isCommandSafe 处被拒绝。
 */
export function expandArgvParts(parts: string[]): string[] {
  if (parts.length === 0) return parts
  if (parts[0] === "bunx") return ["bun", "x", ...parts.slice(1)]
  if (parts[0] === "bun" && parts[1] === "run") return ["bun", ...parts.slice(2)]
  if (parts[0] === "npm" && parts[1] === "run") return ["npm", "run", ...parts.slice(2)]
  return parts
}

/** 从 package.json scripts 检测 typecheck/lint 命令并展开为 argv（自动检测会为 typecheck 追加 --noEmit） */
export function detectAutoCommands(
  scripts: Record<string, string>,
): { typecheck?: string[]; lint?: string[] } {
  const out: { typecheck?: string[]; lint?: string[] } = {}
  const keys = Object.keys(scripts ?? {})
  const expand = (cmdStr: string): string[] | undefined => {
    const parts = cmdStr.split(/\s+/).filter(Boolean)
    if (parts.length === 0) return undefined
    return expandArgvParts(parts)
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

/** 同步读取项目 package.json scripts（不存在/损坏 → {}） */
export function readPackageScripts(cwd: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"))
    const scripts = pkg?.scripts
    if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
      return scripts as Record<string, string>
    }
    return {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// I/O：命令执行（无 shell、Windows shim 安全解析、输出有界、超时杀进程树）
// ---------------------------------------------------------------------------

const WINDOWS_EXTS = [".exe", ".cmd", ".bat", ".com"] as const

/**
 * 解析可执行文件（仅用于 spawn argv[0]，绝不引入 shell）：
 * - 非 Windows：原样返回。
 * - Windows 显式路径（绝对/相对，含分隔符）：带扩展名原样放行（信任调用方，spawn 会报 ENOENT）；
 *   无扩展名按 PATHEXT 语义补 `.exe` → `.cmd` → `.bat` → `.com`（校验存在）。
 * - Windows 裸名：在 PATH 中逐个目录按同样语义查找并校验存在；找不到返回 null。
 * 返回 .cmd/.bat shim 时由 libuv 内部经 cmd.exe 执行——但参数已通过 isCommandSafe
 * 校验（无任何 shell/cmd 特殊字符），不存在注入面。
 */
export function resolveExecutable(
  exe: string,
  platform: NodeJS.Platform = process.platform,
  envPath: string = process.env.PATH ?? "",
): string | null {
  if (!exe) return null
  if (platform !== "win32") return exe
  const hasWinExt = /\.(exe|cmd|bat|com)$/i.test(exe)
  if (path.isAbsolute(exe) || exe.includes("/") || exe.includes("\\")) {
    if (hasWinExt) return exe
    for (const ext of WINDOWS_EXTS) {
      if (existsSync(exe + ext)) return exe + ext
    }
    return null
  }
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, exe)
    if (hasWinExt) {
      if (existsSync(candidate)) return candidate
    } else {
      for (const ext of WINDOWS_EXTS) {
        if (existsSync(candidate + ext)) return candidate + ext
      }
    }
  }
  return null
}

/** 尝试给子进程发送终止信号；返回是否成功发出（不抛异常） */
function tryChildKill(child: ChildProcess): boolean {
  try {
    return child.kill("SIGKILL")
  } catch {
    return false
  }
}

/**
 * 超时强杀整棵进程树，并**如实返回结果**：
 * - Windows：taskkill /PID <pid> /T /F，检查 spawnSync 的 error / signal / status；
 *   任何异常（无法启动、被信号终止、非零退出）→ 回退 child.kill（只杀直接子进程）。
 * - POSIX：杀进程组（spawn 时 detached）；失败回退 child.kill。
 * ok=false 表示进程树可能未完全终止（调用方应反映在结果里）。
 */
export function killProcessTree(
  child: ChildProcess,
  spawnSyncImpl: typeof spawnSync = spawnSync,
): KillTreeResult {
  if (!child.pid) {
    const ok = tryChildKill(child)
    return {
      ok,
      method: "child-kill",
      ...(ok ? {} : { fallbackError: "进程无 pid 且 child.kill 失败" }),
    }
  }
  if (process.platform === "win32") {
    let res: { error?: Error; status: number | null; signal: NodeJS.Signals | null }
    try {
      const r = spawnSyncImpl("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true })
      res = { error: r.error, status: r.status, signal: r.signal }
    } catch (e) {
      res = { error: e as Error, status: null, signal: null }
    }
    if (!res.error && res.signal === null && res.status === 0) {
      return { ok: true, method: "taskkill" }
    }
    const taskkillError = res.error
      ? String(res.error)
      : res.signal !== null
        ? `taskkill 被信号 ${res.signal} 终止`
        : `taskkill 退出码 ${res.status}`
    const ok = tryChildKill(child)
    return {
      ok,
      method: "child-kill",
      taskkillError,
      ...(ok ? {} : { fallbackError: "child.kill 失败" }),
    }
  }
  try {
    process.kill(-child.pid, "SIGKILL")
    return { ok: true, method: "process-group" }
  } catch (e) {
    const ok = tryChildKill(child)
    return {
      ok,
      method: "child-kill",
      fallbackError: ok ? undefined : `进程组 kill 失败（${String(e)}）且 child.kill 失败`,
    }
  }
}

/**
 * 有界输出收集器：按 Buffer **字节**累计（上限 maxBytes），结算时用 StringDecoder
 * 一次性整体解码——跨 chunk 的多字节 UTF-8 序列不会损坏。
 */
export class OutputCollector {
  private chunks: Buffer[] = []
  private bytes = 0
  private readonly decoder = new StringDecoder("utf8")
  /** 输出超过字节上限（部分数据被丢弃） */
  truncated = false

  constructor(private readonly maxBytes: number) {}

  /** 已累计的字节数 */
  get byteLength(): number {
    return this.bytes
  }

  push(data: Buffer | string): void {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data
    if (buf.length === 0) return
    if (this.bytes >= this.maxBytes) {
      this.truncated = true
      return
    }
    let take = buf
    if (this.bytes + buf.length > this.maxBytes) {
      this.truncated = true
      take = buf.subarray(0, this.maxBytes - this.bytes)
    }
    this.chunks.push(take)
    this.bytes += take.length
  }

  /** 结算：拼接全部 chunk 后整体解码（调用后即视为结束，不可复用）。
   *  截断点可能落在多字节字符中间：截断时用 write（未完成的尾字节被丢弃），
   *  不产生 U+FFFD 替换字符；完整时用 end 冲刷。 */
  toString(): string {
    const all = Buffer.concat(this.chunks)
    if (this.truncated) {
      return this.decoder.write(all)
    }
    return this.decoder.end(all)
  }
}

export function runCommand(cwd: string, cmd: string[], timeoutMs: number): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    try {
      requireBunRuntime("runCommand")
    } catch (e) {
      reject(e)
      return
    }
    if (!cmd || cmd.length === 0) {
      resolve({ ok: false, code: null, stdout: "", stderr: "空命令", timedOut: false, truncated: false, killFailed: false })
      return
    }
    const exe = resolveExecutable(cmd[0])
    if (!exe) {
      resolve({
        ok: false,
        code: null,
        stdout: "",
        stderr: `可执行文件 "${cmd[0]}" 未找到（PATH 解析失败）`,
        timedOut: false,
        truncated: false,
        killFailed: false,
      })
      return
    }

    const stdoutCol = new OutputCollector(MAX_OUTPUT_BYTES)
    const stderrCol = new OutputCollector(MAX_OUTPUT_BYTES)
    let timedOut = false
    let killResult: KillTreeResult | undefined
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let killFallback: ReturnType<typeof setTimeout> | undefined

    /** 唯一结算点：只在结算时才把 Buffer 一次性解码为字符串 */
    const finish = (r: Omit<RunCommandResult, "kill" | "killFailed">): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killFallback) clearTimeout(killFallback)
      resolve({ ...r, kill: killResult, killFailed: killResult !== undefined && !killResult.ok })
    }

    const collect = (into: OutputCollector) => (d: Buffer) => into.push(d)

    let child: ChildProcess
    try {
      child = spawn(exe, cmd.slice(1), {
        cwd,
        shell: false,
        windowsHide: true,
        // POSIX：独立进程组以便超时杀整棵树；Windows 用 taskkill /T 杀树，不 detach 避免孤儿
        detached: process.platform !== "win32",
      })
    } catch (e) {
      finish({ ok: false, code: null, stdout: "", stderr: String(e), timedOut: false, truncated: false })
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      killResult = killProcessTree(child)
      // 兜底：即便强杀失败也不挂起验证流程（3s 后强制结算）
      killFallback = setTimeout(() => {
        // 进程仍未退出：如实标记强杀失败（已发出信号但未生效 / 未发出信号）
        if (child.exitCode === null && child.signalCode === null) {
          if (!killResult) {
            killResult = { ok: false, method: "child-kill", fallbackError: "进程在超时后 3s 内未退出" }
          } else if (killResult.ok) {
            killResult = { ...killResult, ok: false, fallbackError: "kill 已发出但进程 3s 内未退出" }
          }
        }
        finish({
          ok: false,
          code: null,
          stdout: stdoutCol.toString(),
          stderr: stderrCol.toString(),
          timedOut,
          truncated: stdoutCol.truncated || stderrCol.truncated,
        })
      }, 3_000)
    }, timeoutMs)

    child.stdout?.on("data", collect(stdoutCol))
    child.stderr?.on("data", collect(stderrCol))
    child.on("error", (err) => {
      finish({
        ok: false,
        code: null,
        stdout: stdoutCol.toString(),
        stderr: stderrCol.toString() || String(err),
        timedOut,
        truncated: stdoutCol.truncated || stderrCol.truncated,
      })
    })
    child.on("close", (code) => {
      finish({
        ok: code === 0,
        code,
        stdout: stdoutCol.toString(),
        stderr: stderrCol.toString(),
        timedOut,
        truncated: stdoutCol.truncated || stderrCol.truncated,
      })
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
    requireBunRuntime("Harness")
    this.opts = { ...DEFAULT_OPTIONS, ...opts }
    // 规范化显式命令（bunx → bun x 等跨平台展开）；显式配置不追加 --noEmit（由用户负责）
    if (this.opts.typecheckCmd) {
      this.opts.typecheckCmd = expandArgvParts([...this.opts.typecheckCmd])
    }
    if (this.opts.lintCmd) {
      this.opts.lintCmd = expandArgvParts([...this.opts.lintCmd])
    }
  }

  /** 当前生效的可执行文件白名单（供胶水层复用，保持与引擎一致） */
  get configuredSafePrefixes(): string[] {
    return [...this.opts.safePrefixes]
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
    return readPackageScripts(cwd)
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
      const baseline: ProjectBaseline = state.baseline ?? {
        projectKey: key,
        typecheckSigs: state.shownTypecheck,
        lintSigs: state.shownLint,
        gitHead: "",
        scriptsHash: "",
        createdAt: state.lastRunAt,
        typecheckBaselineOk: false,
        lintBaselineOk: false,
      }
      if (!state.baseline || !baseline.scriptsHash) {
        // legacy/损坏状态：缺少命令基线 → fail-safe，后续轮次会安全告警并拒绝执行命令
        console.warn(
          `[lidar-harness] 检测到 legacy/损坏状态（缺少 scripts 命令基线）。` +
            `后续轮次将发出安全告警并跳过验证命令，直到状态目录被重置（删除 ${this.statePath(cwd)}）。`,
        )
      } else if (baseline.typecheckBaselineOk === undefined || baseline.lintBaselineOk === undefined) {
        // 旧版本状态缺少"基线是否成功建立"标记：按未建立处理（fail-safe，显式提示重新初始化）
        baseline.typecheckBaselineOk = false
        baseline.lintBaselineOk = false
        console.warn(
          `[lidar-harness] 状态文件缺少基线完整性标记（旧版本）。` +
            `已按"基线未建立"处理；如不希望历史错误被当作新增，请删除 ${this.statePath(cwd)} 后重新初始化。`,
        )
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
      typecheckCmd && tcSafe?.safe ? runCommand(cwd, typecheckCmd, this.opts.commandTimeoutMs) : null,
      lintCmd && lintSafe?.safe ? runCommand(cwd, lintCmd, this.opts.commandTimeoutMs) : null,
      this.gitHead(cwd),
    ])

    // 基线可信条件：命令确实运行、未被超时强杀、输出未被截断、可执行文件成功启动（code 非 null）。
    // 任一不满足 → 拒绝把"部分输出"当作基线（超时/截断/启动失败都可能只吐出一部分错误，
    // 把残缺签名锁进基线会让后续真实错误被静默吞掉）。
    const tcReliable = !!tcOut && !tcOut.timedOut && !tcOut.truncated && tcOut.code !== null
    const lintReliable = !!lintOut && !lintOut.timedOut && !lintOut.truncated && lintOut.code !== null
    const tcParsed = tcOut && tcReliable ? parseCommandOutput(`${tcOut.stdout}\n${tcOut.stderr}`) : { sigs: [] as string[], trusted: false }
    const lintParsed = lintOut && lintReliable ? parseCommandOutput(`${lintOut.stdout}\n${lintOut.stderr}`) : { sigs: [] as string[], trusted: false }
    const tcSigs = tcParsed.sigs
    const lintSigs = lintParsed.sigs
    // 基线成功 = 运行可信 且（退出码 0 或存在可信的位置化诊断输出，即预存错误被正确采集）
    const tcBaselineOk = !!tcOut && tcReliable && (tcOut.ok || (tcParsed.trusted && tcSigs.length > 0))
    const lintBaselineOk = !!lintOut && lintReliable && (lintOut.ok || (lintParsed.trusted && lintSigs.length > 0))

    if (typecheckCmd && !tcBaselineOk) {
      const why = !tcOut
        ? "命令不安全或未运行"
        : tcOut.timedOut
          ? "命令超时（部分输出已拒绝）"
          : tcOut.truncated
            ? "输出截断（部分输出已拒绝）"
            : tcOut.code === null
              ? "命令无法启动"
              : "无输出"
      console.warn(
        `[lidar-harness] typecheck 基线未建立（${why}），` +
          `后续所有 typecheck 错误将被视为新增直到基线成功建立。`,
      )
    }
    if (lintCmd && !lintBaselineOk) {
      const why = !lintOut
        ? "命令不安全或未运行"
        : lintOut.timedOut
          ? "命令超时（部分输出已拒绝）"
          : lintOut.truncated
            ? "输出截断（部分输出已拒绝）"
            : lintOut.code === null
              ? "命令无法启动"
              : "无输出"
      console.warn(
        `[lidar-harness] lint 基线未建立（${why}），` +
          `后续所有 lint 错误将被视为新增直到基线成功建立。`,
      )
    }

    const baseline: ProjectBaseline = {
      projectKey: key,
      typecheckSigs: tcSigs,
      lintSigs: lintSigs,
      gitHead: head,
      scriptsHash: hashScripts(scripts),
      createdAt: Date.now(),
      typecheckBaselineOk: tcBaselineOk,
      lintBaselineOk: lintBaselineOk,
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

    if (!this.opts.enabled) {
      // 关闭时不执行任何命令（含基线采集）
      const baseline =
        this.cache.get(cwd)?.baseline ?? {
          projectKey: this.projectKey(cwd),
          typecheckSigs: [],
          lintSigs: [],
          gitHead: "",
          scriptsHash: "",
          createdAt: 0,
          typecheckBaselineOk: false,
          lintBaselineOk: false,
        }
      return {
        tier: 0,
        skipped: true,
        skipReason: "disabled",
        phaseSignals: { todoCompleted: false, gitCommit: false, gitFilesChanged: [], adaptive: false },
        newErrors: [],
        newErrorCount: 0,
        totalSeen: 0,
        converged: true,
        needsReview: false,
        verificationIncomplete: false,
        baseline,
        durationMs: Date.now() - t0,
      }
    }

    let cached = this.cache.get(cwd)
    if (!cached) {
      await this.initialize(cwd)
      cached = this.cache.get(cwd)!
    }
    const { baseline, state } = cached
    const totalSeen = () => state.shownTypecheck.length + state.shownLint.length

    // ---- 安全：scripts 哈希锁定（含 legacy/损坏状态 fail-safe） ----
    let securityAlert: string | undefined
    const scriptsNow = this.readScripts(cwd)
    if (!baseline.scriptsHash) {
      securityAlert =
        "⚠️ 状态文件缺少命令基线（scripts 哈希为空：legacy/损坏状态）。为防止会话期间被注入的脚本被静默运行，" +
        "本轮已跳过验证命令。请删除该项目的状态文件或重启 opencode 重新初始化基线后继续。"
    } else if (baseline.scriptsHash !== hashScripts(scriptsNow)) {
      securityAlert =
        "⚠️ 检测到 package.json scripts 在会话期间被修改（命令基线锁定被破坏）。已跳过本轮验证命令执行，防止注入的脚本被静默运行。请人工确认 scripts 变更后重新初始化基线（删除状态目录或重启 opencode）。"
    }

    // ---- Tier 0 复杂度门控 ----
    const complexity = classifyComplexity(evidence.turnText, evidence.gitFilesChanged.length, evidence.gitDiffLines, this.opts)
    const tier0Skipped = complexity === "simple" && !force
    if (tier0Skipped) {
      return {
        tier: 0,
        skipped: true,
        skipReason: `simple task (turnText=${evidence.turnText.length}ch, files=${evidence.gitFilesChanged.length}, lines=${evidence.gitDiffLines})`,
        phaseSignals: { todoCompleted: false, gitCommit: false, gitFilesChanged: [], adaptive: state.adaptive },
        newErrors: [],
        newErrorCount: 0,
        totalSeen: totalSeen(),
        converged: true,
        needsReview: false,
        verificationIncomplete: false,
        securityAlert,
        baseline,
        durationMs: Date.now() - t0,
      }
    }

    // ---- Tier 1 阶段信号（局部回环检测）----
    const gitSignal = evidence.gitCommitChanged || evidence.gitFilesChanged.length > 0
    const todoSignal = evidence.todoCompleted

    // 自适应降级：连续 2 轮无 todo 信号 → git-only 模式（与 README 一致）
    if (!todoSignal) {
      state.adaptiveTurns += 1
      if (state.adaptiveTurns >= 2) state.adaptive = true
    } else {
      state.adaptiveTurns = 0
    }

    const phaseSignals: PhaseSignals = {
      todoCompleted: todoSignal,
      gitCommit: evidence.gitCommitChanged,
      gitFilesChanged: evidence.gitFilesChanged,
      adaptive: state.adaptive,
    }
    // git-only 模式下仅认可 git 信号；无 git 信号 → 跳过验证（README：2 轮无 todo 且无 git 信号 → 跳过）
    const anySignal = state.adaptive ? gitSignal : todoSignal || gitSignal
    const tier1Skipped = !anySignal && !force
    if (tier1Skipped) {
      return {
        tier: 1,
        skipped: true,
        skipReason: state.adaptive
          ? "no git signal (adaptive git-only mode)"
          : "no phase signal (no todo completion, no git commit, no file changes)",
        phaseSignals,
        newErrors: [],
        newErrorCount: 0,
        totalSeen: totalSeen(),
        converged: true,
        needsReview: false,
        verificationIncomplete: false,
        securityAlert,
        baseline,
        durationMs: Date.now() - t0,
      }
    }

    // ---- 安全拦截：基线缺失或 scripts 被篡改则不执行命令 ----
    if (securityAlert) {
      return {
        tier: 2,
        skipped: true,
        skipReason: "security: baseline lock",
        phaseSignals,
        newErrors: [],
        newErrorCount: 0,
        totalSeen: totalSeen(),
        converged: false,
        needsReview: false,
        verificationIncomplete: true,
        securityAlert,
        baseline,
        durationMs: Date.now() - t0,
      }
    }

    // ---- Tier 2 全局 PGO：typecheck + lint 增量检测 ----
    const scripts = this.readScripts(cwd)
    const auto = detectAutoCommands(scripts)
    const typecheckCmd = this.opts.typecheckCmd ?? auto.typecheck ?? null
    const lintCmd = this.opts.lintCmd ?? auto.lint ?? null

    /** 把告警推入 shown 集合（只出现一次，保持收敛）并返回其展示形式 */
    const warnOnce = (shown: string[], msg: string): string[] => {
      if (shown.includes(msg)) return []
      shown.push(msg)
      return [msg]
    }

    const runCheck = async (
      cmd: string[] | null,
      baselineSigs: string[],
      shownKey: "shownTypecheck" | "shownLint",
      kind: "typecheck" | "lint",
    ): Promise<CheckRunOutcome> => {
      if (!cmd) return { findings: [], unhealthy: false }
      const shown = state[shownKey]
      const safe = isCommandSafe(cmd, this.opts.safePrefixes)
      if (!safe.safe) {
        // 告警只注入一次（进入 shown），但健康度每轮都如实上报为不健康
        return { findings: warnOnce(shown, `⚠️ 跳过 ${kind}：${safe.reason}`), unhealthy: true }
      }
      const r = await runCommand(cwd, cmd, this.opts.commandTimeoutMs)
      // 命令执行失败（超时、spawn 错误、非零退出且无输出）不能静默为"已收敛"：
      // 告警只注入一次避免刷屏，但 converged=false / verificationIncomplete=true 每轮持续。
      if (r.timedOut) {
        return {
          findings: warnOnce(
            shown,
            `⚠️ ${kind} 命令超时（${this.opts.commandTimeoutMs}ms），已尝试终止进程树，本轮验证结果不可信`,
          ),
          unhealthy: true,
        }
      }
      if (r.code === null) {
        // spawn 失败（可执行文件不存在等）
        const errMsg = r.stderr.trim().slice(0, 200) || "spawn error"
        return {
          findings: warnOnce(shown, `⚠️ ${kind} 命令无法启动（${errMsg}），本轮验证结果不可信`),
          unhealthy: true,
        }
      }
      const parsed = parseCommandOutput(`${r.stdout}\n${r.stderr}`)
      // 非零退出且无可信诊断：位置化签名缺失或只有宽泛 fallback 文本 → 本轮不可信，
      // 不能视为"无新错误"，也不得据此建立基线（工具链/配置错误会误报收敛）。
      if (!r.ok && (!parsed.trusted || parsed.sigs.length === 0)) {
        const why = parsed.sigs.length === 0
          ? `无可解析输出`
          : `输出仅含非位置化错误文本（无法确认为真实诊断）`
        return {
          findings: warnOnce(
            shown,
            `⚠️ ${kind} 命令以非零退出（exit ${r.code}）但${why}，本轮验证结果不可信`,
          ),
          unhealthy: true,
        }
      }
      const prev = new Set([...baselineSigs, ...shown])
      const delta = computeDelta(prev, parsed.sigs)
      // 单轮注入上限：超出的部分留在下轮继续以"新错误"出现（单调 shown 仍保证收敛）
      const shownDelta = delta.slice(0, MAX_NEW_PER_CHECK)
      shown.push(...shownDelta)
      const findings = formatFindings(shownDelta, kind)
      if (r.truncated) {
        // 截断可能遗漏错误：告警只注入一次，但健康度每轮不健康
        findings.push(
          ...warnOnce(shown, `⚠️ ${kind} 输出超过上限被截断（可能有遗漏的错误未被检测到）`),
        )
        return { findings, unhealthy: true }
      }
      return { findings, unhealthy: false }
    }

    const [tcRes, lintRes] = await Promise.all([
      runCheck(typecheckCmd, baseline.typecheckSigs, "shownTypecheck", "typecheck"),
      runCheck(lintCmd, baseline.lintSigs, "shownLint", "lint"),
    ])
    const newErrors = [...tcRes.findings, ...lintRes.findings]
    const verificationIncomplete = tcRes.unhealthy || lintRes.unhealthy

    state.lastRunAt = Date.now()
    this.saveState(cwd, state)

    return {
      tier: 2,
      skipped: false,
      phaseSignals,
      newErrors,
      newErrorCount: newErrors.length,
      totalSeen: totalSeen(),
      // 收敛 = 无新增展示内容 **且** 本轮验证完整可信；检查器持续故障时每轮都如实不收敛
      converged: newErrors.length === 0 && !verificationIncomplete,
      needsReview: newErrors.length >= this.opts.noiseFloor,
      securityAlert,
      verificationIncomplete,
      baselineIncomplete:
        (typecheckCmd !== null && baseline.typecheckBaselineOk !== true) ||
        (lintCmd !== null && baseline.lintBaselineOk !== true),
      baseline,
      durationMs: Date.now() - t0,
    }
  }

  async dispose(): Promise<void> {
    for (const [cwd, { state }] of this.cache) this.saveState(cwd, state)
    this.cache.clear()
  }
}
