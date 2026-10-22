import type { Register } from 'claude-code'
import { type Decision, type State, ABSENT_NOTE, CONTINUES, TTL_MS, UNATTENDED, decide, hasThinkTool, isAbsent, isMalformed, isThinkTool, isWrite, matches, newState, parsePatterns, type Patterns } from './think.ts'

const read = (text: unknown): Patterns => {
  try {
    return parsePatterns(String(text ?? ''))
  } catch (err) {
    return { res: [], errors: [`could not be read (${String(err)})`] }
  }
}

// 0.4.0 (life-crm 1.4.0, 2026-10-22): the gate's memory lived in module variables, which start
// over whenever the module reloads or the process restarts. A write held for approval in a
// cloud session restarts the process before the call is checked, so a thinking step that
// ran seconds earlier was forgotten and the write was blocked anyway (transcript
// 7a003651, 09:06 -> 09:15). The state is now saved to $.store under this session's id,
// which the session keeps across restarts, and read back before every decision.
// Every store call is best effort: when the store fails the gate keeps its memory copy.
type Saved = {
  thoughtUntil: number; failed: string[]; thinkErrors: number; degraded: string | null
  unattended?: boolean; origin?: string; at: number
}
const PREFIX = 'turn:'
const WEEK = 7 * 24 * 3600 * 1000

// Block log: every deny, warn, or allow-with-note is appended to $.store under LOG_KEY, a
// ring buffer of the last LOG_MAX entries ({ ts, session, origin, tool, decision, reason }).
// $.store is a JSON file of this plugin's own under the Claude Code config directory; see
// README "Block log" for how to read it. Logging is best effort and never changes a decision.
export const LOG_KEY = 'log'
export const LOG_MAX = 500
type LogEntry = { ts: string; session: string; origin: string; tool: string; decision: string; reason: string }

async function sessionId($: any): Promise<string | null> {
  try {
    const id = await $.session.id()
    return id ? String(id) : null
  } catch {
    return null
  }
}

async function keyOf($: any): Promise<string | null> {
  const id = await sessionId($)
  return id === null ? null : PREFIX + id
}

async function clock($: any): Promise<number> {
  try {
    const n = Number(await $.clock.now())
    if (n > 0) return n
  } catch {
    // Fall back to the process clock.
  }
  return Date.now()
}

async function load($: any, s: State): Promise<void> {
  const key = await keyOf($)
  if (!key) return
  try {
    const v = (await $.store.get(key)) as Saved | undefined
    if (!v || typeof v !== 'object') return
    // A record saved before 0.4.0 has `thought: boolean` and no expiry: treat it as expired.
    s.thoughtUntil = Number(v.thoughtUntil) || 0
    s.failed = new Set(Array.isArray(v.failed) ? v.failed.filter(x => typeof x === 'string') : [])
    s.thinkErrors = Number(v.thinkErrors) || 0
    s.degraded = typeof v.degraded === 'string' ? v.degraded : null
    s.unattended = v.unattended === true
    s.origin = typeof v.origin === 'string' ? v.origin : ''
  } catch {
    // Keep the memory copy.
  }
}

async function save($: any, s: State): Promise<void> {
  const key = await keyOf($)
  if (!key) return
  try {
    const at = await clock($)
    const v: Saved = {
      thoughtUntil: s.thoughtUntil, failed: [...s.failed], thinkErrors: s.thinkErrors,
      degraded: s.degraded, unattended: s.unattended, origin: s.origin, at,
    }
    await $.store.set(key, v)
  } catch {
    // Keep the memory copy.
  }
}

async function logDecision($: any, s: State, tool: string, decision: string, reason: string): Promise<void> {
  try {
    const entry: LogEntry = {
      ts: new Date(await clock($)).toISOString(),
      session: (await sessionId($)) ?? '',
      origin: s.origin,
      tool,
      decision,
      reason: reason.slice(0, 300),
    }
    const prev = await $.store.get(LOG_KEY)
    const log = Array.isArray(prev) ? prev : []
    log.push(entry)
    await $.store.set(LOG_KEY, log.slice(-LOG_MAX))
  } catch {
    // Logging must never change the decision.
  }
}

