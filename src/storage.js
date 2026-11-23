const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('nightdraft', 2)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('campaigns')) request.result.createObjectStore('campaigns')
    request.result.createObjectStore('library', { keyPath: 'id' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

async function get(store, key) {
  const db = await database
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function readCampaign(id) {
  if (id) return get('campaigns', id)
  const active = await get('campaigns', 'active-id')
  return get('campaigns', active || 'current')
}

export async function listCampaigns() {
  const db = await database
  return new Promise((resolve, reject) => {
    const request = db.transaction('library').objectStore('library').getAll()
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.updated - a.updated))
    request.onerror = () => reject(request.error)
  })
}

export async function writeCampaign(campaign, previous) {
  const db = await database
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['campaigns', 'library'], 'readwrite')
    const saves = transaction.objectStore('campaigns')
    const library = transaction.objectStore('library')
    for (const entry of previous ? [previous, campaign] : [campaign]) {
      saves.put(entry, entry.id)
      library.put({ id: entry.id, title: entry.world.title, updated: Date.now() })
    }
    saves.put(campaign.id, 'active-id')
    transaction.oncomplete = resolve
    transaction.onabort = () => reject(transaction.error)
  })
}
