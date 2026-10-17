/** Public visibility only; server identity and business permissions remain authoritative. */
import type { components } from '../api/generated'

export type FeatureFlags = Required<components['schemas']['FeatureFlags']>

export const hiddenFeatures: FeatureFlags = { google_guide: false, guest_customer: false }

export function readFeatures(value: unknown): FeatureFlags {
  if (!value || typeof value !== 'object') return hiddenFeatures
  return {
    google_guide: 'google_guide' in value && value.google_guide === true,
    guest_customer: 'guest_customer' in value && value.guest_customer === true,
  }
}
