/**
 * lidar-harness — opencode 插件胶水层
 *
 * 把 SLAM/PGO 式多层级验证引擎（src/engine.ts）挂接到 opencode 会话：
 *   - 每轮对话结算（session idle）后自动触发验证
 *   - Tier 0 复杂度门控 / Tier 1 阶段信号 / Tier 2 typecheck+lint 增量注入 / Tier 3 多视角审查
 *   - 只注入"新"错误（增量），错误签名归一化后与基线 + 已展示集合求差
 *   - 收敛保证：shown 集合单调增长
 *
 * 安装：将本目录注册到 opencode.json 的 plugin 数组，例如
 *   "plugin": ["./lidar-harness/plugin.ts"]
 * 相对路径以声明该配置的文件所在目录为基准（全局配置即 ~/.config/opencode/）。
 */
import { tool, type Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { spawn } from "node:child_process"
import * as path from "node:path"
import * as os from "node:os"
import { Harness, isCommandSafe, type TurnEvidence, type VerifyOutcome } from "./src/engine.ts"

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface HarnessPluginOptions {
  /** 总开关，默认 true */
  enabled?: boolean
  /** Tier 3 多视角子会话审查，默认 true */
  tier3?: boolean
  /** 新错误数 ≥ noiseFloor 时才触发 Tier 3，默认 3 */
  noiseFloor?: number
  /** typecheck 命令，null = 自动从 package.json scripts 检测 */
  typecheckCmd?: string[] | null
  /** lint 命令，null = 自动检测 */
  lintCmd?: string[] | null
  /** 三个审查视角的提示词模板（用 {errors} / {files} 占位） */
  reviewPrompts?: {
    safety?: string
    correctness?: string
    style?: string
  }
  /** 状态持久化目录 */
  dataDir?: string
}

const SLAM_PROTOCOL = `## SLAM 验证协议（LiDAR Harness）
- 每个阶段完成（TodoWrite 标记 completed / git 提交 / 文件变更）后视为一次"闭环"。
- 完成阶段后用 Read 复查你刚刚修改过的文件，确认符合该阶段目标；发现偏离即记录。
- 修正偏离时只收紧当前阶段产生的错误（PGO 局部收紧），不要回退到任务起点，不要重做未受影响的已完成阶段。
- 收到 LiDAR Harness 验证报告时：先修复报告中列出的错误，再继续后续工作；不要对报告之外做无谓重构。
- 同一阶段连续 3 次收紧仍有新错误 → 停止并向用户报告，请求人工干预。`

const DEFAULT_REVIEW_PROMPTS = {
  safety: `你是「安全审查员」。审查以下变更与错误，只关注安全问题：命令注入、路径穿越、敏感信息泄露、不安全的输入处理、权限绕过、危险 shell 操作。对每个发现给出：严重度(高/中/低) + 一句话理由 + 修复建议(一行)。若无安全问题，直接说"无"。总输出 ≤ 10 行，用紧凑 markdown。`,
  correctness: `你是「正确性审查员」。审查以下变更与错误，只关注逻辑正确性：边界条件、异步竞态、空值处理、错误处理路径、类型不符导致的行为偏差、算法错误。对每个发现给出：严重度(高/中/低) + 一句话理由 + 修复建议(一行)。若无问题，直接说"无"。总输出 ≤ 10 行，用紧凑 markdown。`,
  style: `你是「风格审查员」。审查以下变更与错误，只关注代码风格与可维护性：命名、重复代码、过深的嵌套、魔法数字、缺少注释、与项目现有风格不一致。对每个发现给出：严重度(高/中/低) + 一句话理由 + 修复建议(一行)。若无问题，直接说"无"。总输出 ≤ 10 行，用紧凑 markdown。`,
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** SDK 返回可能是 { data: T } 包装，也可能是裸 T；统一解包 */
function unwrap<T>(r: T | { data: T }): T {
  const v = r as { data?: unknown }
  return (v && typeof v === "object" && "data" in v ? (v.data as T) : r) as T
}

function runGit(cwd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    let out = ""
    let err = ""
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, timeoutMs)
    child.stdout.on("data", (d) => (out += d.toString()))
    child.stderr.on("data", (d) => (err += d.toString()))
    child.on("error", () => resolve(""))
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? out : "")
    })
  })
}

function runCommand(cwd: string, cmd: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let out = ""
    let err = ""
    const child = spawn(cmd[0], cmd.slice(1), { cwd, shell: false, windowsHide: true })
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout.on("data", (d) => (out += d.toString()))
    child.stderr.on("data", (d) => (err += d.toString()))
    child.on("error", () => resolve({ ok: false, output: "" }))
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output: `${out}\n${err}` })
    })
  })
}

