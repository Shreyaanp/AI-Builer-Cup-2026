import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Stack, Typography, useTheme } from '@mui/material'
import { ImagePlus, Sparkles, Trash2 } from 'lucide-react'
import { useWorkspace } from '../v1/workspaceContext'
import { shape } from '../../design/theme'
import { useShopIconCopy } from './shopIconStrings'

const PHOTO_TYPES = 'image/jpeg,image/png,image/webp'

/** Centre-crop to a square in the browser so the upload is small; null when it cannot decode. */
async function squareFile(file: File, side = 512): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const size = Math.min(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = side
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(
      bitmap,
      (bitmap.width - size) / 2,
      (bitmap.height - size) / 2,
      size,
      size,
      0,
      0,
      side,
      side,
    )
    bitmap.close()
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
  } catch {
    return null
  }
}

function Monogram({ name, size }: { name: string; size: number }) {
  const roles = useTheme().material
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        borderRadius: `${shape.md}px`,
        display: 'grid',
        placeItems: 'center',
        bgcolor: roles.primaryContainer,
        color: roles.onPrimaryContainer,
        fontWeight: 700,
        fontSize: size / 2.2,
      }}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </Box>
  )
}

export function ShopIcon() {
  const ws = useWorkspace()
  const copy = useShopIconCopy()
  const shop = ws.active
  const roles = useTheme().material
  const [busy, setBusy] = useState<'make' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const icon = shop?.icon ?? null
  const base = shop ? `/businesses/${encodeURIComponent(shop.id)}/icon` : ''

  useEffect(() => {
    if (!shop || !icon) return
    const abort = new AbortController()
    let made: string | null = null
    void ws
      .api<Response>(`${base}/${icon}.jpg`, { raw: true, signal: abort.signal })
      .then((response) => response.blob())
      .then((blob) => {
        if (abort.signal.aborted) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      })
      .catch(() => setUrl(null))
    return () => {
      abort.abort()
      if (made) URL.revokeObjectURL(made)
    }
    // The icon id changes whenever the picture does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop?.id, icon])

  if (!shop) return null

  async function run(kind: 'make' | 'save', work: () => Promise<unknown>) {
    if (busy) return
    if (!navigator.onLine) return setError(copy.offline)
    setBusy(kind)
    setError(null)
    try {
      await work()
      await ws.reload()
    } catch (problem) {
      const text = String((problem as Error)?.message ?? '')
      setError(
        text.includes('ICON_DAILY_LIMIT') || text.includes('429')
          ? copy.limit
          : text.includes('ICON_AI_OFF')
            ? copy.aiOff
            : kind === 'make'
              ? copy.failed
              : copy.uploadFailed,
      )
    } finally {
      setBusy(null)
    }
  }

  const make = () =>
    run('make', () =>
      ws.api(`${base}/generate`, { method: 'POST', signal: AbortSignal.timeout(90_000) }),
    )
  const pick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0]
    event.target.value = ''
    if (!chosen) return
    void run('save', async () => {
      const square = await squareFile(chosen)
      const body = square ?? chosen
      await ws.api(base, {
        method: 'PUT',
        body,
        headers: { 'Content-Type': square ? 'image/jpeg' : chosen.type || 'image/jpeg' },
        signal: AbortSignal.timeout(150_000),
      })
    })
  }
  const remove = () => run('save', () => ws.api(base, { method: 'DELETE' }))

  return (
    <Stack spacing={2} data-testid="shop-icon">
      <Typography variant="titleMedium" component="h3">
        {copy.title}
      </Typography>
      <Typography variant="bodySmall" color="text.secondary">
        {copy.tip}
      </Typography>
      <Stack direction="row" sx={{ gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <Box
          sx={{
            width: 72,
            height: 72,
            borderRadius: `${shape.md}px`,
            overflow: 'hidden',
            bgcolor: roles.surfaceContainerHigh,
          }}
        >
          {busy ? (
            <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
              <CircularProgress size={24} />
            </Box>
          ) : icon && url ? (
            <Box
              component="img"
              src={url}
              alt={copy.title}
              sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : (
            <Monogram name={shop.fields?.name ?? ''} size={72} />
          )}
        </Box>
        <Button
          variant="contained"
          startIcon={<Sparkles size={18} />}
          disabled={!!busy}
          onClick={() => void make()}
        >
          {icon ? copy.makeAgain : copy.make}
        </Button>
        <Button
          variant="outlined"
          startIcon={<ImagePlus size={18} />}
          disabled={!!busy}
          onClick={() => file.current?.click()}
        >
          {copy.upload}
        </Button>
        {icon && (
          <Button
            variant="text"
            startIcon={<Trash2 size={18} />}
            disabled={!!busy}
            onClick={() => void remove()}
          >
            {copy.remove}
          </Button>
        )}
      </Stack>
      <Typography variant="bodySmall" color="text.secondary" aria-live="polite">
        {busy === 'make' ? copy.making : busy === 'save' ? copy.saving : ''}
      </Typography>
      {error && (
        <Alert severity="error" role="alert">
          {error}
        </Alert>
      )}
      <input ref={file} type="file" accept={PHOTO_TYPES} hidden onChange={pick} />
    </Stack>
  )
}
