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
- Каждый push создаёт 2 строки в Actions — вторая (без тега) пропускается, это норма.
- **Native vs JS**: изменения в `app.json`, `plugins/`, новых нативных модулях →
  тег `[BUILD]` (нужна пересборка APK). Чистый JS/TS → **пересборка НЕ нужна**,
  правки прилетают в dev-клиент сразу.

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

## Статус и отложенное

- Хостинг бэкенда: выбран Oracle Cloud Always Free (инструкция в
  `server/README.md`), пока владелец тестирует с локалки (`BACKEND_URL` = LAN-IP
  ноута; IP меняется между сетями — проверяй `ip -4 addr` при жалобах на коннект).
- Отложено: FCM-пуши для полностью закрытого приложения (нужен google-services.json
  владельца для `com.anonymous.myapp`); запись/отрисовка GPS-полилинии трассы.

## Рабочий процесс

- Коммить и пушь по завершении логической задачи (владелец просит пуш явно/по
  контексту). Сообщения коммитов — на русском.
- НЕ коммить `server/*.db`, `server/*.log`, `dist/` (в `.gitignore`).
- Owner сам отменяет неактуальные CI-раны; лишние билды не запускай без нужды.
