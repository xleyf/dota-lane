let manifest = null
let loadedPageIndex = -1
let pageGuides = []

async function prepare() {
  if (manifest) return
  const response = await fetch('./steam-builds-manifest.json', { cache: 'no-cache' })
  if (!response.ok) throw new Error('Steam manifest unavailable')
  manifest = await response.json()
}

async function loadPage(pageIndex) {
  if (pageIndex === loadedPageIndex) return pageGuides
  const name = String(pageIndex).padStart(3, '0')
  const response = await fetch('./steam-builds-pages/page-' + name + '.json', { cache: 'no-cache' })
  if (!response.ok) throw new Error('Steam guide page unavailable')
  const payload = await response.json()
  loadedPageIndex = pageIndex
  pageGuides = Array.isArray(payload.guides) ? payload.guides : []
  return pageGuides
}

async function sendNext(start, size) {
  const total = Number(manifest.guide_count) || 0
  if (start >= total) {
    self.postMessage({ type: 'batch', guides: [], offset: start, done: true })
    return
  }
  const pageSize = Math.max(1, Number(manifest.page_size) || 100)
  const pageIndex = Math.floor(start / pageSize)
  const pageOffset = start % pageSize
  const source = await loadPage(pageIndex)
  const batch = source.slice(pageOffset, pageOffset + size)
  if (!batch.length) throw new Error('Steam guide page is empty')
  const offset = start + batch.length
  self.postMessage({ type: 'batch', guides: batch, offset, done: offset >= total })
}

self.onmessage = async (event) => {
  const type = event.data?.type
  try {
    await prepare()
    if (type === 'init') {
      self.postMessage({
        type: 'ready',
        total: Number(manifest.guide_count) || 0,
        generated_at: manifest.generated_at || '',
      })
      return
    }
    if (type === 'next') {
      const start = Math.max(0, Number(event.data.offset) || 0)
      const size = Math.min(20, Math.max(1, Number(event.data.limit) || 20))
      await sendNext(start, size)
      return
    }
    if (type === 'load') {
      const total = Number(manifest.guide_count) || 0
      for (let start = 0; start < total; start += 20) {
        await sendNext(start, 20)
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      self.postMessage({ type: 'done', generated_at: manifest.generated_at || '' })
    }
  } catch (error) {
    self.postMessage({ type: 'error', error: error?.message || 'Не удалось загрузить страницу Steam.' })
  }
}