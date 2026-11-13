#!/usr/bin/env node
// What Claude calls. Every command prints JSON and changes the same file the page shows, so the board updates live.
//   ai-comments list [status]        the comments (of one status)
//   ai-comments take                 `sent` → `processing`; prints what was taken
//   ai-comments progress <id> <0-100> [note]
//   ai-comments done <id> [note]
//   ai-comments watch                prints one line each time comments are sent (for a session that works them off: Monitor)
// The file: $AI_COMMENTS_FILE, or ./.ai-comments/comments.json
import path from 'node:path'
import * as store from '../src/store.js'

const file = path.resolve(process.env.AI_COMMENTS_FILE || '.ai-comments/comments.json')
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
  else if (cmd === 'watch') {
    const seen = new Set()
    for (;;) {
      const sent = store.read(file).state.comments.filter((c) => c.status === 'sent')
      const fresh = sent.filter((c) => !seen.has(c.id))
      for (const c of sent) seen.add(c.id)
      if (fresh.length) console.log(`${fresh.length} comment(s) sent${fresh[0].batch ? ` (batch: ${fresh[0].batch})` : ''}: run \`node ${new URL(import.meta.url).pathname} take\``)
      await new Promise((r) => setTimeout(r, 1000))
    }
  } else fail('usage: ai-comments list [status] | take | watch | progress <id> <0-100> [note] | done <id> [note]')
} catch (e) {
  fail(e.message)
}
