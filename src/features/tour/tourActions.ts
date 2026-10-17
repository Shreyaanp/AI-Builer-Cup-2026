import type { useWorkspace } from '../v1/workspaceContext'
import { tour } from './tourStore'

/** Create (or reuse) the owner's filled demo shop, select it and start the tour. */
export async function startDemoTour(
  ws: ReturnType<typeof useWorkspace>,
  setBusy: (busy: boolean) => void = () => undefined,
  setFailed: (failed: boolean) => void = () => undefined,
) {
  setBusy(true)
  setFailed(false)
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
    const made = await ws.api<{ business_id: string }>(
      `/demo/workspace?zone=${encodeURIComponent(zone)}`,
      { method: 'POST', signal: AbortSignal.timeout(60_000) },
    )
    await ws.reload()
    ws.select(made.business_id)
    tour.start()
    return true
  } catch {
    setFailed(true)
    return false
  } finally {
    setBusy(false)
  }
}
