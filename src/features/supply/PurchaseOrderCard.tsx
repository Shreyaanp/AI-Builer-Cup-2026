import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Stack,
  TextField,
  Typography,
  useTheme,
} from '@mui/material'
import {
  ArrowLeftRight,
  Check,
  CircleAlert,
  ClipboardList,
  FileText,
  FlaskConical,
  PackageCheck,
  Receipt,
  Send,
  Truck,
} from 'lucide-react'
import { useLocale } from '../../state/hooks'
import { enterRise, fieldFade, shape } from '../../design/theme'
import { chalkWrite, stampThud } from '../../design/chalkMotion'
import { formatPrice } from '../v1/format'
import { Sheet } from '../v1/Sheet'
import { useShowcaseCopy } from './showcaseCopy'
import { orderTotal, poNumber } from './orderFormat'
import { useSupplyCopy, type SupplyCopy } from './copy'
import { dayLabel, usePoActions, type SimVariant } from './supplyData'
import type { DocFlag, DocKind, PurchaseOrder, RuleCheck, SupplyDocument } from './types'

const STEPS: DocKind[] = ['ORDERS', 'ORDRSP', 'DESADV', 'INVOIC']
const STEP_ICON = {
  ORDERS: <Send size={16} />,
  ORDRSP: <ClipboardList size={16} />,
  DESADV: <Truck size={16} />,
  INVOIC: <Receipt size={16} />,
}
// What the supplier sends next, by status (backend NEXT_FROM_SUPPLIER).
const NEXT: Partial<Record<PurchaseOrder['status'], DocKind>> = {
  sent: 'ORDRSP',
  confirmed: 'DESADV',
  dispatched: 'INVOIC',
  received: 'INVOIC',
}

function useFormat(order: PurchaseOrder) {
  const locale = useLocale()
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  return {
    locale,
    money: (minor: number | null | undefined) =>
      minor == null ? '–' : formatPrice(minor, order.currency, locale),
    qty: (value: number | null | undefined) => number.format(value ?? 0),
    day: (iso: string) => dayLabel(iso, locale),
  }
}

/** The order in one plain line: "20 kg Atta · deliver Fri 17 Oct · ₹1,240 · 7-day credit". */
function headline(order: PurchaseOrder, s: SupplyCopy, f: ReturnType<typeof useFormat>) {
  const [first, ...rest] = order.lines
  const what = first ? `${f.qty(first.quantity)} ${first.unit} ${first.item}` : ''
  return [
    what + (rest.length ? ` +${rest.length}` : ''),
    order.delivery ? s.deliver(f.day(order.delivery)) : '',
    f.money(orderTotal(order)),
    s.terms(order.terms_days),
  ]
    .filter(Boolean)
    .join(' · ')
}

