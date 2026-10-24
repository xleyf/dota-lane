self.onmessage = async () => {
  try {
    const response = await fetch('./steam-builds.json', { cache: 'no-cache' })
    if (!response.ok) throw new Error('Steam index unavailable')
    const payload = await response.json()
    const source = Array.isArray(payload) ? payload : (payload.guides || [])
    const seen = new Set()
    const guides = []
    for (const item of source) {
      const url = String(item.url || '')
      const id = url.match(/[?&]id=(\d+)/i)?.[1]
      const key = id || url || String(item.hero || '') + '|' + String(item.title || '')
      if (seen.has(key)) continue
      seen.add(key)
      guides.push({ ...item, source: 'steam' })
    }
    self.postMessage({ ok: true, generated_at: payload.generated_at || '', guides })
  } catch {
    self.postMessage({ ok: false, error: 'Не удалось обработать индекс Steam.' })
  }
}
