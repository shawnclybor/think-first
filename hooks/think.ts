// think-first's decision, kept free of the engine so tests and readers can see it whole.
//
// Two triggers, both defined by what is at stake rather than how hard the task feels:
//   1. Before a WRITE, unless a thinking step succeeded in the last 10 minutes.
//   2. Before RETRYING a write that just failed. A failed read retries freely.
// A successful sequentialthinking call satisfies both for TTL_MS (0.4.0: a new user message
// no longer clears it; the step simply expires), or until the next failed write.
//
// Shell tools (device_bash, Desktop Commander start_process) are classified by their
// command, not their name: a command with no write signal is a read. See isShellWrite.
//
// A scheduled run (prompt origin `scheduled-trigger`) has nobody to answer a block, so in
// it every block becomes a warning: the call runs and Claude is told what it skipped.

export type Patterns = { res: RegExp[]; errors: string[] }
export type Mode = 'enforce' | 'warn'
export type Decision =
  | { kind: 'allow'; note?: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'warn'; reason: string }

// Prompts that continue work already under way rather than start a new request. Every
// other origin (the person typing, -p, a phone, a schedule, a peer, a channel) resets.
export const CONTINUES = new Set(['task-notification', 'observer-activity', 'auto-continuation'])

// The engine's origin for "a scheduled task, routine or /loop firing its stored prompt"
// (PromptOrigin in the claude-code types). Nobody is there to read a block.
export const UNATTENDED = new Set(['scheduled-trigger'])

// How long one successful thinking step covers writes.
export const TTL_MS = 10 * 60 * 1000

export type State = {
  thoughtUntil: number        // epoch ms until which the last thinking step covers writes; 0 = none
  failed: Set<string>         // tools whose last WRITE call errored, with no thinking step since
  thinkErrors: number         // consecutive thinking-tool errors, excluding malformed calls
  degraded: string | null     // the thinking tool is unavailable; why
  unattended: boolean         // the last new request came from a schedule
  origin: string              // the last prompt's origin kind, for the block log
}

export const newState = (): State =>
  ({ thoughtUntil: 0, failed: new Set(), thinkErrors: 0, degraded: null, unattended: false, origin: '' })

// ---- shell tools --------------------------------------------------------------------------

export const isShellTool = (tool: string): boolean =>
  tool === 'device_bash' || tool.endsWith('__device_bash') || tool.endsWith('Desktop_Commander__start_process')

