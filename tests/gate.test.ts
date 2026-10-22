import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { isShellWrite, TTL_MS } from '../hooks/think.ts'

// Run with: claude plugin test plugins/think-first
// Every test here has a mutant in scripts/mutate.py that must make it fail.

const ST = 'mcp__plugin_think-first_sequential-thinking__sequentialthinking'
const WRITE = 'mcp__notes__create_page'
const READ = 'mcp__notes__get_page'
const THINK = { thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false, thought: 'plan' }

// The floor stands for the engine: tools in `failing` answer with an error, the rest run.
const marked: string[] = []
const promptsReached: string[] = []

function floor(on: On, opts: { failing?: Record<string, string>; env?: Record<string, string> } = {}) {
  const ran: string[] = []
  marked.length = 0
  mock.env(on, opts.env ?? {})
  on('env.set', async (_$, e) => {
    marked.push(`${e.name}=${e.value}`)
    return { value: undefined }
  })
  on('tool.call', async (_$, e) => {
    ran.push(e.tool)
    const err = opts.failing?.[e.tool]
    return err ? { result: err, text: err, isError: true } : { result: 'ran', text: 'ran' }
  })
  promptsReached.length = 0
  on('prompt.submit', async (_$, e) => {
    promptsReached.push(e.text)
    return { text: e.text }
  })
  return ran
}

const denial = (r: { deny?: string; isError?: boolean; text?: string }) =>
  r.deny ?? (r.isError && r.text?.startsWith('think-first') ? r.text : undefined)

