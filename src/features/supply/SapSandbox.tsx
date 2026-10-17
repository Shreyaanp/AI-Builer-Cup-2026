import { useEffect, useState } from 'react'
import {
  Box,
  Chip,
  Collapse,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
  useTheme,
} from '@mui/material'
import { ChevronDown } from 'lucide-react'
import { useLocale } from '../../state/hooks'
import { shape } from '../../design/theme'
import { formatPrice } from '../v1/format'
import { useWorkspace } from '../v1/workspaceContext'
import { dayLabel } from './supplyData'
import type { PoLine } from './types'

/** Read-only purchase orders from SAP's public sandbox (backend/app/sap_sandbox.py). */
interface SapOrder {
  number: string
  currency: string
  delivery: string
  total: number | null
  supplier: { name: string }
  lines: PoLine[]
  idoc: string
}
interface SapAnswer {
  source: 'live' | 'recorded'
  reason: '' | 'off' | 'no_key' | 'rejected' | 'error'
  orders: SapOrder[]
}

const copy = {
  title: 'Live from SAP sandbox',
  live: 'Read now from SAP’s sandbox',
  recorded: 'Recorded sample of SAP’s sandbox, not live',
  recordedWhy: {
    off: 'The live link is switched off.',
    no_key: 'No SAP API key is set yet.',
    rejected: 'SAP did not accept the API key.',
    error: 'SAP did not answer just now.',
  },
  readOnly: 'Read only: nothing is ever sent to SAP.',
  po: (number: string) => `PO ${number}`,
  deliver: (day: string) => `deliver ${day}`,
  idoc: 'As an SAP IDoc',
}

export function SapSandboxOrders({ open }: { open: boolean }) {
  const { api, activeId } = useWorkspace()
  const locale = useLocale()
  const roles = useTheme().material
  const [data, setData] = useState<SapAnswer | null>(null)
  const [shown, setShown] = useState<string | null>(null)
  useEffect(() => {
    if (!open || !activeId) return
    let current = true
    api<SapAnswer>(`/businesses/${encodeURIComponent(activeId)}/supply/sap-sandbox`)
      .then((answer) => current && setData(answer))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [open, api, activeId])
  if (!data || data.orders.length === 0) return null
  return (
    <Box component="section" aria-labelledby="sap-sandbox-title">
      <Typography variant="titleSmall" component="h3" id="sap-sandbox-title">
        {copy.title}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', my: 1 }}>
        <Chip
          size="small"
          color={data.source === 'live' ? 'success' : 'default'}
          label={data.source === 'live' ? copy.live : copy.recorded}
        />
        <Typography variant="bodySmall" color="text.secondary">
          {data.source === 'recorded' && data.reason ? `${copy.recordedWhy[data.reason]} ` : ''}
          {copy.readOnly}
        </Typography>
      </Stack>
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 2 }}>
        {data.orders.map((order) => (
          <Box
            component="li"
            key={order.number}
            sx={{ borderRadius: `${shape.lg}px`, bgcolor: roles.surfaceContainer }}
          >
            <ListItemButton
              component="button"
              aria-expanded={shown === order.number}
              onClick={() => setShown(shown === order.number ? null : order.number)}
              sx={{ width: '100%', textAlign: 'start', borderRadius: `${shape.lg}px`, gap: 3 }}
            >
              <ListItemText
                primary={`${copy.po(order.number)} · ${order.supplier.name}`}
                secondary={[
                  order.total == null ? '' : formatPrice(order.total, order.currency, locale),
                  order.delivery ? copy.deliver(dayLabel(order.delivery, locale)) : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
              <ChevronDown size={18} aria-hidden="true" />
            </ListItemButton>
            <Collapse in={shown === order.number} unmountOnExit>
              <Box sx={{ px: 4, pb: 3, display: 'grid', gap: 2 }}>
                {order.lines.map((line) => (
                  <Typography key={line.line} variant="bodyMedium">
                    {line.quantity} {line.unit} · {line.item}
                  </Typography>
                ))}
                <Typography variant="labelLarge">{copy.idoc}</Typography>
                <Box
                  component="pre"
                  tabIndex={0}
                  sx={{ m: 0, overflow: 'auto', maxHeight: 240, fontSize: 12 }}
                >
                  {order.idoc}
                </Box>
              </Box>
            </Collapse>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
