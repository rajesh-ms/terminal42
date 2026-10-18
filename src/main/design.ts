import { ipcMain, BrowserWindow, shell, dialog, app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs, watch as fsWatch, type FSWatcher, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import { extractPptxFacts, pptxFactsToPrompt, type PptxFacts } from './pptx'
import { pptxToPdf } from './render'
import { getSettings } from './settings'
import { lintHtml, buildFixPrompt } from './lintHtml'
import { lintAgainstTokens, describeTokensFindings } from '../shared/tokens/lint'
import { buildFoundationBlock } from './designFoundation'
import { AI_RULES, formatRulesForPrompt } from '../renderer/src/lib/aiRules'
import { tokensHash, formatTokensForPrompt, toCSS, toDTCG, toMarkdown } from '../shared/tokens/export'
import { enforcementOf, hydrateStudio, themeIdFor, type Enforcement } from '../shared/tokens/types'
import { getTokenStudio } from './tokens'
import { upsertManagedBlock } from './htmlBlocks'
import { buildEngineBaseBlock, ENGINE_USAGE, ENGINE_BASE_ID, ENGINE_MOTION_ID } from './designAssets'
import { pickVariety } from './designVariety'
import { pickDeckStyle } from './deckStyles'
import { pickWebsiteStyle } from './websiteStyles'
import { applyBaseHref, effectiveBase, inlineLocalAssets } from './versionBase'
import { serveDesign } from './designOrigin'
import { looksLikeSpa } from '../shared/spa'
import { buildDeckBaseBlock, DECK_USAGE, DECK_BASE_ID, DECK_RUNTIME_ID } from './deckChassis'
import {
  EXPORT_PREP_JS,
  SLIDE_COUNT_JS,
  showSlideJs,
  buildSlidePdfHtml,
  DECK_CAPTURE_SIZE
} from './deckCapture'
import {
  type ExportFormat,
  extFor,
  viewportForKind,
  pdfPageForKind,
  pdfLandscapeForKind,
  formatsForKind,
  canExportToFigma
} from './designExport'
import {
  createDesign,
  duplicateDesign,
  getDesign,
  importDesignFromFolder,
  importDesignFromGit,
  insertMessage,
  listDesigns,
  listVersions,
  loadHistory,
  maybeAutoTitle,
  nextVersionNumber,
  renameDesign,
  saveCopilotResumeId,
  setCurrentVersion,
  updateMessage
} from './designStore'

// ─── Types ────────────────────────────────────────────────────────────────

import { resolveModel } from './models'
import { copilotEnv } from './copilotAuth'
import type {
  DesignToolCall,
  DesignMessage,
  DesignKind,
  DesignGroup,
  DesignBrief,
  DesignVersion,
  DesignProgressStep,
  TokensStatus
} from './design.types'

export type {
  DesignRole,
  DesignStatus,
  DesignToolCall,
  DesignMessage,
  DesignKind,
  DesignGroup,
  DesignFidelity,
  DesignBrief,
  Design,
  DesignVersion,
  DesignProgressStep
} from './design.types'


type RunState = {
  child: ChildProcess
  assistantMsgId: string | null
  buffer: string
  toolCalls: Map<string, DesignToolCall>
  cancelled: boolean
  progress: Map<string, DesignProgressStep>
  progressOrder: string[]
  isAutoFix: boolean
  doneEmitted: boolean
  // Retry context: if Copilot rejects the chosen --model (one-shot mode does
  // not auto-fall-back), we re-send the same prompt without --model. If THAT
  // gets rate-limited and the error is eligible for auto-switch, we retry
  // once more with --model auto.
  requestedModel: string | null
  originalText: string
  originalOpts: { skipPrefix?: boolean; useFigma?: boolean; freshSession?: boolean; agentMode?: 'interactive' | 'plan' | 'autopilot'; isAutoFix?: boolean; displayText?: string | null }
  isModelFallback: boolean
  isAutoFallback: boolean
  rateLimitMessage: string | null
  rateLimitAutoEligible: boolean
}

const running = new Map<string, RunState>()

// Single cleanup path for a finished/aborted run. Identity-guarded so a
// late cleanup (e.g. SIGKILL timeout, child 'error' event) can't delete a
// NEWER run that started in the meantime. Also idempotent so we never emit
// `design:done` twice if both 'error' and 'close' fire for the same child.
function finalizeRun(
  win: BrowserWindow | null,
  designId: string,
  state: RunState,
  exitCode: number
): void {
  if (running.get(designId) !== state) return
  running.delete(designId)
  if (state.doneEmitted) return
  state.doneEmitted = true
  emit(win, 'design:done', { designId, exitCode })
}
const watchers = new Map<string, FSWatcher>()


async function deleteDesign(id: string): Promise<{ ok: boolean }> {
  const d = getDesign(id)
  if (!d) return { ok: false }
  // Cancel any in-flight run, stop watcher
  cancel(id)
  unwatch(id)
  getDb().prepare('DELETE FROM designs WHERE id = ?').run(id)
  // Best-effort delete cwd
  try { await fs.rm(d.cwd, { recursive: true, force: true }) } catch {}
  return { ok: true }
}


async function createStarterTemplateVersion(designId: string, userText: string, opts: { addWatermark?: boolean } = {}): Promise<DesignVersion | null> {
  const d = getDesign(designId)
  if (!d || !d.brief?.starterTemplateId) return null

  const source = existsSync(join(d.cwd, 'dist', 'index.html'))
    ? join(d.cwd, 'dist', 'index.html')
    : existsSync(join(d.cwd, 'index.html'))
      ? join(d.cwd, 'index.html')
      : null
  if (!source) return null

  let html = await fs.readFile(source, 'utf8')
  const baseDir = relative(d.cwd, source.replace(/\/index\.html$/i, '')) || '.'
  const baseHref = baseDir === '.' ? './' : `./${baseDir}/`
  if (!/<base\s/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`)
  }
  const b = d.brief
  const title = `${b.starterTemplateName ?? 'Starter'} - ${b.idea || userText || 'adapted preview'}`
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)
  if (b.primaryColor || b.secondaryColor || b.accentColor) {
    const css = `\n<style id="t42-template-fallback-theme">\n:root {\n  ${b.primaryColor ? `--t42-primary: ${b.primaryColor};` : ''}\n  ${b.secondaryColor ? `--t42-secondary: ${b.secondaryColor};` : ''}\n  ${b.accentColor ? `--t42-accent: ${b.accentColor};` : ''}\n}\n${opts.addWatermark ? `body::before {\n  content: "${escapeCssString((b.idea || userText || '').slice(0, 120))}";\n  position: fixed;\n  right: 16px;\n  bottom: 16px;\n  z-index: 2147483647;\n  max-width: 360px;\n  padding: 10px 12px;\n  border-radius: 12px;\n  color: #ffffff;\n  background: ${b.primaryColor ?? '#111827'};\n  font: 500 12px/1.4 system-ui, sans-serif;\n  box-shadow: 0 8px 24px rgba(0,0,0,.18);\n  pointer-events: none;\n}` : ''}\n</style>\n`
    html = html.replace(/<\/head>/i, `${css}</head>`)
  }

  const nextFile = `v${String(nextVersionNumber(designId)).padStart(3, '0')}.html`
  await fs.writeFile(join(d.cwd, nextFile), html, 'utf8')
  setCurrentVersion(designId, nextFile.replace(/\.html$/i, ''))
  return listVersions(designId).find((v) => v.fileName === nextFile) ?? null
}

async function buildTemplatePreviewFallback(designId: string, userText: string): Promise<DesignVersion | null> {
  return createStarterTemplateVersion(designId, userText, { addWatermark: true })
}

// Write a full HTML document as a new version directly (used by the freeform
// canvas export). Unlike applyDesignEdit this does not require a prior version.
async function writeDesignHtml(designId: string, html: string): Promise<DesignVersion | null> {
  const d = getDesign(designId)
  if (!d) return null
  await fs.mkdir(d.cwd, { recursive: true })
  const nextFile = `v${String(nextVersionNumber(designId)).padStart(3, '0')}.html`
  await fs.writeFile(join(d.cwd, nextFile), html, 'utf8')
  setCurrentVersion(designId, nextFile.replace(/\.html$/i, ''))
  return listVersions(designId).find((v) => v.fileName === nextFile) ?? null
}

// Direct "bake" engine: write an edit straight into the design file as a new
// version, with NO AI round-trip. Used by the in-app Motion editor and inspector
// so changes are real, deterministic, and instantly versioned. The edit lives in
// a managed <style data-t42-block="..."> block that is replaced on each apply.
async function applyDesignEdit(designId: string, blockId: string, content: string, tag: 'style' | 'script' = 'style'): Promise<DesignVersion | null> {
  const d = getDesign(designId)
  if (!d) return null
  const versions = listVersions(designId)
  const latest = versions[versions.length - 1]
  if (!latest || latest.kind !== 'html') return null

  let html = ''
  try { html = await fs.readFile(latest.filePath, 'utf8') } catch { return null }

  html = upsertManagedBlock(html, blockId, content, tag)

  const nextFile = `v${String(nextVersionNumber(designId)).padStart(3, '0')}.html`
  await fs.writeFile(join(d.cwd, nextFile), html, 'utf8')
  setCurrentVersion(designId, nextFile.replace(/\.html$/i, ''))
  return listVersions(designId).find((v) => v.fileName === nextFile) ?? null
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

// ─── Design prefix (built-in for design.send) ─────────────────────────────


// ─── Prompt construction (stripped for public release) ────────────────────
// Implement your own prompt builders here.

function summariseBrief(b: DesignBrief | null): string {
  if (!b) return ''
  return [b.kindLabel, b.subtype, b.lookLabel, b.audience].filter(Boolean).join(' · ')
}


/** The rule ids the user is enforcing for this design (all rules if unset). */
function enabledRuleIds(brief: DesignBrief | null): string[] {
  if (brief?.aiRules) {
    return Object.keys(brief.aiRules).filter((id) => brief.aiRules![id] !== false)
  }
  return AI_RULES.map((r) => r.id)
}

/**
 * The bound library, as a block for the prompt.
 *
 * Read at the moment of generation rather than stored on the design, because
 * the library is the thing that moves: a design bound to it should be told
 * what the names mean today, not what they meant when it was first made.
 *
 * Silent when there is no binding, when the library has been deleted, and when
 * it resolves to nothing. None of those is worth a sentence in a prompt.
 */
export function buildTokensBlock(brief: DesignBrief | null): string {
  if (!brief?.tokensId) return ''
  try {
    const record = getTokenStudio(brief.tokensId)
    if (!record) return ''
    const studio = hydrateStudio(record.studio)
    const block = formatTokensForPrompt(studio, themeIdFor(studio, brief.tokensThemeId))
    if (!block) return ''
    // A design here is one self-contained file, so it cannot link the
    // stylesheet the block refers to. The declarations have to come inside,
    // which is a copy rather than a link and so has to be said out loud.
    return `${block}\nThe file tokens.css sits in this folder and defines every property above. Because the page must stay self-contained, paste its :root block into the page\u2019s own <style> verbatim rather than linking it, then use the variables everywhere.`
  } catch {
    // A library that cannot be read is not a reason to refuse to generate.
    return ''
  }
}

/**
 * Whether a design is bound to a library that is no longer there.
 *
 * A binding that cannot be read is the one failure worth interrupting for.
 * Everything downstream of it is written to carry on quietly — the prompt
 * block returns an empty string, the files are not written, the stamp stays
 * as it was — so without this the design would be generated with no token
 * guidance at all and look, from the outside, exactly like a design that was
 * never bound. The user would get invented hex values back and no reason why.
 */
export function libraryMissing(brief: DesignBrief | null): boolean {
  if (!brief?.tokensId) return false
  try {
    return !getTokenStudio(brief.tokensId)
  } catch {
    // A database that will not answer is not the same as a deleted library,
    // and guessing deleted here would cry wolf on every generation.
    return false
  }
}

/**
 * The bound library's three files, in the design's own folder.
 *
 * Failure is swallowed for the same reason the prompt block is: a library that
 * cannot be read is a reason to generate without it, not a reason to refuse.
 */
export async function writeTokensFiles(cwd: string, brief: DesignBrief): Promise<string | null> {
  if (!brief.tokensId) return null
  try {
    const record = getTokenStudio(brief.tokensId)
    if (!record) return null
    const studio = hydrateStudio(record.studio)
    const themeId = themeIdFor(studio, brief.tokensThemeId)
    await fs.writeFile(join(cwd, 'tokens.css'), toCSS(studio, themeId), 'utf8')
    await fs.writeFile(join(cwd, 'tokens.json'), toDTCG(studio, themeId), 'utf8')
    await fs.writeFile(join(cwd, 'tokens.md'), toMarkdown(studio, themeId), 'utf8')
    // Returned rather than written here: what the files say is this module's
    // business, but which design was built from them is the caller's.
    return tokensHash(studio, themeId)
  } catch (err) {
    console.error('[design] could not write the bound library:', err)
    return null
  }
}

/**
 * Whether the library has moved since a design was last built against it.
 *
 * Says no whenever it cannot say yes. A design with no library, a library that
 * has been deleted, and a design generated before stamping existed all read
 * the same way: nothing to report. The flag exists to send someone to a
 * Re-sync button, and sending them there on a guess wastes the one bit of
 * attention the flag has.
 */
export function tokensHaveMoved(brief: DesignBrief | null): boolean {
  if (!brief?.tokensId || !brief.tokensStamp) return false
  try {
    const record = getTokenStudio(brief.tokensId)
    if (!record) return false
    const studio = hydrateStudio(record.studio)
    return tokensHash(studio, themeIdFor(studio, brief.tokensThemeId)) !== brief.tokensStamp
  } catch {
    return false
  }
}

/**
 * What the finished page did with the library it was handed.
 *
 * Capped, because the point of the report is that somebody acts on it: a page
 * that ignored the library entirely produces a hundred findings, and a hundred
 * findings is the same as none. The loudest dozen are the ones worth fixing,
 * and fixing them usually removes the rest.
 */
function lintTokens(html: string, brief: DesignBrief | null): { name: string; lines: string[] } {
  const empty = { name: '', lines: [] as string[] }
  if (!brief?.tokensId) return empty
  try {
    const record = getTokenStudio(brief.tokensId)
    if (!record) return empty
    const studio = hydrateStudio(record.studio)
    const findings = lintAgainstTokens(html, studio, themeIdFor(studio, brief.tokensThemeId))
    return { name: record.name, lines: describeTokensFindings(findings.slice(0, 12), record.name) }
  } catch {
    return empty
  }
}

function buildStarterPrefix(cwd: string, brief: DesignBrief): string {
  const blocks: string[] = []
  blocks.push(
    buildFoundationBlock({ look: brief.look ?? null, designSystem: brief.designSystem ?? null, theme: brief.theme ?? null }),
  )
  blocks.push(
    `You are adapting the ${brief.starterTemplateName ?? 'starter'} template whose files already live in this folder (${cwd}). Read them first, keep their structure and engineering quality, and adapt the content, copy, palette, fonts and imagery to the brief below. Do not rebuild from scratch and do not regress the existing quality.`,
  )
  const briefLines = summariseBriefForPrompt(brief)
  if (briefLines.length) blocks.push(['BRIEF', ...briefLines].join('\n'))
  const rules = formatRulesForPrompt(enabledRuleIds(brief))
  if (rules) blocks.push(rules)
  const tokens = buildTokensBlock(brief)
  if (tokens) blocks.push(tokens)
  return blocks.filter(Boolean).join('\n\n')
}

export function buildPrefix(
  versionFileName: string,
  brief: DesignBrief | null,
  previousVersionFileName: string | null = null,
  pptxFacts: PptxFacts | null = null,
): string {
  const blocks: string[] = []
  blocks.push(
    buildFoundationBlock({ look: brief?.look ?? null, designSystem: brief?.designSystem ?? null, theme: brief?.theme ?? null }),
  )

  const briefLines = summariseBriefForPrompt(brief)
  if (briefLines.length) blocks.push(['BRIEF', ...briefLines].join('\n'))

  const rules = formatRulesForPrompt(enabledRuleIds(brief))
  if (rules) blocks.push(rules)

  // After the rules, because it is the same kind of instruction and the same
  // voice, and before the engine base, which the tokens are meant to feed.
  const tokens = buildTokensBlock(brief)
  if (tokens) blocks.push(tokens)

  if (pptxFacts) {
    blocks.push('A reference template has been analyzed; its facts live in _tpl/_facts.md in this folder. Match its structure where it is relevant.')
  }

  // Web pages get the variety direction (so we do not churn out the same look)
  // and the engine base (so motion, tokens, spacing and reduced-motion are real
  // code the page builds on, not re-derived). Email and non-web kinds skip both.
  const isWeb = !!brief && brief.group === 'web' && brief.kind !== 'email'
  if (isWeb) {
    blocks.push(pickVariety(brief).text)
    blocks.push(
      `ENGINE BASE (use exactly this, do not modify it)\n` +
        `The page must include this engine base: put the <style id="${ENGINE_BASE_ID}"> in <head> and the <script id="${ENGINE_MOTION_ID}"> just before </body>. If a previous version already contains them, keep them byte-for-byte. Build the page using their tokens, classes and data-attributes.\n\n` +
        `${buildEngineBaseBlock()}\n\n${ENGINE_USAGE}`,
    )
    // Only when a template was actually chosen. Left to itself the variety
    // engine already keeps two sites from looking alike, and a second art
    // director arguing with the first produces a page that follows neither.
    if (brief?.webStyleId) blocks.push(pickWebsiteStyle(brief).text)
  }

  // Decks get the same medicine, and more of it. A deck is not a page: it
  // needs navigation, a contents list and a snap stage before it needs any
  // art direction at all, and asking for those in prose produced a stack of
  // sections with the edges cut off. So the chassis ships as code and the
  // house style is reduced to the values that drive it.
  if (brief && brief.group === 'presentation') {
    blocks.push(
      `DECK CHASSIS (use exactly this, do not modify it)\n` +
        `The deck must include this chassis: put the <style id="${DECK_BASE_ID}"> in <head> and the <script id="${DECK_RUNTIME_ID}"> just before </body>. If a previous version already contains them, keep them byte-for-byte.\n\n` +
        `${buildDeckBaseBlock()}\n\n${DECK_USAGE}`,
    )
    blocks.push(pickDeckStyle(brief).text)
  }

  const out: string[] = ['OUTPUT']
  if (previousVersionFileName) {
    out.push(
      `This is an iteration. Read ${previousVersionFileName} in this folder, apply the request and the rules above, and save the result as a single self-contained HTML file named ${versionFileName}.`,
    )
  } else {
    out.push(
      `Produce the design as a single, self-contained HTML file named ${versionFileName}: all CSS inline in a <style> block, no build step and no external JS dependencies. Web fonts and images loaded by URL are fine.`,
    )
  }
  out.push('It must be responsive, accessible, and follow every rule above.')
  blocks.push(out.join('\n'))

  return blocks.filter(Boolean).join('\n\n')
}

function summariseBriefForPrompt(b: DesignBrief | null): string[] {
  if (!b) return []
  const lines: string[] = []
  const add = (label: string, value?: string | null): void => {
    if (value != null && String(value).trim()) lines.push(`- ${label}: ${String(value).trim()}`)
  }

  add('What', b.kindLabel || b.kind)
  add('Subtype', b.subtype)
  add('Surface', b.surface)
  add('Fidelity', b.fidelity === 'wireframe' ? 'wireframe' : 'high fidelity')
  add('Audience', b.audience)

  if (b.paletteColors && b.paletteColors.length) add('Palette', b.paletteColors.join(', '))
  else {
    const cols = [b.primaryColor, b.secondaryColor, b.accentColor].filter(Boolean) as string[]
    if (cols.length) add('Colors', cols.join(', '))
    else add('Palette', b.paletteLabel)
  }

  const fonts = [b.fontHeading || b.fontPrimary, b.fontBody || b.fontSecondary].filter(Boolean) as string[]
  if (fonts.length) add('Fonts', fonts.join(' + '))
  else if (b.fontPrimaryLabel || b.fontPairId) add('Fonts', b.fontPrimaryLabel || b.fontPairId)
  add('Custom fonts', b.customFonts)

  add('Theme', b.theme)
  add('Density', b.density)
  add('Spacing', b.spacing)
  add('Grid', b.grid)
  add('Motion', b.customMotion || b.motion)

  const shape = [
    b.shapeRadiusLabel || b.shapeRadius,
    b.shapeShadowLabel || b.shapeShadow,
    b.shapeBordersLabel || b.shapeBorders,
    b.shapeSurfaceLabel || b.shapeSurface,
  ].filter(Boolean) as string[]
  if (shape.length) add('Shape', shape.join(', '))
  add('Secondary button', b.secondaryButtonLabel || b.secondaryButton)
  add('Icons', b.iconStyleLabel || b.iconLibraryLabel)
  add('Stack', b.customStack || b.stackLabel || b.stack)

  add('Idea', b.idea)
  add('Description', b.contextDescription)
  add('Problem', b.contextProblem)
  add('Goal', b.contextGoal)
  add('Key features', b.contextKeyFeatures)
  add('Success', b.contextSuccess)
  add('Inspiration', b.inspiration)
  if (b.decisions && b.decisions.length) add('Decisions', b.decisions.join('; '))
  add('Also avoid', b.customAvoid)

  return lines
}

function emit(win: BrowserWindow | null, channel: string, payload: unknown): void {
  // Guard against post-crash sends. After a renderer kill, webContents is
  // still defined but its frame is disposed: calling .send() throws and
  // also produces "Render frame was disposed" noise in main's stderr.
  try {
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc || wc.isDestroyed() || wc.isCrashed?.()) return
    wc.send(channel, payload)
  } catch { /* silenced: renderer gone */ }
}

function processJsonEvent(
  win: BrowserWindow | null,
  designId: string,
  state: RunState,
  evt: { type: string; data?: Record<string, unknown>; sessionId?: string; exitCode?: number }
): void {
  const t = evt.type

  // Capture rate-limit errors so the close handler can either auto-switch
  // to the "auto" model picker or surface a friendly message. Copilot exits
  // cleanly (code 0) after emitting this so a pure exit-code check misses it.
  if (t === 'session.error') {
    const d = (evt.data as { errorType?: string; message?: string; eligibleForAutoSwitch?: boolean }) ?? {}
    if (d.errorType === 'rate_limit') {
      state.rateLimitMessage = typeof d.message === 'string' ? d.message : 'Copilot rate limit reached.'
      state.rateLimitAutoEligible = !!d.eligibleForAutoSwitch
    }
  }

  // Build a structured checklist as the run progresses. Each step is
  // identified by a stable id; status flips from 'running' → 'done' as
  // the corresponding events fire. The renderer displays this as a
  // ✓ / spinner list so the user can see what's actually happening.
  const setStep = (id: string, label: string, status: 'running' | 'done' | 'error'): void => {
    const existing = state.progress.get(id)
    if (!existing) {
      state.progress.set(id, { id, label, status, startedAt: Date.now() })
      state.progressOrder.push(id)
    } else {
      state.progress.set(id, { ...existing, status, label: label || existing.label })
    }
    emit(win, 'design:progress', {
      designId,
      steps: state.progressOrder.map((sid) => state.progress.get(sid)!).filter(Boolean)
    })
  }
  const finishStep = (id: string): void => {
    const s = state.progress.get(id)
    if (s && s.status === 'running') setStep(id, s.label, 'done')
  }

  // Surface startup progress as live phase strings: copilot takes a few
  // seconds spinning up MCP servers / loading tools before the first
  // assistant.message_start, and otherwise the user just stares at "Working…".
  if (t === 'session.mcp_server_status_changed') {
    const data = (evt.data as Record<string, unknown>) ?? {}
    const name = String(data.serverName ?? '')
    const status = String(data.status ?? '')
    if (status === 'connected') {
      setStep('mcp:' + name, `Connected ${name}`, 'done')
    } else if (status === 'connecting') {
      setStep('mcp:' + name, `Connecting ${name}`, 'running')
    } else {
      setStep('mcp:' + name, `${name}: ${status}`, status === 'error' ? 'error' : 'done')
    }
    return
  }
  if (t === 'session.tools_updated') {
    setStep('tools', 'Loaded tools', 'done')
    return
  }
  if (t === 'assistant.turn_start') {
    setStep('think', 'Thinking', 'running')
    return
  }
  if (t === 'assistant.message_start') {
    finishStep('think')
    setStep('reply', 'Writing reply', 'running')
    const id = randomUUID()
    state.assistantMsgId = id
    const msg: DesignMessage = {
      id, designId, role: 'assistant', content: '',
      toolCalls: Array.from(state.toolCalls.values()),
      status: 'streaming', createdAt: Date.now()
    }
    insertMessage(msg)
    emit(win, 'design:message', msg)
    return
  }
  if (t === 'assistant.message_delta') {
    const delta = String((evt.data as Record<string, unknown>)?.deltaContent ?? '')
    if (!delta || !state.assistantMsgId) return
    state.buffer += delta
    emit(win, 'design:delta', { designId, messageId: state.assistantMsgId, delta })
    return
  }
  if (t === 'assistant.message') {
    finishStep('reply')
    const content = String((evt.data as Record<string, unknown>)?.content ?? state.buffer)
    if (!state.assistantMsgId) return
    const msg: DesignMessage = {
      id: state.assistantMsgId, designId, role: 'assistant', content,
      toolCalls: Array.from(state.toolCalls.values()),
      status: 'done', createdAt: Date.now()
    }
    updateMessage(msg)
    emit(win, 'design:message', msg)
    state.buffer = ''
    state.assistantMsgId = null
    return
  }
  if (t === 'tool.execution_start') {
    const data = (evt.data as Record<string, unknown>) ?? {}
    const id = String(data.toolCallId ?? data.id ?? randomUUID())
    const name = String(data.toolName ?? data.name ?? 'tool')
    const args = data.arguments ?? data.input
    const input = args ? JSON.stringify(args).slice(0, 400) : undefined
    state.toolCalls.set(id, { id, name, input, status: 'running' })
    emit(win, 'design:tool', { designId, tool: state.toolCalls.get(id) })
    setStep('tool:' + id, friendlyToolLabel(name, args), 'running')
    return
  }
  if (t === 'tool.execution_complete' || t === 'tool.execution_end' || t === 'tool.result') {
    const data = (evt.data as Record<string, unknown>) ?? {}
    const id = String(data.toolCallId ?? data.id ?? '')
    const existing = state.toolCalls.get(id)
    if (!existing) return
    const isError = data.success === false || data.status === 'error' || data.outcome === 'error'
    existing.status = isError ? 'error' : 'done'
    const result = data.result as { content?: unknown } | undefined
    const summary = result?.content ?? data.summary
    if (summary) existing.summary = String(summary).slice(0, 280)
    state.toolCalls.set(id, existing)
    emit(win, 'design:tool', { designId, tool: existing })
    setStep('tool:' + id, '', isError ? 'error' : 'done')
    return
  }
  if (t === 'result') {
    // Mark any lingering steps as done
    for (const sid of state.progressOrder) {
      const s = state.progress.get(sid)
      if (s && s.status === 'running') setStep(sid, s.label, 'done')
    }
    const copilotSessionId = (evt as { sessionId?: string }).sessionId
    if (copilotSessionId) saveCopilotResumeId(designId, copilotSessionId)
    // NOTE: do NOT emit 'design:done' here. The CLI emits `result` before
    // the child process actually closes, which means `running.has()` is
    // still true. Emitting `design:done` here would flip the renderer's
    // busy state to false, the queue drainer would fire, and the next
    // send() would be rejected with "Another response is in progress" —
    // dropping the user's queued/annotation prompt. `finalizeRun` (called
    // from child 'close') is now the single source of truth for done.
    return
  }
}

// Map raw tool names + arguments to short human labels for the progress
// checklist. Falls back to the tool name as-is.
function friendlyToolLabel(toolName: string, args?: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  const path = (a.path ?? a.file ?? a.filePath ?? a.targetPath) as string | undefined
  const baseName = path ? String(path).split('/').filter(Boolean).pop() : undefined
  const lower = (toolName || '').toLowerCase()
  if (lower === 'create' || lower === 'write_file' || lower.includes('write')) return baseName ? `Writing ${baseName}` : 'Writing file'
  if (lower === 'edit' || lower.includes('edit') || lower.includes('replace')) return baseName ? `Editing ${baseName}` : 'Editing file'
  if (lower.includes('read') || lower === 'view') return baseName ? `Reading ${baseName}` : 'Reading file'
  if (lower.includes('grep') || lower.includes('search')) {
    const pat = (a.pattern ?? a.query) as string | undefined
    return pat ? `Searching for "${String(pat).slice(0, 30)}"` : 'Searching'
  }
  if (lower.includes('bash') || lower.includes('shell')) {
    // Surface the actual command (or its head) so the user can see what
    // is being run: much more useful than three identical 'Running shell'
    // lines in a row.
    const cmd = (a.command ?? a.cmd ?? a.script) as string | undefined
    if (cmd) {
      const oneLine = String(cmd).replace(/\s+/g, ' ').trim()
      // Take the first sub-command before && or | so the label stays short.
      const head = oneLine.split(/\s*&&\s*|\s*\|\s*|\s*;\s*/)[0]
      return head.length > 60 ? `Running: ${head.slice(0, 60)}…` : `Running: ${head}`
    }
    return 'Running shell'
  }
  if (lower === 'glob' || lower === 'find' || lower === 'list') return 'Listing files'
  if (lower.startsWith('figma')) {
    // figma-write-figma_auto_layout → "Figma · write figma auto layout"
    const stripped = toolName.replace(/^figma[-_]/i, '').replace(/[-_]/g, ' ')
    return `Figma · ${stripped}`
  }
  return toolName
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try { return JSON.parse(trimmed) as Record<string, unknown> } catch { return null }
}

// Build a per-design AGENTS.md so the Copilot CLI injects template
// constraints into the system prompt automatically: much more sticky than
// a single user-message prompt the model can rush past.
function buildAgentsMd(facts: PptxFacts): string {
  const colors = Object.entries(facts.theme.colors)
  const colorCss = colors.map(([k, v]) => `  --${k}: ${v};`).join('\n')
  const heading = facts.theme.headingFont || 'system-ui'
  const body = facts.theme.bodyFont || 'system-ui'
  const slideLines = facts.slides.map((s) =>
    `${String(s.index).padStart(2, '0')}. [${s.layoutName ?? '?'}] ${s.title ? `"${s.title}"` : '(no title)'}`
  ).join('\n')
  return [
    '# TEMPLATE FIDELITY: STRICT MODE',
    '',
    'This design has a .pptx template attached and the user ticked "Use everything from this template".',
    'You MUST follow the template 1:1 for visuals. Only the CONTENT of each slide changes.',
    '',
    '## Hard rules',
    '',
    `- Output exactly **${facts.slideCount} slides** in the same order, one \`<section class="slide">\` each.`,
    `- Slide artboard size: **${facts.slideWidthPx}×${facts.slideHeightPx}px** (${facts.aspect}). Apply to every \`.slide\`.`,
    '- Use ONLY the theme colours below as `:root` CSS variables. Reference them via `var(--xxx)` everywhere: do NOT hardcode any other hex values.',
    '- Use ONLY the theme fonts below for headings and body. Do NOT default to Inter / DM Sans / etc.',
    '- Do NOT add gradients, eyebrow pills, fake testimonials, fake stats, em-dashes, or any decoration not in the original template.',
    '- Mirror each slide\'s layout: title slide → centered title + subtitle; title+content → top title + body block; two-content → title + 2 columns; section header → centered eyebrow + giant title.',
    '',
    '## CSS scaffold (paste this into `<style>` and only fill in the rest)',
    '',
    '```css',
    ':root {',
    colorCss,
    `  --font-heading: "${heading}", system-ui, sans-serif;`,
    `  --font-body: "${body}", system-ui, sans-serif;`,
    '}',
    'html, body { margin: 0; height: 100vh; overflow: hidden; }',
    'body { display: flex; flex-direction: row; overflow-x: auto; scroll-snap-type: x mandatory; font-family: var(--font-body); }',
    `.slide { flex: 0 0 ${facts.slideWidthPx}px; height: ${facts.slideHeightPx}px; box-sizing: border-box; scroll-snap-align: start; }`,
    'h1, h2, h3, h4 { font-family: var(--font-heading); margin: 0; }',
    '```',
    '',
    '## Per-slide content map',
    '',
    'The user will tell you what to put on each slide. Map their content onto these existing slots: keep word counts roughly equal:',
    '',
    '```',
    slideLines,
    '```',
    '',
    '## Workflow',
    '',
    '1. Read this file (you already are).',
    '2. Read the user\'s idea / instruction.',
    '3. Write the HTML: start with the CSS scaffold above, then write each `<section class="slide">` in order.',
    '4. Reply with at most 4 bullets describing what changed (no HTML in chat).'
  ].join('\n') + '\n'
}

async function send(
  win: BrowserWindow | null,
  designId: string,
  text: string,
  opts: { model?: string | null; skipPrefix?: boolean; useFigma?: boolean; freshSession?: boolean; agentMode?: 'interactive' | 'plan' | 'autopilot'; isAutoFix?: boolean; displayText?: string | null; isModelFallback?: boolean; isAutoFallback?: boolean }
): Promise<{ ok: true } | { ok: false; error: string; accepted?: boolean }> {
  const d = getDesign(designId)
  if (!d) return { ok: false, error: 'Design not found.', accepted: false }
  // Auto-fix runs are triggered from inside the previous run's close
  // handler, BEFORE finalizeRun has had a chance to clear `running`.
  // They are internal continuations of the same logical user request,
  // so allow them through. For all other callers, busy means busy.
  // `accepted: false` tells the renderer the user's text was NOT persisted,
  // so the composer can restore it instead of silently swallowing the input.
  if (running.has(designId) && !opts.isAutoFix && !opts.isModelFallback && !opts.isAutoFallback) {
    return { ok: false, error: 'Another response is in progress.', accepted: false }
  }
  // For auto-fix continuations, clear the stale entry before starting so
  // the new run owns the running slot cleanly.
  if (running.has(designId) && opts.isAutoFix) {
    running.delete(designId)
  }

  const versionNum = nextVersionNumber(designId)
  // PPT EDIT MODE: when useTemplateLook + .pptx, the output is a real
  // .pptx (cloned + XML-edited from the template) instead of a fresh
  // HTML file. The model preserves slide masters/layouts/theme by never
  // recreating them.
  const isPptxEdit = !opts.skipPrefix
    && !!d.brief?.templateFile
    && d.brief.templateFile.toLowerCase().endsWith('.pptx')
    && !!d.brief?.useTemplateLook
  const versionFileName = isPptxEdit
    ? `v${String(versionNum).padStart(3, '0')}.pptx`
    : `v${String(versionNum).padStart(3, '0')}.html`
  // For previous-version reads in iteration mode, look at whatever the
  // last version actually was (could be html or pptx).
  const prior = listVersions(designId)
  const prevVersion = prior[prior.length - 1] ?? null
  const previousVersionFileName = prevVersion?.fileName ?? null

  // If a .pptx template is attached, pre-extract its facts on this side
  // so the LLM doesn't need to parse XML: slide count, hex palette,
  // fonts, per-slide layout/title/body. This is the single biggest
  // hardening lever for template fidelity.
  let pptxFacts: PptxFacts | null = null
  let pptxError: string | null = null
  if (!opts.skipPrefix && d.brief?.templateFile && d.brief.templateFile.toLowerCase().endsWith('.pptx')) {
    try {
      const tplPath = join(d.cwd, d.brief.templateFile)
      pptxFacts = await extractPptxFacts(tplPath, d.cwd)
      // Persist the extracted facts to disk so the model can cat the file
      // back if it doubts the prompt: and so the user can see what we
      // grounded on. Lives next to the unzipped template.
      try {
        const factsLines = pptxFactsToPrompt(pptxFacts)
        await fs.writeFile(join(d.cwd, '_tpl', '_facts.md'), factsLines.join('\n'), 'utf8')
      } catch {}
      // ALSO write a per-design AGENTS.md with template constraints. Copilot
      // CLI reads project-level instructions from cwd automatically and
      // injects them into the system prompt: far more sticky than a one-
      // shot user prompt.
      if (d.brief?.useTemplateLook) {
        try {
          const agentsMd = buildAgentsMd(pptxFacts)
          await fs.writeFile(join(d.cwd, 'AGENTS.md'), agentsMd, 'utf8')
        } catch {}
      }
    } catch (err) {
      console.error('[design] pptx extract failed:', err)
      pptxError = String(err).slice(0, 200)
    }
  }

  // A bound design carries its library as files, refreshed on every run.
  //
  // Written rather than merely described because the page has to link
  // something: a prompt can name `--colour-text-primary` all it likes, but
  // unless tokens.css is on disk beside the HTML the variable resolves to
  // nothing and the page renders unstyled. Refreshed every time so a design
  // generated after the library moved is built against the library as it is,
  // not as it was when the design was created.
  if (!opts.skipPrefix && d.brief?.tokensId) {
    const stamp = await writeTokensFiles(d.cwd, d.brief)
    // Recorded against the design so a later change to the library can be
    // noticed. Written even when it has not moved, because the alternative is
    // a read-compare-write and this is one statement.
    if (stamp && stamp !== d.brief.tokensStamp) {
      d.brief = { ...d.brief, tokensStamp: stamp }
      try {
        getDb().prepare('UPDATE designs SET brief = ? WHERE id = ?')
          .run(JSON.stringify(d.brief), designId)
      } catch (err) {
        // A stamp that failed to save costs a spurious "Library updated" at
        // worst, which is not worth failing a generation over.
        console.error('[design] could not stamp the bound library:', err)
      }
    }
  }

  const isStarterFirstRun = !opts.skipPrefix
    && !!d.brief?.starterTemplateId
    && !d.copilotSessionId

  // Imported designs have no brief — skip the heavy prefix and just let
  // the user chat naturally. The model can read the HTML from the cwd.
  const isImported = !d.brief && !opts.skipPrefix

  const prefix = opts.skipPrefix || isImported
    ? ''
    : isStarterFirstRun
      ? buildStarterPrefix(d.cwd, d.brief!)
      : buildPrefix(versionFileName, d.brief, previousVersionFileName, pptxFacts)
  const promptText = prefix ? `${prefix}\n\n${text}` : text

  const userMsg: DesignMessage = {
    id: randomUUID(), designId, role: 'user',
    // What the user sees in chat history. Defaults to the same text we
    // send to the model, but external callers (annotations, direct
    // edits, etc.) can supply a clean English-readable version via
    // `displayText` while the model still receives the full prompt with
    // technical context (selectors, style payloads, etc.).
    content: opts.displayText && opts.displayText.trim() ? opts.displayText.trim() : text,
    toolCalls: [], status: 'done', createdAt: Date.now()
  }
  insertMessage(userMsg)
  emit(win, 'design:message', userMsg)

  // Surface what we extracted (or what failed) so the user can see whether
  // the template was actually grounded: saves an hour of guessing.
  if (pptxFacts) {
    const colors = Object.entries(pptxFacts.theme.colors).slice(0, 4)
      .map(([k, v]) => `${k} ${v}`).join('  ')
    const fonts = [pptxFacts.theme.headingFont, pptxFacts.theme.bodyFont].filter(Boolean).join(' / ') || ':'
    const summary = `Template ready · ${pptxFacts.slideCount} slides ${pptxFacts.aspect} · ${fonts} · ${colors}`
    const sysMsg: DesignMessage = {
      id: randomUUID(), designId, role: 'system',
      content: summary, toolCalls: [], status: 'done', createdAt: Date.now()
    }
    insertMessage(sysMsg); emit(win, 'design:message', sysMsg)
  } else if (pptxError) {
    const sysMsg: DesignMessage = {
      id: randomUUID(), designId, role: 'system',
      content: `Template extract failed: ${pptxError}. The model will fall back to unzipping it itself.`,
      toolCalls: [], status: 'done', createdAt: Date.now()
    }
    insertMessage(sysMsg); emit(win, 'design:message', sysMsg)
  }

  // A binding to a library that has since been deleted is the one token
  // failure that has to be said out loud. Every other path is deliberately
  // quiet, so the result would otherwise be a design generated with no token
  // guidance and nothing anywhere to say why.
  if (!opts.skipPrefix && libraryMissing(d.brief)) {
    const sysMsg: DesignMessage = {
      id: randomUUID(), designId, role: 'system',
      content: 'The token library this design was bound to no longer exists, so this run has nothing to build against. Bind another library from the design\u2019s settings, or the page will be made up of invented values.',
      toolCalls: [], status: 'done', createdAt: Date.now()
    }
    insertMessage(sysMsg)
    emit(win, 'design:message', sysMsg)
  }

  // First message of a design: surface the brief so the user can see what
  // configuration was sent to Copilot. Subsequent turns are continuations.
  if (!d.copilotSessionId && d.brief) {
    const briefSummary = summariseBrief(d.brief)
    if (briefSummary) {
      const sysMsg: DesignMessage = {
        id: randomUUID(), designId, role: 'system',
        content: `Brief · ${briefSummary}`,
        toolCalls: [], status: 'done', createdAt: Date.now()
      }
      insertMessage(sysMsg)
      emit(win, 'design:message', sysMsg)
    }
  }

  // Apply mode: prepend a small instruction so the agent's behaviour matches
  // the user's choice, and adjust CLI flags. We can't fully gate the CLI's
  // ask_user from here in interactive mode, so we instead instruct via prompt.
  const mode = opts.agentMode ?? 'interactive'
  let modePrefix = ''
  if (mode === 'plan') {
    modePrefix = 'MODE: PLAN. Before writing or running anything, draft a short numbered plan (3-7 steps) of what you intend to do, then STOP and wait for the user to reply with "go" or edits. Do not call any write/edit/exec tools yet.\n\n'
  } else if (mode === 'autopilot') {
    modePrefix = 'MODE: AUTOPILOT. Execute the full task end-to-end without asking clarifying questions. Make reasonable defaults silently. Only stop on a hard error you cannot recover from.\n\n'
  } else {
    modePrefix = 'MODE: INTERACTIVE. Work in small reversible steps. After each meaningful action (file write, command run, external API call), pause briefly to let the user steer if needed. Prefer asking one short clarifying question over making a wrong assumption.\n\n'
  }

  // Free-form Figma guidance: matches what chat.ts does. Triggers when the
  // user mentions Figma in a regular design-chat turn (not from the
  // dedicated export buttons, which already inject their own full prompt).
  let figmaPrefix = ''
  if (!opts.skipPrefix && /\bfigma\b/i.test(text)) {
    figmaPrefix = [
      'FIGMA AVAILABLE via the figma-write MCP server.',
      '  Requires the "MCP WebSocket Client" plugin running in Figma Desktop. Probe with figma-write-figma_plugin_status (5s timeout). If it responds, use figma-write-figma_pages / figma_nodes / figma_auto_layout / figma_text / figma_fills / figma_strokes / figma_effects / figma_fonts. For icons use figma-write-figma_svg with SVG fetched from a CDN (Phosphor / Tabler / Lucide / Remix); replace currentColor with the right hex first.',
      '  If the probe fails, say so and stop. Do not call figma-* tools: the hosted Figma MCP is not configured, so those tool names do not exist.',
      'Quality rules: real auto-layout frames, real text nodes, real vector icons. Never substitute icons with basic shapes. Never use FIXED sizing on auto-layout frames. No em-dashes (U+2014) in any layer/text — use ASCII "-".',
      ''
    ].join('\n')
  }

  const finalPromptText = figmaPrefix + modePrefix + promptText

  const args: string[] = [
    '--prompt', finalPromptText,
    '--allow-all-tools',
    '--allow-all-paths',
    '--output-format', 'json',
    '--no-color',
    '-C', d.cwd
  ]
  // Plan mode: leave ask_user enabled so the CLI can pause for confirmation.
  // Interactive + autopilot: keep --no-ask-user so the agent never blocks on
  // a clarifying-question prompt (interactive uses prompt-level gating instead).
  if (mode !== 'plan') args.push('--no-ask-user')
  // Only Figma EXPORT runs need explicit reasoning effort to handle Plugin API
  // quirks. For regular HTML/template runs, omit --effort entirely: some model
  // router choices (especially "auto") reject effort configuration and exit 1.
  if (opts.useFigma && opts.model !== 'auto') args.push('--effort', 'medium')
  const resolvedModel = resolveModel(opts.model)
  if (resolvedModel) args.push('--model', resolvedModel)
  if (d.copilotSessionId && !opts.freshSession) args.push('--resume', d.copilotSessionId)

  // MCP servers come from the user's ~/.copilot/mcp-config.json, which the CLI
  // reads for every session — there is nothing to disable per run. Figma work
  // now happens through the model's general HTML / spec generation rather than
  // Plugin API tooling. When the user has Cowork enabled the workiq server is
  // deliberately left in place, so a design run can still reach their M365
  // context.

  // Defensive: if the target version file somehow already exists (a previous
  // run left a partial write, a manual touch, etc.), delete it now so the
  // model's `create` tool can't fail with "file exists" and trigger a retry
  // loop. The model is told to write THIS exact filename so this never
  // collides with the user's other files.
  if (!opts.skipPrefix && !isStarterFirstRun && versionFileName) {
    try { await fs.unlink(join(d.cwd, versionFileName)) } catch { /* fine if absent */ }
  }

  let child: ChildProcess
  try {
    child = spawn('copilot', args, {
      cwd: d.cwd,
      env: { ...(await copilotEnv()), FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Run copilot in its own process group so we can kill the WHOLE
      // tree (copilot + MCP child processes) on cancel via process.kill(-pid).
      // Without this, SIGTERM only hits the copilot wrapper and the MCP
      // children keep working, which is why "Stop" appeared to do nothing.
      detached: true
    })
  } catch (err) {
    const errMsg: DesignMessage = {
      id: randomUUID(), designId, role: 'system',
      content: `Failed to start copilot: ${String(err)}`, toolCalls: [],
      status: 'error', createdAt: Date.now()
    }
    insertMessage(errMsg)
    emit(win, 'design:message', errMsg)
    emit(win, 'design:done', { designId, exitCode: -1 })
    return { ok: false, error: String(err) }
  }

  const state: RunState = {
    child, assistantMsgId: null, buffer: '', toolCalls: new Map(), cancelled: false,
    progress: new Map(), progressOrder: [], isAutoFix: !!opts.isAutoFix,
    doneEmitted: false,
    requestedModel: opts.model ?? null,
    originalText: text,
    originalOpts: {
      skipPrefix: opts.skipPrefix,
      useFigma: opts.useFigma,
      freshSession: opts.freshSession,
      agentMode: opts.agentMode,
      isAutoFix: opts.isAutoFix,
      displayText: opts.displayText
    },
    isModelFallback: !!opts.isModelFallback,
    isAutoFallback: !!opts.isAutoFallback,
    rateLimitMessage: null,
    rateLimitAutoEligible: false
  }
  running.set(designId, state)
  emit(win, 'design:start', { designId })

  let stdoutBuf = ''
  let stderrBuf = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8')
    let nl = stdoutBuf.indexOf('\n')
    while (nl !== -1) {
      const line = stdoutBuf.slice(0, nl)
      stdoutBuf = stdoutBuf.slice(nl + 1)
      const evt = parseLine(line)
      if (evt) processJsonEvent(win, designId, state, evt as Parameters<typeof processJsonEvent>[3])
      nl = stdoutBuf.indexOf('\n')
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    stderrBuf += text
    const line = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-1)[0]
    if (line && !/electron security warning|download the react devtools/i.test(line)) {
      emit(win, 'design:phase', { designId, phase: line.length > 140 ? line.slice(0, 137) + '...' : line })
    }
  })
  child.on('error', (err) => {
    const errMsg: DesignMessage = {
      id: randomUUID(), designId, role: 'system',
      content: `copilot error: ${String(err)}`, toolCalls: [],
      status: 'error', createdAt: Date.now()
    }
    insertMessage(errMsg)
    emit(win, 'design:message', errMsg)
    // Defensive cleanup: 'error' is not always followed by 'close', and
    // without finalizing here a future send() would block on running.has().
    finalizeRun(win, designId, state, -1)
  })
  child.on('close', async (code) => {
    if (stdoutBuf.trim()) {
      const evt = parseLine(stdoutBuf)
      if (evt) processJsonEvent(win, designId, state, evt as Parameters<typeof processJsonEvent>[3])
    }

    // ─── RATE-LIMIT RECOVERY ────────────────────────────────────────────
    // Copilot emits a session.error with errorType:"rate_limit" and then
    // shuts down cleanly (exit code 0). If the message says we can switch
    // to "auto" (eligibleForAutoSwitch), retry once with --model auto so
    // the user actually gets a response. Only one auto-switch per turn.
    if (state.rateLimitMessage && !state.cancelled && state.rateLimitAutoEligible && !state.isAutoFallback) {
      if (state.assistantMsgId) {
        const msg: DesignMessage = {
          id: state.assistantMsgId, designId, role: 'assistant',
          content: '', toolCalls: [], status: 'cancelled', createdAt: Date.now()
        }
        updateMessage(msg)
        emit(win, 'design:message', msg)
      }
      const notice: DesignMessage = {
        id: randomUUID(), designId, role: 'system',
        content: 'Hit the rate limit on the default model. Retrying with the "auto" picker (uses any model that\'s currently available).',
        toolCalls: [], status: 'done', createdAt: Date.now()
      }
      insertMessage(notice)
      emit(win, 'design:message', notice)
      finalizeRun(win, designId, state, code ?? -1)
      void send(win, designId, state.originalText, { ...state.originalOpts, model: 'auto', isModelFallback: true, isAutoFallback: true })
      return
    }
    // Rate-limit but no auto-switch path available (or auto also rate-limited):
    // surface the message clearly instead of silently exiting.
    if (state.rateLimitMessage && !state.cancelled) {
      if (state.assistantMsgId) {
        const msg: DesignMessage = {
          id: state.assistantMsgId, designId, role: 'assistant',
          content: '', toolCalls: [], status: 'cancelled', createdAt: Date.now()
        }
        updateMessage(msg)
        emit(win, 'design:message', msg)
      }
      const fallback = await buildTemplatePreviewFallback(designId, state.originalText).catch(() => null)
      const errMsg: DesignMessage = {
        id: randomUUID(), designId, role: 'system',
        content: fallback
          ? `Copilot rate limit reached, so I opened the cloned template as ${fallback.fileName} for now. The template files are in this design folder; once quota is available, send another instruction to adapt the copy/colors.\n\n${state.rateLimitMessage}`
          : `Copilot rate limit reached.\n\n${state.rateLimitMessage}`,
        toolCalls: [], status: fallback ? 'done' : 'error', createdAt: Date.now()
      }
      insertMessage(errMsg)
      emit(win, 'design:message', errMsg)
      if (fallback) {
        const versions = listVersions(designId)
        emit(win, 'design:version', { designId, latest: fallback, versions })
      }
      finalizeRun(win, designId, state, code ?? -1)
      return
    }

    // ─── MODEL FALLBACK ─────────────────────────────────────────────────
    // Copilot CLI in one-shot mode (-p / --prompt) does NOT auto-fall-back
    // when --model is unrecognized; it just exits with code 1. Detect that
    // exact failure and transparently retry the same prompt without --model,
    // so the user gets a response instead of a cryptic error. Only retry
    // once (state.isModelFallback guards), and only when the user actually
    // requested a specific model (otherwise there's nothing to drop).
    const modelUnavailable = code !== 0
      && !state.cancelled
      && !!state.requestedModel
      && !state.isModelFallback
      && /from --model flag is not available/i.test(stderrBuf)
    if (modelUnavailable) {
      // Clear the empty assistant message so the retry's new message is
      // the only "live" one for this turn.
      if (state.assistantMsgId) {
        const msg: DesignMessage = {
          id: state.assistantMsgId, designId, role: 'assistant',
          content: '', toolCalls: [], status: 'cancelled', createdAt: Date.now()
        }
        updateMessage(msg)
        emit(win, 'design:message', msg)
      }
      const notice: DesignMessage = {
        id: randomUUID(), designId, role: 'system',
        content: `Model "${state.requestedModel}" isn't available on this Copilot CLI right now, so this is retrying with the default model.`,
        toolCalls: [], status: 'done', createdAt: Date.now()
      }
      insertMessage(notice)
      emit(win, 'design:message', notice)
      finalizeRun(win, designId, state, code ?? -1)
      void send(win, designId, state.originalText, { ...state.originalOpts, model: null, isModelFallback: true })
      return
    }

    if (state.assistantMsgId) {
      const msg: DesignMessage = {
        id: state.assistantMsgId, designId, role: 'assistant',
        content: state.buffer || '(no response)',
        toolCalls: Array.from(state.toolCalls.values()),
        status: state.cancelled ? 'cancelled' : (code === 0 ? 'done' : 'error'),
        createdAt: Date.now()
      }
      updateMessage(msg)
      emit(win, 'design:message', msg)
    }
    if (code !== 0 && !state.cancelled) {
      const tail = stderrBuf.split('\n').filter(Boolean).slice(-3).join('\n')
      if (tail) {
        const errMsg: DesignMessage = {
          id: randomUUID(), designId, role: 'system',
          content: `copilot exited with code ${code}\n${tail}`, toolCalls: [],
          status: 'error', createdAt: Date.now()
        }
        insertMessage(errMsg)
        emit(win, 'design:message', errMsg)
      }
    }

    // ─── AUTO-LINT PASS ──────────────────────────────────────────────────
    // After a successful HTML build, scan the latest version for hard
    // style-rule violations. If any are found, automatically queue a fix
    // turn so the model gets a second pass at obeying the contract. The
    // model frequently ignores the prompt; this is the enforcement layer.
    //
    // Skips: cancelled runs, error exits, pptx outputs, runs that are
    // themselves auto-fixes (one retry only — no infinite loops), and
    // designs where the user has disabled auto-fix in settings.
    if (code === 0 && !state.cancelled && !state.isAutoFix) {
      // Skip auto-lint for imported designs (no brief) — they have their
      // own style choices that shouldn't be overridden by our rules.
      const designForLint = getDesign(designId)
      if (designForLint?.brief) {
        try {
          await runAutoLint(win, designId)
        } catch (err) {
          console.error('[design] auto-lint failed:', err)
        }
      }
    }

    finalizeRun(win, designId, state, code ?? -1)
  })
  return { ok: true }
}

