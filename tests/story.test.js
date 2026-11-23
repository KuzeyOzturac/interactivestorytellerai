import test from 'node:test'
import assert from 'node:assert/strict'
import { addTurn, attachImage, createCampaign, history, imageRequest, recoverCharacterIllustrations, requestFor } from '../src/story.js'

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
  assert.equal(context.recent[0].playerEntry, 'Action 26')
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

test('the exact player narration and resulting scene carry into the next turn', () => {
  const campaign = createCampaign()
  const entry = 'You take Mara to your apartment.'
  const next = addTurn(campaign, 'apartment', entry, result(campaign, {
    prose: 'Mara hangs her wet coat by the door.',
    scene: { focus: 'mara', location: 'Your apartment', action: 'Hangs her wet coat', details: '' },
    facts: ['You brought Mara to your apartment.'],
  }))
  const request = requestFor(next, 'You offer Mara a towel.')
  const context = JSON.parse(request.messages[1].content)
  assert.equal(context.playerEntry, 'You offer Mara a towel.')
  assert.deepEqual(context.recent.at(-1), { playerEntry: entry, continuation: 'Mara hangs her wet coat by the door.' })
  assert.equal(context.scene.location, 'Your apartment')
  assert.equal(context.scene.focus, 'mara')
  assert.match(request.messages[0].content, /Start with the next event/)
})

test('a saved apartment turn recovers Mara, and an explicitly solo turn stays solo', () => {
  const start = createCampaign()
  const apartment = addTurn(start, 'apartment', 'You take Mara to your apartment.', result(start, {
    prose: 'Mara hangs her wet coat by the door.',
    scene: { location: 'Your apartment', focus: 'mara', action: '', details: '' },
  }))
  apartment.turns.apartment.scene.focus = ''
  const recovered = recoverCharacterIllustrations(apartment)
  assert.equal(recovered.turns.apartment.scene.focus, 'mara')
  assert.match(recovered.turns.apartment.scene.action, /hangs her wet coat/i)
  const solo = addTurn(recovered, 'solo', 'You leave Mara behind and walk home alone.', result(recovered, {
    prose: 'Mara waves goodbye.',
    scene: { location: 'Outside', focus: 'none', action: '', details: '' },
  }))
  assert.equal(imageRequest(solo.world, recoverCharacterIllustrations(solo).turns.solo.scene), null)
})

test('saved starter wardrobe does not compete with the current art direction', () => {
  const campaign = createCampaign()
  const world = { ...campaign.world, characters: [
    { ...campaign.world.characters[0], appearance: 'Adult woman with olive skin, short dark bob, tan raincoat and burgundy sweater' },
  ] }
  const request = imageRequest(world, campaign.turns.opening.scene, {
    action: 'Lifts a wet coat onto a wall hook',
    location: 'Inside the apartment entryway',
  })
  assert.match(request.scene.action, /wall hook/)
  assert.equal(request.scene.location, 'Inside the apartment entryway')
  assert.doesNotMatch(request.scene.appearance, /raincoat/)
})

test('automatic art uses a short action and the same style across a world', () => {
  const { world } = createCampaign()
  const styled = { ...world, artStyle: 'muted watercolor' }
  const scene = { focus: 'mara', action: 'Sits on the floor, looking at the key', location: 'Apartment' }
  assert.equal(imageRequest(styled, scene).scene.action, 'Sits on the floor')
  assert.equal(imageRequest(styled, scene).scene.style, 'muted watercolor')
  assert.equal(imageRequest(styled, { ...scene, focus: 'theo' }).scene.style, 'muted watercolor')
})

test('a change in player viewpoint triggers fresh art for the same character and action', () => {
  const start = createCampaign()
  const fromFloor = addTurn(start, 'floor', 'You sit on the floor and look up at Mara.', result(start, {
    scene: { ...start.turns.opening.scene, viewpoint: 'eye-level' },
  }))
  const turn = fromFloor.turns.floor
  assert.equal(turn.image, '')
  assert.equal(imageRequest(start.world, turn.scene).scene.viewpoint, 'low')
  assert.equal(imageRequest(start.world, turn.scene, { viewpoint: 'high' }).scene.viewpoint, 'high')
})

test('taking the key replaces its holder, retires stale memory, and keeps the rewind state', () => {
  const start = createCampaign()
  const withMara = addTurn(start, 'mara-key', 'You give Mara the brass key.', result(start, {
    facts: ['Mara has the brass key.', 'You promised to meet Mara at the ferry.'],
    stateChanges: [{ key: 'item.brass-key.holder', value: 'Mara' }],
  }))
  const withPlayer = addTurn(withMara, 'player-key', 'You take the brass key from Mara.', result(withMara, {
    facts: withMara.turns['mara-key'].facts,
    stateChanges: [{ key: 'item.brass-key.holder', value: 'Player' }],
    supersededFacts: ['Mara has the brass key'],
  }))
  const context = JSON.parse(requestFor(withPlayer, 'You inspect the key.').messages[1].content)
  assert.equal(context.currentState['item.brass-key.holder'], 'Player')
  assert.deepEqual(context.facts, ['You promised to meet Mara at the ferry.'])
  assert.equal(context.recent.at(-2).playerEntry, 'You give Mara the brass key.')
  const rewind = { ...withPlayer, active: 'mara-key' }
  const oldContext = JSON.parse(requestFor(rewind, 'You wait.').messages[1].content)
  assert.equal(oldContext.currentState['item.brass-key.holder'], 'Mara')
})

