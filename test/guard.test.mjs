// 集成测试：用真实的 ctx 桩驱动插件入口，验证 guard 真的拒绝、真的记账。
//
// 这里刻意 import **构建产物** lib/index.js（而不是源码），因为发布出去的就是它；
// 顺带锁住"构建产物可用"这件事。所以必须先跑 build（npm test 之前跑 npm run build）。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { apply } = await import('../lib/index.js')

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'cc-guard-'))
  mkdirSync(join(root, 'contract'), { recursive: true })
  mkdirSync(join(root, 'evidence'), { recursive: true })
  return root
}

/** 收集 guard 并记录日志调用的 ctx 桩。 */
function makeCtx() {
  const guards = []
  const logs = []
  const ctx = {
    tools: {
      guard: (fn) => {
        guards.push(fn)
        return () => {}
      },
    },
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
    },
  }
  return { ctx, guards, logs, run: (exec) => guards.map((g) => g(exec)).find((r) => r !== undefined) }
}

function attemptLines(root) {
  const file = join(root, 'evidence', 'attempts.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
}

test('未启用时不注册任何 guard', () => {
  const saved = { ...process.env }
  delete process.env.DSH_CLAIM_CHECK
  delete process.env.DSH_CLAIM_CHECK_ROOT
  try {
    const { ctx, guards, logs } = makeCtx()
    apply(ctx, { root: '/nonexistent' })
    assert.equal(guards.length, 0)
    assert.ok(logs.some(([lvl, m]) => lvl === 'info' && m.includes('未启用')))
  } finally {
    process.env = saved
  }
})

test('guard 拒绝写判定，并写入 attempts.jsonl', () => {
  const saved = { ...process.env }
  process.env.DSH_CLAIM_CHECK = '1'
  const root = makeWorkspace()
  try {
    const { ctx, guards, run } = makeCtx()
    apply(ctx, { root })
    assert.equal(guards.length, 1, '注册了一个 guard')

    const reason = run({
      name: 'write',
      arguments: { file_path: join(root, 'contract', 'contract.judgment.md') },
      agent: { id: 'impl', session: 's1' },
    })
    assert.ok(typeof reason === 'string' && reason.includes('判据'), `应拒绝写判定，实际 ${reason}`)

    const lines = attemptLines(root)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].result, 'denied')
    assert.equal(lines[0].action, 'write')
    assert.equal(lines[0].actor, 'impl')
    assert.equal(lines[0].target, 'contract/contract.judgment.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
    process.env = saved
  }
})

test('guard 拒绝读判定（默认隐藏）', () => {
  const saved = { ...process.env }
  process.env.DSH_CLAIM_CHECK = '1'
  const root = makeWorkspace()
  try {
    const { ctx, run } = makeCtx()
    apply(ctx, { root })
    const reason = run({ name: 'read', arguments: { file_path: 'contract/contract.judgment.md' } })
    assert.ok(typeof reason === 'string', '应拒绝读判定')
    assert.equal(attemptLines(root)[0].action, 'read')
  } finally {
    rmSync(root, { recursive: true, force: true })
    process.env = saved
  }
})

test('合法调用不被干预，也不留下记录', () => {
  const saved = { ...process.env }
  process.env.DSH_CLAIM_CHECK = '1'
  const root = makeWorkspace()
  try {
    const { ctx, run } = makeCtx()
    apply(ctx, { root })
    assert.equal(run({ name: 'write', arguments: { file_path: 'src/index.ts' } }), undefined)
    assert.equal(run({ name: 'bash', arguments: { command: 'npm run check' } }), undefined)
    assert.equal(run({ name: 'read', arguments: { file_path: 'contract/contract.requirements.md' } }), undefined)
    assert.equal(attemptLines(root).length, 0, '合法调用不该产生尝试记录')
  } finally {
    rmSync(root, { recursive: true, force: true })
    process.env = saved
  }
})

test('判定执行预算：允许 N 次，第 N+1 次被拒且记为 denied', () => {
  const saved = { ...process.env }
  process.env.DSH_CLAIM_CHECK = '1'
  const root = makeWorkspace()
  try {
    const { ctx, run } = makeCtx()
    apply(ctx, { root, budget: 2 })
    const exec = { name: 'bash', arguments: { command: 'node verify/judgment.mjs' } }

    assert.equal(run(exec), undefined, '第 1 次允许')
    assert.equal(run(exec), undefined, '第 2 次允许')
    const reason = run(exec)
    assert.ok(typeof reason === 'string' && reason.includes('预算'), `第 3 次应被拒，实际 ${reason}`)

    const counter = JSON.parse(readFileSync(join(root, 'evidence', '.judgment-runs.json'), 'utf8'))
    assert.equal(counter.runs.length, 2, '只有被允许的两次计入')

    const denied = attemptLines(root).filter((l) => l.result === 'denied')
    assert.equal(denied.length, 1)
    assert.equal(denied[0].reason, 'budget')
  } finally {
    rmSync(root, { recursive: true, force: true })
    process.env = saved
  }
})