// Read the latest version file, lint it, and if violations are found, fire
// a follow-up "fix" turn that asks the model to save vN+1.html with the
// violations corrected. Marks the new turn so we don't recurse forever.
async function runAutoLint(win: BrowserWindow | null, designId: string): Promise<void> {
  const d = getDesign(designId)
  if (!d) return
  const versions = listVersions(designId)
  const latest = versions[versions.length - 1]
  if (!latest || latest.kind !== 'html') return

  let html = ''
  try {
    html = await fs.readFile(latest.filePath, 'utf8')
  } catch {
    return
  }
  const enforcedRules = d.brief?.aiRules
    ? Object.keys(d.brief.aiRules).filter((id) => d.brief!.aiRules![id] !== false)
    : null
  const violations = lintHtml(html, enforcedRules)
  // The library's own setting decides how far its findings travel. Advise
  // means the prompt was the whole of it, so there is nothing to look at
  // afterwards; check and block both look, and only block acts.
  const level = tokensEnforcement(d.brief ?? null)
  const drift = level === 'advise' ? { name: '', lines: [] as string[] } : lintTokens(html, d.brief ?? null)
  if (violations.length === 0 && drift.lines.length === 0) return

  // Nothing to fix by hand and nothing the library wants fixed for us: report
  // what was found and leave the design alone. Without this a library set to
  // check would still spend a turn, which is the difference between the two
  // rungs.
  const fixing = violations.length > 0 || level === 'block'

  const nextNum = (parseInt(latest.id.slice(1), 10) || 0) + 1
  const nextFile = `v${String(nextNum).padStart(3, '0')}.html`
  let fixText = buildFixPrompt(violations, latest.fileName, nextFile)
  if (drift.lines.length) {
    fixText = [
      fixText || `The current design in ${latest.fileName} does not use the ${drift.name} library it is bound to.`,
      '',
      `It is bound to the ${drift.name} token library, and these values are off it:`,
      ...drift.lines.map((l) => `- ${l}`),
      '',
      `Replace each with the var(--…) it should have used, then save the result as ${nextFile}. The :root block in tokens.css defines every one of them; keep the layout, content and intent unchanged.`
    ].join('\n')
  }

  // Surface the lint result in the chat as a system message so the user
  // can see what was caught and what's being auto-corrected.
  const sysMsg: DesignMessage = {
    id: randomUUID(),
    designId,
    role: 'system',
    content: (() => {
      const counted: string[] = []
      if (violations.length) counted.push(`${violations.length} style-rule violation${violations.length === 1 ? '' : 's'}`)
      if (drift.lines.length) counted.push(`${drift.lines.length} value${drift.lines.length === 1 ? '' : 's'} off the ${drift.name} library`)
      const bullets = [...violations.map((v) => '• ' + v.message), ...drift.lines.map((l) => '• ' + l)]
      const head = fixing
        ? `Auto-fix: ${counted.join(' and ')} detected in ${latest.fileName}. Generating ${nextFile} with corrections…`
        : `${counted.join(' and ')} in ${latest.fileName}. ${drift.name} is set to check, so this is a report rather than a change.`
      return `${head}\n\n${bullets.join('\n')}`
    })(),
    toolCalls: [],
    status: 'done',
    createdAt: Date.now(),
  }
  insertMessage(sysMsg)
  emit(win, 'design:message', sysMsg)

  if (!fixing) return
  await send(win, designId, fixText, { skipPrefix: true, isAutoFix: true })
}

