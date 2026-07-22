# MeshVoice — гайд для агентов

Голосовая рация + мото-соцсеть на Expo/React Native (Android + iOS). Один
самохостируемый Node-бэкенд. Репозиторий: `arcwagner1337/moto-voice-chat`.
Язык общения с владельцем — **русский**. Весь UI и сообщения — на русском.

Этот файл — канонический источник. `AGENTS.md` ссылается сюда.

## Что это за приложение

- **Локальная рация (COMM_CENTER, `two.tsx`)** — P2P по Wi-Fi/mDNS (zeroconf +
  TCP), сервер не нужен, работает офлайн в одной сети.
- **Интернет-звонки (INTERNET CALL, `three.tsx`)** — WebRTC через socket.io
  сигналинг на общем бэкенде; комнаты по названию. Чаты используют комнату
  `chat-<id>`.
- **Соцсеть** — аккаунты, друзья, личные/групповые чаты, presence.
- **Карта (`map.tsx`)** — позиции друзей, заезды с лидербордом и трассой,
  фоновый трекинг, история завершённых заездов.

## Архитектура

### Клиент (`app/`, `lib/`)
- Expo Router (файловый роутинг). Вкладки в `app/(tabs)/`:
  `index.tsx` (главная/статус), `social.tsx` (FRIENDS: авторизация, друзья,
  поиск), `chats.tsx` (список чатов), `map.tsx` (MAP), `two.tsx` (COMM_CENTER),
  `three.tsx` (INTERNET CALL), `profile.tsx` (PROFILE). Чат — `app/chat/[id].tsx`.
- `lib/api.ts` — весь REST-клиент (`request()` обёртка, Bearer-токен, типы
  `SocialUser`/`ChatSummary`/`RideInfo`/...). База берётся из `getApiBase()`.
- `lib/config.ts` — **`BACKEND_URL`, единственный адрес бэкенда** (захардкожен;
  UI-редактирования IP больше нет). При переезде сервера меняется только он.
- `lib/socialSocket.ts` — общий socket.io для соцсети (сообщения, заявки,
  presence, `loc:*`, `call:incoming`). Голосовой сигналинг в `three.tsx` —
  **отдельный сокет**, не путать.
