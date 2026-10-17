import type { ReactNode } from 'react'
import { Box, ButtonBase, Stack, Typography, useTheme } from '@mui/material'
import { ChevronRight } from 'lucide-react'
import { shape } from '../../design/theme'
import { Code } from './PurchaseOrderCard'
import { useIoCopy } from './ioCopy'
import { changeText, problemText, taskDetail, useIoFormat, type IoFormat } from './ioFormat'
import type { Chip, InboxEntry, IoDocument, IoOrder, Step, Task } from './ioTypes'

const TONE: Record<Chip, 'tertiary' | 'primary' | 'neutral' | 'secondary' | 'error'> = {
  new: 'tertiary',
  needs_you: 'primary',
  sent: 'neutral',
  done: 'secondary',
  problem: 'error',
}

/** The five statuses, the same colours everywhere (UX rule 5). */
export function StatusChip({ chip }: { chip: Chip }) {
  const roles = useTheme().material
  const c = useIoCopy()
  const colors = {
    tertiary: [roles.tertiaryContainer, roles.onTertiaryContainer],
    primary: [roles.primary, roles.onPrimary],
    neutral: [roles.surfaceContainerHighest, roles.onSurfaceVariant],
    secondary: [roles.secondaryContainer, roles.onSecondaryContainer],
    error: [roles.errorContainer, roles.onErrorContainer],
  }[TONE[chip] ?? 'neutral']
  return (
    <Box
      component="span"
      sx={{
        flexShrink: 0,
        px: 2,
        py: 0.5,
        borderRadius: `${shape.sm}px`,
        bgcolor: colors[0],
        color: colors[1],
        typography: 'labelMedium',
        whiteSpace: 'nowrap',
      }}
    >
      {c.status[chip] ?? c.status.sent}
    </Box>
  )
}

