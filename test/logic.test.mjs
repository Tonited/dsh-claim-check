// 纯逻辑单测：不依赖 DSH 运行时，直接 import 源码（node 的 type-stripping 足够，
// 因为 src/index.ts 刻意没有用 TypeScript 的构造器参数属性等 strip-only 不支持的语法）。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  appendAttempt,
  bashTouches,
  classifyPath,
  extractPaths,
  identityOf,
  inspect,
  isEnabled,
  isJudgmentCommand,
  readJudgmentRuns,
  recordJudgmentRun,
  resolveConfig,
  toWorkspaceRelative,
} from '../src/index.ts'

const ROOT = '/work/proj'
const CFG = {
  root: ROOT,
  judgmentPath: 'contract/contract.judgment.md',
  evidenceDir: 'evidence',
  hideJudgment: true,
}

test('toWorkspaceRelative：绝对与相对都归一，越界返回 null', () => {
  assert.equal(toWorkspaceRelative(ROOT, 'contract/a.md'), 'contract/a.md')
  assert.equal(toWorkspaceRelative(ROOT, '/work/proj/contract/a.md'), 'contract/a.md')
  assert.equal(toWorkspaceRelative(ROOT, './contract/../contract/a.md'), 'contract/a.md')
  assert.equal(toWorkspaceRelative(ROOT, '/etc/passwd'), null, '工作区之外')
  assert.equal(toWorkspaceRelative(ROOT, '../outside.md'), null)
  assert.equal(toWorkspaceRelative(ROOT, ''), null)
})

test('classifyPath：只认判定文件与证据目录', () => {
  assert.equal(classifyPath('contract/contract.judgment.md', CFG), 'judgment')
  assert.equal(classifyPath('contract/contract.requirements.md', CFG), null, '需求是实现者可见的')
  assert.equal(classifyPath('evidence/x.md', CFG), 'evidence')
  assert.equal(classifyPath('evidence', CFG), 'evidence')
  assert.equal(classifyPath('evidenceX/x.md', CFG), null, '不改前缀误伤')
  assert.equal(classifyPath('src/index.ts', CFG), null)
  assert.equal(classifyPath(null, CFG), null)
})

test('extractPaths：只从字面量字段取路径', () => {
  assert.deepEqual(extractPaths('read', { file_path: 'a.md' }), ['a.md'])
  assert.deepEqual(extractPaths('write', { file_path: 'b.md' }), ['b.md'])
  assert.deepEqual(extractPaths('grep', { path: 'src' }), ['src'])
  assert.deepEqual(extractPaths('bash', { command: 'rm -rf /' }), [], 'bash 不走这里')
  assert.deepEqual(extractPaths('read', null), [])
  assert.deepEqual(extractPaths('read', { file_path: 42 }), [], '非字符串忽略')
})

test('bashTouches：字面量包含即命中（含 basename）', () => {
  const paths = ['contract/contract.judgment.md', 'evidence']
  assert.equal(bashTouches('cat contract/contract.judgment.md', paths), true)
  assert.equal(bashTouches('cat contract.judgment.md', paths), true, '相对 basename')
  assert.equal(bashTouches('echo x >> evidence/notes.md', paths), true)
  assert.equal(bashTouches('ls src contract', paths), false)
  assert.equal(bashTouches('', paths), false)
  assert.equal(bashTouches(undefined, paths), false)
})

test('isJudgmentCommand：与 evidence.mjs 的口径一致', () => {
  assert.equal(isJudgmentCommand('node verify/judgment.mjs'), true)
  assert.equal(isJudgmentCommand('npm run judge'), true)
  assert.equal(isJudgmentCommand('cat contract/contract.judgment.md'), true)
  assert.equal(isJudgmentCommand('npm run check'), false, '普通构建不算判定')
  assert.equal(isJudgmentCommand('node --test'), false)
})

test('inspect：写判定被拒', () => {
  const hit = inspect('write', { file_path: `${ROOT}/contract/contract.judgment.md` }, CFG)
  assert.equal(hit?.action, 'write')
  assert.equal(hit?.target, 'contract/contract.judgment.md')
})

