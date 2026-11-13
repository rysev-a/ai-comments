import type { Plugin } from 'vite'

export interface AgentOptions {
  /** the command that works off the comments; default `claude` */
  command?: string
  /** passed as `--model` to the default arguments */
  model?: string
  /** the instructions Claude is started with */
  prompt?: (ctx: { cli: string; file: string; root: string }) => string
  /** the whole argument list, when the default (`-p <prompt> --permission-mode acceptEdits --allowedTools …`) does not fit */
  args?: (ctx: { prompt: string; cli: string; file: string; root: string }) => string[]
  env?: Record<string, string>
}

export interface Options {
  /** default `.ai-comments/comments.json` */
  file?: string
  /** the API route; default `/__ai-comments` */
  route?: string
  /** the element that scrolls the page, as a selector; default `main` (falls back to the document) */
  scroller?: string
  /** `false`: no agent, the board is only a list; `'external'`: an agent outside this process (the Zed panel, claude on the server) works the sent comments */
  agent?: false | 'external' | AgentOptions
}

export function defaultPrompt(ctx: { cli: string; root: string }): string
export function pageComments(options?: Options): Plugin
export default pageComments
