/**
 * lidar-harness 插件胶水层测试（纯函数 + 插件工厂冒烟）
 * 不触及真实 opencode client：仅验证导出助手与插件结构。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  buildReport,
  boundedUntrackedContents,
  collectTier3Context,
  extractTodos,
  lidarHarness,
  summarizeText,
  TIER3_DIFF_CAP,
  TIER3_DIFF_STAT_CAP,
} from "../plugin.ts"
import type { VerifyOutcome } from "../src/engine.ts"

const baseOutcome: VerifyOutcome = {
  tier: 2,
  skipped: false,
  phaseSignals: { todoCompleted: true, gitCommit: false, gitFilesChanged: [], adaptive: false },
  newErrors: [],
  newErrorCount: 0,
  totalSeen: 0,
  converged: true,
  needsReview: false,
  verificationIncomplete: false,
  baseline: {
    projectKey: "k",
    typecheckSigs: [],
    lintSigs: [],
    gitHead: "",
    scriptsHash: "h",
    createdAt: 0,
    typecheckBaselineOk: true,
    lintBaselineOk: true,
  },
  durationMs: 0,
}

describe("extractTodos", () => {
  test("解析 todos 数组", () => {
    expect(
      extractTodos({
        todos: [
          { id: "a", status: "in_progress" },
          { id: "b", status: "completed" },
        ],
      }),
    ).toEqual([
      { id: "a", status: "in_progress" },
      { id: "b", status: "completed" },
    ])
  })
  test("单个 todo 与缺省 status", () => {
    expect(extractTodos({ todo: { id: "x" } })).toEqual([{ id: "x", status: "pending" }])
  })
  test("非法/缺失输入 → 空列表", () => {
    expect(extractTodos(null)).toEqual([])
    expect(extractTodos(undefined)).toEqual([])
    expect(extractTodos({ todos: [{ status: "done" }] })).toEqual([])
    expect(extractTodos({ todos: "not-an-array" })).toEqual([])
  })
})

describe("summarizeText", () => {
  test("只合并 text parts 并忽略其他类型", () => {
    const parts: Array<{ type: string; text?: string }> = [
      { type: "text", text: "第一段" },
      { type: "tool" },
      { type: "text", text: "第二段" },
    ]
    expect(summarizeText(parts)).toBe("第一段\n第二段")
  })
  test("空输入 → 空串", () => {
    expect(summarizeText([])).toBe("")
    expect(summarizeText(null as unknown as Array<{ type: string; text?: string }>)).toBe("")
  })
})

describe("buildReport", () => {
  test("无告警无新错误 → 空报告", () => {
    expect(buildReport(baseOutcome)).toBe("")
  })
  test("安全告警优先出现", () => {
    const r = buildReport({ ...baseOutcome, securityAlert: "ALERT-测试" })
    expect(r).toContain("安全告警")
    expect(r).toContain("ALERT-测试")
  })
  test("基线不完整提示出现", () => {
    const r = buildReport({ ...baseOutcome, baselineIncomplete: true })
    expect(r).toContain("基线不完整")
  })
  test("验证不完整提示出现（健康度语义，与告警去重无关）", () => {
    const r = buildReport({ ...baseOutcome, verificationIncomplete: true, converged: false })
    expect(r).toContain("验证不完整")
    expect(r).toContain("不视为收敛")
  })
  test("新错误列表与数量注入", () => {
    const r = buildReport({ ...baseOutcome, newErrors: ["🔴 e1", "🟡 e2"], newErrorCount: 2 })
    expect(r).toContain("🔴 e1")
    expect(r).toContain("🟡 e2")
    expect(r).toContain("增量 2 个新错误")
  })
})

describe("lidarHarness 插件工厂（冒烟）", () => {
  test("构造返回 event / tool / system.transform / dispose，且系统提示注入 SLAM 协议", async () => {
    const plugin = (await lidarHarness({ client: {} } as never, { enabled: true, tier3: false, dataDir: "tmp-smoke" })) as Record<
      string,
      unknown
    >
    expect(typeof plugin.event).toBe("function")
    expect((plugin.tool as Record<string, unknown>)?.lidar_verify).toBeDefined()
    const transform = plugin["experimental.chat.system.transform"] as (
      _input: unknown,
      output: { system: string[] },
    ) => Promise<void> | void
    expect(typeof transform).toBe("function")
    expect(typeof plugin.dispose).toBe("function")
    const output = { system: [] as string[] }
    await transform({}, output)
    expect(output.system.length).toBeGreaterThan(0)
    expect(output.system[0]).toContain("SLAM 验证协议")
    await (plugin.dispose as () => Promise<void>)()
  })
})
