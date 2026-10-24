let guides = null
let generatedAt = ''

async function prepare() {
  if (guides) return
  const response = await fetch('./steam-builds.json', { cache: 'no-cache' })
  if (!response.ok) throw new Error('Steam index unavailable')
  const payload = await response.json()
  const source = Array.isArray(payload) ? payload : (payload.guides || [])
  const seen = new Set()
  guides = []
  generatedAt = payload.generated_at || ''
  for (const item of source) {
    const url = String(item.url || '')
    const id = url.match(/[?&]id=(\d+)/i)?.[1]
    const key = id || url || String(item.hero || '') + '|' + String(item.title || '')
    if (seen.has(key)) continue
    seen.add(key)
    guides.push({ ...item, source: 'steam' })
  }
}

self.onmessage = async (event) => {
  const type = event.data?.type
  try {
    await prepare()
    if (type === 'init') {
      self.postMessage({ type: 'ready', total: guides.length, generated_at: generatedAt })
      return
    }
    if (type === 'next') {
      const start = Math.max(0, Number(event.data.offset) || 0)
      const size = Math.min(20, Math.max(1, Number(event.data.limit) || 20))
      const batch = guides.slice(start, start + size)
      self.postMessage({ type: 'batch', guides: batch, offset: start + batch.length, done: start + batch.length >= guides.length })
      return
    }
    if (type === 'load') {
      const batchSize = 20
      for (let start = 0; start < guides.length; start += batchSize) {
        self.postMessage({ type: 'batch', guides: guides.slice(start, start + batchSize) })
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      self.postMessage({ type: 'done', generated_at: generatedAt })
    }
  } catch {
    self.postMessage({ type: 'error', error: 'Не удалось обработать индекс Steam.' })
  }
}
