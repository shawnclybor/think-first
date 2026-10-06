# think-first

think-first makes Claude Code run a sequential-thinking step at the two moments where
acting without a plan costs the most:

1. **Before the first write in each turn.** A turn starts with each new request, whether
   typed, sent with `claude -p`, sent from a phone, fired by a schedule, or sent by another
   session. A background task finishing doesn't start a new turn.
2. **Before retrying a tool call that just failed.** A plan made earlier in the turn doesn't
   cover a failure that came after it.

One successful thinking step covers every write in the turn and clears earlier failures.

## What it needs

A sequential-thinking server. think-first checks that one was used; it doesn't bring its own.
If you don't run one yet, add the standard one with a single command:

```bash
claude mcp add sequential-thinking -- npx -y @modelcontextprotocol/server-sequential-thinking@2025.11.25
```

think-first accepts any tool whose name ends in `sequentialthinking`. If none exists, it
blocks writes and tells Claude to stop and say so, rather than letting them through.

**Why it doesn't bundle the server.** A plugin that brings its own server runs on your
computer in Claude Cowork, and its check never reaches cloud Cowork tasks. Without the
server, think-first runs inside the task, and Cowork passes it the thinking server from
your computer while the desktop app is open.

## Configure

Run `/plugin configure think-first`, then set:

| Setting | Meaning | Default |
|---|---|---|
| `writes` | Which tools count as writes. Patterns are separated by `;`. A glob uses `*`; `/regex/flags` matches anywhere in the tool name. | MCP tools whose names contain create, update, delete, send, post, publish, upload, move, remove, insert, execute, write, apply, deploy, trash, share, edit or merge |
| `retries` | Which tools need a thinking step before they're retried after a failure, in the same format. | `mcp__*` |
| `mode` | `enforce` blocks the call. `warn` lets it run and tells Claude it skipped the step. | `enforce` |

## When the thinking tool itself is down

- **A malformed call** (wrong or missing parameters) means the server answered, so it's
  healthy. Claude has to fix the call.
- **Two real errors in a row** mark the server unavailable for the rest of the turn. Writes
  then go through, with a note telling Claude to say in its reply that it couldn't think
  first. This means a broken server can't deadlock the session.

## When the gate itself fails

If a setting can't be read, or the gate crashes, think-first blocks MCP tools and every
write. It never blocks the thinking tool itself, so there's always a way out. If the hook
that notices each new request crashes, the request still goes through and think-first
resets anyway, so a thinking step from the last request can never cover this one.

## Running alongside an older hook-based gate

If you already enforce the same thing with a command hook, both would fire. Once think-first has
valid settings, it sets `THINK_FIRST_ACTIVE=1` for every hook Claude Code starts after its first check. Make the
old hook exit early when it sees that, and it steps aside only where think-first is actually
running. Anywhere mods don't load (another host, or mods switched off) the old hook keeps
enforcing.

## Where it runs

think-first is a mod: a plugin with code that runs inside Claude Code. It needs Claude Code
2.1.287 or later, with mods on. Mod hooks run in the terminal, in the Desktop app's Code
tab, under `claude -p` and in the Agent SDK. Anthropic's documentation doesn't list Claude
Cowork, and think-first hasn't been tested there.

## What it reaches

`claude plugin validate .` lists everything the module touches. It hooks `prompt.submit` and
`tool.call`, and its only calls are `$.env.get` for one variable, `THINK_FIRST_FAULT`, and `$.env.set` for one, `THINK_FIRST_ACTIVE`. The
module makes no network requests and reads or writes no files. The bundled server is
started by Claude Code itself, with `npx` downloading the pinned package from the npm
registry.

## Verify it

Each check below has been shown to fail as well as pass:

```bash
claude plugin test .          # 21 behaviour tests
python3 scripts/mutate.py     # breaks the gate 18 ways; every break must turn a test red
bash scripts/e2e.sh           # real sessions: blocked, unblocked after thinking, retry blocked, control, handoff
```

`THINK_FIRST_FAULT=1` in the environment makes the gate crash on purpose. That's how the
"blocks when it crashes" behaviour is tested.
