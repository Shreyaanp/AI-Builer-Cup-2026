import { useState } from 'react'
import {
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useTheme,
} from '@mui/material'
import { ArrowLeft, ChevronRight, FileText, Settings2, Sparkles } from 'lucide-react'
import { useLocale } from '../../state/hooks'
import { enterRise, shape } from '../../design/theme'
import { formatPrice, toMajor, toMinor } from '../v1/format'
import { Sheet } from '../v1/Sheet'
import { useWorkspace } from '../v1/workspaceContext'
import { useShowcaseCopy } from './showcaseCopy'
import { Supporting, Tile } from '../v1/ShopTiles'
import { useSupplyCopy } from './copy'
import { orderTotal, poNumber } from './orderFormat'
import { PurchaseOrderCard } from './PurchaseOrderCard'
import { useDraftReorder, useRulesActions, useSupply } from './supplyData'
import type { ItemRule, PurchaseOrder, Relationship, RuleSet, SystemFormat } from './types'

const OPEN = new Set([
  'draft',
  'sent',
  'changed',
  'confirmed',
  'dispatched',
  'received',
  'invoiced',
])

/** My shop: the Purchase orders tile, opening the sheet. */
export function SupplyTile() {
  const s = useSupplyCopy()
  const [open, setOpen] = useState(false)
  const { data, refresh } = useSupply(true)
  const orders = data?.orders ?? []
  const active = orders.filter((order) => OPEN.has(order.status))
  const latest = orders[0]
  return (
    <>
      <Tile
        tour="supply"
        icon={<FileText size={20} />}
        label={s.title}
        value={data === null ? '–' : s.tileValue(active.length)}
        onClick={() => setOpen(true)}
      >
        <Supporting>
          {latest ? `${s.po(poNumber(latest.number))} · ${s.status[latest.status]}` : s.tileEmpty}
        </Supporting>
      </Tile>
      <SupplySheet
        open={open}
        onClose={() => {
          setOpen(false)
          void refresh()
        }}
      />
    </>
  )
}

type View = { kind: 'list' } | { kind: 'order'; id: string } | { kind: 'rules'; id: string }

