import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Snackbar,
  Tooltip,
  useTheme,
} from '@mui/material'
import { Check, Plus } from 'lucide-react'
import { popIn } from '../../design/chalkMotion'
import { useCustomer } from './account'
import { track } from '../../app/analytics'
import { useAccountCopy } from './copy'

/**
 * Follow a shop. Signed in: synced to the account. Signed out: kept on this device and moved into
 * the account at the next sign-in, so following never forces an account.
 */
export function FollowButton({
  id,
  name,
  variant = 'button',
}: {
  id: string
  name: string
  /** `icon`: a compact round toggle for cards. */
  variant?: 'button' | 'icon'
}) {
  const roles = useTheme().material
  const account = useCustomer()
  const t = useAccountCopy()
  const following = account.follows.includes(id)
  const [busy, setBusy] = useState(false)
  const [changed, setChanged] = useState(0)
  const [failed, setFailed] = useState(false)
  const label = (following ? t.unfollowShop : t.followShop).replace('{shop}', name)
  async function toggle() {
    // Enabled while the account loads (no grey flash on every page); a tap waits for it.
    if (busy || account.status === 'loading') return
    setBusy(true)
    setFailed(false)
    try {
      await account.setFollow(id, !following)
      if (!following) track('follow')
      setChanged((n) => n + 1)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const icon = busy ? (
    <CircularProgress size={18} color="inherit" />
  ) : (
    <Box key={changed} component="span" sx={{ display: 'flex', ...(changed ? popIn : {}) }}>
      {following ? <Check size={18} /> : <Plus size={18} />}
    </Box>
  )
  return (
    <>
      {variant === 'icon' ? (
        <Tooltip title={label}>
          <IconButton
            aria-label={label}
            aria-pressed={following}
            aria-busy={busy}
            disabled={busy}
            onClick={() => void toggle()}
            sx={{
              width: 48,
              height: 48,
              bgcolor: following ? roles.primary : roles.surface,
              color: following ? roles.onPrimary : roles.onSurface,
              boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
              transition: 'background-color 200ms, color 200ms',
              '&:hover': { bgcolor: following ? roles.primary : roles.surface },
            }}
          >
            {icon}
          </IconButton>
        </Tooltip>
      ) : (
        <Button
          aria-pressed={following}
          aria-label={label}
          variant="outlined"
          size="small"
          startIcon={icon}
          aria-busy={busy}
          disabled={busy}
          onClick={() => void toggle()}
          sx={{
            minHeight: 48,
            minWidth: 112,
            transition: 'background-color 200ms, color 200ms, border-color 200ms',
          }}
        >
          {following ? t.following : t.follow}
        </Button>
      )}
      <Snackbar open={failed} onClose={() => setFailed(false)}>
        <Alert
          severity="error"
          onClose={() => setFailed(false)}
          action={
            <Button color="inherit" onClick={() => void toggle()}>
              {t.retry}
            </Button>
          }
        >
          {t.followFailed}
        </Alert>
      </Snackbar>
    </>
  )
}
