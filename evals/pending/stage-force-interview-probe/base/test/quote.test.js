import test from 'node:test'
import assert from 'node:assert/strict'
import { baseRateCents } from '../src/quote.js'

test('base rate grows with weight', () => {
  assert.equal(baseRateCents(1), 620)
})
