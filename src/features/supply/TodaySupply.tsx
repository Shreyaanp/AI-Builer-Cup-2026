import { useState } from 'react'
import { Box, Button, CircularProgress, Stack, Typography, useTheme } from '@mui/material'
import { useLocale } from '../../state/hooks'
import { shape } from '../../design/theme'
import { useWorkspace } from '../v1/workspaceContext'
import { Sheet } from '../v1/Sheet'
import { PurchaseOrderCard } from './PurchaseOrderCard'
import { useShowcaseCopy } from './showcaseCopy'
import { useSupplyCopy } from './copy'
import { dayLabel, useDraftReorder, useSupply } from './supplyData'
import type { PurchaseOrder } from './types'

export function TodaySupply() {
  const { products, active } = useWorkspace()
  const { data, refresh } = useSupply(true)
  const draft = useDraftReorder()
  const s = useShowcaseCopy()
  const copy = useSupplyCopy()
  const locale = useLocale()
  const roles = useTheme().material
  const [order, setOrder] = useState<PurchaseOrder | null>(null)
  const [busy, setBusy] = useState(false)
  const need = data?.needs?.[0]
  const received = data?.orders.find(
    (po) =>
      po.received &&
      po.received_stock &&
      Object.keys(po.received_stock).length > 0 &&
      Object.entries(po.received_stock).every(([name, stock]) =>
        products.some((p) => p.name === name && p.stock != null && p.stock >= stock),
      ),
  )
  const item = need?.item ?? received?.lines[0]?.item
  if (!active || !item) return null
  const close = () => {
    setOrder(null)
    void refresh()
  }
  return (
    <>
      <Stack
        component="section"
        aria-label={s.title}
        spacing={2}
        sx={{
          p: 4,
          borderRadius: `${shape.lg}px`,
          bgcolor: roles.primaryContainer,
          color: roles.onPrimaryContainer,
        }}
      >
        <Typography variant="titleSmall" component="h2">
          {s.title}
        </Typography>
        <Typography variant="titleLarge" component="p" aria-live="polite">
          {item} {need ? `${s.runsOut} ${dayLabel(need.runs_out, locale)}` : s.restocked}
        </Typography>
        <Box>
          <Button
            variant="contained"
            disabled={busy}
            sx={{ minHeight: 48 }}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
            onClick={async () => {
              if (!need) {
                setOrder(received ?? null)
                return
              }
              setBusy(true)
              const next = await draft(need.item)
              setBusy(false)
              if (next) setOrder(next)
            }}
          >
            {need ? s.reorder : s.view}
          </Button>
        </Box>
      </Stack>
      <Sheet open={order !== null} onClose={close} titleId="today-supply-title" title={copy.title}>
        {order && <PurchaseOrderCard order={order} onChange={setOrder} />}
      </Sheet>
    </>
  )
}
