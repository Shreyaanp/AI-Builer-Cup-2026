import type { PurchaseOrder } from './types.ts'

/** The number without a leading "PO-"/"PO " so the copy's own "PO" prefix is not doubled. */
export function poNumber(number: string | number | null | undefined): string {
  return String(number ?? '').trim().replace(/^PO[-\s]*/i, '')
}

/** Order total in minor units: the stated total, else the sum of line totals, else null. */
export function orderTotal(order: Pick<PurchaseOrder, 'total' | 'lines'>): number | null {
  if (typeof order.total === 'number' && Number.isFinite(order.total)) return order.total
  const lines = order.lines ?? []
  if (lines.length === 0) return null
  let sum = 0
  for (const line of lines) {
    const value =
      line.total ??
      (line.price != null && line.quantity != null ? line.price * line.quantity : null)
    if (value == null || !Number.isFinite(value)) return null
    sum += value
  }
  return sum
}