function why(order: PurchaseOrder, s: SupplyCopy, f: ReturnType<typeof useFormat>): string {
  const r = order.reason
  const parts = [
    r.runs_out
      ? s.left(f.qty(r.stock), r.unit, f.day(r.runs_out))
      : r.method === 'none'
        ? s.noForecast
        : '',
    r.tier_min ? s.tier(f.qty(r.tier_min), order.lines[0]?.unit ?? r.unit) : '',
    order.delivery ? s.arrives(f.day(order.delivery)) : '',
    r.headroom != null && r.headroom > 0 ? s.creditLeft(f.money(r.headroom)) : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

function checkText(check: RuleCheck, s: SupplyCopy, f: ReturnType<typeof useFormat>) {
  const v = check.values
  const values: Record<string, string> = {
    moq: f.qty(Number(v.moq)),
    pack: f.qty(Number(v.pack)),
    unit: String(v.unit ?? ''),
    headroom: f.money(Number(v.headroom ?? 0)),
    arrives: f.day(String(v.arrives ?? '')),
    limit: Number(v.limit) ? f.money(Number(v.limit)) : '',
  }
  return s.check[check.code](values)
}

function Panel({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'warn' }) {
  const roles = useTheme().material
  return (
    <Box
      sx={{
        p: 3,
        borderRadius: `${shape.md}px`,
        bgcolor: tone === 'warn' ? roles.errorContainer : roles.surfaceContainerHigh,
        color: tone === 'warn' ? roles.onErrorContainer : roles.onSurface,
        ...fieldFade,
      }}
    >
      {children}
    </Box>
  )
}

/**
 * A purchase order in the chat or the Purchase orders sheet. Plain language first; every
 * broken rule carries its one-tap fix; the document timeline and the side-by-side
 * translation show how each party's system sees it.
 */
export function PurchaseOrderCard({
  order,
  onChange,
}: {
  order: PurchaseOrder
  onChange: (order: PurchaseOrder) => void
}) {
  const roles = useTheme().material
  const s = useSupplyCopy()
  const f = useFormat(order)
  const showcase = useShowcaseCopy()
  const [sapOpen, setSapOpen] = useState(false)
  const sap = order.documents.find(
    (doc) => doc.kind === 'ORDERS' && doc.translated_format === 'idoc',
  )
  const actions = usePoActions(onChange)
  const [busy, setBusy] = useState<string | null>(null)
  const draft = order.status === 'draft'
  const blocking = order.checks.filter((check) => check.blocking)
  const reasons = order.checks.filter((check) => !check.blocking)
  async function act(key: string, run: () => Promise<unknown>) {
    if (busy) return
    setBusy(key)
    try {
      await run()
    } finally {
      setBusy(null)
    }
  }
  const spinner = (key: string, icon: ReactNode) =>
    busy === key ? <CircularProgress size={16} color="inherit" /> : icon
  return (
    <Box
      component="article"
      aria-label={s.po(poNumber(order.number))}
      sx={{
        borderRadius: `${shape.xl}px`,
        bgcolor: draft ? roles.surfaceContainerLow : roles.surfaceContainer,
        border: `1px solid ${draft ? roles.primary : roles.outlineVariant}`,
        p: 4,
        display: 'grid',
        gap: 3,
        minWidth: 0,
      }}
    >
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Box aria-hidden="true" sx={{ display: 'flex', color: roles.primary }}>
          <FileText size={20} />
        </Box>
        <Typography variant="labelLarge" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>
          {s.po(poNumber(order.number))}
        </Typography>
        {order.simulated && (
          <Chip
            component="span"
            size="small"
            icon={<FlaskConical size={14} />}
            label={s.simulation}
            sx={{
              height: 24,
              bgcolor: roles.tertiaryContainer,
              color: roles.onTertiaryContainer,
              '& .MuiChip-icon': { color: 'inherit', ml: 1.5 },
            }}
          />
        )}
        <Chip
          key={order.status}
          component="span"
          size="small"
          label={s.status[order.status]}
          sx={{
            height: 24,
            bgcolor: order.status === 'closed' ? roles.primaryContainer : roles.secondaryContainer,
            color:
              order.status === 'closed' ? roles.onPrimaryContainer : roles.onSecondaryContainer,
            ...(order.status === 'closed' || order.status === 'confirmed' ? stampThud : fieldFade),
          }}
        />
      </Stack>
      <Box>
        {draft && (
          <Typography variant="labelLarge" color="text.secondary">
            {showcase.draft}
          </Typography>
        )}
        <Typography variant="titleSmall" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {order.supplier.name}
        </Typography>
        <Typography
          variant="titleMedium"
          component="p"
          sx={{ mt: 1, overflowWrap: 'anywhere', ...chalkWrite }}
        >
          {headline(order, s, f)}
          {draft && !order.blocked && (
            <Box component="span" sx={{ color: roles.primary }}>
              {' '}
              {s.sendIt}
            </Box>
          )}
        </Typography>
        {draft && (
          <Typography variant="bodyMedium" color="text.secondary" sx={{ mt: 1 }}>
            {order.reason.moq != null &&
              `${s.moq}: ${f.qty(order.reason.moq)} ${order.reason.unit} · `}
            {why(order, s, f)}
          </Typography>
        )}
        {order.lines.length > 1 && (
          <Box component="ul" sx={{ m: 0, mt: 2, pl: 5, display: 'grid', gap: 0.5 }}>
            {order.lines.map((line) => (
              <Typography component="li" variant="bodyMedium" key={line.line}>
                {f.qty(line.quantity)} {line.unit} {line.item} · {f.money(line.total)}
              </Typography>
            ))}
          </Box>
        )}
        {order.simulated && (
          <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 1 }}>
            {order.supplier.system === 'idoc' ? showcase.simulated : s.simulationNote}
          </Typography>
        )}
      </Box>

      {draft && blocking.length > 0 && (
        <Stack spacing={2}>
          {blocking.map((check, index) => (
            <Panel tone="warn" key={`${check.code}-${index}`}>
              <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
                <Box aria-hidden="true" sx={{ display: 'flex', mt: 0.25 }}>
                  <CircleAlert size={18} />
                </Box>
                <Typography variant="bodyMedium" sx={{ flex: 1 }}>
                  {checkText(check, s, f)}
                </Typography>
              </Stack>
              {check.fix && (
                <Button
                  size="small"
                  variant="outlined"
                  disabled={busy !== null}
                  onClick={() => void act(`fix-${index}`, () => actions.fix(order, check.fix))}
                  sx={{ mt: 2, ml: 6, color: 'inherit', borderColor: 'currentColor' }}
                >
                  {check.fix.kind === 'cash'
                    ? s.fixCash
                    : check.fix.kind === 'supplier'
                      ? s.fixSupplier(
                          order.alternatives.find((alt) => alt.supplier_id === check.fix?.value)
                            ?.name ?? '',
                        )
                      : s.fixQuantity(
                          f.qty(Number(check.fix.value)),
                          order.lines.find((line) => line.line === check.fix?.line)?.unit ?? '',
                        )}
                </Button>
              )}
            </Panel>
          ))}
        </Stack>
      )}

      {draft && reasons.length > 0 && (
        <Stack spacing={1}>
          {reasons.map((check, index) => (
            <Typography
              key={`${check.code}-${index}`}
              variant="bodySmall"
              color="text.secondary"
              sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}
            >
              <Check size={14} aria-hidden="true" />
              {checkText(check, s, f)}
            </Typography>
          ))}
        </Stack>
      )}

      {draft ? (
        <Stack direction="row" spacing={2} sx={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button
            disabled={busy !== null}
            onClick={() => void act('cancel', () => actions.cancel(order))}
          >
            {s.discard}
          </Button>
          <Button
            variant="contained"
            disabled={busy !== null || order.blocked}
            onClick={() => void act('approve', () => actions.approve(order))}
            startIcon={spinner('approve', <Send size={18} />)}
            sx={{ minHeight: 48, px: 6 }}
          >
            {busy === 'approve' ? s.sending : s.approve}
          </Button>
        </Stack>
      ) : order.status === 'cancelled' ? (
        <Typography variant="bodyMedium" color="text.secondary">
          {order.sent ? s.status.cancelled : s.discarded}
        </Typography>
      ) : (
        <>
          {order.auto_sent && (
            <Typography variant="bodySmall" color="text.secondary">
              {s.autoSent}
            </Typography>
          )}
          {sap && (
            <Button onClick={() => setSapOpen(true)} sx={{ minHeight: 48 }}>
              {showcase.sap}
            </Button>
          )}
          <Sheet
            open={sapOpen}
            onClose={() => setSapOpen(false)}
            titleId="sap-order-title"
            title={showcase.sap}
          >
            {sap && (
              <Box
                sx={{
                  display: 'grid',
                  gap: 4,
                  gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '1fr 1fr' },
                }}
              >
                <Box>
                  <Typography variant="titleMedium" component="h3">
                    {showcase.plain}
                  </Typography>
                  <Typography sx={{ mt: 2 }}>
                    {order.buyer.name} → {order.supplier.name}
                  </Typography>
                  <Typography sx={{ mt: 2 }}>{headline(order, s, f)}</Typography>
                  <Typography sx={{ mt: 2 }}>{showcase.simulated}</Typography>
                </Box>
                <Code label={s.system.idoc} text={sap.translated} />
              </Box>
            )}
          </Sheet>
          <Timeline order={order} busy={busy} act={act} actions={actions} />
          <NextStep order={order} busy={busy} act={act} actions={actions} />
        </>
      )}
    </Box>
  )
}

