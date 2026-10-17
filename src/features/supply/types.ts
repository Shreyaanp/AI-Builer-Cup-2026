/** Shapes of the supply-chain records (backend/app/supply_chain.py, supply_rules.py). */

export type SystemFormat = 'idoc' | 'csv' | 'text' | 'json'
export type DocKind = 'ORDERS' | 'ORDRSP' | 'DESADV' | 'INVOIC'
export type PoStatus =
  | 'draft'
  | 'sent'
  | 'changed'
  | 'confirmed'
  | 'dispatched'
  | 'received'
  | 'invoiced'
  | 'closed'
  | 'cancelled'

export interface PoLine {
  line: number
  item: string
  buyer_code?: string
  supplier_code?: string
  quantity: number
  unit: string
  /** Minor units per unit at the tier this quantity reaches. */
  price: number | null
  total: number | null
  list_price?: number
  next_tier?: { min_quantity: number; price: number } | null
  confirmed?: number
  confirmed_price?: number | null
  line_status?: 'accepted' | 'changed' | 'backordered' | 'substituted' | 'rejected'
  backorder_quantity?: number
  backorder_date?: string
  substitute?: string
  shipped?: number
  invoiced_price?: number | null
  invoiced_quantity?: number
}

export type CheckCode =
  | 'below_moq'
  | 'not_pack_multiple'
  | 'over_credit'
  | 'late'
  | 'over_approval'
  | 'new_supplier'
  | 'no_price'

export interface Fix {
  kind: 'quantity' | 'cash' | 'supplier'
  line?: number
  value?: number | string | null
}

export interface RuleCheck {
  code: CheckCode
  line: number | null
  item: string
  values: Record<string, number | string>
  fix: Fix | null
  blocking: boolean
}

export interface DocFlag {
  id: string
  field: string
  reason: 'unit' | 'date' | 'item_code' | 'quantity' | 'price' | 'total' | 'terms' | 'reference'
  value: string
  options: string[]
  line: number | null
  resolved: string | null
}

export interface SupplyDocument {
  id: string
  kind: DocKind
  number: string
  at: number
  from: 'buyer' | 'supplier'
  /** As the sender's system wrote it. */
  raw: string
  raw_format: SystemFormat
  /** As the receiver's system reads it. */
  translated: string
  translated_format: SystemFormat
  mapping: { field: string; source: string }[]
  flags: DocFlag[]
  /** gemini (live AI), parser (offline fixture) or template (we wrote it). */
  reader: 'gemini' | 'parser' | 'template'
  simulated?: boolean
}

export interface OrderChange {
  code:
    | 'partial'
    | 'partial_not_allowed'
    | 'backorder_not_allowed'
    | 'substitute'
    | 'substitute_not_allowed'
    | 'rejected'
    | 'price_changed'
  line: number
  now?: number
  later?: number
  date?: string
  name?: string
  was?: number
}

export interface PurchaseOrder {
  id: string
  number: string
  version: number
  status: PoStatus
  sent: boolean
  auto_sent: boolean
  created: number
  currency: string
  buyer: { id: string; name: string; system: SystemFormat }
  supplier: { id: string; name: string; demo: boolean; system: SystemFormat }
  terms_days: number
  lines: PoLine[]
  /** Minor units. */
  total: number
  need_by: string
  delivery: string
  reason: {
    item: string
    unit: string
    stock: number
    stock_known: boolean
    runs_out: string
    daily: number
    method: 'timesfm' | 'weekday_average' | 'none'
    wanted: number
    owner_quantity: boolean
    tier_min: number
    moq?: number
    on_time: boolean
    headroom: number | null
    options: number
  }
  alternatives: {
    supplier_id: string
    name: string
    demo: boolean
    total: number
    price: number | null
    unit: string
    quantity: number
    arrives: string
    on_time: boolean
    system: SystemFormat
  }[]
  checks: RuleCheck[]
  approval_required: boolean
  blocked: boolean
  documents: SupplyDocument[]
  backorders: { item: string; quantity: number; unit: string; date: string }[]
  changes?: OrderChange[]
  received: boolean
  received_at?: number
  received_stock?: Record<string, number>
  invoiced?: boolean
  invoice_total?: number | null
  disputed?: boolean
  match?: { code: 'price' | 'quantity'; line: number }[]
  open_flags?: number
  simulated: boolean
  cash_this_time?: boolean
}

export interface PriceTier {
  min_quantity: number
  price: number
}

export interface ItemRule {
  item: string
  unit: string
  supplier_code: string
  moq: number
  pack: number
  lead_days: number
  tiers: PriceTier[]
  substitutes: string[]
  partial_ok: boolean
  backorder_ok: boolean
}

export interface RuleSet {
  terms_days: 0 | 7 | 30
  credit_limit: number
  approval_over: number
  new_supplier_approval: boolean
  auto_send: boolean
  system_format: SystemFormat
  items: ItemRule[]
}

export interface Relationship {
  supplier: { id: string; name: string; demo: boolean }
  currency: string
  rules: RuleSet
  suggested: boolean
  pending: { rules: RuleSet; change: Record<string, unknown>; created: number } | null
  version: number
  open_balance?: number
}