/** A card: who, what, how much, when, status. Two lines at most; tap for the detail. */
export function Card({
  title,
  chip,
  amount,
  detail,
  onOpen,
  label,
}: {
  title: string
  chip: Chip
  amount?: string
  detail: string
  onOpen?: () => void
  label?: string
}) {
  const roles = useTheme().material
  return (
    <ButtonBase
      onClick={onOpen}
      disabled={!onOpen}
      aria-label={label}
      sx={{
        width: '100%',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        alignItems: 'center',
        gap: 2,
        textAlign: 'left',
        p: 3,
        minHeight: 64,
        borderRadius: `${shape.md}px`,
        bgcolor: roles.surfaceContainer,
        color: roles.onSurface,
        '&:focus-visible': { outline: `2px solid ${roles.primary}`, outlineOffset: 2 },
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', minWidth: 0 }}>
          <Typography variant="titleSmall" component="span" sx={{ overflowWrap: 'anywhere' }}>
            {title}
          </Typography>
        </Stack>
        <Stack
          direction="row"
          spacing={2}
          sx={{ mt: 0.5, alignItems: 'baseline', flexWrap: 'wrap', columnGap: 2, rowGap: 0 }}
        >
          {amount && (
            <Typography
              variant="titleLarge"
              component="span"
              sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
            >
              {amount}
            </Typography>
          )}
          <Typography
            variant="bodyMedium"
            component="span"
            color="text.secondary"
            sx={{ overflowWrap: 'anywhere' }}
          >
            {detail}
          </Typography>
        </Stack>
      </Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <StatusChip chip={chip} />
        {onOpen && <ChevronRight size={18} aria-hidden="true" />}
      </Stack>
    </ButtonBase>
  )
}

function firstLine(order: IoOrder, f: IoFormat): string {
  const [first, ...rest] = order.lines
  if (!first) return ''
  return `${f.qty(first.quantity)} ${first.unit}${rest.length ? ` +${rest.length}` : ''}`
}

export function OrderCard({ order, onOpen }: { order: IoOrder; onOpen: () => void }) {
  const c = useIoCopy()
  const f = useIoFormat(order.currency)
  const item = order.lines[0]?.item ?? ''
  return (
    <Card
      title={order.partner.name}
      chip={order.chip}
      amount={firstLine(order, f)}
      detail={[item, c.direction[order.direction], order.delivery ? f.day(order.delivery) : '']
        .filter(Boolean)
        .join(' · ')}
      onOpen={onOpen}
    />
  )
}

export function EntryCard({ entry, onOpen }: { entry: InboxEntry; onOpen?: () => void }) {
  const c = useIoCopy()
  const f = useIoFormat()
  const what = entry.changes.map((x) => changeText(x, c, f)).find(Boolean)
  const line = entry.lines[0]
  const chip: Chip = entry.status === 'needs_you' ? 'needs_you' : entry.status
  return (
    <Card
      title={entry.partner?.name ?? entry.number}
      chip={chip}
      amount={!what && line ? `${f.qty(line.quantity)} ${line.unit}` : undefined}
      detail={[
        c.kind[entry.kind],
        entry.problem ? problemText(entry.problem, c) : (what ?? line?.item),
      ]
        .filter(Boolean)
        .join(' · ')}
      onOpen={onOpen}
    />
  )
}

export function TaskCard({ task, onOpen }: { task: Task; onOpen?: () => void }) {
  const c = useIoCopy()
  const f = useIoFormat()
  return (
    <Card
      title={c.task[task.code](task.partner || task.number)}
      chip={task.status}
      detail={taskDetail(task, c, f)}
      onOpen={onOpen}
    />
  )
}

/** One timeline per order: Created → Changed → Shipped → Received → Closed. */
export function Timeline({ steps }: { steps: Step[] }) {
  const roles = useTheme().material
  const c = useIoCopy()
  const f = useIoFormat()
  return (
    <Box component="ol" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
      {steps.map((step) => {
        const done = step.at != null && !step.waiting
        return (
          <Box
            component="li"
            key={step.step}
            sx={{
              display: 'grid',
              gridTemplateColumns: '16px 1fr auto',
              gap: 2,
              alignItems: 'center',
            }}
          >
            <Box
              aria-hidden="true"
              sx={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                border: `2px solid ${done ? roles.primary : roles.outline}`,
                bgcolor: done ? roles.primary : 'transparent',
              }}
            />
            <Typography variant="bodyMedium">{c.step[step.step]}</Typography>
            <Typography variant="bodySmall" color="text.secondary" sx={{ textAlign: 'right' }}>
              {step.waiting ? c.waiting : step.at != null ? f.time(step.at) : '–'}
            </Typography>
          </Box>
        )
      })}
    </Box>
  )
}

/** The document as SAP (or the partner's system) sees it, beside plain words (UX rule 4). */
export function SapView({ order, doc }: { order: IoOrder; doc: IoDocument }) {
  const c = useIoCopy()
  const f = useIoFormat(order.currency)
  const text =
    doc.translated_format === 'idoc' || doc.raw_format !== 'idoc' ? doc.translated : doc.raw
  const format = doc.translated_format === 'idoc' ? 'idoc' : doc.raw_format
  const lines = doc.canonical?.lines ?? order.lines
  const shop = order.direction === 'in' ? order.buyer.name : order.supplier.name
  const [from, to] =
    doc.direction === 'out' ? [shop, order.partner.name] : [order.partner.name, shop]
  return (
    <Box
      sx={{ display: 'grid', gap: 4, gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '1fr 1fr' } }}
    >
      <Box>
        <Typography variant="titleMedium" component="h3">
          {c.plain}
        </Typography>
        <Typography sx={{ mt: 2 }}>
          {c.kind[doc.kind]} · {c.fromTo(from, to)}
        </Typography>
        {lines.slice(0, 5).map((line) => (
          <Typography key={line.line} sx={{ mt: 1, fontVariantNumeric: 'tabular-nums' }}>
            {f.qty(line.quantity)} {line.unit} {line.item}
          </Typography>
        ))}
        {order.partner.demo && (
          <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 2 }}>
            {c.simulated}
          </Typography>
        )}
      </Box>
      <Code label={c.format[format]} text={text} />
    </Box>
  )
}

/** A heading and a list with the same spacing on every supply screen. */
export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <Box component="section" aria-label={title}>
      {title && (
        <Typography variant="titleMedium" component="h4" sx={{ mb: 2 }}>
          {title}
        </Typography>
      )}
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 2 }}>
        {children}
      </Box>
    </Box>
  )
}
