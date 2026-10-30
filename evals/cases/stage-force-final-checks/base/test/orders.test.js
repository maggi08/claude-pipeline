import test from 'node:test'
import assert from 'node:assert/strict'
import { sortNewestFirst } from '../src/orders.js'

test('sorts newest first', () => {
  const sorted = sortNewestFirst([{ createdAt: 1 }, { createdAt: 3 }, { createdAt: 2 }])
  assert.deepEqual(sorted.map((o) => o.createdAt), [3, 2, 1])
})