describe('writes', () => {
  test('a write is blocked before any thinking step', async ($, on) => {
    const ran = floor(on)
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toContain('is a write')
    expect(ran).toEqual([])
  })

  test('a read is never blocked', async ($, on) => {
    const ran = floor(on)
    const r = await $.tool.call({ tool: READ, id: 'x' })
    expect(denial(r)).toBeUndefined()
    expect(ran).toEqual([READ])
  })

  test('a thinking step unlocks writes for the next 10 minutes', async ($, on) => {
    const ran = floor(on)
    await $.tool.call({ tool: ST, ...THINK })
    const a = await $.tool.call({ tool: WRITE, title: 'a' })
    const b = await $.tool.call({ tool: WRITE, title: 'b' })
    expect(denial(a)).toBeUndefined()
    expect(denial(b)).toBeUndefined()
    expect(ran).toEqual([ST, WRITE, WRITE])
  })

  test('a new user message does not clear a thinking step that is still valid', async ($, on) => {
    const ran = floor(on)
    await $.tool.call({ tool: ST, ...THINK })
    await $.prompt.submit({ text: 'next request', wait: false, origin: { kind: 'composer' } })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toBeUndefined()
    expect(ran).toEqual([ST, WRITE])
  })

  test('the thinking step expires after 10 minutes', async ($, on) => {
    const ran = floor(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.tool.call({ tool: ST, ...THINK })
    await clock.advance(TTL_MS - 1000)
    const a = await $.tool.call({ tool: WRITE, title: 'a' })
    await clock.advance(2000)
    const b = await $.tool.call({ tool: WRITE, title: 'b' })
    expect(denial(a)).toBeUndefined()
    expect(denial(b)).toContain('last 10 minutes')
    expect(ran).toEqual([ST, WRITE])
  })
})

describe('what counts as a new request', () => {
  test('a new request clears degraded mode, so the thinking server is tried again', async ($, on) => {
    const ran = floor(on, { failing: { [ST]: 'connection refused' } })
    await $.tool.call({ tool: ST, ...THINK })
    await $.tool.call({ tool: ST, ...THINK })
    await $.prompt.submit({ text: 'next request', wait: false, origin: { kind: 'composer' } })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toContain('is a write')
    expect(ran).toEqual([ST, ST])
  })

  test('a background task finishing does not clear degraded mode', async ($, on) => {
    const ran = floor(on, { failing: { [ST]: 'connection refused' } })
    await $.tool.call({ tool: ST, ...THINK })
    await $.tool.call({ tool: ST, ...THINK })
    await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toBeUndefined()
    expect(ran).toEqual([ST, ST, WRITE])
  })
})

describe('scheduled runs', () => {
  test('a scheduled run warns instead of blocking', async ($, on) => {
    const ran = floor(on)
    await $.prompt.submit({ text: 'scheduled', wait: false, origin: { kind: 'scheduled-trigger' } })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toBeUndefined()
    expect((r.context ?? []).join(' ')).toContain('Scheduled run')
    expect(ran).toEqual([WRITE])
  })

  test('a background task finishing inside a scheduled run keeps it scheduled', async ($, on) => {
    const ran = floor(on)
    await $.prompt.submit({ text: 'scheduled', wait: false, origin: { kind: 'scheduled-trigger' } })
    await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toBeUndefined()
    expect(ran).toEqual([WRITE])
  })

  test('a person typing after a scheduled run is blocked again', async ($, on) => {
    const ran = floor(on)
    await $.prompt.submit({ text: 'scheduled', wait: false, origin: { kind: 'scheduled-trigger' } })
    await $.prompt.submit({ text: 'me', wait: false, origin: { kind: 'composer' } })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toContain('is a write')
    expect(ran).toEqual([])
  })
})

describe('when the prompt hook itself fails', () => {
  test('a crash still resets degraded mode, and the prompt goes through',
    async ($, on) => {
      const ran = floor(on, { env: { THINK_FIRST_FAULT: 'prompt' }, failing: { [ST]: 'connection refused' } })
      await $.tool.call({ tool: ST, ...THINK })
      await $.tool.call({ tool: ST, ...THINK })
      await $.prompt.submit({ text: 'next request', wait: false, origin: { kind: 'scheduled-trigger' } })
      const r = await $.tool.call({ tool: WRITE, title: 'x' })
      expect(promptsReached).toEqual(['next request'])
      // Degraded mode is gone and the crash never counts as a scheduled run: a real block.
      expect(denial(r)).toContain('is a write')
      expect(ran).toEqual([ST, ST])
    })

  test('a prompt that arrives with no origin still resets', async ($, on) => {
    const ran = floor(on, { failing: { [ST]: 'connection refused' } })
    await $.tool.call({ tool: ST, ...THINK })
    await $.tool.call({ tool: ST, ...THINK })
    await $.prompt.submit({ text: 'next request', wait: false } as never)
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toContain('is a write')
    expect(ran).toEqual([ST, ST])
  })
})

describe('retries', () => {
  test('a failed write is blocked until a thinking step runs', async ($, on) => {
    const ran = floor(on, { failing: { [WRITE]: 'boom' } })
    await $.tool.call({ tool: ST, ...THINK })
    await $.tool.call({ tool: WRITE, title: 'x' })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toContain('last call failed')
    expect(ran).toEqual([ST, WRITE])
  })

  test('after a thinking step the retry runs', async ($, on) => {
    const ran = floor(on, { failing: { [WRITE]: 'boom' } })
    await $.tool.call({ tool: ST, ...THINK })
    await $.tool.call({ tool: WRITE, title: 'x' })
    await $.tool.call({ tool: ST, ...THINK })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).not.toContain('think-first')
    expect(ran).toEqual([ST, WRITE, ST, WRITE])
  })

  test('a failed read retries freely', async ($, on) => {
    const ran = floor(on, { failing: { [READ]: 'boom' } })
    await $.tool.call({ tool: READ, id: 'x' })
    const r = await $.tool.call({ tool: READ, id: 'x' })
    expect(denial(r)).not.toContain('think-first')
    expect(ran).toEqual([READ, READ])
  })

  test('thinking earlier in the turn does not cover a later failure', async ($, on) => {
    const ran = floor(on, { failing: { [WRITE]: 'boom' } })
    await $.tool.call({ tool: ST, ...THINK })
    await $.tool.call({ tool: WRITE, title: 'x' })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toContain('last call failed')
    expect(ran).toEqual([ST, WRITE])
  })

  test('a different tool is not held back by another tool failing', async ($, on) => {
    const ran = floor(on, { failing: { [WRITE]: 'boom' } })
    await $.tool.call({ tool: ST, ...THINK })
    await $.tool.call({ tool: WRITE, title: 'x' })
    const r = await $.tool.call({ tool: 'mcp__notes__create_note' })
    expect(denial(r)).toBeUndefined()
    expect(ran).toEqual([ST, WRITE, 'mcp__notes__create_note'])
  })
})

