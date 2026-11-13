// The comments UI, injected into every page of the dev server by the plugin (which puts `const CONFIG = {...}` on top of this file).
// Plain JavaScript in a shadow root: no framework, and the page's own CSS cannot touch it.
//   add icon (or Ctrl+C) → drag an area → write the comment → it is a draft
//   board icon           → the kanban board: draft · sent · processing · done · archive, with Send and Archive
// The server's JSON file is the truth; a copy goes to localStorage and comes back only if the file was lost.
;(() => {
  if (window.__pageComments) return
  window.__pageComments = true

  const API = CONFIG.route
  const COLUMNS = ['draft', 'sent', 'processing', 'done', 'archive']
  // the moves a person may make by dragging; `processing` is Claude's (the same table as the server's)
  const MOVES = { draft: ['sent'], sent: ['draft'], done: ['archive', 'draft'], archive: ['done', 'draft'] }
  const TITLES = { draft: 'Draft', sent: 'Sent', processing: 'Processing', done: 'Done', archive: 'Archive' }
  // the copy is per project: another project served on the same port must never get these comments
  const LS = `ai-comments:v1:${CONFIG.project}`
  const LS_FOLD = `ai-comments:folded:${CONFIG.project}`

  /** @type {{comments: any[], agent: string, picking: boolean, board: boolean, open: string|null, sending: boolean, editing: string|null}} */
  const S = { comments: [], agent: 'idle', error: null, dragging: null, replying: null, allThread: new Set(), picking: false, board: false, open: null, sending: false, editing: null }
  let folded = new Set()
  try { folded = new Set(JSON.parse(localStorage.getItem(LS_FOLD) || '[]')) } catch { /* nothing remembered */ }
  try { S.comments = JSON.parse(localStorage.getItem(LS) || '[]') } catch { /* nothing remembered */ }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const route = () => location.pathname + location.search + location.hash
  const scroller = () => document.querySelector(CONFIG.scroller) || document.documentElement
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
    return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
  }

  // --- talking to the server ------------------------------------------------------------------------------------------------------------
  const call = async (method, p = '', body) => {
    const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || r.statusText)
    return j
  }
  const mirror = () => { try { localStorage.setItem(LS, JSON.stringify(S.comments)) } catch { /* private mode */ } }
  let restoring = false
  const apply = (snap) => {
    // the file is lost (not just emptied): bring the copy of localStorage back, and never overwrite the copy with "nothing"
    if (!snap.exists && S.comments.length) {
      if (!restoring) {
        restoring = true
        call('POST', '/restore', { comments: S.comments }).catch(() => {}).finally(() => (restoring = false))
      }
      return
    }
    S.comments = snap.comments
    S.agent = snap.agent
    S.error = snap.error
    mirror()
    renderAll()
  }
  const act = (p) => p.catch((e) => toast(e.message))

  // --- the shadow root ------------------------------------------------------------------------------------------------------------------
  const host = document.createElement('div')
  host.setAttribute('data-ai-comments', '')
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>${css()}</style><div id="frames"></div><div id="dock"></div><div id="board"></div><div id="pick"></div><div id="draft"></div><div id="toast"></div>`
  const $ = (id) => root.getElementById(id)
  document.body.appendChild(host)

  let toastTimer
  function toast(m) {
    $('toast').innerHTML = `<div class="toast">${esc(m)}</div>`
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => ($('toast').innerHTML = ''), 3500)
  }

  // --- the frames on the page -----------------------------------------------------------------------------------------------------------
  const base = () => {
    const sc = scroller()
    const r = sc === document.documentElement ? { left: 0, top: 0 } : sc.getBoundingClientRect()
    return { left: r.left, top: r.top, sl: sc.scrollLeft, st: sc.scrollTop }
  }
  function renderFrames() {
    if (S.replying && root.activeElement?.tagName === 'TEXTAREA') return // do not wipe a reply that is being typed in a popover
    const b = base()
    const here = S.comments.filter((c) => c.route === route() && c.status !== 'archive')
    $('frames').innerHTML = here.map((c, i) => {
      const left = b.left + c.rect.x - b.sl, top = b.top + c.rect.y - b.st
      if (top + c.rect.h < 0 || top > innerHeight || left + c.rect.w < 0 || left > innerWidth) return ''
      return `<div class="frame s-${c.status}" data-testid="comments-frame" style="left:${left}px;top:${top}px;width:${c.rect.w}px;height:${c.rect.h}px">
        <button class="num" data-act="open" data-testid="comments-num" data-id="${c.id}">${i + 1}</button>
        ${S.open === c.id ? `<div class="pop">${card(c, true)}</div>` : ''}</div>`
    }).join('')
  }

  // --- the dock: the add icon and the board icon ----------------------------------------------------------------------------------------
  function renderDock() {
    const live = S.comments.filter((c) => c.status !== 'archive').length
    const drafts = S.comments.filter((c) => c.status === 'draft').length
    $('dock').innerHTML = `<div class="dock">
      <button class="fab ${S.board ? 'on' : ''}" data-act="board" data-testid="comments-board" title="All comments">${I.board}<span>${live}</span>${S.agent === 'running' ? '<i class="pulse"></i>' : ''}</button>
      <button class="fab ${S.picking ? 'warn' : ''}" data-act="pick" data-testid="comments-add" title="Comment on an area of the page (Ctrl+C)">${S.picking ? I.x : I.add}${drafts ? `<span>${drafts}</span>` : ''}</button></div>`
  }

  // --- the board ------------------------------------------------------------------------------------------------------------------------
  const lastProgress = new Map()
  function renderBoard() {
    if (!S.board) { $('board').innerHTML = ''; return }
    if (S.dragging || ((S.editing || S.replying) && root.activeElement?.tagName === 'TEXTAREA')) return // do not wipe what is being dragged or typed; it renders at the end
    const by = (st) => S.comments.filter((c) => c.status === st)
    const drafts = by('draft').length, done = by('done').length
    const agent = S.agent === 'running' ? '<span class="agent on"><i class="pulse"></i>Claude is working</span>' : S.agent === 'external' ? '<span class="agent">sent comments wait for the agent outside the dev server (the watcher)</span>' : S.agent === 'off' ? '<span class="agent">no agent: sent comments wait for a session</span>' : '<span class="agent">Claude is idle</span>'
    $('board').innerHTML = `<div class="veil" data-act="close"></div><section class="board" role="dialog" aria-label="Comments" data-testid="comments-panel">
      <header><strong>Comments</strong>${agent}<span class="grow"></span>${S.error ? `<span class="agent err" title="${esc(S.error)}">${esc(S.error.slice(0, 90))}</span><button class="btn" data-act="retry">Retry</button>` : ''}
        <button class="btn primary" data-act="send" data-testid="comments-send" ${drafts ? '' : 'disabled'}>${I.send} Send ${drafts || ''}</button>
        <button class="btn" data-act="archive" data-testid="comments-archive" ${done ? '' : 'disabled'}>${I.archive} Archive ${done || ''}</button>
        <button class="ico" data-act="close" title="Close (Esc)">${I.x}</button></header>
      ${S.sending ? `<form class="sendbar" data-form="send"><label>Name of the batch <input name="batch" data-testid="comments-batch" required autofocus value="${esc(defaultBatch())}" maxlength="80" /></label>
        <button class="btn primary" type="submit">Send ${drafts}</button><button class="btn" type="button" data-act="cancel-send">Cancel</button></form>` : ''}
      <div class="cols">${COLUMNS.map((st) => `<div class="col" data-status="${st}"><h3 class="h-${st}">${TITLES[st]} <em>${by(st).length}</em></h3><div class="list">${column(st, by(st))}</div></div>`).join('')}</div></section>`
    // the bars grow from where they were: the progress is seen moving
    for (const bar of root.querySelectorAll('.bar i[data-id]')) {
      const id = bar.dataset.id, to = bar.dataset.to
      const from = lastProgress.get(id) ?? to
      bar.style.width = from + '%'
      requestAnimationFrame(() => requestAnimationFrame(() => (bar.style.width = to + '%')))
      lastProgress.set(id, to)
    }
    const ta = root.querySelector('textarea[data-edit]'); if (ta && root.activeElement !== ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) } // edit in place: ready to type
    const f = root.querySelector('[name=batch]'); if (f && !f.dataset.seen) { f.dataset.seen = '1'; f.focus(); f.select() }
  }
  const defaultBatch = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }

  function column(st, list) {
    if (!list.length) return '<p class="empty">—</p>'
    if (st === 'draft' || st === 'sent') return list.map((c) => card(c)).join('')
    // processing, done and archive: grouped by the name of the batch, a group folds
    const groups = new Map()
    for (const c of list) groups.set(c.batch || 'No batch', [...(groups.get(c.batch || 'No batch') || []), c])
    return [...groups.entries()]
      .sort((a, b) => Math.max(...b[1].map((c) => Date.parse(c.sentAt || c.createdAt))) - Math.max(...a[1].map((c) => Date.parse(c.sentAt || c.createdAt))))
      .map(([name, cs]) => {
        const key = `${st}:${name}`, shut = folded.has(key)
        return `<div class="group"><button class="gh" data-act="fold" data-key="${esc(key)}" aria-expanded="${!shut}">${shut ? I.right : I.down}<span>${esc(name)}</span><em>${cs.length}</em></button>${shut ? '' : cs.map((c) => card(c)).join('')}</div>`
      }).join('')
  }

  /** The conversation on a comment: the owner's words and Claude's answers. An old comment with only a `note` shows it as Claude's answer. */
  function thread(c, compact) {
    const msgs = c.thread?.length ? c.thread : c.note ? [{ who: 'claude', text: c.note, at: c.updatedAt }] : []
    if (!msgs.length) return ''
    const all = S.allThread.has(c.id) || compact || msgs.length <= 2
    const shown = all ? msgs : msgs.slice(-2)
    return `<div class="thread">${!all ? `<button class="more" data-act="thread-all" data-id="${c.id}">${msgs.length - 2} earlier</button>` : ''}${shown.map((m) => `<div class="msg ${m.who}"><b>${m.who === 'claude' ? 'Claude' : 'You'}</b><span>${esc(m.text)}</span></div>`).join('')}</div>`
  }

  function card(c, compact) {
    const editing = S.editing === c.id
    const canEdit = !compact && c.status !== 'processing'
    const canDrag = !compact && !!MOVES[c.status]
    return `<article class="card s-${c.status}" data-testid="comments-card" data-id="${c.id}" ${canDrag ? 'draggable="true"' : ''}>
      ${editing ? `<textarea data-edit="${c.id}">${esc(c.comment)}</textarea>` : `<p class="text ${canEdit ? 'editable' : ''}" ${canEdit ? `data-act="edit" data-id="${c.id}" title="Click to edit"` : ''}>${esc(c.comment)}</p>`}
      ${c.status === 'processing' ? `<div class="bar"><i data-id="${c.id}" data-to="${c.progress ?? 0}"></i><b>${c.progress ?? 0}%</b></div>${c.note ? `<p class="note">${esc(c.note)}</p>` : ''}` : thread(c, compact)}
      ${S.replying === c.id ? `<div class="reply"><textarea data-reply="${c.id}" placeholder="Reply (⌘↵ / Ctrl+↵ sends to Claude)"></textarea>
        <div class="row"><button class="btn" data-act="cancel-reply">Cancel</button><button class="btn" data-act="reply-only" data-id="${c.id}">Reply</button><button class="btn primary" data-act="reply-send" data-id="${c.id}">${I.send} Reply and send to Claude</button></div></div>` : ''}
      <footer><span>${esc(c.route)} · ${ago(c.updatedAt || c.createdAt)}</span><span class="acts">
        ${c.status === 'processing' ? '' : `<button class="ico" data-act="reply" data-id="${c.id}" title="Reply">${I.reply}</button>`}
        ${compact ? '' : `<button class="ico" data-act="goto" data-id="${c.id}" title="Show on the page">${I.locate}</button>`}
        <button class="ico" data-act="delete" data-id="${c.id}" title="Delete">${I.trash}</button></span></footer></article>`
  }

  // --- picking an area, writing the comment --------------------------------------------------------------------------------------------
  let drag = null, box = null
  function renderPick() {
    if (!S.picking || box) { $('pick').innerHTML = ''; return }
    const sel = drag && { l: Math.min(drag.x0, drag.x1), t: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }
    $('pick').innerHTML = `<div class="pick" data-pick data-testid="comments-pick">${sel ? `<div class="sel" style="left:${sel.l}px;top:${sel.t}px;width:${sel.w}px;height:${sel.h}px"></div>` : ''}</div>`
  }
  function renderDraft() {
    if (!box) { $('draft').innerHTML = ''; return }
    const keep = $('draft').querySelector('textarea')?.value ?? ''
    $('draft').innerHTML = `<div class="sel fixed" style="left:${box.left}px;top:${box.top}px;width:${box.right - box.left}px;height:${box.bottom - box.top}px"></div>
      <div class="drafter" style="left:${Math.min(box.left, innerWidth - 310)}px;top:${Math.min(box.bottom + 8, innerHeight - 160)}px">
        <textarea data-testid="comments-text" placeholder="What to change here? (⌘↵ / Ctrl+↵ saves a draft, +Shift takes it now)">${esc(keep)}</textarea>
        <div class="row"><button class="btn" data-act="cancel-draft">Cancel</button><button class="btn" data-act="save-draft" data-testid="comments-save">Save as draft</button><button class="btn primary" data-act="take-now" data-testid="comments-take" title="Send it to Claude now, without a batch">Take now</button></div></div>`
    $('draft').querySelector('textarea').focus()
  }
  function describe(el) {
    const cls = String(el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 70)
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}${text ? ` "${text}"` : ''}`
  }
  function under(r) {
    const seen = new Set()
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
      const x = r.left + ((r.right - r.left) * i) / 4, y = r.top + ((r.bottom - r.top) * j) / 4
      for (const el of document.elementsFromPoint(x, y)) {
        if (el === host || el === document.documentElement || el === document.body || el.id === 'root' || el.matches(CONFIG.scroller)) continue
        seen.add(el)
      }
    }
    return [...seen].slice(0, 14).map(describe)
  }
  async function saveDraft(now) {
    const text = $('draft').querySelector('textarea')?.value.trim()
    if (!text || !box) return
    const b = base(), r = box
    const body = { route: route(), rect: { x: r.left - b.left + b.sl, y: r.top - b.top + b.st, w: r.right - r.left, h: r.bottom - r.top }, viewport: { w: innerWidth, h: innerHeight }, comment: text, elements: under(r), send: !!now }
    box = null
    renderDraft()
    await act(call('POST', '', body))
  }

  // --- going to the place of a comment ------------------------------------------------------------------------------------------------
  const GOTO = 'ai-comments:goto'
  function reveal(id) {
    const c = S.comments.find((x) => x.id === id)
    if (!c) return
    S.open = id
    for (const ms of [0, 250, 700, 1500]) setTimeout(() => scroller().scrollTo({ left: Math.max(0, c.rect.x - 40), top: Math.max(0, c.rect.y - 120), behavior: ms ? 'auto' : 'smooth' }), ms)
    renderFrames()
  }
  function goTo(id) {
    const c = S.comments.find((x) => x.id === id)
    if (!c) return
    S.board = false
    if (c.route === route()) { reveal(id); renderAll(); return }
    try { sessionStorage.setItem(GOTO, id) } catch { /* the page then opens without the scroll */ }
    location.assign(c.route)
  }

  // --- events ---------------------------------------------------------------------------------------------------------------------------
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return
    const id = el.dataset.id || el.closest('[data-id]')?.dataset.id
    switch (el.dataset.act) {
      case 'board': S.board = !S.board; S.sending = false; break
      case 'close': S.board = false; S.sending = false; break
      case 'pick': S.picking = !S.picking; box = null; drag = null; break
      case 'open': S.open = S.open === id ? null : id; break
      case 'send': S.sending = true; break
      case 'cancel-send': S.sending = false; break
      case 'archive': act(call('POST', '/archive', {})); return
      case 'retry': act(call('POST', '/retry', {})); return
      case 'fold': folded.has(el.dataset.key) ? folded.delete(el.dataset.key) : folded.add(el.dataset.key); try { localStorage.setItem(LS_FOLD, JSON.stringify([...folded])) } catch { /* fine */ } break
      case 'edit': S.editing = id; break
      case 'reply': S.replying = S.replying === id ? null : id; break
      case 'cancel-reply': S.replying = null; break
      case 'thread-all': S.allThread.add(id); break
      case 'reply-only': case 'reply-send': { const ta = root.querySelector(`textarea[data-reply="${id}"]`); void sendReply(id, ta?.value, el.dataset.act === 'reply-send'); return }
      case 'delete': if (S.open === id) S.open = null; act(call('DELETE', '/' + id, {})); return
      case 'goto': goTo(id); return
      case 'save-draft': void saveDraft(false); return
      case 'take-now': void saveDraft(true); return
      case 'cancel-draft': box = null; renderDraft(); renderPick(); renderDock(); return
    }
    renderAll()
  })
  root.addEventListener('submit', (e) => {
    e.preventDefault()
    if (e.target.dataset.form !== 'send') return
    const batch = new FormData(e.target).get('batch')
    S.sending = false
    act(call('POST', '/send', { batch }))
    renderAll()
  })
  async function sendReply(id, text, resend) {
    text = (text || '').trim()
    if (!text) return toast('Write a reply first')
    S.replying = null
    renderAll()
    await act(call('POST', `/${id}/reply`, { text, resend }))
  }
  // leaving the text (or ⌘↵ / Ctrl+↵) saves it, if it changed
  function commitEdit(ta) {
    const id = ta.dataset.edit
    if (S.editing !== id) return // already saved
    const text = ta.value.trim()
    S.editing = null
    if (text && text !== S.comments.find((c) => c.id === id)?.comment) act(call('PATCH', '/' + id, { comment: text }))
    renderAll()
  }
  root.addEventListener('focusout', (e) => { if (e.target.dataset?.edit) commitEdit(e.target) })
  root.addEventListener('keydown', (e) => {
    if (e.target.dataset?.edit && e.key === 'Escape') { e.stopPropagation(); S.editing = null; renderAll() }
    if (e.target.dataset?.edit && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitEdit(e.target)
    if (e.target.closest?.('.drafter') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveDraft(e.shiftKey)
    if (e.target.dataset?.reply && e.key === 'Escape') { e.stopPropagation(); S.replying = null; renderAll() }
    if (e.target.dataset?.reply && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendReply(e.target.dataset.reply, e.target.value, true)
  })
  // dragging a card to another column
  const colOf = (e) => e.target.closest?.('.col[data-status]')
  root.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.card[draggable="true"]'); if (!card) return
    S.dragging = card.dataset.id
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', S.dragging)
    card.classList.add('dragging')
  })
  root.addEventListener('dragover', (e) => {
    const col = colOf(e); if (!col || !S.dragging) return
    const from = S.comments.find((c) => c.id === S.dragging)?.status
    if ((MOVES[from] || []).includes(col.dataset.status)) { e.preventDefault(); col.classList.add('over') }
  })
  root.addEventListener('dragleave', (e) => { const col = colOf(e); if (col && !col.contains(e.relatedTarget)) col.classList.remove('over') })
  root.addEventListener('drop', (e) => {
    const col = colOf(e), id = S.dragging; if (!col || !id) return
    e.preventDefault()
    const to = col.dataset.status
    S.dragging = null
    act(call('PATCH', '/' + id, { status: to })) // to Sent too: one comment needs no batch (Send, for all the drafts, asks for one)
    renderAll()
  })
  root.addEventListener('dragend', () => {
    // a drop on a column that does not take it: say why
    if (S.dragging) { const c = S.comments.find((x) => x.id === S.dragging); toast(c ? `A ${c.status} comment can go to: ${(MOVES[c.status] || []).join(', ') || 'nowhere'}` : 'Cannot move it'); S.dragging = null }
    renderAll()
  })
  // dragging the area
  root.addEventListener('mousedown', (e) => { if (e.target.closest('[data-pick]')) { drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY }; renderPick() } })
  root.addEventListener('mousemove', (e) => { if (drag) { drag.x1 = e.clientX; drag.y1 = e.clientY; renderPick() } })
  root.addEventListener('mouseup', () => {
    if (!drag) return
    const l = Math.min(drag.x0, drag.x1), t = Math.min(drag.y0, drag.y1), w = Math.abs(drag.x1 - drag.x0), h = Math.abs(drag.y1 - drag.y0)
    drag = null; S.picking = false
    if (w > 6 && h > 6) box = { left: l, top: t, right: l + w, bottom: t + h }
    renderAll()
  })
  window.addEventListener('keydown', (e) => {
    const t = e.composedPath()[0]
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    if (e.key === 'Escape') {
      if (box) box = null
      else if (S.picking) { S.picking = false; drag = null }
      else if (S.sending) S.sending = false
      else if (S.board) S.board = false
      else S.open = null
      renderAll(); return
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'c' && !typing && !window.getSelection()?.toString()) { e.preventDefault(); box = null; S.picking = true; renderAll() }
  })
  let raf = 0
  const relayout = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderFrames) }
  window.addEventListener('scroll', relayout, true)
  window.addEventListener('resize', relayout)
  let at = route()
  setInterval(() => { if (route() !== at) { at = route(); renderFrames() } else if (S.board || S.open) { /* the "n min ago" */ } }, 500)

  function renderAll() {
    renderFrames(); renderDock(); renderBoard(); renderPick(); if (box && !$('draft').firstChild) renderDraft()
    const ta = S.replying && root.querySelector(`textarea[data-reply="${S.replying}"]`)
    if (ta && root.activeElement !== ta) ta.focus() // a reply was just opened (in the board or in a popover on the page)
  }

  // --- look ---------------------------------------------------------------------------------------------------------------------------
  const svg = (d) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
  const I = {
    add: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6M9 10h6"/>'),
    board: svg('<rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="11" rx="1"/><rect x="17" y="3" width="4" height="15" rx="1"/>'),
    x: svg('<path d="M18 6 6 18M6 6l12 12"/>'), trash: svg('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>'),
    reply: svg('<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>'),
    locate: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
    pencil: svg('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'), send: svg('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
    archive: svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>'),
    down: svg('<path d="m6 9 6 6 6-6"/>'), right: svg('<path d="m9 6 6 6-6 6"/>'),
  }
  function css() {
    return `
:host{all:initial}*{box-sizing:border-box}
:host,#frames,#dock,#board,#pick,#draft,#toast{--bg:#fff;--fg:#18181b;--mut:#71717a;--line:#e4e4e7;--soft:#f4f4f5;--pri:#18181b;--onpri:#fff;--draft:#a1a1aa;--sent:#3b82f6;--proc:#f59e0b;--done:#10b981;--arch:#71717a;font:13px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--fg)}
@media (prefers-color-scheme:dark){:host,#frames,#dock,#board,#pick,#draft,#toast{--bg:#1c1c1f;--fg:#f4f4f5;--mut:#a1a1aa;--line:#3f3f46;--soft:#27272a;--pri:#f4f4f5;--onpri:#18181b}}
button{font:inherit;color:inherit;cursor:pointer}button:disabled{opacity:.4;cursor:default}
.frame{position:fixed;z-index:2147483000;pointer-events:none;border:1px dashed var(--c,var(--draft));border-radius:3px}
.frame.s-draft{--c:var(--draft)}.frame.s-sent{--c:var(--sent)}.frame.s-processing{--c:var(--proc)}.frame.s-done{--c:var(--done)}
.num{pointer-events:auto;position:absolute;left:-9px;top:-9px;width:20px;height:20px;border-radius:50%;border:0;background:var(--c);color:#fff;font-size:10px;font-weight:600}
.pop{pointer-events:auto;position:absolute;left:14px;top:14px;width:280px;z-index:2}
.dock{position:fixed;right:16px;bottom:16px;z-index:2147483200;display:flex;gap:8px}
.fab{position:relative;display:flex;align-items:center;gap:6px;height:34px;padding:0 12px;border-radius:17px;border:1px solid var(--line);background:var(--bg);box-shadow:0 2px 8px #0003}
.fab.on{background:var(--pri);color:var(--onpri)}.fab.warn{background:#d97706;color:#fff;border-color:#d97706}
.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--proc);animation:p 1.2s ease-in-out infinite}.fab .pulse{position:absolute;right:-2px;top:-2px}
@keyframes p{50%{opacity:.25}}
.veil{position:fixed;inset:0;z-index:2147483100;background:#0006}
.board{position:fixed;inset:16px 16px 60px;z-index:2147483150;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 40px #0005}
.board header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line)}
.grow{flex:1}.agent{display:flex;align-items:center;gap:6px;color:var(--mut);font-size:12px}.agent.on{color:var(--fg)}.agent.err{color:#dc2626;max-width:46ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg)}
.btn.primary{background:var(--pri);color:var(--onpri);border-color:var(--pri)}
.ico{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid var(--line);border-radius:5px;background:var(--bg)}
.sendbar{display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--soft);border-bottom:1px solid var(--line)}
.sendbar label{display:flex;align-items:center;gap:8px;flex:1}.sendbar input{flex:1;height:28px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
.cols{flex:1;min-height:0;display:grid;grid-template-columns:repeat(5,minmax(170px,1fr));gap:10px;padding:12px;overflow-x:auto}
.col{display:flex;flex-direction:column;min-height:0;background:var(--soft);border-radius:8px}
.col h3{margin:0;padding:8px 10px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;border-top:3px solid var(--c);border-radius:8px 8px 0 0}
.col h3 em{font-style:normal;color:var(--mut);margin-left:4px}
.h-draft{--c:var(--draft)}.h-sent{--c:var(--sent)}.h-processing{--c:var(--proc)}.h-done{--c:var(--done)}.h-archive{--c:var(--arch)}
.list{flex:1;min-height:0;overflow-y:auto;padding:0 8px 8px;display:flex;flex-direction:column;gap:8px}
.empty{color:var(--mut);text-align:center;margin:12px 0}
.group{display:flex;flex-direction:column;gap:6px}.gh{display:flex;align-items:center;gap:6px;border:0;background:none;padding:4px 2px;font-weight:600;text-align:left}
.gh span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gh em{font-style:normal;color:var(--mut);font-weight:400}
.card{background:var(--bg);border:1px solid var(--line);border-left:3px solid var(--c,var(--draft));border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.card[draggable=true]{cursor:grab}.card.dragging{opacity:.4}.col.over{outline:2px dashed var(--sent);outline-offset:-2px}
.thread{display:flex;flex-direction:column;gap:4px}.msg{display:flex;flex-direction:column;padding:4px 8px;border-radius:6px;font-size:12px;white-space:pre-wrap}.msg b{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut)}
.msg.claude{background:var(--soft)}.msg.user{background:#3b82f61a;align-self:flex-end;max-width:92%}.more{border:0;background:none;color:var(--mut);text-align:left;padding:0;font-size:11px;text-decoration:underline}
.reply{display:flex;flex-direction:column;gap:6px}.reply .row{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}
.text.editable{cursor:text;border-radius:3px}.text.editable:hover{background:var(--soft)}
.card.s-draft{--c:var(--draft)}.card.s-sent{--c:var(--sent)}.card.s-processing{--c:var(--proc)}.card.s-done{--c:var(--done)}.card.s-archive{--c:var(--arch)}
.text{margin:0;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}.pop .text{-webkit-line-clamp:none}
.note{margin:0;color:var(--mut);font-size:12px;white-space:pre-wrap}
.card footer{display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--mut);font-size:11px}
.card footer>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.acts{display:flex;gap:4px}
.bar{position:relative;height:16px;border-radius:8px;background:var(--soft);overflow:hidden;border:1px solid var(--line)}
.bar i{position:absolute;left:0;top:0;bottom:0;background:var(--proc);transition:width .6s ease}
.bar b{position:relative;display:block;text-align:center;font-size:11px;line-height:14px;color:var(--fg)}
textarea{width:100%;min-height:64px;resize:vertical;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
.pick{position:fixed;inset:0;z-index:2147483100;cursor:crosshair;background:#0000000d}
.sel{position:fixed;border:2px solid #d97706;background:#d9770619;border-radius:3px;pointer-events:none}.sel.fixed{z-index:2147483100}
.drafter{position:fixed;z-index:2147483200;width:300px;padding:8px;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 24px #0004}
.drafter .row{display:flex;justify-content:flex-end;gap:6px;margin-top:6px}
.toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483300;background:var(--pri);color:var(--onpri);padding:6px 12px;border-radius:6px}`
  }

  // --- start ---------------------------------------------------------------------------------------------------------------------------
  renderAll()
  fetch(API, { cache: 'no-store' }).then((r) => r.json()).then((snap) => {
    apply(snap)
    let id = null
    try { id = sessionStorage.getItem(GOTO); sessionStorage.removeItem(GOTO) } catch { /* nothing */ }
    if (id) reveal(id)
  }).catch(() => {})
  const es = new EventSource(API + '/events')
  es.onmessage = (m) => apply(JSON.parse(m.data))

})()
