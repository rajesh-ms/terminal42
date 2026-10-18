/**
 * Pure helpers for editing `~/.copilot/mcp-config.json` — the Copilot CLI's own
 * MCP server file — to register the Microsoft Work IQ ("Cowork") MCP server.
 *
 * Why this file and not a `--additional-mcp-config` flag: terminal42 spawns the
 * `copilot` binary from more than one place (chat, design, recipes) and the
 * integrated terminal spawns it from a PTY the user drives. A flag reaches only
 * the spawns we author; the user-scope file is read by the CLI for every
 * session, so one entry covers all of them, terminal included.
 *
 * We only ever add or remove the single `workiq` key. Every other server in
 * that file belongs to the user (azure, context7, firecrawl, figma-write, ...)
 * and must survive a round trip untouched — hence the merge-based helpers
 * rather than writing a fresh object. An unparseable file is never rewritten.
 *
 * The entry shape was measured on Windows against Copilot CLI 1.0.98: the
 * server starts and the CLI reports it `connected` with its tools registered.
 * Getting a real answer still needs the Work IQ prerequisites — EULA, sign-in,
 * tenant admin consent and a usage-based billing plan — which are the user's to
 * complete, not ours. See docs/COWORK.md.
 */

/** The MCP server name terminal42 manages; also the prefix of its tools. */
export const COWORK_SERVER_NAME = 'workiq'

export type McpConfig = Record<string, unknown>

/** The `workiq` MCP server as terminal42 writes it. */
export type CoworkServerEntry = {
  tools: string[]
  type: string
  command: string
  args: string[]
}

/**
 * The entry terminal42 writes.
 *
 * `npx` rather than a bare `workiq` is deliberate: it is what the Work IQ docs
 * and the user's other servers use, and it resolves the package without
 * depending on a global install being on the PATH of the `copilot` child.
 * `type: "local"` matches the other stdio servers in a real user file, and
 * `@latest` matches how those entries are kept current.
 */
export function coworkServerEntry(): CoworkServerEntry {
  return {
    tools: ['*'],
    type: 'local',
    command: 'npx',
    args: ['-y', '@microsoft/workiq@latest', 'mcp']
  }
}

/**
 * Parse the MCP config file. Returns `null` when the text is not a JSON object,
 * which callers must treat as "refuse to write": replacing a file we failed to
 * understand would destroy the user's servers. A missing file arrives here as
 * `''` and yields `{}`.
 */
export function parseMcpConfig(text: string): McpConfig | null {
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as McpConfig
}

/**
 * The `mcpServers` object, or `null` when it exists but is the wrong shape — a
 * file we understand everything else about but must not flatten.
 */
function servers(config: McpConfig): Record<string, unknown> | null {
  const s = config.mcpServers
  if (s === undefined) return {}
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return null
  return s as Record<string, unknown>
}

/** Whether terminal42's Cowork server entry is present. */
export function hasCoworkServer(config: McpConfig): boolean {
  const s = servers(config)
  return !!s && typeof s[COWORK_SERVER_NAME] === 'object' && s[COWORK_SERVER_NAME] !== null
}

/**
 * Return a copy with the `workiq` entry set. Returns `null` when `mcpServers`
 * is present but not an object — the one shape we cannot merge into.
 */
export function withCoworkServer(config: McpConfig): McpConfig | null {
  const s = servers(config)
  if (s === null) return null
  return { ...config, mcpServers: { ...s, [COWORK_SERVER_NAME]: coworkServerEntry() } }
}

/**
 * Return a copy with the `workiq` entry removed.
 *
 * `mcpServers` itself is left in place even when it empties, so disabling never
 * removes a key the user had before we touched the file.
 */
export function withoutCoworkServer(config: McpConfig): McpConfig {
  const s = servers(config)
  if (s === null) return { ...config }
  const next = { ...s }
  delete next[COWORK_SERVER_NAME]
  return { ...config, mcpServers: next }
}

/** Serialize the way the CLI writes it: 2-space indent, trailing newline. */
export function serializeMcpConfig(config: McpConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}