test('inspect：读判定被拒（默认隐藏）', () => {
  const hit = inspect('read', { file_path: 'contract/contract.judgment.md' }, CFG)
  assert.equal(hit?.action, 'read')
})

test('inspect：hideJudgment=false 时读判定合法（不记为尝试），写仍被拒', () => {
  const relaxed = { ...CFG, hideJudgment: false }
  assert.equal(inspect('read', { file_path: 'contract/contract.judgment.md' }, relaxed), null, '读是合法的')
  assert.equal(inspect('write', { file_path: 'contract/contract.judgment.md' }, relaxed)?.action, 'write', '写仍然被拒')
})

test('inspect：写证据目录被拒，读证据被记录', () => {
  assert.equal(inspect('write', { file_path: 'evidence/x.md' }, CFG)?.action, 'write')
  assert.equal(inspect('read', { file_path: 'evidence/x.md' }, CFG)?.action, 'read')
})

test('inspect：需求文件与源码不受影响', () => {
  assert.equal(inspect('write', { file_path: 'contract/contract.requirements.md' }, CFG), null)
  assert.equal(inspect('write', { file_path: 'src/index.ts' }, CFG), null)
  assert.equal(inspect('read', { file_path: 'src/index.ts' }, CFG), null)
  assert.equal(inspect('bash', { command: 'npm run check' }, CFG), null)
})

test('inspect：bash 触碰受保护路径按写处理', () => {
  const hit = inspect('bash', { command: 'sed -i s/a/b/ contract/contract.judgment.md' }, CFG)
  assert.equal(hit?.action, 'write')
  assert.equal(inspect('bash', { command: 'ls -la' }, CFG), null)
})

test('inspect：工作区之外的路径不干预', () => {
  assert.equal(inspect('write', { file_path: '/etc/hosts' }, CFG), null)
  assert.equal(inspect('read', { file_path: '/tmp/contract/contract.judgment.md' }, CFG), null)
})

test('identityOf：从 agent 取安全字段，坏输入不抛', () => {
  assert.deepEqual(identityOf({ id: 'a1', session: 's1' }), { id: 'a1', session: 's1' })
  assert.deepEqual(identityOf({ name: 'n', session: { id: 's2' } }), { id: 'n', session: 's2' })
  assert.deepEqual(identityOf(null), { id: null, session: null })
  assert.deepEqual(identityOf({ id: 5, session: 6 }), { id: null, session: null })
  const circular = { id: 'c' }
  circular['self'] = circular
  assert.deepEqual(identityOf(circular), { id: 'c', session: null }, '循环引用也能取')
})

test('isEnabled：默认关闭，显式开关才启用', () => {
  assert.equal(isEnabled({}), false)
  assert.equal(isEnabled({ DSH_CLAIM_CHECK: '1' }), true)
  assert.equal(isEnabled({ DSH_CLAIM_CHECK_ROOT: '/x' }), true)
})

test('resolveConfig：环境变量兜底与默认值', () => {
  const cfg = resolveConfig({}, { DSH_CLAIM_CHECK_ROOT: '/r', DSH_CLAIM_CHECK_BUDGET: '7' })
  assert.equal(cfg.root, '/r')
  assert.equal(cfg.budget, 7)
  assert.equal(cfg.judgmentPath, 'contract/contract.judgment.md')
  assert.equal(cfg.hideJudgment, true)

  const bad = resolveConfig({ budget: Number.NaN }, {})
  assert.equal(bad.budget, 3, '非法预算退回默认')

  const zero = resolveConfig({ budget: 0 }, {})
  assert.equal(zero.budget, 0, '0 是合法值（完全禁止执行判定）')
})

test('预算计数器：读写与损坏文件容错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'))
  try {
    assert.equal(readJudgmentRuns(dir), 0)
    recordJudgmentRun(dir, { at: 't1' })
    recordJudgmentRun(dir, { at: 't2' })
    assert.equal(readJudgmentRuns(dir), 2)
    appendAttempt(dir, { ts: 't', result: 'denied' })
    assert.equal(readJudgmentRuns(dir), 2, '尝试日志不污染预算计数')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
