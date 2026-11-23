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
  wardrobe: 'Tan raincoat over a burgundy sweater',
  initialState: { 'item.brass-key.holder': 'On the diner table' },
  action: 'Slides a brass key across the diner table',
}
export const openingChoices = ['You ask Mara what happened to the ferry.', 'You examine the brass key.']
export function createCampaign(world = starter) {
  return {
    version: 1, id: globalThis.crypto.randomUUID(), world, active: 'opening',
    turns: { opening: {
      id: 'opening', parent: null, input: '', prose: world.opening,
      choices: world === starter ? openingChoices : [],
      scene: { location: world.location, focus: world.focus, action: world.action, wardrobe: world.wardrobe || '', details: '' },
      facts: [], state: { ...world.initialState }, summary: '', image: world === starter ? 'mara.webp' : '',
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

export const cameraAngles = {
  '': 'Automatic',
  'eye-level': 'Eye level',
  low: 'Looking up',
  high: 'Looking down',
  close: 'Close-up',
  side: 'Side view',
}

export const resultSchema = {
  type: 'object',
  required: ['prose', 'choices', 'scene', 'facts', 'summary', 'stateChanges', 'supersededFacts'],
  properties: {
    prose: { type: 'string' },
    choices: { type: 'array', maxItems: 3, items: { type: 'string' } },
    scene: {
      type: 'object', required: ['location', 'focus', 'action', 'wardrobe', 'details', 'viewpoint'],
      properties: {
        ...Object.fromEntries(['location', 'focus', 'action', 'wardrobe', 'details'].map(key => [key, { type: 'string' }])),
        viewpoint: { type: 'string', enum: Object.keys(cameraAngles) },
      },
    },
    facts: { type: 'array', maxItems: 20, items: { type: 'string' } },
    summary: { type: 'string' },
    stateChanges: {
      type: 'array', maxItems: 20,
      items: { type: 'object', required: ['key', 'value'], properties: {
        key: { type: 'string' }, value: { type: 'string' },
      } },
    },
    supersededFacts: { type: 'array', maxItems: 20, items: { type: 'string' } },
  },
}

// A declared transfer of an already tracked item updates custody before generation.
function declaredCustody(state, entry, characters) {
  const take = /^(?:you |i )?(?:take|pick up) (?:the |a )?([\w -]+?)(?: from [\w -]+)?[.!]?$/i.exec(entry.trim())
  const give = /^(?:you |i )?(?:give|hand) (?:the |a )?([\w -]+?) to ([\w -]+)[.!]?$/i.exec(entry.trim())
  const item = (take?.[1] || give?.[1])?.trim().toLowerCase().replace(/ +/g, '-')
  const key = `item.${item}.holder`
  if (!item || !Object.hasOwn(state, key)) return {}
  if (take) return { [key]: 'Player' }
  const recipient = give[2].trim().toLowerCase()
  const matches = characters.filter(person => person.id.toLowerCase() === recipient ||
    person.name.toLowerCase() === recipient || person.name.toLowerCase().split(/ +/)[0] === recipient)
  return matches.length === 1 ? { [key]: give[2].trim() } : {}
}

function declaredViewpoint(entry) {
  const match = /^(?:you |i )?(?:sit (?:down|on the floor) and |kneel and |stand and )?look (up|down) at [\w -]+[.!]?$/i.exec(entry.trim())
  return match ? (match[1].toLowerCase() === 'up' ? 'low' : 'high') : ''
}

function declaredDestination(entry) {
  const move = /^(?:you |i )?(?:go|walk|head|return|take [\w -]+?|bring [\w -]+?) (?:back )?to (?:your|my) (apartment|home|house|room)\b/i.exec(entry.trim())
  return move?.[1].toLowerCase() || ''
}

export function contradictsDestination(entry, scene) {
  const destination = declaredDestination(entry)
  if (!destination || typeof scene?.location !== 'string') return false
  return !scene.location.toLowerCase().includes(destination)
}

function declaredVisibleAction(entry, characters) {
  for (const sentence of entry.split(/[.!?\n]+/)) {
    const line = sentence.trim()
    const lower = line.toLowerCase()
    for (const character of characters) {
      for (const name of characterNames(character, characters)) {
        if (!name || !lower.startsWith(name + ' ')) continue
        const action = line.slice(name.length + 1)
        if (/^hangs (?:up )?(?:her |his |their |the |a )?(?:wet )?(?:coat|jacket|raincoat)\b/i.test(action)) {
          return { focus: character.id, action: action.charAt(0).toUpperCase() + action.slice(1) }
        }
      }
    }
  }
  return null
}

export function requestFor(campaign, input) {
  const turns = history(campaign)
  const current = turns.at(-1)
  const state = current.state ?? {}
  const playerStateChanges = declaredCustody(state, input, campaign.world.characters)
  const destination = declaredDestination(input)
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
        'Continue interactive fiction. The player is the protagonist, called “you.” All named cast members are NPCs. The latest playerEntry is already in the story. Start with the next event, without quoting, restating, or explaining the entry. An attempt can fail. Never decide a new action for the player.',
        'Base the turn on the latest entry before older context. If playerDestination is set, the player is already there at the start of your continuation. Keep the player there for this turn. If playerVisibleAction is set, use that established action to frame the image. When someone went with the player, keep them present. Do not move absent characters off-screen or invent where they are.',
        'Example: entry “You bring the watchmaker to your room.” Prose “He stops by the window and listens.” Location “Your room.” The watchmaker is with you.',
        'Current state describes the present. playerStateChanges have already happened. Reuse existing state keys. For custody use item.<item-slug>.holder, one key per item. Return only changes, with an empty value to clear a key. Keep past events in the summary and durable facts in plain sentences. Copy obsolete facts into supersededFacts.',
        'For scene.focus use the present NPC the player is interacting with or accompanying, or none. Write one short visible action and only the clothes the NPC is currently wearing. Carry wardrobe forward unless the latest entry or prose changes it. A coat hung on a hook is a prop. Use scene.details for other cues and scene.viewpoint for the player’s angle: low, high, close, side, eye-level, or empty.',
        'Return JSON only. Prose is in-world fiction, never analysis or a recap. Give up to three short second-person choices that follow the new event.',
      ].join('\n') },
      { role: 'user', content: JSON.stringify({
        premise: campaign.world.premise,
        cast: campaign.world.characters.map(({ id, name, appearance }) => ({ id, name, appearance })),
        summary: current.summary, facts: current.facts, currentState: { ...state, ...playerStateChanges }, playerStateChanges, scene: current.scene,
        recent: turns.slice(-5).map(({ input, prose }) => ({ playerEntry: input, continuation: isNarratorCommentary(prose) ? '' : prose })),
        relevantMemories: recallMemories(turns, input),
        playerDestination: destination ? 'Your ' + destination : '',
        playerVisibleAction: declaredVisibleAction(input, campaign.world.characters),
        playerEntry: input,
      }) },
    ],
  }
}