type Actions = ReturnType<typeof usePoActions>
type Act = (key: string, run: () => Promise<unknown>) => Promise<void>

/** PO → confirmation → dispatch → invoice, each with its translation and open questions. */
function Timeline({
  order,
  busy,
  act,
  actions,
}: {
  order: PurchaseOrder
  busy: string | null
  act: Act
  actions: Actions
}) {
  const roles = useTheme().material
  const s = useSupplyCopy()
  const showcase = useShowcaseCopy()
  const locale = useLocale()
  const time = (at: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(at * 1000),
    )
  const titles = {
    ORDERS: showcase.sent,
    ORDRSP: showcase.confirmed,
    DESADV: showcase.shipping,
    INVOIC: s.step.INVOIC,
  }
  const docs = new Map(order.documents.map((doc) => [doc.kind, doc]))
  return (
    <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 0 }}>
      {STEPS.map((kind) => {
        const doc = docs.get(kind)
        const current = !doc && NEXT[order.status] === kind
        const last = false
        return (
          <Box
            component="li"
            key={kind}
            sx={{ display: 'grid', gridTemplateColumns: '32px 1fr', columnGap: 2 }}
          >
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <Box
                aria-hidden="true"
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  bgcolor: doc ? roles.primary : 'transparent',
                  color: doc ? roles.onPrimary : roles.onSurfaceVariant,
                  border: doc ? 'none' : `2px ${current ? 'solid' : 'dashed'} ${roles.outline}`,
                  ...(doc ? stampThud : {}),
                }}
              >
                {doc ? <Check size={16} /> : STEP_ICON[kind]}
              </Box>
              {!last && (
                <Box
                  aria-hidden="true"
                  sx={{
                    flex: 1,
                    width: 2,
                    minHeight: 16,
                    bgcolor: doc ? roles.primary : roles.outlineVariant,
                  }}
                />
              )}
            </Box>
            <Box sx={{ pb: last ? 0 : 3, minWidth: 0 }}>
              <Typography variant="titleSmall" sx={{ lineHeight: '28px' }}>
                {titles[kind]}
                {doc && (
                  <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>
                    {' '}
                    · {time(doc.at)}
                  </Box>
                )}
                {!doc && (
                  <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>
                    {' '}
                    · {s.waiting}
                  </Box>
                )}
              </Typography>
              {doc && (
                <DocumentDetail order={order} doc={doc} busy={busy} act={act} actions={actions} />
              )}
            </Box>
          </Box>
        )
      })}
      <Box component="li" sx={{ display: 'grid', gridTemplateColumns: '32px 1fr', gap: 2 }}>
        <Box
          aria-hidden="true"
          sx={{ display: 'grid', placeItems: 'center', height: 28, color: roles.primary }}
        >
          <PackageCheck size={20} />
        </Box>
        <Typography variant="titleSmall" sx={{ lineHeight: '28px' }}>
          {showcase.received} · {order.received_at ? time(order.received_at) : s.waiting}
        </Typography>
      </Box>
    </Box>
  )
}

