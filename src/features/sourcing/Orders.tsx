import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Badge,
  Box,
  Button,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
  useTheme,
} from '@mui/material'
import { ArrowLeft, ArrowUp, PackageCheck, Truck } from 'lucide-react'
import { useLocale } from '../../state/hooks'
import { enterRise, shape } from '../../design/theme'
import { formatPrice } from '../v1/format'
import { Sheet } from '../v1/Sheet'
import { Supporting, Tile } from '../v1/ShopTiles'
import { useWorkspace } from '../v1/workspaceContext'
import { useSourcingCopy } from './copy'
import { deliveryLabel, useOrders, useReceiveOrder } from './orderData'
import { DemoChip, StatusChip } from './SourcingCards'
import type { Order } from './types'
import { track } from '../../app/analytics'

const OPEN = new Set(['sent', 'needs_reply', 'confirmed'])

/** My shop: the Orders tile, opening the Orders sheet. */
export function OrdersTile() {
  const s = useSourcingCopy()
  const [open, setOpen] = useState(false)
  const { orders, refresh } = useOrders(false)
  const active = (orders ?? []).filter((order) => OPEN.has(order.status))
  const unread = (orders ?? []).filter((order) => order.unread).length
  const latest = orders?.[0]
  return (
    <>
      <Tile
        tour="orders"
        icon={
          <Badge badgeContent={unread} color="primary" aria-hidden="true">
            <Truck size={20} />
          </Badge>
        }
        label={s.orders}
        value={orders === null ? '–' : s.ordersValue(active.length)}
        onClick={() => {
          track('purchase_orders_opened')
          setOpen(true)
        }}
      >
        {latest && (
          <Supporting>
            {latest.supplier.name} · {s.status[latest.status]}
          </Supporting>
        )}
      </Tile>
      <OrdersSheet
        open={open}
        onClose={() => {
          setOpen(false)
          void refresh()
        }}
        onChanged={() => void refresh()}
      />
    </>
  )
}