/**
 * What the library a design is bound to asks of it.
 *
 * `advise` for a design with no library, because a design that was never told
 * anything cannot have disobeyed. Anything unreadable falls back the same way
 * a missing library does elsewhere: quietly, without failing the run.
 */
function tokensEnforcement(brief: DesignBrief | null): Enforcement {
  if (!brief?.tokensId) return 'advise'
  try {
    const record = getTokenStudio(brief.tokensId)
    if (!record) return 'advise'
    return enforcementOf(hydrateStudio(record.studio))
  } catch {
    return 'advise'
  }
}

function cancel(designId: string): boolean {
  const state = running.get(designId)
  if (!state) return false
  state.cancelled = true
  const pid = state.child.pid
  // Kill the WHOLE process group (copilot + every MCP child it spawned).
  // Without -pid, SIGTERM only hits the copilot wrapper and the MCP
  // workers keep streaming, so the run never ends and the Stop button
  // appears stuck.
  try {
    if (pid) process.kill(-pid, 'SIGTERM')
    else state.child.kill('SIGTERM')
  } catch {
    try { state.child.kill('SIGTERM') } catch {}
  }
  setTimeout(() => {
    const s = running.get(designId)
    if (!s) return
    try {
      if (pid) process.kill(-pid, 'SIGKILL')
      else s.child.kill('SIGKILL')
    } catch {
      try { s.child.kill('SIGKILL') } catch {}
    }
    // Final safeguard: if the child is wedged and 'close' never fires (e.g.
    // signals not propagating to the process group), the design would stay
    // "running" forever and every future send() would silently early-return.
    // finalizeRun is identity-guarded so this can't clobber a new run that
    // started cleanly in the meantime.
    setTimeout(() => {
      const current = running.get(designId)
      if (current === state) finalizeRun(null, designId, state, -1)
    }, 2000)
  }, 1500)
  return true
}

