export const starter = {
  title: 'The Last Stop',
  premise: 'A slow-burn noir mystery in a flooded port city. The final ferry vanished with all its passengers. Mara Venn, a former harbor dispatcher, has traced it to a sealed locker. Theo Rusk, the night ferryman, knows what is inside. Both are adults.',
  opening: 'At 2:13 a.m., the rain turns the diner windows into river glass. Mara Venn sits alone in the last booth. There are two cups of coffee on the table, and neither is warm.\n\nShe slides a brass key out from under her saucer. “Locker seventeen. If someone asks where you got it, say you found it in the river.”\n\nOutside, a ferry horn sounds. The last boat was supposed to leave an hour ago.',
  location: 'The Breakwater Diner',
  characters: [
    { id: 'mara', name: 'Mara Venn', appearance: 'Adult woman with olive skin and a short dark bob', reference: 'mara.webp' },
    { id: 'theo', name: 'Theo Rusk', appearance: 'Adult man with a salt-and-pepper beard and cropped hair', reference: '' },
  ],
  focus: 'mara',
  action: 'Slides a brass key across the diner table',
}
export const openingChoices = ['You ask Mara what happened to the ferry.', 'You examine the brass key.']
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
    format: {
      ...resultSchema,
      properties: {
        ...resultSchema.properties,
        scene: {
          ...resultSchema.properties.scene,
          properties: {
            ...resultSchema.properties.scene.properties,
            focus: { type: 'string', enum: ['none', ...campaign.world.characters.map(character => character.id)] },
          },
        },
      },
    },
    messages: [
      { role: 'system', content: [
        'The player is the sole protagonist. Address the player as "you". Every named character in the cast is an NPC, including whoever is in the illustration.',
        'The latest player entry is the next passage of the story, written by the player. The app already prints it verbatim. Continue immediately after it with a new reaction, consequence, or development. Do not quote, paraphrase, or recap the entry as your continuation, and do not assign it to an NPC. Interpret first-person, second-person and subjectless actions as the player’s own.',
        'Treat events the player states as having happened as established story facts, including actions, dialogue, who is present and changes of location. If the player explicitly writes an attempt or question, continue from the attempt or question. Never choose a new action for the player.',
        'Example: player entry "You take Mara to your apartment." Continue with "Mara hangs her wet coat by the door." The scene is the player’s apartment, Mara is present, and the player brought her there. Carry those facts forward.',
        'Use the saved scene and prior player entries for continuity. If generated prose or older memory contradicts a player-authored fact, follow the player entry. Update the rolling summary and durable facts with established changes, including who did what. Write up to three suggested player entries in second person.',
        'Use the player’s current physical location for scene.location. For scene.focus, use the ID of the NPC currently interacting with or accompanying the player. The NPC can be silent or doing something nearby. In the apartment example use "mara". Keep the same NPC across a change of location when they accompany the player. Use "none" when no NPC is with the player. Bystanders stay out of focus.',
        'For scene.action, describe the NPC in the middle of the visible action. Specify their pose, the object they handle and where it is. For example: "Reaches up to place a wet coat on a wall hook inside the entryway." For scene.details, give short visual cues for expression, current clothing or dress state, props and lighting. Preserve the scene’s established visible details across turns and describe them directly regardless of genre or tone. Preserve the previous visible action when only dialogue changes. If focus is "none", use empty action and details.',
        'Respond with the requested JSON only.',
      ].join(' ') },
      { role: 'user', content: JSON.stringify({
        premise: campaign.world.premise,
        cast: campaign.world.characters.map(({ id, name, appearance }) => ({ id, name, appearance })),
        summary: current.summary, facts: current.facts, scene: current.scene,
        recent: turns.slice(-5).map(({ input, prose }) => ({ playerEntry: input, continuation: prose })),
        playerEntry: input,
      }) },
    ],
  }
}