/** 从 assistant 消息的 tool parts 中提取 TodoWrite 输入里的 todos */
function extractTodos(input: unknown): Array<{ id: string; status: string }> {
  const list: Array<{ id: string; status: string }> = []
  const obj = (input ?? {}) as { todos?: unknown; todo?: unknown }
  const collect = (t: unknown) => {
    const todo = t as { id?: unknown; status?: unknown }
    if (todo && typeof todo === "object" && todo.id) {
      list.push({ id: String(todo.id), status: String(todo.status ?? "pending") })
    }
  }
  if (Array.isArray(obj.todos)) obj.todos.forEach(collect)
  else if (obj.todo) collect(obj.todo)
  return list
}

function summarizeText(parts: Array<{ type: string; text?: string }>): string {
  return (parts ?? [])
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n")
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export const lidarHarness: Plugin = async ({ client }, options = {}) => {
  const opts: HarnessPluginOptions = { enabled: true, tier3: true, noiseFloor: 3, ...options }
  const dataDir =
    opts.dataDir ?? path.join(os.homedir(), ".local", "share", "opencode", "lidar-harness")
  const harness = new Harness({
    enabled: opts.enabled,
    typecheckCmd: opts.typecheckCmd ?? null,
    lintCmd: opts.lintCmd ?? null,
    noiseFloor: opts.noiseFloor ?? 3,
    dataDir,
  })

  const reviewPrompts = { ...DEFAULT_REVIEW_PROMPTS, ...opts.reviewPrompts }

  // per-session 运行时状态
  const sessionState = new Map<
    string,
    {
      cwd: string
      baselineHead: string
      inFlight: boolean
      lastRunAt: number
      todoStatus: Map<string, string>
    }
  >()

  function getState(sessionID: string) {
    let s = sessionState.get(sessionID)
    if (!s) {
      s = { cwd: "", baselineHead: "", inFlight: false, lastRunAt: 0, todoStatus: new Map() }
      sessionState.set(sessionID, s)
    }
    return s
  }

  async function getSessionCwd(sessionID: string): Promise<string> {
    try {
      const r = await client.session.get({ path: { id: sessionID } })
      const s = unwrap(r) as { directory?: string; info?: { directory?: string } }
      return s.directory ?? s.info?.directory ?? ""
    } catch {
      return ""
    }
  }

  /** 收集 Tier 2 需要的证据（git + todo + 最近用户消息文本） */
  async function collectEvidence(
    sessionID: string,
    cwd: string,
    baselineHead: string,
    force: boolean,
  ): Promise<TurnEvidence> {
    const st = getState(sessionID)

    // git 信号
    let gitCommitChanged = false
    let gitFilesChanged: string[] = []
    let gitDiffLines = 0
    const head = (await runGit(cwd, ["rev-parse", "HEAD"])).trim()
    if (head) {
      gitCommitChanged = baselineHead !== "" && head !== baselineHead
      const base = baselineHead || head
      const changed = await runGit(cwd, ["diff", "--name-only", base])
      gitFilesChanged = changed.split(/\r?\n/).filter(Boolean)
      const untracked = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"])
      gitFilesChanged.push(...untracked.split(/\r?\n/).filter(Boolean))
      const numstat = await runGit(cwd, ["diff", "--numstat", base])
      for (const line of numstat.split(/\r?\n/)) {
        const m = line.match(/^(\d+)\s+(\d+)/)
        if (m) gitDiffLines += Number(m[1]) + Number(m[2])
      }
    }

    // todo 信号：解析 TodoWrite 工具调用中的 in_progress → completed 转变
    let todoCompleted = false
    try {
      const msgs = unwrap(await client.session.messages({ path: { id: sessionID } })) as Array<{
        info: { role?: string }
        parts: Array<{ type: string; tool?: string; input?: unknown }>
      }>
      for (const m of msgs) {
        if (m.info?.role !== "assistant") continue
        for (const p of m.parts ?? []) {
          if (p.type !== "tool" || !/todo/i.test(p.tool ?? "")) continue
          for (const t of extractTodos(p.input)) {
            const prev = st.todoStatus.get(t.id)
            if (prev === "in_progress" && t.status === "completed") todoCompleted = true
            st.todoStatus.set(t.id, t.status)
          }
        }
      }
    } catch {
      /* todo 检测失败不影响 git 信号 */
    }

    // 复杂度门控用文本：最近一条 user 消息
    let turnText = ""
    try {
      const msgs = unwrap(await client.session.messages({ path: { id: sessionID } })) as Array<{
        info: { role?: string }
        parts: Array<{ type: string; text?: string }>
      }>
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].info?.role === "user") {
          turnText = summarizeText(msgs[i].parts ?? [])
          break
        }
      }
    } catch {
      /* 忽略 */
    }

    return {
      cwd,
      turnText,
      todoCompleted,
      gitCommitChanged,
      gitFilesChanged,
      gitDiffLines,
      force,
    }
  }

  /** 注入一条 user 消息（synthetic，不触发模型回复） */
  async function inject(sessionID: string, text: string) {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text, synthetic: true }],
        },
      })
    } catch (e) {
      console.error("[lidar-harness] inject failed:", e)
    }
  }

  /** 构建注入报告 */
  function buildReport(o: VerifyOutcome): string {
    const lines: string[] = []
    if (o.securityAlert) {
      lines.push(`## 🧭 LiDAR Harness · 安全告警`, ``, o.securityAlert, ``)
    }
    if (o.newErrors.length > 0) {
      lines.push(
        `## 🧭 LiDAR Harness · Tier 2 验证报告（增量 ${o.newErrorCount} 个新错误）`,
        ``,
        `请修复以下错误，仅修正当前阶段范围：`,
        ``,
        ...o.newErrors.map((e) => `- ${e}`),
        ``,
      )
    }
    return lines.join("\n")
  }

  /** Tier 3：并行 3 个一次性 review 会话，合并结果 */
  async function runTier3(cwd: string, o: VerifyOutcome): Promise<string> {
    const files = (o.phaseSignals?.gitFilesChanged ?? []).slice(0, 15).join("\n") || "(无文件变更)"
    const errors = o.newErrors.slice(0, 20).join("\n")
    const roles: Array<[string, string]> = [
      ["安全", reviewPrompts.safety!],
      ["正确性", reviewPrompts.correctness!],
      ["风格", reviewPrompts.style!],
    ]
    const results = await Promise.allSettled(
      roles.map(async ([name, role]) => {
        const promptText = `${role}\n\n项目目录: ${cwd}\n\n变更文件:\n${files}\n\n验证发现的新错误:\n${errors}\n\n请给出你的审查结论。`
        const created = await client.session.create({
          body: { title: `lidar-review-${name}` },
        })
        const session = unwrap(created) as { id: string }
        try {
          const res = await client.session.prompt({
            path: { id: session.id },
            body: { parts: [{ type: "text", text: promptText }] },
          })
          const data = unwrap(res) as { info?: { text?: string }; parts?: Array<{ type: string; text?: string }> }
          return `- **${name}审查**: ${(data.info?.text ?? summarizeText((data.parts ?? []) as Array<{ type: string; text?: string }>)).trim().split("\n").slice(0, 10).join("\n  ")}`
        } finally {
          try {
            await client.session.delete({ path: { id: session.id } })
          } catch {
            /* 清理失败可忽略 */
          }
        }
      }),
    )
    const ok = results.filter((r) => r.status === "fulfilled" && r.value)
    if (ok.length === 0) return ""
    return [
      `## 🔍 Tier 3 多视角审查（3 个独立 Reviewer）`,
      ``,
      ...ok.map((r) => (r as PromiseFulfilledResult<string>).value),
      ``,
    ].join("\n")
  }

  /** 单轮验证主流程（防重入 + 节流） */
  async function runVerification(sessionID: string, force = false) {
    if (!opts.enabled) return
    const st = getState(sessionID)
    if (st.inFlight) return
    const now = Date.now()
    if (!force && now - st.lastRunAt < 5_000) return
    st.inFlight = true
    try {
      const cwd = st.cwd || (await getSessionCwd(sessionID))
      if (!cwd) return
      st.cwd = cwd

      const baseline = await harness.initialize(cwd)
      st.baselineHead = baseline.gitHead
      const evidence = await collectEvidence(sessionID, cwd, baseline.gitHead, force)
      const outcome = await harness.afterTurn(evidence)
      st.lastRunAt = Date.now()

      if (outcome.skipped && !outcome.securityAlert && outcome.newErrors.length === 0) return

      let report = buildReport(outcome)
      if (outcome.newErrorCount >= (opts.noiseFloor ?? 3) && opts.tier3 && !outcome.securityAlert) {
        const review = await runTier3(cwd, outcome)
        if (review) report += `\n${review}`
      }
      if (report.trim()) await inject(sessionID, report)
    } catch (e) {
      console.error("[lidar-harness] verification failed:", e)
    } finally {
      st.inFlight = false
    }
  }

  return {
    event: async ({ event }: { event: Event }) => {
      const { type, properties } = event as Event & { properties?: Record<string, any> }
      const p = properties ?? {}
      if (type === "session.status") {
        if (p.status?.type === "idle" && p.sessionID) void runVerification(String(p.sessionID))
      } else if (type === "session.idle") {
        if (p.sessionID) void runVerification(String(p.sessionID))
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(SLAM_PROTOCOL)
    },

    tool: {
      lidar_verify: tool({
        description:
          "立即运行 LiDAR Harness 验证（typecheck + lint 增量检测），报告相对上次的新错误。用于阶段完成或怀疑出错时手动触发。",
        args: {
          scope: tool.schema
            .enum(["auto", "typecheck", "lint", "all"])
            .optional()
            .describe("auto = 按阶段信号自动判断；typecheck/lint = 只跑指定检查；all = 全部"),
        },
        async execute(args, context) {
          const cwd = context.directory
          const st = getState(context.sessionID)
          st.cwd = cwd
          const baseline = await harness.initialize(cwd)
          st.baselineHead = baseline.gitHead
          const evidence = await collectEvidence(context.sessionID, cwd, baseline.gitHead, true)
          const outcome = await harness.afterTurn(evidence)

          if (outcome.securityAlert) {
            return { title: "lidar_verify", output: outcome.securityAlert, metadata: { tier: outcome.tier } }
          }
          if (outcome.skipped && outcome.newErrors.length === 0) {
            // 无阶段信号时兜底：直接跑一次安全白名单内的检查，返回原始输出
            const fallback: string[] = []
            const cmds: Array<[string, string[]]> = []
            const tc = opts.typecheckCmd ?? (await autoDetectCmd(cwd, "typecheck"))
            if (tc) cmds.push(["typecheck", tc])
            const lintC = opts.lintCmd ?? (await autoDetectCmd(cwd, "lint"))
            if (lintC) cmds.push(["lint", lintC])
            for (const [kind, cmd] of cmds) {
              const safe = isCommandSafe(cmd, ["bun", "bunx", "npx", "npm", "pnpm", "yarn", "deno", "tsc", "eslint", "biome"])
              if (!safe.safe) {
                fallback.push(`⚠️ ${kind} 命令不在白名单内，已拒绝执行: ${cmd.join(" ")}`)
                continue
              }
              const r = await runCommand(cwd, cmd, 120_000)
              const out = r.output.trim()
              fallback.push(`### ${kind} (exit ${r.ok ? 0 : "非0"})\n\`\`\`\n${out.slice(0, 2000) || "(无输出)"}\n\`\`\``)
            }
            return {
              title: "lidar_verify",
              output: fallback.join("\n\n") || "没有检测到阶段信号，且未配置可运行的检查命令。",
              metadata: { tier: 0, skipped: true },
            }
          }

          let report = buildReport(outcome)
          if (outcome.newErrorCount >= (opts.noiseFloor ?? 3) && opts.tier3) {
            const review = await runTier3(cwd, outcome)
            if (review) report += `\n${review}`
          }
          return {
            title: "lidar_verify",
            output: report.trim() || "✅ 未发现新错误（相对基线）。",
            metadata: { tier: outcome.tier, newErrors: outcome.newErrorCount, converged: outcome.converged },
          }
        },
      }),
    },

    dispose: async () => {
      await harness.dispose()
    },
  }
}

