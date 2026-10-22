import { expect, test } from 'claude-code/testing'

const W = 'mcp__claude-code-remote__update_trigger'
const T = 'mcp__remote-devices__sequential-thinking__sequentialthinking'

function engine(on: any, store: Map<string, unknown>, broken = false) {
  on('store.get', (_: any, e: any) => { if (broken) throw new Error('boom'); return { value: store.get(e.key) } })
  on('store.set', (_: any, e: any) => { if (broken) throw new Error('boom'); store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: 'S1' }))
  on('clock.now', () => ({ value: 1_000_000_000 }))
  on('env.get', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: T }, { name: W }] }))
  on('tool.call', () => ({ result: {} }))
}

const denied = (r: any) => /think-first: blocked/.test(String(r.deny ?? (r.isError ? r.text : '') ?? ''))

test('control: a fresh process with nothing saved blocks the write', async ($, on) => {
  engine(on, new Map())
  const r = await $.tool.call({ tool: W } as any)
  expect(denied(r)).toBe(true)
})

test('a thinking step is saved under the session id', async ($, on) => {
  const store = new Map<string, unknown>()
  engine(on, store)
  await $.tool.call({ tool: T, thought: 'x', thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false } as any)
  expect((store.get('turn:S1') as any)?.thoughtUntil).toBe(1_000_000_000 + 10 * 60 * 1000)
  const r = await $.tool.call({ tool: W } as any)
  expect(denied(r)).toBe(false)
})

test('restart: a new module reads the saved thinking step back and allows the write', async ($, on) => {
  const store = new Map<string, unknown>([['turn:S1', { thoughtUntil: 1_000_060_000, failed: [], thinkErrors: 0, degraded: null, at: 1_000_000_000 }]])
  engine(on, store)
  const r = await $.tool.call({ tool: W } as any)
  expect(denied(r)).toBe(false)
})

test('another session id does not inherit the step', async ($, on) => {
  const store = new Map<string, unknown>([['turn:OTHER', { thoughtUntil: 1_000_060_000, failed: [], thinkErrors: 0, degraded: null, at: 1_000_000_000 }]])
  engine(on, store)
  const r = await $.tool.call({ tool: W } as any)
  expect(denied(r)).toBe(true)
})

test('a broken store falls back to memory: think then write still works', async ($, on) => {
  engine(on, new Map(), true)
  await $.tool.call({ tool: T, thought: 'x', thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false } as any)
  const r = await $.tool.call({ tool: W } as any)
  expect(denied(r)).toBe(false)
})

test('a new user message keeps a saved step that has not expired (0.4.0)', async ($, on) => {
  const store = new Map<string, unknown>([['turn:S1', { thoughtUntil: 1_000_060_000, failed: [], thinkErrors: 0, degraded: null, at: 1_000_000_000 }]])
  engine(on, store)
  on('prompt.submit', (_: any, e: any) => ({ ...e }))
  await ($ as any).prompt.submit({ text: 'next request' })
  expect((store.get('turn:S1') as any)?.thoughtUntil).toBe(1_000_060_000)
  const r = await $.tool.call({ tool: W } as any)
  expect(denied(r)).toBe(false)
})

test('a saved step past its expiry blocks the write', async ($, on) => {
  engine(on, new Map<string, unknown>([['turn:S1', { thoughtUntil: 999_999_999, failed: [], thinkErrors: 0, degraded: null, at: 999_000_000 }]]))
  const r = await $.tool.call({ tool: W } as any)
  expect(denied(r)).toBe(true)
})

test('a record saved before 0.4.0 (thought: true, no expiry) counts as expired', async ($, on) => {
  engine(on, new Map<string, unknown>([['turn:S1', { thought: true, failed: [], thinkErrors: 0, degraded: null, at: 1_000_000_000 }]]))
  const r = await $.tool.call({ tool: W } as any)
  expect(denied(r)).toBe(true)
})
