import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const image = 'data:image/webp;base64,' + readFileSync(new URL('../public/mara.webp', import.meta.url)).toString('base64')
const generated = {
  prose: 'You board the ferry. Theo hoists the lantern over the railing.', choices: ['Ask about the light'],
  scene: { focus: 'theo', location: 'Ferry deck', action: 'Hoists a lantern over the railing', details: 'Fog' },
  facts: ['Theo showed the player his lantern.'], summary: 'The player boarded the ferry.',
}

test('adventure renders scene art, remembers facts after reload, and rewinds', async ({ page }) => {
  await page.route('**/api/turn', route => route.fulfill({ json: generated }))
  await page.route('**/api/image', async route => {
    const { scene } = route.request().postDataJSON()
    expect(scene.action).toBe('Hoists a lantern over the railing')
    expect(scene.location).toBe('Ferry deck')
    await route.fulfill({ json: { image } })
  })
  await page.goto('/')
  await expect(page.getByRole('img', { name: /Mara Venn/ })).toBeVisible()
  await page.getByLabel('Your move').fill('Board the ferry and ask Theo about his light')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText(generated.prose)).toBeVisible()
  await expect(page.getByRole('img', { name: /Theo Rusk.*Hoists/ })).toBeVisible()
  await page.reload()
  await expect(page.getByText(generated.prose)).toBeVisible()
  await page.getByRole('button', { name: 'Journal' }).click()
  await expect(page.getByLabel('Remembered facts')).toHaveValue(generated.facts[0])
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('button', { name: 'Rewind' }).click()
  await expect(page.getByRole('img', { name: /Mara Venn/ })).toBeVisible()
  await expect(page.getByLabel('Existing branches')).toBeVisible()
})

test('mobile layout fits and a failed model request preserves the action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/api/turn', route => route.fulfill({ status: 503, json: { error: 'Start Ollama on this computer, then try again.' } }))
  await page.goto('/')
  await page.getByLabel('Your move').fill('I take the key')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('alert')).toContainText('Start Ollama')
  await expect(page.getByLabel('Your move')).toHaveValue('I take the key')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('world editor creates a new playable campaign', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New world' }).click()
  await page.getByLabel('Title').fill('The Hush Signal')
  await page.getByLabel('World and rules').fill('An attic radio only works during snow.')
  await page.getByLabel('Opening scene').fill('The radio crackles.')
  await page.getByLabel('Location', { exact: true }).fill('The attic')
  await page.getByLabel('Characters').fill('Vera Bell | An adult radio operator with a silver buzz cut')
  await page.getByLabel('What the opening character is doing').fill('Tunes the radio')
  await page.getByRole('button', { name: 'Start new campaign' }).click()
  await expect(page.getByRole('heading', { name: 'The Hush Signal' })).toBeVisible()
  await expect(page.getByRole('complementary').getByText('Vera Bell', { exact: true })).toBeVisible()
  await expect(page.getByText('Tunes the radio', { exact: true })).toBeVisible()
})

test('playing ahead keeps an earlier scene render attached to its own turn', async ({ page }) => {
  let releaseFirst
  const firstReady = new Promise(resolve => { releaseFirst = resolve })
  await page.route('**/api/turn', route => {
    const input = JSON.parse(route.request().postDataJSON().messages[1].content)
    return route.fulfill({ json: input.playerEntry === 'Board the ferry' ? generated : {
      ...generated, prose: 'You step closer. Theo sets the lantern on a crate.',
      scene: { ...generated.scene, action: 'Sets the lantern on a crate' },
    } })
  })
  await page.route('**/api/image', async route => {
    if (route.request().postDataJSON().scene.action.includes('Hoists')) await firstReady
    await route.fulfill({ json: { image } })
  })
  await page.goto('/')
  await page.getByLabel('Your move').fill('Board the ferry')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Drawing the character locally…')).toBeVisible()
  await page.getByLabel('Your move').fill('Step closer')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('img', { name: /Theo Rusk.*Sets/ })).toBeVisible()
  releaseFirst()
  await page.getByRole('button', { name: 'Rewind' }).click()
  await expect(page.getByRole('img', { name: /Theo Rusk.*Hoists/ })).toBeVisible()
})

test('a named companion still gets a character illustration when the model omits focus', async ({ page }) => {
  await page.route('**/api/turn', route => route.fulfill({ json: {
    ...generated, prose: 'Mara hangs her wet coat by the door.',
    scene: { focus: '', location: 'Your apartment', action: '', details: '' },
  } }))
  await page.route('**/api/image', async route => {
    const request = route.request().postDataJSON()
    expect(request.reference).toBe('mara.webp')
    expect(request.scene.location).toBe('Your apartment')
    expect(request.scene.action).toContain('hangs her wet coat')
    await route.fulfill({ json: { image } })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Character illustration' })).toBeVisible()
  await page.getByLabel('Your move').fill('You take Mara to your apartment.')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('img', { name: /Mara Venn.*hangs/ })).toBeVisible()
})

test('an echoed player entry is retried and only new narration is saved', async ({ page }) => {
  const entry = 'You set the key on the table.'
  let attempts = 0
  await page.route('**/api/turn', route => {
    attempts += 1
    return route.fulfill({ json: {
      ...generated, prose: attempts === 1 ? entry : 'Mara slips the key into her coat.',
      scene: { ...generated.scene, focus: 'none' },
    } })
  })
  await page.goto('/')
  await page.getByLabel('Your move').fill(entry)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Mara slips the key into her coat.')).toBeVisible()
  await expect(page.getByText(entry, { exact: true })).toHaveCount(1)
  expect(attempts).toBe(2)
})
