import test from 'node:test'
import assert from 'node:assert/strict'
import { pageCount } from '../src/orders.js'

test('45 orders take 3 pages', () => {
  assert.equal(pageCount(45), 3)
})
