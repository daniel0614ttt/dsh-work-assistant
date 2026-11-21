#!/usr/bin/env node
/**
 * 卸载「工作助手」：删除 profile 里的软链、依赖声明与 loader 条目。
 * 改动前会备份 package.json 与 cordis.patch.yml。
 *
 * 用法：
 *   node scripts/uninstall.mjs [--profile desktop] [--dry-run]
 */

import { existsSync, readFileSync, readlinkSync, writeFileSync, copyFileSync, lstatSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..')
const manifest = JSON.parse(readFileSync(join(PROJECT, 'package.json'), 'utf8'))
const PACKAGE_NAME = manifest.name
const ENTRY_ID = 'work-assistant'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const profileFlag = args.indexOf('--profile')
const profileName = profileFlag >= 0 ? args[profileFlag + 1] : process.env.DSH_PROFILE || 'desktop'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(DSH_HOME, 'profiles', profileName)
const packageJsonPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)

console.log(`\n工作助手 · 从 profile「${profileName}」卸载`)
if (dryRun) console.log('（dry-run：不会改动任何文件）\n')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')

function backup(path) {
  if (dryRun) return
  const target = `${path}.bak-${stamp}`
  copyFileSync(path, target)
  console.log(`  · 备份 ${target}`)
}

/* ---------- 软链 ---------- */
try {
  const stat = lstatSync(linkPath)
  if (stat.isSymbolicLink()) {
    const current = resolve(dirname(linkPath), readlinkSync(linkPath))
    console.log(`  · 删除软链 ${linkPath}（原指向 ${current}）`)
    if (!dryRun) unlinkSync(linkPath)
  } else {
    console.log(`  · ${linkPath} 不是软链，保留不动`)
  }
} catch (_) {
  console.log('  · 没有软链，跳过')
}

/* ---------- package.json ---------- */
if (existsSync(packageJsonPath)) {
  const raw = readFileSync(packageJsonPath, 'utf8')
  const json = JSON.parse(raw)
  if (json.dependencies && Object.hasOwn(json.dependencies, PACKAGE_NAME)) {
    delete json.dependencies[PACKAGE_NAME]
    console.log('  · package.json 移除依赖')
    if (!dryRun) {
      backup(packageJsonPath)
      writeFileSync(packageJsonPath, JSON.stringify(json, null, 2) + '\n')
    }
  }
}

/* ---------- cordis.patch.yml ---------- */
if (existsSync(patchPath)) {
  const raw = readFileSync(patchPath, 'utf8')
  const pattern = new RegExp(
    `\\n# 工作助手[^\\n]*\\n- insert:\\n    - id: ${ENTRY_ID}\\n      name: '[^']*'\\n?`,
    'g',
  )
  if (pattern.test(raw)) {
    const next = raw.replace(pattern, '\n')
    console.log('  · cordis.patch.yml 移除 loader 条目')
    if (!dryRun) {
      backup(patchPath)
      writeFileSync(patchPath, next.replace(/\n{3,}/g, '\n\n'))
    }
  } else if (new RegExp(`id:\\s*${ENTRY_ID}\\b`).test(raw)) {
    console.log(`  · cordis.patch.yml 里有 id: ${ENTRY_ID}，但没有匹配到标准块，请手动删除`)
  }
}

console.log('\n✓ 卸载完成（DSH 开着 HMR 时会自动生效，否则重启应用）\n')
