import { useState, type ReactNode } from 'react'
import {
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  Stack,
  Typography,
  useTheme,
} from '@mui/material'
import { Truck } from 'lucide-react'
import { shape } from '../../design/theme'
import { Sheet } from '../v1/Sheet'
import { Supporting, Tile } from '../v1/ShopTiles'
import { useIoCopy } from './ioCopy'
import { useBoard, useIoActions, useUndoableSend } from './ioData'
import type { Board, IoOrder, Unsent, View } from './ioTypes'
import { Card, EntryCard, OrderCard, Section, TaskCard } from './IoParts'
import { counts, onTheWay, useIoFormat } from './ioFormat'
import { OrderSheet } from './OrderSheet'

const VIEWS: View[] = ['needs', 'coming', 'received', 'send']
const SHOWN = 5

/** Grow: the Supply chain tile (what needs the owner, in one number). */
export function SupplyHubTile() {
  const c = useIoCopy()
  const [open, setOpen] = useState(false)
  const { board } = useBoard(true)
  const n = counts(board)
  return (
    <>
      <Tile
        icon={<Truck size={20} />}
        label={c.title}
        value={board === null ? '–' : n.needs ? c.needsNow(n.needs) : c.allQuiet}
        onClick={() => setOpen(true)}
      >
        <Supporting>{n.send ? c.notSent(n.send) : c.empty.send}</Supporting>
      </Tile>
      <SupplyHub open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/** Four screens, one owner question each: needs me now, coming in, received, must send. */
export function SupplyHub({
  open,
  onClose,
  initial = 'needs',
}: {
  open: boolean
  onClose: () => void
  initial?: View
}) {
  const c = useIoCopy()
  const { board, failed, refresh } = useBoard(open)
  const [view, setView] = useState<View>(initial)
  const [orderId, setOrderId] = useState<string | null>(null)
  const sendAll = useUndoableSend()
  const actions = useIoActions()
  const n = counts(board)
  const order = board?.orders.find((o) => o.id === orderId) ?? null
  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        titleId="supply-hub-title"
        title={c.title}
        actions={
          view === 'send' && n.send > 0 ? (
            sendAll.left !== null ? (
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <Typography variant="bodyMedium" aria-live="polite">
                  {c.sendingIn(sendAll.left)}
                </Typography>
                <Button variant="contained" onClick={sendAll.undo} sx={{ minHeight: 48 }}>
                  {c.action.undo}
                </Button>
              </Stack>
            ) : (
              <Button
                variant="contained"
                onClick={() => sendAll.start(() => actions.sendAll())}
                sx={{ minHeight: 48 }}
              >
                {c.action.sendAll(n.send)}
              </Button>
            )
          ) : undefined
        }
      >
        <Stack spacing={4}>
          <Box
            role="group"
            aria-label={c.title}
            sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2 }}
          >
            {VIEWS.map((v) => (
              <ViewButton
                key={v}
                view={v}
                count={n[v]}
                active={v === view}
                onClick={() => setView(v)}
              />
            ))}
          </Box>
          <Typography variant="titleLarge" component="h3">
            {c.question[view]}
          </Typography>
          {!board ? (
            failed ? (
              <Stack spacing={2} sx={{ alignItems: 'flex-start' }} role="alert">
                <Typography>{c.failed}</Typography>
                <Button variant="outlined" onClick={() => void refresh()} sx={{ minHeight: 48 }}>
                  {c.action.retry}
                </Button>
              </Stack>
            ) : (
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }} aria-busy="true">
                <CircularProgress size={20} />
                <Typography>{c.loading}</Typography>
              </Stack>
            )
          ) : (
            <Screen board={board} view={view} open={setOrderId} />
          )}
        </Stack>
      </Sheet>
      <OrderSheet order={order} open={order !== null} onClose={() => setOrderId(null)} />
    </>
  )
}

