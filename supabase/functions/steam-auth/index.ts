import { createClient } from 'npm:@supabase/supabase-js@2'

const PROJECT_URL = Deno.env.get('SUPABASE_URL')!
const SITE_URL = Deno.env.get('LANE_SITE_URL') || 'https://xleyf.github.io/dota-lane/'
const FUNCTION_URL = `${PROJECT_URL}/functions/v1/steam-auth`
const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
const PUBLISHABLE_KEY = Deno.env.get('SUPABASE_ANON_KEY') || publishableKeys.default || ''
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || secretKeys.default
if (!SERVICE_KEY) throw new Error('Supabase service secret is unavailable')

const db = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false } })
const encoder = new TextEncoder()
const siteOrigin = new URL(SITE_URL).origin
const STATE_COOKIE = 'lane_steam_openid_state'
const headers = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin === siteOrigin ? siteOrigin : siteOrigin,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json; charset=utf-8',
  'Vary': 'Origin',
})
const json = (body: unknown, status = 200, origin: string | null = null) =>
  new Response(JSON.stringify(body), { status, headers: headers(origin) })
const fail = (message: string, status = 400, origin: string | null = null) =>
  json({ error: message }, status, origin)
const randomToken = (bytes = 32) => {
  const value = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
function errorResponse(message: string, origin: string | null) {
  const target = new URL(SITE_URL)
  target.hash = `steam_error=${encodeURIComponent(message)}`
  return Response.redirect(target, 303)
}
function validSteamUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 500) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      (url.hostname === 'steamcommunity.com' || url.hostname === 'www.steamcommunity.com') &&
      url.pathname === '/sharedfiles/filedetails/' && /^\d{5,20}$/.test(url.searchParams.get('id') || '')
  } catch { return false }
}
function safeText(value: unknown, min: number, max: number) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max
}
async function getSession(request: Request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || ''
  if (token.length < 32 || token.length > 200) return null
  const { data: session } = await db.from('steam_sessions')
    .select('profile_id,expires_at').eq('token_hash', await sha256(token)).gt('expires_at', new Date().toISOString()).maybeSingle()
  if (!session) return null
  const { data: profile } = await db.from('steam_profiles')
    .select('id,steam_id,is_moderator').eq('id', session.profile_id).maybeSingle()
  return profile ? { token, ...profile } : null
}
async function steamLogin(request: Request) {
  const expired = new Date().toISOString()
  await Promise.all([
    db.from('steam_login_states').delete().lt('expires_at', expired),
    db.from('steam_login_tickets').delete().lt('expires_at', expired),
    db.from('steam_sessions').delete().lt('expires_at', expired),
  ])
  const state = randomToken(24)
  const stateHash = await sha256(state)
  const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || ''
  const clientHash = clientIp ? await sha256(`${clientIp}:${SERVICE_KEY}`) : null
  if (clientHash) {
    const { count, error: countError } = await db.from('steam_login_states')
      .select('state_hash', { count: 'exact', head: true })
      .eq('client_hash', clientHash).gt('created_at', new Date(Date.now() - 10 * 60_000).toISOString())
    if (countError) return fail('Не удалось проверить частоту входов.', 503)
    if ((count || 0) >= 12) return fail('Слишком много попыток входа. Подожди несколько минут.', 429)
  }
  const { error } = await db.from('steam_login_states').insert({
    state_hash: stateHash,
    client_hash: clientHash,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  })
  if (error) return fail('Не удалось начать вход Steam.', 503)
  const returnTo = new URL(FUNCTION_URL)
  returnTo.searchParams.set('action', 'callback')
  returnTo.searchParams.set('state', state)
  returnTo.searchParams.set('apikey', PUBLISHABLE_KEY)
  const openId = new URL('https://steamcommunity.com/openid/login')
  const params: Record<string, string> = {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo.toString(),
    'openid.realm': new URL(FUNCTION_URL).origin,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  }
  Object.entries(params).forEach(([key, value]) => openId.searchParams.set(key, value))
  return new Response(null, { status: 302, headers: {
    Location: openId.toString(),
    'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
  } })
}
async function steamCallback(request: Request, url: URL) {
  const state = url.searchParams.get('state') || ''
  const cookieState = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${STATE_COOKIE}=([^;]+)`))?.[1] || ''
  if (!state || state.length > 100 || cookieState !== state) return errorResponse('Не удалось подтвердить вход Steam. Начни вход заново.', null)
  const openId = new URLSearchParams()
  for (const [key, value] of url.searchParams) if (key.startsWith('openid.')) openId.set(key, value)
  const claimedId = openId.get('openid.claimed_id') || ''
  const match = claimedId.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/)
  const responseNonce = openId.get('openid.response_nonce') || ''
  const nonceDate = Date.parse(responseNonce.slice(0, 20))
  const now = Date.now()
  const returnTo = new URL(FUNCTION_URL)
  returnTo.searchParams.set('action', 'callback')
  returnTo.searchParams.set('state', state)
  returnTo.searchParams.set('apikey', PUBLISHABLE_KEY)
  if (url.searchParams.get('openid.mode') !== 'id_res' || !match || openId.get('openid.identity') !== claimedId ||
      openId.get('openid.op_endpoint') !== 'https://steamcommunity.com/openid/login' ||
      openId.get('openid.return_to') !== returnTo.toString() ||
      !Number.isFinite(nonceDate) || Math.abs(now - nonceDate) > 15 * 60_000) {
    return errorResponse('Ответ Steam не прошёл проверку.', null)
  }
  openId.set('openid.mode', 'check_authentication')
  let verification: Response
  try {
    verification = await fetch('https://steamcommunity.com/openid/login', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: openId,
    })
  } catch { return errorResponse('Сейчас не удалось связаться со Steam.', null) }
  const result = await verification.text()
  if (!verification.ok || !/^is_valid:true\s*$/m.test(result)) return errorResponse('Steam не подтвердил вход.', null)
  const used = await db.rpc('consume_steam_state', { p_hash: await sha256(state) })
  if (used.error || used.data !== true) return errorResponse('Ссылка входа уже использована или устарела.', null)

  const steamId = match[1]
  const adminIds = (Deno.env.get('LANE_ADMIN_STEAM_IDS') || '').split(',').map((id) => id.trim()).filter(Boolean)
  const { data: profile, error: profileError } = await db.from('steam_profiles').upsert({
    steam_id: steamId,
    is_moderator: adminIds.includes(steamId),
  }, { onConflict: 'steam_id' }).select('id').single()
  if (profileError || !profile) return errorResponse('Не удалось создать профиль Steam.', null)
  const ticket = randomToken()
  const { error: ticketError } = await db.from('steam_login_tickets').insert({
    ticket_hash: await sha256(ticket), steam_id: steamId,
    expires_at: new Date(Date.now() + 90_000).toISOString(),
  })
  if (ticketError) return errorResponse('Не удалось завершить вход Steam.', null)
  const target = new URL(SITE_URL)
  target.hash = `steam_ticket=${ticket}`
  return Response.redirect(target, 303)
}
async function exchangeTicket(body: Record<string, unknown>, origin: string | null) {
  const ticket = typeof body.ticket === 'string' ? body.ticket : ''
  if (ticket.length < 32 || ticket.length > 200) return fail('Ссылка входа недействительна.', 401, origin)
  const { data: rows, error } = await db.rpc('consume_steam_ticket', { p_hash: await sha256(ticket) })
  const steamId = rows?.[0]?.steam_id
  if (error || !/^\d{17}$/.test(steamId || '')) return fail('Ссылка входа уже использована или устарела.', 401, origin)
  const { data: profile } = await db.from('steam_profiles').select('id,steam_id,is_moderator').eq('steam_id', steamId).single()
  if (!profile) return fail('Профиль Steam не найден.', 401, origin)
  const token = randomToken()
  const { error: sessionError } = await db.from('steam_sessions').insert({
    token_hash: await sha256(token), profile_id: profile.id,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
  })
  if (sessionError) return fail('Не удалось открыть сессию.', 503, origin)
  return json({ token, profile }, 200, origin)
}
async function enforceWriteLimit(profileId: string, origin: string | null) {
  const { data, error } = await db.rpc('allow_steam_write', { p_profile_id: profileId })
  if (error) return fail('Не удалось проверить лимит публикаций.', 503, origin)
  if (data !== true) return fail('Слишком много действий за минуту. Подожди немного.', 429, origin)
  return null
}
async function myContent(profileId: string, origin: string | null) {
  const [guides, threads, replies] = await Promise.all([
    db.from('guides').select('id,title,hero,position,description,steam_url,moderation_status').eq('owner_profile_id', profileId),
    db.from('forum_threads').select('id,title,hero,category,body,moderation_status').eq('owner_profile_id', profileId),
    db.from('forum_replies').select('id,thread_id,body,moderation_status').eq('owner_profile_id', profileId),
  ])
  if (guides.error || threads.error || replies.error) return fail('Не удалось загрузить ваши публикации.', 503, origin)
  return json({ guides: guides.data, threads: threads.data, replies: replies.data }, 200, origin)
}
async function moderate(action: string, body: Record<string, unknown>, profile: { is_moderator: boolean }, origin: string | null) {
  if (!profile.is_moderator) return fail('Нет доступа к модерации.', 403, origin)
  if (action === 'moderation_queue') {
    const [guides, threads, replies, reports] = await Promise.all([
      db.from('guides').select('*').eq('moderation_status', 'pending').order('created_at').limit(50),
      db.from('forum_threads').select('*').eq('moderation_status', 'pending').order('created_at').limit(50),
      db.from('forum_replies').select('*').eq('moderation_status', 'pending').order('created_at').limit(50),
      db.from('content_reports').select('*').eq('status', 'new').order('created_at').limit(100),
    ])
    const error = [guides, threads, replies, reports].find((item) => item.error)?.error
    return error ? fail('Не удалось получить очередь модерации.', 503, origin) :
      json({ guides: guides.data, threads: threads.data, replies: replies.data, reports: reports.data }, 200, origin)
  }
  if (action === 'moderate_content') {
    const table = ({ guide: 'guides', thread: 'forum_threads', reply: 'forum_replies' } as Record<string, string>)[String(body.type)]
    const id = Number(body.id)
    const status = body.status
    if (!table || !Number.isSafeInteger(id) || !['approved', 'rejected'].includes(String(status))) return fail('Неверные данные модерации.', 400, origin)
    const { error } = await db.from(table).update({ moderation_status: status }).eq('id', id)
    return error ? fail('Не удалось обновить публикацию.', 503, origin) : json({ ok: true }, 200, origin)
  }
  if (action === 'resolve_report') {
    const id = Number(body.id)
    if (!Number.isSafeInteger(id) || !['reviewed', 'dismissed'].includes(String(body.status))) return fail('Неверные данные жалобы.', 400, origin)
    const { error } = await db.from('content_reports').update({ status: body.status }).eq('id', id)
    return error ? fail('Не удалось обновить жалобу.', 503, origin) : json({ ok: true }, 200, origin)
  }
  return fail('Неизвестное действие.', 404, origin)
}
async function handleAction(action: string, body: Record<string, unknown>, profile: NonNullable<Awaited<ReturnType<typeof getSession>>>, origin: string | null) {
  const profileId = profile.id
  if (action === 'me') return json({ profile: { id: profile.id, steam_id: profile.steam_id, is_moderator: profile.is_moderator } }, 200, origin)
  if (action === 'logout') {
    await db.from('steam_sessions').delete().eq('token_hash', await sha256(profile.token))
    return json({ ok: true }, 200, origin)
  }
  if (action === 'my_content') return myContent(profileId, origin)
  if (action.startsWith('moderation_') || action === 'moderate_content' || action === 'resolve_report')
    return moderate(action, body, profile, origin)
  if (action === 'rate_guide') {
    const guideId = String(body.guide_id || '')
    const gamesPlayed = Number(body.games_played)
    const rating = Number(body.rating)
    if (!/^\d{5,20}$/.test(guideId) || !Number.isInteger(gamesPlayed) || gamesPlayed < 1 || gamesPlayed > 5000 || !Number.isInteger(rating) || rating < 1 || rating > 5) return fail('Укажи число матчей от 1 до 5000 и оценку от 1 до 5.', 400, origin)
    const rateLimit = await enforceWriteLimit(profileId, origin); if (rateLimit) return rateLimit
    const { error } = await db.from('guide_feedback').insert({
      guide_id: guideId, visitor_id: profileId, games_played: gamesPlayed, rating, steam_verified: true,
    })
    if (error?.code === '23505') return fail('Ты уже оценивал это руководство.', 409, origin)
    return error ? fail('Не удалось сохранить оценку.', 503, origin) : json({ ok: true }, 200, origin)
  }
  if (action === 'report') {
    const types = ['steam_build', 'community_guide', 'forum_thread', 'forum_reply']
    const reasons = ['Оскорбления или грубость', 'Спам или реклама', 'Неверный герой или ссылка', 'Другое']
    const targetId = String(body.target_id || '')
    if (!types.includes(String(body.target_type)) || !targetId || targetId.length > 80 || !reasons.includes(String(body.reason)) || !safeText(body.details || '', 0, 500)) return fail('Проверь данные жалобы.', 400, origin)
    const rateLimit = await enforceWriteLimit(profileId, origin); if (rateLimit) return rateLimit
    const { error } = await db.from('content_reports').insert({
      target_type: body.target_type, target_id: targetId, reason: body.reason,
      details: String(body.details || '').trim(), visitor_id: profileId,
    })
    if (error?.code === '23505') return fail('Ты уже пожаловался на эту публикацию.', 409, origin)
    return error ? fail('Не удалось отправить жалобу.', 503, origin) : json({ ok: true }, 200, origin)
  }
  if (action === 'create_guide') {
    const { title, hero, position, description, steam_url } = body
    const pos = position === '' || position === null || position === undefined ? null : Number(position)
    if (!safeText(title, 1, 80) || !safeText(hero, 1, 80) || (pos !== null && (!Number.isInteger(pos) || pos < 1 || pos > 5)) || !safeText(description || '', 0, 180) || !validSteamUrl(steam_url)) return fail('Проверь поля гайда и ссылку Steam.', 400, origin)
    const rateLimit = await enforceWriteLimit(profileId, origin); if (rateLimit) return rateLimit
    const { data, error } = await db.from('guides').insert({
      title: String(title).trim(), hero: String(hero).trim(), position: pos,
      description: String(description || '').trim(), steam_url, owner_profile_id: profileId,
    }).select('id').single()
    return error ? fail('Не удалось отправить гайд.', 503, origin) : json({ ok: true, id: data.id, moderation_status: 'pending' }, 201, origin)
  }
  if (action === 'create_thread') {
    if (!safeText(body.title, 5, 120) || !safeText(body.body, 5, 2000) || !['Вопрос', 'Матчап', 'Предметы', 'Тактика'].includes(String(body.category))) return fail('Проверь заголовок, тему и раздел.', 400, origin)
    const rateLimit = await enforceWriteLimit(profileId, origin); if (rateLimit) return rateLimit
    const { data, error } = await db.from('forum_threads').insert({
      title: String(body.title).trim(), hero: body.hero || null, category: body.category,
      body: String(body.body).trim(), owner_profile_id: profileId,
    }).select('id').single()
    return error ? fail('Не удалось отправить тему.', 503, origin) : json({ ok: true, id: data.id, moderation_status: 'pending' }, 201, origin)
  }
  if (action === 'create_reply') {
    const threadId = Number(body.thread_id)
    if (!Number.isSafeInteger(threadId) || !safeText(body.body, 1, 1200)) return fail('Проверь текст ответа.', 400, origin)
    const { data: thread, error: threadError } = await db.from('forum_threads')
      .select('id').eq('id', threadId).eq('moderation_status', 'approved').maybeSingle()
    if (threadError) return fail('Не удалось проверить обсуждение.', 503, origin)
    if (!thread) return fail('Можно отвечать только в опубликованных обсуждениях.', 404, origin)
    const rateLimit = await enforceWriteLimit(profileId, origin); if (rateLimit) return rateLimit
    const { data, error } = await db.from('forum_replies').insert({ thread_id: threadId, body: String(body.body).trim(), owner_profile_id: profileId }).select('id').single()
    return error ? fail('Не удалось отправить ответ.', 503, origin) : json({ ok: true, id: data.id, moderation_status: 'pending' }, 201, origin)
  }
  if (action === 'update_guide') {
    const id = Number(body.id); const patch: Record<string, unknown> = {}
    if (body.title !== undefined) { if (!safeText(body.title, 1, 80)) return fail('Неверное название гайда.', 400, origin); patch.title = String(body.title).trim() }
    if (body.hero !== undefined) { if (!safeText(body.hero, 1, 80)) return fail('Неверный герой.', 400, origin); patch.hero = String(body.hero).trim() }
    if (body.position !== undefined) { const pos = body.position === '' || body.position === null ? null : Number(body.position); if (pos !== null && (!Number.isInteger(pos) || pos < 1 || pos > 5)) return fail('Неверная позиция.', 400, origin); patch.position = pos }
    if (body.description !== undefined) { if (!safeText(body.description, 0, 180)) return fail('Описание слишком длинное.', 400, origin); patch.description = String(body.description).trim() }
    if (body.steam_url !== undefined) { if (!validSteamUrl(body.steam_url)) return fail('Неверная ссылка Steam.', 400, origin); patch.steam_url = body.steam_url }
    return updateOwned('guides', id, patch, profileId, origin)
  }
  if (action === 'update_thread') {
    const id = Number(body.id); const patch: Record<string, unknown> = {}
    if (body.title !== undefined) { if (!safeText(body.title, 5, 120)) return fail('Неверный заголовок темы.', 400, origin); patch.title = String(body.title).trim() }
    if (body.body !== undefined) { if (!safeText(body.body, 5, 2000)) return fail('Неверный текст темы.', 400, origin); patch.body = String(body.body).trim() }
    if (body.hero !== undefined) patch.hero = body.hero || null
    if (body.category !== undefined) { if (!['Вопрос', 'Матчап', 'Предметы', 'Тактика'].includes(String(body.category))) return fail('Неверный раздел.', 400, origin); patch.category = body.category }
    return updateOwned('forum_threads', id, patch, profileId, origin)
  }
  if (action === 'update_reply') {
    const id = Number(body.id)
    if (!safeText(body.body, 1, 1200)) return fail('Проверь текст ответа.', 400, origin)
    return updateOwned('forum_replies', id, { body: String(body.body).trim() }, profileId, origin)
  }
  if (action.startsWith('delete_')) {
    const table = ({ delete_guide: 'guides', delete_thread: 'forum_threads', delete_reply: 'forum_replies' } as Record<string, string>)[action]
    if (!table) return fail('Неизвестное действие.', 404, origin)
    const id = Number(body.id)
    if (!Number.isSafeInteger(id)) return fail('Неверный идентификатор.', 400, origin)
    const rateLimit = await enforceWriteLimit(profileId, origin); if (rateLimit) return rateLimit
    const { data, error } = await db.from(table).delete().eq('id', id).eq('owner_profile_id', profileId).select('id').maybeSingle()
    if (error) return fail('Не удалось удалить публикацию.', 503, origin)
    return data ? json({ ok: true }, 200, origin) : fail('Публикация не найдена или принадлежит другому пользователю.', 404, origin)
  }
  return fail('Неизвестное действие.', 404, origin)
}
async function updateOwned(table: string, id: number, values: Record<string, unknown>, profileId: string, origin: string | null) {
  if (!Number.isSafeInteger(id) || !Object.keys(values).length) return fail('Нет изменений для сохранения.', 400, origin)
  const rateLimit = await enforceWriteLimit(profileId, origin); if (rateLimit) return rateLimit
  values.moderation_status = 'pending'
  const { data, error } = await db.from(table).update(values).eq('id', id).eq('owner_profile_id', profileId).select('id').maybeSingle()
  if (error) return fail('Не удалось сохранить изменения.', 503, origin)
  return data ? json({ ok: true, moderation_status: 'pending' }, 200, origin) : fail('Публикация не найдена или принадлежит другому пользователю.', 404, origin)
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin')
  if (request.method === 'OPTIONS') return new Response('ok', { headers: headers(origin) })
  const url = new URL(request.url)
  const action = url.searchParams.get('action') || ''
  if (request.method === 'GET' && action === 'login') return await steamLogin(request)
  if (request.method === 'GET' && action === 'callback') return await steamCallback(request, url)
  if (request.method !== 'POST') return fail('Метод не поддерживается.', 405, origin)
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return fail('Нужен JSON-запрос.', 400, origin) }
  if (action === 'exchange') return await exchangeTicket(body, origin)
  const profile = await getSession(request)
  if (!profile) return fail('Войди через Steam, чтобы продолжить.', 401, origin)
  return await handleAction(action, body, profile, origin)
})