function recallMemories(turns, input) {
  const terms = text => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [])
  const query = terms(input)
  for (const common of ['that', 'this', 'with', 'about', 'there', 'what', 'your', 'from', 'have', 'would']) query.delete(common)
  const score = text => [...terms(text)].filter(word => query.has(word)).length
  return turns.slice(1, -5)
    .map(turn => ({
      playerEntry: turn.input.slice(0, 220),
      event: isNarratorCommentary(turn.prose) ? '' : turn.prose.slice(0, 280),
    }))
    .map(memory => ({ memory, score: score(memory.playerEntry + ' ' + memory.event) }))
    .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score)
    .slice(0, 3).map(entry => entry.memory)
}

export function isNarratorCommentary(prose) {
  if (typeof prose !== 'string') return false
  return /(?:^|\n|[.!?]\s+)\s*(?:<think>|(?:analysis|reasoning)\s*:|(?:the )?player(?:['’]s) (?:recent |latest |current |previous )?(?:entry|input|action) (?:is|was|means|implies|suggests|indicates)\b|the previous continuation (?:states|says|describes)\b|the scene(?:['’]s current state| state) is\s*:)/i.test(prose)
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

function updateState(previous, changes) {
  const state = new Map(Object.entries(previous ?? {}))
  for (const change of (changes ?? []).slice(0, 20)) {
    const key = checkedText(change.key, 100).toLowerCase()
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(key)) continue
    const value = checkedText(change.value, 200)
    if (value) state.set(key, value)
    else state.delete(key)
  }
  return Object.fromEntries(state)
}

