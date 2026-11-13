# ai-comments

Review comments on a web page, worked off by Claude — or by an agent outside the dev server. A tiny Vite plugin, **dev server only**.

You select an area of a page and write what to change. When you send the comments, an agent takes them, changes the code, and
reports its progress back to the same page, live.

```
page ── add comment ──▶ draft ──▶ Send (batch name) ──▶ sent ──▶ the agent takes it ──▶ processing 40 % ──▶ done ──▶ Archive ──▶ archive
```

## Use

```bash
npm i -D github:rysev-a/ai-comments
```

```js
// vite.config.js
import aiComments from "ai-comments";

export default { plugins: [aiComments()] };
```

Add `.ai-comments` to `.gitignore`. Nothing else: the plugin injects the UI into every page of the dev server.

## On the page

Two round buttons at the bottom right:

- **add** (or `Ctrl+C`): drag an area of the page, write the comment, then **Save as draft** (`⌘↵` / `Ctrl+↵`) or **Take now**
  (`⇧⌘↵`): it goes to Claude at once, with no batch. A comment is a dashed frame with a number on its page; the number opens its card.
- **board**: every comment as a card on a kanban board, one column per status.

| Status       | Meaning                                                     |
| ------------ | ----------------------------------------------------------- |
| `draft`      | written, not sent yet                                       |
| `sent`       | sent to Claude, waiting to be taken                         |
| `processing` | Claude took it; the card shows a percentage that moves live |
| `done`       | finished, with Claude's note on what changed                |
| `archive`    | filed away                                                  |

Two controls on the board:

- **Send**: asks for the **name of the batch**, then every draft becomes `sent`.
- **Archive**: every `done` comment goes to `archive`.

`processing`, `done` and `archive` are grouped by batch name; a group folds and unfolds (remembered).

On a card: a click on its **text** edits it in place (`⌘↵` / blur saves, `Esc` cancels; not while Claude works on it); the
**locate** icon goes to its page, scrolls to the frame and opens it. **Drag** a card to another column:

| From    | To                                 |
| ------- | ---------------------------------- |
| draft   | sent (one comment: no batch asked) |
| sent    | draft (withdraw it)                |
| done    | archive, draft (rework it)         |
| archive | done, draft                        |

`processing` is Claude's: nothing is dragged into or out of it.

### Threads

Claude's note on `done` is its **reply** on the card, and a card keeps the whole conversation. The **reply** icon opens a box:
**Reply** only adds your message; **Reply and send to Claude** (`⌘↵` / `Ctrl+↵`) adds it and puts the comment back to `sent`, so Claude
takes it again and reads the thread. Claude may end with a question; answer it the same way.

## How the agent works

Two ways to work a batch off:

- **`claude` here (default).** On server start the plugin watches `.ai-comments/comments.json`. When comments are `sent` and no
  agent runs, it starts

  ```
  claude -p "<instructions>" --permission-mode acceptEdits --allowedTools "Bash(node <this package>/bin/cli.mjs:*)"
  ```

  in the project root.

- **`'external'`.** `agent: 'external'` starts nothing: the sent comments wait for an agent outside this process — the Zed agent
  woken by a watcher script, `claude -p` on another machine (a dev server in a container has no claude and no credentials), a
  person. The board and the file work the same; whoever takes the batch uses the CLI below.

The agent works with the small CLI of this package (every command changes the same file, so the board updates live; run it from
the project root, or point `AI_COMMENTS_FILE` at the file):

```
ai-comments take                          sent → processing
ai-comments progress <id> <0-100> [note]  Claude's own plan steps: finished steps / all steps
ai-comments done <id> [note]              processing → done
```

- One agent at a time; when it stops, comments that are still `sent` are started again only after something new is sent (in
  `'external'` mode the watcher decides).
- If the agent stops with comments still `processing`, they go back to `draft` with a note, so you decide.
- The agent's output is in `.ai-comments/agent.log`.

## Where the data is

- `.ai-comments/comments.json`: the truth. You can read it, and the plugin picks up edits.
- `localStorage` of the page: a copy, per project. It is used only when the file is **lost**: the page puts the copy back.

## Options

```js
aiComments({
  file: ".ai-comments/comments.json",
  scroller: "main", // the element that scrolls your page; comments are placed inside it (falls back to the document)
  agent: {
    // or `false`: no agent, the board is only a list, or `'external'`: an agent outside works it
    command: "claude",
    model: "sonnet", // optional
    prompt: ({ cli, file, root }) => "…",
    args: ({ prompt, cli }) => ["-p", prompt /* … */],
    env: {},
  },
});
```

## Prototypes of the lab workspace

The Vite prototypes (`lab/.worktrees/main/prototypes/*`) use the plugin in both setups:

- **local** (`npm run dev` on the work machine): the plugin starts the usual `claude` on every sent batch; `AI_COMMENTS_AGENT=zed`
  hands the batch to the Zed agent instead — `prototypes/zed-comments.sh` watches the sent comments and pastes the prompt into the
  Zed panel (`--claude` starts `claude -p` itself).
- **remote** (the dev server of `development/proto-env.sh` in its container on `https://<name>.proto.service-lab.dev`): the container
  has no claude, so the plugin always runs with `agent: 'external'`; `prototypes/zed-comments.sh --remote` watches the public address
  and wakes the agent — the Zed panel of a Zed project opened over ssh, or `--remote --claude`: `claude -p` on the server
  (`ssh claude@service-lab.dev`), in `~/lab/.worktrees/main/prototypes/<name>`.

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
