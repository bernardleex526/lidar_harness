<p align="center">
  <strong>lidar-harness</strong><br/>
  <em>SLAM/PGO 式多层级编码 Agent 验证框架 — 为 opencode 打造的开源插件</em>
</p>

<p align="center">
  <a href="#"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.6-blue?style=flat-square"/></a>
  <a href="#"><img alt="License" src="https://img.shields.io/badge/License-MIT-green?style=flat-square"/></a>
  <a href="#"><img alt="Tests" src="https://img.shields.io/badge/Tests-77%20passed-brightgreen?style=flat-square"/></a>
  <a href="#"><img alt="Platform" src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square"/></a>
</p>

---

## 什么是 lidar-harness？

受 SLAM（即时定位与地图构建）中 **PGO（位姿图优化）**、**Scan Context（扫描上下文）** 等核心思想启发，为编码 Agent 设计的多层级验证框架：**在 Agent 每轮操作结算后自动运行 typecheck / lint，只把"新增的错误"注入回对话**，让模型像 SLAM 修正位姿漂移一样局部收紧、收敛迭代——而不是等任务结束才发现一堆问题。

最初的设计构想来自 [bernardleex526/lidar_harness 早期 README](https://github.com/bernardleex526/lidar_harness)（一个未落地代码的 SLAM→验证映射构想）。本仓库是该构想的**完整可用实现**，以 opencode 插件 + 零依赖核心引擎的形式交付。

## SLAM → Code Verification 映射

| SLAM / LiDAR 概念 | 编码 Agent 验证中的映射 |
|---|---|
| **Scan Context** | 任务复杂度分类 → 阶段快照 → 决定验证深度（Tier 0） |
| **局部回环检测** | 每阶段完成信号（TodoWrite / git commit / git 变更）→ 注入局部验证（Tier 1） |
| **全局 PGO** | typecheck / lint → 错误签名归一化 → **增量注入** → 模型修正 → 重新检测（Tier 2） |
| **多传感器融合** | 3 个独立 Review 会话（安全 / 正确性 / 风格）→ 合并发现（Tier 3） |
| **误差基线** | 会话开始前采集 typecheck+lint 基线 → **只报告增量错误** |

## 架构层级

```
模型完成一轮操作（session idle）
        ↓
  Tier 0: 复杂度门控 ──── 简单任务跳过重度验证
        ↓
  Tier 1: 局部回环检测 ─── TodoWrite / git commit / git 变更
        │                   （无 todo 信号 2 轮后自适应 git-only 模式）
        ↓
  Tier 2: 全局 PGO ─────── typecheck + lint → 签名归一化 → 增量注入 → 收敛
        ↓
  Tier 3: 多视角 Review ── 3 个一次性会话（安全/正确性/风格）并行审查
        ↓
  有新问题 → 注入报告继续 | 无新问题 → 静默
```

## 核心特性

### 🔒 安全 — 命令基线锁定
- 基线阶段锁定 `package.json` scripts 哈希；会话期间 scripts 被修改 → 安全告警，**拒绝执行**命令
- legacy/损坏状态（scripts 哈希缺失）同样 fail-safe：显式告警并跳过命令执行，直到状态重置
- **safePrefixes 白名单**（默认最小集：bun / bunx / npx / npm / pnpm / yarn / deno / tsc / eslint / biome；可配置扩展以支持 ROS / CMake / Python）
- 检查命令**永不经过 shell**：`spawn` + argv 数组（`shell: false`）+ 超时强杀**进程树**（Windows `taskkill /T`，POSIX 进程组），路径含空格也安全
- **Windows 兼容（Bun 运行时契约）**：本引擎仅支持 **Bun** 运行时。Windows 下 `npm` / `tsc` 等 `.cmd` shim 在 `shell:false` 下按 PATH 安全解析执行（优先 `.exe`），由 Bun 内部安全启动、**不经过 ComSpec 字符串拼接**；shell/cmd 特殊字符（`;&|<>`$(){}*?"%^` 等）一律拒绝。在 Node.js 下引擎会 **fail-fast 拒绝执行**（不落入不安全的 `cmd.exe` 拼接路径），请用 `bun test` / opencode 插件环境运行

### 🧠 上下文压缩 — 增量注入
- 错误签名归一化：`src/a.ts:12:5` → `src/a.ts:N:N`，剥离 ANSI 转义 / 时间戳 / 时长
- 与「基线 ∪ 已展示集合」求差 → **每轮只注入模型从未见过的新错误**，修复后自动消失
- 相比"每轮全量注入所有错误"，上下文占用显著降低

### 🔄 阶段检测 — 并行多信号
| 信号 | 来源 | 触发条件 |
|---|---|---|
| TodoWrite | 会话消息中的工具调用 | todo 状态 in_progress → completed |
| git commit | `git rev-parse HEAD` 前后对比 | 有新提交 |
| git 变更 | `git diff --name-only` + untracked | 文件变更 |
| 自适应 | 连续 2 轮无 todo 信号 | 自动切换到 git-only 模式 |

### ✅ 收敛保证与检查器健康度
`shown` 集合**单调增长**，增量仅在出现新签名时注入 → 必然收敛，不会出现"同一错误反复刷屏"或无限循环。命令不安全 / 超时 / 无法启动 / 非零退出且无输出等告警同样进入 `shown`：**告警只注入一次**，不会每轮刷屏；但**检查器健康度与告警展示分离**——检查器不健康的每一轮都如实标记 `converged=false` 且 `verificationIncomplete=true`，验证失败绝不会被静默当作"已收敛"。单轮注入上限 30 条新错误，超出部分下轮继续注入。

### 🎛 按需验证工具
插件注册 `lidar_verify` 工具，模型或用户可随时手动触发验证（无阶段信号时兜底运行白名单内检查并返回原始输出）。

## 快速开始

### 前提
- [opencode](https://opencode.ai)（插件模式，本实现对照 v1.18.x API）
- [bun](https://bun.sh)（**必需**：引擎的进程执行契约仅支持 Bun 运行时，Node.js 下会 fail-fast 拒绝执行）

### 安装（两种方式）

**方式 A：全局启用（推荐）**

```bash
# 克隆到全局配置目录
git clone https://github.com/bernardleex526/lidar_harness ~/.config/opencode/lidar-harness
# 安装依赖（@opencode-ai/plugin 为插件 API 包；引擎本身零运行时依赖）
cd ~/.config/opencode/lidar-harness
bun install
```

在 `~/.config/opencode/opencode.json` 的 `plugin` 数组加入：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./lidar-harness/plugin.ts"]
}
```

**方式 B：项目内启用**

将仓库克隆到项目根目录的 `.opencode/plugins/lidar-harness/`（或直接把 `plugin.ts` 与 `src/` 拷入 `.opencode/plugin/`），然后在该目录执行 `bun install`。

> ⚠️ 配置与插件均**不热加载**，修改后需**重启 opencode**。

### 配置

默认零配置即用（自动检测 `package.json` 中的 typecheck/lint 脚本）。可选参数通过 tuple 形式传递：

```json
{
  "plugin": [["./lidar-harness/plugin.ts", {
    "enabled": true,
    "tier3": true,
    "noiseFloor": 3,
    "typecheckCmd": ["bun", "tsc", "--noEmit"],
    "lintCmd": ["bunx", "eslint", "."]
  }]]
}
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `tier3` | `true` | 启用 3 视角子会话审查（每次触发产生 3 次模型调用；子会话运行在项目目录并提供有界 diff 上下文） |
| `noiseFloor` | `3` | 新错误数 ≥ 该值才触发 Tier 3 |
| `typecheckCmd` / `lintCmd` | `null`（自动检测） | 显式指定检查命令；`null` = 自动检测 |
| `safePrefixes` | 最小集（见上文安全一节） | 可执行文件白名单。ROS/CMake/Python 项目示例：`["bun", "bunx", "npx", "npm", "tsc", "eslint", "cmake", "ctest", "make", "ninja", "python", "pytest", "colcon", "catkin_make"]`。默认保持最小，扩展需有意为之 |
| `dataDir` | `~/.local/share/opencode/lidar-harness` | 状态持久化目录 |

> 自动检测的 typecheck 命令会**自动追加 `--noEmit`**；`bunx` 前缀自动转为 `bun x`（Windows 兼容，显式配置同样生效）。
> 显式配置的命令**不会**自动追加 `--noEmit`，由用户负责；命令必须为 argv 数组形式（无 shell），包含 shell 构造（`source` / `&&` / 管道等）的脚本会被安全层拒绝。

### 作为独立库使用（非 opencode 环境）

核心引擎 `src/engine.ts` 是**纯 TypeScript、零运行时依赖**模块，可独立嵌入 Claude Code / Codex / 自定义 agent 循环（**要求 Bun 运行时**，见上文 Windows 兼容契约）：

```ts
import { Harness } from "lidar-harness"

const harness = new Harness({ typecheckCmd: ["bun", "tsc", "--noEmit"] })
await harness.initialize("/path/to/project")

const outcome = await harness.afterTurn({
  cwd: "/path/to/project",
  turnText: "用户本轮指令",
  todoCompleted: true,
  gitCommitChanged: false,
  gitFilesChanged: ["src/a.ts"],
  gitDiffLines: 40,
})

// 只输出模型没见过的新错误
for (const msg of outcome.newErrors) {
  // 注入给模型
}
await harness.dispose()
```

## 工作原理

- **触发**：监听 `session.status`（idle）与 `session.idle` 事件，每轮对话结算后自动验证（防重入 + 5s 节流）
- **注入**：`client.session.prompt` + `noReply: true` + `synthetic` 文本 part —— 追加 user 消息而不触发模型回复，不污染标题生成
- **Tier 3**：`client.session.create` 创建 3 个一次性会话并行审查（安全/正确性/风格），子会话运行在项目目录（`directory`），上下文有界（文件 ≤15、错误 ≤20、diff ≤8KB、未跟踪文件内容预览 ≤8KB 且跳过二进制/超大文件），diff 覆盖**基线 commit → 工作区**（含 staged 与 committed-since-baseline，通过 `git diff <baselineHead>`），合并结论后删除会话；任一失败自动降级，不影响 Tier 2 结果
- **系统提示**：`experimental.chat.system.transform` 注入 SLAM 验证协议（阶段闭环自查 + PGO 局部收紧原则）
- **状态**：每项目一个 JSON 文件持久化（基线签名、shown 集合、adaptive 模式、scripts 哈希、基线完整性标记），原子写入

## 文件结构

```
lidar-harness/
├── plugin.ts            # opencode 插件胶水层（事件触发 / 注入 / 工具 / Tier 3）
├── src/engine.ts        # 核心引擎（纯 TS、零运行时依赖、可独立使用；要求 Bun 运行时）
├── test/engine.test.ts  # 引擎测试（签名归一化 / 解析 / 增量 / 收敛 / 安全 / 故障分支）
├── test/plugin.test.ts  # 插件测试（Todo 解析 / 报告构建 / 插件工厂冒烟）
├── .github/workflows/   # CI（frozen install + tests + typecheck）
├── package.json
├── tsconfig.json
└── README.md
```

## 开发

```bash
bun install          # 安装依赖（frozen lockfile）
bun test             # 77 项测试：签名归一化 / 解析 / 增量 / 收敛 / 白名单 / 安全锁 / 门控 / 故障分支 / 基线可信 / 强杀 / 输出字节上限 / Tier3 上下文 / 插件
bunx tsc --noEmit    # 严格模式类型检查
```

CI（GitHub Actions）在每次 push/PR 上执行 `bun install --frozen-lockfile` + `bun test` + `bunx tsc --noEmit`（Ubuntu + Windows 双平台矩阵）。

## 与设计构想的差异（实现取舍）

- **Tier 3 实现**：构想的"3 个子 Agent"实现为 3 个一次性 review 会话（SDK `session.create/prompt/delete`），可配置关闭
- **噪声门槛**：构想中 `unseenSigs < NOISE_FLOOR` 直接收敛会吞掉真实少量错误；本实现改为"增量非空就注入一次，noiseFloor 仅作为 Tier 3 触发门槛"，仍保证收敛
- **钩子名称**：构想中的 `runner.turn.settled` 不存在于当前 opencode API，实际使用 `session.status` / `session.idle` 事件

## 限制

- 验证命令超时 120s（可配置）；超时强杀**进程树**（Windows `taskkill /T` 检查 error/status/signal，失败回退 `child.kill` 并如实标记强杀失败）并视为不可信（告警只注入一次，但该轮 `converged=false` / `verificationIncomplete=true`）；单命令输出上限 256KB（按 **Buffer 字节**累计，结算时 `StringDecoder` 整体解码保证跨 chunk UTF-8 正确，超出截断并告警）
- **基线只接受可信运行**：超时强杀 / 输出截断 / 无法启动（exit code 为 null）的运行结果不会被当作基线，残缺的"部分输出"不会污染基线签名
- 命令必须可通过 argv 数组无 shell 执行；含 shell 构造的脚本会被拒绝（fail-safe，不会静默跳过检查——会以告警形式注入一次）
- 非 git 仓库：git 信号为空，仅靠 TodoWrite 信号触发；2 轮无 todo 后进入 git-only 无信号 → 跳过验证，可用 `lidar_verify` 工具手动触发
- 旧版本/损坏状态文件（缺失 scripts 基线或完整性标记）会安全告警并拒绝执行命令，需删除状态目录重新初始化
- Tier 3 review 会话消耗模型额度（每次触发 3 次调用），可配置 `tier3: false` 关闭

## License

[MIT](./LICENSE)
