// think-first's decision, kept free of the engine so tests and readers can see it whole.
//
// Two triggers, both defined by what is at stake rather than how hard the task feels:
//   1. Before the first WRITE in each turn (a turn starts at each user message).
//   2. Before RETRYING a tool call that just failed.
// A successful sequentialthinking call satisfies both, until the next user message or the
// next failure.

export type Patterns = { res: RegExp[]; errors: string[] }
export type Mode = 'enforce' | 'warn'
export type Decision =
  | { kind: 'allow'; note?: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'warn'; reason: string }

// Prompts that continue work already under way rather than start a new request. Every
// other origin (the person typing, -p, a phone, a schedule, a peer, a channel) resets.
export const CONTINUES = new Set(['task-notification', 'observer-activity', 'auto-continuation'])

export type State = {
  thought: boolean            // a thinking step succeeded since the user's last message
  failed: Set<string>         // tools whose last call errored, with no thinking step since
  thinkErrors: number         // consecutive thinking-tool errors, excluding malformed calls
  degraded: string | null     // the thinking tool is unavailable; why
}

export const newState = (): State => ({ thought: false, failed: new Set(), thinkErrors: 0, degraded: null })

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

export function decide(tool: string, s: State, writes: Patterns, retries: Patterns, mode: Mode): Decision {
  if (isThinkTool(tool)) return { kind: 'allow' }
  const verdict = (reason: string): Decision =>
    mode === 'warn' ? { kind: 'warn', reason } : { kind: 'deny', reason }

  const errors = [...writes.errors, ...retries.errors]
  if (errors.length > 0 && tool.startsWith('mcp__')) {
    return verdict(`think-first: blocked ${tool} because its settings have errors. ${errors.join('; ')}. Fix them with /plugin configure.`)
  }

  const retrying = s.failed.has(tool) && matches(retries, tool)
  const writing = !s.thought && matches(writes, tool)
  if (!retrying && !writing) return { kind: 'allow' }

  if (s.degraded) {
    return { kind: 'allow', note: `think-first: sequential thinking is unavailable this turn (${s.degraded}). Say so in your reply.` }
  }
  if (retrying) {
    return verdict(`think-first: blocked ${tool} because its last call failed and no thinking step has run since. Work out why first. ${HOW}`)
  }
  return verdict(`think-first: blocked ${tool} because it is a write and no thinking step has run since the user's last message. ${HOW}`)
}