// ─── Watcher ──────────────────────────────────────────────────────────────

function watchDesign(getWin: () => BrowserWindow | null, designId: string): void {
  if (watchers.has(designId)) return
  const d = getDesign(designId)
  if (!d) return
  void fs.mkdir(d.cwd, { recursive: true }).then(() => {
    let pending: NodeJS.Timeout | null = null
    // Track in-flight pdf renders so we don't queue duplicates.
    const rendering = new Set<string>()
    const w = fsWatch(d.cwd, { persistent: false }, (_evt, fileName) => {
      if (!fileName) return
      const lower = String(fileName).toLowerCase()
      const isHtml = lower.endsWith('.html')
      const isPptx = lower.endsWith('.pptx')
      if (!isHtml && !isPptx) return

      // When a vNNN.pptx lands, kick off the soffice -> PDF render so the
      // canvas can preview it. The PDF lands as vNNN.pdf in the same dir.
      if (isPptx && /^v\d+\.pptx$/i.test(fileName as string) && !rendering.has(fileName as string)) {
        rendering.add(fileName as string)
        const pptxPath = join(d.cwd, fileName as string)
        // Run async, don't block the watcher. When it completes the PDF
        // will appear in the cwd and trigger another fsWatch event so the
        // canvas refreshes.
        void pptxToPdf(pptxPath).then((pdf) => {
          rendering.delete(fileName as string)
          if (pdf) {
            // Re-emit the version list so the renderer sees previewUrl pop.
            try {
              const versions = listVersions(designId)
              const latest = versions[versions.length - 1] ?? null
              getWin()?.webContents.send('design:version', { designId, latest, versions })
            } catch {}
          }
        }).catch(() => { rendering.delete(fileName as string) })
      }

      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        const versions = listVersions(designId)
        const latest = versions[versions.length - 1] ?? null
        if (latest) setCurrentVersion(designId, latest.id)
        try {
          getWin()?.webContents.send('design:version', { designId, latest, versions })
        } catch {}
      }, 250)
    })
    watchers.set(designId, w)
  }).catch(() => {})
}

