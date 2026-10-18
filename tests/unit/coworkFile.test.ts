import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The database and the IPC registry are not what this file is about; stubbing
// them keeps the test pointed at the merge-and-write behaviour, which is the
// part that can actually lose someone's MCP servers.
const h = vi.hoisted(() => ({ settings: { coworkEnabled: true } }))

vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }))
vi.mock('../../src/main/settings', () => ({
  getSettings: () => h.settings,
  setSetting: (key: string, value: unknown) => {
    ;(h.settings as Record<string, unknown>)[key] = value
  }
}))

const { getCoworkStatus, enableCowork, disableCowork, ensureCoworkOnStartup, isCoworkRegisteredSync } =
  await import('../../src/main/cowork')

let home: string
const priorHome = process.env.COPILOT_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 't42-cowork-'))
  process.env.COPILOT_HOME = home
  h.settings.coworkEnabled = true
})

afterEach(() => {
  if (priorHome === undefined) delete process.env.COPILOT_HOME
  else process.env.COPILOT_HOME = priorHome
  rmSync(home, { recursive: true, force: true })
})

const file = (): string => join(home, 'mcp-config.json')
const backup = (): string => `${file()}.t42-backup`
const write = (text: string): void => writeFileSync(file(), text, 'utf8')
const read = (): string => readFileSync(file(), 'utf8')
const config = (): Record<string, unknown> => JSON.parse(read()) as Record<string, unknown>
const servers = (): Record<string, unknown> => config().mcpServers as Record<string, unknown>

// A trimmed copy of a real user file: servers and keys that terminal42 is not
// entitled to touch, and which a Cowork round trip has to leave alone.
const USER_FILE = {
  mcpServers: {
    azure: {
      tools: ['*'],
      type: 'local',
      command: 'npx',
      args: ['-y', '@azure/mcp@latest', 'server', 'start']
    },
    phoenix: { type: 'stdio', command: 'C:/tools/phoenix-mcp.exe' }
  },
  somethingElse: { kept: true }
}
const USER_TEXT = JSON.stringify(USER_FILE, null, 2)

describe('getCoworkStatus', () => {
  it('reports unregistered for a file that does not exist yet', async () => {
    expect(await getCoworkStatus()).toMatchObject({ registered: false, ok: true, path: file() })
  })

  it('reports not-ok for a file it cannot parse', async () => {
    write('{ this is not json')
    expect(await getCoworkStatus()).toMatchObject({ registered: false, ok: false })
  })

  it('reports registered once the entry is there', async () => {
    await enableCowork()
    expect(await getCoworkStatus()).toMatchObject({ registered: true, ok: true })
  })
})

describe('enableCowork', () => {
  it('creates the file when there is none', async () => {
    const res = await enableCowork()
    expect(res).toMatchObject({ registered: true, ok: true })
    const workiq = servers().workiq as Record<string, unknown>
    expect(workiq).toMatchObject({ type: 'local', command: 'npx' })
    expect(workiq.args).toEqual(['-y', '@microsoft/workiq@latest', 'mcp'])
  })

  it('preserves every server and top-level key the user had', async () => {
    write(USER_TEXT)
    await enableCowork()
    expect(servers().azure).toEqual(USER_FILE.mcpServers.azure)
    expect(servers().phoenix).toEqual(USER_FILE.mcpServers.phoenix)
    expect(config().somethingElse).toEqual({ kept: true })
    expect(Object.keys(servers()).sort()).toEqual(['azure', 'phoenix', 'workiq'])
  })

  it('leaves a backup of the file as it was before the first edit', async () => {
    write(USER_TEXT)
    await enableCowork()
    expect(readFileSync(backup(), 'utf8')).toBe(USER_TEXT)
  })

  it('does not overwrite a workiq entry the user edited by hand', async () => {
    const mine = { type: 'http', url: 'https://my-own-proxy.internal/mcp' }
    write(JSON.stringify({ ...USER_FILE, mcpServers: { ...USER_FILE.mcpServers, workiq: mine } }))
    await enableCowork()
    expect(servers().workiq).toEqual(mine)
  })

  it('refuses to write over a file it cannot parse', async () => {
    const corrupt = '{ this is not json'
    write(corrupt)
    const res = await enableCowork()
    expect(res.ok).toBe(false)
    expect(read()).toBe(corrupt)
  })

  it('leaves no temp file behind', async () => {
    write(USER_TEXT)
    await enableCowork()
    expect(readdirSync(home).filter((f) => f.includes('tmp'))).toEqual([])
    expect(existsSync(file())).toBe(true)
  })
})

describe('disableCowork', () => {
  it('removes only the workiq entry', async () => {
    write(USER_TEXT)
    await enableCowork()
    await disableCowork()
    expect(Object.keys(servers()).sort()).toEqual(['azure', 'phoenix'])
    expect(config().somethingElse).toEqual({ kept: true })
  })

  it('round-trips enable -> disable back to the original config', async () => {
    write(USER_TEXT)
    await enableCowork()
    await disableCowork()
    expect(config()).toEqual(USER_FILE)
  })

  it('does not touch a file that never had the entry', async () => {
    write(USER_TEXT)
    const res = await disableCowork()
    expect(res).toMatchObject({ registered: false, ok: true })
    expect(read()).toBe(USER_TEXT)
  })
})

describe('ensureCoworkOnStartup', () => {
  it('registers the entry when the user has Cowork enabled', async () => {
    await ensureCoworkOnStartup()
    expect(await getCoworkStatus()).toMatchObject({ registered: true, ok: true })
  })

  it('removes the entry when the user has Cowork disabled', async () => {
    write(USER_TEXT)
    await enableCowork()
    h.settings.coworkEnabled = false
    await ensureCoworkOnStartup()
    expect(Object.keys(servers()).sort()).toEqual(['azure', 'phoenix'])
  })

  it('never throws, however broken the file is', async () => {
    write('{ broken')
    await expect(ensureCoworkOnStartup()).resolves.toBeUndefined()
  })
})

describe('isCoworkRegisteredSync', () => {
  it('tracks the file, and reports false rather than throwing when it is missing', () => {
    expect(isCoworkRegisteredSync()).toBe(false)
    write(USER_TEXT)
    expect(isCoworkRegisteredSync()).toBe(false)
    write(JSON.stringify(USER_FILE))
    expect(isCoworkRegisteredSync()).toBe(false)
  })

  it('sees the entry once it has been written', async () => {
    await enableCowork()
    expect(isCoworkRegisteredSync()).toBe(true)
  })
})