function ViewButton({
  view,
  count,
  active,
  onClick,
}: {
  view: View
  count: number
  active: boolean
  onClick: () => void
}) {
  const roles = useTheme().material
  const c = useIoCopy()
  return (
    <ButtonBase
      aria-pressed={active}
      onClick={onClick}
      sx={{
        minHeight: 48,
        px: 3,
        py: 2,
        gap: 2,
        justifyContent: 'space-between',
        borderRadius: `${shape.md}px`,
        border: `1px solid ${active ? roles.secondaryContainer : roles.outlineVariant}`,
        bgcolor: active ? roles.secondaryContainer : 'transparent',
        color: active ? roles.onSecondaryContainer : roles.onSurface,
        typography: 'labelLarge',
        textAlign: 'left',
        '&:focus-visible': { outline: `2px solid ${roles.primary}`, outlineOffset: 2 },
      }}
    >
      <span>{c.tabs[view]}</span>
      {count > 0 && (
        <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {count}
        </Box>
      )}
    </ButtonBase>
  )
}

type Item = { key: string; node: ReactNode }

function Screen({ board, view, open }: { board: Board; view: View; open: (id: string) => void }) {
  const c = useIoCopy()
  const f = useIoFormat()
  const actions = useIoActions()
  const order = (o: IoOrder): Item => ({
    key: o.id,
    node: <OrderCard order={o} onOpen={() => open(o.id)} />,
  })
  const groups: { title?: string; items: Item[] }[] =
    view === 'needs'
      ? [
          {
            items: board.tasks.map((task, i) => ({
              key: `${task.code}-${task.order_id ?? task.entry_id}-${i}`,
              node: task.order_id ? (
                <TaskCard task={task} onOpen={() => open(task.order_id!)} />
              ) : (
                <Stack spacing={1}>
                  <TaskCard task={task} />
                  {task.entry_id && (
                    <Button
                      onClick={() => void actions.dismiss(task.entry_id!)}
                      sx={{ alignSelf: 'flex-start', minHeight: 48 }}
                    >
                      {c.action.dismiss}
                    </Button>
                  )}
                </Stack>
              ),
            })),
          },
        ]
      : view === 'coming'
        ? [
            {
              title: c.onTheWay,
              items: board.orders.filter(onTheWay).map(order),
            },
            {
              title: c.fromPartners,
              items: board.inbox.map((entry) => ({
                key: entry.id,
                node: (
                  <EntryCard
                    entry={entry}
                    onOpen={entry.order_id ? () => open(entry.order_id) : undefined}
                  />
                ),
              })),
            },
          ]
        : view === 'received'
          ? [{ items: board.orders.filter((o) => o.direction === 'in' && o.received).map(order) }]
          : [
              {
                items: board.unsent.map((row: Unsent) => ({
                  key: `${row.order_id}-${row.kind}`,
                  node: (
                    <Card
                      title={row.partner}
                      chip={row.short.length ? 'problem' : 'needs_you'}
                      amount={
                        row.lines[0]
                          ? `${f.qty(row.lines[0].quantity)} ${row.lines[0].unit}`
                          : undefined
                      }
                      detail={[c.kind[row.kind], row.lines[0]?.item].filter(Boolean).join(' · ')}
                      onOpen={() => open(row.order_id)}
                    />
                  ),
                })),
              },
            ]
  const filled = groups.filter((group) => group.items.length)
  return (
    <Stack spacing={4}>
      {filled.length === 0 && <Typography color="text.secondary">{c.empty[view]}</Typography>}
      {filled.map((group) => (
        <Group key={group.title ?? view} title={group.title} items={group.items} />
      ))}
      {view === 'coming' && (board.demo || import.meta.env.DEV) && (
        <Button
          variant="outlined"
          onClick={() => void actions.demoNext()}
          sx={{ alignSelf: 'flex-start', minHeight: 48 }}
        >
          {c.action.demo}
        </Button>
      )}
    </Stack>
  )
}

/** At most five cards open at once; the rest behind "Show all items" (UX rule 3). */
function Group({ title, items }: { title?: string; items: Item[] }) {
  const c = useIoCopy()
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, SHOWN)
  return (
    <Stack spacing={2}>
      <Section title={title}>
        {shown.map((item) => (
          <li key={item.key}>{item.node}</li>
        ))}
      </Section>
      {items.length > SHOWN && (
        <Button onClick={() => setAll(!all)} sx={{ alignSelf: 'flex-start', minHeight: 48 }}>
          {all ? c.showFewer : c.showAll(items.length)}
        </Button>
      )}
    </Stack>
  )
}