function unwatch(designId: string): void {
  const w = watchers.get(designId)
  if (!w) return
  try { w.close() } catch {}
  watchers.delete(designId)
}

export function stopAllDesignWatchers(): void {
  for (const [id] of watchers) unwatch(id)
}

export function killAllDesignRuns(): void {
  for (const [id] of running) cancel(id)
}

// ─── Auto-title from first user prompt ────────────────────────────────────

// Strip em/en-dashes the model loves to add. Replace with a regular " - "
// so titles like "Lumen: Home" become "Lumen - Home".

// ─── Export ───────────────────────────────────────────────────────────────

// Render an HTML file in an off-screen BrowserWindow at a given viewport,
// then run a callback against its webContents to produce bytes (PDF / PNG).
//
// `detached` asks for a real offscreen surface rather than a hidden window.
// A hidden window is still a window and is bound by the display it would have
// appeared on: ask for more than the screen and the page either comes back
// the wrong size or fails to load at all (3840x2160 reliably fails on a
// laptop). An offscreen surface is not attached to a display and honours what
// it is given. It is only used where the size can exceed the screen, because
// it is the less well-trodden path.
async function renderHtmlOffscreen<T>(
  htmlPath: string,
  viewport: { width: number; height: number },
  produce: (wc: Electron.WebContents) => Promise<T>,
  opts: { detached?: boolean } = {}
): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    // Otherwise the window frame eats into the page and the capture is short.
    useContentSize: true,
    width: viewport.width,
    height: viewport.height,
    webPreferences: {
      offscreen: opts.detached === true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  try {
    await win.loadFile(htmlPath)
    // Give CSS / web fonts / images a beat to settle before capture.
    await new Promise((r) => setTimeout(r, 350))
    return await produce(win.webContents)
  } finally {
    try { win.destroy() } catch {}
  }
}


/** The kinds that are decks, whatever the brief's group says. */
const DECK_KINDS = new Set(['pitch-deck', 'sales-deck', 'talk-slides', 'workshop-deck'])

/**
 * One PNG per slide, at the deck's native size.
 *
 * The old path scrolled the *window* and waited 80ms. A chassis deck scrolls
 * a container, and its slides are transparent until they arrive, so that
 * produced the same blank frame once per slide. Here the page is put into an
 * export mode first — transitions frozen, reveals forced, chrome hidden —
 * and then walked one slide at a time.
 */
