import { defineConfig } from 'vite'
import path from 'node:path'
import pageComments from '../../src/plugin.js'

// FAKE_AGENT=1 npm run demo  → a stand-in for Claude that only moves the progress (no files are touched)
const fake = process.env.FAKE_AGENT
  ? { command: 'node', args: () => [path.resolve(import.meta.dirname, '../../test/fake-agent.mjs')], env: { FAKE_AGENT: 'ok', FAKE_AGENT_LOG: '/dev/null', FAKE_AGENT_SLOW: '15' } }
  : {}

export default defineConfig({ plugins: [pageComments({ agent: fake })], server: { port: 5199 } })
