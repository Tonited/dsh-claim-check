// dsh-claim-check 构建脚本：src/index.ts → lib/index.js（ESM，宿主侧）。
//
// @deepseek-ai/* 一律 external：它们是宿主提供的基线模块，必须由宿主解析。
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))

await mkdir(resolve(ROOT, 'lib'), { recursive: true })

await build({
  entryPoints: [resolve(ROOT, 'src/index.ts')],
  outfile: resolve(ROOT, 'lib/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
})

console.log('[build] lib/index.js done')
