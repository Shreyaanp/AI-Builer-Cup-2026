import { expect, test } from '@playwright/test'
import { enter, localOnly, seedShop } from './stories/support.js'

// #96: Back, Forward and a refresh behave like an app on a phone.
test.describe.configure({ timeout: 90_000 })
test.use({ viewport: { width: 390, height: 800 } })

const tab = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('button', { name, exact: true })

test('owner tabs are history entries that survive Back and a refresh', async ({ page }) => {
  await localOnly(page)
  await enter(page)
  await seedShop(page)
  await page.keyboard.press('Escape')

  await tab(page, 'Shop').click()
  await expect(page).toHaveURL(/tab=shop/)
  await tab(page, 'Grow').click()
  await expect(page).toHaveURL(/tab=grow/)

  await page.goBack()
  await expect(page).toHaveURL(/tab=shop/)
  await page.goForward()
  await expect(page).toHaveURL(/tab=grow/)

  await page.reload()
  // Local preview signs in again after a refresh; the address keeps the tab.
  await expect(page).toHaveURL(/tab=grow/)
  await page.getByRole('button', { name: 'Continue local preview' }).click()
  await expect(page.getByRole('button', { name: /^Get on Google/ })).toBeVisible()

  // A sub-page returns to its tab on Back, and the shop switcher closes before any page change.
  await page.getByRole('button', { name: /^Get on Google/ }).click()
  await expect(page).toHaveURL(/tab=google/)
  await page.goBack()
  await expect(page).toHaveURL(/tab=grow/)

  await page.getByRole('button', { name: /^Choose shop/ }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(page).toHaveURL(/tab=grow/)
})

test('customer profile sheet closes on Back and a shared shop link has a way back', async ({
  page,
}) => {
  await localOnly(page)
  await page.goto('/explore/')
  await page
    .getByRole('button', { name: /profile/i })
    .first()
    .click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page).toHaveURL(/\/explore\/?$/)

  await page.goto('/explore/s/demo-courtyard-chai')
  await page.goBack()
  await expect(page).toHaveURL(/\/explore\/?(\?.*)?$/)
})