export function SupplySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSupplyCopy()
  const demo = useShowcaseCopy()
  const ws = useWorkspace()
  const roles = useTheme().material
  const locale = useLocale()
  const money = (order: PurchaseOrder) => {
    const total = orderTotal(order)
    return total == null ? '–' : formatPrice(total, order.currency, locale)
  }
  const { data, refresh } = useSupply(open)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [local, setLocal] = useState<Record<string, PurchaseOrder>>({})
  const [drafting, setDrafting] = useState(false)
  const draft = useDraftReorder()
  const orders = (data?.orders ?? []).map((order) => {
    const mine = local[order.id]
    return mine && mine.version > order.version ? mine : order
  })
  const extra = Object.values(local).filter((order) => !orders.some((o) => o.id === order.id))
  const all = [...extra, ...orders]
  const selected = view.kind === 'order' ? all.find((order) => order.id === view.id) : undefined
  const supplier =
    view.kind === 'rules' ? data?.suppliers.find((row) => row.supplier.id === view.id) : undefined
  function update(order: PurchaseOrder) {
    setLocal((known) => ({ ...known, [order.id]: order }))
  }
  function close() {
    setView({ kind: 'list' })
    onClose()
  }
  const back = (
    <IconButton aria-label={s.title} onClick={() => setView({ kind: 'list' })} sx={{ ml: -2 }}>
      <ArrowLeft size={20} />
    </IconButton>
  )
  return (
    <Sheet
      open={open}
      onClose={close}
      titleId="supply-sheet-title"
      title={
        view.kind === 'list' ? (
          s.title
        ) : (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
            {back}
            <Box component="span" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {view.kind === 'order' && selected
                ? s.po(poNumber(selected.number))
                : supplier
                  ? s.rulesFor(supplier.supplier.name)
                  : s.title}
            </Box>
          </Stack>
        )
      }
    >
      {view.kind === 'order' && selected ? (
        <PurchaseOrderCard order={selected} onChange={update} />
      ) : view.kind === 'rules' && supplier ? (
        <RulesEditor
          key={`${supplier.supplier.id}-${supplier.version}`}
          row={supplier}
          onSaved={() => {
            void refresh()
            setView({ kind: 'list' })
          }}
        />
      ) : (
        <Stack spacing={4}>
          {import.meta.env.DEV && (
            <Button
              disabled={drafting}
              sx={{ minHeight: 48 }}
              onClick={async () => {
                setDrafting(true)
                try {
                  const result = await ws.api<{ business_id: string }>('/supply/demo', {
                    method: 'POST',
                  })
                  await ws.reload()
                  ws.select(result.business_id)
                  close()
                  ws.go('coach')
                } catch {
                  ws.notify(s.failed)
                } finally {
                  setDrafting(false)
                }
              }}
            >
              {demo.demo}
            </Button>
          )}
          <Button
            variant="contained"
            startIcon={
              drafting ? <CircularProgress size={16} color="inherit" /> : <Sparkles size={18} />
            }
            disabled={drafting}
            onClick={async () => {
              setDrafting(true)
              const order = await draft()
              setDrafting(false)
              if (order) {
                update(order)
                void refresh()
                setView({ kind: 'order', id: order.id })
              }
            }}
            sx={{ alignSelf: 'flex-start', minHeight: 48 }}
          >
            {drafting ? s.drafting : s.draftReorder}
          </Button>
          {data && all.length === 0 && (
            <Typography variant="bodyLarge" color="text.secondary">
              {s.noOrders}
            </Typography>
          )}
          {all.length > 0 && (
            <List disablePadding sx={{ display: 'grid', gap: 2 }} aria-label={s.title}>
              {all.map((order, index) => (
                <ListItem key={order.id} disablePadding>
                  <ListItemButton
                    component="button"
                    onClick={() => setView({ kind: 'order', id: order.id })}
                    sx={{
                      borderRadius: `${shape.lg}px`,
                      bgcolor: roles.surfaceContainer,
                      width: '100%',
                      textAlign: 'start',
                      py: 3,
                      gap: 3,
                      ...enterRise,
                      animationDelay: `${index * 50}ms`,
                    }}
                  >
                    <FileText size={20} color={roles.primary} aria-hidden="true" />
                    <ListItemText
                      primary={`${s.po(poNumber(order.number))} · ${order.supplier.name}`}
                      secondary={`${s.status[order.status]} · ${money(order)}`}
                    />
                    <ChevronRight size={18} aria-hidden="true" />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          )}
          {data && data.suppliers.length > 0 && (
            <Box>
              <Typography variant="titleSmall" component="h3" sx={{ mb: 2 }}>
                {s.suppliersRules}
              </Typography>
              <List disablePadding sx={{ display: 'grid', gap: 1 }} aria-label={s.suppliersRules}>
                {data.suppliers.map((row) => (
                  <ListItem key={row.supplier.id} disablePadding>
                    <ListItemButton
                      component="button"
                      onClick={() => setView({ kind: 'rules', id: row.supplier.id })}
                      sx={{
                        borderRadius: `${shape.md}px`,
                        width: '100%',
                        textAlign: 'start',
                        gap: 3,
                      }}
                    >
                      <Settings2 size={18} aria-hidden="true" />
                      <ListItemText
                        primary={row.supplier.name}
                        secondary={`${s.terms(row.rules.terms_days)} · ${s.system[row.rules.system_format]}${row.supplier.demo ? ` · ${s.simulation}` : ''}`}
                      />
                      <ChevronRight size={18} aria-hidden="true" />
                    </ListItemButton>
                  </ListItem>
                ))}
              </List>
            </Box>
          )}
        </Stack>
      )}
    </Sheet>
  )
}

/** The simple rules screen for one supplier relationship. */
export function RulesEditor({ row, onSaved }: { row: Relationship; onSaved: () => void }) {
  const s = useSupplyCopy()
  const locale = useLocale()
  const roles = useTheme().material
  const { save } = useRulesActions()
  const currency = row.currency
  const [rules, setRules] = useState<RuleSet>(row.rules)
  const [busy, setBusy] = useState(false)
  const major = (minor: number) => (minor ? String(toMajor(minor, currency)) : '')
  const minor = (text: string) => (text.trim() ? toMinor(Number(text) || 0, currency) : 0)
  function item(index: number, change: Partial<ItemRule>) {
    setRules((current) => ({
      ...current,
      items: current.items.map((rule, i) => (i === index ? { ...rule, ...change } : rule)),
    }))
  }
  return (
    <Stack spacing={4}>
      {row.suggested && (
        <Typography variant="bodyMedium" color="text.secondary">
          {s.suggested}
        </Typography>
      )}
      {row.open_balance ? (
        <Typography variant="bodyMedium">
          {s.openBalance(formatPrice(row.open_balance, currency, locale))}
        </Typography>
      ) : null}
      <Box>
        <Typography variant="labelLarge" id="rules-payment" sx={{ display: 'block', mb: 1 }}>
          {s.payment}
        </Typography>
        <ToggleButtonGroup
          exclusive
          value={rules.terms_days}
          onChange={(_, value: 0 | 7 | 30 | null) =>
            value !== null && setRules({ ...rules, terms_days: value })
          }
          aria-labelledby="rules-payment"
          sx={{
            '& .MuiToggleButton-root': { color: roles.onSurface, minHeight: 48, px: 4 },
            '& .MuiToggleButton-root.Mui-selected': {
              bgcolor: roles.secondaryContainer,
              color: roles.onSecondaryContainer,
            },
          }}
          size="small"
        >
          <ToggleButton value={0}>{s.cash}</ToggleButton>
          <ToggleButton value={7}>{s.days(7)}</ToggleButton>
          <ToggleButton value={30}>{s.days(30)}</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
        <TextField
          label={s.creditLimit}
          value={major(rules.credit_limit)}
          onChange={(event) => setRules({ ...rules, credit_limit: minor(event.target.value) })}
          disabled={rules.terms_days === 0}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
          fullWidth
        />
        <TextField
          label={s.approvalOver}
          value={major(rules.approval_over)}
          onChange={(event) => setRules({ ...rules, approval_over: minor(event.target.value) })}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
          fullWidth
        />
      </Stack>
      <Box>
        <FormControlLabel
          control={
            <Switch
              checked={rules.auto_send}
              onChange={(event) => setRules({ ...rules, auto_send: event.target.checked })}
            />
          }
          label={s.autoSend}
        />
        <Typography variant="bodySmall" color="text.secondary" sx={{ display: 'block', ml: 6 }}>
          {s.autoSendHint}
        </Typography>
      </Box>
      <TextField
        select
        label={s.theirSystem}
        value={rules.system_format}
        onChange={(event) =>
          setRules({ ...rules, system_format: event.target.value as SystemFormat })
        }
        sx={{ maxWidth: 280 }}
      >
        {(['idoc', 'csv', 'text', 'json'] as const).map((format) => (
          <MenuItem key={format} value={format}>
            {s.system[format]}
          </MenuItem>
        ))}
      </TextField>
      <Typography variant="titleSmall" component="h3">
        {s.items}
      </Typography>
      <Stack spacing={3}>
        {rules.items.map((rule, index) => (
          <Box
            key={rule.item}
            component="fieldset"
            sx={{
              m: 0,
              p: 3,
              border: `1px solid ${roles.outlineVariant}`,
              borderRadius: `${shape.md}px`,
              display: 'grid',
              gap: 2,
              minWidth: 0,
            }}
          >
            <Typography component="legend" variant="labelLarge" sx={{ px: 1 }}>
              {rule.item} · {rule.unit}
            </Typography>
            {/* Wraps on a phone so labels in every language stay whole. */}
            <Box
              sx={{
                display: 'grid',
                gap: 2,
                gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
              }}
            >
              <TextField
                size="small"
                label={s.moq}
                value={rule.moq || ''}
                onChange={(event) => item(index, { moq: Number(event.target.value) || 0 })}
                slotProps={{ htmlInput: { inputMode: 'decimal' } }}
              />
              <TextField
                size="small"
                label={s.pack}
                value={rule.pack || ''}
                onChange={(event) => item(index, { pack: Number(event.target.value) || 0 })}
                slotProps={{ htmlInput: { inputMode: 'decimal' } }}
              />
              <TextField
                size="small"
                label={s.lead}
                value={rule.lead_days}
                onChange={(event) =>
                  item(index, {
                    lead_days: Math.min(60, Math.max(0, Number(event.target.value) || 0)),
                  })
                }
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              />
            </Box>
            {rule.tiers.map((tier, tierIndex) => (
              <Box
                key={tierIndex}
                sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
              >
                <TextField
                  size="small"
                  label={`${s.tiers} · ${s.tierFrom}`}
                  value={tier.min_quantity || ''}
                  onChange={(event) =>
                    item(index, {
                      tiers: rule.tiers.map((t, i) =>
                        i === tierIndex
                          ? { ...t, min_quantity: Number(event.target.value) || 0 }
                          : t,
                      ),
                    })
                  }
                  slotProps={{ htmlInput: { inputMode: 'decimal' } }}
                />
                <TextField
                  size="small"
                  label={s.tierPrice}
                  value={major(tier.price)}
                  onChange={(event) =>
                    item(index, {
                      tiers: rule.tiers.map((t, i) =>
                        i === tierIndex ? { ...t, price: minor(event.target.value) } : t,
                      ),
                    })
                  }
                  slotProps={{ htmlInput: { inputMode: 'decimal' } }}
                />
              </Box>
            ))}
            <TextField
              size="small"
              label={s.substitutes}
              helperText={s.substitutesHint}
              value={rule.substitutes.join(', ')}
              onChange={(event) =>
                item(index, {
                  substitutes: event.target.value
                    .split(',')
                    .map((name) => name.trimStart())
                    .slice(0, 6),
                })
              }
            />
            <Stack direction="row" sx={{ flexWrap: 'wrap', columnGap: 3 }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={rule.partial_ok}
                    onChange={(event) => item(index, { partial_ok: event.target.checked })}
                  />
                }
                label={s.partialOk}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={rule.backorder_ok}
                    onChange={(event) => item(index, { backorder_ok: event.target.checked })}
                  />
                }
                label={s.backorderOk}
              />
            </Stack>
          </Box>
        ))}
      </Stack>
      <Button
        variant="contained"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          const cleaned = {
            ...rules,
            items: rules.items.map((rule) => ({
              ...rule,
              substitutes: rule.substitutes.map((name) => name.trim()).filter(Boolean),
            })),
          }
          const saved = await save(row, cleaned)
          setBusy(false)
          if (saved) onSaved()
        }}
        sx={{ alignSelf: 'flex-start', minHeight: 48 }}
      >
        {s.save}
      </Button>
    </Stack>
  )
}

