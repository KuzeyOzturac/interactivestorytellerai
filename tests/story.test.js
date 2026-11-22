import test from 'node:test'
import assert from 'node:assert/strict'
import { addTurn, attachImage, createCampaign, history, imageRequest, requestFor } from '../src/story.js'

const result = (campaign, overrides = {}) => ({
  prose: 'You watch Mara turn to the window.', choices: ['Wait'],
  scene: campaign.turns[campaign.active].scene,
  facts: ['The player promised to return the brass key.'],
  summary: 'Mara revealed locker seventeen.',
  ...overrides,
})

test('turns carry recent context, durable facts and older summary', () => {
  let campaign = createCampaign()
  for (let i = 1; i <= 30; i++) campaign = addTurn(campaign, String(i), 'Action ' + i, result(campaign))
  const context = JSON.parse(requestFor(campaign, 'Go back').messages[1].content)
  assert.equal(context.recent.length, 5)
  assert.equal(context.recent[0].playerAction, 'Action 26')
  assert.match(context.facts[0], /promised/)
  assert.match(context.summary, /locker seventeen/)
})

test('art matches the focused character and their specific action', () => {
  const campaign = createCampaign()
  const scene = { focus: 'mara', location: 'Ferry deck', action: 'Holds a lantern above her head', details: 'Wind and rain' }
  const art = imageRequest(campaign.world, scene)
  assert.equal(art.reference, 'mara.webp')
  assert.equal(art.scene.action, scene.action)
  assert.equal(art.scene.location, scene.location)
  assert.equal(art.scene.appearance, campaign.world.characters[0].appearance)
  assert.equal(imageRequest(campaign.world, { ...scene, focus: '' }), null)
})

test('unchanged scenes reuse art and late renders stay on their branch', () => {
  const start = createCampaign()
  const first = addTurn(start, 'first', 'Wait', result(start))
  assert.equal(first.turns.first.image, 'mara.webp')
  const rewind = { ...first, active: 'opening' }
  const second = addTurn(rewind, 'second', 'Talk to Theo', result(start, {
    scene: { focus: 'theo', location: 'Ferry deck', action: 'Uncoils a rope', details: 'Fog' },
  }))
  assert.equal(second.turns.second.image, '')
  const saved = attachImage(second, 'first', 'rendered.webp')
  assert.equal(saved.active, 'second')
  assert.equal(saved.turns.second.image, '')
  assert.equal(saved.turns.first.image, 'rendered.webp')
  assert.deepEqual(history(saved).map(turn => turn.id), ['opening', 'second'])
})

test('a malformed model response cannot replace the active turn', () => {
  const campaign = createCampaign()
  assert.throws(() => addTurn(campaign, 'bad', 'Go', { prose: 'You wait.' }), /incomplete/)
  assert.equal(campaign.active, 'opening')
})

test('an NPC point of view cannot replace a player turn', () => {
  const campaign = createCampaign()
  const request = requestFor(campaign, 'Check the key for fingerprints')
  assert.match(request.messages[0].content, /player is the sole protagonist/)
  assert.match(request.messages[0].content, /Never give the player’s action to an NPC/)
  assert.throws(() => addTurn(campaign, 'bad', 'Check the key', result(campaign, {
    prose: 'Mara checks the key for fingerprints.',
  })), /lost the player’s point of view/)
})
