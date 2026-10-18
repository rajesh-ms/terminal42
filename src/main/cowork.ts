/**
 * Registers the Microsoft Work IQ ("Cowork") MCP server for every Copilot CLI
 * session terminal42 starts, and lets the user turn it off again.
 *
 * File handling follows copilotCliSettings.ts: read the raw text, refuse to
 * write anything we could not parse, and replace the file via a sibling rename
 * so a crash mid-write cannot truncate a config full of the user's own servers.
 * The first write also leaves a one-time backup next to the file.
 *
 * Toggling is expressed as the presence of the entry rather than state of our
 * own: the MCP file is what the CLI actually reads, so a second copy of that
 * fact in the database would only be a second thing to get out of sync. The
 * database keeps the *intent* (`coworkEnabled`), applied once per launch, so a
 * deliberate disable survives both a manual edit and a restart.
 */

import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  hasCoworkServer,
  parseMcpConfig,
  serializeMcpConfig,
  withCoworkServer,
  withoutCoworkServer,
  type McpConfig
} from '../shared/cowork'
import { getSettings, setSetting } from './settings'

export type CoworkStatus = {
  /** Whether the `workiq` entry is present in the MCP config. */
  registered: boolean
  /** False when the file exists but could not be parsed, so we refused to write. */
  ok: boolean
  /** The MCP config file terminal42 manages. */
  path: string
  /** Whether the user's persisted intent is "on". */
  enabled: boolean
  /** `workiq --version` output when the CLI is on PATH, else null. */
  cliVersion: string | null
}

/** Resolves like the CLI's own settings lookup, so a relocated COPILOT_HOME is honoured. */
function mcpConfigPath(): string {
  return join(process.env.COPILOT_HOME || join(homedir(), '.copilot'), 'mcp-config.json')
}

async function readRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    return null
  }
}

async function writeRaw(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.t42.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/**
 * Keep one pristine copy of the file from before our first edit, so a bad merge
 * is always reversible. Never overwrites an existing backup: the newest backup
 * would otherwise drift towards "already contains our change".
 */
async function backupOnce(path: string, raw: string): Promise<void> {
  if (raw === '') return
  const backup = `${path}.t42-backup`
  try {
    await access(backup)
    return
  } catch {
    /* no backup yet */
  }
  try {
    await writeFile(backup, raw, 'utf8')
  } catch {
    /* a failed backup must not block the edit the user asked for */
  }
}

type Loaded =
  | { ok: true; config: McpConfig; raw: string; path: string }
  | { ok: false; path: string }

async function load(): Promise<Loaded> {
  const path = mcpConfigPath()
  const raw = await readRaw(path)
  if (raw === null) return { ok: false, path }
  const config = parseMcpConfig(raw)
  if (config === null) return { ok: false, path }
  return { ok: true, config, raw, path }
}

/** `workiq --version` (e.g. "1.0.1.47154"), or null when it is not installed. */
function detectCliVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: string | null): void => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      // `shell: true` because Windows exposes the CLI as a .cmd/.ps1 shim, and
      // a bare execFile of "workiq" would fail there with ENOENT.
      const child = execFile('workiq', ['version'], { shell: true, timeout: 5000 }, (err, stdout) => {
        if (err) return done(null)
        const first = String(stdout).split('\n')[0].trim()
        done(first || null)
      })
      child.on('error', () => done(null))
    } catch {
      done(null)
    }
    setTimeout(() => done(null), 5500)
  })
}

/**
 * Whether the Cowork entry is present, read synchronously.
 *
 * Used on the chat hot path to decide whether to tell the agent it has M365
 * context. A `readFileSync` of a small config, not a spawn, is cheap enough for
 * the turn that it saves keeping an async copy in sync with the disk.
 */
export function isCoworkRegisteredSync(): boolean {
  try {
    const config = parseMcpConfig(readFileSync(mcpConfigPath(), 'utf8'))
    return config ? hasCoworkServer(config) : false
  } catch {
    return false
  }
}

export async function getCoworkStatus(probeCli = false): Promise<CoworkStatus> {
  const path = mcpConfigPath()
  const enabled = getSettings().coworkEnabled
  const raw = await readRaw(path)
  const config = raw === null ? null : parseMcpConfig(raw)
  if (config === null) {
    return { registered: false, ok: false, path, enabled, cliVersion: null }
  }
  return {
    registered: hasCoworkServer(config),
    ok: true,
    path,
    enabled,
    cliVersion: probeCli ? await detectCliVersion() : null
  }
}

/**
 * Add the entry. Idempotent, and never overwrites an entry that is already
 * there: if the user has edited the `workiq` server by hand, that edit is
 * theirs and re-writing our shape would silently undo it.
 */
export async function enableCowork(): Promise<CoworkStatus> {
  const loaded = await load()
  if (!loaded.ok) return { registered: false, ok: false, path: loaded.path, enabled: true, cliVersion: null }
  if (hasCoworkServer(loaded.config)) {
    return { registered: true, ok: true, path: loaded.path, enabled: true, cliVersion: null }
  }
  const next = withCoworkServer(loaded.config)
  if (next === null) {
    return { registered: false, ok: false, path: loaded.path, enabled: true, cliVersion: null }
  }
  await backupOnce(loaded.path, loaded.raw)
  await writeRaw(loaded.path, serializeMcpConfig(next))
  return { registered: true, ok: true, path: loaded.path, enabled: true, cliVersion: null }
}

/** Remove only the entry terminal42 added; everything else stays put. */
export async function disableCowork(): Promise<CoworkStatus> {
  const loaded = await load()
  if (!loaded.ok) return { registered: false, ok: false, path: loaded.path, enabled: false, cliVersion: null }
  if (!hasCoworkServer(loaded.config)) {
    return { registered: false, ok: true, path: loaded.path, enabled: false, cliVersion: null }
  }
  await backupOnce(loaded.path, loaded.raw)
  await writeRaw(loaded.path, serializeMcpConfig(withoutCoworkServer(loaded.config)))
  return { registered: false, ok: true, path: loaded.path, enabled: false, cliVersion: null }
}

/**
 * Apply the user's intent once per launch: enabled (the default) registers the
 * entry, disabled removes it.
 *
 * Failures are swallowed on purpose. A Cowork registration problem must never
 * keep the app from starting; `cowork:status` is where it gets surfaced.
 */
export async function ensureCoworkOnStartup(): Promise<void> {
  try {
    if (getSettings().coworkEnabled) await enableCowork()
    else await disableCowork()
  } catch (err) {
    console.error('[cowork] startup sync failed:', err)
  }
}

export function registerCoworkIpc(): void {
  ipcMain.handle('cowork:status', (_e, probeCli?: boolean) => getCoworkStatus(probeCli === true))
  ipcMain.handle('cowork:enable', async () => {
    setSetting('coworkEnabled', true)
    return enableCowork()
  })
  ipcMain.handle('cowork:disable', async () => {
    setSetting('coworkEnabled', false)
    return disableCowork()
  })
}