describe('when the thinking tool itself fails', () => {
  test('two real errors mark it unavailable and writes go through with a note', async ($, on) => {
    const ran = floor(on, { failing: { [ST]: 'connection refused' } })
    await $.tool.call({ tool: ST, ...THINK })
    await $.tool.call({ tool: ST, ...THINK })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toBeUndefined()
    expect((r.context ?? []).join(' ')).toContain('unavailable')
    expect(ran).toEqual([ST, ST, WRITE])
  })

  test('one error is not enough to give up on it', async ($, on) => {
    const ran = floor(on, { failing: { [ST]: 'connection refused' } })
    await $.tool.call({ tool: ST, ...THINK })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toContain('is a write')
    expect(ran).toEqual([ST])
  })

  test('a malformed call is a caller mistake, never unavailable', async ($, on) => {
    const ran = floor(on, { failing: { [ST]: 'MCP error -32602: invalid params' } })
    await $.tool.call({ tool: ST, ...THINK })
    await $.tool.call({ tool: ST, ...THINK })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toContain('is a write')
    expect(ran).toEqual([ST, ST])
  })
})

describe('modes and failures of the gate', () => {
  test('warn mode lets the write run and tells Claude', { options: { mode: 'warn' } }, async ($, on) => {
    const ran = floor(on)
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toBeUndefined()
    expect((r.context ?? []).join(' ')).toContain('is a write')
    expect(ran).toEqual([WRITE])
  })

  test('a custom writes setting replaces the default', { options: { writes: 'mcp__notes__get_*' } }, async ($, on) => {
    const ran = floor(on)
    const a = await $.tool.call({ tool: READ, id: 'x' })
    const b = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(a)).toContain('is a write')
    expect(denial(b)).toBeUndefined()
    expect(ran).toEqual([WRITE])
  })

  test('a broken pattern blocks MCP calls with the reason', { options: { writes: '/create(/' } }, async ($, on) => {
    const ran = floor(on)
    const r = await $.tool.call({ tool: READ, id: 'x' })
    expect(denial(r)).toContain('settings have errors')
    expect(ran).toEqual([])
  })

  test('a crash inside the gate blocks a write even after thinking', async ($, on) => {
    const ran = floor(on, { env: { THINK_FIRST_FAULT: '1' } })
    await $.tool.call({ tool: ST, ...THINK })
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toContain('gate failed')
    // The thinking call is passed through on purpose: blocking it would leave no way out.
    expect(ran).toEqual([ST])
  })
})

describe('handing off to an older hook-based thinking gate', () => {
  test('with valid settings, think-first marks itself active for later hooks', async ($, on) => {
    floor(on)
    await $.tool.call({ tool: READ, id: 'x' })
    expect(marked).toEqual(['THINK_FIRST_ACTIVE=1'])
  })

  test('with a broken pattern, it never marks itself active', { options: { writes: '/create(/' } }, async ($, on) => {
    floor(on)
    await $.tool.call({ tool: 'Read', file_path: 'x' })
    expect(marked).toEqual([])
  })
})

