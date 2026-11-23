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

test('the apartment beat displays the reviewed image, with no render request', async ({ page }) => {
  let renders = 0
  await page.route('**/api/turn', route => route.fulfill({ json: {
    ...generated, prose: 'Mara hangs her wet coat by the door.',
    scene: { focus: '', location: 'Your apartment', action: '', details: '', wardrobe: 'Wearing a navy-blue trench coat' },
  } }))
  await page.route('**/api/image', async route => {
    renders++
    await route.fulfill({ json: { image } })
  })
  await page.goto('/')
  await page.getByLabel('Your move').fill('You take Mara to your apartment.')
  await page.getByRole('button', { name: 'Continue' }).click()
  const illustration = page.getByRole('img', { name: /Mara Venn.*hangs/ })
  await expect(illustration).toHaveAttribute('src', /mara-coat-hook\.webp$/)
  await expect.poll(() => illustration.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
  expect(renders).toBe(0)
  await page.reload()
  await expect(illustration).toHaveAttribute('src', /mara-coat-hook\.webp$/)
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

test('art direction can correct an illustration without rewriting the story', async ({ page }) => {
  await page.route('**/api/image', async route => {
    const { scene } = route.request().postDataJSON()
    expect(scene.action).toContain('wall hook')
    expect(scene.location).toBe('Inside the apartment entryway')
    expect(scene.wardrobe).toBe('Burgundy sweater')
    expect(scene.viewpoint).toBe('low')
    expect(route.request().postDataJSON().reference).toBe('')
    expect(route.request().postDataJSON().depthGuide).toMatch(/^data:image\/webp;base64,/)
    await route.fulfill({ json: { image } })
  })
  await page.goto('/')
  await page.getByText('Adjust illustration').click()
  await page.getByLabel('Visible action').fill('Reaches up to hang a wet coat on the wall hook')
  await page.getByLabel('Setting', { exact: true }).fill('Inside the apartment entryway')
  await page.getByLabel('Current wardrobe').fill('Burgundy sweater')
  await page.getByLabel('Camera angle').selectOption('low')
  await page.getByLabel('Render without the face reference').check()
  await page.getByLabel('Depth guide').setInputFiles({ name: 'depth.webp', mimeType: 'image/webp', buffer: Buffer.from(image.split(',')[1], 'base64') })
  const render = page.waitForResponse('**/api/image')
  await page.getByRole('button', { name: 'Render with changes' }).click()
  expect((await render).ok()).toBe(true)
  await expect(page.getByText('Slides a brass key across the diner table', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Render with changes' })).toBeEnabled()
  await page.reload()
  await page.getByText('Adjust illustration').click()
  await expect(page.getByLabel('Visible action')).toHaveValue(/wall hook/)
})

test('an exact image prompt is sent without narration details', async ({ page }) => {
  await page.route('**/api/image', async route => {
    const request = route.request().postDataJSON()
    expect(request.exactPrompt).toBe('portrait')
    expect(request.scene).not.toHaveProperty('details')
    await route.fulfill({ json: { image } })
  })
  await page.goto('/')
  await page.getByText('Adjust illustration').click()
  await page.getByLabel('Exact image prompt').fill('portrait')
  const response = page.waitForResponse('**/api/image')
  await page.getByRole('button', { name: 'Render with changes' }).click()
  expect((await response).ok()).toBe(true)
})

test('narrator commentary is retried and excluded from the transcript', async ({ page }) => {
  const entry = 'You show Mara the key.'
  const commentary = "The player's recent entry is: 'You show Mara the key.' This means the player wants a reaction."
  let attempts = 0
  await page.route('**/api/turn', route => {
    attempts += 1
    return route.fulfill({ json: {
      ...generated, prose: attempts === 1 ? commentary : 'Mara recognizes the notch cut into the key.',
      scene: { ...generated.scene, focus: 'none' },
    } })
  })
  await page.goto('/')
  await page.getByLabel('Your move').fill(entry)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Mara recognizes the notch cut into the key.')).toBeVisible()
  await expect(page.getByText(commentary, { exact: true })).toHaveCount(0)
  expect(attempts).toBe(2)
})

test('world art style persists and is sent to the illustration renderer', async ({ page }) => {
  await page.route('**/api/image', async route => {
    expect(route.request().postDataJSON().scene.style).toBe('muted watercolor')
    expect(route.request().postDataJSON().styleReference).toMatch(/^data:image\/webp;base64,/)
    await route.fulfill({ json: { image } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Journal' }).click()
  await page.getByRole('textbox', { name: 'Art style' }).fill('muted watercolor')
  await page.getByLabel('Style reference').setInputFiles({ name: 'style.webp', mimeType: 'image/webp', buffer: Buffer.from(image.split(',')[1], 'base64') })
  await page.getByRole('button', { name: 'Save art style' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await page.reload()
  const response = page.waitForResponse('**/api/image')
  await page.getByRole('button', { name: 'Regenerate art' }).click()
  expect((await response).ok()).toBe(true)
})

test('starting over leaves earlier campaigns available after reload', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New world' }).click()
  await page.getByLabel('Title').fill('The Hush Signal')
  await page.getByLabel('World and rules').fill('A radio only works in the snow.')
  await page.getByLabel('Opening scene').fill('The radio crackles.')
  await page.getByLabel('Location', { exact: true }).fill('The attic')
  await page.getByRole('button', { name: 'Start new campaign' }).click()
  await expect(page.getByRole('heading', { name: 'The Hush Signal' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Campaigns', exact: true }).click()
  await page.getByRole('button', { name: 'Start The Last Stop again' }).click()
  await expect(page.getByRole('heading', { name: 'The Last Stop' })).toBeVisible()
  await page.getByRole('button', { name: 'Campaigns', exact: true }).click()
  await page.getByRole('button', { name: 'The Hush Signal', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'The Hush Signal' })).toBeVisible()
})
