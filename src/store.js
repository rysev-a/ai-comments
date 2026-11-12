// The comments file and every change of a comment's status. No Vite, no DOM: the plugin, the CLI that Claude calls
// and the tests all use this one file.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const STATUSES = ['draft', 'sent', 'processing', 'done', 'archive']

/**
 * @typedef {{
 *   id: string, route: string,
 *   rect: { x: number, y: number, w: number, h: number },
 *   viewport: { w: number, h: number },
 *   comment: string, elements: string[],
 *   status: 'draft' | 'sent' | 'processing' | 'done' | 'archive',
 *   batch?: string, progress?: number, note?: string,
 *   createdAt: string, updatedAt: string, sentAt?: string,
 * }} Comment
 * @typedef {{ version: 1, comments: Comment[] }} State
 */

export const emptyState = () => ({ version: 1, comments: [] })
export const newId = () => crypto.randomUUID().slice(0, 8)
const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)))

/** Read the file; a missing or broken file is an empty state (`exists` says which). */
export function read(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (s && Array.isArray(s.comments)) return { state: { version: 1, comments: s.comments }, exists: true }
  } catch {
    /* no file, or not JSON */
  }
  return { state: emptyState(), exists: fs.existsSync(file) }
}

/** Write through a temporary file, so a reader never sees half a file. */
export function write(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

/** The plugin and the CLI are two processes, so a change is read-modify-write under a lock directory. */
export function mutate(file, fn) {
  const lock = file + '.lock'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const until = Date.now() + 5000
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { recursive: true, force: true }) // stale
      } catch {
        /* just released */
      }
      if (Date.now() > until) throw new Error('the comments file is locked')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
    }
  }
  try {
    const { state } = read(file)
    const result = fn(state)
    write(file, state)
    return result
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

const now = () => new Date().toISOString()
const find = (state, id) => state.comments.find((c) => c.id === id)

// --- the changes ----------------------------------------------------------------------------------------------------------------------
/** A new comment is a draft. */
export function add(state, input) {
  const c = {
    id: input.id || newId(),
    route: String(input.route || '/'),
    rect: input.rect,
    viewport: input.viewport,
    comment: String(input.comment || '').trim(),
    elements: Array.isArray(input.elements) ? input.elements.slice(0, 14) : [],
    status: 'draft',
    createdAt: now(),
    updatedAt: now(),
  }
  if (!c.comment) throw new Error('empty comment')
  state.comments.push(c)
  return c
}

/** Edit the text of a draft (or of a comment the person wants to say more about). */
export function edit(state, id, text) {
  const c = find(state, id)
  if (!c) throw new Error('no such comment')
  c.comment = String(text).trim()
  c.updatedAt = now()
  return c
}

export function remove(state, id) {
  const i = state.comments.findIndex((c) => c.id === id)
  if (i < 0) throw new Error('no such comment')
  state.comments.splice(i, 1)
}

/** Send: every draft becomes `sent` and gets the name of the batch. */
export function send(state, batch) {
  const name = String(batch || '').trim()
  if (!name) throw new Error('a batch needs a name')
  const t = now()
  const sent = state.comments.filter((c) => c.status === 'draft')
  for (const c of sent) Object.assign(c, { status: 'sent', batch: name, sentAt: t, updatedAt: t })
  return sent
}

/** Archive: every `done` comment goes to the archive. */
export function archiveDone(state) {
  const done = state.comments.filter((c) => c.status === 'done')
  const t = now()
  for (const c of done) Object.assign(c, { status: 'archive', updatedAt: t })
  return done
}

/** Claude takes the comments that are `sent`: they become `processing`, at 0 %. */
export function take(state, only) {
  const t = now()
  const taken = state.comments.filter((c) => c.status === 'sent' && (!only || only.includes(c.id)))
  for (const c of taken) Object.assign(c, { status: 'processing', progress: 0, updatedAt: t })
  return taken
}

/** Claude reports how far it is, 0–100, with an optional line on what it is doing now. */
export function progress(state, id, percent, note) {
  const c = find(state, id)
  if (!c) throw new Error('no such comment')
  if (c.status !== 'processing') throw new Error(`the comment is ${c.status}, not processing`)
  c.progress = Math.min(99, clamp(percent)) // 100 is `done`
  if (note !== undefined) c.note = String(note)
  c.updatedAt = now()
  return c
}

/** Claude finishes a comment: `done`, 100 %, with a line on what was changed. */
export function finish(state, id, note) {
  const c = find(state, id)
  if (!c) throw new Error('no such comment')
  if (c.status !== 'processing') throw new Error(`the comment is ${c.status}, not processing`)
  Object.assign(c, { status: 'done', progress: 100, updatedAt: now() })
  if (note !== undefined) c.note = String(note)
  return c
}

/** The agent stopped with comments still `processing`: back to draft, so the person decides, and nothing loops. */
export function release(state, reason) {
  const back = state.comments.filter((c) => c.status === 'processing')
  for (const c of back) Object.assign(c, { status: 'draft', progress: undefined, note: reason, updatedAt: now() })
  return back
}
