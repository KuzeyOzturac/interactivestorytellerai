import { createCampaign, requestFor, repeatsPlayerEntry, isNarratorCommentary } from '../src/story.js'

const seed = Number(process.env.NIGHTDRAFT_BENCH_SEED || 31)
const entries = [
  'You take Mara to your apartment.',
  'You take the brass key from Mara.',
  'You sit on the floor and look up at Mara.',
]

let failures = 0
for (const sampling of ['baseline', 'qwen', 'steady']) {
  for (const entry of entries) {
    const response = await fetch('http://127.0.0.1:8787/api/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...requestFor(createCampaign(), entry), sampling, seed }),
      signal: AbortSignal.timeout(305_000),
    })
    const turn = await response.json()
    const pass = response.ok && typeof turn.prose === 'string' && Boolean(turn.prose.trim()) &&
      !isNarratorCommentary(turn.prose) && !repeatsPlayerEntry(entry, turn.prose)
    if (!pass) failures++
    console.log(JSON.stringify({ sampling, entry, pass, ...turn }))
  }
}
process.exitCode = failures ? 1 : 0