function DocumentDetail({
  order,
  doc,
  busy,
  act,
  actions,
}: {
  order: PurchaseOrder
  doc: SupplyDocument
  busy: string | null
  act: Act
  actions: Actions
}) {
  const s = useSupplyCopy()
  const f = useFormat(order)
  const roles = useTheme().material
  const [open, setOpen] = useState(false)
  const outbound = doc.from === 'buyer'
  const theirs = s.system[outbound ? doc.translated_format : doc.raw_format]
  const ours = s.system[outbound ? doc.raw_format : doc.translated_format]
  const open_flags = doc.flags.filter((flag) => flag.resolved === null)
  const changes = doc.kind === 'ORDRSP' ? (order.changes ?? []) : []
  return (
    <Stack spacing={2} sx={{ mt: 0.5, ...enterRise }}>
      <Typography variant="bodySmall" color="text.secondary">
        {outbound ? s.sentAs(theirs) : s.cameAs(theirs)} · {s.reader[doc.reader]}
      </Typography>
      {changes.map((change, index) => {
        const line = order.lines.find((item) => item.line === change.line)
        const unit = line?.unit ?? ''
        const text =
          change.code === 'partial'
            ? s.partial(f.qty(change.now), f.qty(change.later), unit, f.day(change.date ?? ''))
            : change.code === 'substitute'
              ? s.substitute(change.name ?? '')
              : change.code === 'substitute_not_allowed'
                ? s.substituteNotAllowed(change.name ?? '')
                : change.code === 'partial_not_allowed'
                  ? s.partialNotAllowed
                  : change.code === 'backorder_not_allowed'
                    ? s.backorderNotAllowed
                    : change.code === 'price_changed'
                      ? s.priceChanged(f.money(change.was), f.money(change.now))
                      : s.rejected
        const warn = change.code.endsWith('not_allowed')
        return (
          <Typography
            key={`${change.code}-${index}`}
            variant="bodyMedium"
            sx={{
              display: 'flex',
              gap: 1.5,
              alignItems: 'flex-start',
              color: warn ? roles.error : 'text.primary',
            }}
          >
            <Box component="span" aria-hidden="true" sx={{ display: 'flex', mt: 0.25 }}>
              {warn ? <CircleAlert size={16} /> : <ArrowLeftRight size={16} />}
            </Box>
            <span>
              {line ? `${line.item}: ` : ''}
              {text}
            </span>
          </Typography>
        )
      })}
      {doc.kind === 'INVOIC' &&
        (order.match ?? []).map((item, index) => (
          <Typography
            key={`${item.code}-${index}`}
            variant="bodyMedium"
            sx={{ display: 'flex', gap: 1.5, color: roles.error }}
          >
            <CircleAlert size={16} aria-hidden="true" />
            {item.code === 'price' ? s.priceMismatch : s.quantityMismatch}
          </Typography>
        ))}
      {open_flags.length > 0 && (
        <Panel>
          <Typography variant="labelLarge" sx={{ display: 'block', mb: 2 }}>
            {s.toCheck(open_flags.length)}
          </Typography>
          <Stack spacing={3}>
            {open_flags.map((flag) => (
              <FlagRow
                key={flag.id}
                order={order}
                flag={flag}
                disabled={busy !== null}
                onPick={(value) =>
                  void act(`flag-${flag.id}`, () => actions.resolve(order, flag.id, value))
                }
              />
            ))}
          </Stack>
        </Panel>
      )}
      <Box>
        <Button
          size="small"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          startIcon={<ArrowLeftRight size={16} />}
          sx={{ ml: -2, minHeight: 48 }}
        >
          {open ? s.hide : s.forSupplierSystem}
        </Button>
        <Collapse in={open} unmountOnExit>
          <Typography
            variant="labelMedium"
            color="text.secondary"
            sx={{ display: 'block', mt: 1, mb: 1 }}
          >
            {s.viewAs(theirs, ours)}
          </Typography>
          <Box
            sx={{
              mt: 2,
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
              minWidth: 0,
            }}
          >
            <Code label={outbound ? s.sent(ours) : s.theirSide(theirs)} text={doc.raw} />
            <Code
              label={outbound ? s.theyReceive(theirs) : s.yourSide(ours)}
              text={doc.translated}
            />
          </Box>
          {doc.mapping.length > 1 && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="labelMedium" color="text.secondary">
                {s.mapping}
              </Typography>
              <Box
                component="dl"
                sx={{
                  m: 0,
                  mt: 1,
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, auto) minmax(0, 1fr)',
                  columnGap: 2,
                  rowGap: 0.5,
                  fontSize: 12,
                }}
              >
                {doc.mapping.map((row) => (
                  <Box key={row.field} sx={{ display: 'contents' }}>
                    <Box component="dt" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                      {row.field}
                    </Box>
                    <Box
                      component="dd"
                      sx={{ m: 0, fontFamily: 'monospace', overflowWrap: 'anywhere' }}
                    >
                      {row.source}
                    </Box>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
        </Collapse>
      </Box>
    </Stack>
  )
}

export function Code({ label, text }: { label: string; text: string }) {
  const roles = useTheme().material
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="labelMedium" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        {label}
      </Typography>
      <Box
        component="pre"
        tabIndex={0}
        aria-label={label}
        sx={{
          m: 0,
          p: 2,
          maxHeight: 260,
          overflow: 'auto',
          borderRadius: `${shape.sm}px`,
          bgcolor: roles.surfaceContainerHighest,
          color: roles.onSurface,
          fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre',
          '&:focus-visible': { outline: `2px solid ${roles.primary}`, outlineOffset: 2 },
        }}
      >
        {text}
      </Box>
    </Box>
  )
}

function FlagRow({
  order,
  flag,
  disabled,
  onPick,
}: {
  order: PurchaseOrder
  flag: DocFlag
  disabled: boolean
  onPick: (value: string) => void
}) {
  const s = useSupplyCopy()
  const f = useFormat(order)
  const line = order.lines.find((item) => item.line === flag.line)
  const show = (value: string) =>
    flag.reason === 'price' || flag.reason === 'total'
      ? f.money(Number(value))
      : flag.reason === 'date'
        ? f.day(value)
        : flag.reason === 'quantity'
          ? `${f.qty(Number(value))} ${line?.unit ?? ''}`.trim()
          : value
  return (
    <Box>
      <Typography variant="bodyMedium" sx={{ overflowWrap: 'anywhere' }}>
        {line ? `${line.item} · ` : ''}
        {s.flagQuestion(s.flagReason[flag.reason], show(flag.value))}
      </Typography>
      <Stack direction="row" sx={{ mt: 1.5, flexWrap: 'wrap', gap: 1.5 }}>
        {flag.options.map((option) => (
          <Button
            key={option}
            size="small"
            variant="outlined"
            disabled={disabled}
            onClick={() => onPick(option)}
          >
            {show(option)}
          </Button>
        ))}
      </Stack>
    </Box>
  )
}

/** The one thing the owner (or, in the demo, the simulated supplier) does next. */
function NextStep({
  order,
  busy,
  act,
  actions,
}: {
  order: PurchaseOrder
  busy: string | null
  act: Act
  actions: Actions
}) {
  const s = useSupplyCopy()
  const showcase = useShowcaseCopy()
  const f = useFormat(order)
  const roles = useTheme().material
  const [paste, setPaste] = useState(false)
  const [text, setText] = useState('')
  const flags = order.open_flags ?? 0
  const waitingFor = NEXT[order.status]
  const invoiced = Boolean(order.invoiced)
  const sim: { variant: SimVariant; label: string }[] =
    order.status === 'sent'
      ? [
          { variant: 'partial', label: s.simPartial },
          { variant: 'full', label: s.simFull },
          { variant: 'substitute', label: s.simSubstitute },
        ]
      : order.status === 'confirmed'
        ? [{ variant: 'full', label: s.simDispatch }]
        : (order.status === 'dispatched' || order.status === 'received') && !invoiced
          ? [
              { variant: 'price_mismatch', label: s.simInvoiceWrong },
              { variant: 'match', label: s.simInvoice },
            ]
          : []
  const icon = (key: string, node: ReactNode) =>
    busy === key ? <CircularProgress size={16} color="inherit" /> : node
  return (
    <Stack spacing={3}>
      {(order.backorders ?? []).map((item, index) => (
        <Typography key={index} variant="bodyMedium" color="text.secondary">
          {s.backorder(f.qty(item.quantity), item.unit, item.item, f.day(item.date))}
        </Typography>
      ))}
      {order.status === 'changed' && (
        <Stack direction="row" spacing={2} sx={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button
            disabled={busy !== null}
            onClick={() => void act('cancel', () => actions.cancel(order))}
          >
            {s.cancelOrder}
          </Button>
          <Button
            variant="contained"
            disabled={busy !== null || flags > 0}
            onClick={() => void act('accept', () => actions.accept(order))}
            startIcon={icon('accept', <Check size={18} />)}
            sx={{ minHeight: 48 }}
          >
            {s.acceptChanges}
          </Button>
        </Stack>
      )}
      {(order.status === 'dispatched' || (order.status === 'invoiced' && !order.received)) && (
        <Button
          variant={order.status === 'invoiced' ? 'contained' : 'outlined'}
          disabled={busy !== null || flags > 0}
          onClick={() => void act('received', () => actions.received(order))}
          startIcon={icon('received', <PackageCheck size={18} />)}
          sx={{ alignSelf: 'flex-start', minHeight: 48 }}
        >
          {s.goodsArrived}
        </Button>
      )}
      {order.status === 'invoiced' && order.received && (
        <Box>
          {order.disputed && (
            <Typography variant="bodyMedium" sx={{ mb: 2, display: 'flex', gap: 1.5 }}>
              <Check size={16} aria-hidden="true" color={roles.primary} />
              {s.disputed}
            </Typography>
          )}
          <Typography variant="bodySmall" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            {s.invoiceNote}
          </Typography>
          <Button
            variant="contained"
            disabled={busy !== null || flags > 0 || !order.received}
            onClick={() => void act('accept', () => actions.accept(order))}
            startIcon={icon('accept', <Receipt size={18} />)}
            sx={{ minHeight: 48 }}
          >
            {s.approveInvoice} · {f.money(order.invoice_total ?? orderTotal(order))}
          </Button>
        </Box>
      )}
      {order.status === 'closed' && (
        <Typography variant="bodyMedium" sx={{ display: 'flex', gap: 1.5, ...stampThud }}>
          <Check size={18} aria-hidden="true" color={roles.primary} />
          {s.closed}
        </Typography>
      )}
      {waitingFor && !(order.status === 'received' && invoiced) && (
        <Box
          sx={{
            p: 3,
            borderRadius: `${shape.md}px`,
            border: `1px dashed ${roles.outline}`,
          }}
        >
          {order.simulated && sim.length > 0 && (
            <>
              <Button
                variant="contained"
                disabled={busy !== null}
                sx={{ minHeight: 48, mb: 2 }}
                startIcon={
                  busy === 'sim-next' ? <CircularProgress size={16} color="inherit" /> : undefined
                }
                onClick={() =>
                  void act('sim-next', () =>
                    actions.simulate(order, waitingFor === 'INVOIC' ? 'match' : 'full'),
                  )
                }
              >
                {showcase.simulate}
              </Button>
              <Box>
                <Typography
                  variant="labelLarge"
                  sx={{ display: 'flex', gap: 1.5, alignItems: 'center', mb: 2 }}
                >
                  <FlaskConical size={16} aria-hidden="true" />
                  {s.simTitle}
                </Typography>
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1.5, mb: 2 }}>
                  {sim.map((option) => (
                    <Button
                      key={option.variant}
                      size="small"
                      variant="outlined"
                      color="secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(`sim-${option.variant}`, () =>
                          actions.simulate(order, option.variant),
                        )
                      }
                      startIcon={
                        busy === `sim-${option.variant}` ? (
                          <CircularProgress size={14} color="inherit" />
                        ) : undefined
                      }
                    >
                      {option.label}
                    </Button>
                  ))}
                </Stack>
              </Box>
            </>
          )}
          <Button
            size="small"
            onClick={() => setPaste((value) => !value)}
            aria-expanded={paste}
            sx={{ ml: -2 }}
          >
            {s.paste}
          </Button>
          <Collapse in={paste} unmountOnExit>
            <Stack spacing={2} sx={{ mt: 2 }}>
              <TextField
                multiline
                minRows={4}
                maxRows={10}
                value={text}
                onChange={(event) => setText(event.target.value)}
                label={s.pasteLabel}
                slotProps={{ htmlInput: { maxLength: 20_000, spellCheck: false } }}
                sx={{ '& textarea': { fontFamily: 'monospace', fontSize: 12 } }}
              />
              <Button
                variant="outlined"
                disabled={busy !== null || text.trim().length < 10}
                onClick={() =>
                  void act('inbound', async () => {
                    const next = await actions.inbound(order, text)
                    if (next) {
                      setText('')
                      setPaste(false)
                    }
                  })
                }
                startIcon={icon('inbound', <ArrowLeftRight size={16} />)}
                sx={{ alignSelf: 'flex-start' }}
              >
                {busy === 'inbound' ? s.translating : s.translate}
              </Button>
            </Stack>
          </Collapse>
        </Box>
      )}
    </Stack>
  )
}