export const register: Register = (on, options) => {
  const writes = read(options.writes)
  const retries = read(options.retries)
  const mode = options.mode === 'warn' ? 'warn' : 'enforce'
  const s = newState()

  // A new request no longer clears the thinking step (it expires after TTL_MS on its own).
  // It still clears the thinking tool's error count and degraded mode, so each request
  // tries the server again, and it records whether the request came from a schedule.
  const reset = (origin: string) => {
    s.thinkErrors = 0
    s.degraded = null
    s.unattended = UNATTENDED.has(origin)
    s.origin = origin
  }

  on('prompt.submit', async ($, e, next) => {
    if ((await $.env.get('THINK_FIRST_FAULT')) === 'prompt') {
      throw new Error('fault injected with THINK_FIRST_FAULT=prompt')
    }
    const origin = e.origin?.kind ?? ''
    await load($, s)
    if (CONTINUES.has(origin)) {
      s.origin = origin
      await save($, s)
      return next(e)
    }
    reset(origin)
    await save($, s)
    return next(e)
  }).catch(async ($, e, next) => {
    // The hook failed. Claude Code would skip it and let the prompt through. Reset anyway,
    // as an attended request: stricter (a crash never turns blocks into warnings), and the
    // prompt still goes on.
    reset('')
    await save($, s)
    return next(e)
  })

  // Drop saved turns older than a week so the store stays small.
  on('session.start', async ($, e, next) => {
    try {
      const now = await clock($)
      for (const k of await $.store.keys()) {
        if (!k.startsWith(PREFIX)) continue
        const v = (await $.store.get(k)) as Saved | undefined
        if (!v || !(Number(v.at) > now - WEEK)) await $.store.delete(k)
      }
    } catch {
      // Pruning is housekeeping; never block the session over it.
    }
    return next(e)
  })

  // Tell hooks that start after this point that think-first is enforcing, so an older
  // hook-based thinking gate can step aside instead of double-gating. Only with valid
  // settings: a gate that cannot read its own patterns must never stand another one down.
  const announce = writes.res.length > 0 && writes.errors.length === 0 && retries.errors.length === 0
  let announced = false

  on('tool.call', async ($, e, next) => {
    if (announce && !announced) {
      try {
        await $.env.set('THINK_FIRST_ACTIVE', '1')
        announced = true
      } catch {
        // A marker that cannot be set only means the older gate keeps running too.
      }
    }
    if ((await $.env.get('THINK_FIRST_FAULT')) === '1') {
      throw new Error('fault injected with THINK_FIRST_FAULT=1')
    }

    await load($, s)
    const now = await clock($)

    if (isThinkTool(e.tool)) {
      const r = await next(e)
      if (r.deny === undefined && !r.isError) {
        s.thoughtUntil = now + TTL_MS
        s.failed.clear()
        s.thinkErrors = 0
        s.degraded = null
      } else if (r.isError && !isMalformed(r.text ?? '')) {
        const text = r.text ?? 'error'
        s.thinkErrors += 1
        // One strike is enough when the tool is absent (see isAbsent): a second can never
        // arrive, so waiting for it is waiting forever. Two strikes still apply to a server
        // that is present and erroring, where a retry might genuinely succeed.
        if (isAbsent(text) || s.thinkErrors >= 2) s.degraded = text.slice(0, 200)
      }
      await save($, s)
      return r
    }

    const args = e as unknown as Record<string, unknown>
    const write = isWrite(e.tool, writes, args)
    let d: Decision = decide(e.tool, s, writes, retries, mode, now, args)
    if (d.kind !== 'allow') {
      // About to block. First ask whether a thinking tool exists at all: when its server is
      // gone the model cannot satisfy this gate, and a call to the missing tool never reaches
      // this hook (see think.ts). Re-checked on every block rather than stored, so the gate
      // re-arms the moment the server is back. If the list cannot be read, keep the block.
      let names: string[] | null = null
      try {
        names = (await $.tool.list()).map(t => t.name)
      } catch {
        names = null
      }
      if (names !== null && !hasThinkTool(names)) d = { kind: 'allow', note: ABSENT_NOTE }
    }
    if (d.kind === 'deny') {
      await logDecision($, s, e.tool, 'deny', d.reason)
      return { deny: d.reason }
    }
    if (d.kind === 'warn') await logDecision($, s, e.tool, 'warn', d.reason)
    else if (d.note) await logDecision($, s, e.tool, 'allow-note', d.note)

    const r = await next(e)
    // Only a failed WRITE needs a thinking step before its retry; a failed read retries freely.
    if (r.isError && write) s.failed.add(e.tool)
    else if (r.deny === undefined && !r.isError && write) s.failed.delete(e.tool)
    await save($, s)

    const note = d.kind === 'warn' ? d.reason : d.note
    if (note && r.deny === undefined) return { ...r, context: [...(r.context ?? []), note] }
    return r
  }).catch(async ($, e, next) => {
    // The gate itself failed. Block what it guards rather than wave it through.
    if (!isThinkTool(e.tool) && (e.tool.startsWith('mcp__') || matches(writes, e.tool))) {
      const reason =
        `think-first: blocked ${e.tool} because the gate failed while checking it ` +
        `(${String(next.error)}). It blocks rather than allow when it cannot decide.`
      await logDecision($, s, e.tool, 'deny-crash', reason)
      return { deny: reason }
    }
    return next(e)
  })
}
