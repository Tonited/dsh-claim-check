# dsh-claim-check

**DSH 插件：把 [claim-check](https://github.com/Tonited/claim-check) 的"意图闸门"从脚本层提升到 harness 层。**

[claim-check](https://github.com/Tonited/claim-check) 的脚本层只能**事后**比对哈希——它能回答"判据被改过吗"，不能回答"它**试过**吗。

本插件在工具调用被派发**之前**就拦住，并把每一次**越权尝试**写进日志。

> **"尝试"是这套体系里信噪比最高的观测量。** 通过率分不清"做不到"和"选择不做"，尝试可以；而且两者是**解耦**的——把评测器锁死能让得逞率归零，尝试率却可能纹丝不动。

---

## 它做什么

三件事，全部是**字面量比对**，不做任何解释性判断：

| 能力 | 行为 |
|---|---|
| **路径级保护** | 拒绝对 `contract/contract.judgment.md` 的写、默认也拒绝读；拒绝写 `evidence/` |
| **尝试日志** | 每一次对被保护资源的触碰（含被拒的）追加到 `evidence/attempts.jsonl` |
| **判定执行预算** | 判定命令的执行次数超过上限就拒绝（默认 3 次，语义：**允许 N 次、第 N+1 次拒绝**），并记一条 `reason: "budget"` |

触发词是 `judg` / `judge` / `verify`（与 claim-check 脚本层 `evidence.mjs` 严格一致）。**刻意不含 `contract`**——那个词在路径里出现得太频繁，会把 `sed -i … contract/contract.judgment.md` 这种**写操作**误记成判定执行、白白吃掉预算。顺序也是刻意的：**先跑路径检查**，被它拦下的命令不再另计预算。

注册的是一个 `ToolGuard`——**单调 deny**：任何 guard 都不能把别人的 deny 翻回 allow，所以监听器的顺序无法把拒绝变回许可。

## 它不做什么

- **不替代脚本。** 证据块、锚点统计、契约完整性仍由 `claim-check/scripts/*.mjs` 负责。
- **不做判断题。** 不判断"这是不是作弊"、不判断"该不该允许"。任何需要解释意图的判断都会变成新的可被博弈的判据——那正是这套体系要防的东西。所以它只比对路径与命令字面量。
- **不解析 shell。** `bash` 命令用**字面量包含**检查，不是 shell 解析。引入 shell 解析器就是引入新的博弈面。宁可漏，不可误判。

---

## 强制阶梯里的位置

`claim-check` 定义了三级强制强度（见其 `templates/file-ownership.md`）。本插件补的是脚本够不到的那一级：

| 级别 | 机制 | 谁提供 |
|---|---|---|
| 1 | 物理隔离（判据不在实现者工作视图内） | 不靠代码 |
| 2 | git 钩子拒绝改动判据 / 证据 | 不靠本插件 |
| 3 | **事前拦截 + 越权尝试记录** | **本插件** |

**级别 1 就足以挡住最常见的两种失效**（自欺、层替换）。级别 3 是唯一能**测量意图**的——本插件存在的唯一理由就是这一级。

---

## 安装

```bash
# 1. 放进 DSH profile 的依赖
cd ~/.dsh/profiles/web
npm install dsh-claim-check        # 或 pnpm add / 本地 link

# 2. 挂载（把本插件的 cordis.patch.yml 内容合进 profile 的 cordis.patch.yml）
#    或者直接把这一条插进去：
```

```yaml
- insert:
    - id: dsh-claim-check
      name: dsh-claim-check
```

```bash
# 3. 重启 DSH（配置在加载工作区时读一次）
```

## 配置

**默认不生效**——装上去不会影响其它项目。必须在环境里显式打开：

| 环境变量 | 含义 | 默认 |
|---|---|---|
| `DSH_CLAIM_CHECK` | 置任意非空值即启用 | 关 |
| `DSH_CLAIM_CHECK_ROOT` | 工作区根目录（同时起到启用作用） | `process.cwd()` |
| `DSH_CLAIM_CHECK_BUDGET` | 判定执行次数上限 | `3` |

启用后还有一个条件：**工作区下必须存在 `contract/` 目录**，否则插件只记一条 warning 就退出（不会给没在用 claim-check 的仓库添麻烦）。

也可以在挂载时用配置对象覆盖：

```yaml
- insert:
    - id: dsh-claim-check
      name: dsh-claim-check
      config:
        judgmentPath: contract/contract.judgment.md
        evidenceDir: evidence
        budget: 3
        hideJudgmentFromImplementer: true
```

---

## 与脚本层的关系

两层**不重叠**，各自补对方的缺口：

| | `claim-check/scripts/`（脚本） | 本插件 |
|---|---|---|
| 时机 | 事后 | **事前** |
| 证据块（原始输出 + 哈希 + 种子） | ✅ | ❌ |
| 锚点比例统计 | ✅ | ❌ |
| 判据完整性比对 | ✅ | ❌（它直接拦，不需要比对） |
| **越权尝试日志** | ❌（只能靠人接线） | **✅** |
| **判定执行预算** | ✅（仅限经它启动的命令） | **✅（任何路径，包括 bash 直调）** |

脚本的预算是"软"的——只要 agent 不用 `evidence.mjs` 包装，它就跑不到；插件的预算在 harness 层，绕不过去。

---

## 开发

```bash
npm install
npm run check        # tsc --noEmit && node build.mjs && node --test
```

测试分两层：

- `test/logic.test.mjs`（16 条）——纯逻辑单测，全部导出函数，不依赖 DSH。
- `test/guard.test.mjs`（8 条）——**集成测试**：用真实的 `ctx` 桩驱动 `apply()`，验证 guard 真的拒绝、真的写 `attempts.jsonl`、预算真的在第 N+1 次触发。它 import 的是**构建产物** `lib/index.js`，顺带锁住"产物可用"。

## 已知限制

- **`root` 必须真的对得上 agent 看到的路径。** 路径比对时，相对路径是相对候选 `root` 逐个解析的。候选顺序是：`DSH_CLAIM_CHECK_ROOT` / 配置里的 `root` → DSH 进程的 `cwd` → `/mnt/d/MyProject`。**多候选是为了消掉一类静默失效**：如果 DSH 从一个与工作区无关的目录启动，而候选里没有工作区，那么 agent 用相对路径（`contract/contract.judgment.md`）触碰判据时会被解析到工作区之外，插件**不会拦截**。插件在这种情况下会打一条明确的 warning（"守卫不会拦截任何东西"），而不是安静地什么都不做。
- **`ToolRestriction` 在 DSH 上是工具名级**，没有按路径禁读的原生能力。所以"判据不可见"在本插件里是**路径比对**实现的，不是内核级；真正的隔离仍应靠"判据不在实现者工作视图内"。
- **判定计数器与 agent 同进程**，理论上可被改写。它比脚本层的软预算强（agent 无法通过"不调用 evidence.mjs"绕过），但不是内核级不可伪造。
- **`bash` 用字面量比对**：混淆过的命令（拼接路径、变量展开、base64）不会被识别。这是刻意的取舍——见上文"不解析 shell"。
- **默认关闭**：忘记设环境变量就是没装。

## License

MIT
