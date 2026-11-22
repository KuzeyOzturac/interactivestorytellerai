export const starter = {
  title: 'The Last Stop',
  premise: 'A slow-burn noir mystery in a flooded port city. The final ferry vanished with all its passengers. Mara Venn, a former harbor dispatcher, has traced it to a sealed locker. Theo Rusk, the night ferryman, knows what is inside. Both are adults.',
  opening: 'At 2:13 a.m., the rain turns the diner windows into river glass. Mara Venn sits alone in the last booth. There are two cups of coffee on the table, and neither is warm.\n\nShe slides a brass key out from under her saucer. “Locker seventeen. If someone asks where you got it, say you found it in the river.”\n\nOutside, a ferry horn sounds. The last boat was supposed to leave an hour ago.',
  location: 'The Breakwater Diner',
  characters: [
    { id: 'mara', name: 'Mara Venn', appearance: 'Adult woman with olive skin, short dark bob, tan raincoat and burgundy sweater', reference: 'mara.webp' },
    { id: 'theo', name: 'Theo Rusk', appearance: 'Adult man with a salt-and-pepper beard, cropped hair, dark wool coat and gray cap', reference: '' },
  ],
  focus: 'mara',
  action: 'Slides a brass key across the diner table',
}
export const openingChoices = ['Ask Mara what happened to the ferry', 'Examine the brass key']
export function createCampaign(world = starter) {
  return {
    version: 1, world, active: 'opening',
    turns: { opening: {
      id: 'opening', parent: null, input: '', prose: world.opening,
      choices: world === starter ? openingChoices : [],
      scene: { location: world.location, focus: world.focus, action: world.action, details: '' },
      facts: [], summary: '', image: world === starter ? 'mara.webp' : '',
    } },
  }
}

export function history(campaign, end = campaign.active) {
  const turns = []
  const visited = new Set()
  for (let id = end; id != null; id = campaign.turns[id].parent) {
    if (visited.has(id) || !Object.hasOwn(campaign.turns, id)) throw new Error('Invalid story history.')
    visited.add(id)
    turns.push(campaign.turns[id])
  }
  return turns.reverse()
}

export const resultSchema = {
  type: 'object',
  required: ['prose', 'choices', 'scene', 'facts', 'summary'],
  properties: {
    prose: { type: 'string' },
    choices: { type: 'array', maxItems: 3, items: { type: 'string' } },
    scene: {
      type: 'object', required: ['location', 'focus', 'action', 'details'],
      properties: Object.fromEntries(['location', 'focus', 'action', 'details'].map(key => [key, { type: 'string' }])),
    },
    facts: { type: 'array', maxItems: 20, items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

export function requestFor(campaign, input) {
  const turns = history(campaign)
  const current = turns.at(-1)
  return {
    format: resultSchema,
    messages: [
      { role: 'system', content: [
        'The player is the sole protagonist. Address the player as "you". Every named character in the cast is an NPC, including whoever is in the illustration.',
        'The latest player action is performed or attempted by the player. Interpret an omitted subject, such as "check the key" or "leave", as "I". Begin prose with "You" or "Your" and immediately resolve that specific action or speech. If it is blocked, show what stops the player. Never give the player’s action to an NPC or invent a new decision for the player.',
        'Example: "Check the key for fingerprints" → "You tilt the key toward the light. A faint print crosses its head. Mara watches from across the table."',
        'After resolving the action, narrate NPC reactions and consequences. Offer up to three actions for the player. Keep established facts and a rolling summary. Older narration may have confused the roles. Always follow the player ownership rule.',
        'Use the player’s current physical location for scene.location. For scene.focus, use the ID of the NPC currently interacting with the player. If the player leaves that NPC behind or is alone, use an empty string. Bystanders stay out of focus.',
        'For scene.action, describe only what that NPC is visibly doing in this scene, in a short concrete phrase. For scene.details, use short visual cues for expression, props and lighting. Preserve the previous visible action when only dialogue changes. If focus is empty, use empty action and details.',
        'Respond with the requested JSON only.',
      ].join(' ') },
      { role: 'user', content: JSON.stringify({
        premise: campaign.world.premise,
        cast: campaign.world.characters.map(({ id, name, appearance }) => ({ id, name, appearance })),
        summary: current.summary, facts: current.facts, scene: current.scene,
        recent: turns.slice(-5).map(({ input, prose }) => ({ playerAction: input, prose })), action: input,
      }) },
    ],
  }
}

function checkedText(value, max) {
  if (typeof value !== 'string') throw new Error('The narrator returned an incomplete turn. Try again.')
  return value.trim().slice(0, max)
}
function checkedList(value, count) {
  if (!Array.isArray(value)) throw new Error('The narrator returned an incomplete turn. Try again.')
  return value.slice(0, count).map(item => checkedText(item, 300)).filter(Boolean)
}

export function addTurn(campaign, id, input, result) {
  const previous = campaign.turns[campaign.active]
  const prose = checkedText(result.prose, 5000)
  if (!prose) throw new Error('The narrator returned an empty passage. Try again.')
  if (!/^(you|your)\b/i.test(prose)) {
    throw new Error('The narrator lost the player’s point of view. Try the action again.')
  }
  const scene = Object.fromEntries(['location', 'focus', 'action', 'details'].map(key => [key, checkedText(result.scene?.[key], 300)]))
  if (scene.focus && !campaign.world.characters.some(character => character.id === scene.focus)) {
    scene.focus = ''
  }
  const turn = {
    id, parent: previous.id, input, prose, scene, choices: checkedList(result.choices, 3),
    summary: checkedText(result.summary, 2200), facts: checkedList(result.facts, 20),
    image: scene.focus && sameScene(previous.scene, scene) ? previous.image : '',
  }
  return { ...campaign, active: id, turns: { ...campaign.turns, [id]: turn } }
}

export function sameScene(a, b) {
  const normalize = value => value.trim().toLowerCase().replace(/[.!?]+$/, '')
  return ['focus', 'location', 'action', 'details'].every(key => normalize(a[key]) === normalize(b[key]))
}

export function imageRequest(world, scene) {
  const character = world.characters.find(entry => entry.id === scene.focus)
  if (!character) return null
  return {
    reference: character.reference,
    scene: { action: scene.action, location: scene.location, details: scene.details, appearance: character.appearance },
  }
}

export function attachImage(campaign, id, image) {
  if (!Object.hasOwn(campaign.turns, id)) return campaign
  return { ...campaign, turns: { ...campaign.turns, [id]: { ...campaign.turns[id], image } } }
}
