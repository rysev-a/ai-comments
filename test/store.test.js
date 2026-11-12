import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as s from '../src/store.js'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-')), 'sub', 'comments.json')
const input = (comment) => ({ route: '/a', rect: { x: 1, y: 2, w: 3, h: 4 }, viewport: { w: 10, h: 10 }, comment, elements: ['div'] })

test('a missing file is an empty state that says it does not exist', () => {
  const r = s.read(tmp())
  assert.deepEqual(r, { state: s.emptyState(), exists: false })
})

test('the life of a comment: draft → sent → processing → done → archive', () => {
  const f = tmp()
  const id = s.mutate(f, (st) => s.add(st, input('make it bigger'))).id
  assert.equal(s.read(f).state.comments[0].status, 'draft')

  assert.throws(() => s.mutate(f, (st) => s.send(st, '  ')), /name/)
  s.mutate(f, (st) => s.send(st, 'round 1'))
  let c = s.read(f).state.comments[0]
  assert.deepEqual([c.status, c.batch], ['sent', 'round 1'])

  assert.throws(() => s.mutate(f, (st) => s.progress(st, id, 10)), /not processing/)
  s.mutate(f, (st) => s.take(st))
  c = s.read(f).state.comments[0]
  assert.deepEqual([c.status, c.progress], ['processing', 0])

  s.mutate(f, (st) => s.progress(st, id, 55, 'working'))
  s.mutate(f, (st) => s.progress(st, id, 100)) // 100 is only reached by `done`
  c = s.read(f).state.comments[0]
  assert.deepEqual([c.progress, c.note], [99, 'working'])

  s.mutate(f, (st) => s.finish(st, id, 'changed x'))
  c = s.read(f).state.comments[0]
  assert.deepEqual([c.status, c.progress, c.note], ['done', 100, 'changed x'])

  s.mutate(f, (st) => s.archiveDone(st))
  assert.equal(s.read(f).state.comments[0].status, 'archive')
})

test('send takes only drafts; archive only done; take only sent', () => {
  const f = tmp()
  s.mutate(f, (st) => { s.add(st, input('one')); s.add(st, input('two')) })
  s.mutate(f, (st) => s.send(st, 'b'))
  s.mutate(f, (st) => s.add(st, input('three')))
  assert.deepEqual(s.read(f).state.comments.map((c) => c.status), ['sent', 'sent', 'draft'])
  const taken = s.mutate(f, (st) => s.take(st))
  assert.equal(taken.length, 2)
  assert.equal(s.mutate(f, (st) => s.archiveDone(st)).length, 0)
})

test('an agent that stops releases what it did not finish, back to draft', () => {
  const f = tmp()
  s.mutate(f, (st) => s.add(st, input('x')))
  s.mutate(f, (st) => s.send(st, 'b'))
  s.mutate(f, (st) => s.take(st))
  s.mutate(f, (st) => s.release(st, 'stopped'))
  const c = s.read(f).state.comments[0]
  assert.deepEqual([c.status, c.note, c.progress], ['draft', 'stopped', undefined])
})

test('an empty comment is refused; edit and remove work', () => {
  const f = tmp()
  assert.throws(() => s.mutate(f, (st) => s.add(st, input('  '))), /empty/)
  const id = s.mutate(f, (st) => s.add(st, input('a'))).id
  s.mutate(f, (st) => s.edit(st, id, 'b'))
  assert.equal(s.read(f).state.comments[0].comment, 'b')
  s.mutate(f, (st) => s.remove(st, id))
  assert.equal(s.read(f).state.comments.length, 0)
})

test('many processes changing the file at once lose nothing', async () => {
  const f = tmp()
  const { spawn } = await import('node:child_process')
  const code = `import * as s from ${JSON.stringify(path.resolve('src/store.js'))}; for (let i=0;i<20;i++) s.mutate(${JSON.stringify(f)}, st => s.add(st, ${JSON.stringify(input('x'))}))`
  await Promise.all([1, 2, 3, 4].map(() => new Promise((res, rej) => spawn('node', ['--input-type=module', '-e', code]).on('exit', (c) => (c ? rej(new Error('exit ' + c)) : res())))))
  assert.equal(s.read(f).state.comments.length, 80)
})

