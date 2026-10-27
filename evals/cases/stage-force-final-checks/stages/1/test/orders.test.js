import test from 'node:test'
import assert from 'node:assert/strict'
import { PAGE_SIZE, listOrdersPage, sortNewestFirst } from '../src/orders.js'

const make = (n) => Array.from({ length: n }, (_, i) => ({ createdAt: i }))

test('sorts newest first', () => {
  const sorted = sortNewestFirst([{ createdAt: 1 }, { createdAt: 3 }, { createdAt: 2 }])
  assert.deepEqual(sorted.map((o) => o.createdAt), [3, 2, 1])
})

test('page 1 holds the newest PAGE_SIZE orders', () => {
  const page = listOrdersPage(make(45), 1)
  assert.equal(page.length, PAGE_SIZE)
  assert.equal(page[0].createdAt, 44)
})

test('a page past the end is empty', () => {
  assert.deepEqual(listOrdersPage(make(45), 9), [])
})
