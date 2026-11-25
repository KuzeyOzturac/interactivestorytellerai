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

function declaredMove(entry, characters, previousFocus) {
  const move = /^(?:you |i )?(?:go|walk|head|return|(?:take|bring) ([\p{L}\p{N} -]+?)) (?:back )?to (?:your|my) (apartment|home|house|room)\b/iu.exec(entry.trim())
  if (!move) return null
  const companion = move[1]?.trim().toLowerCase()
  const matches = characters.filter(character => characterNames(character, characters).includes(companion))
  const focus = ['her', 'him', 'them'].includes(companion) ? previousFocus : matches.length === 1 ? matches[0].id : ''
  return { place: move[2].toLowerCase(), focus }
}

const nonVisualVerbs = new Set(['is', 'was', 'has', 'does', 'seems', 'wants', 'thinks', 'knows', 'remembers',
  'hopes', 'believes', 'plans', 'tries', 'says', 'asks', 'answers', 'replies', 'tells', 'mentions'])

function declaredVisibleAction(entry, characters) {
  for (const sentence of entry.match(/[^.!?\n]+[.!?]?/g) || []) {
    const line = sentence.trim().replace(/[.!]$/, '')
    if (line.endsWith('?')) continue
    const lower = line.toLowerCase()
    for (const character of characters) {
      for (const name of characterNames(character, characters)) {
        if (!name || !lower.startsWith(name + ' ')) continue
        const action = line.slice(name.length + 1)
        const verb = /^[a-z]+s\b/i.exec(action)?.[0].toLowerCase()
        if (verb && !nonVisualVerbs.has(verb)) {
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
  const move = declaredMove(input, campaign.world.characters, current.scene.focus)
  const scene = move ? {
    ...current.scene, location: 'Your ' + move.place, focus: move.focus,
    action: '', details: '', viewpoint: '', wardrobe: move.focus === current.scene.focus ? current.scene.wardrobe : '',
  } : current.scene
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
        'Continue interactive fiction. The player is the protagonist, called “you.” All named cast members are NPCs. Every action or outcome stated in the latest playerEntry has already happened and overrides older context. Start with its aftermath without restating it. An explicitly attempted action can fail. Never decide a new action for the player.',
        'Base the turn on the latest entry before older context. If playerDestination is set, the player is already there at the start of your continuation. Keep the player there for this turn. If playerVisibleAction is set, use that established action to frame the image. When someone went with the player, keep them present. Do not move absent characters off-screen or invent where they are.',
        'Example: entry “You bring the watchmaker to your room.” Prose “He stops by the window and listens.” Location “Your room.” The watchmaker is with you.',
        'Current state describes the present. playerStateChanges have already happened. Reuse existing state keys. For custody use item.<item-slug>.holder, one key per item. Return only changes, with an empty value to clear a key. Keep past events in the summary and durable facts in plain sentences. Copy obsolete facts into supersededFacts.',
        'For scene.focus use the present NPC the player is interacting with or accompanying, or none. Write one short visible action, retaining the main object or surface needed to depict it, and only the clothes the NPC is currently wearing. Carry wardrobe forward unless the latest entry or prose changes it. A coat hung on a hook is a prop. Use scene.details for other cues and scene.viewpoint for the player’s angle: low, high, close, side, eye-level, or empty.',
        'Return JSON only. Prose is in-world fiction, never analysis or a recap. Give up to three short second-person choices that follow the new event.',
      ].join('\n') },
      { role: 'user', content: JSON.stringify({
        premise: campaign.world.premise,
        cast: campaign.world.characters.map(({ id, name, appearance }) => ({ id, name, appearance })),
        summary: current.summary, facts: current.facts, currentState: { ...state, ...playerStateChanges }, playerStateChanges, scene,
        recent: (move ? [] : turns.slice(-5)).map(({ input, prose }) => ({ playerEntry: input, continuation: isNarratorCommentary(prose) ? '' : prose })),
        relevantMemories: recallMemories(turns, input),
        playerDestination: move ? scene.location : '',
        playerCompanion: move?.focus || '',
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

export function repeatsPriorPassage(campaign, prose) {
  const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!campaign || typeof prose !== 'string' || !prose.trim()) return false
  const passage = normalize(prose)
  return history(campaign).slice(-5).some(turn => normalize(turn.prose) === passage)
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

const coatIllustration = 'mara-coat-hook.webp'

function reviewedIllustration(world, scene, entry, prose) {
  if (world.title !== starter.title || world.opening !== starter.opening ||
      world.artStyle || world.styleReference || scene.focus !== 'mara' ||
      (scene.viewpoint && scene.viewpoint !== 'eye-level')) return ''
  const mara = world.characters.find(character => character.id === 'mara')
  if (mara?.reference !== starter.characters[0].reference ||
      !/\bapartment\b/i.test(scene.location)) return ''
  const beat = /\bMara(?: Venn)? (?:hangs? (?:up )?|hooks? )(?:her |the |a )?(?:wet |damp )?(?:raincoat|coat)\b/i
  const wardrobe = (scene.wardrobe || '').trim()
  const outfitMatches = !wardrobe || /\bburgundy (?:knit )?sweater\b/i.test(wardrobe) ||
    /^(?:wearing )?(?:a )?(?:wet |damp )?(?:navy[- ]blue |tan )?(?:trench coat|raincoat|coat)[.!]?$/i.test(wardrobe)
  return outfitMatches && (beat.test(entry) || beat.test(prose)) ? coatIllustration : ''
}

export function addTurn(campaign, id, input, result) {
  const previous = campaign.turns[campaign.active]
  const prose = checkedText(result.prose, 5000)
  if (!prose) throw new Error('The narrator returned an empty passage. Try again.')
  if (isNarratorCommentary(prose)) throw new Error('The narrator returned commentary instead of story prose. Try the turn again.')
  const rawScene = Object.fromEntries(['location', 'focus', 'action', 'details'].map(key => [key, checkedText(result.scene?.[key], 300)]))
  const move = declaredMove(input, campaign.world.characters, previous.scene.focus)
  if (move && !rawScene.location.toLowerCase().split(/[^\p{L}]+/u).includes(move.place)) {
    Object.assign(rawScene, { location: 'Your ' + move.place, action: '', details: '' })
  }
  if (move?.focus) rawScene.focus = move.focus
  const scene = resolveCharacter(campaign.world, rawScene, input, prose)
  const declared = declaredVisibleAction(input, campaign.world.characters)
  const illustrated = declared?.focus === scene.focus ? declared :
    !scene.action.trim().includes(' ') ? declaredVisibleAction(prose, campaign.world.characters) : null
  if (illustrated?.focus === scene.focus) scene.action = illustrated.action
  const custody = declaredCustody(previous.state ?? {}, input, campaign.world.characters)
  const state = { ...updateState(previous.state, result.stateChanges), ...custody }
  for (const key of Object.keys(custody)) delete state[key.replace(/\.holder$/, '.location')]
  for (const [key, holder] of Object.entries(state)) {
    const item = /^item\.([a-z0-9-]+)\.holder$/.exec(key)?.[1]
    if (!item || typeof holder !== 'string' || holder.toLowerCase() !== 'player') continue
    const lastWord = item.split('-').at(-1)
    if (/^(holds?|grips?|clutches?|pockets?|carries|catches|takes?|tightens|slides?|offers?|handles?)\b/i.test(scene.action) &&
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
  const reviewed = reviewedIllustration(campaign.world, scene, input, prose)
  if (reviewed) scene.wardrobe = 'Burgundy sweater'
  const reusable = scene.focus && sameScene(previous.scene, scene) && !previous.artDirection &&
    previous.image !== coatIllustration && (previous.imageStyle || '') === (campaign.world.artRevision || campaign.world.artStyle || '')
  const turn = {
    id, parent: previous.id, input, prose, scene, choices: checkedList(result.choices, 3),
    summary: checkedText(result.summary, 2200),
    facts: checkedList(result.facts, 20).filter(fact =>
      !/^[\w-]+(?:\.[\w-]+)+\s*[:=]/.test(fact) && !superseded.has(normalizeFact(fact))),
    state,
    imageStyle: previous.imageStyle,
    image: reviewed || (reusable ? previous.image : ''),
    imageSource: reviewed ? 'reviewed' : reusable ? previous.imageSource : undefined,
    imageReviewed: reusable ? previous.imageReviewed : undefined,
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
    if (!turn.parent) return [id, turn]
    const scene = turn.scene.focus ? turn.scene : resolveCharacter(campaign.world, turn.scene, turn.input || '', turn.prose)
    const reviewed = !turn.artDirection && !turn.imageSource
      ? reviewedIllustration(campaign.world, scene, turn.input || '', turn.prose)
      : ''
    if (scene === turn.scene && !reviewed) return [id, turn]
    if (!scene.focus) return [id, turn]
    changed = true
    return [id, {
      ...turn, scene: reviewed ? { ...scene, wardrobe: 'Burgundy sweater' } : scene,
      image: reviewed || turn.image,
      imageSource: reviewed ? 'reviewed' : turn.imageSource,
    }]
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

export function attachImage(campaign, id, image, style = '', reviewed = false) {
  if (!Object.hasOwn(campaign.turns, id)) return campaign
  return { ...campaign, turns: { ...campaign.turns, [id]: { ...campaign.turns[id], image, imageStyle: style, imageSource: 'generated', imageReviewed: reviewed } } }
}

const characterUpdate = {
  type: 'object',
  required: ['id', 'name', 'appearance', 'context'],
  properties: {
    id: { type: 'string' }, name: { type: 'string' },
    appearance: { type: 'string' }, context: { type: 'string' },
  },
}

export function dynamicRequest(campaign, entry, opening = false) {
  const turns = campaign ? history(campaign) : []
  const turn = turns.at(-1)
  const currentState = turn?.state || {}
  const cast = Object.values(turn?.cast || {}).map(({ id, name, appearance, context }) => ({ id, name, appearance, context }))
  const playerStateChanges = opening ? {} : declaredCustody(currentState, entry, cast)
  const properties = {
    ...resultSchema.properties,
    scene: { type: 'object', required: ['location', 'present'], properties: {
      location: { type: 'string' }, present: { type: 'array', items: { type: 'string' } },
    } },
    characters: { type: 'array', items: characterUpdate },
    ...(opening ? { title: { type: 'string' } } : {}),
  }
  return {
    format: { type: 'object', properties, required: Object.keys(properties) },
    messages: [
      { role: 'system', content: [
        'Write the next passage of interactive fiction. The player is the protagonist. Preserve the opening and player entries as canon. Continue with the next event, never echo or explain the entry and never decide a new action for the player.',
        opening ? 'Give the story a short title. Establish the scene directly after the supplied opening.' : 'The latest playerEntry is the newest established event and overrides conflicting older context. Actions stated as happening or completed have already happened, including every explicitly stated outcome. Only resolve uncertainty when the entry itself describes an attempt, intention, or uncertain outcome. Begin with a concrete consequence or reaction to the final event in the entry. When the entry states multiple completed events, make every stated outcome true in the new scene. Update the scene, character context, facts and choices to reflect its aftermath.',
        ...(!opening ? ['Example: “I repair the bridge and lead Ada across.” Begin on the far bank with Ada reacting. The bridge is repaired, Ada has crossed, and crossing is no longer a suggested action.'] : []),
        'List important non-player characters only. Return characters for new introductions or changes only. Give each new character a distinct short lowercase ID, name, and concise stable visual features for a solo portrait. Omit temporary expressions, poses, and scenery. Reuse existing IDs. Context is the updated current role, knowledge, goals and relationship with the player, replacing obsolete information. Update context whenever a character changes plans, leaves, learns something, or when prior context has become obsolete. Record only what the story has established. For existing characters, use empty strings for unchanged fields.',
        'scene.present is the full list of IDs of important characters physically present at the end of your passage. Include still-present characters and those introduced in the player entry. Exclude the player, departed characters, distant speakers, and people only mentioned. Empty list when the player is alone.',
        'Summarize only events established in the opening, entries, or narrated passages. Facts must be established and worth remembering. Track important objects and their current holders using item.<item-slug>.holder. Return only keyed stateChanges, using existing keys and an empty value to remove a key. PlayerStateChanges are authoritative. List obsolete facts in supersededFacts. Supply up to three short actions the player could choose.',
        'Return JSON only, with fiction in prose and no reasoning.',
      ].join('\n') },
      { role: 'user', content: JSON.stringify({
        ...(opening ? { opening: entry } : { playerEntry: entry }),
        cast, scene: turn?.scene, summary: turn?.summary, facts: turn?.facts,
        currentState: { ...currentState, ...playerStateChanges }, playerStateChanges,
        recent: turns.slice(-5).map(({ input, prose }) => ({ entry: input, continuation: prose })),
        relevantMemories: recallMemories(turns, entry),
      }) },
    ],
  }
}

export function saveDynamicTurn(campaign, id, entry, result) {
  const previous = campaign?.turns[campaign.active]
  let prose = checkedText(result.prose, 5000)
  for (const sentence of entry.match(/[^.!?]+[.!?]+/g) || []) {
    const leading = /^[^.!?]+[.!?]+/.exec(prose)?.[0]
    if (!leading || !repeatsPlayerEntry(sentence, leading.replace(/\b(\w+)[\s:,]+\1\b/gi, '$1'))) break
    prose = prose.slice(leading.length).trimStart()
  }
  if (!prose || isNarratorCommentary(prose) || repeatsPlayerEntry(entry, prose) || repeatsPriorPassage(campaign, prose)) {
    throw new Error('The narrator did not continue the story. Try again.')
  }
  if (!Array.isArray(result.characters) || !Array.isArray(result.scene?.present)) {
    throw new Error('The narrator returned an incomplete cast. Try again.')
  }
  const cast = new Map(Object.entries(previous?.cast || {}))
  const aliases = new Map()
  const characterKey = value => checkedText(value, 100).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
  for (const update of result.characters.slice(0, 30)) {
    const key = characterKey(update.id)
    if (!key || key === 'player' || key === 'none') continue
    const name = checkedText(update.name ?? '', 100)
    const old = cast.get(key) ?? [...cast.values()].find(person => name && characterKey(person.name) === characterKey(name))
    if (!old && !name) continue
    const characterId = old?.id ?? key
    aliases.set(key, characterId)
    cast.set(characterId, {
      id: characterId,
      portraitId: old?.portraitId ?? crypto.randomUUID(),
      name: name || old?.name,
      appearance: checkedText(update.appearance ?? '', 180) || old?.appearance || '',
      context: checkedText(update.context ?? '', 600) || old?.context || '',
    })
  }
  const present = [...new Set(result.scene.present.map(value => {
    const key = characterKey(value)
    return aliases.get(key) || key
  }))].filter(key => cast.has(key))
  const state = updateState(previous?.state, result.stateChanges)
  const custody = declaredCustody(previous?.state ?? {}, entry, [...cast.values()])
  Object.assign(state, custody)
  for (const key of Object.keys(custody)) delete state[key.replace(/\.holder$/, '.location')]
  const factKey = fact => fact.toLowerCase().replace(/[.!?]+$/, '')
  const superseded = new Set(checkedList(result.supersededFacts ?? [], 20).map(factKey))
  const facts = new Map()
  for (const fact of [...(previous?.facts || []), ...checkedList(result.facts, 20)]) {
    if (!superseded.has(factKey(fact)) && !/^[\w-]+(?:\.[\w-]+)+\s*[:=]/.test(fact)) facts.set(factKey(fact), fact)
  }
  const turn = {
    id, parent: previous?.id ?? null, input: entry, prose, cast: Object.fromEntries(cast),
    scene: { location: checkedText(result.scene.location, 150) || previous?.scene.location || '', present },
    summary: checkedText(result.summary, 2200) || previous?.summary || '',
    facts: [...facts.values()].slice(-20), state, choices: checkedList(result.choices, 3),
  }
  const base = campaign || {
    version: 1, mode: 'dynamic', id: crypto.randomUUID(), turns: {}, portraits: {},
    world: { title: checkedText(result.title ?? '', 100) || 'Untitled story', opening: entry, characters: [] },
  }
  return { ...base, active: id, turns: { ...base.turns, [id]: turn } }
}

export function portraitRequest(world, character) {
  return {
    scene: {
      appearance: character.appearance || character.name,
      action: 'solo character portrait, waist-up, simple background',
      wardrobe: '', location: '', viewpoint: '',
      style: world.artStyle || 'painterly illustration',
    },
    styleReference: world.styleReference || '',
  }
}
