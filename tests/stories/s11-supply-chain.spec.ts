import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { confirm, enter, liveOnly, localOnly } from './support.js'

/**
 * S11 · Supply chain: the forecast drafts a purchase order to a (simulated) SAP supplier, the
 * supplier confirms part of it with a back-order, dispatches, and invoices the wrong price;
 * every document is translated between the supplier's IDoc XML and the shop's JSON.
 */
const SHOP = 'Lakshmi Kirana · Bengaluru'

async function seedKirana(page: Page) {
  const prepared = await page.request.post('/api/v1/proposals', {
    data: {
      kind: 'business',
      business: {
        name: SHOP,
        category: 'Grocery',
        location: 'Indiranagar, Bengaluru',
        lat: 12.9716,
        lng: 77.5946,
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        phone: '+91 98450 00000',
      },
      products: [
        { name: 'Atta (wheat flour)', price: 5500, unit: 'kg', category: 'Staples', stock: 6 },
        { name: 'Sugar', price: 4800, unit: 'kg', category: 'Staples', stock: 60 },
      ],
    },
  })
  const proposal = await prepared.json()
  const approved = await (
    await page.request.post(`/api/v1/proposals/${proposal.id}/approve`, {
      data: { digest: proposal.digest },
    })
  ).json()
  const bid = approved.business_id as string
  const { today } = await (await page.request.get(`/api/v1/businesses/${bid}/freshness`)).json()
  const end = new Date(`${today}T12:00:00Z`)
  const rows = Array.from({ length: 28 }, (_, i) => {
    const day = new Date(end)
    day.setUTCDate(day.getUTCDate() - i - 1)
    return `${day.toISOString().slice(0, 10)},Atta (wheat flour),3,165`
  })
  const imported = await (
    await page.request.post(`/api/v1/businesses/${bid}/import`, {
      data: `Date,Item,Qty,Revenue\n${rows.join('\n')}`,
      headers: { 'Content-Type': 'text/csv' },
    })
  ).json()
  await page.request.post(`/api/v1/businesses/${bid}/import/${imported.import_id}/approve`, {
    data: { digest: imported.digest },
  })
  // Find the nearby (demo) suppliers once, then say they all run SAP: the story is about
  // translating SAP IDoc XML. The owner can set this per supplier in the rules screen.
  const first = await (
    await page.request.post(`/api/v1/businesses/${bid}/supply/reorder`, { data: {} })
  ).json()
  await page.request.post(`/api/v1/businesses/${bid}/supply/orders/${first.order.id}/cancel`, {
    data: { version: first.order.version },
  })
  const { suppliers } = await (await page.request.get(`/api/v1/businesses/${bid}/supply`)).json()
  for (const row of suppliers) {
    const saved = await page.request.put(
      `/api/v1/businesses/${bid}/supply/suppliers/${row.supplier.id}/rules`,
      { data: { version: row.version, rules: { ...row.rules, system_format: 'idoc' } } },
    )
    expect(saved.ok()).toBe(true)
  }
  await page.reload()
  await page.getByRole('button', { name: 'Continue local preview' }).click()
  await expect(page.getByRole('button', { name: `Choose shop: ${SHOP}` })).toBeVisible()
}

/** The page, with the part being shown scrolled to the middle (the card is taller than a phone). */
async function snap(page: Page, name: string, project: string, target?: Locator) {
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  const suffix = project === 'phone' ? '' : `-${project}`
  if (target) await target.first().evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.screenshot({
    path: `docs/stories/supply-${name}${suffix}.png`,
    animations: 'disabled',
  })
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    `supply/${name}: horizontal overflow`,
  ).toBe(true)
}