/** 从 package.json scripts 检测 typecheck/lint 命令（引擎 same 逻辑的轻量版） */
async function autoDetectCmd(cwd: string, kind: "typecheck" | "lint"): Promise<string[] | null> {
  try {
    const raw = await import("node:fs/promises")
    const pkg = JSON.parse(await raw.readFile(path.join(cwd, "package.json"), "utf8"))
    const scripts: Record<string, string> = pkg?.scripts ?? {}
    const keys = Object.keys(scripts)
    const pick = (re: RegExp, exact: string[]): string | null => {
      for (const e of exact) if (scripts[e]) return e
      return keys.find((k) => re.test(k)) ?? null
    }
    const key =
      kind === "typecheck"
        ? pick(/typecheck|type-check|^tsc$|^check$/, ["typecheck", "tsc"])
        : pick(/^lint$|^eslint$/, ["lint", "eslint"])
    if (!key) return null
    const cmdStr = scripts[key]
    const parts = cmdStr.split(/\s+/)
    if (parts[0] === "bun" && parts[1] === "run") return ["bun", ...parts.slice(2)]
    if (parts[0] === "npm" && parts[1] === "run") return ["npm", "run", ...parts.slice(2)]
    if (parts[0] === "pnpm") return ["pnpm", ...parts.slice(1)]
    if (parts[0] === "yarn") return ["yarn", ...parts.slice(1)]
    return parts
  } catch {
    return null
  }
}