test('moving by hand: only the allowed moves; sent needs a batch; processing is Claude\'s', () => {
  const f = tmp()
  const id = s.mutate(f, (st) => s.add(st, input('x'))).id
  const status = () => s.read(f).state.comments[0].status
  assert.throws(() => s.mutate(f, (st) => s.move(st, id, 'done')), /cannot go from draft to done/)
  s.mutate(f, (st) => s.move(st, id, 'sent')) // one comment needs no batch
  assert.deepEqual([status(), s.read(f).state.comments[0].batch], ['sent', undefined])
  s.mutate(f, (st) => s.move(st, id, 'draft'))
  s.mutate(f, (st) => s.move(st, id, 'sent', 'b1'))
  assert.deepEqual([status(), s.read(f).state.comments[0].batch], ['sent', 'b1'])
  s.mutate(f, (st) => s.move(st, id, 'draft')) // withdraw it
  assert.deepEqual([status(), s.read(f).state.comments[0].batch], ['draft', undefined])
  s.mutate(f, (st) => s.send(st, 'b2')); s.mutate(f, (st) => s.take(st))
  assert.throws(() => s.mutate(f, (st) => s.move(st, id, 'draft')), /cannot go from processing/)
  assert.throws(() => s.mutate(f, (st) => s.edit(st, id, 'new text')), /working on/)
  s.mutate(f, (st) => s.finish(st, id, 'ok'))
  s.mutate(f, (st) => s.move(st, id, 'archive'))
  s.mutate(f, (st) => s.move(st, id, 'done'))
  s.mutate(f, (st) => s.move(st, id, 'draft')) // rework: back to a draft, to be edited and sent again
  assert.equal(status(), 'draft')
  s.mutate(f, (st) => s.edit(st, id, 'changed text'))
  assert.equal(s.read(f).state.comments[0].comment, 'changed text')
})

test('releasing is only for what that agent run was started for', () => {
  const f = tmp()
  const [a, b] = s.mutate(f, (st) => [s.add(st, input('a')).id, s.add(st, input('b')).id])
  s.mutate(f, (st) => s.send(st, 'x')); s.mutate(f, (st) => s.take(st))
  s.mutate(f, (st) => s.release(st, 'stopped', new Set([a]))) // another session works on b
  assert.deepEqual(s.read(f).state.comments.map((c) => c.status), ['draft', 'processing'])
})

test('a thread: Claude answers with done, the owner replies and sends it again, \"take now\" skips the draft', () => {
  const f = tmp()
  const id = s.mutate(f, (st) => s.add(st, { ...input('make it blue'), send: true })).id
  let c = s.read(f).state.comments[0]
  assert.deepEqual([c.status, c.batch], ['sent', undefined]) // take now: sent at once, no batch
  s.mutate(f, (st) => s.take(st))
  assert.throws(() => s.mutate(f, (st) => s.reply(st, id, 'user', 'wait')), /working on/)
  s.mutate(f, (st) => s.finish(st, id, 'Which blue?'))
  c = s.read(f).state.comments[0]
  assert.deepEqual(c.thread.map((m) => [m.who, m.text]), [['claude', 'Which blue?']])
  s.mutate(f, (st) => s.reply(st, id, 'user', 'the sky one')) // a reply alone does not send it
  assert.equal(s.read(f).state.comments[0].status, 'done')
  s.mutate(f, (st) => s.reply(st, id, 'user', 'sky blue, please', true)) // reply and send to Claude
  c = s.read(f).state.comments[0]
  assert.deepEqual([c.status, c.thread.length, c.note], ['sent', 3, undefined])
  assert.throws(() => s.mutate(f, (st) => s.reply(st, id, 'user', '  ')), /empty/)
})
