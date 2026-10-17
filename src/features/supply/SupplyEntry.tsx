import { useState } from 'react'
import { Box, Button, Stack, Typography, useTheme } from '@mui/material'
import { CircleCheck } from 'lucide-react'
import { shape } from '../../design/theme'
import { useIoCopy } from './ioCopy'
import { useBoard, useIoActions, useUndoableSend } from './ioData'
import type { IoOrder, View } from './ioTypes'
import { OrderCard, TaskCard } from './IoParts'
import { OrderSheet } from './OrderSheet'
import { SupplyHub } from './SupplyHub'

/** Today: exceptions float up (shortages, changes, late, unsent); on-time documents stay quiet. */
export function TodaySupplyNeeds() {
  const c = useIoCopy()
  const roles = useTheme().material
  const { board } = useBoard(true)
  const [open, setOpen] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(null)
  const tasks = board?.tasks ?? []
  if (!tasks.length) return null
  const order = board?.orders.find((o) => o.id === orderId) ?? null
  return (
    <>
      <Stack
        component="section"
        aria-label={c.question.needs}
        spacing={2}
        sx={{ p: 4, borderRadius: `${shape.lg}px`, bgcolor: roles.surfaceContainerLow }}
      >
        <Typography variant="titleMedium" component="h2">
          {c.needsNow(tasks.length)}
        </Typography>
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 2 }}>
          {tasks.slice(0, 3).map((task, i) => (
            <li key={`${task.code}-${task.order_id ?? task.entry_id}-${i}`}>
              <TaskCard
                task={task}
                onOpen={() => (task.order_id ? setOrderId(task.order_id) : setOpen(true))}
              />
            </li>
          ))}
        </Box>
        <Button onClick={() => setOpen(true)} sx={{ alignSelf: 'flex-start', minHeight: 48 }}>
          {c.action.open}: {c.title}
        </Button>
      </Stack>
      <SupplyHub open={open} onClose={() => setOpen(false)} />
      <OrderSheet order={order} open={order !== null} onClose={() => setOrderId(null)} />
    </>
  )
}

/** Close the day: received but not confirmed, or shipped without a notice? Send in one tap. */
export function CloseDaySupply() {
  const c = useIoCopy()
  const roles = useTheme().material
  const { board } = useBoard(true)
  const actions = useIoActions()
  const sending = useUndoableSend()
  if (!board) return null
  const unsent = board.unsent
  const active = board.orders.some((o) => o.documents.some((d) => d.direction === 'out'))
  if (!unsent.length && !active) return null
  return (
    <Box
      component="section"
      aria-label={c.beforeClose}
      sx={{
        p: 3,
        mb: 3,
        borderRadius: `${shape.md}px`,
        bgcolor: unsent.length ? roles.secondaryContainer : roles.surfaceContainerLow,
        color: unsent.length ? roles.onSecondaryContainer : roles.onSurface,
      }}
    >
      {unsent.length === 0 ? (
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }} role="status">
          <CircleCheck size={20} aria-hidden="true" />
          <Typography variant="titleSmall">{c.allSent}</Typography>
        </Stack>
      ) : (
        <Stack spacing={2}>
          <Typography variant="titleSmall" component="h3">
            {c.beforeClose}: {c.notSent(unsent.length)}
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 5 }}>
            {unsent.slice(0, 5).map((row) => (
              <Typography component="li" variant="bodyMedium" key={`${row.order_id}-${row.kind}`}>
                {c.kind[row.kind]} · {row.partner}
              </Typography>
            ))}
          </Box>
          {sending.left !== null ? (
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <Typography variant="bodyMedium" aria-live="polite">
                {c.sendingIn(sending.left)}
              </Typography>
              <Button variant="contained" onClick={sending.undo} sx={{ minHeight: 48 }}>
                {c.action.undo}
              </Button>
            </Stack>
          ) : (
            <Button
              variant="contained"
              onClick={() => sending.start(() => actions.sendAll())}
              sx={{ alignSelf: 'flex-start', minHeight: 48 }}
            >
              {c.action.sendAll(unsent.length)}
            </Button>
          )}
        </Stack>
      )}
    </Box>
  )
}

export interface SupplyCardData {
  view: View | 'order' | 'sap'
  order: IoOrder | null
  document_id?: string
}

/** A coach chat card: the order it acted on (tap for the detail), or the supply screens. */
export function SupplyChatCard({ data }: { data: SupplyCardData }) {
  const c = useIoCopy()
  const { board } = useBoard(true)
  const [open, setOpen] = useState(data.view === 'sap')
  const latest = (data.order && board?.orders.find((o) => o.id === data.order!.id)) || data.order
  if (latest)
    return (
      <>
        <OrderCard order={latest} onOpen={() => setOpen(true)} />
        <OrderSheet
          order={latest}
          open={open}
          onClose={() => setOpen(false)}
          sapDocId={data.view === 'sap' ? data.document_id : undefined}
        />
      </>
    )
  const view: View = data.view === 'order' || data.view === 'sap' ? 'needs' : data.view
  return (
    <>
      <Button variant="outlined" onClick={() => setOpen(true)} sx={{ minHeight: 48 }}>
        {c.action.open}: {c.tabs[view]}
      </Button>
      <SupplyHub open={open} onClose={() => setOpen(false)} initial={view} />
    </>
  )
}