// 2026-10-12: when the bridge to the computer drops, the thinking tool leaves the tool
// list, and the engine refuses a call to it before any tool.call hook runs. The gate asks
// $.tool.list() before blocking instead of waiting for an error that never arrives.
const tools = (on: On, names: string[]) =>
  on('tool.list', async () => ({ value: names.map(name => ({ name, description: name, mcp: true })) }))

describe('thinking tool gone from the session', () => {
  test('with no thinking tool listed, a write runs with a note to disclose', async ($, on) => {
    const ran = floor(on)
    tools(on, [WRITE, READ])
    const r: any = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toBeUndefined()
    expect(ran).toEqual([WRITE])
    expect(String(r.context ?? '')).toContain('no sequential-thinking tool is available')
  })

  test('with the thinking tool listed but not called, the write is still blocked', async ($, on) => {
    const ran = floor(on)
    tools(on, [WRITE, READ, ST])
    const r = await $.tool.call({ tool: WRITE, title: 'x' })
    expect(denial(r)).toContain('is a write')
    expect(ran).toEqual([])
  })
})

// 0.4.0: shell tools are judged by their command, not their name.
const DB = 'mcp__remote-devices__device_bash'
const DC = 'mcp__remote-devices__Desktop_Commander__start_process'

const READS = [
  'ls -la',
  'cd "$HOME/mnt/x" && git status --short && git log --oneline | head -5',
  'grep -rn "a->b" . 2>&1 | head',
  'find . -name "*.ts" 2>/dev/null | wc -l',
  'cat -n hooks/think.ts > /dev/null',
  'sed -n 1,40p file; git diff --stat; git -C ~/gits/x show HEAD:README.md',
  'which python3 node',
  'python3 -m json.tool < x.json',
  'echo hello >&2',
]
const WRITES = [
  'echo x > f', 'echo x >> f', 'rm f', 'mv a b', 'cp a b', 'mkdir d', 'touch f', 'ln -s a b',
  'chmod +x f', 'chown me f', 'ls | tee out', "sed -i '' 's/a/b/' f", 'perl -pi -e s/a/b/ f',
  'truncate -s 0 f', 'dd if=a of=b', 'git commit -m x', 'git -C repo push', 'git reset --hard',
  'git checkout -- f', 'git restore f', 'git stash', 'git clean -fd', 'git rm f', 'git merge b',
  'git rebase main', 'git tag v1', 'git am p', 'git apply p', 'npm install', 'pip install x',
  'brew install jq', 'curl -X POST https://x', 'curl -X DELETE https://x', 'kill 123',
  "python3 - <<'PY'\nprint(1)\nPY", 'python3 -c "print(1)"', 'node <<EOF\n1\nEOF', 'bash scripts/build.sh',
  'cat <<EOF > f\nx\nEOF', 'find . -delete',
]