- `lib/notifications.ts` — notifee-уведомления (сообщения, заявки, звонки).
- `lib/backgroundLocation.ts` — expo-task-manager фоновый GPS (opt-in).
- `lib/useLiveLocation.ts`, `lib/useVolumeMute.ts`, `lib/mapHtml.ts` (Leaflet
  внутри WebView — **без вложенных backtick'ов** в шаблоне).
- `lib/profile.ts` — локальный профиль (имя+аватар в AsyncStorage; сервера тут нет).

### Сервер (`server/`, TypeScript → `dist/`)
- **Node 22.5+ обязателен** — используется встроенный `node:sqlite`
  (`DatabaseSync`), никаких нативных зависимостей.
- Express 5 + socket.io на одном порту **3000**. JWT (180 дней) + bcryptjs.
- `src/db.ts` — схема (users, friendships, chats, chat_members, messages, rides,
  ride_members), миграции через try/catch ALTER, хелперы, `accumulateRideStats`
  (haversine, чекпоинты) — **статистику заездов считает сервер**, клиент шлёт
  только координаты.
- `src/api.ts` — все REST-маршруты. `src/realtime.ts` — socket.io + presence +
  `storeLocation`. `src/auth.ts` — JWT/bcrypt/`requireAuth`.
- **Порядок маршрутов важен**: `/rides/history` и `/rides/active` объявлены
  ДО `/rides/:id`, иначе `:id` перехватит их.

## Команды

```bash
# клиент
npx tsc --noEmit                 # обязательная проверка перед коммитом
npm start                        # expo dev server

# сервер
cd server && npm run build       # tsc → dist/  (после ЛЮБОЙ правки src/)
node dist/index.js               # запуск на :3000, база server/meshvoice.db
```

Локальный сервер для тестов с телефона: `cd server && npm run build && node dist/index.js`.
Живой процесс НЕ подхватывает пересборку `dist` — после правок сервера его
нужно перезапустить (`kill <pid>` по `ss -tlnp | grep :3000`, затем заново).

## Тестирование сервера (без нативной сборки)

Изолированная база + отдельный порт, curl/socket.io, уборка после:
```bash
DB_PATH=/tmp/.../test.db PORT=3999 node dist/index.js &   # НЕ трогать боевую :3000
# ... curl http://localhost:3999/api/... ; регистрация даёт user.id и token ...
PID=$(ss -tlnp | grep :3999 | grep -oP 'pid=\K[0-9]+'); kill $PID; rm -f test.db*
```
Правила: username `^[a-zA-Z0-9_]{3,20}$` (u1/u2 не пройдут — бери user1/user2);
id аккаунтов не хардкодить (сдвигаются) — читай из ответа; `cd` в той же
Bash-команде (cwd сбрасывается между вызовами).

## CI / сборки (`.github/workflows/`)

- `autobuild.yml` — dev-APK при `[BUILD]`/`[RUN]` в сообщении коммита или вручную.
- `release.yml` — production-APK (вне Play Market) при `[RELEASE]` или вручную.
  По умолчанию debug-подпись; для своего ключа нужны секреты
  `ANDROID_KEYSTORE_BASE64/…_PASSWORD/…_KEY_ALIAS/**ANDROID_KEY_PASSWORD**`.
  **Открытая проблема**: `ANDROID_KEY_PASSWORD` (пароль именно ключа, не
  keystore) владельцем ещё не добавлен → релиз выходит с debug-подписью.
  Шаг «Bump Gradle heap» поднимает `-Xmx4096m` (иначе OOM при упаковке APK).
- `eas-update.yml` — авто-публикация OTA (`eas update`) на push в `main`, кроме
  коммитов с `[BUILD]`/`[RELEASE]` и путей `server/**`, `.github/**`, `*.md`.
  См. раздел «OTA-обновления».
- Каждый push создаёт 2 строки в Actions — вторая (без тега) пропускается, это норма.
- **Native vs JS**: изменения в `app.json`, `plugins/`, новых нативных модулях →
  тег `[BUILD]` (нужна пересборка APK). Чистый JS/TS → **пересборка НЕ нужна**:
  в dev-клиент прилетает сразу, в release-APK — через OTA (см. ниже).

## OTA-обновления (EAS Update)

JS/TS-правки доезжают до установленных release-приложений без пересборки APK.

- **Конфиг**: `expo-updates` (версия строго под SDK — сейчас `~29.0.19`, берётся из
  `expo/bundledNativeModules.json`, НЕ ставить вручную свежий major!). В `app.json`:
  `updates.url = https://u.expo.dev/<projectId>`, `updates.requestHeaders`
  `{expo-channel-name: production}`, `runtimeVersion.policy = appVersion`.
- **Канал/ветка**: канал `production` (вшит в сборку) → ветка `production` в EAS.
  `eas.json` описывает профили и каналы. Публикация: `eas update --branch production`.
- **Авто-публикация**: `eas-update.yml` гоняет `eas update` на каждый JS-push в `main`.
  Аккаунт EAS — `owner: 1mposs1bl3` (alexandr.bryaginya@gmail.com),
  `projectId b4c8eba9-d9ff-4978-a983-2c262c956a31`.
- **Публикация с aarch64 (Asahi)**: прямой `eas update` падает — `hermesc` есть только
  под x86 (linux64/osx/win64), компиляция Hermes через FEX/muvm рушится
  (`could not connect to muvm server`). **Обход** (`bun run ota`): `expo export
  --no-bytecode` (hermesc не вызывается, отдаётся обычный JS — Hermes в приложении
  его исполнит) + `eas update --branch production --skip-bundler --input-dir dist`.
  `bun run ota:ci` = `gh workflow run eas-update.yml` — публикация bytecode с x86-раннера
  (быстрее, но нужен рабочий EXPO_TOKEN). Логин локально — `1mposs1bl3` (sessionSecret).
- **Как применяется на телефоне**: по умолчанию (`checkAutomatically: ON_LOAD`)
  запуск N качает апдейт в фоне, запуск N+1 показывает. Кастомного `Updates.*`
  UI в коде нет.
- **ЖЕЛЕЗНОЕ правило runtimeVersion**: политика `appVersion` → все сборки с одним
  `version` (`1.0.0`) делят runtimeVersion. **Любое нативное изменение (новый модуль,
  разрешение) без бампа `version` = OTA с новым JS прилетит на старый бинарник и
  уронит его.** Меняешь нативное → подними `expo.version` (и делай `[RELEASE]`),
  чтобы runtimeVersion разошлись.
- **⚠️ ОТКРЫТЫЙ БЛОКЕР — `EXPO_TOKEN` от чужого аккаунта.** Текущий секрет ведёт на
  аккаунт без доступа к проекту → `eas update` в CI падает с `Entity not authorized:
  AppEntity[b4c8eba9…]`. Владельцу заменить: expo.dev (аккаунт `1mposs1bl3`) →
  Settings → Access tokens → создать → `gh secret set EXPO_TOKEN`.
- **Разовая настройка владельцем** (после фикса токена): `eas channel:create production`
  (создаёт канал+ветку и связывает их) + поставить на телефон свежий `[RELEASE]`-APK
  с вшитым каналом — только с него OTA и заработает.

## Критические инварианты (не ломать)

- **`applicationId` / `bundleIdentifier` = `com.anonymous.myapp`** — залочено.
  Это дефолт CI; локальный `expo prebuild` пишет случайный
  `com.xxx.myapp` — если увидел такое в `app.json`, верни обратно. Смена ломает
  путь обновления установленного APK.
- Микрофон (`getUserMedia`) захватывается **только при входе в комнату**, не при
  открытии вкладки; в `stopAll` освобождается ПЕРВЫМ (иначе индикатор записи
  висит после выхода). Касается и `two.tsx`, и `three.tsx`.
- **`three.tsx` использует TAB-отступы** — при Edit копируй точный текст из Read.
- Разрешения Android/iOS живут в `app.json` (RECORD_AUDIO, FOREGROUND_SERVICE_*,
  ACCESS_*_LOCATION, BLUETOOTH_CONNECT, POST_NOTIFICATIONS + iOS UIBackgroundModes
  [audio,voip,location] и NS*-строки). Новое разрешение → правка тут → `[BUILD]`.
- HTTPS обязателен для release Android (cleartext) и iOS (ATS). Локально `http://LAN`
  работает только в dev-сборке.

## Текущее состояние среды (волатильно — сверяй при старте)

- Бэкенд тестируется **с локалки**: `BACKEND_URL` в `lib/config.ts` = LAN-IP
  ноута (последнее — `http://192.168.0.106:3000`). IP меняется между сетями —
  при жалобах на коннект проверь `ip -4 addr` и обнови константу.
- Боевой локальный сервер слушает **:3000**, база `server/meshvoice.db` (реальные
  аккаунты владельца — НЕ удалять, НЕ тестировать на ней; тесты только на
  изолированной `DB_PATH`+`PORT=3999`). Живой процесс не подхватывает пересборку
  `dist` — перезапускай после правок `server/src`.
- Хостинг: выбран Oracle Cloud Always Free (инструкция в `server/README.md`),
  переезд отложен владельцем.

## Отложенные задачи

- FCM-пуши для полностью закрытого приложения (нужен google-services.json
  владельца для `com.anonymous.myapp`); сейчас уведомления работают, только пока
  приложение живо (открыто или в фоне).
- Запись/отрисовка GPS-полилинии реально пройденной трассы.
- iOS-баги: владелец обещал детали позже (тестирует с macOS отдельно). Известный
  и уже починенный — микрофон не освобождался после выхода из войса.
- Владелец должен добавить секрет `ANDROID_KEY_PASSWORD` для production-подписи.

## Справочник REST API (`/api`, base = `BACKEND_URL`)

Все, кроме `/register` и `/login`, требуют `Authorization: Bearer <jwt>`.
Клиентские обёртки — в `lib/api.ts`.

**Аккаунты:** `POST /register` `{username,password,displayName?,avatar?}` →
`{token,user}` · `POST /login` `{username,password}` → `{token,user}` ·
`GET /me` · `PUT /me` `{displayName?,avatar?}`.

**Друзья:** `GET /users/search?q=` (rel в каждом: none/friends/pending_out/
pending_in) · `GET /friends` → `{friends,incoming,outgoing}` ·
`POST /friends/request` `{userId}` (встречная заявка → `{accepted:true}`) ·
`POST /friends/respond` `{userId,accept}` · `DELETE /friends/:userId`.

**Чаты:** `GET /chats` · `GET /chats/:id` · `POST /chats/dm` `{userId}` (только
друзья) · `POST /chats/group` `{name,memberIds}` · `POST /chats/:id/members`
`{memberIds}` (добавить друзей в группу) · `POST /chats/:id/call` (шлёт
`call:incoming` участникам) · `POST /chats/:id/read` `{lastId}` ·
`GET /chats/:id/messages?before=&limit=` · `POST /chats/:id/messages` `{text}`.

**Позиции:** `POST /location` `{lat,lng,speed?,heading?}` (фоновый трекинг шлёт
сюда) · `GET /locations` (позиции друзей).

**Заезды:** `POST /rides` `{name}` · `GET /rides/active` · `GET /rides/history`
(finished, до 30) · `GET /rides/:id` · `POST /rides/:id/join` ·
`POST /rides/:id/track` `{points:[{lat,lng}]}` (≤50, только организатор,
сбрасывает чекпоинты) · `POST /rides/:id/stats` (legacy, статы обычно считает
сервер) · `POST /rides/:id/finish` (создатель; статус→finished, НЕ удаляет) ·
`DELETE /rides/:id` (создатель; удаляет насовсем). Лидерборд с трассой
сортируется по чекпоинтам, без — по дистанции.

## Справочник socket.io

Подключение соцсети: `io(BACKEND_URL,{auth:{token}})` (`lib/socialSocket.ts`).
**Сервер → клиент:** `chat:new` (объект сообщения), `chats:update`,
`friends:update`, `friend:request` `{from}`, `friend:accepted` `{from}`,
`call:incoming` `{chatId,room,title,from}`, `rides:update`, `loc:friend`
`{userId,lat,lng,speed}`, `loc:friend-stop` `{userId}`.
**Клиент → сервер:** `loc:update` `{lat,lng,speed,heading}`, `loc:stop`.

Голосовой сигналинг (отдельный сокет в `three.tsx`, анонимный):
`join-room`/`signal`/`chat` (клиент) → `user-joined`/`user-left`/`signal`/
`chat`/`chat-history` (сервер).

## Схема БД (`server/src/db.ts`, node:sqlite)

- **users**(id, username UNIQUE NOCASE, password_hash, display_name, avatar, created_at)
- **friendships**(id, from_id, to_id, status[pending|accepted], created_at, UNIQUE(from,to))
- **chats**(id, type[dm|group], name?, created_by, created_at)
- **chat_members**(chat_id, user_id, joined_at, last_read_id) PK(chat,user)
- **messages**(id, chat_id, sender_id, text, created_at)
- **rides**(id, name, created_by, status[active|finished], track?[JSON], created_at, finished_at?)
- **ride_members**(ride_id, user_id, joined_at, distance, max_speed, avg_speed,
  duration, checkpoint, last_lat/lng/ts, updated_at) PK(ride,user)

Миграции — идемпотентные `ALTER TABLE` в try/catch (добавление колонок к
существующим базам). Новую колонку добавляй И в `CREATE TABLE`, И в миграции.

## Рабочий процесс

- Коммить и пушь по завершении логической задачи (владелец просит пуш явно/по
  контексту). Сообщения коммитов — на русском.
- НЕ коммить `server/*.db`, `server/*.log`, `dist/` (в `.gitignore`).
- Owner сам отменяет неактуальные CI-раны; лишние билды не запускай без нужды.

---

# ЖУРНАЛ СЕССИИ 2026-07-22 (хендофф для нового чата)

## Что сделано за большую сессию (всё в git, ветка `main`)

Начали ~v2.0, дошли до **v2.7.3**. Версии = строка `subtitle` на дашборде
(`app/(tabs)/index.tsx`). Всё, кроме медиа-батча, доставлено по OTA.

- **Чаты** (`app/chat/[id].tsx`): ответы (свайп PanResponder + контекстное меню
  по тапу), редактирование, удаление, кликабельные ссылки, авто-скролл при
  отправке, вложения (📎). Realtime `chat:edited`/`chat:deleted`.
- **Поиск по чатам** (`chats.tsx`), **меню участников групп** (список/удаление/
  добавление; сервер `createdBy`, DELETE `/chats/:id/members/:userId`).
- **Быстрый ответ из уведомления** (`notifications.ts` + `_layout.tsx`
  `onBackgroundEvent`): notifee input-action.
- **Звонок из чата** — скрытая случайная комната `call-<chatId>-<uuid>` (сервер
  `POST /chats/:id/call` возвращает room; общий войс по имени не тронут).
- **Карта**: 4 слоя циклом (тёмная/спутник/гибрид-с-дорогами Esri/светлая),
  навигатор turn-by-turn (`/route` прокси к OSRM, HUD, пересчёт), шаринг точки
  друзьям (`nav:waypoint`), просмотр заезда рисует трассу+треки участников
  (`fitTo`), метки с фото/видео (📌).
- **SOS** (`/sos`) — оповещение друзей с координатами + выбор получателей.
- **Музыка** — синхронный Audius-плеер в голосовой комнате (`three.tsx`;
  сервер `/music/search` + realtime `music:set/control/stop`), локальный мьют.
- **Фон-геолокация** — авто-хендофф foreground→background (`map.tsx` AppState).
- **Вкладка EVENTS** (`app/(tabs)/events.tsx`) — совместные поездки в ЧЧ:ММ,
  присоединение; точка сбора (моя гео / тап по карте) + привязка маршрута +
  фото карточки; авто-формат времени.
- **Дашборд**: реальные индикаторы (убраны фейки), диалог OTA-обновления с
  кнопкой «Скачать» (`Updates.checkForUpdateAsync`/`fetchUpdateAsync`/`reloadAsync`).
- **Фикс refresh-петли** карты (стабильный `pushMarkers`), **фикс IP** локального
  звонка (`two.tsx`: ретраи `getIpAddressAsync` + ручной ввод + 🔄).

## Медиа-батч = НАТИВНЫЙ (нужен APK, не OTA)

Добавлены нативные модули: `expo-image-picker`, `expo-file-system` (клиент),
`multer` (сервер). Поэтому **`expo.version` поднят 1.0.0 → 1.1.0** (runtimeVersion
развели). Плагин `expo-image-picker` в `app.json`.
- Сервер: `POST /api/upload` (multer diskStorage → `server/uploads/`, отдаётся
  `express.static('/uploads')`), колонки `messages.attachment_*`, `events.photo`,
  таблица `map_pins` + `/pins` CRUD.
- Клиент: `lib/pickMedia.ts` (`pickAndUpload`), `lib/api.ts` (`uploadFile`,
  `mediaUrl`, типы `Attachment`/`MapPin`).
- APK **v2.7.0** собран (CI run 29857620719, релиз-тег `apk-2.7.0`, debug-подпись).

## Состояние доставки (ВАЖНО про runtime; обновлено 2026-07-22)

- OTA-ветка `production` расщеплена по runtime:
  - **1.0.0** — старые бинарники, последний апдейт **v2.6.1** (без медиа).
  - **1.1.0** — APK v2.7.0 (`apk-2.7.0`), последний апдейт **v2.7.10**.
  - **1.2.0** — АКТУАЛЬНЫЙ: APK v2.8.0 (**релиз `apk-2.8.0`**, добавлен
    expo-camera для видео-кружков), последний апдейт **v2.8.1**. Новые OTA
    публикуются сюда (app.json version = 1.2.0).
- Публикация OTA: `bun run ota` НЕ работает (нет `--message`); вручную:
  `npx expo export --output-dir dist --platform android --platform ios --no-bytecode`
  затем `npx eas update --branch production --skip-bundler --input-dir dist --message "..."`.
- `babel-preset-expo` — явная devDependency: npm терял её при установке новых
  пакетов (экспорт падал с «Cannot find module 'babel-preset-expo'»).
- Бэкенд под systemd `meshvoice.service` (Restart=always). После правок
  `server/src`: `cd server && npm run build && systemctl --user restart meshvoice.service`.

### Сессия 2026-07-22, вторая часть (v2.7.4 → v2.8.1)

- v2.7.4: отмена маршрута (AbortController), клавиатура в метке, пикер события на гео.
- v2.7.5: эмодзи-метки (map_pins.emoji + XSS-фильтр), фото метки фуллскрин,
  голосовые (expo-av), лимит видео.
- v2.7.6: messages.attachments (JSON, до 10), мульти-фото, фуллскрин фото/видео в чате.
- v2.7.7: короткое имя комнаты звонка (roomLabel), KAV-аудит всех инпутов.
- v2.7.8: события — visibility all/friends + GET /events/archive (вкладка Архив).
- v2.7.9: фикс зацикливания голосовых (didJustFinish → один setStatusAsync!),
  Ionicons-иконки плеера, upload через FileSystem.uploadAsync с прогрессом,
  лимит 100 МБ + внятный 413.
- v2.7.10: общий VideoPlayerModal (чат + метки) — последний OTA для 1.1.0.
- v2.8.0 [RELEASE]: expo-camera, кружки in-app (круглая фронталка CameraView),
  TG-кнопка (тап = режим 🎤/🎥, зажатие = запись; кнопка НЕ должна
  перемонтироваться во время записи — иначе теряется onPressOut).
- v2.8.1: обложки видео (VideoThumb, первый кадр), `legacy: true` в пикере
  (классическая галерея вместо Google-фото-пикера).
- Хост-фикс: `lo mtu 8192` (systemd lo-mtu.service) — см. память
  meshvoice-upload-hang-rootcause; «баг multer» был ложным диагнозом.

## ⛔️ ИЗВЕСТНЫЕ БАГИ / TODO (по приоритету)

1. ✅ **ПОЧИНЕНО (2026-07-22) — загрузка медиа (`/api/upload`) больше не виснет.**
   Прежний диагноз («баг multer@2.2.0 + Express 5 + Node 24») был **неверным** —
   код невиновен, правки multer→busboy НЕ понадобились. Реальная причина: на ядре
   Asahi `*.asahi.*.aarch64+16k` (страницы 16 КБ) крупные TCP-сегменты (>16 КБ,
   пересекающие границу страницы) теряются на **loopback**. Виснет даже
   `curl → чистый python` (без Node/multer); чистый `network namespace` баг не
   воспроизводит. На loopback MSS задаётся MTU (65536) → сегменты ~32 КБ → бьются.
   **Фикс:** MTU интерфейса `lo` понижен до **8192** (свип: 16384❌ / 8192✅ / 1500✅),
   постоянно через `/etc/systemd/system/lo-mtu.service` (oneshot, enabled). Проверка
   на реальном сервере: `/api/upload` 100КБ→200/5мс, 1МБ→200/7мс. Если сервер
   переедет на обычное x86-ядро (Oracle) — баг вообще не проявится. Не путать: это
   касается ТОЛЬКО этой конкретной машины-хоста, не кода приложения.
2. **Клавиатура в форме метки** (`map.tsx`, модалка `pinDraft`) — добавлен
   `KeyboardAvoidingView`, но на Android в прозрачной модалке `behavior=height`
   ненадёжен, отступа нет. Нужен нормальный фикс (bottom-sheet, или
   `Modal` не transparent + adjustResize).
3. **Выбор точки события на карте** должен открывать карту **на текущей
   геолокации** и показывать маркер текущего гео (сейчас дефолтный вид Москвы).
   Файл: `events.tsx` модалка `mapPickOpen`, в `onLoadEnd` дёрнуть
   `Location.getCurrentPositionAsync` → `window.centerOn`.
4. **Отмена построения маршрута** (навигатор, `map.tsx buildRoad`) — длинные/
   ошибочные маршруты (напр. НСК→МСК) строятся долго/криво; добавить
   AbortController в `getRoad` и кнопку «Отмена» на время `buildingRoad`.
5. Серверная часть #1 проверена (curl, 100КБ/1МБ → 200). Осталось проверить **на
   устройстве** загрузку фото/видео во всех трёх местах (чат, события, метки) и
   удаление меток.

## Память агента

`~/.claude/.../memory/`: `meshvoice-backend-hosting.md` (dev-tunnel),
`meshvoice-db-safety.md` (боевая БД `server/meshvoice.db` не в git — не тестить
на ней; тесты только на изолированной `DB_PATH`+порт). dev-tunnel URL в
`lib/config.ts` (`BACKEND_URL`).
