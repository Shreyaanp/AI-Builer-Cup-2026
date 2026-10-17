import type { ReactNode } from 'react'
import { Box, Button } from '@mui/material'
import { ArrowLeft } from 'lucide-react'
import { entryState } from '../../../app/history'
import { useTabsCopy } from '../tabsCopy'
import { useWorkspace } from '../workspaceContext'
import { tabFromUrl } from '../workspaceContext'
import type { Destination } from '../workspaceContext'

/**
 * A page opened from a tab card (Google from Grow, Privacy from You). The tab stays selected,
 * a back link leads to it, and the phone's Back returns there instead of leaving the app (each
 * is its own history entry, `/?tab=google`).
 */
export function SubPage({
  parent,
  label,
  children,
}: {
  parent: Destination
  label: string
  children: ReactNode
}) {
  const tabs = useTabsCopy()
  const ws = useWorkspace()
  // Opened from its tab: the link is Back, so the tab keeps its place and Forward still works.
  const back = () => {
    const from = entryState().from
    if (from && new URL(from).pathname === '/' && tabFromUrl(new URL(from).search) === parent)
      history.back()
    else ws.go(parent)
  }
  return (
    // Entry motion (a step sliding in) must not widen a phone's page.
    <Box sx={{ maxWidth: 760, mx: 'auto', overflowX: 'clip', overflowClipMargin: '8px' }}>
      <Button
        startIcon={<ArrowLeft size={18} />}
        onClick={back}
        aria-label={tabs.backTo(label)}
        sx={{ mt: 1, ml: -1, minHeight: 48 }}
      >
        {label}
      </Button>
      {children}
    </Box>
  )
}
