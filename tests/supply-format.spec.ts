import { expect, test } from '@playwright/test'
import { orderTotal, poNumber } from '../src/features/supply/orderFormat.ts'

test('poNumber drops a leading PO- so the label reads "PO 2026-0042"', () => {
  expect(poNumber('PO-2026-0042')).toBe('2026-0042')
  expect(poNumber('po 17')).toBe('17')
  expect(poNumber('2026-0042')).toBe('2026-0042')
  expect(poNumber(17)).toBe('17')
  expect(poNumber(undefined)).toBe('')
})

test('orderTotal uses the stated total, then the line sum, never NaN', () => {
  const line = (total: number | null, price: number | null = null, quantity = 2) =>
    ({ total, price, quantity }) as never
  expect(orderTotal({ total: 500, lines: [] })).toBe(500)
  expect(orderTotal({ total: undefined, lines: [line(100), line(250)] } as never)).toBe(350)
  expect(orderTotal({ total: undefined, lines: [line(null, 30)] } as never)).toBe(60)
  expect(orderTotal({ total: undefined, lines: [line(null)] } as never)).toBeNull()
  expect(orderTotal({ total: undefined, lines: [] } as never)).toBeNull()
  expect(orderTotal({ total: NaN, lines: undefined } as never)).toBeNull()
})