export function addTurn(campaign, id, input, result) {
  const previous = campaign.turns[campaign.active]
  const prose = checkedText(result.prose, 5000)
  if (!prose) throw new Error('The narrator returned an empty passage. Try again.')
  if (isNarratorCommentary(prose)) throw new Error('The narrator returned commentary instead of story prose. Try the turn again.')
  if (contradictsDestination(input, result.scene)) throw new Error('The narrator lost track of where you went. Try the turn again.')
  const rawScene = Object.fromEntries(['location', 'focus', 'action', 'details'].map(key => [key, checkedText(result.scene?.[key], 300)]))
  const scene = resolveCharacter(campaign.world, rawScene, input, prose)
  const custody = declaredCustody(previous.state ?? {}, input, campaign.world.characters)
  const state = { ...updateState(previous.state, result.stateChanges), ...custody }
  for (const [key, holder] of Object.entries(state)) {
    const item = /^item\.([a-z0-9-]+)\.holder$/.exec(key)?.[1]
    if (!item || typeof holder !== 'string' || holder.toLowerCase() !== 'player') continue
    const lastWord = item.split('-').at(-1)
    if (/^(holds?|grips?|clutches?|pockets?|carries|catches|takes?|tightens)\b/i.test(scene.action) &&
        scene.action.toLowerCase().split(/[^\p{L}\p{N}]+/u).includes(lastWord)) {
      scene.action = ''
    }
  }
  if (scene.focus && scene.focus !== 'none') {
    const viewpoint = result.scene.viewpoint ?? (scene.focus === previous.scene.focus ? previous.scene.viewpoint : '')
    scene.viewpoint = declaredViewpoint(input) || (Object.hasOwn(cameraAngles, viewpoint) ? viewpoint : '')
    scene.wardrobe = checkedText(result.scene.wardrobe ?? (scene.focus === previous.scene.focus ? previous.scene.wardrobe : '') ?? '', 150)
  }
  const normalizeFact = fact => fact.toLowerCase().replace(/[.!?]+$/, '')
  const superseded = new Set(checkedList(result.supersededFacts ?? [], 20).map(normalizeFact))
  const turn = {
    id, parent: previous.id, input, prose, scene, choices: checkedList(result.choices, 3),
    summary: checkedText(result.summary, 2200),
    facts: checkedList(result.facts, 20).filter(fact =>
      !/^[\w-]+(?:\.[\w-]+)+\s*[:=]/.test(fact) && !superseded.has(normalizeFact(fact))),
    state,
    imageStyle: previous.imageStyle,
    image: scene.focus && sameScene(previous.scene, scene) && !previous.artDirection && (previous.imageStyle || '') === (campaign.world.artRevision || campaign.world.artStyle || '') ? previous.image : '',
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
  const normalize = (value = '') => value.trim().toLowerCase().replace(/[.!?]+$/, '')
  return ['focus', 'location', 'action', 'wardrobe', 'viewpoint'].every(key => normalize(a[key]) === normalize(b[key]))
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
    reference: direction.disableFace ? '' : character.reference,
    exactPrompt: direction.exactPrompt || '',
    styleReference: world.styleReference || '',
    depthGuide: direction.depthGuide || '',
    scene: {
      action: direction.action || scene.action.split(',')[0].trim(), location: direction.location || scene.location,
      wardrobe: direction.wardrobe ?? scene.wardrobe ?? '',
      appearance, style: world.artStyle || '',
      viewpoint: direction.viewpoint || scene.viewpoint || '',
    },
  }
}

export function attachImage(campaign, id, image, style = '') {
  if (!Object.hasOwn(campaign.turns, id)) return campaign
  return { ...campaign, turns: { ...campaign.turns, [id]: { ...campaign.turns[id], image, imageStyle: style } } }
}
