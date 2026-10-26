(() => {
  const endpoint = `${SUPABASE_URL}/functions/v1/steam-auth`
  const tokenKey = 'lane-steam-session-v1'
  let token = ''
  try {
    token = localStorage.getItem(tokenKey) || sessionStorage.getItem(tokenKey) || ''
    if (token) localStorage.setItem(tokenKey, token)
  } catch (error) {
    try { token = sessionStorage.getItem(tokenKey) || '' } catch (ignored) { /* storage may be disabled */ }
  }
  let profile = null
  let mine = { guides: [], threads: [], replies: [] }
  let observer

  const style = document.createElement('style')
  style.textContent = `
    #laneAccount{display:flex;align-items:center;gap:8px;margin-left:8px}
    .lane-account-btn,.lane-owner-btn{border:1px solid #414b4d;background:#20272b;color:#e3a57c;border-radius:5px;padding:7px 9px;font:10px system-ui;cursor:pointer}
    .lane-account-btn:hover,.lane-owner-btn:hover{border-color:#c18065}
    .lane-account-name{max-width:120px;overflow:hidden;text-overflow:ellipsis;color:#aeb6b4;font-size:10px}
    .lane-owner-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
    .lane-performance{color:#d7b578!important;font-size:10px!important;margin:5px 0!important}
    .lane-account-dialog,.lane-queue-dialog{width:min(740px,calc(100% - 24px));max-height:85vh;overflow:auto;border:1px solid #4a5150;border-radius:10px;background:#191e22;color:var(--ink);padding:20px;box-shadow:0 22px 80px #0009}
    .lane-account-dialog::backdrop,.lane-queue-dialog::backdrop{background:#050708bb;backdrop-filter:blur(3px)}
    .lane-dialog-head{display:flex;justify-content:space-between;align-items:start;gap:12px;margin-bottom:14px}
    .lane-dialog-head h2{font-size:18px;margin:0}
    .lane-dialog-close{border:1px solid #3b4547;background:transparent;color:#c7ceca;border-radius:5px;padding:6px 9px;cursor:pointer}
    .lane-edit-form{display:grid;gap:10px}.lane-edit-form label{display:grid;gap:4px;color:#aab2af;font-size:11px}
    .lane-edit-form input,.lane-edit-form select,.lane-edit-form textarea{width:100%;border:1px solid #3b4446;border-radius:5px;background:#14191c;color:var(--ink);padding:9px;font:12px system-ui}
    .lane-edit-form textarea{min-height:100px;resize:vertical}.lane-queue-group{border-top:1px solid #343d40;padding-top:12px;margin-top:14px}
    .lane-queue-item{display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid #30383d;border-radius:6px;padding:10px;margin:7px 0}
    .lane-queue-item p{margin:3px 0 0;color:#9aa3a1;font-size:10px}.lane-queue-actions{display:flex;gap:6px;flex:none}
    @media(max-width:600px){#laneAccount{margin-left:0}.lane-account-name{display:none}.lane-queue-item{align-items:flex-start;flex-direction:column}}
  `
  document.head.append(style)

  function notifyUser(message) {
    if (typeof notify === 'function') notify(message)
    else window.alert(message)
  }
  async function api(action, body = {}) {
    const response = await fetch(`${endpoint}?action=${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token || SUPABASE_PUBLISHABLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `Ошибка ${response.status}`)
    return result
  }
  function signIn() { location.href = `${endpoint}?action=login&apikey=${encodeURIComponent(SUPABASE_PUBLISHABLE_KEY)}` }
  function accountRoot() {
    let root = document.querySelector('#laneAccount')
    if (!root) {
      root = document.createElement('div')
      root.id = 'laneAccount'
      document.querySelector('.topright')?.prepend(root)
    }
    return root
  }
  function drawAccount() {
    const root = accountRoot()
    if (!profile) {
      root.innerHTML = '<button class="lane-account-btn" type="button" data-lane-login>Войти через Steam</button>'
      root.querySelector('[data-lane-login]').onclick = signIn
      return
    }
    root.innerHTML = `<span class="lane-account-name">Steam · ${profile.steam_id}</span><button class="lane-account-btn" type="button" data-lane-profile>Мои публикации</button>${profile.is_moderator ? '<button class="lane-account-btn" type="button" data-lane-moderation>Модерация</button>' : ''}<button class="lane-account-btn" type="button" data-lane-logout>Выйти</button>`
    root.querySelector('[data-lane-profile]').onclick = showMine
    root.querySelector('[data-lane-logout]').onclick = signOut
    root.querySelector('[data-lane-moderation]')?.addEventListener('click', showQueue)
  }
  async function refreshMine() {
    if (!token) { mine = { guides: [], threads: [], replies: [] }; return }
    try { mine = await api('my_content') } catch { mine = { guides: [], threads: [], replies: [] } }
    decorateOwnedContent()
  }
  async function acceptSession() {
    const hash = new URLSearchParams(location.hash.slice(1))
    const ticket = hash.get('steam_ticket')
    const authError = hash.get('steam_error')
    if (authError) {
      history.replaceState(null, '', location.pathname + location.search)
      notifyUser(authError)
    }
    if (ticket) {
      history.replaceState(null, '', location.pathname + location.search)
      try {
        const result = await api('exchange', { ticket })
        token = result.token
        try { localStorage.setItem(tokenKey, token) } catch (error) { /* persistent storage may be disabled */ }
        try { sessionStorage.setItem(tokenKey, token) } catch (error) { /* session storage may be disabled */ }
        profile = result.profile
        notifyUser(`Вход выполнен: Steam ID ${profile.steam_id}`)
      } catch (error) {
        token = ''
        try { localStorage.removeItem(tokenKey) } catch (error) { /* storage may be disabled */ }
        try { sessionStorage.removeItem(tokenKey) } catch (error) { /* storage may be disabled */ }
        notifyUser(error.message || 'Не удалось завершить вход Steam.')
      }
    }
    if (token) {
      try { profile = (await api('me')).profile }
      catch { token = ''; profile = null; try { localStorage.removeItem(tokenKey) } catch (error) { /* storage may be disabled */ }; try { sessionStorage.removeItem(tokenKey) } catch (error) { /* storage may be disabled */ } }
    }
    drawAccount()
    await refreshMine()
    decoratePerformance()
  }
  async function signOut() {
    try { await api('logout') } catch { /* expired sessions are removed locally */ }
    token = ''; profile = null; mine = { guides: [], threads: [], replies: [] }
    try { localStorage.removeItem(tokenKey) } catch (error) { /* storage may be disabled */ }
    try { sessionStorage.removeItem(tokenKey) } catch (error) { /* storage may be disabled */ }
    drawAccount(); decorateOwnedContent(); notifyUser('Вы вышли из аккаунта Steam.')
  }
  function requireSteam() {
    if (profile) return true
    notifyUser('Войди через Steam, чтобы продолжить.')
    return false
  }
  function attachOwnerActions(container, type, id) {
    const rows = mine[{ guide: 'guides', thread: 'threads', reply: 'replies' }[type]] || []
    const item = rows.find((row) => String(row.id) === String(id))
    if (!item || container.querySelector(`[data-owner-edit="${type}-${id}"]`)) return
    const actions = document.createElement('div')
    actions.className = 'lane-owner-actions'
    actions.innerHTML = `<button class="lane-owner-btn" type="button" data-owner-edit="${type}-${id}">Изменить</button><button class="lane-owner-btn" type="button" data-owner-delete="${type}-${id}">Удалить</button>`
    container.append(actions)
    actions.querySelector('[data-owner-edit]').onclick = () => editOwned(type, item)
    actions.querySelector('[data-owner-delete]').onclick = () => deleteOwned(type, id)
  }
  function decorateOwnedContent() {
    document.querySelectorAll('#feed .build').forEach((card) => {
      const report = card.querySelector('[data-report-type="community_guide"]')
      if (report && mine.guides.some((row) => String(row.id) === report.dataset.reportId))
        attachOwnerActions(card.querySelector('.build-actions') || card, 'guide', report.dataset.reportId)
    })
    document.querySelectorAll('#threadList .thread').forEach((card) => {
      const open = card.querySelector('[data-open-thread]')
      if (open && mine.threads.some((row) => String(row.id) === open.dataset.openThread))
        attachOwnerActions(card.querySelector('.build-actions') || card, 'thread', open.dataset.openThread)
    })
    document.querySelectorAll('#threadDetail .thread-reply').forEach((reply) => {
      const report = reply.querySelector('[data-report-type="forum_reply"]')
      if (report && mine.replies.some((row) => String(row.id) === report.dataset.reportId))
        attachOwnerActions(reply, 'reply', report.dataset.reportId)
    })
  }
  function performanceFor(guideId) {
    const build = (steamBuilds || []).find((item) => {
      try { return new URL(item.url).searchParams.get('id') === String(guideId) } catch { return false }
    })
    return build && (build.match_count || build.win_rate) ? build : null
  }
  function decoratePerformance() {
    document.querySelectorAll('#feed .build').forEach((card) => {
      const report = card.querySelector('[data-report-type="steam_build"]')
      let guideId = report?.dataset.reportId || ''
      if (!guideId) {
        try { guideId = new URL(card.querySelector('.build-link')?.href || '').searchParams.get('id') || '' } catch { /* not a Steam guide URL */ }
      }
      const source = guideId ? performanceFor(guideId) : null
      const metrics = card.querySelector('.guide-metrics')
      if (metrics) {
        const stats = guideId && typeof guideStats !== 'undefined' ? guideStats[guideId] : null
        const matchText = source?.match_count ? `${Number(source.match_count).toLocaleString('ru-RU')} матчей · ${source.win_rate ? `${source.win_rate}% винрейт` : 'винрейт не указан'} · ${source.stats_source}` : 'Нет статистики матчей в тексте гайда'
        const ratingText = stats?.votes ? `${stats.rating}/5 · ${stats.votes} оценок Steam-аккаунтов` : 'Пока нет оценок Steam-аккаунтов'
        if (metrics.children[0] && metrics.children[0].textContent !== `🎮 ${matchText}`) metrics.children[0].textContent = `🎮 ${matchText}`
        if (metrics.children[1] && metrics.children[1].textContent !== `★ ${ratingText}`) metrics.children[1].textContent = `★ ${ratingText}`
      }
      if (source && !card.querySelector('.lane-performance')) {
        const line = document.createElement('p')
        line.className = 'lane-performance'
        line.textContent = `Данные руководства: ${Number(source.match_count || 0).toLocaleString('ru-RU')} матчей${source.win_rate ? ` · ${source.win_rate}% побед` : ''} · ${source.stats_source}. Steam не подтверждает эти цифры.`
        card.querySelector('.desc')?.after(line)
      }
      const form = card.querySelector('.guide-feedback-form')
      if (form) {
        const games = form.querySelector('label')
        if (games) games.hidden = true
        const note = form.querySelector('.guide-feedback-note')
        if (note) note.textContent = 'Оценка доступна вошедшим через Steam. Число матчей берётся из текста гайда, если автор его указал.'
        const button = card.querySelector('[data-guide-feedback]')
        if (button) { button.disabled = false; button.textContent = profile ? 'Оценить руководство' : 'Войти и оценить' }
      }
    })
    const mode = document.querySelector('#feedSort')?.value
    if (mode && mode !== 'default') {
      const feed = document.querySelector('#feed')
      if (feed) {
        const cards = [...feed.children]
        cards.sort((a, b) => {
          const idA = a.querySelector('[data-report-type="steam_build"]')?.dataset.reportId || ''
          const idB = b.querySelector('[data-report-type="steam_build"]')?.dataset.reportId || ''
          const statA = performanceFor(idA), statB = performanceFor(idB)
          const valueA = mode === 'games' ? Number(statA?.match_count || 0) : Number(guideStats[idA]?.rating || 0)
          const valueB = mode === 'games' ? Number(statB?.match_count || 0) : Number(guideStats[idB]?.rating || 0)
          return valueB - valueA || a.textContent.localeCompare(b.textContent, 'ru')
        })
        if (cards.some((card, index) => card !== feed.children[index])) cards.forEach((card) => feed.append(card))
      }
    }
    decorateOwnedContent()
  }
  function editorDialog(title, type, item, action) {
    let dialog = document.querySelector('#laneOwnerEditor')
    if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'laneOwnerEditor'; dialog.className = 'lane-account-dialog'; document.body.append(dialog) }
    const common = type === 'guide'
      ? [['title','Название','input',item.title],['hero','Герой','select',item.hero],['position','Позиция','select',String(item.position || '')],['description','Короткое описание','textarea',item.description || ''],['steam_url','Ссылка Steam','input',item.steam_url]]
      : type === 'thread'
        ? [['title','Заголовок','input',item.title],['hero','Герой','select',item.hero || ''],['category','Раздел','select',item.category],['body','Текст','textarea',item.body]]
        : [['body','Текст ответа','textarea',item.body]]
    const fields = common.map(([name, label, kind, value]) => {
      let control
      if (kind === 'select') {
        let options = []
        if (name === 'hero') options = [['','Без героя'], ...heroes.map((hero) => [hero.name, hero.name])]
        else if (name === 'position') options = [['','Любая'], ...[1,2,3,4,5].map((n) => [String(n), `Позиция ${n}`])]
        else options = ['Вопрос','Матчап','Предметы','Тактика'].map((v) => [v,v])
        control = `<select name="${name}">${options.map(([v,l]) => `<option value="${escapeHtml(v)}" ${String(value)===String(v)?'selected':''}>${escapeHtml(l)}</option>`).join('')}</select>`
      } else if (kind === 'textarea') control = `<textarea name="${name}" required>${escapeHtml(value)}</textarea>`
      else control = `<input name="${name}" value="${escapeHtml(value)}" required>`
      return `<label>${label}${control}</label>`
    }).join('')
    dialog.innerHTML = `<div class="lane-dialog-head"><h2>${title}</h2><button class="lane-dialog-close" type="button">Закрыть</button></div><form class="lane-edit-form">${fields}<div class="form-actions"><button class="btn btn-red" type="submit">Сохранить на повторную проверку</button></div></form>`
    dialog.querySelector('.lane-dialog-close').onclick = () => dialog.close()
    dialog.querySelector('form').onsubmit = async (event) => {
      event.preventDefault()
      const values = Object.fromEntries(new FormData(event.currentTarget))
      if (type === 'guide' || type === 'thread') values.id = item.id
      else values.id = item.id
      if (action === 'update_guide') values.position = values.position || null
      const submit = event.currentTarget.querySelector('[type="submit"]'); submit.disabled = true
      try { await api(action, values); dialog.close(); notifyUser('Изменения отправлены на повторную проверку.'); setTimeout(() => location.reload(), 400) }
      catch (error) { submit.disabled = false; notifyUser(error.message) }
    }
    dialog.showModal()
  }
  function editOwned(type, item) {
    const actions = { guide: 'update_guide', thread: 'update_thread', reply: 'update_reply' }
    editorDialog('Редактировать публикацию', type, item, actions[type])
  }
  async function deleteOwned(type, id) {
    if (!window.confirm('Удалить эту публикацию? Это действие нельзя отменить.')) return
    try { await api(`delete_${type}`, { id }); notifyUser('Публикация удалена.'); setTimeout(() => location.reload(), 300) }
    catch (error) { notifyUser(error.message) }
  }
  async function showMine() {
    if (!requireSteam()) return
    await refreshMine()
    let dialog = document.querySelector('#laneMyPosts')
    if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'laneMyPosts'; dialog.className = 'lane-account-dialog'; document.body.append(dialog) }
    const groups = [
      ['Гайды','guide',mine.guides],['Темы','thread',mine.threads],['Ответы','reply',mine.replies],
    ].map(([label,type,rows]) => `<section class="lane-queue-group"><h3>${label} · ${rows.length}</h3>${rows.map((item) => {
      const title = item.title || item.body.slice(0,100)
      const status = item.moderation_status || 'approved'
      return `<article class="lane-queue-item"><div><b>${escapeHtml(title)}</b><p>${status === 'pending' ? 'На проверке' : status === 'rejected' ? 'Отклонено' : 'Опубликовано'}</p></div><div class="lane-queue-actions"><button class="lane-owner-btn" data-mine-edit="${type}:${item.id}">Изменить</button><button class="lane-owner-btn" data-mine-delete="${type}:${item.id}">Удалить</button></div></article>`
    }).join('') || '<p>Пока нет публикаций.</p>'}</section>`)
    dialog.innerHTML = `<div class="lane-dialog-head"><h2>Мои публикации</h2><button class="lane-dialog-close" type="button">Закрыть</button></div>${groups.join('')}`
    dialog.querySelector('.lane-dialog-close').onclick = () => dialog.close()
    dialog.querySelectorAll('[data-mine-edit]').forEach((button) => button.onclick = () => {
      const [type,id] = button.dataset.mineEdit.split(':')
      const item = mine[{guide:'guides',thread:'threads',reply:'replies'}[type]].find((row) => String(row.id) === id)
      if (item) editOwned(type,item)
    })
    dialog.querySelectorAll('[data-mine-delete]').forEach((button) => button.onclick = async () => {
      const [type,id] = button.dataset.mineDelete.split(':')
      await deleteOwned(type,id)
      await refreshMine()
      if (dialog.open) dialog.close()
    })
    dialog.showModal()
  }
  function addDialog() {
    const dialog = document.createElement('dialog')
    dialog.id = 'laneModerationQueue'; dialog.className = 'lane-queue-dialog'
    document.body.append(dialog)
    return dialog
  }
  async function showQueue() {
    const dialog = document.querySelector('#laneModerationQueue') || addDialog()
    dialog.innerHTML = '<div class="lane-dialog-head"><h2>Очередь модерации</h2><button class="lane-dialog-close" type="button">Закрыть</button></div><p>Загружаю очередь…</p>'
    dialog.querySelector('.lane-dialog-close').onclick = () => dialog.close()
    dialog.showModal()
    try {
      const queue = await api('moderation_queue')
      const sections = [
        ['Гайды', 'guide', queue.guides], ['Темы', 'thread', queue.threads], ['Ответы', 'reply', queue.replies],
      ].map(([label, type, items]) => `<section class="lane-queue-group"><h3>${label} · ${items.length}</h3>${items.map((item) => `<article class="lane-queue-item"><div><b>${escapeHtml(item.title || item.body.slice(0,100))}</b><p>${escapeHtml(item.hero || item.category || '')} · ${escapeHtml(item.body || item.description || '')}</p></div><div class="lane-queue-actions"><button class="lane-owner-btn" data-approve="${type}:${item.id}">Одобрить</button><button class="lane-owner-btn" data-reject="${type}:${item.id}">Отклонить</button></div></article>`).join('') || '<p>Очередь пуста.</p>'}</section>`)
      const reports = `<section class="lane-queue-group"><h3>Жалобы · ${queue.reports.length}</h3>${queue.reports.map((r) => `<article class="lane-queue-item"><div><b>${escapeHtml(r.target_type)} · ${escapeHtml(r.target_id)}</b><p>${escapeHtml(r.reason)} · ${escapeHtml(r.details || '')}</p></div><div class="lane-queue-actions"><button class="lane-owner-btn" data-resolve="reviewed:${r.id}">Рассмотрена</button><button class="lane-owner-btn" data-resolve="dismissed:${r.id}">Отклонить</button></div></article>`).join('') || '<p>Новых жалоб нет.</p>'}</section>`
      dialog.innerHTML = `<div class="lane-dialog-head"><h2>Очередь модерации</h2><button class="lane-dialog-close" type="button">Закрыть</button></div>${sections.join('')}${reports}`
      dialog.querySelector('.lane-dialog-close').onclick = () => dialog.close()
      dialog.querySelectorAll('[data-approve],[data-reject]').forEach((button) => button.onclick = async () => {
        const [type,id] = (button.dataset.approve || button.dataset.reject).split(':')
        const status = button.hasAttribute('data-approve') ? 'approved' : 'rejected'
        try { await api('moderate_content',{type,id,status}); await showQueue() } catch (error) { notifyUser(error.message) }
      })
      dialog.querySelectorAll('[data-resolve]').forEach((button) => button.onclick = async () => {
        const [status,id] = button.dataset.resolve.split(':')
        try { await api('resolve_report',{id,status}); await showQueue() } catch (error) { notifyUser(error.message) }
      })
    } catch (error) { dialog.insertAdjacentHTML('beforeend', `<p class="empty">${escapeHtml(error.message)}</p>`) }
  }
  async function submitForm(action, values, form) {
    if (!requireSteam()) return
    const button = form.querySelector('[type="submit"]'); if (button) button.disabled = true
    try { await api(action, values); form.reset(); notifyUser('Отправлено на проверку модератору.') }
    catch (error) { notifyUser(error.message); if (button) button.disabled = false }
  }
  function installSubmitHandlers() {
    document.addEventListener('click', (event) => {
      const action = event.target.closest?.('.report-content,[data-guide-feedback]')
      if (action && !profile) { event.preventDefault(); event.stopImmediatePropagation(); requireSteam() }
    }, true)
    document.addEventListener('submit', async (event) => {
      const form = event.target
      let action, values
      if (form.id === 'form') {
        action = 'create_guide'
        values = { steam_url: document.querySelector('#url').value.trim(), title: document.querySelector('#title').value.trim(), hero: document.querySelector('#hero').value, position: document.querySelector('#role').value || null, description: document.querySelector('#desc').value.trim() }
      } else if (form.id === 'threadForm') {
        action = 'create_thread'
        values = { title: document.querySelector('#threadTitle').value.trim(), hero: document.querySelector('#threadHero').value || null, category: document.querySelector('#threadCategory').value, body: document.querySelector('#threadBody').value.trim() }
      } else if (form.matches('.reply-form')) {
        action = 'create_reply'
        values = { thread_id: Number(typeof openThreadId !== 'undefined' ? openThreadId : 0), body: form.querySelector('textarea').value.trim() }
      } else if (form.id === 'reportForm') {
        const data = new FormData(form); action = 'report'
        values = { target_type: data.get('target_type'), target_id: data.get('target_id'), reason: data.get('reason'), details: data.get('details') || '' }
      } else if (form.matches('.guide-feedback-form')) {
        const data = new FormData(form); action = 'rate_guide'
        values = { guide_id: form.dataset.guideFeedbackForm, rating: Number(data.get('rating')) }
      } else return
      event.preventDefault(); event.stopImmediatePropagation()
      if (!profile) { requireSteam(); return }
      const button = form.querySelector('[type="submit"]'); if (button) button.disabled = true
      try {
        await api(action, values)
        if (form.id === 'reportForm') { document.querySelector('#reportDialog').close(); form.reset(); notifyUser('Спасибо, жалоба отправлена модератору.') }
        else if (form.matches('.guide-feedback-form')) { form.hidden = true; notifyUser('Оценка от Steam-аккаунта учтена.'); await loadGuideStats() }
        else { form.reset(); notifyUser('Отправлено на проверку модератору.') }
        if (button) button.disabled = false
      } catch (error) { notifyUser(error.message); if (button) button.disabled = false }
    }, true)
  }
  function setUpObservers() {
    document.addEventListener('lane:feed-rendered', decoratePerformance)
    const forum = document.querySelector('#threadList')
    if (forum) new MutationObserver(decorateOwnedContent).observe(forum, { childList: true, subtree: true })
    const detail = document.querySelector('#threadDetail')
    if (detail) new MutationObserver(decorateOwnedContent).observe(detail, { childList: true, subtree: true })
    document.querySelector('#feedSort')?.addEventListener('change', () => setTimeout(decoratePerformance, 0))
  }
  async function boot() {
    installSubmitHandlers()
    setUpObservers()
    document.querySelector('#openForm')?.addEventListener('click', () => { if (!profile) notifyUser('Войди через Steam перед публикацией.') })
    const guideHint = document.querySelector('#form .fineprint')
    if (guideHint) guideHint.textContent = 'Публикация привязывается к Steam-профилю и появится после одобрения.'
    const threadHint = document.querySelector('#threadForm .fineprint')
    if (threadHint) threadHint.textContent = 'Тема привязывается к Steam-профилю и появится после одобрения.'
    await acceptSession()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
})()
