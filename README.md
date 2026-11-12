# claude-page-comments

Review comments on a web page, worked off by Claude. A tiny Vite plugin, **dev server only**.

You select an area of a page and write what to change. When you send the comments, the dev server starts Claude, which
takes them, changes the code, and reports its progress back to the same page, live.

```
page ── add comment ──▶ draft ──▶ Send (batch name) ──▶ sent ──▶ Claude takes it ──▶ processing 40 % ──▶ done ──▶ Archive ──▶ archive
```

## Use

```bash
npm i -D github:rysev-a/claude-page-comments
```

```js
// vite.config.js
import pageComments from 'claude-page-comments'

export default { plugins: [pageComments()] }
```

Add `.page-comments` to `.gitignore`. Nothing else: the plugin injects the UI into every page of the dev server.

## On the page

Two round buttons at the bottom right:

- **add** (or `Ctrl+C`): drag an area of the page, write the comment, `⌘↵` / `Ctrl+↵` saves it as a **draft**. A comment is a dashed
  frame with a number on its page; the number opens its card.
- **board**: every comment as a card on a kanban board, one column per status.

| Status | Meaning |
| --- | --- |
| `draft` | written, not sent yet |
| `sent` | sent to Claude, waiting to be taken |
| `processing` | Claude took it; the card shows a percentage that moves live |
| `done` | finished, with Claude's note on what changed |
| `archive` | filed away |

Two controls on the board:

- **Send**: asks for the **name of the batch**, then every draft becomes `sent`.
- **Archive**: every `done` comment goes to `archive`.

`processing`, `done` and `archive` are grouped by batch name; a group folds and unfolds (remembered).

On a card: a click on its **text** edits it in place (`⌘↵` / blur saves, `Esc` cancels; not while Claude works on it); the
**locate** icon goes to its page, scrolls to the frame and opens it. **Drag** a card to another column:

| From | To |
| --- | --- |
| draft | sent (asks for the batch name, like Send) |
| sent | draft (withdraw it) |
| done | archive, draft (rework it) |
| archive | done, draft |

`processing` is Claude's: nothing is dragged into or out of it.

## How Claude is started

On server start the plugin watches `.page-comments/comments.json`. When comments are `sent` and no agent runs, it starts

```
claude -p "<instructions>" --permission-mode acceptEdits --allowedTools "Bash(node <this package>/bin/cli.mjs:*)"
```

in the project root. Claude works with the small CLI of this package (every command changes the same file, so the board updates
live):

```
page-comments take                          sent → processing
page-comments progress <id> <0-100> [note]  Claude's own plan steps: finished steps / all steps
page-comments done <id> [note]              processing → done
```

- One agent at a time; when it stops, comments that are still `sent` are started again only after something new is sent.
- If the agent stops with comments still `processing`, they go back to `draft` with a note, so you decide.
- The agent's output is in `.page-comments/agent.log`.

## Where the data is

- `.page-comments/comments.json`: the truth. You can read it, and the plugin picks up edits.
- `localStorage` of the page: a copy, per project. It is used only when the file is **lost**: the page puts the copy back.

## Options

```js
pageComments({
  file: '.page-comments/comments.json',
  scroller: 'main',              // the element that scrolls your page; comments are placed inside it (falls back to the document)
  agent: {                       // or `false`: no agent, the board is only a list
    command: 'claude',
    model: 'sonnet',             // optional
    prompt: ({ cli, file, root }) => '…',
    args: ({ prompt, cli }) => ['-p', prompt, /* … */],
    env: {},
  },
})
```

## Safety

The API accepts changes only as `application/json` from a page of the same server, so a page on another site cannot add or send
comments. `claude -p` runs with `acceptEdits` and may call only this package's CLI in the shell: change `args` if your agent needs more.
The comment text goes into the agent's context, so treat the comments file like input you wrote yourself.

## Develop

```bash
npm test                 # the store, and the plugin with a stand-in for Claude
FAKE_AGENT=1 npm run demo   # http://localhost:5199 with a fake agent that only moves the progress
npm run demo             # the same with real Claude
```
