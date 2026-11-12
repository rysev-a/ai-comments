import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { pageComments } from '../src/plugin.js'
import * as s from '../src/store.js'

const here = path.dirname(new URL(import.meta.url).pathname)
const wait = async (f, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 40)) }
  throw new Error('timeout')
}

async function start(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body><main>hi</main></body></html>')
  const log = path.join(root, 'agent-runs.txt')
  const server = await createServer({
    root, logLevel: 'silent', server: { port: 0, host: '127.0.0.1' },
    plugins: [pageComments({ agent: { command: 'node', args: () => [path.join(here, 'fake-agent.mjs')], env: { FAKE_AGENT: mode, FAKE_AGENT_LOG: log } } })],
  })
  await server.listen()
  const url = `http://127.0.0.1:${server.config.server.port ?? server.httpServer.address().port}`
  const file = path.join(root, '.page-comments/comments.json')
  const api = (method, p = '', body, h = {}) => fetch(url + '/__page-comments' + p, { method, headers: { 'content-type': 'application/json', ...h }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
  const add = (comment) => api('POST', '', { route: '/', rect: { x: 0, y: 0, w: 5, h: 5 }, viewport: { w: 9, h: 9 }, comment, elements: [] })
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0)
  return { server, url, file, api, add, runs }
}

test('send → the listener starts the agent → processing with progress → done → archive', async () => {
  const t = await start('ok')
  try {
    await t.add('one'); await t.add('two')
    assert.equal(t.runs(), 0, 'drafts do not start the agent')
    assert.equal((await t.api('POST', '/send', { batch: '' })).status, 400)
    assert.equal((await t.api('POST', '/send', { batch: 'round 1' })).status, 200)
    await wait(() => s.read(t.file).state.comments.every((c) => c.status === 'done'))
    const cs = s.read(t.file).state.comments
    assert.deepEqual(cs.map((c) => [c.batch, c.progress, c.note]), [['round 1', 100, 'changed the thing'], ['round 1', 100, 'changed the thing']])
    assert.equal(t.runs(), 1)
    await t.api('POST', '/archive', {})
    assert.deepEqual(s.read(t.file).state.comments.map((c) => c.status), ['archive', 'archive'])
  } finally { await t.server.close() }
})

test('the page is told of every change live (server-sent events)', async () => {
  const t = await start('ok')
  try {
    const res = await fetch(t.url + '/__page-comments/events')
    const reader = res.body.getReader()
    const seen = []
    ;(async () => { const dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) return; for (const m of dec.decode(value).split('\n\n')) if (m.startsWith('data: ')) seen.push(JSON.parse(m.slice(6))) } })()
    await t.add('one'); await t.api('POST', '/send', { batch: 'b' })
    await wait(() => seen.some((x) => x.comments[0]?.status === 'processing' && x.comments[0].progress === 40))
    await wait(() => seen.some((x) => x.comments[0]?.status === 'done'))
    assert.ok(seen.some((x) => x.agent === 'running'))
    await reader.cancel()
  } finally { await t.server.close() }
})

test('an agent that stops mid-way: the unfinished comment goes back to draft', async () => {
  const t = await start('crash')
  try {
    await t.add('one'); await t.api('POST', '/send', { batch: 'b' })
    await wait(() => s.read(t.file).state.comments[0].status === 'draft' && s.read(t.file).state.comments[0].note)
    assert.match(s.read(t.file).state.comments[0].note, /stopped before it finished/)
    assert.equal(t.runs(), 1, 'and it is not started again by itself')
  } finally { await t.server.close() }
})

test('an agent that takes nothing is not started again in a loop', async () => {
  const t = await start('idle')
  try {
    await t.add('one'); await t.api('POST', '/send', { batch: 'b' })
    await wait(() => t.runs() === 1)
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(t.runs(), 1)
    assert.equal(s.read(t.file).state.comments[0].status, 'sent')
    // the board is told why, and Retry starts it again
    const snap = (await t.api('GET')).json
    assert.match(snap.error, /usage limit/)
    await t.api('POST', '/retry', {})
    await wait(() => t.runs() === 2)
  } finally { await t.server.close() }
})

test('comments sent before the server started are taken when it starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<main>hi</main>')
  const file = path.join(root, '.page-comments/comments.json')
  s.mutate(file, (st) => { s.add(st, { route: '/', rect: { x: 0, y: 0, w: 5, h: 5 }, viewport: { w: 1, h: 1 }, comment: 'old' }); s.send(st, 'early') })
  const log = path.join(root, 'runs.txt')
  const server = await createServer({ root, logLevel: 'silent', server: { port: 0, host: '127.0.0.1' }, plugins: [pageComments({ agent: { command: 'node', args: () => [path.join(here, 'fake-agent.mjs')], env: { FAKE_AGENT: 'ok', FAKE_AGENT_LOG: log } } })] })
  try {
    await server.listen()
    await wait(() => s.read(file).state.comments[0].status === 'done')
  } finally { await server.close() }
})

test('only the page of this server may change comments; a lost file comes back from the copy of the page', async () => {
  const t = await start('ok')
  try {
    assert.equal((await fetch(t.url + '/__page-comments', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415)
    assert.equal((await t.api('POST', '', {}, { origin: 'http://evil.example' })).status, 403)
    const html = await (await fetch(t.url + '/')).text()
    assert.match(html, /__page-comments\/client\.js/)
    const js = await (await fetch(t.url + '/__page-comments/client.js')).text()
    assert.match(js, /^const CONFIG = /)

    const keep = { id: 'abc', status: 'done', route: '/', rect: { x: 0, y: 0, w: 1, h: 1 }, comment: 'kept', createdAt: 'x', updatedAt: 'x' }
    assert.equal((await t.api('GET')).json.exists, false)
    assert.equal((await t.api('POST', '/restore', { comments: [keep] })).json.restored, 1)
    assert.equal(s.read(t.file).state.comments[0].comment, 'kept')
    assert.equal((await t.api('POST', '/restore', { comments: [] })).status, 400, 'never over a file that exists')
  } finally { await t.server.close() }
})
