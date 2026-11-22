import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowCounterClockwise, BookOpen, DownloadSimple, Feather, GitBranch, ImageSquare, Notebook, PaperPlaneTilt, UploadSimple, X } from '@phosphor-icons/react'
import { addTurn, attachImage, createCampaign, history, imageRequest, recoverCharacterIllustrations, repeatsPlayerEntry, requestFor } from './story.js'
import { readCampaign, writeCampaign } from './storage.js'
import './style.css'

const asset = path => path?.startsWith('data:') ? path : path ? import.meta.env.BASE_URL + path : ''
async function callModel(route, body) {
  const response = await fetch('/api/' + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new Error(data?.error || 'Start the local Nightdraft server and try again.')
  return data
}
function exportJSON(campaign) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(campaign, null, 2)], { type: 'application/json' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: 'nightdraft-campaign.json' })
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function WorldEditor({ onCreate }) {
  return <form className="editor" onSubmit={event => {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const characters = values.get('characters').split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => {
      const [name, ...appearance] = line.split('|')
      return { id: 'character-' + index, name: name.trim(), appearance: appearance.join('|').trim() || name.trim(), reference: '' }
    })
    onCreate(createCampaign({
      title: values.get('title').trim(), premise: values.get('premise').trim(),
      opening: values.get('opening').trim(), location: values.get('location').trim(),
      action: values.get('action').trim(), focus: characters[0]?.id || '', characters,
    }))
  }}>
    <label>Title<input name="title" required maxLength="100"/></label>
    <label>World and rules<textarea name="premise" required rows="3" maxLength="4000"/></label>
    <label>Opening scene<textarea name="opening" required rows="4" maxLength="5000"/></label>
    <label>Location<input name="location" required maxLength="150"/></label>
    <label>Characters <small>One per line, using Name | Appearance. Put the opening character first.</small><textarea name="characters" rows="3" maxLength="4000"/></label>
    <label>What the opening character is doing<input name="action" maxLength="250"/></label>
    <button className="primary">Start new campaign</button>
  </form>
}
function App() {
  const [campaign, setCampaign] = useState(createCampaign)
  const [loaded, setLoaded] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [rendering, setRendering] = useState([])
  const [error, setError] = useState('')
  const [artError, setArtError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [autoArt, setAutoArt] = useState(() => localStorage.getItem('nightdraft-auto-art') !== 'off')
  const [panel, setPanel] = useState('')
  const dialog = useRef(null)
  const current = useRef(campaign)
  const activeRenders = useRef(new Map())
  const transcriptEnd = useRef(null)
  const turn = campaign.turns[campaign.active]
  const turns = history(campaign)
  const character = campaign.world.characters.find(entry => entry.id === turn.scene.focus)
  const visual = turn.image || character?.reference || [...turns].reverse().find(entry => entry.scene.focus === character?.id && entry.image)?.image
  const nextTurns = Object.values(campaign.turns).filter(entry => entry.parent === turn.id)
  useEffect(() => {
    let alive = true
    readCampaign().then(saved => {
      if (alive && saved) {
        const recovered = recoverCharacterIllustrations(saved)
        current.current = recovered
        setCampaign(recovered)
        if (autoArt && recovered.turns[recovered.active].scene.focus !== saved.turns[saved.active].scene.focus) {
          void renderArt(recovered)
        }
      }
    }).catch(() => alive && setSaveError('Could not load the local save.')).finally(() => alive && setLoaded(true))
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (loaded) writeCampaign(campaign).catch(() => setSaveError('Could not save this campaign on this device. Export a backup.'))
  }, [campaign, loaded])
  useEffect(() => {
    if (turn.id !== 'opening') transcriptEnd.current?.scrollIntoView({ block: 'nearest' })
  }, [turn.id])
  useEffect(() => {
    if (panel && !dialog.current.open) dialog.current.showModal()
    if (!panel && dialog.current.open) dialog.current.close()
  }, [panel])

  function update(next) {
    current.current = next
    setCampaign(next)
  }
  function replace(next) {
    for (const controller of activeRenders.current.values()) controller.abort()
    activeRenders.current.clear()
    setRendering([])
    setArtError('')
    setError('')
    setInput('')
    update(next)
    setPanel('')
  }
  function selectTurn(id) {
    setError('')
    setArtError('')
    update({ ...current.current, active: id })
  }
  async function renderArt(snapshot) {
    const id = snapshot.active
    const selected = snapshot.turns[id]
    const request = imageRequest(snapshot.world, selected.scene, selected.artDirection)
    if (!request || activeRenders.current.has(id)) return
    if (!request.reference) {
      request.reference = history(snapshot).find(entry => entry.scene.focus === selected.scene.focus && entry.image)?.image || ''
    }
    const controller = new AbortController()
    activeRenders.current.set(id, controller)
    setRendering([...activeRenders.current.keys()])
    setArtError('')
    try {
      const response = await fetch('/api/image', {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.image?.startsWith('data:image/webp;base64,')) {
        throw new Error(data?.error || 'Scene art is unavailable. Start the local server and check the image setup.')
      }
      if (!controller.signal.aborted) update(attachImage(current.current, id, data.image))
    } catch (failure) {
      if (!controller.signal.aborted && current.current.active === id) setArtError(failure.message)
    } finally {
      if (activeRenders.current.get(id) === controller) {
        activeRenders.current.delete(id)
        setRendering([...activeRenders.current.keys()])
      }
    }
  }
  function reviseArt(event) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const artDirection = Object.fromEntries(['action', 'location', 'wardrobe', 'details'].map(field => [field, fields.get(field).trim()]))
    const base = current.current
    const selected = base.turns[base.active]
    const next = { ...base, turns: { ...base.turns, [selected.id]: { ...selected, artDirection } } }
    update(next)
    void renderArt(next)
  }
  async function play(action, base = current.current) {
    action = action.trim()
    if (!action || busy || !loaded) return
    setBusy(true)
    setError('')
    setArtError('')
    setInput(action)
    try {
      const request = requestFor(base, action)
      let result = await callModel('turn', request)
      if (repeatsPlayerEntry(action, result.prose)) {
        const [instructions, ...context] = request.messages
        result = await callModel('turn', { ...request, messages: [
          { ...instructions, content: instructions.content + ' The previous draft echoed the entry. Begin with a new reaction, consequence, or development that happens after it.' },
          ...context,
        ] })
        if (repeatsPlayerEntry(action, result.prose)) {
          throw new Error('The narrator repeated your entry. Try the turn again.')
        }
      }
      const next = addTurn({ ...current.current, active: base.active }, crypto.randomUUID(), action, result)
      update(next)
      setInput('')
      if (autoArt && next.turns[next.active].scene.focus && !next.turns[next.active].image) void renderArt(next)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }
  async function importCampaign(event) {
    const file = event.target.files[0]
    event.target.value = ''
    if (!file) return
    try {
      const data = JSON.parse(await file.text())
      if (data.version !== 1 || typeof data.world?.title !== 'string' ||
          !Array.isArray(data.world?.characters) || !Object.hasOwn(data.turns, data.active)) throw new Error()
      for (const id of Object.keys(data.turns)) {
        const item = data.turns[id]
        if (item.id !== id || typeof item.prose !== 'string' || !Array.isArray(item.choices) ||
            !Array.isArray(item.facts) || !item.scene || typeof item.scene.location !== 'string') throw new Error()
        history(data, id)
      }
      replace(recoverCharacterIllustrations(data))
    } catch {
      setError('Choose a valid Nightdraft campaign export.')
    }
  }

  return <>
    <header className="masthead"><div className="brand"><Feather size={24}/><span>Nightdraft</span></div>
      <nav aria-label="Campaign controls">
        <button disabled={busy || !loaded} onClick={() => setPanel('world')}><BookOpen size={18}/> <span>New world</span></button>
        <button disabled={busy || !loaded} onClick={() => setPanel('journal')}><Notebook size={18}/> <span>Journal</span></button>
      </nav>
    </header>
    <main className="room">
      <section className="story" aria-labelledby="story-title">
        <div className="heading"><p className="eyebrow">{turn.scene.location}</p><h1 id="story-title">{campaign.world.title}</h1></div>
        <div className="transcript" aria-label="Story transcript">
          {turns.map(entry => <article key={entry.id} className="passage">
            {entry.input && <p className="player-action">{entry.input}</p>}
            {entry.prose.split(/\n+/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
          </article>)}
          <div ref={transcriptEnd}/>
        </div>
        <div className="play-controls">
          {turn.choices.length > 0 && <div className="suggestions" aria-label="Suggested actions">{turn.choices.map((choice, index) =>
            <button key={index} disabled={busy || !loaded} onClick={() => play(choice)}>{choice}</button>)}</div>}
          <form className="composer" onSubmit={event => { event.preventDefault(); void play(input) }}>
            <label htmlFor="action">Your move</label>
            <div className="input-row"><textarea id="action" rows="2" maxLength="3000" placeholder="What do you do or say?" value={input} disabled={busy || !loaded}
              onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit() } }}
              onChange={event => setInput(event.target.value)}/>
              <button className="primary" disabled={busy || !loaded || !input.trim()}><PaperPlaneTilt size={18}/> Continue</button></div>
          </form>
          <div className="turn-controls">
            <button disabled={busy || !turn.parent} onClick={() => selectTurn(turn.parent)}><GitBranch size={17}/> Rewind</button>
            <button disabled={busy || !turn.parent} onClick={() => play(turn.input, { ...current.current, active: turn.parent })}><ArrowCounterClockwise size={17}/> Retry turn</button>
            {nextTurns.length > 0 && <select aria-label="Existing branches" value="" disabled={busy} onChange={event => selectTurn(event.target.value)}>
              <option value="" disabled>Existing branches</option>
              {nextTurns.map((entry, index) => <option key={entry.id} value={entry.id}>{index + 1}. {entry.input.slice(0, 65)}</option>)}
            </select>}
            <span className="turn-count">Turn {turns.length}</span>
          </div>
          {busy && <p role="status">Writing the next turn…</p>}
          {(error || saveError) && <p role="alert" className="error">{error || saveError}</p>}
        </div>
      </section>
      <aside className="scene" aria-labelledby="scene-title">
        <div className="scene-label"><ImageSquare size={19}/><h2 id="scene-title">Character illustration</h2></div>
        <figure>
          {visual ? <img src={asset(visual)} alt={turn.image ? `${character?.name || 'Character'} · ${turn.scene.action}` : `Reference for ${character?.name || 'character'}`}/>
            : <div className="image-empty"><ImageSquare size={38}/><p>{character ? 'No illustration of this character yet.' : 'No character with you.'}</p></div>}
          <figcaption>
            {character ? <><strong>{character.name}</strong><span>{turn.scene.action}</span></> : <span>{turn.scene.location}</span>}
          </figcaption>
        </figure>
        {character && <div className="art-controls">
          <button onClick={() => renderArt(current.current)} disabled={rendering.includes(turn.id) || !loaded}><ArrowCounterClockwise size={17}/> {turn.image ? 'Regenerate art' : 'Generate art'}</button>
          <label><input type="checkbox" checked={autoArt} onChange={event => { setAutoArt(event.target.checked); localStorage.setItem('nightdraft-auto-art', event.target.checked ? 'on' : 'off') }}/> Auto-illustrate</label>
        </div>}
        {character && loaded && <details key={turn.id} className="art-direction">
          <summary>Adjust illustration</summary>
          <form className="editor" onSubmit={reviseArt}>
            <label>Visible action<input name="action" defaultValue={turn.artDirection?.action || turn.scene.action} required maxLength="250"/></label>
            <label>Setting<input name="location" defaultValue={turn.artDirection?.location || turn.scene.location} required maxLength="150"/></label>
            <label>Current wardrobe<input name="wardrobe" defaultValue={turn.artDirection?.wardrobe ?? turn.scene.wardrobe ?? ''} maxLength="150"/></label>
            <label>Visual details<textarea name="details" defaultValue={turn.artDirection?.details ?? turn.scene.details} maxLength="250" rows="3"/></label>
            <button disabled={rendering.includes(turn.id) || !loaded}>Render with changes</button>
          </form>
        </details>}
        {rendering.includes(turn.id) && <p role="status">Drawing the character locally…</p>}
        {character && visual && !turn.image && <p className="muted">Showing previously saved character art.</p>}
        {artError && <p role="alert" className="error">{artError}</p>}
      </aside>
    </main>
    <dialog ref={dialog} onClose={() => setPanel('')} aria-labelledby="dialog-title">
      <div className="dialog-heading"><h2 id="dialog-title">{panel === 'world' ? 'Create a world' : 'Campaign journal'}</h2>
        <button aria-label="Close dialog" onClick={() => setPanel('')}><X size={20}/></button></div>
      {panel === 'world' ? <><p>Starting a world replaces the current campaign. Export a copy to keep it.</p><button onClick={() => exportJSON(campaign)}><DownloadSimple size={18}/> Export current campaign</button><WorldEditor onCreate={replace}/></> : panel === 'journal' &&
        <>
          <div className="journal-actions"><button onClick={() => exportJSON(campaign)}><DownloadSimple size={18}/> Export</button>
            <label className="upload"><UploadSimple size={18}/> Import campaign<input type="file" accept=".json,application/json" onChange={importCampaign}/></label></div>
          {error && <p role="alert" className="error">{error}</p>}
          <label>Story so far<textarea key={turn.id + '-summary'} rows="4" defaultValue={turn.summary} onBlur={event => update({ ...current.current,
            turns: { ...current.current.turns, [turn.id]: { ...current.current.turns[turn.id], summary: event.target.value.slice(0, 2200) } } })}/></label>
          <label>Remembered facts <small>One per line</small><textarea key={turn.id + '-facts'} rows="5" defaultValue={turn.facts.join('\n')} onBlur={event => update({ ...current.current,
            turns: { ...current.current.turns, [turn.id]: { ...current.current.turns[turn.id], facts: event.target.value.split('\n').map(fact => fact.trim().slice(0, 300)).filter(Boolean).slice(0, 20) } } })}/></label>
          <h3>Character references</h3>
          {campaign.world.characters.length === 0 && <p>No characters in this world yet.</p>}
          {campaign.world.characters.map(entry => <label key={entry.id}>{entry.name}
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => {
              const file = event.target.files[0]
              event.target.value = ''
              if (!file) return
              if (file.size > 4_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
                setError('Choose a PNG, JPEG, or WebP under 4 MB.')
                return
              }
              const world = current.current.world
              const reader = new FileReader()
              reader.onload = () => {
                if (current.current.world !== world) return
                setError('')
                update({ ...current.current, world: { ...world, characters: world.characters.map(person => person.id === entry.id ? { ...person, reference: reader.result } : person) } })
              }
              reader.readAsDataURL(file)
            }}/>{entry.reference && <small>Reference saved</small>}</label>)}
        </>}
    </dialog>
  </>
}
createRoot(document.getElementById('root')).render(<App/>)
