// A stand-in for `claude -p` in the tests: it does what the prompt tells Claude to do, with the CLI.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/cli.mjs')
const run = (...a) => JSON.parse(execFileSync('node', [cli, ...a], { encoding: 'utf8', env: process.env }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * (Number(process.env.FAKE_AGENT_SLOW) || 1))) // Claude is slower than the page refresh
const mode = process.env.FAKE_AGENT || 'ok'
fs.appendFileSync(process.env.FAKE_AGENT_LOG, 'run\n')
if (mode === 'idle') process.exit(1) // starts and takes nothing
for (const c of run('take')) {
  await sleep(150)
  run('progress', c.id, '40', 'step 2 of 5')
  await sleep(150)
  if (mode === 'crash') process.exit(1) // dies with the comment still processing
  run('progress', c.id, '80', 'step 4 of 5')
  await sleep(150)
  run('done', c.id, 'changed the thing')
}
