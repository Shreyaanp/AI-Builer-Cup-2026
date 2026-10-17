import { useState } from 'react'
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
  useTheme,
} from '@mui/material'
import { Minus, Plus } from 'lucide-react'
import { shape } from '../../design/theme'
import { Sheet } from '../v1/Sheet'
import { useIoCopy } from './ioCopy'
import { useIoActions, useUndoableSend } from './ioData'
import type { IoDocument, IoOrder } from './ioTypes'
import { SapView, StatusChip, Timeline } from './IoParts'
import { changeText, problemText, useIoFormat } from './ioFormat'

const RECEIVABLE = new Set(['sent', 'changed', 'confirmed', 'dispatched', 'invoiced', 'received'])
const SHOWN = 5

const outbound = (order: IoOrder) => order.documents.filter((d) => d.direction === 'out')
const pendingDoc = (order: IoOrder) => outbound(order).find((d) => d.status === 'pending')
const hasReceipt = (order: IoOrder) => outbound(order).some((d) => d.kind === 'RECEIPT')
const hasAsn = (order: IoOrder) => outbound(order).some((d) => d.kind === 'DESADV')

/** The detail of one order: what changed or is wrong first, then the one next action. */
export function OrderSheet({
  order: given,
  open,
  onClose,
  sapDocId,
}: {
  order: IoOrder | null
  open: boolean
  onClose: () => void
  /** Open straight on the SAP view of this document (from the coach chat). */
  sapDocId?: string
}) {
  const [mine, setMine] = useState<IoOrder | null>(null)
  // Only a full view (status, timeline) replaces the board's copy; the board refreshes anyway.
  const adopt = (next: IoOrder) => {
    if (next.timeline && next.chip) setMine(next)
  }
  const order = mine && given && mine.id === given.id && mine.version > given.version ? mine : given
  return (
    <Sheet
      open={open && order !== null}
      onClose={() => {
        setMine(null)
        onClose()
      }}
      titleId="supply-order-title"
      title={order?.partner.name}
      actions={order ? <NextAction order={order} onChange={adopt} /> : undefined}
    >
      {order && <Detail order={order} onChange={adopt} sapDocId={sapDocId} />}
    </Sheet>
  )
}

function Detail({
  order,
  onChange,
  sapDocId,
}: {
  order: IoOrder
  onChange: (order: IoOrder) => void
  sapDocId?: string
}) {
  const roles = useTheme().material
  const c = useIoCopy()
  const f = useIoFormat(order.currency)
  const [all, setAll] = useState(false)
  const [sap, setSap] = useState<string | null>(sapDocId ?? null)
  const pending = pendingDoc(order)
  const changes = order.pending_change?.changes ?? []
  const wrong = [
    order.problem ? problemText(order.problem, c) : '',
    ...(pending?.short ?? []).map((x) => c.short(f.qty(x.quantity), x.unit, x.item)),
    ...(order.chip === 'problem' && !order.problem && !pending?.short?.length && order.delivery
      ? [c.problem.late(f.day(order.delivery))]
      : []),
  ].filter(Boolean)
  const lines = all ? order.lines : order.lines.slice(0, SHOWN)
  const sapDoc =
    order.documents.find((d) => d.id === sap) ??
    [...order.documents]
      .reverse()
      .find((d) => d.translated_format === 'idoc' || d.raw_format === 'idoc') ??
    order.documents[order.documents.length - 1]
  return (
    <Stack spacing={4}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <StatusChip chip={order.chip} />
        <Typography variant="bodyMedium" color="text.secondary">
          {c.order(order.number)} · {c.direction[order.direction]}
          {order.delivery ? ` · ${f.day(order.delivery)}` : ''}
        </Typography>
      </Stack>
      {(changes.length > 0 || wrong.length > 0) && (
        <Box
          role="status"
          sx={{
            p: 3,
            borderRadius: `${shape.md}px`,
            bgcolor: wrong.length ? roles.errorContainer : roles.secondaryContainer,
            color: wrong.length ? roles.onErrorContainer : roles.onSecondaryContainer,
          }}
        >
          {changes.length > 0 && (
            <Typography variant="labelLarge" component="p">
              {c.kind.ORDER_CHANGE}
            </Typography>
          )}
          {[...changes.map((x) => changeText(x, c, f)), ...wrong].filter(Boolean).map((text) => (
            <Typography key={text} variant="titleMedium" component="p" sx={{ mt: 1 }}>
              {text}
            </Typography>
          ))}
        </Box>
      )}
      {pending && <Preview order={order} doc={pending} />}
      <ReceiveOrItems order={order} onChange={onChange} lines={lines} />
      {order.lines.length > SHOWN && (
        <Button onClick={() => setAll(!all)} sx={{ alignSelf: 'flex-start', minHeight: 48 }}>
          {all ? c.showFewer : c.showAll(order.lines.length)}
        </Button>
      )}
      <Timeline steps={order.timeline} />
      {sapDoc && (
        <Button onClick={() => setSap(sapDoc.id)} sx={{ alignSelf: 'flex-start', minHeight: 48 }}>
          {c.action.sap}
        </Button>
      )}
      <Sheet
        open={sap !== null}
        onClose={() => setSap(null)}
        titleId="supply-sap-title"
        title={c.action.sap}
      >
        {sapDoc && <SapView order={order} doc={sapDoc} />}
      </Sheet>
    </Stack>
  )
}

