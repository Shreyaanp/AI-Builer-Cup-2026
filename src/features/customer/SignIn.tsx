import { useState } from 'react'
import { Alert, Box, Button, CircularProgress, Stack, Typography, useTheme } from '@mui/material'
import { LockKeyhole } from 'lucide-react'
import { Sheet } from '../v1/Sheet'
import { useCustomer } from './account'
import { useAccountCopy } from './copy'

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17z"
      />
      <path
        fill="#FBBC05"
        d="M10.6 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"
      />
    </svg>
  )
}

/** The one sign-in button: Google when hosted; an explicit local stand-in in development. */
export function SignInButton({
  onSignedIn,
  fullWidth = true,
}: {
  onSignedIn?: () => void
  fullWidth?: boolean
}) {
  const account = useCustomer()
  const t = useAccountCopy()
  const [busy, setBusy] = useState(false)
  return (
    <>
      {account.error && (
        <Alert severity="error">
          {account.error === 'unavailable' ? t.signInUnavailable : t.signInUnfinished}
        </Alert>
      )}
      <Button
        variant="contained"
        size="large"
        fullWidth={fullWidth}
        disabled={busy || account.status === 'loading'}
        startIcon={
          busy ? (
            <CircularProgress size={18} color="inherit" />
          ) : (
            <Box sx={{ display: 'grid', p: 0.5, bgcolor: '#fff', borderRadius: '50%' }}>
              <GoogleMark />
            </Box>
          )
        }
        onClick={async () => {
          setBusy(true)
          const ok = await account.signIn()
          setBusy(false)
          if (ok) onSignedIn?.()
        }}
        sx={{ minHeight: 52 }}
      >
        {account.mode === 'local' ? t.signInLocal : t.signIn}
      </Button>
    </>
  )
}

/** Explains why, before asking: messaging owners needs an account; browsing never does. */
export function SignInSheet({
  open,
  onClose,
  onSignedIn,
  title,
  body,
}: {
  open: boolean
  onClose: () => void
  onSignedIn: () => void
  title?: string
  body?: string
}) {
  const roles = useTheme().material
  const t = useAccountCopy()
  return (
    <Sheet
      open={open}
      onClose={onClose}
      titleId="customer-sign-in-title"
      title={title ?? t.signInTitle}
    >
      <Stack spacing={3} sx={{ pb: 1 }}>
        <Box
          aria-hidden="true"
          className="c-pop"
          sx={{
            width: 56,
            height: 56,
            borderRadius: '18px',
            display: 'grid',
            placeItems: 'center',
            bgcolor: roles.primaryContainer,
            color: roles.onPrimaryContainer,
          }}
        >
          <LockKeyhole size={26} />
        </Box>
        <Typography variant="bodyLarge">{body ?? t.signInBody}</Typography>
        {!body && (
          <Typography variant="bodySmall" color="text.secondary">
            {t.signInWhy}
          </Typography>
        )}
        <SignInButton onSignedIn={onSignedIn} />
        <Button onClick={onClose}>{t.notNow}</Button>
      </Stack>
    </Sheet>
  )
}
