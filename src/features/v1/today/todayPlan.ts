import type { components } from '../../../api/generated'
import type { Business, Product } from '../api'
import { hasHours } from '../../shop/hoursModel'
import { closingMinutes, shopNow } from '../../owner/time'
import { isFood, missingFacts, timeRanges, type AskFact } from '../shopProgress'
import type { DayPart } from './todayCopy'

export type TodayFacts = components['schemas']['Today']
export type CoachLine = components['schemas']['CoachLine']
type Pulse = components['schemas']['Pulse']
type TodayHints = components['schemas']['TodayHints']

export type StepId =
  'items' | 'category' | 'location' | 'hours' | 'photo' | 'phone' | 'share' | 'face'
/** Reminders for what onboarding let the owner skip; not part of the setup progress. */
const REMINDERS: StepId[] = ['photo', 'face']
export type Need =
  | { id: string; kind: 'reply'; count: number }
  | { id: string; kind: 'closeDay' }
  | { id: string; kind: 'menu' }
  | { id: string; kind: 'low'; item: string; left: number }
  | { id: string; kind: 'soldOut'; items: Product[] }
  | { id: string; kind: 'step'; step: StepId }
  | { id: string; kind: 'facts'; facts: AskFact[] }

export type Metric = 'sales' | 'items' | 'views' | 'questions' | 'stamps' | 'returning'
export interface PulseLine {
  when: 'yesterday' | 'today'
  values: { metric: Metric; value: number }[]
}

export interface TodayPlan {
  part: DayPart
  /** Business-type vocabulary: menu for food and drink, items for everyone else. */
  food: boolean
  /** Setup progress while unfinished; null once complete. */
  progress: { done: number; total: number } | null
  /** At most three live items, most urgent first. */
  needs: Need[]
  line: CoachLine | null
  pulse: PulseLine | null
  forecast: { quantity: number; item: string; busy: [number, number] | null } | null
  /** A brand-new shop with no data yet: the next setup step instead of the pulse. */
  dayOne: { step: StepId } | null
}

export interface TodayInput {
  shop: Business & { public?: boolean }
  products: Product[]
  /** Waiting customer conversations (null while unknown). */
  unread: number | null
  /** Server facts (null while loading or unavailable). */
  facts: TodayFacts | null
  /** The daily menu question was answered (or confirmed) today. */
  menuAnswered: boolean
  /** The day was closed today by the owner. */
  dayClosed?: boolean
  now: Date
  /** The owner's face check (null while unknown): skipped at onboarding → a reminder. */
  face?: 'not_started' | 'verified' | 'in_review' | 'not_verified' | null
}

export function isCloseDayWindow(fields: Business['fields'], now: Date): boolean {
  const tz = fields.timezone || 'Asia/Singapore'
  const currentMinutes = shopNow(tz, now.getTime()).minutes
  const close = closingMinutes(fields, tz)
  const threshold = close !== null ? Math.max(0, close - 60) : 19 * 60
  return currentMinutes >= threshold
}

const MAX_NEEDS = 3
const MAX_PULSE_VALUES = 3

export function dayPart(now: Date): DayPart {
  const hour = now.getHours()
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'
}

/**
 * Setup steps still missing, in the order the owner should do them. Onboarding never asks the
 * menu (owner decision, 17 Oct), so "Add your menu" comes first; hours, the shop photo and the
 * face check come back here when onboarding skipped them.
 */
export function missingSteps(
  shop: TodayInput['shop'],
  products: Product[],
  face: TodayInput['face'] = null,
): StepId[] {
  const f = shop.fields
  const steps: [StepId, boolean][] = [
    ['items', products.length === 0],
    ['category', !f.category.trim()],
    // A GPS pin is a place too (onboarding pins the shop; the address may stay empty).
    ['location', !f.location.trim() && f.lat == null],
    ['hours', !hasHours(f)],
    ['phone', !f.phone.trim()],
    ['share', !shop.public],
    // Reminders last: what the owner put off is never more urgent than what the shop lacks.
    ['photo', !shop.gallery?.length],
    ['face', face === 'not_started' || face === 'not_verified'],
  ]
  return steps.filter(([, missing]) => missing).map(([id]) => id)
}

/**
 * Which numbers matter for this kind of shop, most telling first. Rules from the business type
 * until the shop playbook (per-shop goals and key metrics) is available; then it leads.
 */
export function metricsFor(shop: TodayInput['shop'], hints?: TodayHints | null): Metric[] {
  const hasStamps = Boolean(shop.fields.reward_text?.trim())
  const base: Metric[] = isFood(shop.fields)
    ? [
        'sales',
        'items',
        'views',
        'questions',
        'returning',
        ...(hasStamps ? (['stamps'] as Metric[]) : []),
      ]
    : [
        'sales',
        'questions',
        'views',
        'returning',
        ...(hasStamps ? (['stamps'] as Metric[]) : []),
        'items',
      ]
  const first = (hints?.pulse ?? []).filter((key): key is Metric => base.includes(key as Metric))
  return [...new Set([...first, ...base])]
}