async function captureDeckSlides(htmlPath: string): Promise<Buffer[]> {
  return renderHtmlOffscreen(htmlPath, DECK_CAPTURE_SIZE, async (wc) => {
    await wc.executeJavaScript(EXPORT_PREP_JS)
    const count = Number(await wc.executeJavaScript(SLIDE_COUNT_JS)) || 0
    if (!count) {
      const img = await wc.capturePage()
      return [img.toPNG()]
    }
    const out: Buffer[] = []
    for (let i = 0; i < count; i++) {
      const ok = await wc.executeJavaScript(showSlideJs(i))
      if (!ok) continue
      // Nothing is animating any more, so this is a paint, not a settle.
      await new Promise((r) => setTimeout(r, 120))
      const img = await wc.capturePage()
      out.push(img.toPNG())
    }
    return out
  })
}


async function exportLatest(
  designId: string,
  format: ExportFormat
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const versions = listVersions(designId)
  const latest = versions[versions.length - 1]
  if (!latest) return { ok: false, error: 'No version yet.' }
  const d = getDesign(designId)
  if (!d) return { ok: false, error: 'Design not found.' }

  const safeBase = (d.title || 'design').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'design'
  const defaultName = `${safeBase}-${latest.id}.${extFor(format)}`
  const res = await dialog.showSaveDialog({
    title: `Export as ${format.toUpperCase()}`,
    defaultPath: defaultName
  })
  if (res.canceled || !res.filePath) return { ok: false, error: 'Cancelled.' }
  const out = res.filePath

  try {
    if (format === 'html') {
      await fs.copyFile(latest.filePath, out)
      return { ok: true, path: out }
    }

    // Choose a sensible viewport for the offscreen render. For per-kind
    // formats we already constrain the artboard inside the HTML, so a
    // generous canvas is fine.
    const viewport = viewportForKind(d.brief?.kind)
    const isDeck = d.brief?.group === 'presentation' || DECK_KINDS.has(d.brief?.kind ?? '')

    // Decks are photographed slide by slide, whatever the format asks for.
    // Everything downstream — PowerPoint, a paginated PDF, a cover image —
    // is the same set of pictures arranged differently.
    if (isDeck) {
      const shots = await captureDeckSlides(latest.filePath)
      if (!shots.length) return { ok: false, error: 'That deck has no slides to export.' }

      if (format === 'png') {
        // One picture of a deck can only be its cover.
        await fs.writeFile(out, shots[0])
        return { ok: true, path: out }
      }

      if (format === 'pptx') {
        const pptxgen = (await import('pptxgenjs')).default
        const pres = new pptxgen()
        pres.layout = 'LAYOUT_WIDE' // 13.3 × 7.5 in (16:9)
        for (const buf of shots) {
          const s = pres.addSlide()
          s.addImage({
            data: `data:image/png;base64,${buf.toString('base64')}`,
            x: 0, y: 0, w: '100%', h: '100%'
          })
        }
        await pres.writeFile({ fileName: out })
        return { ok: true, path: out }
      }

      if (format === 'pdf') {
        // Chromium will not paginate the deck itself: it is one viewport
        // tall with overflow hidden, so it prints as a single page of
        // whichever slide was showing. A plain document of one image per
        // page is the only way the page count matches the deck.
        const doc = buildSlidePdfHtml(
          shots.map((b) => `data:image/png;base64,${b.toString('base64')}`),
          DECK_CAPTURE_SIZE
        )
        const tmp = join(app.getPath('temp'), `deck-print-${Date.now()}.html`)
        await fs.writeFile(tmp, doc, 'utf8')
        try {
          const pdf = await renderHtmlOffscreen(tmp, DECK_CAPTURE_SIZE, (wc) =>
            wc.printToPDF({
              printBackground: true,
              pageSize: {
                width: DECK_CAPTURE_SIZE.width / 96,
                height: DECK_CAPTURE_SIZE.height / 96
              },
              margins: { top: 0, bottom: 0, left: 0, right: 0 }
            })
          )
          await fs.writeFile(out, pdf)
        } finally {
          try { await fs.unlink(tmp) } catch {}
        }
        return { ok: true, path: out }
      }
    }

    if (format === 'pdf') {
      const pdf = await renderHtmlOffscreen(latest.filePath, viewport, (wc) =>
        wc.printToPDF({
          printBackground: true,
          pageSize: pdfPageForKind(d.brief?.kind),
          landscape: pdfLandscapeForKind(d.brief?.kind),
          margins: { top: 0, bottom: 0, left: 0, right: 0 }
        })
      )
      await fs.writeFile(out, pdf)
      return { ok: true, path: out }
    }

    if (format === 'png') {
      const png = await renderHtmlOffscreen(latest.filePath, viewport, async (wc) => {
        const img = await wc.capturePage()
        return img.toPNG()
      })
      await fs.writeFile(out, png)
      return { ok: true, path: out }
    }

    return { ok: false, error: `Unsupported format: ${format}` }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

// ─── IPC ──────────────────────────────────────────────────────────────────

export function registerDesignIpc(getWin: () => BrowserWindow | null): void {
  ipcMain.handle('designs:list', () => listDesigns())
  ipcMain.handle('designs:get', (_e, id: string) => getDesign(id))
  ipcMain.handle('designs:create', async (_e, opts?: { title?: string; brief?: DesignBrief | null }) => createDesign(opts))
  ipcMain.handle('designs:createStarterVersion', async (_e, args: { designId: string; userText?: string | null }) => {
    try {
      const latest = await createStarterTemplateVersion(args.designId, args.userText ?? '')
      const versions = listVersions(args.designId)
      if (latest) getWin()?.webContents.send('design:version', { designId: args.designId, latest, versions })
      return { ok: !!latest, latest, versions }
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e), latest: null, versions: [] }
    }
  })
  ipcMain.handle('designs:rename', (_e, args: { id: string; title: string }) => renameDesign(args.id, args.title))
  ipcMain.handle('designs:applyEdit', async (_e, args: { designId: string; blockId: string; css: string; tag?: 'style' | 'script' }) => {    try {
      const latest = await applyDesignEdit(args.designId, args.blockId, args.css, args.tag ?? 'style')
      const versions = listVersions(args.designId)
      if (latest) getWin()?.webContents.send('design:version', { designId: args.designId, latest, versions })
      return { ok: !!latest, latest, versions }
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e), latest: null, versions: [] }
    }
  })
  ipcMain.handle('designs:duplicate', async (_e, id: string) => duplicateDesign(id))
  ipcMain.handle('designs:delete', async (_e, id: string) => deleteDesign(id))

  ipcMain.handle('designs:writeHtml', async (_e, args: { designId: string; html: string }) => {
    try {
      const latest = await writeDesignHtml(args.designId, args.html)
      const versions = listVersions(args.designId)
      if (latest) getWin()?.webContents.send('design:version', { designId: args.designId, latest, versions })
      return { ok: !!latest, latest, versions }
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e), latest: null, versions: [] }
    }
  })

  ipcMain.handle('designs:importFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'Cancelled' }
    try {
      const design = await importDesignFromFolder(result.filePaths[0])
      return { ok: true, design }
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e) }
    }
  })

  ipcMain.handle('designs:importGit', async (_e, args: { url: string; title?: string }) => {
    try {
      const design = await importDesignFromGit(args.url, args.title)
      return { ok: true, design }
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e) }
    }
  })

  ipcMain.handle('designs:send', (_e, args: { designId: string; text: string; model?: string | null; agentMode?: 'interactive' | 'plan' | 'autopilot'; displayText?: string | null }) => {
    maybeAutoTitle(args.designId, args.displayText ?? args.text)
    return send(getWin(), args.designId, args.text, {
      model: args.model ?? null,
      agentMode: args.agentMode ?? 'interactive',
      displayText: args.displayText ?? null
    })
  })
  type SendToFigmaArgs = { designId: string; mode?: 'newFile' | 'existingFile'; fileUrl?: string | null; pageName?: string | null }
  type FigmaFromScratchArgs = { designId: string; description: string; mode?: 'newFile' | 'existingFile'; fileUrl?: string | null }

  function extractFigmaKey(input: string): string | null {
    if (!input) return null
    const m = input.match(/figma\.com\/(?:design|file|board|proto)\/([A-Za-z0-9]{8,40})/i)
    return m?.[1] ?? null
  }

  ipcMain.handle('designs:sendToFigma', (_e, args: SendToFigmaArgs) => runSendToFigma(args))
  ipcMain.handle('designs:figmaFromScratch', (_e, args: FigmaFromScratchArgs) => runFigmaFromScratch(args))

  // Returns the full assembled prompt that WOULD be sent to the model for a
  // brief. Used by the wizard's "View prompt" button so the user can see
  // exactly what the LLM will receive (including the STYLE CONTRACT, brand
  // colors, BRIEF bullets, and their idea/notes) before they hit Create.
  ipcMain.handle('designs:previewPrompt', (_e, args: { brief: DesignBrief | null }): { prompt: string } => {
    const brief = args?.brief ?? null
    const versionFileName = brief?.target === 'figma' ? '(figma)' : 'v001.html'
    const ideaPart = brief?.idea ? `\n\n${brief.idea}` : ''
    const userMsg = brief?.target === 'figma'
      ? `Build this in Figma based on the brief.${ideaPart}`
      : `Create v001 based on this brief.${ideaPart}`
    if (brief?.target === 'figma') {
      return { prompt: userMsg + (brief ? `\n\nBrief summary:\n${summariseBriefForPrompt(brief).map((b) => `- ${b}`).join('\n')}` : '') }
    }
    const prefix = buildPrefix(versionFileName, brief, null, null)
    return { prompt: prefix ? `${prefix}\n\n${userMsg}` : userMsg }
  })

  function runSendToFigma(args: SendToFigmaArgs): { ok: boolean; error?: string } | Promise<{ ok: true } | { ok: false; error: string }> {
    const d = getDesign(args.designId)
    if (!d) return { ok: false, error: 'Design not found.' }
    const versions = listVersions(args.designId)
    const latest = versions[versions.length - 1]
    if (!latest) return { ok: false, error: 'Generate at least one version first.' }
    let mode = args.mode ?? 'newFile'
    const kind = d.brief?.kind ?? ''
    const isDeck = ['pitch-deck','sales-deck','talk-slides','workshop-deck'].includes(kind)
    const briefBits: string[] = []
    if (d.brief?.kindLabel) briefBits.push(`Kind: ${d.brief.kindLabel}`)
    if (d.brief?.paletteColors?.length) briefBits.push(`Palette: ${d.brief.paletteColors.join(', ')}`)
    if (d.brief?.fontHeading) briefBits.push(`Heading font: ${d.brief.fontHeading}`)
    if (d.brief?.fontBody) briefBits.push(`Body font: ${d.brief.fontBody}`)

    // Extract a fileKey from any Figma URL the user pasted. Figma URLs
    // come in the forms:
    //   https://www.figma.com/design/{key}/{name}
    //   https://www.figma.com/file/{key}/{name}
    //   https://www.figma.com/board/{key}/{name}    (FigJam)
    //   https://www.figma.com/proto/{key}/{name}
    let fileUrl = (args.fileUrl ?? '').trim()
    let fileKey = extractFigmaKey(fileUrl)

    // Default Figma file: when no explicit fileUrl was passed AND the user
    // has a default file set in Settings, fork into that file instead of
    // creating a fresh one. This avoids the unclaimed-file empty result and
    // lets the agent reuse components from the file's design system.
    if (!fileKey && mode === 'newFile') {
      const defaultRef = (getSettings().defaultFigmaFile ?? '').trim()
      if (defaultRef) {
        fileKey = extractFigmaKey(defaultRef) ?? (/^[A-Za-z0-9]{8,40}$/.test(defaultRef) ? defaultRef : null)
        if (fileKey) {
          mode = 'existingFile'
          fileUrl = defaultRef.startsWith('http') ? defaultRef : `https://www.figma.com/design/${fileKey}/`
        }
      }
    }

    if (mode === 'existingFile' && !fileKey) {
      return { ok: false, error: 'Could not extract a Figma file key from that URL. Expected something like https://www.figma.com/design/ABC123…/MyFile' }
    }

    // Only `figma-write` is configured: the custom MCP that drives the "MCP
    // WebSocket Client" plugin in Figma Desktop. The hosted `figma` server was
    // removed because its OAuth token expired with no refresh token, so it
    // nagged for re-authentication on every CLI start. Nothing here may name
    // figma-* tools any more -- instructing the model to call tools that are
    // not registered wastes a turn and produces a confusing failure.
    const lines: string[] = []
    lines.push(`You are exporting an HTML design (./${latest.fileName}) into Figma via the figma-write MCP server:`)
    lines.push(`  - figma-write-* (custom): figma-write-figma_plugin_status, figma-write-figma_svg, figma-write-figma_pages, figma-write-figma_nodes, figma-write-figma_auto_layout, figma-write-figma_text, figma-write-figma_fills, figma-write-figma_strokes, figma-write-figma_effects, figma-write-figma_fonts, figma-write-figma_get_design_state. Requires the "MCP WebSocket Client" plugin running in Figma Desktop.`)
    lines.push('')

    lines.push(`PRECHECK — Confirm the plugin is running.`)
    lines.push(`  Call figma-write-figma_plugin_status with a 5s timeout.`)
    lines.push(`  - If it responds → continue.`)
    lines.push(`  - If it does NOT respond → stop and tell the user to open the "MCP WebSocket Client" plugin in Figma Desktop. There is no second path; do not invent one.`)
    lines.push('')

    lines.push(`PASS 0 — Read the source.`)
    lines.push(`  Open ./${latest.fileName}. Note layout, palette (hex), heading + body fonts, icon library, image sources, per-section copy.`)
    lines.push(`  If using figma-write: call figma-write-figma_get_design_state to read any __design_tokens__ and __ai_rules__ nodes. If tokens exist, USE THEM (override your own choices).`)
    lines.push('')

    lines.push(`PASS 1 — Set up the file or page.`)
    lines.push(`  figma-write path: figma-write-figma_pages create + name "${d.title}", then activate.`)
    lines.push('')

    lines.push(`PASS 2 — Build the scaffold (auto-layout frames per major section).`)
    lines.push(`  figma-write path: figma-write-figma_nodes (or figma-write-figma_build_page) for one top-level auto-layout frame named "${d.title}" sized to the HTML viewport (1280 wide for app/dashboard, 600 for email). Inside, one auto-layout frame per HTML section. Use figma-write-figma_auto_layout for layoutMode + itemSpacing + padding. Sizing HUG or FILL, never FIXED (except top frame width). clipsContent = false.`)
    lines.push('')

    lines.push(`PASS 3 — Fonts and text.`)
    lines.push(`  figma-write path: figma-write-figma_fonts to load every font BEFORE creating text. figma-write-figma_text to add headings + body. layoutSizingHorizontal = HUG inside auto-layout parents.`)
    lines.push('')

    lines.push(`PASS 4 — Fills, strokes, effects.`)
    lines.push(`  figma-write: figma-write-figma_fills (solid hex from HTML), figma-write-figma_strokes, figma-write-figma_effects (subtle shadows; respect noHeavyShadow).`)
    lines.push('')

    lines.push(`PASS 5 — Icons (THIS is what makes icons look right).`)
    lines.push(`  Inspect the HTML for icon classes (Phosphor / Tabler / Lucide / Remix / Material Symbols) and inline SVGs. For each:`)
    lines.push(`    - Fetch the SVG markup from the right CDN:`)
    lines.push(`        Phosphor regular: https://unpkg.com/@phosphor-icons/core@2.1.1/assets/regular/<name>.svg`)
    lines.push(`        Phosphor fill:    https://unpkg.com/@phosphor-icons/core@2.1.1/assets/fill/<name>-fill.svg`)
    lines.push(`        Tabler outline:   https://unpkg.com/@tabler/icons/icons/outline/<name>.svg`)
    lines.push(`        Lucide:           https://unpkg.com/lucide-static@latest/icons/<name>.svg`)
    lines.push(`        Remix:            https://unpkg.com/remixicon@4/icons/System/<name>-line.svg`)
    lines.push(`    - Replace currentColor with the icon's CSS hex BEFORE inserting.`)
    lines.push(`  figma-write path: pass to figma-write-figma_svg with operation "import" + parent + position + size.`)
    lines.push(`  Real editable vector icons. Do NOT skip and do NOT substitute basic shapes. If a fetch fails, same-sized rectangle in the icon's colour as last resort.`)
    lines.push('')

    lines.push(`PASS 6 — Charts and graphics (REQUIRED if the HTML has any).`)
    lines.push(`  Bar charts → rectangles in an auto-layout row, heights matching source values.`)
    lines.push(`  Line / area → figma-write-figma_vectors with the SVG path data already in the HTML.`)
    lines.push(`  Donut / pie → ellipses with arcData per segment.`)
    lines.push(`  Progress bars + status badges → primitive frames with tinted fills.`)
    lines.push(`  Do NOT replace a chart with a single grey rectangle.`)
    lines.push('')

    lines.push(`PASS 7 — Images.`)
    lines.push(`  figma-write: figma-write-figma_images to download + apply as image fill.`)
    lines.push('')

    lines.push(`PASS 8 — Final check.`)
    lines.push(`  figma-write: figma-write-figma_get_design_state on the new page.`)
    lines.push(`  Confirm: top frame exists, all sections present, icons rendered (not blanks). If anything wrong, fix and re-check.`)
    lines.push('')

    lines.push(`Anti-patterns to avoid:`)
    lines.push(`  - Do NOT use FIXED sizing on auto-layout frames. Use HUG / FILL.`)
    lines.push(`  - Do NOT skip font loading.`)
    lines.push(`  - Do NOT leave icons as text or basic shapes — always go through figma-write-figma_svg or figma.createNodeFromSvg.`)
    lines.push(`  - Do NOT use em-dashes (U+2014) or en-dashes (U+2013) in any layer/text. Use ASCII "-" or " · ".`)
    lines.push(`  - Respect every __ai_rules__ value if the figma-write path returned any.`)
    lines.push(`  - Do NOT pretend the build succeeded. If a step fails, report it.`)
    if (isDeck) lines.push(`  - Deck: render each <section class="slide"> as its own 1920x1080 frame, laid out left-to-right.`)
    lines.push('')

    lines.push(`Reply with: (1) confirmation that the build is in Figma, (2) one short line per pass describing what was built, (3) anything that fell back to a placeholder. Do NOT save any local HTML files.`)
    void briefBits
    void mode
    void fileKey

    const displayText = mode === 'existingFile' && fileKey
      ? `Exporting "${d.title}" → Figma (existing file)`
      : `Exporting "${d.title}" → Figma (new file)`

    return send(getWin(), args.designId, lines.join('\n'), { model: null, skipPrefix: true, useFigma: true, freshSession: true, displayText })
  } // end runSendToFigma

  // Build directly in Figma: no HTML version is generated. The user's
  // description is sent to Copilot with a Figma-only prompt.
  function runFigmaFromScratch(args: FigmaFromScratchArgs): { ok: boolean; error?: string } | Promise<{ ok: true } | { ok: false; error: string }> {
    const d = getDesign(args.designId)
    if (!d) return { ok: false, error: 'Design not found.' }
    const description = (args.description ?? '').trim()
    if (!description) return { ok: false, error: 'Describe what to build first.' }
    let mode = args.mode ?? 'newFile'
    let fileUrl = (args.fileUrl ?? '').trim()
    let fileKey = extractFigmaKey(fileUrl)

    if (!fileKey && mode === 'newFile') {
      const defaultRef = (getSettings().defaultFigmaFile ?? '').trim()
      if (defaultRef) {
        fileKey = extractFigmaKey(defaultRef) ?? (/^[A-Za-z0-9]{8,40}$/.test(defaultRef) ? defaultRef : null)
        if (fileKey) {
          mode = 'existingFile'
          fileUrl = defaultRef.startsWith('http') ? defaultRef : `https://www.figma.com/design/${fileKey}/`
        }
      }
    }

    if (mode === 'existingFile' && !fileKey) {
      return { ok: false, error: 'Could not extract a Figma file key from that URL.' }
    }
    maybeAutoTitle(args.designId, description)

    const lines: string[] = []
    lines.push(`Build a Figma design from this description using the figma-write MCP server (the one that built the original Terminal42 mockups). Tools are prefixed figma-write-.`)
    lines.push(`Description: ${description}`, '')

    lines.push(`PRECHECK — Connection.`)
    lines.push(`  Call figma-write-figma_plugin_status. If it does NOT respond within a few seconds, STOP and reply: "The Figma plugin isn't connected. Open Figma Desktop, run the 'MCP WebSocket Client' plugin from Plugins → Development, then ask me to retry." Do not call any other tools in that case.`)
    lines.push('')

    lines.push(`PASS 0 — Read tokens.`)
    lines.push(`  Call figma-write-figma_get_design_state to read any __design_tokens__ and __ai_rules__ nodes already in the file. If tokens exist, USE THEM (override your own colour / type / radius / shadow choices).`)
    lines.push('')

    lines.push(`PASS 1 — Set up the page.`)
    lines.push(`  Call figma-write-figma_pages with operation create + name "${d.title}", then activate it.`)
    lines.push('')

    lines.push(`PASS 2 — Pick the visual language.`)
    lines.push(`  If the file has __design_tokens__, use those. Otherwise pick concrete brand colours, typography, spacing and radius that fit the description. Solid fills only, exact hex.`)
    lines.push('')

    lines.push(`PASS 3 — Build the scaffold (auto-layout frames per major section).`)
    lines.push(`  Use figma-write-figma_nodes (or figma-write-figma_build_page) to create one top-level auto-layout frame named "${d.title}" sized to the right viewport (1280 wide for app/dashboard, 600 for email, 1200x800 for landing).`)
    lines.push(`  Inside it, one auto-layout frame per major section.`)
    lines.push(`  Use figma-write-figma_auto_layout for layoutMode + itemSpacing + padding. Sizing must be HUG or FILL, never FIXED (except top frame width).`)
    lines.push('')

    lines.push(`PASS 4 — Fonts and text.`)
    lines.push(`  Call figma-write-figma_fonts to load every font BEFORE creating text. For Inter use "Semi Bold" / "Extra Bold" (with the space).`)
    lines.push(`  Use figma-write-figma_text. Set layoutSizingHorizontal = HUG inside auto-layout parents.`)
    lines.push('')

    lines.push(`PASS 5 — Fills, strokes, effects.`)
    lines.push(`  figma-write-figma_fills, figma-write-figma_strokes, figma-write-figma_effects. Subtle shadows by default; respect noHeavyShadow if set.`)
    lines.push('')

    lines.push(`PASS 6 — Icons via figma-write-figma_svg (THIS makes icons look right).`)
    lines.push(`  For each icon needed, fetch SVG markup from a CDN and pass to figma-write-figma_svg with operation "import":`)
    lines.push(`    - Phosphor: https://unpkg.com/@phosphor-icons/core@2.1.1/assets/regular/<name>.svg`)
    lines.push(`    - Tabler:   https://unpkg.com/@tabler/icons/icons/outline/<name>.svg`)
    lines.push(`    - Lucide:   https://unpkg.com/lucide-static@latest/icons/<name>.svg`)
    lines.push(`  Replace currentColor with the icon's hex BEFORE calling figma-write-figma_svg. Do NOT substitute basic shapes.`)
    lines.push('')

    lines.push(`PASS 7 — Final check.`)
    lines.push(`  figma-write-figma_get_design_state to confirm: top frame, all sections, real icons (not blanks). Fix anything wrong.`)
    lines.push('')

    lines.push(`Anti-patterns to avoid:`)
    lines.push(`  - Do NOT use FIXED sizing on auto-layout frames. Use HUG / FILL.`)
    lines.push(`  - Do NOT skip font loading.`)
    lines.push(`  - Do NOT leave icons as text or basic shapes — always go through figma-write-figma_svg.`)
    lines.push(`  - Do NOT use em-dashes (U+2014) or en-dashes (U+2013). Use ASCII "-" or " · ".`)
    lines.push(`  - Respect every __ai_rules__ value (no fake testimonials, no eyebrow pills, no emoji icons unless asked).`)
    lines.push(`  - Do NOT pretend the build succeeded. If a step fails, report it.`)
    lines.push('')

    lines.push(`Reply with: (1) confirmation that the build is in Figma, (2) one short line per pass describing what was built, (3) anything that fell back to a placeholder. Do NOT save any local HTML files.`)
    void mode
    void fileKey

    const displayText = mode === 'existingFile' && fileKey
      ? `Building "${d.title}" in Figma (existing file)`
      : `Building "${d.title}" in Figma (new file)`

    return send(getWin(), args.designId, lines.join('\n'), { model: null, skipPrefix: true, useFigma: true, freshSession: true, displayText })
  } // end runFigmaFromScratch

  // Whether the library a design was built against has moved since, and what
  // to call it. Asked per design by the list, so it stays cheap: a hash of two
  // already-sorted strings, no file reads.
  ipcMain.handle('designs:tokensStatus', (_e, designId: string): TokensStatus => {
    const d = getDesign(designId)
    const tokensId = d?.brief?.tokensId
    if (!tokensId) return { bound: false, name: null, moved: false, missing: false }
    const record = getTokenStudio(tokensId)
    // Bound to something that is gone. Generation carries on without it by
    // design, so this is the only place that can say the binding has stopped
    // meaning anything.
    if (!record) return { bound: true, name: null, moved: false, missing: true }
    return { bound: true, name: record.name, moved: tokensHaveMoved(d?.brief ?? null), missing: false }
  })

  // Bring a bound design back into line with its library.
  //
  // Rewriting the files is the whole fix for a design that used the variables,
  // which is the common case and why this is worth offering as one click. A
  // design that inlined a hex instead gets no benefit from new files, so the
  // linter runs afterwards and says what it could not relink — the drift
  // becomes visible rather than staying silent.
  ipcMain.handle('designs:resyncTokens', async (_e, designId: string) => {
    const d = getDesign(designId)
    if (!d?.brief?.tokensId) return { ok: false as const, error: 'This design is not bound to a library.' }
    const stamp = await writeTokensFiles(d.cwd, d.brief)
    if (!stamp) return { ok: false as const, error: 'That library could not be read.' }
    const brief = { ...d.brief, tokensStamp: stamp }
    try {
      getDb().prepare('UPDATE designs SET brief = ? WHERE id = ?').run(JSON.stringify(brief), designId)
    } catch (err) {
      return { ok: false as const, error: String(err) }
    }
    let stuck: string[] = []
    try {
      const versions = listVersions(designId)
      const latest = versions[versions.length - 1]
      if (latest && latest.kind === 'html') {
        stuck = lintTokens(await fs.readFile(latest.filePath, 'utf8'), brief).lines
      }
    } catch {
      // No readable version yet is not a failure: the files are still correct.
    }
    return { ok: true as const, stuck }
  })

  /**
   * Bind a design to a token library, or let it go.
   *
   * Separate from the wizard because binding is not only a thing you decide
   * before anything exists. A form drawn last week is exactly the work that
   * needs pulling back onto the team's colours, and it has no wizard to
   * return to.
   */
  ipcMain.handle(
    'designs:setTokens',
    async (_e, args: { designId: string; tokensId: string | null; themeId: string | null }) => {
      const d = getDesign(args.designId)
      if (!d) return { ok: false as const, error: 'That design has gone.' }
      const brief = {
        ...(d.brief ?? ({ v: 1 } as unknown as DesignBrief)),
        tokensId: args.tokensId,
        tokensThemeId: args.themeId,
        tokensStamp: null as string | null
      }
      if (args.tokensId) {
        // Written now rather than at the next generation, so the folder and the
        // prompt agree from the moment somebody says yes.
        brief.tokensStamp = await writeTokensFiles(d.cwd, brief)
        if (!brief.tokensStamp) return { ok: false as const, error: 'That library could not be read.' }
      }
      try {
        getDb().prepare('UPDATE designs SET brief = ? WHERE id = ?').run(JSON.stringify(brief), args.designId)
      } catch (err) {
        return { ok: false as const, error: String(err) }
      }
      return { ok: true as const, brief }
    }
  )

  ipcMain.handle('designs:cancel', (_e, designId: string) => ({ ok: cancel(designId) }))
  ipcMain.handle('designs:isBusy', (_e, designId: string) => running.has(designId))
  ipcMain.handle('designs:history', (_e, designId: string) => loadHistory(designId))

  ipcMain.handle('designs:listVersions', (_e, designId: string) => listVersions(designId))
  ipcMain.handle('designs:readVersion', async (_e, designId: string, fileName: string) => {
    const versions = listVersions(designId)
    const v = versions.find((x) => x.fileName === fileName) ?? null
    if (!v) return { ok: false as const, error: 'Not found' }
    try {
      const content = await fs.readFile(v.filePath, 'utf8')
      // An app built around a router is served over a loopback origin rather
      // than put in srcDoc (see spa.ts), and none of what follows applies to
      // it: it is fetching its own files over http, from a directory the
      // server is already serving. Worse than unnecessary, a file:// base
      // would be actively harmful -- the router's first pushState would
      // resolve against it, rewriting history to an origin the frame does
      // not own, which Chromium answers by killing the renderer.
      if (looksLikeSpa(content)) return { ok: true as const, content, spa: true as const }
      // See versionBase.ts: rendered through srcDoc, relative URLs resolve
      // against about:srcdoc unless the design's directory is set as the
      // base — and a document that already declares its own base has to be
      // resolved against that directory rather than overruled by it.
      const d = getDesign(designId)
      const baseHref = d ? pathToFileURL(d.cwd + '/').toString() : ''
      const based = applyBaseHref(content, baseHref)
      // And pull in its own scripts and stylesheets: srcDoc sits inside a page
      // served over http, so a file:// script is refused as cross-origin and
      // the page renders as an empty root with nothing to say why.
      const inlined = await inlineLocalAssets(based, effectiveBase(based, baseHref), async (fileUrl) => {
        try { return await fs.readFile(fileURLToPath(fileUrl), 'utf8') } catch { return null }
      })
      return { ok: true as const, content: inlined, spa: false as const }
    } catch (err) {
      return { ok: false as const, error: String(err) }
    }
  })
  /**
   * Put a design's preview on a loopback origin and hand back its URL.
   *
   * Only for previews that need an address -- see spa.ts. The document is
   * the one the canvas has already prepared, so what is on screen does not
   * change; only where it lives does.
   */
  ipcMain.handle('designs:serve', async (_e, args: { designId: string; html: string }) => {
    const d = getDesign(args.designId)
    if (!d) return { ok: false as const, error: 'Not found' }
    if (typeof args.html !== 'string') return { ok: false as const, error: 'No document' }
    try {
      return { ok: true as const, url: await serveDesign(d.cwd, args.html) }
    } catch (err) {
      return { ok: false as const, error: String(err) }
    }
  })

  ipcMain.handle('designs:watch', async (_e, designId: string) => {
    watchDesign(getWin, designId)
    return { ok: true }
  })
  ipcMain.handle('designs:unwatch', (_e, designId: string) => { unwatch(designId); return { ok: true } })
  ipcMain.handle('designs:revealLatest', (_e, designId: string) => {
    const versions = listVersions(designId)
    const latest = versions[versions.length - 1]
    if (!latest) return { ok: false }
    try { shell.showItemInFolder(latest.filePath); return { ok: true } } catch { return { ok: false } }
  })
  ipcMain.handle('designs:openExternal', async (_e, fileUrl: string) => {
    if (typeof fileUrl !== 'string') return { ok: false }
    // Confine to the schemes this handler is actually called with (design
    // file:// URLs and http(s) Figma links). The renderer renders untrusted
    // srcDoc design HTML with webSecurity disabled, so reject any other scheme
    // (javascript:, custom protocol handlers, smb:, etc.).
    if (!/^(https?|file):/i.test(fileUrl)) return { ok: false }
    try { await shell.openExternal(fileUrl); return { ok: true } } catch { return { ok: false } }
  })

  // Export the latest version. Format must be one of: html | pdf | png | pptx.
  ipcMain.handle('designs:export', async (_e, args: { designId: string; format: ExportFormat }) =>
    exportLatest(args.designId, args.format))

  // Which formats does this design's kind support?
  ipcMain.handle('designs:formats', (_e, designId: string) => {
    const d = getDesign(designId)
    return formatsForKind(d?.brief?.kind)
  })

  // Can this design's kind meaningfully be pushed into Figma? Renderer
  // uses this to hide the Figma button for kinds where it would just
  // produce noise (e.g. HTML email).
  ipcMain.handle('designs:canFigma', (_e, designId: string) => {
    const d = getDesign(designId)
    return canExportToFigma(d?.brief?.kind)
  })

  // Upload a template file (pptx / pdf / png / docx / html / etc.) into a
  // design's cwd. Saved as `template.<ext>` so the model can find it
  // predictably. Returns the basename it was saved as.
  ipcMain.handle('designs:uploadTemplate', async (_e, args: { designId: string; name: string; bytes: ArrayBuffer | Uint8Array }) => {
    const d = getDesign(args.designId)
    if (!d) return { ok: false as const, error: 'Design not found.' }
    const ext = (args.name.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
    const filename = `template.${ext}`
    try {
      await fs.mkdir(d.cwd, { recursive: true })
      const buf = Buffer.from(args.bytes as ArrayBuffer)
      await fs.writeFile(join(d.cwd, filename), buf)
      // Record on the design row so the prompt picks it up next turn. If
      // the design has no brief yet (e.g. blank canvas), bootstrap a
      // minimal one so templateFile is still honoured.
      const brief = d.brief
        ? { ...d.brief, templateFile: filename }
        : { v: 1 as const, kind: 'blank' as DesignKind, kindLabel: 'Blank canvas',
            group: 'other' as DesignGroup, fidelity: 'highfidelity' as const,
            templateFile: filename, createdAt: Date.now() }
      getDb().prepare('UPDATE designs SET brief = ?, last_active_at = ? WHERE id = ?')
        .run(JSON.stringify(brief), Date.now(), args.designId)
      return { ok: true as const, filename }
    } catch (err) {
      return { ok: false as const, error: String(err) }
    }
  })

  // Upload a reference image (PNG / JPG / WebP / GIF / SVG / AVIF) into the
  // design's `_refs/` folder. Returns the basename it was saved as. Names
  // are sanitised + suffixed with a short id to avoid collisions across
  // multiple drops. Updates the design row's brief.inspirationImages so
  // every future send() call picks them up automatically.
  ipcMain.handle('designs:uploadInspiration', async (_e, args: { designId: string; name: string; bytes: ArrayBuffer | Uint8Array }) => {
    const d = getDesign(args.designId)
    if (!d) return { ok: false as const, error: 'Design not found.' }
    const dot = args.name.lastIndexOf('.')
    const rawExt = dot >= 0 ? args.name.slice(dot + 1) : ''
    const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'png'
    const stem = (dot >= 0 ? args.name.slice(0, dot) : args.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'ref'
    const id = Math.random().toString(36).slice(2, 8)
    const filename = `${stem}-${id}.${ext}`
    try {
      const refsDir = join(d.cwd, '_refs')
      await fs.mkdir(refsDir, { recursive: true })
      const buf = Buffer.from(args.bytes as ArrayBuffer)
      await fs.writeFile(join(refsDir, filename), buf)
      // Append to the brief's inspirationImages list so every future prompt
      // picks the file up. Bootstrap a minimal brief if needed.
      const existing: string[] = Array.isArray(d.brief?.inspirationImages) ? (d.brief!.inspirationImages as string[]) : []
      const next = [...existing, filename]
      const brief = d.brief
        ? { ...d.brief, inspirationImages: next }
        : { v: 1 as const, kind: 'blank' as DesignKind, kindLabel: 'Blank canvas',
            group: 'other' as DesignGroup, fidelity: 'highfidelity' as const,
            inspirationImages: next, createdAt: Date.now() }
      getDb().prepare('UPDATE designs SET brief = ?, last_active_at = ? WHERE id = ?')
        .run(JSON.stringify(brief), Date.now(), args.designId)
      return { ok: true as const, filename }
    } catch (err) {
      return { ok: false as const, error: String(err) }
    }
  })

  ipcMain.handle('designs:removeAttachment', async (_e, args: { designId: string; filename: string }) => {
    const d = getDesign(args.designId)
    if (!d) return { ok: false as const, error: 'Design not found.' }
    const safe = args.filename.replace(/[^a-zA-Z0-9._-]/g, '')
    if (!safe) return { ok: false as const, error: 'Invalid file.' }
    try {
      let brief = d.brief
      if (brief?.templateFile === safe) {
        try { await fs.unlink(join(d.cwd, safe)) } catch {}
        brief = { ...brief, templateFile: null }
      } else {
        try { await fs.unlink(join(d.cwd, '_refs', safe)) } catch {}
        const refs = Array.isArray(brief?.inspirationImages) ? brief!.inspirationImages!.filter((f) => f !== safe) : []
        brief = brief
          ? { ...brief, inspirationImages: refs }
          : { v: 1 as const, kind: 'blank' as DesignKind, kindLabel: 'Blank canvas',
              group: 'other' as DesignGroup, fidelity: 'highfidelity' as const,
              inspirationImages: refs, createdAt: Date.now() }
      }
      getDb().prepare('UPDATE designs SET brief = ?, last_active_at = ? WHERE id = ?')
        .run(JSON.stringify(brief), Date.now(), args.designId)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: String(err) }
    }
  })

  // Returns a base64 data URL for a reference image so the renderer can
  // show a thumbnail without a privileged file:// fetch.
  ipcMain.handle('designs:inspirationDataUrl', async (_e, args: { designId: string; filename: string }): Promise<string | null> => {
    const d = getDesign(args.designId)
    if (!d) return null
    const safe = args.filename.replace(/[^a-zA-Z0-9._-]/g, '')
    if (!safe) return null
    try {
      const buf = await fs.readFile(join(d.cwd, '_refs', safe))
      const ext = safe.split('.').pop()?.toLowerCase() ?? 'png'
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                 : ext === 'webp' ? 'image/webp'
                 : ext === 'gif'  ? 'image/gif'
                 : ext === 'svg'  ? 'image/svg+xml'
                 : ext === 'avif' ? 'image/avif'
                 : 'image/png'
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch { return null }
  })
}