test('older relevant events are recalled only from the active branch', () => {
  const start = createCampaign()
  let branch = addTurn(start, 'promise', 'You promise to meet Mara at the ferry.', result(start))
  for (let index = 0; index < 6; index++) {
    branch = addTurn(branch, 'later-' + index, 'You watch the storm.', result(branch))
  }
  const request = campaign => JSON.parse(requestFor(campaign, 'You ask about the ferry.').messages[1].content)
  assert.match(request(branch).relevantMemories[0].playerEntry, /promise/)
  assert.deepEqual(request({ ...branch, active: 'opening' }).relevantMemories, [])
})

test('a declared tracked-item transfer is authoritative even if the model disagrees', () => {
  const start = createCampaign()
  const entry = 'You take the brass key from Mara.'
  const context = JSON.parse(requestFor(start, entry).messages[1].content)
  assert.equal(context.currentState['item.brass-key.holder'], 'Player')
  const next = addTurn(start, 'take', entry, result(start, {
    stateChanges: [{ key: 'item.brass-key.holder', value: 'Mara' }],
    scene: { ...start.turns.opening.scene, action: 'Holds the brass key in her palm' },
  }))
  assert.equal(next.turns.take.scene.action, '')
  assert.equal(next.turns.take.state['item.brass-key.holder'], 'Player')
  const later = addTurn(next, 'later', 'You look up at Mara.', result(next, {
    scene: { ...start.turns.opening.scene, action: 'Holds the brass key in her palm' },
  }))
  assert.equal(later.turns.later.scene.action, '')
  const attempt = JSON.parse(requestFor(start, 'You try to take the brass key.').messages[1].content)
  assert.deepEqual(attempt.playerStateChanges, {})
})

test('an established move to the apartment cannot be saved as an unrelated location', () => {
  const start = createCampaign()
  const entry = 'You take Mara to your apartment. Mara hangs her coat.'
  const input = JSON.parse(requestFor(start, entry).messages[1].content)
  assert.equal(input.playerDestination, 'Your apartment')
  assert.deepEqual(input.playerVisibleAction, { focus: 'mara', action: 'Hangs her coat' })
  assert.throws(() => addTurn(start, 'wrong-place', entry, result(start)), /lost track/)
  assert.doesNotThrow(() => addTurn(start, 'right-place', entry, result(start, {
    scene: { ...start.turns.opening.scene, location: "Player's apartment hallway" },
  })))
})

test('the reviewed coat frame replaces a legacy render only for the matching starter beat', () => {
  const start = createCampaign()
  const proposed = result(start, {
    prose: 'Mara hangs her wet coat by the door.',
    scene: { focus: 'mara', location: 'Your apartment', action: 'Hangs wet coat', details: '', wardrobe: 'Wearing a navy-blue trench coat' },
  })
  const campaign = addTurn(start, 'coat', 'You take her to your apartment.', proposed)
  assert.equal(campaign.turns.coat.image, 'mara-coat-hook.webp')
  const legacy = { ...campaign, turns: { ...campaign.turns, coat: { ...campaign.turns.coat, image: 'bad.webp', imageSource: undefined } } }
  assert.equal(recoverCharacterIllustrations(legacy).turns.coat.image, 'mara-coat-hook.webp')
  assert.equal(recoverCharacterIllustrations({ ...legacy, world: { ...legacy.world, artStyle: 'watercolor' } }).turns.coat.image, 'bad.webp')
  assert.equal(recoverCharacterIllustrations(attachImage(legacy, 'coat', 'custom.webp')).turns.coat.image, 'custom.webp')
})

test('explicit NPC actions and their props survive across unrelated custom worlds', () => {
  for (const [title, name, location, action] of [
    ['Clockwork Dawn', 'Imani', 'Clock workshop', 'Sits on a wooden stool'],
    ['Glasshouse Dusk', 'Emil', 'Greenhouse', 'Waters the fern with a yellow watering can'],
  ]) {
    const start = createCampaign({ title, premise: '', opening: '', location, focus: 'npc',
      action: '', characters: [{ id: 'npc', name, appearance: '', reference: '' }] })
    const entry = `You approach ${name}. ${name} ${action.charAt(0).toLowerCase() + action.slice(1)}.`
    const next = addTurn(start, 'new', entry, result(start, {
      scene: { ...start.turns.opening.scene, action: 'Glances toward you' },
    }))
    assert.equal(next.turns.new.image, '')
    assert.equal(imageRequest(start.world, next.turns.new.scene).scene.action, action)
  }
})
