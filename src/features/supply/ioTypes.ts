/** Partner documents in and out (backend/app/supply_io.py, supply_outbound.py). */
import type { PurchaseOrder, SupplyDocument, SystemFormat } from './types'

export type Chip = 'new' | 'needs_you' | 'sent' | 'done' | 'problem'
export type IoKind =
  'FORECAST' | 'ORDERS' | 'ORDER_CHANGE' | 'ORDRSP' | 'DESADV' | 'INVOIC' | 'RECEIPT'
export type View = 'needs' | 'coming' | 'received' | 'send'

export interface Partner {
  id: string
  name: string
  system: SystemFormat
  demo: boolean
}

export interface Change {
  code:
    | 'quantity'
    | 'date'
    | 'price'
    | 'added'
    | 'removed'
    | 'cancelled'
    | 'created'
    | 'forecast'
    | 'partial'
    | 'partial_not_allowed'
    | 'backorder_not_allowed'
    | 'substitute'
    | 'substitute_not_allowed'
    | 'rejected'
    | 'price_changed'
  item?: string
  was?: number | string
  now?: number | string
  unit?: string
  quantity?: number
  date?: string
}

export interface Short {
  item: string
  quantity: number
  unit: string
}

export interface IoDocument extends Omit<SupplyDocument, 'kind'> {
  kind: IoKind
  direction?: 'in' | 'out'
  status?: 'pending' | 'sent'
  sent_at?: number
  short?: Short[]
  canonical?: { lines?: { line: number; item: string; quantity: number; unit: string }[] }
}

export interface Step {
  step: 'created' | 'changed' | 'shipped' | 'received' | 'closed'
  at: number | null
  waiting?: boolean
}

export interface IoOrder extends Omit<PurchaseOrder, 'documents' | 'status'> {
  status: PurchaseOrder['status']
  documents: IoDocument[]
  direction: 'in' | 'out'
  partner: Partner
  chip: Chip
  timeline: Step[]
  /** Per line number: what should arrive (shipping notice, else confirmation, else order). */
  expected: Record<string, number>
  origin?: 'partner'
  problem?: string
  pending_change: { entry_id: string; number: string; changes: Change[] } | null
  shortage?: Short[]
  received_lines?: Record<string, number>
}

export interface InboxEntry {
  id: string
  kind: IoKind
  number: string
  at: number
  partner: Partner | null
  direction: 'in' | 'out'
  order_id: string
  status: 'new' | 'needs_you' | 'done' | 'problem'
  problem: string
  changes: Change[]
  lines: { line: number; item: string; quantity: number; unit: string }[]
  delivery: string
  raw: string
  raw_format: SystemFormat
}

export interface Task {
  code:
    | 'accept_change'
    | 'approve_po'
    | 'receive'
    | 'send_receipt'
    | 'send_asn'
    | 'ship'
    | 'late'
    | 'problem'
  status: 'needs_you' | 'problem'
  order_id: string | null
  number: string
  partner: string
  doc_id?: string | null
  entry_id?: string
  short?: Short[]
  changes?: Change[]
  problem?: string
  date?: string
}

export interface Unsent {
  order_id: string
  number: string
  kind: 'RECEIPT' | 'DESADV'
  doc_id: string | null
  partner: string
  demo: boolean
  lines: { item: string; quantity: number; unit: string }[]
  short: Short[]
}

export interface Board {
  today: string
  orders: IoOrder[]
  inbox: InboxEntry[]
  tasks: Task[]
  unsent: Unsent[]
  demo: boolean
}
