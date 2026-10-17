import { useEffect, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { Stamp } from 'lucide-react'
import { usePassportCopy } from './copy'
import { holdAt } from '../rescue/holds'
import { StampMoment } from './StampMoment'
import { demoKey } from './store'
import { landStamp } from '../rewards/storage'
import { track } from '../../app/analytics'

/**
 * The passport on a shop page. A scan of the shop's QR (`?source=qr&k=…`) opens the stamp
 * moment once; demo shops offer their on-screen QR as a button, since nobody can stand in a
 * fictional shop.
 */
export function ShopStamp({
  shop,
}: {
  shop: {
    id: string
    name: string
    category?: string
    demo?: boolean
    timezone?: string
    needed?: number
  }
}) {
  const t = usePassportCopy()
  const [scan] = useState(() => {
    // Only a signed QR opens the moment. A bare `?source=qr` (posters printed before the key)
    // still counts on this phone's card, as it always did, without a check that must fail.
    const params = new URLSearchParams(location.search)
    const key = params.get('k')
    return params.get('source') === 'qr' && key ? key : null
  })
  const [key, setKey] = useState(scan ?? '')
  const [open, setOpen] = useState(scan !== null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (scan === null) return
    track('qr_scanned')
    // After the shop card has counted the visit: a reload must not stamp again.
    const timer = setTimeout(() => {
      const url = new URL(location.href)
      url.searchParams.delete('source')
      url.searchParams.delete('k')
      history.replaceState(history.state, '', url)
    }, 0)
    return () => clearTimeout(timer)
  }, [scan])
  async function tryDemo() {
    setBusy(true)
    try {
      setKey(await demoKey(shop.id))
      setOpen(true)
    } catch {
      /* The shop page still works; the button stays. */
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {shop.demo && (
        <Box sx={{ mt: 2 }}>
          <Button
            variant="contained"
            startIcon={<Stamp size={18} />}
            disabled={busy}
            onClick={() => void tryDemo()}
          >
            {t.tryDemo}
          </Button>
          <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 1 }}>
            {t.tryDemoNote}
          </Typography>
        </Box>
      )}
      {open && (
        <StampMoment
          shop={shop}
          qrKey={key}
          open={open}
          onClose={(stamped) => {
            setOpen(false)
            if (stamped) {
              landStamp(shop.id)
              track('stamp_added')
            }
          }}
          // A scan where this phone holds a rescue collects it (checked against the shop chat).
          rescue={holdAt(shop.id)?.rescue ?? null}
        />
      )}
    </>
  )
}