// Write signals in a shell command. Biased toward WRITE: a false write costs one thinking
// step, a false read lets a write through ungated. Word rules run on the raw command, so a
// quoted `rm` still counts; the redirect rule runs with quoted text removed, so `grep "a>b"`
// does not.
const W = String.raw`(?:^|[\s;&|(\x60{!])`   // a command position, roughly: start or after a separator
const WRITE_WORDS: RegExp[] = [
  new RegExp(W + String.raw`(?:sudo\s+)?(?:rm|rmdir|unlink|mv|cp|mkdir|touch|ln|chmod|chown|chgrp|tee|truncate|dd|shred|install|rsync|scp|patch|trash|mkfifo|wget)(?=\s|$|;|\|)`),
  new RegExp(W + String.raw`(?:kill|pkill|killall)(?=\s|$)`),
  /\bsed\b[^|;&\n]*\s-(?:[a-zA-Z]*i|-in-place)/,
  /\bperl\b[^|;&\n]*\s-[a-zA-Z]*i/,
  /\bgit\b(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+(?:commit|push|pull|reset|checkout|switch|restore|stash|clean|rm|mv|add|merge|rebase|cherry-pick|revert|tag|am|apply|init|clone|worktree)\b/,
  /\b(?:npm|pnpm|yarn|pip3?|uv|brew|gem|cargo|apt|apt-get)\s+(?:\S+\s+)?(?:install|i|ci|add|uninstall|remove|rm|upgrade|update|run|exec|link)\b/,
  /\bcurl\b[^|;&\n]*\s(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|-d\b|--data|-F\b|--form|-T\b|--upload-file|-o\b|-O\b|--output)/i,
  /\bfind\b[^|;&\n]*\s-(?:delete|exec|execdir|ok)\b/,
  /\btar\s+-?[a-zA-Z]*[cxru]/,
  new RegExp(W + String.raw`(?:zip|unzip|gzip|gunzip)(?=\s)`),
  /\b(?:defaults\s+(?:write|delete)|launchctl\s+(?:load|unload|bootstrap|bootout|enable|disable|kickstart|start|stop|remove|submit)|crontab\s+(?!-l))/,
  /\bclaude\s+(?:plugin|mcp)\s+(?:install|uninstall|add|remove|enable|disable|update|marketplace)\b/,
  /<</,   // any heredoc or here-string: what it feeds cannot be inspected
  // Interpreters run code this gate cannot read (python3 -, python3 -c, a script, a REPL).
  new RegExp(W + String.raw`(?:python3?|node|bash|sh|zsh|perl|ruby|npx|tsx|deno|bun|osascript|make|xargs|ssh|eval|source|exec)(?=\s|$)(?!\s+(?:--version|-[vV])(?:\s|$))(?!\s+-m\s+json\.tool\b)`),
]
const BENIGN_REDIRECTS = /&>>?\s*\/dev\/null|\d*>>?\s*\/dev\/null|\d*>&\d+|\d*>&-/g
const LOOKUPS = /\b(?:which|type|command\s+-v)(?:[ \t]+[^\s;&|]+)+/g
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g

// true = the command writes, or cannot be read. Never throws.
export function isShellWrite(command: unknown): boolean {
  if (typeof command !== 'string' || command.trim() === '') return true
  const raw = command.replace(LOOKUPS, ' ')
  if (WRITE_WORDS.some(re => re.test(raw))) return true
  const bare = raw.replace(QUOTED, "''").replace(BENIGN_REDIRECTS, ' ')
  return />/.test(bare)
}

// Is this call a write? Shell tools by command; everything else by the `writes` patterns.
export const isWrite = (tool: string, writes: Patterns, args: Record<string, unknown> = {}): boolean =>
  isShellTool(tool) ? isShellWrite(args.command) : matches(writes, tool)

export const isThinkTool = (tool: string): boolean =>
  tool === 'sequentialthinking' || tool.endsWith('__sequentialthinking')

// A malformed call (wrong or missing parameters) means the server answered: it is
// healthy. Only other errors count toward "unavailable".
export const isMalformed = (text: string): boolean => /-32602|invalid (params|arguments)|validation/i.test(text)

// A thinking tool that ERRORS is not the same as one that is GONE.
//
// When the bridge carrying the local MCPs drops, the thinking tool leaves the tool list.
// Measured 2026-10-12 (claude -p, a plugin-dir copy of this mod, the thinking server left
// out): the model's call to the missing tool is refused by the engine with "No such tool
// available" BEFORE any tool.call hook runs, so this mod never sees it. Waiting for that
// error to set `degraded` therefore waits forever, and every write stays blocked. A
// scheduled daily-briefing run (2026-10-12) and email-review (2026-09-30) both lost their
// writes this way.
//
// So the gate asks the engine directly, and only when it is about to block:
// `$.tool.list()` returns every tool the model has, deferred ones included (measured the
// same day: a never-loaded deferred thinking tool is listed). No thinking tool listed means
// the step cannot be taken, so the call goes through with a note the model must disclose.
// A listed thinking tool that simply was not called still blocks. See register.ts.
export const hasThinkTool = (names: readonly string[]): boolean => names.some(isThinkTool)

export const ABSENT_NOTE =
  'think-first: no sequential-thinking tool is available in this session (its server is not ' +
  'connected; in a cloud session the bridge to the computer is usually down), so this call ran ' +
  'without a thinking step. Say in your reply that the thinking step was unavailable.'

// Kept as a second route: a thinking tool that IS listed but whose server answers that the
// tool is unavailable is conclusive on the first answer.
export const isAbsent = (text: string): boolean =>
  /no such tool|tool not found|unknown tool|not available|does not offer this tool/i.test(text)

// Patterns separated by ";" or newlines: a glob ("*" matches anything) or /regex/flags.
export function parsePatterns(text: string): Patterns {
  const res: RegExp[] = []
  const errors: string[] = []
  for (const raw of text.split(/[;\n]/)) {
    const p = raw.trim()
    if (!p || p.startsWith('#')) continue
    const m = /^\/(.+)\/([a-z]*)$/.exec(p)
    try {
      res.push(m ? new RegExp(m[1]!, m[2]) :
        new RegExp('^' + p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'))
    } catch (err) {
      errors.push(`"${p}" is not a valid pattern (${String(err)})`)
    }
  }
  return { res, errors }
}

export const matches = (p: Patterns, tool: string): boolean => p.res.some(re => re.test(tool))

const HOW =
  'Call the sequentialthinking tool to plan it, then retry this same call. ' +
  'If that tool fails because its server is unreachable (not a parameter error), the turn drops ' +
  'to degraded mode and the retry is allowed through \u2014 then say in your reply that the ' +
  'thinking step was unavailable and why. An unreachable thinking server must not strand an ' +
  'unattended run; report the degradation, do not abandon the work.'

export const SCHEDULED_NOTE =
  ' (Scheduled run, so think-first only warns: the call ran. Say in your report that it ran without a thinking step.)'

export function decide(
  tool: string, s: State, writes: Patterns, retries: Patterns, mode: Mode,
  now = 0, args: Record<string, unknown> = {},
): Decision {
  if (isThinkTool(tool)) return { kind: 'allow' }
  const verdict = (reason: string): Decision =>
    s.unattended ? { kind: 'warn', reason: reason + SCHEDULED_NOTE } :
    mode === 'warn' ? { kind: 'warn', reason } : { kind: 'deny', reason }

  const errors = [...writes.errors, ...retries.errors]
  if (errors.length > 0 && tool.startsWith('mcp__')) {
    return verdict(`think-first: blocked ${tool} because its settings have errors. ${errors.join('; ')}. Fix them with /plugin configure.`)
  }

  const write = isWrite(tool, writes, args)
  const retrying = write && s.failed.has(tool) && matches(retries, tool)
  const writing = write && !(s.thoughtUntil > now)
  if (!retrying && !writing) return { kind: 'allow' }

  if (s.degraded) {
    return { kind: 'allow', note: `think-first: sequential thinking is unavailable this turn (${s.degraded}). Say so in your reply.` }
  }
  if (retrying) {
    return verdict(`think-first: blocked ${tool} because its last call failed and no thinking step has run since. Work out why first. ${HOW}`)
  }
  return verdict(`think-first: blocked ${tool} because it is a write and no thinking step has run in the last ${TTL_MS / 60000} minutes. ${HOW}`)
}
