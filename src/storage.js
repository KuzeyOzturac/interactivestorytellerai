const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('nightdraft', 1)
  request.onupgradeneeded = () => request.result.createObjectStore('campaigns')
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

export async function readCampaign() {
  const db = await database
  return new Promise((resolve, reject) => {
    const request = db.transaction('campaigns').objectStore('campaigns').get('current')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function writeCampaign(campaign) {
  const db = await database
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('campaigns', 'readwrite')
    transaction.objectStore('campaigns').put(campaign, 'current')
    transaction.oncomplete = resolve
    transaction.onabort = () => reject(transaction.error)
  })
}
