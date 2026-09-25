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

test('工作区没有 contract/ 时拒绝启用', () => {
  const saved = { ...process.env }
  process.env.DSH_CLAIM_CHECK = '1'
  const bare = mkdtempSync(join(tmpdir(), 'cc-bare-'))
  try {
    const { ctx, guards, logs } = makeCtx()
    apply(ctx, { root: bare })
    assert.equal(guards.length, 0, '没有 contract/ 就不注册')
    assert.ok(logs.some(([lvl, m]) => lvl === 'warn' && m.includes('没有 contract/')))
  } finally {
    rmSync(bare, { recursive: true, force: true })
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