/** A rule change the coach prepared: confirm or keep the old rules. */
export function RulesChangeCard({
  row,
  onChange,
}: {
  row: Relationship
  onChange: (row: Relationship) => void
}) {
  const s = useSupplyCopy()
  const locale = useLocale()
  const roles = useTheme().material
  const { confirm } = useRulesActions()
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState<boolean | null>(null)
  // The card is born with the prepared change; it stays readable after the owner decides.
  const [change] = useState<Record<string, unknown>>(() => row.pending?.change ?? {})
  const value = (key: string, raw: unknown): string => {
    if (typeof raw === 'boolean') return raw ? s.yes : s.no
    if (Array.isArray(raw)) return raw.join(', ')
    if (key === 'terms_days') return Number(raw) === 0 ? s.cash : s.days(Number(raw))
    if (key === 'credit_limit' || key === 'approval_over' || key === 'tier_price')
      return formatPrice(toMinor(Number(raw), row.currency), row.currency, locale)
    if (key === 'system_format') return s.system[raw as SystemFormat] ?? String(raw)
    return String(raw)
  }
  const rows = Object.entries(change).filter(([key]) => key !== 'item')
  async function decide(apply: boolean) {
    setBusy(true)
    const saved = await confirm(row, apply)
    setBusy(false)
    if (saved) {
      setApplied(apply)
      onChange(saved)
    }
  }
  return (
    <Box
      sx={{
        borderRadius: `${shape.xl}px`,
        border: `1px solid ${row.pending ? roles.primary : roles.outlineVariant}`,
        bgcolor: roles.surfaceContainerLow,
        p: 4,
        display: 'grid',
        gap: 2,
      }}
    >
      <Typography variant="labelLarge" color="text.secondary">
        {s.ruleChange}
      </Typography>
      <Typography variant="titleMedium">
        {row.supplier.name}
        {typeof change.item === 'string' && change.item ? ` · ${change.item}` : ''}
      </Typography>
      {row.pending ? (
        <>
          <Box
            component="dl"
            sx={{ m: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 3, rowGap: 1 }}
          >
            {rows.map(([key, raw]) => (
              <Box key={key} sx={{ display: 'contents' }}>
                <Typography component="dt" variant="bodyMedium" color="text.secondary">
                  {s.change[key] ?? key}
                </Typography>
                <Typography component="dd" variant="bodyMedium" sx={{ m: 0, fontWeight: 600 }}>
                  {value(key, raw)}
                </Typography>
              </Box>
            ))}
          </Box>
          <Stack direction="row" spacing={2} sx={{ justifyContent: 'flex-end' }}>
            <Button disabled={busy} onClick={() => void decide(false)}>
              {s.discard}
            </Button>
            <Button
              variant="contained"
              disabled={busy}
              onClick={() => void decide(true)}
              sx={{ minHeight: 48 }}
            >
              {s.confirm}
            </Button>
          </Stack>
        </>
      ) : (
        <Typography variant="bodyMedium" color="text.secondary">
          {applied === false ? s.ruleKept : s.ruleConfirmed}
        </Typography>
      )}
    </Box>
  )
}
