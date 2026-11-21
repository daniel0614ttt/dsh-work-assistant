#!/usr/bin/env node
/**
 * 把「工作助手」装进 DSH 的某个 profile。
 *
 * 做的事只有三件：
 *   1. 在 <profile>/node_modules 下建一个指向本仓库的软链；
 *   2. 把包名写进 <profile>/package.json 的 dependencies（记录依赖关系）；
 *   3. 在 <profile>/cordis.patch.yml 末尾追加一条 loader 条目。
 *
 * 所有改动前都会备份。重复执行是安全的（幂等）。
 *
 * 用法：
 *   node scripts/install.mjs                # 自动选择当前激活的 profile
 *   node scripts/install.mjs --profile web  # 指定 profile
 *   node scripts/install.mjs --dry-run      # 只打印将要做什么
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, lstatSync, unlinkSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..')
const manifest = JSON.parse(readFileSync(join(PROJECT, 'package.json'), 'utf8'))
const PACKAGE_NAME = manifest.name
const ENTRY_ID = 'work-assistant'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const profileFlag = args.indexOf('--profile')
const explicitProfile = profileFlag >= 0 ? args[profileFlag + 1] : undefined

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

function fail(message) {
  console.error('\n✗ ' + message)
  process.exit(1)
}

function note(message) {
  console.log('  · ' + message)
}

/** 读桌面端保存的 profile 选择，取不到就回退 desktop。 */
function activeProfile() {
  const candidates = [
    join(homedir(), 'Library', 'Application Support', 'DSH Desktop', 'profile-selection'),
    join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness', 'profile-selection'),
  ]
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    const file = join(dir, 'profile-selection.json')
    const fallback = join(dir, 'selection.json')
    for (const path of [file, fallback]) {
      if (!existsSync(path)) continue
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof parsed.active === 'string' && parsed.active !== '') return parsed.active
      } catch (_) {
        /* 忽略：继续找下一个 */
      }
    }
    // 目录里只有一个文件时直接读它。
    try {
      const { readdirSync } = require('node:fs')
      const entries = readdirSync(dir).filter((name) => name.endsWith('.json'))
      for (const name of entries) {
        const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        if (typeof parsed.active === 'string' && parsed.active !== '') return parsed.active
      }
    } catch (_) {
      /* 忽略 */
    }
  }
  return 'desktop'
}

const profileName = explicitProfile || activeProfile()
const profileDir = join(DSH_HOME, 'profiles', profileName)
const packageJsonPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const nodeModulesDir = join(profileDir, 'node_modules')
const linkPath = join(nodeModulesDir, PACKAGE_NAME)

if (!existsSync(profileDir)) fail(`找不到 profile 目录：${profileDir}`)
if (!existsSync(packageJsonPath)) fail(`profile 缺少 package.json：${packageJsonPath}`)
if (!existsSync(patchPath)) fail(`profile 缺少 cordis.patch.yml：${patchPath}`)

console.log(`\n工作助手 · 安装到 profile「${profileName}」`)
console.log(`插件目录：${PROJECT}`)
if (dryRun) console.log('（dry-run：不会写入任何文件）\n')
else console.log('')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')

function backup(path) {
  if (dryRun) return
  const target = `${path}.bak-${stamp}`
  copyFileSync(path, target)
  note(`备份 ${target}`)
}

/* ---------- 1. node_modules 软链 ---------- */

function linkPackage() {
  if (!dryRun) mkdirSync(nodeModulesDir, { recursive: true })
  let existing = null
  try {
    existing = lstatSync(linkPath)
  } catch (_) {
    existing = null
  }
  if (existing !== null) {
    if (existing.isSymbolicLink()) {
      const current = resolve(dirname(linkPath), readlinkSync(linkPath))
      if (current === PROJECT) {
        note(`软链已存在且指向本目录：${linkPath}`)
        return
      }
      note(`替换旧软链（原指向 ${current}）`)
      if (!dryRun) unlinkSync(linkPath)
    } else {
      note('目标位置已存在真实目录，保留不动：' + linkPath)
      return
    }
  } else {
    note(`创建软链 ${linkPath}`)
  }
  if (!dryRun) symlinkSync(PROJECT, linkPath, 'dir')
}

/* ---------- 2. package.json 依赖 ---------- */

function declareDependency() {
  const raw = readFileSync(packageJsonPath, 'utf8')
  const json = JSON.parse(raw)
  json.dependencies = json.dependencies || {}
  if (json.dependencies[PACKAGE_NAME] === 'file:' + PROJECT) {
    note('package.json 已声明依赖')
    return
  }
  json.dependencies[PACKAGE_NAME] = 'file:' + PROJECT
  note(`package.json 增加依赖 ${PACKAGE_NAME} → file:${PROJECT}`)
  if (dryRun) return
  backup(packageJsonPath)
  writeFileSync(packageJsonPath, JSON.stringify(json, null, 2) + '\n')
}

/* ---------- 3. cordis.patch.yml 条目 ---------- */

function ensurePatchEntry() {
  const raw = readFileSync(patchPath, 'utf8')
  const pattern = new RegExp(`id:\\s*${ENTRY_ID}\\b`)
  if (pattern.test(raw)) {
    note('cordis.patch.yml 已存在该条目')
    return
  }
  const block = [
    '',
    '# 工作助手：整理命令 → 发送到指定会话 → 完成后提醒',
    '- insert:',
    `    - id: ${ENTRY_ID}`,
    `      name: '${PACKAGE_NAME}'`,
    '',
  ].join('\n')
  note('cordis.patch.yml 追加 loader 条目')
  if (dryRun) return
  backup(patchPath)
  writeFileSync(patchPath, raw.replace(/\s*$/, '\n') + block)
}

linkPackage()
declareDependency()
ensurePatchEntry()

if (dryRun) {
  console.log('\n（dry-run 结束）\n')
  process.exit(0)
}

console.log('\n✓ 安装完成。')
console.log('\n下一步：')
console.log('  1. DSH 开着 HMR 时会自动加载；否则重启应用。')
console.log('  2. 左侧边栏底部会出现「🤖 工作助手」按钮。')
console.log('  3. 卸载：node scripts/uninstall.mjs\n')
