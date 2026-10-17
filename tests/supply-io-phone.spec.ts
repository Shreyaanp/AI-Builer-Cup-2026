import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { enter, localOnly, seedShop } from './stories/support.js'

const noSideScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

test('Supply on a phone: forecast in → order → change → goods arrive → receipt → ASN → Close the day', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 360, height: 800 })
  await localOnly(page)
  await enter(page)
  await seedShop(page)
  await page.keyboard.press('Escape')
  // The private local demo: a milk shop with a purchase order sent to a simulated SAP dairy.
  await page.getByRole('button', { name: 'Grow', exact: true }).click()
  await page.getByRole('button', { name: /^Purchase orders/ }).click()
  await page.getByRole('button', { name: 'Try supply demo', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Supply chain' })).toBeVisible()

  await page.getByRole('button', { name: 'Grow', exact: true }).click()
  await page.getByRole('button', { name: /^Supply chain/ }).click()
  const hub = page.getByRole('dialog', { name: 'Supply chain' })
  await hub.getByRole('button', { name: /^Coming in/ }).click()
  await expect(hub.getByRole('heading', { name: 'What’s coming in?' })).toBeVisible()

  // INBOUND: the demo buyer (an SAP system) sends a forecast, an order and an order change.
  const next = hub.getByRole('button', { name: 'Partner sends next document (demo)' })
  await next.click()
  await expect(hub).toContainText('Forecast')
  await expect(hub).toContainText(/Expects 20 l Milk/)
  await next.click()
  await expect(hub).toContainText('New order')
  await next.click()
  await expect(hub).toContainText('Order changed')
  await expect(hub).toContainText('Milk: 20 → 15 l')
  await noSideScroll(page)
  await page.screenshot({ path: 'output/playwright/supply-io-coming.png' })

  // The change needs the owner: what changed comes first, the action sits at the bottom.
  await hub.getByRole('button', { name: /^Needs me now/ }).click()
  await hub.getByRole('button', { name: /Harbour Café \(Demo\) changed an order/ }).click()
  const cafe = page.getByRole('dialog', { name: 'Harbour Café (Demo)' })
  await expect(cafe.getByRole('status')).toContainText('Milk: 20 → 15 l')
  await expect(cafe.getByRole('status')).toContainText('Date moved')
  await noSideScroll(page)
  await page.screenshot({ path: 'output/playwright/supply-io-change.png' })
  await cafe.getByRole('button', { name: 'Accept change', exact: true }).click()
  await expect(cafe.getByRole('button', { name: 'Send shipping notice' })).toBeVisible()
  await expect(cafe).toContainText('15 l Milk')
  await cafe.getByRole('button', { name: 'Close', exact: true }).click()

  // OUTBOUND 1: goods arrive. Pre-filled from the order; the owner fixes only the difference.
  await hub.getByRole('button', { name: /^Coming in/ }).click()
  await hub.getByRole('button', { name: /^Fresh Dairy \(Demo\)/ }).click()
  const dairy = page.getByRole('dialog', { name: 'Fresh Dairy (Demo)' })
  await dairy.getByRole('button', { name: 'Goods arrived', exact: true }).click()
  await expect(dairy.getByRole('button', { name: 'All received', exact: true })).toBeVisible()
  for (let i = 0; i < 5; i++) await dairy.getByRole('button', { name: 'Less Milk' }).click()
  await dairy.getByRole('button', { name: 'Save receipt', exact: true }).click()
  // The stock update still waits for the owner's usual review.
  const review = page.getByRole('dialog', { name: 'Check before saving' })
  await review.getByRole('button', { name: 'Confirm and save', exact: true }).click()
  await expect(review).toHaveCount(0)
  await expect(dairy).toContainText('Goods received to Fresh Dairy (Demo) · SAP IDoc')
  await expect(dairy.getByRole('status')).toContainText(/5 (l|litre) Milk short/)
  await noSideScroll(page)
  await page.screenshot({ path: 'output/playwright/supply-io-receipt.png' })
  await dairy.getByRole('button', { name: 'Send goods receipt', exact: true }).click()
  await expect(dairy).toContainText(/Sending in \d s/)
  await expect(dairy.getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  await expect(dairy.getByText('Done', { exact: true })).toBeVisible({ timeout: 15_000 })
  await dairy.getByRole('button', { name: 'Close', exact: true }).click()

  // OUTBOUND 2: the shipping notice for the café, written as an SAP DELVRY07; not sent yet.
  await hub.getByRole('button', { name: /New order/ }).click()
  await cafe.getByRole('button', { name: 'Send shipping notice', exact: true }).click()
  await expect(cafe).toContainText('Shipping notice to Harbour Café (Demo) · SAP IDoc')
  await cafe.getByRole('button', { name: 'View as SAP', exact: true }).click()
  const sap = page.getByRole('dialog', { name: 'View as SAP' })
  await expect(sap.getByLabel('SAP IDoc')).toContainText('<IDOCTYP>DELVRY07</IDOCTYP>')
  await expect(sap).toContainText('In plain words')
  await expect(sap).toContainText('15 l Milk')
  await noSideScroll(page)
  await page.keyboard.press('Escape')
  await expect(sap).toHaveCount(0)
  await cafe.getByRole('button', { name: 'Close', exact: true }).click()
  await hub.getByRole('button', { name: /^Must send/ }).click()
  await expect(hub).toContainText('Shipping notice')
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([])
  await hub.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(hub).toHaveCount(0)

  // Close the day: the unsent shipping notice is the reminder, sent in one tap.
  await page.getByRole('button', { name: /^Close the day/ }).click()
  const closing = page.getByRole('dialog', { name: 'Close the day' })
  const before = closing.getByRole('region', { name: 'Before you close' })
  await expect(before).toContainText('1 document not sent yet')
  await expect(before).toContainText('Shipping notice · Harbour Café (Demo)')
  await before.getByRole('button', { name: 'Send all (1)', exact: true }).click()
  await expect(before).toContainText(/Sending in \d s/)
  await expect(before.getByRole('status')).toContainText('Everything is sent', { timeout: 15_000 })
  await noSideScroll(page)
  await page.screenshot({ path: 'output/playwright/supply-io-closed.png' })

  const businesses = await (await page.request.get('/api/v1/businesses')).json()
  const shop = businesses.find(
    (b: { fields: { name: string } }) => b.fields.name === 'Milk shop (Supply demo)',
  )
  const board = await (await page.request.get(`/api/v1/businesses/${shop.id}/supply/board`)).json()
  expect(board.unsent).toEqual([])
  const kinds = board.orders.flatMap((o: { documents: { kind: string; status?: string }[] }) =>
    o.documents.filter((d) => d.status === 'sent').map((d) => d.kind),
  )
  expect(kinds.sort()).toEqual(['DESADV', 'RECEIPT'])
})
