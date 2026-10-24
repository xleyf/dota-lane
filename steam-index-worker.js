self.onmessage = async () => {
  try {
    const response = await fetch('./steam-builds.json', { cache: 'no-cache' })
    if (!response.ok) throw new Error('Steam index unavailable')
    const payload = await response.json()
    const source = Array.isArray(payload) ? payload : (payload.guides || [])
    const seen = new Set()
    const batchSize = 80
    for (let start = 0; start < source.length; start += batchSize) {
      const guides = []
      for (const item of source.slice(start, start + batchSize)) {
        const url = String(item.url || '')
        const id = url.match(/[?&]id=(\d+)/i)?.[1]
        const key = id || url || String(item.hero || '') + '|' + String(item.title || '')
        if (seen.has(key)) continue
        seen.add(key)
        guides.push({ ...item, source: 'steam' })
      }
      if (guides.length) self.postMessage({ type: 'batch', guides })
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    self.postMessage({ type: 'done', generated_at: payload.generated_at || '' })
  } catch {
    self.postMessage({ type: 'error', error: 'Не удалось обработать индекс Steam.' })
  }
}