export function repeatsPlayerEntry(entry, prose) {
  if (typeof prose !== 'string') return false
  const normalize = text => text.normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^(?:i|you) /, '')
  return normalize(entry) === normalize(prose)
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
  const rawScene = Object.fromEntries(['location', 'focus', 'action', 'details'].map(key => [key, checkedText(result.scene?.[key], 300)]))
  const scene = resolveCharacter(campaign.world, rawScene, input, prose)
  const turn = {
    id, parent: previous.id, input, prose, scene, choices: checkedList(result.choices, 3),
    summary: checkedText(result.summary, 2200), facts: checkedList(result.facts, 20),
    image: scene.focus && sameScene(previous.scene, scene) && !previous.artDirection ? previous.image : '',
  }
  return { ...campaign, active: id, turns: { ...campaign.turns, [id]: turn } }
}

function characterNames(character, characters) {
  const full = character.name.trim().toLowerCase()
  const first = full.split(/\s+/)[0]
  return first && first !== full && characters.filter(person =>
    person.name.trim().toLowerCase().split(/\s+/)[0] === first).length === 1 ? [full, first] : [full]
}

function resolveCharacter(world, scene, input, prose) {
  const focus = (scene.focus || '').trim().toLowerCase()
  if (focus === 'none') return scene
  const cast = world.characters.map(character => ({ character, names: characterNames(character, world.characters) }))
  const selected = cast.filter(({ character, names }) => character.id.toLowerCase() === focus || names.includes(focus))
  if (selected.length === 1) return { ...scene, focus: selected[0].character.id }

  const words = text => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')
  const mentioned = text => {
    const normalized = ` ${words(text)} `
    return cast.filter(({ names }) => names.some(name => name && normalized.includes(` ${words(name)} `)))
  }
  const inProse = mentioned(prose)
  const inEntry = mentioned(input)
  const matches = inProse.length === 1 ? inProse : inProse.length === 0 ? inEntry : []
  if (matches.length !== 1) return { ...scene, focus: '' }
  const { character, names } = matches[0]
  const sentence = prose.split(/[.!?\n]/).map(line => line.trim()).find(line =>
    names.filter(Boolean).some(name => line.toLowerCase().startsWith(name + ' ')))
  return { ...scene, focus: character.id, action: scene.action || sentence?.slice(0, 180) || '' }
}

export function recoverCharacterIllustrations(campaign) {
  let changed = false
  const turns = Object.fromEntries(Object.entries(campaign.turns).map(([id, turn]) => {
    if (!turn.parent || turn.scene.focus) return [id, turn]
    const scene = resolveCharacter(campaign.world, turn.scene, turn.input || '', turn.prose)
    if (!scene.focus) return [id, turn]
    changed = true
    return [id, { ...turn, scene }]
  }))
  return changed ? { ...campaign, turns } : campaign
}

export function sameScene(a, b) {
  const normalize = value => value.trim().toLowerCase().replace(/[.!?]+$/, '')
  return ['focus', 'location', 'action', 'details'].every(key => normalize(a[key]) === normalize(b[key]))
}

export function imageRequest(world, scene, direction = {}) {
  const character = world.characters.find(entry => entry.id === scene.focus)
  if (!character) return null
  const bundled = starter.characters.find(person => person.id === character.id)
  const defaultAppearance = [
    'Adult woman with olive skin, short dark bob, tan raincoat and burgundy sweater',
    'Adult man with a salt-and-pepper beard, cropped hair, dark wool coat and gray cap',
  ]
  const appearance = bundled?.name === character.name && defaultAppearance.includes(character.appearance)
    ? bundled.appearance : character.appearance
  return {
    reference: character.reference,
    scene: {
      action: direction.action || scene.action, location: direction.location || scene.location,
      details: direction.details ?? scene.details, appearance,
    },
  }
}

export function attachImage(campaign, id, image) {
  if (!Object.hasOwn(campaign.turns, id)) return campaign
  return { ...campaign, turns: { ...campaign.turns, [id]: { ...campaign.turns[id], image } } }
}
