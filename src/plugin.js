// ai-comments: a Vite plugin, for the dev server only.
//  * the comments are in one JSON file (`.ai-comments/comments.json`); the plugin serves a small API over it and injects the
//    comments UI (an add icon and a kanban board) into every page;
//  * a listener watches the file: when comments become `sent` it starts Claude (`claude -p`), which takes them with the
//    `ai-comments` command, reports its progress and finishes them; every change of the file is pushed to the open pages live.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "../bin/cli.mjs");
const CLIENT = path.resolve(here, "client.js");

/**
 * @typedef {{
 *   file?: string,
 *   route?: string,
 *   scroller?: string,
 *   agent?: false | 'external' | {
 *     command?: string,
 *     model?: string,
 *     args?: (ctx: { prompt: string, cli: string, file: string, root: string }) => string[],
 *     prompt?: (ctx: { cli: string, file: string, root: string }) => string,
 *     env?: Record<string, string>,
 *   },
 */

/** The instructions Claude is started with. */
export function defaultPrompt({ cli, root }) {
  const c = `node ${cli}`;
  return `You work off review comments that the owner left on the pages of the dev server of the project in ${root}.

1. Take the comments: run \`${c} take\`. It prints them as JSON and marks them "processing".
   Each one has: "comment" (what to change), "route" (the page, with the #anchor), "rect" and "viewport" (the area the owner selected,
   in pixels), "elements" (tags, classes and text under that area: search the source for them) and "batch" (it may have none).
   A comment may have a "thread": the conversation so far (who is "user" or "claude"). If the owner answered and sent it again, read
   the thread and go on from their last message. The note you give to \`done\` is shown to the owner as your reply in that thread;
   if you need an answer from them, finish with the question: they can reply and send it again.
2. Work one comment at a time, in order. For each: find the code, make a short plan of 3 to 6 steps, and after every finished step run
   \`${c} progress <id> <percent> "<what you are doing next>"\`, where percent = finished steps / all steps * 100 (never 100).
3. When the change is made, run \`${c} done <id> "<one or two lines: what changed and where>"\`.
   If you cannot do it, run \`${c} done <id> "Not done: <the reason>"\` and go on.

Rules: run each \`${c} ...\` command as a Bash call of its own, written exactly like this with the full path and nothing before or after it
(no variables, no && or ;, no pipes): any other form is refused. Change files with the Edit tool, not with sed or shell redirects.
Never edit the comments file by hand. Do not commit. Make the smallest change that does what the comment asks.`;
}