// The playbook's "needs you now" kinds, mapped onto what Today can show.
const NEED_HINT: Record<Need['kind'], TodayHints['needs_you'][number] | null> = {
  reply: 'questions',
  closeDay: null,
  menu: 'menu_check',
  low: 'low_stock',
  soldOut: null,
  step: 'missing_info',
  facts: 'missing_info',
}

/** Kinds the shop's playbook puts first lead; everything else keeps its usual order. */
export function byPlaybook(needs: Need[], hints?: TodayHints | null): Need[] {
  if (!hints) return needs
  const rank = (need: Need) => {
    const hint = NEED_HINT[need.kind]
    const index = hint ? hints.needs_you.indexOf(hint) : -1
    return index < 0 ? hints.needs_you.length : index
  }
  return needs
    .map((need, index) => ({ need, index }))
    .sort((a, b) => rank(a.need) - rank(b.need) || a.index - b.index)
    .map(({ need }) => need)
}

function pulseLine(pulse: Pulse, when: PulseLine['when'], order: Metric[]): PulseLine | null {
  const values = order
    // Revenue already tells the day; the item count is the fallback when no prices were saved.
    .filter((metric) => !(metric === 'items' && pulse.sales != null))
    .flatMap((metric) => {
      const value = pulse[metric]
      return value != null && value > 0 ? [{ metric, value }] : []
    })
    .slice(0, MAX_PULSE_VALUES)
  return values.length ? { when, values } : null
}

/**
 * The single adapter that decides what the Today view shows: which items need the owner, which
 * numbers make the pulse, and the coach's line. Pure: same input, same plan.
 */
export function todayPlan(input: TodayInput): TodayPlan {
  const { shop, products, unread, facts } = input
  const food = isFood(shop.fields)
  const steps = missingSteps(shop, products, input.face)
  // Same six checks as the readiness list (name, kind, address, hours, phone, items).
  const total = 6
  const done = total - steps.filter((step) => step !== 'share' && !REMINDERS.includes(step)).length
  const metrics = metricsFor(shop, facts?.hints)
  const pulse = facts
    ? (pulseLine(facts.yesterday, 'yesterday', metrics) ??
      (facts.today ? pulseLine(facts.today, 'today', metrics) : null))
    : null
  const busy = timeRanges(shop.fields.busy_hours ?? '')[0] ?? null
  const forecast = facts?.forecast
    ? { quantity: facts.forecast.quantity, item: facts.forecast.item, busy }
    : null
  // Without facts yet (loading or unavailable), a shop with no menu is still clearly day one.
  const fresh = facts ? !pulse && !forecast : products.length === 0
  // Reminders (photo, face check) never make a set-up shop look like day one again.
  const setup = steps.filter((step) => !REMINDERS.includes(step))
  const dayOne = fresh && setup.length ? { step: setup[0]! } : null

  const serverClosed = Boolean(
    facts?.today && (facts.today.sales != null || facts.today.items != null),
  )
  const isClosed = Boolean(input.dayClosed || serverClosed)
  const closeWindow = isCloseDayWindow(shop.fields, input.now)

  const all: Need[] = []
  if (unread) all.push({ id: 'reply', kind: 'reply', count: unread })
  if (closeWindow && !isClosed) all.push({ id: 'close-day', kind: 'closeDay' })
  if (products.length && facts && shop.last_confirmed !== facts.date && !input.menuAnswered)
    all.push({ id: 'menu', kind: 'menu' })
  const soldOut = products.filter((product) => product.available === false)
  for (const low of facts?.low_stock ?? [])
    all.push({ id: `low-${low.name}`, kind: 'low', item: low.name, left: low.stock })
  if (soldOut.length) all.push({ id: 'sold-out', kind: 'soldOut', items: soldOut })
  // On day one the hero carries the next step; elsewhere missing steps wait their turn here.
  if (!dayOne) for (const step of steps) all.push({ id: `step-${step}`, kind: 'step', step })
  const asked = shop.public ? missingFacts(shop.fields) : []
  if (asked.length) all.push({ id: 'facts', kind: 'facts', facts: asked.slice(0, 2) })

  return {
    part: dayPart(input.now),
    food,
    progress: done < total ? { done, total } : null,
    needs: byPlaybook(all, facts?.hints).slice(0, MAX_NEEDS),
    line: facts?.line ?? null,
    pulse,
    forecast,
    dayOne,
  }
}
