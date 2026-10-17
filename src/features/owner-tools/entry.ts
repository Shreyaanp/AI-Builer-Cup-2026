import { useSyncExternalStore } from 'react'
import { carried, pushEntry, replaceEntry } from '../../app/history'

export type OwnerFeature = 'guide' | 'payments'
const featureChanged = 'ownerfeaturechange'
const subscribe = (callback: () => void) => {
  window.addEventListener('popstate', callback)
  window.addEventListener(featureChanged, callback)
  return () => {
    window.removeEventListener('popstate', callback)
    window.removeEventListener(featureChanged, callback)
  }
}
const snapshot = () => new URL(location.href).searchParams.get('feature')
export const useOwnerFeature = () => {
  const feature = useSyncExternalStore(subscribe, snapshot)
  return feature === 'guide' || feature === 'payments' ? feature : null
}
export function openOwnerFeature(feature: OwnerFeature | null) {
  const url = new URL(location.href)
  if (feature) url.searchParams.set('feature', feature)
  else url.searchParams.delete('feature')
  // Preserve the underlying draft/overlay marker so returning from a feature does
  // not look like popping that draft's own history entry.
  if (feature) pushEntry(url, carried())
  else replaceEntry(url)
  // A feature change is not Back: the overlay/draft history stack owns real popstate events.
  window.dispatchEvent(new Event(featureChanged))
}