/** The list of orders, or one supplier conversation when `orderId` is set. */
export function OrdersSheet({
  open,
  onClose,
  orderId = null,
  onChanged,
}: {
  open: boolean
  onClose: () => void
  orderId?: string | null
  /** An order changed after the sheet closed (e.g. marked received). */
  onChanged?: () => void
}) {
  const s = useSourcingCopy()
  const locale = useLocale()
  const roles = useTheme().material
  const { orders, refresh } = useOrders(open)
  const [picked, setPicked] = useState<string | null>(null)
  // Opening on one order (from the chat) shows its thread first.
  const [seen, setSeen] = useState<string | null>(null)
  if (open && orderId !== seen) {
    setSeen(orderId)
    setPicked(orderId)
  }
  const selected = orders?.find((order) => order.id === picked) ?? null
  const receiveOrder = useReceiveOrder()
  function close() {
    setPicked(null)
    setSeen(null)
    onClose()
  }
  return (
    <Sheet
      open={open}
      onClose={close}
      titleId="orders-sheet-title"
      title={
        selected ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <IconButton aria-label={s.orders} onClick={() => setPicked(null)} sx={{ ml: -2 }}>
              <ArrowLeft size={20} />
            </IconButton>
            <Box component="span" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {selected.supplier.name}
            </Box>
            {selected.supplier.demo && <DemoChip />}
          </Stack>
        ) : (
          s.orders
        )
      }
    >
      {selected ? (
        <Thread
          key={selected.id}
          order={selected}
          onChange={refresh}
          onReceived={(order) => {
            // The stock review is its own dialog; close this sheet first so modals never stack.
            close()
            void receiveOrder(order).then(() => onChanged?.())
          }}
        />
      ) : orders && orders.length === 0 ? (
        <Typography variant="bodyLarge" color="text.secondary">
          {s.ordersEmpty}
        </Typography>
      ) : (
        <List disablePadding sx={{ display: 'grid', gap: 2 }}>
          {(orders ?? []).map((order, index) => (
            <ListItem key={order.id} disablePadding>
              <ListItemButton
                component="button"
                onClick={() => setPicked(order.id)}
                sx={{
                  borderRadius: `${shape.lg}px`,
                  bgcolor: roles.surfaceContainer,
                  alignItems: 'flex-start',
                  gap: 3,
                  py: 3,
                  width: '100%',
                  textAlign: 'start',
                  ...enterRise,
                  animationDelay: `${index * 50}ms`,
                }}
              >
                <Badge
                  variant="dot"
                  color="primary"
                  invisible={!order.unread}
                  sx={{ mt: 1 }}
                  aria-hidden="true"
                >
                  <Truck size={20} color={roles.primary} />
                </Badge>
                <ListItemText
                  primary={
                    <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                      <Box
                        component="span"
                        sx={{ flex: 1, minWidth: 0, fontWeight: order.unread ? 700 : 500 }}
                      >
                        {order.supplier.name}
                      </Box>
                      <StatusChip status={order.status} />
                    </Stack>
                  }
                  secondary={
                    <>
                      {order.lines
                        .map((line) => `${line.quantity} ${line.unit} ${line.name}`)
                        .join(', ')}
                      <Box component="span" sx={{ display: 'block' }}>
                        {formatPrice(order.total, order.currency, locale)} ·{' '}
                        {deliveryLabel(order, locale)}
                      </Box>
                    </>
                  }
                  slotProps={{
                    primary: { component: 'div' },
                    secondary: { component: 'div' },
                  }}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      )}
    </Sheet>
  )
}

/** One supplier conversation: the structured request, replies, and a composer. */
function Thread({
  order,
  onChange,
  onReceived,
}: {
  order: Order
  onChange: () => Promise<void>
  onReceived: (order: Order) => void
}) {
  const { api, activeId } = useWorkspace()
  const s = useSourcingCopy()
  const locale = useLocale()
  const roles = useTheme().material
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const base = `/businesses/${encodeURIComponent(activeId ?? '')}/orders/${encodeURIComponent(order.id)}`
  const unread = order.unread
  useEffect(() => {
    if (unread)
      void api(`${base}/read`, { method: 'POST' })
        .then(onChange)
        .catch(() => undefined)
  }, [api, base, unread, onChange])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [order.messages.length])
  async function submit(event: FormEvent) {
    event.preventDefault()
    const message = text.trim()
    if (!message || busy) return
    setBusy(true)
    setError('')
    try {
      await api(`${base}/messages`, { method: 'POST', body: JSON.stringify({ text: message }) })
      setText('')
      await onChange()
    } catch {
      setError(s.sendFailed)
    } finally {
      setBusy(false)
    }
  }
  const closed =
    order.status === 'cancelled' || order.status === 'replaced' || order.status === 'received'
  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <StatusChip status={order.status} />
        <Typography variant="bodyMedium" color="text.secondary" sx={{ flex: 1 }}>
          {formatPrice(order.total, order.currency, locale)} · {deliveryLabel(order, locale)}
        </Typography>
      </Stack>
      <Stack component="ol" spacing={2} sx={{ listStyle: 'none', m: 0, p: 0 }} aria-live="polite">
        {order.messages.map((message) => {
          const mine = message.author === 'owner'
          return (
            <Box
              component="li"
              key={message.id}
              sx={{
                display: 'flex',
                justifyContent: mine ? 'flex-end' : 'flex-start',
                ...enterRise,
              }}
            >
              <Box
                sx={{
                  maxWidth: '85%',
                  px: 3,
                  py: 2,
                  borderRadius: mine
                    ? `${shape.xl}px ${shape.xs}px ${shape.xl}px ${shape.xl}px`
                    : `${shape.xs}px ${shape.xl}px ${shape.xl}px ${shape.xl}px`,
                  bgcolor: mine ? roles.primaryContainer : roles.surfaceContainerHigh,
                  color: mine ? roles.onPrimaryContainer : roles.onSurface,
                }}
              >
                {message.kind === 'order' && (
                  <Typography variant="labelMedium" sx={{ display: 'block', opacity: 0.8 }}>
                    {s.orderRequest}
                  </Typography>
                )}
                <Typography
                  variant="bodyLarge"
                  sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                >
                  {message.text}
                </Typography>
                <Typography variant="labelSmall" sx={{ display: 'block', opacity: 0.75, mt: 0.5 }}>
                  {mine ? s.you : order.supplier.name}
                  {message.auto ? ` · ${s.autoReply}` : ''} ·{' '}
                  {new Date(message.created * 1000).toLocaleTimeString(locale, {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </Typography>
              </Box>
            </Box>
          )
        })}
        {order.reply_due != null && (
          <Typography component="li" variant="bodySmall" color="text.secondary">
            {s.waiting}
          </Typography>
        )}
      </Stack>
      <div ref={end} />
      {(order.status === 'confirmed' ||
        order.status === 'needs_reply' ||
        order.status === 'sent') && (
        <Button
          variant="outlined"
          startIcon={<PackageCheck size={18} />}
          onClick={() => onReceived(order)}
          sx={{ alignSelf: 'flex-start' }}
        >
          {s.markReceived}
        </Button>
      )}
      {!closed && (
        <Box
          component="form"
          onSubmit={submit}
          sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}
        >
          <TextField
            fullWidth
            multiline
            maxRows={4}
            size="small"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={s.threadPlaceholder}
            slotProps={{ htmlInput: { maxLength: 500, 'aria-label': s.threadPlaceholder } }}
            error={Boolean(error)}
            helperText={error || undefined}
          />
          <IconButton
            type="submit"
            aria-label={s.send}
            disabled={!text.trim() || busy}
            sx={{
              bgcolor: text.trim() ? roles.primary : 'transparent',
              color: text.trim() ? roles.onPrimary : undefined,
              '&:hover': { bgcolor: text.trim() ? roles.primary : undefined },
            }}
          >
            <ArrowUp size={20} />
          </IconButton>
        </Box>
      )}
      {closed && (
        <Button disabled sx={{ alignSelf: 'flex-start' }}>
          {s.status[order.status]}
        </Button>
      )}
    </Stack>
  )
}
