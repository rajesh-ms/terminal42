import { useEffect, useMemo, useRef, useState } from 'react'
import { type AgentAction, type CanvasContext, type ChatTurn, type ObjectSpec, buildObject } from '../lib/canvasAgent'
import { runDesignPipeline, type Completer, type StageTrace } from '../lib/designPipeline'
import { compileTree, type UINode } from '../lib/uiTree'
import { lintObjects } from '../lib/designQA'
import { scoreDesign, type Scores } from '../lib/designEval'
import { runBenchmark, formatScorecard } from '../lib/benchmark'
import { DEFAULT_KIT, type Kit } from '../lib/uiKit'
import { MODELS } from './ModelDropdown'
import { type LayerMotion } from '../lib/timelineModel'
import { addBrainPreference, addBrainSkill, brainPrompt, loadAssistantBrain, saveAssistantBrain, DEFAULT_PREFS, type AssistantBrain } from '../lib/assistantBrain'
import { BoxesThinking } from './PencilThinking'
import { Modal } from './Modal'

type ActionKind = 'create' | 'animate' | 'edit' | 'delete'
interface Msg { id: string; role: 'user' | 'assistant'; text: string; options?: string[]; kind?: 'question' | 'done' | 'error'; action?: ActionKind }
let mid = 0
const newMid = (): string => `m${Date.now().toString(36)}${(mid++).toString(36)}`

const GREETING = 'What should I add?'

// Context-aware starter prompts geared toward building scenes and animating them.
function suggestionsFor(ctx: CanvasContext): string[] {
  const sel = ctx.selection
  if (sel.length === 1) {
    const n = sel[0]
    return [`Animate ${n}`, `Add heading`, `Add shadow`]
  }
  if (sel.length > 1) return ['Group selected', 'Align selected', 'Animate selected']
  if (ctx.layers.length === 0) return ['Hero section', 'Feature cards', 'Pricing card']
  return ['Add nav', 'Add card', 'Add button']
}