/** What will be sent, before it is sent (UX rule 9). */
function Preview({ order, doc }: { order: IoOrder; doc: IoDocument }) {
  const roles = useTheme().material
  const c = useIoCopy()
  const f = useIoFormat(order.currency)
  return (
    <Box sx={{ p: 3, borderRadius: `${shape.md}px`, bgcolor: roles.surfaceContainerHigh }}>
      <Typography variant="titleSmall" component="p">
        {c.willSend(c.kind[doc.kind], order.partner.name, c.format[doc.translated_format])}
      </Typography>
      {(doc.canonical?.lines ?? []).slice(0, SHOWN).map((line) => (
        <Typography
          key={line.line}
          variant="bodyLarge"
          sx={{ mt: 1, fontVariantNumeric: 'tabular-nums' }}
        >
          {f.qty(line.quantity)} {line.unit} {line.item}
        </Typography>
      ))}
      {order.partner.demo && (
        <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 1 }}>
          {c.simulated}
        </Typography>
      )}
    </Box>
  )
}

/** Receiving: pre-filled with what should arrive; the owner fixes only the differences. */
function ReceiveOrItems({
  order,
  onChange,
  lines,
}: {
  order: IoOrder
  onChange: (order: IoOrder) => void
  lines: IoOrder['lines']
}) {
  const c = useIoCopy()
  const f = useIoFormat(order.currency)
  const actions = useIoActions()
  const [counts, setCounts] = useState<Record<number, number> | null>(null)
  const [busy, setBusy] = useState(false)
  const receiving = counts !== null
  const expected = (line: number) => order.expected[String(line)] ?? 0
  const canReceive =
    order.direction === 'in' &&
    RECEIVABLE.has(order.status) &&
    !order.received &&
    !hasReceipt(order)
  async function save(received: Record<number, number>) {
    setBusy(true)
    const result = await actions.receipt(order, received)
    setBusy(false)
    if (result) {
      onChange(result.order)
      setCounts(null)
    }
  }
  if (!receiving)
    return (
      <Stack spacing={2}>
        {lines.map((line) => (
          <Stack key={line.line} direction="row" spacing={2} sx={{ alignItems: 'baseline' }}>
            <Typography
              variant="titleLarge"
              component="span"
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {f.qty(line.quantity)} {line.unit}
            </Typography>
            <Typography variant="bodyLarge" sx={{ overflowWrap: 'anywhere' }}>
              {line.item}
            </Typography>
          </Stack>
        ))}
        {canReceive && (
          <Button
            variant="outlined"
            onClick={() =>
              setCounts(Object.fromEntries(order.lines.map((l) => [l.line, expected(l.line)])))
            }
            sx={{ alignSelf: 'flex-start', minHeight: 48 }}
          >
            {c.action.receive}
          </Button>
        )}
      </Stack>
    )
  const differs = order.lines.some((l) => counts[l.line] !== expected(l.line))
  return (
    <Stack spacing={3} component="section" aria-label={c.action.receive}>
      <Typography variant="bodyMedium" color="text.secondary">
        {c.fixOnly}
      </Typography>
      {lines.map((line) => {
        const value = counts[line.line] ?? 0
        const set = (next: number) => setCounts({ ...counts, [line.line]: Math.max(0, next) })
        return (
          <Box
            key={line.line}
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              gap: 2,
              alignItems: 'center',
            }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="bodyLarge" sx={{ overflowWrap: 'anywhere' }}>
                {line.item}
              </Typography>
              <Typography variant="bodySmall" color="text.secondary">
                {c.of(f.qty(expected(line.line)), line.unit)}
              </Typography>
            </Box>
            <Stack direction="row" sx={{ alignItems: 'center' }}>
              <IconButton
                aria-label={c.less(line.item)}
                onClick={() => set(value - 1)}
                sx={{ width: 48, height: 48 }}
              >
                <Minus size={20} />
              </IconButton>
              <Typography
                variant="titleLarge"
                component="output"
                aria-live="polite"
                sx={{ minWidth: 48, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
              >
                {f.qty(value)}
              </Typography>
              <IconButton
                aria-label={c.more(line.item)}
                onClick={() => set(value + 1)}
                sx={{ width: 48, height: 48 }}
              >
                <Plus size={20} />
              </IconButton>
            </Stack>
          </Box>
        )
      })}
      <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', rowGap: 2 }}>
        <Button
          variant={differs ? 'outlined' : 'contained'}
          disabled={busy}
          onClick={() => void save({})}
          sx={{ minHeight: 48 }}
        >
          {c.action.allReceived}
        </Button>
        {differs && (
          <Button
            variant="contained"
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
            onClick={() => void save(counts)}
            sx={{ minHeight: 48 }}
          >
            {c.action.saveReceipt}
          </Button>
        )}
      </Stack>
    </Stack>
  )
}

/** The one primary action, in the sheet's bottom row (thumb zone). */
function NextAction({ order, onChange }: { order: IoOrder; onChange: (order: IoOrder) => void }) {
  const c = useIoCopy()
  const actions = useIoActions()
  const sending = useUndoableSend()
  const [busy, setBusy] = useState(false)
  const pending = pendingDoc(order)
  async function act(run: () => Promise<IoOrder | { order: IoOrder } | null>) {
    setBusy(true)
    const result = await run()
    setBusy(false)
    if (result) onChange('order' in result ? result.order : result)
  }
  const button = (label: string, run: () => Promise<IoOrder | { order: IoOrder } | null>) => (
    <Button
      variant="contained"
      disabled={busy}
      startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
      onClick={() => void act(run)}
      sx={{ minHeight: 48 }}
    >
      {label}
    </Button>
  )
  if (sending.left !== null)
    return (
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <Typography variant="bodyMedium" aria-live="polite">
          {c.sendingIn(sending.left)}
        </Typography>
        <Button variant="contained" onClick={sending.undo} sx={{ minHeight: 48 }}>
          {c.action.undo}
        </Button>
      </Stack>
    )
  if (order.pending_change)
    return (
      <>
        <Button
          disabled={busy}
          onClick={() => void act(() => actions.answer(order, false))}
          sx={{ minHeight: 48 }}
        >
          {c.action.decline}
        </Button>
        {button(c.action.accept, () => actions.answer(order, true))}
      </>
    )
  if (order.status === 'draft') return button(c.action.approve, () => actions.approve(order))
  if (pending)
    return (
      <Button
        variant="contained"
        onClick={() => sending.start(() => act(() => actions.send(order, pending.id)))}
        sx={{ minHeight: 48 }}
      >
        {pending.kind === 'RECEIPT' ? c.action.sendReceipt : c.action.prepareAsn}
      </Button>
    )
  if (order.direction === 'in' && order.received && !hasReceipt(order)) {
    const received = Object.fromEntries(
      Object.entries(order.received_lines ?? {}).map(([line, qty]) => [Number(line), qty]),
    )
    return button(c.action.sendReceipt, () => actions.receipt(order, received))
  }
  if (
    order.direction === 'out' &&
    !['closed', 'cancelled'].includes(order.status) &&
    !hasAsn(order)
  )
    return button(c.action.prepareAsn, () => actions.asn(order))
  return null
}
