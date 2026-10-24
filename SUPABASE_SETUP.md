# Подключение общей ленты и форума через Supabase

Текущий публичный сайт уже подключён к проекту Supabase. Гайды, темы и ответы хранятся в общих таблицах и читаются всеми посетителями. Браузер использует только публичный publishable key с настроенными RLS-политиками; секретный ключ в клиентский код не помещается.

Для нового проекта:

1. Создай проект Supabase.
2. В Dashboard → SQL Editor запусти `supabase/schema.sql`, затем `supabase/forum.sql`, `supabase/guide_feedback.sql`, `supabase/moderation.sql` и `supabase/steam_identity.sql`.
3. Возьми Project URL и publishable key в Project Settings → API Keys.
4. Укажи их в константах `SUPABASE_URL` и `SUPABASE_PUBLISHABLE_KEY` в `index.html`.

SQL-файлы создают ленту гайдов, обсуждения, ответы, оценки и очередь модерации. Уже опубликованные записи остаются видимыми; новые гайды, темы и ответы ждут проверки. Одобряй или отклоняй их в Supabase Table Editor, меняя `moderation_status` в `guides`, `forum_threads` или `forum_replies`. Жалобы находятся в `content_reports`; публичное чтение этой таблицы запрещено.

Старые публикации остаются видимыми, но без владельца их нельзя редактировать через сайт. Новые публикации требуют Steam-входа.

Для Steam-входа опубликуй `supabase/functions/steam-auth/index.ts` как Edge Function с именем `steam-auth`. Конфигурация `supabase/config.toml` отключает проверку Supabase JWT на шлюзе, потому что функцию вызывает Steam OpenID callback; функция проверяет OpenID у Steam и все приватные действия по одноразовым Steam-сессиям. Supabase secret key используется только внутри Edge Function и никогда не добавляется в HTML. В Edge Function Secrets добавь `LANE_ADMIN_STEAM_IDS` со своим 17-значным SteamID64, чтобы открыть панель модерации; можно указать несколько ID через запятую. Вход Steam не требует Steam Web API key.

После миграции публикации и жалобы принимаются только через Edge Function. Новые записи привязаны к вошедшему Steam-профилю; владелец может изменять и удалять свои материалы, изменения повторно проходят проверку. Оценка принимается один раз на Steam-профиль. Число матчей и винрейт берутся из публичного текста Steam-руководства, когда автор их указал; Steam не подтверждает их для отдельного гайда.

Не публикуй `service_role` / secret key в HTML или публичном репозитории.


Ежедневный GitHub Actions workflow обновляет `steam-builds.json` в 06:23 по Москве, если в Steam появились новые руководства или изменились данные. Если индекс не изменился, новый коммит не создаётся.