describe('shell tools', () => {
  test('read-only commands are reads; commands with a write signal are writes', () => {
    for (const c of READS) expect([c, isShellWrite(c)]).toEqual([c, false])
    for (const c of WRITES) expect([c, isShellWrite(c)]).toEqual([c, true])
  })

  test('a command that cannot be read is a write', () => {
    expect(isShellWrite(undefined)).toBe(true)
    expect(isShellWrite(42)).toBe(true)
    expect(isShellWrite('   ')).toBe(true)
  })

  test('a read-only device_bash command runs with no thinking step', { options: { writes: '/device_bash/' } }, async ($, on) => {
    const ran = floor(on)
    const r = await $.tool.call({ tool: DB, command: 'ls -la 2>&1 | head' } as never)
    expect(denial(r)).toBeUndefined()
    expect(ran).toEqual([DB])
  })

  test('a writing device_bash command is blocked', async ($, on) => {
    const ran = floor(on)
    const r = await $.tool.call({ tool: DB, command: 'echo x > f' } as never)
    expect(denial(r)).toContain('is a write')
    expect(ran).toEqual([])
  })

  test('Desktop Commander start_process is judged the same way', async ($, on) => {
    const ran = floor(on)
    const a = await $.tool.call({ tool: DC, command: 'git status', timeout_ms: 1000 } as never)
    const b = await $.tool.call({ tool: DC, command: 'python3 -i', timeout_ms: 1000 } as never)
    expect(denial(a)).toBeUndefined()
    expect(denial(b)).toContain('is a write')
    expect(ran).toEqual([DC])
  })

  test('a failed read command retries freely; a failed write command does not', async ($, on) => {
    const ran = floor(on, { failing: { [DB]: 'exit 1' } })
    await $.tool.call({ tool: DB, command: 'ls nope' } as never)
    const a = await $.tool.call({ tool: DB, command: 'ls nope' } as never)
    await $.tool.call({ tool: ST, ...THINK })
    await $.tool.call({ tool: DB, command: 'mkdir d' } as never)
    const b = await $.tool.call({ tool: DB, command: 'mkdir d' } as never)
    expect(denial(a)).toBeUndefined()
    expect(denial(b)).toContain('last call failed')
    expect(ran).toEqual([DB, DB, ST, DB])
  })
})

// 0.4.0: every block, warning and allow-with-note is appended to $.store under 'log'.
function memstore(on: On, map: Map<string, unknown>, broken = false) {
  on('store.get', async (_$, e) => { if (broken) throw new Error('boom'); return { value: map.get(e.key) } })
  on('store.set', async (_$, e) => { if (broken) throw new Error('boom'); map.set(e.key, e.value); return { value: undefined } })
  on('store.delete', async (_$, e) => { map.delete(e.key); return { value: undefined } })
  on('store.keys', async () => ({ value: [...map.keys()] }))
}

describe('block log', () => {
  test('a block is logged with tool, decision and reason', async ($, on) => {
    floor(on)
    const map = new Map<string, unknown>()
    memstore(on, map)
    await $.tool.call({ tool: WRITE, title: 'x' })
    const log = map.get('log') as any[]
    expect(log.length).toBe(1)
    expect(log[0].tool).toBe(WRITE)
    expect(log[0].decision).toBe('deny')
    expect(String(log[0].reason)).toContain('is a write')
    expect(typeof log[0].ts).toBe('string')
  })

  test('a warning in a scheduled run is logged with its origin', async ($, on) => {
    floor(on)
    const map = new Map<string, unknown>()
    memstore(on, map)
    await $.prompt.submit({ text: 'scheduled', wait: false, origin: { kind: 'scheduled-trigger' } })
    await $.tool.call({ tool: WRITE, title: 'x' })
    const log = map.get('log') as any[]
    expect(log[0].decision).toBe('warn')
    expect(log[0].origin).toBe('scheduled-trigger')
  })

  test('the log keeps only the last 500 entries', async ($, on) => {
    floor(on)
    const old = Array.from({ length: 500 }, (_, i) => ({ ts: '', session: '', origin: '', tool: 't' + i, decision: 'deny', reason: '' }))
    const map = new Map<string, unknown>([['log', old]])
    memstore(on, map)
    await $.tool.call({ tool: WRITE, title: 'x' })
    const log = map.get('log') as any[]
    expect(log.length).toBe(500)
    expect(log[0].tool).toBe('t1')
    expect(log[499].tool).toBe(WRITE)
  })

  test('a broken store never changes the decision', async ($, on) => {
    const ran = floor(on)
    memstore(on, new Map(), true)
    const a = await $.tool.call({ tool: WRITE, title: 'x' })
    await $.tool.call({ tool: ST, ...THINK })
    const b = await $.tool.call({ tool: WRITE, title: 'y' })
    expect(denial(a)).toContain('is a write')
    expect(denial(b)).toBeUndefined()
    expect(ran).toEqual([ST, WRITE])
  })
})
