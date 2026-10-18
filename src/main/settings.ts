import { ipcMain, Notification, shell } from 'electron'
import { getDb } from './db'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULTS = {
  notifyAfterSeconds: 30,
  notifyCooldownSeconds: 180,
  defaultModel: 'claude-opus-4.8',
  notificationsEnabled: true,
  brainAutoApply: true,
  accentColor: '#0ea5e9',
  translucentSidebar: false,
  approvalPolicy: 'on-request' as 'on-request' | 'suggest' | 'auto-edit' | 'full-auto',
  sandboxMode: 'read-only' as 'read-only' | 'workspace-write' | 'danger',
  completionNotifyMode: 'unfocused' as 'always' | 'unfocused' | 'off',
  permissionNotifications: true,
  questionNotifications: true,
  terminalFontSize: 13,
  terminalFontFamily: 'JetBrains Mono',
  terminalCursorStyle: 'bar' as 'bar' | 'block' | 'underline',
  terminalCursorBlink: true,
  terminalLineHeight: 1.35,
  terminalCopyOnSelect: false,
  // Auto-continue writes into a live PTY, which can answer a prompt or type
  // over the user's input line, so it stays opt-in however good the guards are.
  autoContinueEnabled: false,
  // Default Figma file every export forks into. Set to a fileKey or full
  // figma.com URL of a file you've claimed and (optionally) seeded with
  // your design system. When set, "newFile" exports become "existingFile"
  // exports against this key, which avoids the unclaimed-file empty result
  // and lets the agent reuse your components.
  defaultFigmaFile: '',
  // Register the Work IQ ("Cowork") MCP server in ~/.copilot/mcp-config.json so
  // every Copilot CLI session terminal42 starts can ground answers in the
  // user's Microsoft 365 context. On by default; the switch exists so a user
  // who would rather terminal42 not manage their MCP servers can turn it off
  // and have that choice survive a restart.
  coworkEnabled: true
}

export type Settings = typeof DEFAULTS

export function getSettings(): Settings {
  const rows = getDb().prepare('SELECT key, value FROM settings_kv').all() as { key: string; value: string }[]
  const out: Settings = { ...DEFAULTS }
  for (const r of rows) {
    if (r.key in out) {
      const v = JSON.parse(r.value)
      ;(out as Record<string, unknown>)[r.key] = v
    }
  }
  return out
}

export function setSetting(key: keyof Settings, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings_kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, JSON.stringify(value))
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, args: { key: keyof Settings; value: unknown }) => {
    setSetting(args.key, args.value)
    return getSettings()
  })

  ipcMain.handle('notify:show', (_e, args: { title: string; body: string }) => {
    if (!Notification.isSupported()) return { ok: false }
    const s = getSettings()
    if (!s.notificationsEnabled) return { ok: false }
    const n = new Notification({ title: args.title, body: args.body, silent: false })
    n.show()
    return { ok: true }
  })

  ipcMain.handle('settings:openConfigToml', async () => {
    const path = join(homedir(), '.copilot', 'config.toml')
    try { await shell.openPath(path); return { ok: true, path } } catch { return { ok: false, path } }
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (typeof url !== 'string') return false
    if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return false
    try { await shell.openExternal(url); return true } catch { return false }
  })
}
