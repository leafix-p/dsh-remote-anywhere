#!/usr/bin/env node
/**
 * Local installer for dsh-remote-anywhere.
 *
 * Usage (from the plugin checkout):
 *   node scripts/install.mjs            install into $DSH_HOME/profiles/<profile>
 *   node scripts/install.mjs --uninstall
 *
 * It does two things without touching the network:
 *   1. symlinks/junctions this checkout into the profile's node_modules;
 *   2. adds the package to the profile manifest's dependencies and
 *      `dsh.profile.bundles` list (with a one-time .bak copy).
 *
 * Restart dsh afterwards; the browser half is scanned at startup.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).name
const uninstall = process.argv.includes('--uninstall')

const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? resolve(process.env.DSH_HOME)
  : join(homedir(), '.dsh')
const profileName = process.env.DSH_PROFILE && process.env.DSH_PROFILE.trim() !== ''
  ? process.env.DSH_PROFILE
  : 'web'
const profileDir = process.env.DSH_PROFILE_DIR && process.env.DSH_PROFILE_DIR.trim() !== ''
  ? resolve(process.env.DSH_PROFILE_DIR)
  : join(dshHome, 'profiles', profileName)
const manifestPath = join(profileDir, 'package.json')
const nodeModules = join(profileDir, 'node_modules')
const linkPath = join(nodeModules, packageName)

if (!existsSync(manifestPath)) {
  console.error(`profile manifest not found: ${manifestPath}`)
  console.error('Start dsh once (or create the profile) before installing this plugin.')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies = manifest.dependencies ?? {}
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
manifest.dsh.profile.bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []

if (!uninstall) {
  const backup = `${manifestPath}.bak-${Date.now()}`
  copyFileSync(manifestPath, backup)
  const relativePath = relative(profileDir, pluginRoot).replaceAll('\\', '/')
  manifest.dependencies[packageName] = `link:${relativePath}`
  if (!manifest.dsh.profile.bundles.includes(packageName)) manifest.dsh.profile.bundles.push(packageName)
  mkdirSync(nodeModules, { recursive: true })
  if (existsSync(linkPath)) {
    const info = lstatSync(linkPath)
    if (!info.isSymbolicLink()) {
      console.error(`${linkPath} exists and is not a link; refusing to overwrite a real package directory.`)
      process.exit(1)
    }
    rmSync(linkPath, { recursive: true, force: true })
  }
  symlinkSync(pluginRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`installed ${packageName}`)
  console.log(`  link:     ${linkPath} -> ${pluginRoot}`)
  console.log(`  profile:  ${profileDir}`)
  console.log('  restart dsh (or the Web GUI process) to load it.')
} else {
  if (existsSync(linkPath)) {
    const info = lstatSync(linkPath)
    if (info.isSymbolicLink()) rmSync(linkPath, { recursive: true, force: true })
  }
  delete manifest.dependencies[packageName]
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== packageName)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`uninstalled ${packageName}; restart dsh to unload it.`)
}

