# MeshVoice Server

Единый бэкенд приложения: аккаунты, друзья, личные/групповые чаты (REST + socket.io)
и сигналинг голосовых комнат INTERNET CALL. База — SQLite-файл `meshvoice.db` рядом
с сервером (для бэкапа достаточно скопировать файл).

## Требования

- Node.js **22.5+** (используется встроенный `node:sqlite`, ничего компилировать не нужно)

## Запуск

```bash
cd server
npm install
npm run build
npm start          # порт 3000
```

Переменные окружения (необязательные):

| Переменная   | Назначение                                   | По умолчанию            |
|--------------|----------------------------------------------|-------------------------|
| `PORT`       | Порт сервера                                 | `3000`                  |
| `JWT_SECRET` | Секрет токенов                               | генерируется в `.jwt-secret` |
| `DB_PATH`    | Путь к файлу базы                            | `server/meshvoice.db`   |

После запуска в приложении во вкладке **PROFILE** укажите адрес сервера,
например `http://ВАШ_IP:3000`.

## Автозапуск через systemd (на своём сервере)

`/etc/systemd/system/meshvoice.service`:

```ini
[Unit]
Description=MeshVoice server
After=network.target

[Service]
WorkingDirectory=/opt/moto-voice-chat/server
ExecStart=/usr/bin/node dist/index.js
Restart=always
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now meshvoice
```

## API кратко

- `POST /api/register`, `POST /api/login` → `{token, user}`
- `GET/PUT /api/me`
- `GET /api/users/search?q=`
- `GET /api/friends`, `POST /api/friends/request`, `POST /api/friends/respond`, `DELETE /api/friends/:userId`
- `GET /api/chats`, `POST /api/chats/dm`, `POST /api/chats/group`
- `GET/POST /api/chats/:id/messages`, `POST /api/chats/:id/read`
- `POST /api/location` (позиция; фоновый трекинг шлёт сюда), `GET /api/locations` (друзья)
- `POST /api/rides` (создать заезд), `GET /api/rides/active`, `GET /api/rides/:id` (лидерборд),
  `POST /api/rides/:id/join|track|finish` (track/finish — только организатор)

Статистика заездов (дистанция, макс/средняя скорость, чекпоинты трассы)
считается сервером по входящим позициям — клиенту достаточно слать координаты.

Realtime-события (socket.io, auth: `{token}`): `chat:new`, `chats:update`,
`friends:update`, `rides:update`, `loc:friend`, `loc:friend-stop`; клиент шлёт
`loc:update`/`loc:stop`. Анонимные подключения работают как раньше — только
голосовой сигналинг (`join-room`, `signal`, `chat`).
