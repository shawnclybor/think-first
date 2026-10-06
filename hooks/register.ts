import type { Register } from 'claude-code'
import { CONTINUES, decide, isMalformed, isThinkTool, matches, newState, parsePatterns, type Patterns } from './think.ts'

const read = (text: unknown): Patterns => {
  try {
    return parsePatterns(String(text ?? ''))
  } catch (err) {
    return { res: [], errors: [`could not be read (${String(err)})`] }
  }
}

export const register: Register = (on, options) => {
  const writes = read(options.writes)
  const retries = read(options.retries)
  const mode = options.mode === 'warn' ? 'warn' : 'enforce'
  const s = newState()

  const reset = () => {
    s.thought = false
    s.thinkErrors = 0
    s.degraded = null
  }

  // Each new request starts a new turn: the next write needs a fresh thinking step.
  on('prompt.submit', async ($, e, next) => {
    if ((await $.env.get('THINK_FIRST_FAULT')) === 'prompt') {
      throw new Error('fault injected with THINK_FIRST_FAULT=prompt')
    }
    if (CONTINUES.has(e.origin?.kind ?? '')) return next(e)
    reset()
    return next(e)
  }).catch(async ($, e, next) => {
    // The hook failed. Claude Code would skip it and let the prompt through, but the
    // reset would never happen, and the last request's thinking step would silently
    // cover this request's writes. Reset anyway: stricter, and the prompt still goes on.
    reset()
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

    if (isThinkTool(e.tool)) {
      const r = await next(e)
      if (r.deny === undefined && !r.isError) {
        s.thought = true
        s.failed.clear()
        s.thinkErrors = 0
        s.degraded = null
      } else if (r.isError && !isMalformed(r.text ?? '')) {
        s.thinkErrors += 1
        if (s.thinkErrors >= 2) s.degraded = (r.text ?? 'error').slice(0, 200)
      }
      return r
    }

    const d = decide(e.tool, s, writes, retries, mode)
    if (d.kind === 'deny') return { deny: d.reason }

    const r = await next(e)
    if (r.isError) s.failed.add(e.tool)
    else if (r.deny === undefined) s.failed.delete(e.tool)

    const note = d.kind === 'warn' ? d.reason : d.note
    if (note && r.deny === undefined) return { ...r, context: [...(r.context ?? []), note] }
    return r
  }).catch(async ($, e, next) => {
    // The gate itself failed. Block what it guards rather than wave it through.
    if (!isThinkTool(e.tool) && (e.tool.startsWith('mcp__') || matches(writes, e.tool))) {
      return {
        deny:
          `think-first: blocked ${e.tool} because the gate failed while checking it ` +
          `(${String(next.error)}). It blocks rather than allow when it cannot decide.`,
      }
    }
    return next(e)
  })
}