/** @param {Options} [options] */
export function pageComments(options = {}) {
  const route = options.route ?? "/__ai-comments";
  // 'external': nothing is started here; an agent outside this process (the Zed panel, claude on another machine) works the sent comments
  const agentOpts =
    options.agent === false
      ? null
      : options.agent === "external"
        ? { external: true }
        : (options.agent ?? {});
  let root = process.cwd();
  let file = "";
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  let child = null;
  let lastError = null; // why the last agent run left comments untouched (shown on the board)
  const tried = new Set(); // `sent` comments that an agent run left untouched: not started again until something new is sent
  let log = (m) => console.log(`[ai-comments] ${m}`);
  let timer = null;

  const snapshot = () => {
    const { state, exists } = store.read(file);
    return {
      comments: state.comments,
      exists,
      agent: child
        ? "running"
        : !agentOpts
          ? "off"
          : agentOpts.external
            ? "external"
            : "idle",
      error: child ? null : lastError,
    };
  };
  const push = () => {
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const r of clients) r.write(data);
  };

  /** Start Claude if comments are waiting and none runs. */
  const maybeRun = () => {
    if (!agentOpts || agentOpts.external || child) return;
    const waiting = store
      .read(file)
      .state.comments.filter((c) => c.status === "sent" && !tried.has(c.id));
    if (!waiting.length) return;
    const mine = new Set(waiting.map((c) => c.id)); // what this run was started for: only these are its to release
    const prompt = (agentOpts.prompt ?? defaultPrompt)({
      cli: CLI,
      file,
      root,
    });
    const ctx = { prompt, cli: CLI, file, root };
    const command = agentOpts.command ?? "claude";
    const args = (
      agentOpts.args ??
      ((x) => [
        "-p",
        x.prompt,
        ...(agentOpts.model ? ["--model", agentOpts.model] : []),
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        `Bash(node ${x.cli}:*)`,
      ])
    )(ctx);
    const logFile = path.join(path.dirname(file), "agent.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const logFrom = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    const out = fs.openSync(logFile, "a");
    lastError = null;
    log(`${waiting.length} comment(s) sent: starting ${command}`);
    const p = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...agentOpts.env, AI_COMMENTS_FILE: file },
      stdio: ["ignore", out, out],
    });
    child = p;
    const stop = (why) => {
      if (child !== p) return;
      child = null;
      fs.closeSync(out);
      // whatever the run left: still processing → back to draft (the person decides); still sent → remembered, not started again
      const released = store.mutate(file, (s) =>
        store.release(
          s,
          `The agent stopped before it finished (${why}).`,
          mine,
        ),
      );
      let stillSent = 0;
      for (const c of store.read(file).state.comments)
        if (c.status === "sent") {
          tried.add(c.id);
          stillSent++;
        }
      if (stillSent || released.length) {
        const text = fs
          .readFileSync(logFile, "utf8")
          .slice(logFrom)
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(-3)
          .join(" ");
        lastError = (
          text || `the agent stopped (${why}) and left the comments untouched`
        ).slice(0, 400);
      }
      if (released.length)
        log(`${released.length} comment(s) were not finished: back to draft`);
      log(`agent stopped (${why}); log: ${logFile}`);
      push();
      maybeRun();
    };
    p.on("error", (e) => stop(e.message));
    p.on("exit", (code, sig) => stop(sig ? `signal ${sig}` : `exit ${code}`));
    push();
  };

  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      push();
      maybeRun();
    }, 30);
  };

  const body = (req) =>
    new Promise((resolve, reject) => {
      let n = 0;
      const chunks = [];
      req.on("data", (c) => {
        n += c.length;
        if (n > 1e6) reject(new Error("body too large"));
        else chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(
            chunks.length
              ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
              : {},
          );
        } catch {
          reject(new Error("not JSON"));
        }
      });
    });

  /** @type {import('vite').Plugin} */
  return {
    name: "ai-comments",
    apply: "serve",
    configResolved(config) {
      root = config.root;
      file = path.resolve(root, options.file ?? ".ai-comments/comments.json");
      log = (m) => config.logger.info(`[ai-comments] ${m}`);
    },
    configureServer(server) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      server.watcher.add(file);
      for (const ev of ["add", "change", "unlink"])
        server.watcher.on(ev, (f) => path.resolve(f) === file && changed());
      server.httpServer?.once("close", () => child?.kill());
      setTimeout(maybeRun, 0); // comments that were sent before the server started

      server.middlewares.use(route, async (req, res, next) => {
        const url = new URL(req.url || "/", "http://x");
        const send = (code, data) => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(data));
        };
        try {
          if (req.method === "GET" && url.pathname === "/client.js") {
            const cfg = {
              route,
              scroller: options.scroller ?? "main",
              project: crypto
                .createHash("sha1")
                .update(file)
                .digest("hex")
                .slice(0, 8),
            };
            res.setHeader("content-type", "text/javascript");
            res.setHeader("cache-control", "no-store");
            return res.end(
              `const CONFIG = ${JSON.stringify(cfg)};\n` +
                fs.readFileSync(CLIENT, "utf8"),
            );
          }
          if (req.method === "GET" && url.pathname === "/events") {
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
              connection: "keep-alive",
            });
            res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
            clients.add(res);
            const ka = setInterval(() => res.write(": ka\n\n"), 25000);
            req.on("close", () => {
              clearInterval(ka);
              clients.delete(res);
            });
            return;
          }
          if (req.method === "GET" && url.pathname === "/")
            return send(200, snapshot());

          // a change: only from a page of this server (a form on another site cannot send application/json without a preflight)
          if (
            !/^application\/json/.test(
              String(req.headers["content-type"] || ""),
            )
          )
            return send(415, { error: "application/json only" });
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host)
            return send(403, { error: "foreign origin" });
          const b = await body(req);
          const id = url.pathname.slice(1);
          let result;
          if (req.method === "POST" && url.pathname === "/") {
            result = store.mutate(file, (s) => store.add(s, b));
            if (b.send) tried.delete(result.id); // "take now"
          } else if (
            req.method === "POST" &&
            /^\/[^/]+\/reply$/.test(url.pathname)
          ) {
            result = store.mutate(file, (s) =>
              store.reply(
                s,
                url.pathname.split("/")[1],
                "user",
                b.text,
                !!b.resend,
              ),
            );
            if (b.resend) tried.delete(result.id);
          } else if (req.method === "POST" && url.pathname === "/send") {
            result = store.mutate(file, (s) => store.send(s, b.batch));
            for (const c of result) tried.delete(c.id);
          } else if (req.method === "POST" && url.pathname === "/retry") {
            tried.clear();
            lastError = null;
            maybeRun();
            result = { ok: true };
          } else if (req.method === "POST" && url.pathname === "/restore") {
            // the file was lost, the page still has its copy: put it back (never over a file that exists)
            if (store.read(file).exists) throw new Error("the file exists");
            const list = Array.isArray(b.comments)
              ? b.comments.filter(
                  (c) =>
                    c && c.id && store.STATUSES.includes(c.status) && c.rect,
                )
              : [];
            store.write(file, { version: 1, comments: list });
            result = { restored: list.length };
          } else if (req.method === "POST" && url.pathname === "/archive")
            result = store.mutate(file, (s) => store.archiveDone(s));
          else if (req.method === "PATCH" && id) {
            result = store.mutate(file, (s) => {
              if (b.comment !== undefined) store.edit(s, id, b.comment);
              if (b.status !== undefined)
                return store.move(s, id, b.status, b.batch);
              return s.comments.find((c) => c.id === id);
            });
            if (b.status === "sent") tried.delete(id);
          } else if (req.method === "DELETE" && id)
            result = store.mutate(file, (s) => store.remove(s, id));
          else return next();
          changed();
          return send(200, result ?? { ok: true });
        } catch (e) {
          return send(400, { error: e.message });
        }
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "module", src: `${route}/client.js` },
          injectTo: "body",
        },
      ];
    },
  };
}

export default pageComments;
