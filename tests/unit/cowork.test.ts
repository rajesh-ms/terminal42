import { describe, it, expect } from 'vitest'
import {
  COWORK_SERVER_NAME,
  coworkServerEntry,
  hasCoworkServer,
  parseMcpConfig,
  serializeMcpConfig,
  withCoworkServer,
  withoutCoworkServer
} from '../../src/shared/cowork'

// A trimmed copy of a real ~/.copilot/mcp-config.json. Every server and every
// top-level key here belongs to the user, and a Cowork round trip has to leave
// all of it byte-for-byte intact.
const REAL = `{
  "mcpServers": {
    "azure": {
      "tools": ["*"],
      "type": "local",
      "command": "npx",
      "args": ["-y", "@azure/mcp@latest", "server", "start"]
    },
    "context7": {
      "tools": ["*"],
      "type": "http",
      "url": "https://mcp.context7.com/mcp"
    },
    "phoenix": {
      "type": "stdio",
      "command": "C:/Users/rajeshsingh/.scout/phoenix-mcp.exe"
    }
  },
  "somethingElse": { "kept": true }
}
`

describe('parseMcpConfig', () => {
  it('treats a missing/empty file as an empty config', () => {
    expect(parseMcpConfig('')).toEqual({})
    expect(parseMcpConfig('  \n ')).toEqual({})
  })

  it('refuses malformed JSON rather than guessing', () => {
    expect(parseMcpConfig('{"mcpServers": ')).toBeNull()
    expect(parseMcpConfig('not json')).toBeNull()
  })

  it('refuses JSON that is not an object', () => {
    expect(parseMcpConfig('[1,2,3]')).toBeNull()
    expect(parseMcpConfig('null')).toBeNull()
    expect(parseMcpConfig('"a string"')).toBeNull()
    expect(parseMcpConfig('42')).toBeNull()
  })
})

describe('coworkServerEntry', () => {
  it('is a local npx stdio server with every tool enabled', () => {
    const entry = coworkServerEntry()
    expect(entry.type).toBe('local')
    expect(entry.command).toBe('npx')
    expect(entry.tools).toEqual(['*'])
    expect(entry.args).toEqual(['-y', '@microsoft/workiq@latest', 'mcp'])
  })
})

describe('hasCoworkServer', () => {
  it('is false for a file that never had it', () => {
    expect(hasCoworkServer(parseMcpConfig(REAL)!)).toBe(false)
  })

  it('is false when mcpServers is absent', () => {
    expect(hasCoworkServer({})).toBe(false)
  })

  it('is false when mcpServers is the wrong shape, rather than throwing', () => {
    expect(hasCoworkServer({ mcpServers: ['nope'] })).toBe(false)
  })
})

describe('withCoworkServer', () => {
  it('adds the entry without disturbing anything else', () => {
    const before = parseMcpConfig(REAL)!
    const after = withCoworkServer(before)!

    expect(hasCoworkServer(after)).toBe(true)
    // The user's own metadata survives...
    expect(after.somethingElse).toEqual({ kept: true })
    // ...and so does every server that was already there.
    const servers = after.mcpServers as Record<string, unknown>
    expect(Object.keys(servers).sort()).toEqual(['azure', 'context7', 'phoenix', COWORK_SERVER_NAME])
    expect(servers.azure).toEqual((before.mcpServers as Record<string, unknown>).azure)
    expect(servers.context7).toEqual((before.mcpServers as Record<string, unknown>).context7)
  })

  it('does not mutate the input', () => {
    const before = parseMcpConfig(REAL)!
    withCoworkServer(before)
    expect(hasCoworkServer(before)).toBe(false)
  })

  it('creates mcpServers when the file has none', () => {
    const after = withCoworkServer({ theme: 'dark' })!
    expect(hasCoworkServer(after)).toBe(true)
    expect(after.theme).toBe('dark')
  })

  it('refuses to flatten an mcpServers that is not an object', () => {
    expect(withCoworkServer({ mcpServers: 'not an object' })).toBeNull()
  })
})

describe('withoutCoworkServer', () => {
  it('removes only the workiq entry', () => {
    const withIt = withCoworkServer(parseMcpConfig(REAL)!)!
    const after = withoutCoworkServer(withIt)
    expect(hasCoworkServer(after)).toBe(false)
    const servers = after.mcpServers as Record<string, unknown>
    expect(servers.azure).toBeDefined()
    expect(servers.phoenix).toBeDefined()
    expect(after.somethingElse).toEqual({ kept: true })
  })

  it('leaves mcpServers in place even when it empties', () => {
    const after = withoutCoworkServer({ mcpServers: { [COWORK_SERVER_NAME]: coworkServerEntry() } })
    expect(after.mcpServers).toEqual({})
  })

  it('is a no-op on a file that never had it', () => {
    const before = parseMcpConfig(REAL)!
    expect(withoutCoworkServer(before)).toEqual(before)
  })
})

describe('serializeMcpConfig', () => {
  it('round-trips and ends with a newline, the way the CLI writes it', () => {
    const config = withCoworkServer(parseMcpConfig(REAL)!)!
    const text = serializeMcpConfig(config)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "mcpServers"')
    expect(parseMcpConfig(text)).toEqual(config)
  })
})
