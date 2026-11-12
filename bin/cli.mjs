#!/usr/bin/env node
// What Claude calls. Every command prints JSON and changes the same file the page shows, so the board updates live.
//   page-comments list [status]        the comments (of one status)
//   page-comments take                 `sent` → `processing`; prints what was taken
//   page-comments progress <id> <0-100> [note]
//   page-comments done <id> [note]
// The file: $PAGE_COMMENTS_FILE, or ./.page-comments/comments.json
import path from 'node:path'
import * as store from '../src/store.js'

const file = path.resolve(process.env.PAGE_COMMENTS_FILE || '.page-comments/comments.json')
const [cmd, ...a] = process.argv.slice(2)
const out = (x) => console.log(JSON.stringify(x, null, 2))
const fail = (m) => {
  console.error(m)
  process.exit(1)
}

try {
  if (cmd === 'list') out(store.read(file).state.comments.filter((c) => !a[0] || c.status === a[0]))
  else if (cmd === 'take') out(store.mutate(file, (s) => store.take(s)))
  else if (cmd === 'progress' && a[0] && a[1] !== undefined) out(store.mutate(file, (s) => store.progress(s, a[0], a[1], a[2])))
  else if (cmd === 'done' && a[0]) out(store.mutate(file, (s) => store.finish(s, a[0], a[1])))
  else fail('usage: page-comments list [status] | take | progress <id> <0-100> [note] | done <id> [note]')
} catch (e) {
  fail(e.message)
}
