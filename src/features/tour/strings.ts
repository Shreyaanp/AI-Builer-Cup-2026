import type { Locale } from '../../i18n/locales.js'
import { tourApac } from './apacTranslations.js'
import { tourTranslations } from './translations.js'

/** The guided tour. Languages without their own copy fall back to English. */
const en = {
  offerTitle: 'See it working first',
  offerBody: 'Take a one-minute tour of a filled demo shop: forecasts, closing the day, suppliers.',
  offerButton: 'Take the tour',
  preparing: 'Setting up your demo shop…',
  failed: 'Couldn’t set up the demo shop. Please try again.',
  settings: 'Take the tour',
  narration: 'Read aloud',
  next: 'Next',
  back: 'Back',
  skip: 'Skip',
  stepOf: '{n} of {total}',
  steps: [
    {
      title: 'Your shop at a glance',
      body: 'This is a demo shop with six weeks of sales. Everything here updates as you talk to the coach.',
    },
    {
      title: 'Your menu, by category',
      body: 'Tap a price to change it. Sold-out items show instantly on your customer page.',
    },
    {
      title: 'Tomorrow’s prep plan',
      body: 'Forecast from your sales, so you make enough and waste less.',
    },
    {
      title: 'Close the day in a minute',
      body: 'Every evening, snap your till report, deliveries and stock. Chalkboard reads them; you check once.',
    },
    {
      title: 'Running low? Find suppliers',
      body: 'Tell the coach “my flour is running low”. It finds nearby suppliers and you order in chat.',
    },
    {
      title: 'Just talk or type',
      body: '“Kopi is two dollars now, kaya toast sold out.” Nothing changes until you confirm.',
    },
    {
      title: 'Get on Google, guided',
      body: 'Your details and photos become a ready Google profile.',
    },
    {
      title: 'Share your page',
      body: 'Customers scan your QR to see today’s menu, ask questions and collect stamps.',
    },
  ],
  doneTitle: 'You’re ready',
  doneBody: 'Explore the demo shop as long as you like, or set up your own in a minute.',
  startMine: 'Start my own shop',
  keepExploring: 'Keep exploring',
}

export type TourCopy = typeof en
type Copy = TourCopy

const translations: Partial<Record<Locale, Partial<Copy>>> = {
  ...tourTranslations,
  ...tourApac,
}

export function tourCopy(locale: Locale): Copy {
  return { ...en, ...(translations[locale] ?? {}) }
}
