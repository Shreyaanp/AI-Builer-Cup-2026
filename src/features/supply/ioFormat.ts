import { useLocale } from '../../state/hooks'
import { formatPrice } from '../v1/format'
import { dayLabel } from './supplyData'
import type { IoCopy } from './ioCopy'
import type { Board, Change, IoOrder, Task, View } from './ioTypes'

/** Numbers, days and money in the owner's locale (quantities line up with tabular figures). */
export function useIoFormat(currency = '') {
  const locale = useLocale()
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  return {
    qty: (value: number | string | null | undefined) => number.format(Number(value ?? 0)),
    day: (iso: string | null | undefined) => dayLabel(iso ?? '', locale),
    time: (at: number) =>
      new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(at * 1000)),
    money: (minor: number | string | null | undefined) =>
      minor == null || minor === '' ? '–' : formatPrice(Number(minor), currency, locale),
  }
}
export type IoFormat = ReturnType<typeof useIoFormat>

/** One change in plain words: "Milk: 20 → 15 litre", "Date moved: Mon 20 Oct → Tue 21 Oct". */
export function changeText(change: Change, c: IoCopy, f: IoFormat): string {
  const item = change.item ?? ''
  switch (change.code) {
    case 'quantity':
      return c.change.quantity(item, f.qty(change.was), f.qty(change.now), change.unit ?? '')
    case 'date':
      return c.change.date(f.day(String(change.was ?? '')), f.day(String(change.now ?? '')))
    case 'price':
    case 'price_changed':
      return c.change.price(item, f.money(change.was), f.money(change.now))
    case 'added':
      return c.change.added(item, f.qty(change.now), change.unit ?? '')
    case 'removed':
    case 'rejected':
      return c.change.removed(item)
    case 'cancelled':
      return c.change.cancelled
    case 'forecast':
      return c.change.forecast(f.qty(change.quantity), change.unit ?? '', item, f.day(change.date))
    default:
      return ''
  }
}

export function problemText(code: string, c: IoCopy): string {
  const text = c.problem[code as Exclude<keyof IoCopy['problem'], 'late'>]
  return typeof text === 'string' ? text : ''
}

/** What a task asks, in one line under its title. */
export function taskDetail(task: Task, c: IoCopy, f: IoFormat): string {
  if (task.short?.length)
    return task.short.map((x) => c.short(f.qty(x.quantity), x.unit, x.item)).join(', ')
  if (task.changes?.length)
    return task.changes
      .map((x) => changeText(x, c, f))
      .filter(Boolean)
      .slice(0, 2)
      .join(' · ')
  if (task.code === 'late') return c.problem.late(f.day(task.date))
  if (task.code === 'problem') return problemText(task.problem ?? '', c)
  if (task.date) return c.due(f.day(task.date))
  return c.order(task.number)
}

/** Statuses of the shop's own orders whose goods are still on the way. */
export const ON_THE_WAY = new Set(['sent', 'changed', 'confirmed', 'dispatched', 'invoiced'])
export const onTheWay = (o: IoOrder) =>
  o.direction === 'in' && !o.received && ON_THE_WAY.has(o.status)

/** How many items each of the four screens holds. */
export function counts(board: Board | null): Record<View, number> {
  return {
    needs: board?.tasks.length ?? 0,
    coming:
      (board?.inbox.filter((e) => e.status === 'new' || e.status === 'needs_you').length ?? 0) +
      (board?.orders.filter(onTheWay).length ?? 0),
    received: board?.orders.filter((o) => o.direction === 'in' && o.received).length ?? 0,
    send: board?.unsent.length ?? 0,
  }
}