test('预算语义与脚本层一致：budget=N 恰好放行 N 次', () => {
  const saved = { ...process.env }
  process.env.DSH_CLAIM_CHECK = '1'
  const root = makeWorkspace()
  try {
    const { ctx, run } = makeCtx()
    apply(ctx, { root, budget: 5 })
    const exec = { name: 'bash', arguments: { command: 'npm run judge' } }
    for (let i = 1; i <= 5; i += 1) {
      assert.equal(run(exec), undefined, `第 ${i} 次应在预算内`)
    }
    assert.ok(typeof run(exec) === 'string', '第 6 次应被拒')
    const counter = JSON.parse(readFileSync(join(root, 'evidence', '.judgment-runs.json'), 'utf8'))
    assert.equal(counter.runs.length, 5, '恰好 5 次计入')
  } finally {
    rmSync(root, { recursive: true, force: true })
    process.env = saved
  }
})

test('budget=0 表示完全禁止执行判定', () => {
  const saved = { ...process.env }
  process.env.DSH_CLAIM_CHECK = '1'
  const root = makeWorkspace()
  try {
    const { ctx, run } = makeCtx()
    apply(ctx, { root, budget: 0 })
    const reason = run({ name: 'bash', arguments: { command: 'npm run judge' } })
    assert.ok(typeof reason === 'string', '第 1 次就该被拒')
    assert.equal(attemptLines(root).filter((l) => l.result === 'denied').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
    process.env = saved
  }
})

test('bash 触碰受保护路径按写拒绝', () => {
  const saved = { ...process.env }
  process.env.DSH_CLAIM_CHECK = '1'
  const root = makeWorkspace()
  try {
    const { ctx, run } = makeCtx()
    apply(ctx, { root })
    const reason = run({
      name: 'bash',
      arguments: { command: `sed -i 's/a/b/' contract/contract.judgment.md` },
    })
    assert.ok(typeof reason === 'string')
    assert.equal(attemptLines(root)[0].action, 'write')
  } finally {
    rmSync(root, { recursive: true, force: true })
    process.env = saved
  }
})

test('写路径的 bash 命令不吃判定预算（端到端验证抓到的 bug）', () => {
  const saved = { ...process.env }
  process.env.DSH_CLAIM_CHECK = '1'
  const root = makeWorkspace()
  try {
    const { ctx, run } = makeCtx()
    apply(ctx, { root, budget: 3 })
    const counterFile = join(root, 'evidence', '.judgment-runs.json')

    // 这条命令含 contract，曾是预算的触发词，导致被拦一次就吃掉一次预算
    const reason = run({
      name: 'bash',
      arguments: { command: 'sed -i s/a/b/ contract/contract.judgment.md' },
    })
    assert.ok(typeof reason === 'string', '仍应被路径检查拦下')
    assert.equal(existsSync(counterFile), false, '不应计入判定执行')

    // 预算仍然是完整的三次
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(
        run({ name: 'bash', arguments: { command: 'node verify/judgment.mjs' } }),
        undefined,
        `第 ${i} 次判定仍应在预算内`,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    process.env = saved
  }
})

test('候选 root 都没有 contract/ 时警告并退化为不拦截（防静默失效）', () => {
  const savedEnv = { ...process.env }
  const savedCwd = process.cwd()
  process.env.DSH_CLAIM_CHECK = '1'
  const first = mkdtempSync(join(tmpdir(), 'cc-r1-'))
  const second = mkdtempSync(join(tmpdir(), 'cc-r2-'))
  try {
    // 把 cwd 也换到没有 contract/ 的地方，确保三个候选全部落空
    process.chdir(first)
    const { ctx, guards, logs } = makeCtx()
    apply(ctx, { root: second })
    assert.equal(guards.length, 0, '没有活动工作区就不注册守卫')
    assert.ok(
      logs.some(([lvl, m]) => lvl === 'warn' && m.includes('不会拦截任何东西')),
      '必须留下一条明确的警告',
    )
  } finally {
    process.chdir(savedCwd)
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
    process.env = savedEnv
  }
})

test('显式 root 指错时，兜底候选仍能命中（cwd 是活动工作区）', () => {
  const savedEnv = { ...process.env }
  const savedCwd = process.cwd()
  process.env.DSH_CLAIM_CHECK = '1'
  const real = makeWorkspace()
  const wrong = mkdtempSync(join(tmpdir(), 'cc-wrong-'))
  try {
    process.chdir(real) // cwd 才是真正的工作区
    const { ctx, run, logs } = makeCtx()
    apply(ctx, { root: wrong })

    const reason = run({ name: 'write', arguments: { file_path: join(real, 'contract', 'contract.judgment.md') } })
    assert.ok(typeof reason === 'string', '绝对路径在第二个候选（cwd）上被解析，应当被拦')
    assert.equal(attemptLines(real)[0].action, 'write')
    assert.ok(logs.some(([lvl, m]) => lvl === 'info' && m.includes('候选=')), '应报告候选数量')
  } finally {
    process.chdir(savedCwd)
    rmSync(real, { recursive: true, force: true })
    rmSync(wrong, { recursive: true, force: true })
    process.env = savedEnv
  }
})