async function axe(page: Page) {
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(audit.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([])
}

async function theme(page: Page, name: 'Dark' | 'Light') {
  // Appearance lives on You; the coach stays mounted, so its cards keep their state.
  await page.getByRole('button', { name: 'You', exact: true }).click()
  await page.getByRole('button', { name, exact: true }).click()
  await page.getByRole('button', { name: 'Coach', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

async function status(card: Locator, label: string) {
  await expect(card.getByText(label, { exact: true }).first()).toBeVisible()
}

test.use({ reducedMotion: 'reduce' })
test('S11 · forecast → PO → ORDRSP (partial) → ASN → invoice, translated SAP IDoc ↔ JSON', async ({
  page,
}, info) => {
  test.setTimeout(150_000)
  const project = info.project.name
  await localOnly(page)
  await enter(page)
  await seedKirana(page)
  // The daily "still the same menu?" check is answered first, as an owner would.
  const same = page.getByRole('button', { name: 'Yes, all good' })
  if (process.env.S11_SAME && (await same.count())) await same.click()

  await test.step('1 · the coach drafts the PO from the forecast and the rules', async () => {
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Reorder atta')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const card = page.getByRole('article', { name: 'PO 4500012346' })
    await expect(card).toBeVisible()
    await expect(card).toContainText(/kg Wheat flour · deliver/)
    await expect(card).toContainText('6 kg left, runs out')
    await expect(card).toContainText('Simulation')
    await expect(page.getByRole('log')).toContainText("I've drafted PO 4500012346")
    await snap(page, '1-draft', project)
    await axe(page)
    // A broken rule (e.g. over the credit limit) comes with its one-tap fix.
    const fix = card.getByRole('button', { name: /^(Make it|Pay cash)/ })
    if (await fix.count()) await fix.first().click()
    await card.getByRole('button', { name: 'Approve and send' }).click()
    await expect(card).not.toContainText('<MESTYP>')
    await expect(card).not.toContainText('"kind": "ORDERS"')
    await card
      .getByRole('button', { name: /For your supplier’s system|For your supplier's system/i })
      .click()
    await expect(card.getByLabel('They receive · SAP IDoc')).toContainText(
      '<MESTYP>ORDERS</MESTYP>',
    )
    await expect(card.getByLabel('You sent · JSON')).toContainText('"kind": "ORDERS"')
    await snap(page, '2-sent-as-idoc', project, card.getByLabel('They receive · SAP IDoc'))
    await card.getByRole('button', { name: 'Hide' }).click()
    await expect(card).not.toContainText('<MESTYP>')
  })

  const card = page.getByRole('article', { name: 'PO 4500012346' })
  await test.step('2 · ORDRSP: part now, the rest back-ordered', async () => {
    await card.getByRole('button', { name: 'Confirm part, back-order the rest' }).click()
    await status(card, 'Changes to check')
    await expect(card).toContainText(/kg now, \d+ kg on/)
    await expect(card).toContainText('Came as SAP IDoc · Translated offline (fixture parser)')
    liveOnly('S11/2: with COACH_MODE=gemini the same documents are read by Gemini')
    await snap(page, '3-ordrsp-partial', project, card.getByText(/kg now/))
    await card.getByRole('button', { name: 'Accept changes' }).click()
    await status(card, 'Confirmed')
    await expect(card).toContainText(/Back-order: \d+ kg Wheat flour/)
  })

  await test.step('3 · DESADV, then the goods arrive and stock is reviewed', async () => {
    await card.getByRole('button', { name: 'Send dispatch notice' }).click()
    await status(card, 'On its way')
    await card.getByRole('button', { name: 'Goods arrived' }).click()
    await confirm(page)
    await status(card, 'Arrived')
    await snap(page, '4-arrived', project, card.getByRole('heading', { name: /^Shipping notice/ }))
  })

  await test.step('4 · INVOIC with the wrong price: three-way match flags it', async () => {
    await card.getByRole('button', { name: 'Send invoice (wrong price)' }).click()
    await status(card, 'Invoice in')
    await expect(card).toContainText('Billed price differs from the agreed price')
    await expect(card).toContainText('1 field to check')
    await snap(page, '5-invoice-flag', project, card.getByText('1 field to check'))
    await axe(page)
    // The first option is the agreed price.
    await card
      .getByText(/Price “/)
      .locator('..')
      .getByRole('button')
      .first()
      .click()
    await expect(card).toContainText('Corrected to the agreed price')
    const invoice = card.getByRole('listitem').filter({ hasText: /^Invoice/ })
    await invoice.getByRole('button', { name: 'For your supplier’s system' }).click()
    await expect(invoice.getByLabel('Supplier’s system · SAP IDoc')).toContainText(
      '<IDOCTYP>INVOIC02</IDOCTYP>',
    )
    await expect(invoice.getByLabel('Your app · JSON')).toContainText('"kind": "INVOIC"')
    await snap(page, '6-translation', project, invoice.getByLabel('Your app · JSON'))
    await theme(page, 'Dark')
    await snap(page, '6-translation-dark', project, invoice.getByLabel('Your app · JSON'))
    await axe(page)
    await theme(page, 'Light')
    await card.getByRole('button', { name: /^Approve invoice/ }).click()
    await status(card, 'Done')
    await expect(card).toContainText('Pay the supplier outside the app')
    await snap(page, '7-done', project, card.getByText(/Pay the supplier/))
  })

  await test.step('5 · rules screen on Grow', async () => {
    await page.getByRole('button', { name: 'Grow', exact: true }).click()
    await page.getByRole('button', { name: /^Purchase orders/ }).click()
    const sheet = page.getByRole('dialog', { name: 'Purchase orders' })
    await expect(sheet).toContainText('PO 4500012346')
    await sheet
      .getByRole('list', { name: 'Suppliers and rules' })
      .getByRole('button')
      .first()
      .click()
    await expect(page.getByRole('dialog')).toContainText('Minimum order')
    await page.getByRole('button', { name: '30 days' }).click()
    await snap(page, '8-rules', project)
    await axe(page)
    await page.getByRole('button', { name: 'Save rules' }).click()
    await expect(page.getByText('Rules saved')).toBeVisible()
  })
})