const ACTION_META: Record<ActionKind, { label: string; icon: JSX.Element }> = {
  create: { label: 'Added', icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg> },
  animate: { label: 'Animated', icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12c3 0 3-8 6-8s3 8 6 8" /></svg> },
  edit: { label: 'Updated', icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z" /></svg> },
  delete: { label: 'Deleted', icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.5 8h5l.5-8" /></svg> }
}


export function CanvasAssistant({ getContext, onCreate, onAnimate, onEdit, onDelete, onArtboard, onRenameArtboard, onBusyChange, model, onClose, embedded, kit }: {
  getContext: () => CanvasContext
  onCreate: (objects: ObjectSpec[], opts?: { accent?: string }) => void
  onAnimate: (target: string | undefined, motion: LayerMotion) => void
  onEdit: (target: string, patch: Partial<ObjectSpec>) => void
  onDelete: (target: string) => void
  onArtboard?: (w: number, h: number, name?: string) => void
  onRenameArtboard?: (name: string) => void
  onBusyChange?: (busy: boolean) => void
  model: string | null
  onClose: () => void
  embedded?: boolean
  kit?: Kit
}): JSX.Element {
  const activeKit = kit ?? DEFAULT_KIT
  const [messages, setMessages] = useState<Msg[]>([{ id: newMid(), role: 'assistant', text: GREETING }])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [images, setImages] = useState<string[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const onPickFiles = (files: FileList | null): void => {
    if (!files) return
    Array.from(files).slice(0, 4).forEach((f) => {
      if (!f.type.startsWith('image/')) return
      const r = new FileReader()
      r.onload = () => setImages((im) => (im.length >= 4 ? im : [...im, String(r.result)]))
      r.readAsDataURL(f)
    })
  }
  const [brainOpen, setBrainOpen] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [lastTrace, setLastTrace] = useState<StageTrace[] | null>(null)
  const [openStages, setOpenStages] = useState<Set<number>>(new Set())
  const EXAMPLE_TREE = JSON.stringify({ stack: 'y', bg: 'bg', children: [{ component: 'statusBar' }, { component: 'navBar', props: { title: 'New expense' } }, { h: 24 }, { component: 'heroAmount', props: { value: '$48.50' } }, { h: 24 }, { component: 'listRow', props: { icon: 'tag', label: 'Category', value: 'Groceries' } }, { component: 'listRow', props: { icon: 'calendar', label: 'Date', value: 'Today, Jun 29' } }, { component: 'inputRow', props: { icon: 'edit', placeholder: 'Add a note', divider: false } }, { h: 180 }, { stack: 'y', pad: 20, children: [{ component: 'primaryButton', props: { label: 'Save expense', icon: 'check' } }] }, { h: 12 }, { component: 'homeIndicator' }] }, null, 2)
  const [treeInput, setTreeInput] = useState(EXAMPLE_TREE)
  const [treeScore, setTreeScore] = useState<Scores | null>(null)
  const [treeErr, setTreeErr] = useState('')
  const [benchOut, setBenchOut] = useState('')
  const renderTree = (): void => {
    setTreeErr('')
    try {
      const node = JSON.parse(treeInput) as UINode
      const w = getContext().artboard.w
      const specs = compileTree(node, { width: w, kit: activeKit })
      // score a local copy (build → lint) for the inspector readout
      const built = specs.map((s) => buildObject(s, 0, 0))
      const refToId = new Map<string, string>()
      specs.forEach((s, i) => { if (s.ref) refToId.set(s.ref.toLowerCase(), built[i].id) })
      built.forEach((b, i) => { const p = specs[i].parent; if (typeof p === 'string') { const id = refToId.get(p.toLowerCase()); b.parent = id && id !== b.id ? id : undefined } })
      setTreeScore(scoreDesign(lintObjects(built, { artboardBg: getContext().artboard.bg }), { artboardBg: getContext().artboard.bg, accent: activeKit.accent, artboard: { w, h: getContext().artboard.h } }))
      onCreate(specs)
    } catch (e) { setTreeErr(String(e)) }
  }
  const [modelId, setModelId] = useState<string>(() => localStorage.getItem('t42-assistant-model') || model || 'gpt-6.1-sol')
  const [quality, setQuality] = useState<boolean>(() => localStorage.getItem('t42-assistant-quality') !== 'fast')
  useEffect(() => { localStorage.setItem('t42-assistant-quality', quality ? 'quality' : 'fast') }, [quality])
  const [modelOpen, setModelOpen] = useState(false)
  const modelRef = useRef<HTMLDivElement>(null)
  useEffect(() => { localStorage.setItem('t42-assistant-model', modelId) }, [modelId])
  useEffect(() => {
    if (!modelOpen) return
    const h = (e: MouseEvent): void => { if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [modelOpen])
  const [composerMenu, setComposerMenu] = useState(false)
  const composerMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!composerMenu) return
    const h = (e: MouseEvent): void => { if (composerMenuRef.current && !composerMenuRef.current.contains(e.target as Node)) setComposerMenu(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [composerMenu])
  const [brain, setBrain] = useState<AssistantBrain>(() => loadAssistantBrain())
  const [brainTab, setBrainTab] = useState<'prefs' | 'skills'>('prefs')
  const [newGroup, setNewGroup] = useState('')
  const [addingGroup, setAddingGroup] = useState(false)
  const [addingPrefFor, setAddingPrefFor] = useState<string | null>(null)
  const [prefLabel, setPrefLabel] = useState('')
  const [prefText, setPrefText] = useState('')
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null)
  const [skillMenuOpen, setSkillMenuOpen] = useState(false)
  const skillFileRef = useRef<HTMLInputElement>(null)
  const skillMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!skillMenuOpen) return
    const h = (e: MouseEvent): void => { if (skillMenuRef.current && !skillMenuRef.current.contains(e.target as Node)) setSkillMenuOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [skillMenuOpen])
  const createGroup = (label: string): string => {
    const id = `group-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`
    setBrain(saveAssistantBrain({ ...brain, groups: [...brain.groups, { id, label: label.trim() || 'New group' }] }))
    return id
  }
  const importSkillFile = (files: FileList | null): void => {
    const f = files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      const title = f.name.replace(/\.(md|markdown|txt)$/i, '')
      setBrain(addBrainSkill(brain, title, text))
    }
    reader.readAsText(f)
  }
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [messages, busy])
  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])

  const fresh = messages.length <= 1 && !busy
  const suggestions = useMemo(() => (fresh ? suggestionsFor(getContext()) : []), [fresh, getContext])

  const reset = (): void => { if (!busy) setMessages([{ id: newMid(), role: 'assistant', text: GREETING }]) }

  // Apply one action set to the canvas, returning the chat messages to show. Used
  // for the primary design and for each variant (each variant lands on its own artboard).
  const applyActions = (actions: AgentAction[], reply?: string): Msg[] => {
    const out: Msg[] = []
    if (!actions.length) { if (reply) out.push({ id: newMid(), role: 'assistant', text: reply }); return out }
    for (const a of actions) {
      if (a.kind === 'question') out.push({ id: newMid(), role: 'assistant', text: a.text, options: a.options, kind: 'question' })
      else if (a.kind === 'artboard') { onArtboard?.(a.w, a.h, a.name); out.push({ id: newMid(), role: 'assistant', text: a.summary, kind: 'done', action: 'create' }) }
      else if (a.kind === 'screen') { try { const tree = a.tree as UINode; onCreate(compileTree(tree, { width: getContext().artboard.w, accent: a.accent, kit: activeKit }), { accent: a.accent }); if (tree?.name) onRenameArtboard?.(String(tree.name)) } catch { /* bad tree */ } out.push({ id: newMid(), role: 'assistant', text: a.summary, kind: 'done', action: 'create' }) }
      else if (a.kind === 'create') { onCreate(a.objects, { accent: a.objects.find((o) => typeof o.accent === 'string')?.accent }); out.push({ id: newMid(), role: 'assistant', text: a.summary, kind: 'done', action: 'create' }) }
      else if (a.kind === 'animate') { onAnimate(a.target, a.motion); out.push({ id: newMid(), role: 'assistant', text: a.summary, kind: 'done', action: 'animate' }) }
      else if (a.kind === 'edit') { onEdit(a.target, a.patch); out.push({ id: newMid(), role: 'assistant', text: a.summary, kind: 'done', action: 'edit' }) }
      else if (a.kind === 'delete') { onDelete(a.target); out.push({ id: newMid(), role: 'assistant', text: a.summary, kind: 'done', action: 'delete' }) }
    }
    return out
  }

  const send = async (text: string): Promise<void> => {
    const t = text.trim()
    if ((!t && !images.length) || busy) return
    setInput('')
    const imgs = images
    setImages([])
    const userMsg: Msg = { id: newMid(), role: 'user', text: t || '(reference image)' }
    const history: ChatTurn[] = [...messages, userMsg].filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.text }))
    setMessages((m) => [...m, userMsg])
    setBusy(true)
    setStage('')
    // For a fresh screen (nothing selected, but the canvas already has content),
    // spin up a NEW artboard now so the shimmer + result land on their own board
    // instead of overlaying the current design. The model's artboard/screen action
    // then resizes + renames this empty board (assistantArtboard reuses it).
    const ctxPre = getContext()
    if (ctxPre.selection.length === 0 && ctxPre.layers.length > 0 && onArtboard) {
      onArtboard(ctxPre.artboard.w, ctxPre.artboard.h, 'New design')
    }
    try {
      const ctx = getContext()
      const complete: Completer = async (prompt, vis) => {
        const res = vis && vis.length
          ? await window.terminal42.canvas.assistVision(prompt, vis, modelId)
          : await window.terminal42.canvas.assist(prompt, modelId)
        if (!res.ok) throw new Error(res.error)
        return res.text
      }
      const result = await runDesignPipeline({
        ctx, brain: brainPrompt(brain), history: history.slice(0, -1), userText: t,
        quality, images: imgs, variants: quality ? 3 : 1, complete, onStage: setStage
      })
      setLastTrace(result.trace)
      const out: Msg[] = applyActions(result.primary.actions, result.primary.reply)
      result.variants.forEach((v, i) => {
        if (!v.some((a) => a.kind === 'artboard') && v.some((a) => a.kind === 'create')) onArtboard?.(ctx.artboard.w, ctx.artboard.h, `Option ${i + 2}`)
        out.push(...applyActions(v))
      })
      if (!out.length) out.push({ id: newMid(), role: 'assistant', text: 'Done.' })
      setMessages((m) => [...m, ...out])
    } catch (err) {
      setMessages((m) => [...m, { id: newMid(), role: 'assistant', text: `Something went wrong: ${String(err)}`, kind: 'error' }])
    } finally {
      setBusy(false)
      setStage('')
    }
  }

  return (
    <div className="pointer-events-auto flex h-full w-full flex-col overflow-hidden bg-surface">
      {embedded ? (
        <div className="p-2">
          <button type="button" onClick={reset} disabled={busy || fresh} className="flex w-full items-center justify-center gap-2 rounded-xl bg-elevated px-3 py-2 text-[13px] font-medium text-text-primary hover:text-text-primary disabled:opacity-60">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v10M3 8h10" /></svg>
            New chat
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2 text-[12px] font-medium text-text-primary">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--accent))" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15l-1.9-4.1L5.5 9l4.6-1.4z" /><path d="M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></svg>
            Assistant
          </div>
          <div className="flex items-center gap-0.5">
            <button type="button" onClick={reset} disabled={busy || fresh} title="New chat" className="grid h-6 w-6 place-items-center rounded text-text-muted hover:bg-elevated hover:text-text-primary disabled:opacity-30">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2v3h-3" /></svg>
            </button>
            <button type="button" onClick={onClose} className="grid h-6 w-6 place-items-center rounded text-text-muted hover:bg-elevated hover:text-text-primary">
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 3l8 8M11 3l-8 8" /></svg>
            </button>
          </div>
        </div>
      )}

      {debugOpen && (
        <Modal title="Generation inspector" onClose={() => setDebugOpen(false)} size="large">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="text-[13px] font-semibold text-text-primary">Generation inspector</div>
              <button type="button" onClick={() => setDebugOpen(false)} className="grid h-6 w-6 place-items-center rounded text-text-muted hover:bg-elevated hover:text-text-primary"><svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 3l8 8M11 3l-8 8" /></svg></button>
            </div>
            <div className="flex min-h-0 flex-1">
              <div className="flex w-1/2 flex-col overflow-y-auto p-3">
                <div className="mb-2 text-[11px] font-medium text-text-muted">Last run, each model call</div>
                {!lastTrace ? (
                  <p className="text-[12px] leading-relaxed text-text-muted">Run a prompt (Quality or Fast) and the structure → visual → critique → variant calls show up here: timing, what was parsed, and the raw model output — so you can see exactly where it went wrong.</p>
                ) : lastTrace.map((s, i) => (
                  <div key={i} className="mb-2 rounded-lg">
                    <button type="button" onClick={() => setOpenStages((o) => { const n = new Set(o); if (n.has(i)) n.delete(i); else n.add(i); return n })} className="flex w-full items-center justify-between px-3 py-2 text-left">
                      <span className="flex items-center gap-2 text-[12px] font-medium text-text-primary"><span className={['h-1.5 w-1.5 rounded-full', s.ok ? 'bg-success' : 'bg-error'].join(' ')} />{s.stage}</span>
                      <span className="text-[10.5px] text-text-muted">{s.ms}ms</span>
                    </button>
                    <div className="px-3 pb-2">
                      <div className={['text-[11px]', s.error ? 'text-error' : 'text-text-secondary'].join(' ')}>{s.error ? `Error: ${s.error}` : (s.actions.join('  ·  ') || '(nothing parsed — model returned no valid actions)')}</div>
                      {openStages.has(i) && <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-elevated p-2 text-[10.5px] leading-snug text-text-secondary">{s.raw || '(empty response)'}</pre>}
                      {!openStages.has(i) && <button type="button" onClick={() => setOpenStages((o) => new Set(o).add(i))} className="mt-1 text-[10.5px] text-text-muted hover:text-text-primary">show raw output</button>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex w-1/2 flex-col overflow-hidden p-3">
                <div className="mb-1 text-[11px] font-medium text-text-muted">Tree playground</div>
                <p className="mb-2 text-[11px] leading-relaxed text-text-muted">Paste a screen tree (the exact format the assistant targets) and render it on the canvas — no model needed. Lets you study/iterate the substrate directly.</p>
                <textarea value={treeInput} onChange={(e) => setTreeInput(e.target.value)} spellCheck={false} className="min-h-0 flex-1 resize-none rounded-lg t42-field p-2.5 font-mono text-[11px] leading-snug text-text-primary focus:outline-none" />
                {treeErr && <div className="mt-1.5 text-[11px] text-error">{treeErr}</div>}
                <div className="mt-2 flex items-center gap-3">
                  <button type="button" onClick={renderTree} className="rounded-md bg-action px-3 py-1.5 text-[12px] font-medium text-action-text hover:opacity-90">Render on canvas</button>
                  {treeScore && <span className="text-[11px] text-text-muted">contrast {Math.round(treeScore.contrast * 100)}% · grid {Math.round(treeScore.grid * 100)}% · overlaps {treeScore.overlaps} · boxes {treeScore.boxes} · hand {treeScore.handIcons} · orphans {treeScore.orphans} · accent {Math.round(treeScore.accentArea * 100)}% · score {Math.round(treeScore.total * 100)}</span>}
                </div>
                <div className="mt-3 pt-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-medium text-text-muted">Quality benchmark, cross-domain scorecard</span>
                    <button type="button" onClick={() => setBenchOut(formatScorecard(runBenchmark()))} className="rounded-md px-2.5 py-1 text-[11px] font-medium text-text-primary hover:bg-elevated">Run benchmark</button>
                  </div>
                  {benchOut
                    ? <pre className="max-h-48 overflow-auto whitespace-pre rounded bg-elevated p-2 font-mono text-[10px] leading-snug text-text-secondary">{benchOut}</pre>
                    : <p className="text-[11px] leading-relaxed text-text-muted">Scores the design substrate across domains (form/list/settings/commerce/media/dashboard) plus adversarial cases the QA gate must repair. Quality as a number, not a vibe-check.</p>}
                </div>
              </div>
            </div>
        </Modal>
      )}
      {brainOpen && (
        <Modal title="Assistant preferences" onClose={() => setBrainOpen(false)} size="large">
            <header className="flex items-center justify-between px-5 py-3">
              <div className="flex items-center gap-2 text-[14px] font-semibold text-text-primary">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4.5h8M4 8h8M4 11.5h5" /></svg>
                Assistant preferences
              </div>
              <button type="button" onClick={() => setBrainOpen(false)} className="grid h-7 w-7 place-items-center rounded text-text-muted hover:bg-elevated hover:text-text-primary" aria-label="Close">
                <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 3l8 8M11 3 3 11" /></svg>
              </button>
            </header>
            <div className="flex items-center gap-1 px-5 pb-3">
              {(['prefs', 'skills'] as const).map((t) => (
                <button key={t} type="button" onClick={() => setBrainTab(t)} className={['rounded-md px-3 py-1.5 text-[12px] font-medium', brainTab === t ? 'bg-elevated text-text-primary' : 'text-text-secondary hover:text-text-primary'].join(' ')}>
                  {t === 'prefs' ? 'Preferences' : 'Skills'}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
              {brainTab === 'prefs' ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-end pb-1">
                    {addingGroup ? (
                      <div className="flex w-full items-center gap-1.5">
                        <input autoFocus value={newGroup} onChange={(e) => setNewGroup(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && newGroup.trim()) { setAddingPrefFor(createGroup(newGroup)); setNewGroup(''); setAddingGroup(false); setPrefLabel(''); setPrefText('') } else if (e.key === 'Escape') { setNewGroup(''); setAddingGroup(false) } }}
                          placeholder="Group name" className="flex-1 rounded-md bg-elevated px-2.5 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none" />
                        <button type="button" onClick={() => { if (!newGroup.trim()) return; setAddingPrefFor(createGroup(newGroup)); setNewGroup(''); setAddingGroup(false); setPrefLabel(''); setPrefText('') }} className="rounded-md bg-elevated px-2.5 py-1.5 text-[12px] font-medium text-text-primary hover:opacity-90">Add</button>
                        <button type="button" onClick={() => { setNewGroup(''); setAddingGroup(false) }} className="grid h-7 w-7 place-items-center rounded-md text-text-muted hover:bg-elevated hover:text-text-primary"><svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 3l8 8M11 3l-8 8" /></svg></button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => setAddingGroup(true)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-text-secondary hover:text-text-primary">
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
                        New group
                      </button>
                    )}
                  </div>
                  {brain.groups.map((g) => {
                    const prefs = brain.prefs.filter((p) => p.groupId === g.id)
                    const isAdding = addingPrefFor === g.id
                    if (!prefs.length && !isAdding) return null
                    const open = !g.collapsed
                    return (
                      <section key={g.id} className="overflow-hidden rounded-lg bg-elevated/30">
                        <button type="button" onClick={() => setBrain(saveAssistantBrain({ ...brain, groups: brain.groups.map((x) => x.id === g.id ? { ...x, collapsed: !x.collapsed } : x) }))} className="flex w-full items-center justify-between px-3 py-2.5 text-left">
                          <span className="flex items-center gap-2 text-[12px] font-medium text-text-primary">
                            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={['text-text-muted transition-transform', open ? 'rotate-90' : ''].join(' ')}><path d="M6 4l4 4-4 4" /></svg>
                            {g.label}
                          </span>
                          <span className="text-[11px] text-text-muted">{prefs.filter((p) => p.enabled).length}/{prefs.length}</span>
                        </button>
                        {open && (
                          <div className="space-y-0.5 px-2 pb-2">
                            {prefs.map((p) => {
                              const custom = !DEFAULT_PREFS.some((d) => d.id === p.id)
                              return (
                                <div key={p.id} className="group/pref flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-bg/40">
                                  <input type="checkbox" checked={p.enabled} onChange={(e) => setBrain(saveAssistantBrain({ ...brain, prefs: brain.prefs.map((x) => x.id === p.id ? { ...x, enabled: e.target.checked } : x) }))} className="shrink-0" />
                                  <input value={p.label} onChange={(e) => setBrain(saveAssistantBrain({ ...brain, prefs: brain.prefs.map((x) => x.id === p.id ? { ...x, label: e.target.value } : x) }))} className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary focus:outline-none" />
                                  {custom && (
                                    <button type="button" onClick={() => setBrain(saveAssistantBrain({ ...brain, prefs: brain.prefs.filter((x) => x.id !== p.id) }))} className="grid h-6 w-6 shrink-0 place-items-center rounded text-text-muted opacity-0 hover:bg-elevated hover:text-text-primary group-hover/pref:opacity-100" aria-label="Remove preference">
                                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.5 8h5l.5-8" /></svg>
                                    </button>
                                  )}
                                </div>
                              )
                            })}
                            {isAdding ? (
                              <div className="space-y-1.5 rounded-md bg-bg/40 p-2">
                                <input autoFocus value={prefLabel} onChange={(e) => setPrefLabel(e.target.value)} placeholder="Preference name" className="w-full rounded t42-field px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted" />
                                <input value={prefText} onChange={(e) => setPrefText(e.target.value)} placeholder="Short instruction" className="w-full rounded t42-field px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted" />
                                <div className="flex gap-1.5">
                                  <button type="button" onClick={() => { if (!prefLabel.trim() && !prefText.trim()) return; setBrain(addBrainPreference(brain, g.id, prefLabel, prefText)); setPrefLabel(''); setPrefText(''); setAddingPrefFor(null) }} className="rounded-md bg-elevated px-2.5 py-1 text-[11.5px] font-medium text-text-primary hover:opacity-90">Add</button>
                                  <button type="button" onClick={() => { setPrefLabel(''); setPrefText(''); setAddingPrefFor(null) }} className="rounded-md px-2.5 py-1 text-[11.5px] text-text-muted hover:text-text-primary">Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <button type="button" onClick={() => { setAddingPrefFor(g.id); setPrefLabel(''); setPrefText('') }} className="flex items-center gap-1.5 px-2 py-1 text-[11.5px] text-text-secondary hover:text-text-primary">
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
                                Add preference
                              </button>
                            )}
                          </div>
                        )}
                      </section>
                    )
                  })}
                </div>
              ) : (
                <div className="space-y-2">
                  <input ref={skillFileRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="hidden" onChange={(e) => { importSkillFile(e.target.files); e.target.value = '' }} />
                  <div className="flex items-center justify-end pb-1">
                    <div ref={skillMenuRef} className="relative">
                      <button type="button" onClick={() => setSkillMenuOpen((o) => !o)} className="inline-flex items-center gap-1.5 rounded-md bg-elevated px-2.5 py-1.5 text-[12px] font-medium text-text-primary hover:opacity-90">
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
                        Add
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
                      </button>
                      {skillMenuOpen && (
                        <div className="t42-menu absolute right-0 top-full z-10 mt-1.5 w-44 overflow-hidden rounded-lg bg-raised py-1 shadow-overlay">
                          <button type="button" onClick={() => { setSkillMenuOpen(false); const next = addBrainSkill(brain, 'New skill', ''); setBrain(next); setExpandedSkill(next.skills[0]?.id ?? null) }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-text-primary hover:bg-elevated">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
                            Create new
                          </button>
                          <button type="button" onClick={() => { setSkillMenuOpen(false); skillFileRef.current?.click() }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-text-primary hover:bg-elevated">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 11V3M5 6l3-3 3 3M3 12.5h10" /></svg>
                            Upload .md
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  {brain.skills.length === 0 ? (
                    <div className="py-10 text-center text-[12px] text-text-muted">No skills yet. Add one to teach the assistant a specific task.</div>
                  ) : (
                    <div className="space-y-1.5">
                      {brain.skills.map((s) => {
                        const open = expandedSkill === s.id
                        return (
                          <section key={s.id} className="overflow-hidden rounded-lg bg-elevated/30">
                            <div className="flex items-center gap-3 px-3 py-2.5">
                              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted"><path d="M4 1.5h5l3 3V14a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 14V2a.5.5 0 0 1 .5-.5z" /><path d="M9 1.5V4.5h3" /></svg>
                              <button type="button" onClick={() => setExpandedSkill(open ? null : s.id)} className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium text-text-primary">{s.title || 'Untitled skill'}</button>
                              <input type="checkbox" checked={s.enabled} onChange={(e) => setBrain(saveAssistantBrain({ ...brain, skills: brain.skills.map((x) => x.id === s.id ? { ...x, enabled: e.target.checked } : x) }))} className="shrink-0" />
                              <button type="button" onClick={() => setExpandedSkill(open ? null : s.id)} className="grid h-6 w-6 shrink-0 place-items-center rounded text-text-muted hover:bg-elevated hover:text-text-primary" aria-label={open ? 'Collapse' : 'Expand'}>
                                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={['transition-transform', open ? 'rotate-90' : ''].join(' ')}><path d="M6 4l4 4-4 4" /></svg>
                              </button>
                            </div>
                            {open && (
                              <div className="space-y-1.5 px-3 pb-3">
                                <input value={s.title} onChange={(e) => setBrain(saveAssistantBrain({ ...brain, skills: brain.skills.map((x) => x.id === s.id ? { ...x, title: e.target.value } : x) }))} placeholder="Skill title" className="w-full rounded-md t42-field px-2.5 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted" />
                                <textarea value={s.content} onChange={(e) => setBrain(saveAssistantBrain({ ...brain, skills: brain.skills.map((x) => x.id === s.id ? { ...x, content: e.target.value } : x) }))} rows={8} placeholder="Markdown instructions or examples…" className="w-full resize-none rounded-md t42-field px-2.5 py-2 font-mono text-[11px] leading-snug text-text-primary placeholder:text-text-muted" />
                                <button type="button" onClick={() => { setBrain(saveAssistantBrain({ ...brain, skills: brain.skills.filter((x) => x.id !== s.id) })); setExpandedSkill(null) }} className="text-[11px] text-error/80 hover:text-error">Delete skill</button>
                              </div>
                            )}
                          </section>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
        </Modal>
      )}

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4">
        {fresh ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="text-text-muted">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15l-1.9-4.1L5.5 9l4.6-1.4z" /><path d="M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></svg>
            </div>
            <div className="text-[14px] font-medium text-text-primary">{GREETING}</div>
            {suggestions.length > 0 && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {suggestions.map((s) => (
                  <button key={s} type="button" onClick={() => void send(s)} className="rounded-full bg-elevated px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:text-text-primary">{s}</button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex items-start'}>
                <div className={['max-w-[88%] px-0 py-0 text-[12px] leading-relaxed',
                  m.role === 'user' ? 'text-text-primary'
                    : m.kind === 'error' ? 'text-error'
                    : m.kind === 'done' ? 'text-text-primary'
                    : 'text-text-secondary'].join(' ')}>
                  {m.kind === 'done' && m.action && (
                    <span className="mb-0.5 flex items-center gap-1 text-[10.5px] font-medium text-text-muted">{ACTION_META[m.action].icon}{ACTION_META[m.action].label}</span>
                  )}
                  <span className="align-middle">{m.text}</span>
                  {m.options && m.options.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {m.options.map((o) => (
                        <button key={o} type="button" disabled={busy} onClick={() => void send(o)} className="rounded-full bg-elevated px-2 py-0.5 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-40">{o}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex items-start"><div className="flex items-center gap-2 rounded-lg bg-elevated px-2.5 py-2 text-[12px] text-text-muted"><BoxesThinking /><span>{stage || 'Working on it…'}</span></div></div>
            )}
          </div>
        )}
      </div>

      <div className="p-2.5">
        <div className="rounded-2xl bg-elevated/40 p-2.5">
          {images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {images.map((src, i) => (
                <div key={i} className="relative h-12 w-12 overflow-hidden rounded-md">
                  <img src={src} alt="reference" className="h-full w-full object-cover" />
                  <button type="button" onClick={() => setImages((im) => im.filter((_, j) => j !== i))} className="absolute right-0 top-0 grid h-4 w-4 place-items-center bg-bg/80 text-text-muted hover:text-text-primary"><svg width="9" height="9" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 3l8 8M11 3l-8 8" /></svg></button>
                </div>
              ))}
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { onPickFiles(e.target.files); e.target.value = '' }} />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input) } }}
            rows={2}
            placeholder="Ask the assistant…"
            className="max-h-32 min-h-[44px] w-full resize-none bg-transparent px-1 py-1 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <div className="mt-1.5 flex items-center gap-1.5 pt-1.5">
            <div ref={modelRef} className="relative">
              <button type="button" onClick={() => setModelOpen((o) => !o)} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-text-muted hover:bg-elevated hover:text-text-primary">{(MODELS.find((m) => m.id === modelId)?.label ?? 'Model').replace(/^Claude\s+/, '')} <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg></button>
              {modelOpen && (
                <div className="t42-menu t42-menu-up absolute bottom-full left-0 z-40 mb-1.5 max-h-72 w-52 overflow-y-auto rounded-lg bg-raised py-1 shadow-overlay">
                  {MODELS.map((m) => (
                    <button key={m.id} type="button" onClick={() => { setModelId(m.id); setModelOpen(false) }} className={['flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-elevated', m.id === modelId ? 'text-text-primary' : 'text-text-secondary'].join(' ')}>
                      <span className="w-3 shrink-0">{m.id === modelId ? '\u2713' : ''}</span>{m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex h-7 items-center rounded-md bg-elevated p-0.5 text-[11px]">
              <button type="button" onClick={() => setQuality(true)} title="Quality: design properly (slower, multi-step)" className={['rounded px-2 py-1 font-medium transition-colors', quality ? 'bg-bg text-text-primary' : 'text-text-muted hover:text-text-primary'].join(' ')}>Quality</button>
              <button type="button" onClick={() => setQuality(false)} title="Fast: quick single pass" className={['rounded px-2 py-1 font-medium transition-colors', !quality ? 'bg-bg text-text-primary' : 'text-text-muted hover:text-text-primary'].join(' ')}>Fast</button>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <div ref={composerMenuRef} className="relative">
                <button type="button" onClick={() => setComposerMenu((o) => !o)} title="More" aria-label="More" className={['grid h-7 w-7 place-items-center rounded-md text-text-muted hover:bg-elevated hover:text-text-primary', composerMenu ? 'bg-elevated text-text-primary' : ''].join(' ')}>
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="13" cy="8" r="1.3" /></svg>
                </button>
                {composerMenu && (
                  <div className="t42-menu t42-menu-up absolute bottom-full right-0 z-40 mb-1.5 w-48 overflow-hidden rounded-xl bg-raised py-1 shadow-overlay">
                    <button type="button" onClick={() => { setComposerMenu(false); fileRef.current?.click() }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-text-primary hover:bg-elevated">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3l8-8" /></svg>
                      Attach image
                    </button>
                    <button type="button" onClick={() => { setComposerMenu(false); setDebugOpen(true) }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-text-primary hover:bg-elevated">
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4h12M2 8h12M2 12h7" /><circle cx="13" cy="12" r="1.4" /></svg>
                      Inspect generation
                    </button>
                    <button type="button" onClick={() => { setComposerMenu(false); setBrainOpen(true) }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-text-primary hover:bg-elevated">
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h8M4 8h8M4 11h5" /><circle cx="13" cy="11" r="0.6" fill="currentColor" /></svg>
                      Assistant preferences
                    </button>
                  </div>
                )}
              </div>
              <button type="button" disabled={busy || (!input.trim() && !images.length)} onClick={() => void send(input)} title="Send" className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-elevated text-text-muted hover:text-text-primary disabled:opacity-35">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" /></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
