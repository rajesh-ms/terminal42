// The model catalog's static half, shared by the main process and the
// renderer so there is exactly one list to update.
//
// The live catalog is fetched from the Copilot CLI at runtime (see
// main/models.ts) and is always the source of truth once it arrives. What
// lives here is the baseline shown before that first fetch lands, and the
// permanent fallback for environments where the CLI path never works.
//
// This list previously existed twice — once in main/models.ts and once in
// ModelDropdown.tsx, kept in sync by hand. They drifted, which is how retired
// models (entitlements that no longer resolve) kept appearing in the picker.
// Import from here instead of re-declaring a list.

export type DisplayModel = { id: string; label: string; group: string }

/**
 * Mirrors the entitlement-filtered list the CLI currently returns. When the
 * live fetch reports models that are not here, update this list rather than
 * letting the two diverge again.
 *
 * Synced against the CLI's live list on 2026-10-18. Tenant-internal entries are
 * deliberately left out — the CLI advertises models whose own label carries an
 * "(Internal only)" suffix, and this list ships to every user of the app, so
 * pinning one tenant's internal entitlement here would put a model in the
 * picker that nobody else can select.
 */
export const FALLBACK_MODELS: DisplayModel[] = [
  { id: 'claude-opus-5.5', label: 'Claude Opus 5.5', group: 'Anthropic' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', group: 'Anthropic' },
  { id: 'claude-opus-4.8', label: 'Claude Opus 4.8', group: 'Anthropic' },
  { id: 'claude-opus-4.7', label: 'Claude Opus 4.7', group: 'Anthropic' },
  { id: 'claude-opus-4.6', label: 'Claude Opus 4.6', group: 'Anthropic' },
  { id: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5', group: 'Anthropic' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', group: 'Anthropic' },
  { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', group: 'Anthropic' },
  { id: 'claude-haiku-5.5', label: 'Claude Haiku 5.5', group: 'Anthropic' },
  { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', group: 'Anthropic' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', group: 'OpenAI' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', group: 'OpenAI' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', group: 'OpenAI' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', group: 'OpenAI' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', group: 'OpenAI' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', group: 'OpenAI' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', group: 'OpenAI' },
  { id: 'gpt-5.5', label: 'GPT-5.5', group: 'OpenAI' },
  { id: 'gpt-5.4', label: 'GPT-5.4', group: 'OpenAI' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', group: 'OpenAI' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', group: 'OpenAI' },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', group: 'OpenAI' },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', group: 'Google' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', group: 'Google' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', group: 'Google' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', group: 'Google' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', group: 'Google' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', group: 'Google' },
  { id: 'grok-4.7', label: 'Grok 4.7', group: 'xAI' },
  { id: 'grok-4.6', label: 'Grok 4.6', group: 'xAI' },
  { id: 'grok-4.5', label: 'Grok 4.5', group: 'xAI' },
  { id: 'mai-code-1.1-flash', label: 'MAI-Code-1.1-Flash', group: 'Microsoft' },
  { id: 'mai-code-1-flash-picker', label: 'MAI-Code-1-Flash', group: 'Microsoft' }
]

const KNOWN_PREFIXES: Array<{ test: RegExp; group: string }> = [
  { test: /^claude-/i, group: 'Anthropic' },
  { test: /^gpt-/i, group: 'OpenAI' },
  { test: /^o[0-9]/i, group: 'OpenAI' },
  { test: /^gemini-/i, group: 'Google' },
  { test: /^grok-/i, group: 'xAI' },
  { test: /^mai-/i, group: 'Microsoft' },
  { test: /^phi-/i, group: 'Microsoft' }
]

/** Groups a live model ID by provider so new IDs land in the right section. */
export function inferGroup(id: string): string {
  for (const { test, group } of KNOWN_PREFIXES) {
    if (test.test(id)) return group
  }
  return 'Other'
}

/** Provider section order in the picker; unknown providers sort last. */
export const GROUP_ORDER = ['Anthropic', 'OpenAI', 'Google', 'xAI', 'Microsoft', 'Other']

export function compareGroups(a: string, b: string): number {
  const ia = GROUP_ORDER.indexOf(a)
  const ib = GROUP_ORDER.indexOf(b)
  return (ia === -1 ? GROUP_ORDER.length : ia) - (ib === -1 ? GROUP_ORDER.length : ib)
}

/**
 * Maps a requested model onto one the given catalog will actually accept.
 *
 * Model IDs outlive the entitlements behind them: a session, design or recipe
 * saved months ago still carries whatever was selected at the time, and the
 * CLI emits internal IDs (`claude-opus-4.7-1m-internal`) that never appear in
 * the catalog at all. Passing a retired ID straight through to `--model`
 * fails the whole run, so resolve it first.
 *
 * Returns null when the flag should simply be omitted, letting the CLI pick
 * its own default — always better than failing on a name.
 */
export function resolveModelAgainst(
  catalog: DisplayModel[],
  requested: string | null | undefined
): string | null {
  if (!requested) return null
  // "auto" is the CLI's own router, not a catalog entry — pass it through.
  if (requested === 'auto') return 'auto'
  if (catalog.some((m) => m.id === requested)) return requested

  // Internal variants (`-1m-internal`, `-high`) decorate a real ID.
  const base = requested
    .replace(/-(?:\d+m-)?internal$/i, '')
    .replace(/-(?:high|low|1m)$/i, '')
  if (base !== requested && catalog.some((m) => m.id === base)) return base

  // Otherwise prefer another model from the same provider over something from
  // an unrelated family.
  const sameProvider = catalog.find((m) => m.group === inferGroup(requested))
  if (sameProvider) return sameProvider.id

  return null
}

/**
 * Splits a model ID into the family it belongs to and its version.
 *
 * The version is whichever dotted number appears in the ID; everything else,
 * in order, is the family. That keeps `gpt-5.6-sol` and `gpt-5.4-mini` in
 * different families while making `gemini-3.7-flash` a strictly newer
 * `gemini-flash` than `gemini-3.5-flash`.
 *
 * Deriving this from the ID rather than a maintained table is the point: the
 * catalog is fetched live, so a model that ships tomorrow has to rank
 * correctly without anyone editing this file.
 */
export function parseModelVersion(id: string): { family: string; version: number[] } {
  const parts = id.split('-')
  const version: number[] = []
  const family: string[] = []
  for (const part of parts) {
    // Only the first numeric token is the version. A trailing "1m" or similar
    // is a variant marker, not a newer release.
    if (!version.length && /^\d+(\.\d+)*$/.test(part)) {
      version.push(...part.split('.').map(Number))
    } else {
      family.push(part)
    }
  }
  return { family: family.join('-'), version }
}

/** Newest first. Compares version components numerically, not as text. */
export function compareModelRecency(a: string, b: string): number {
  const va = parseModelVersion(a).version
  const vb = parseModelVersion(b).version
  const len = Math.max(va.length, vb.length)
  for (let i = 0; i < len; i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0)
    if (d !== 0) return d
  }
  return a.localeCompare(b)
}

/**
 * Trims the catalog to the few models per provider anyone actually picks.
 *
 * The full entitlement list runs past twenty entries, most of them older
 * revisions of something already in the list. Selecting the newest of each
 * family first (rather than simply the newest N) is what stops Anthropic's
 * slots being spent on three generations of Opus while Sonnet and Haiku fall
 * off the end.
 *
 * `keepId` pins the current selection so a session on an older model never
 * shows an empty picker.
 */
export function shortlistModels(
  models: DisplayModel[],
  perGroup = 3,
  keepId?: string | null
): DisplayModel[] {
  const byGroup = new Map<string, DisplayModel[]>()
  for (const m of models) {
    const list = byGroup.get(m.group) ?? []
    list.push(m)
    byGroup.set(m.group, list)
  }

  const picked: DisplayModel[] = []
  for (const [, list] of byGroup) {
    const newestPerFamily = new Map<string, DisplayModel>()
    for (const m of [...list].sort((a, b) => compareModelRecency(a.id, b.id))) {
      const { family } = parseModelVersion(m.id)
      if (!newestPerFamily.has(family)) newestPerFamily.set(family, m)
    }
    picked.push(
      ...[...newestPerFamily.values()]
        .sort((a, b) => compareModelRecency(a.id, b.id))
        .slice(0, perGroup)
    )
  }

  if (keepId && !picked.some((m) => m.id === keepId)) {
    const pinned = models.find((m) => m.id === keepId)
    if (pinned) picked.push(pinned)
  }

  return picked.sort(
    (a, b) => compareGroups(a.group, b.group) || compareModelRecency(a.id, b.id)
  )
}

/** How long a cached catalog stays good before we spawn the CLI to refresh it. */
export const MODEL_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000

/** Delay before the first refresh when there is nothing usable cached. */
export const STARTUP_REFRESH_DELAY_MS = 3000

/**
 * How long to wait before the first catalog refresh of a launch.
 *
 * Refreshing spawns the CLI, and the CLI reads its credential from the macOS
 * keychain, which can surface a system password dialog. Doing that on every
 * launch interrupts the user with a prompt they never asked for, to fetch a
 * list that changes a few times a year. A cache still inside its refresh
 * window therefore defers the spawn rather than repeating it.
 *
 * A timestamp in the future means the clock moved, not that the cache is
 * impossibly fresh. That defers a full cycle as well: guessing wrong costs a
 * slightly stale model list, while spawning costs the dialog this exists to
 * remove.
 */
export function refreshDelayMs(
  fetchedAt: number | null,
  now: number,
  interval: number = MODEL_REFRESH_INTERVAL_MS
): number {
  if (fetchedAt === null || !Number.isFinite(fetchedAt)) return STARTUP_REFRESH_DELAY_MS
  const age = now - fetchedAt
  if (age < 0) return interval
  if (age >= interval) return STARTUP_REFRESH_DELAY_MS
  return interval - age
}
