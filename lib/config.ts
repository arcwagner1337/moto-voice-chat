// Единый общий бэкенд MeshVoice (аккаунты, чаты, карта, сигналинг INTERNET CALL).
// Пользователь этот адрес не меняет. При переезде сервера меняется только эта
// константа — это JS-код, нативная пересборка APK/IPA не требуется.
//
// ВРЕМЕННО: cloudflared quick-tunnel (systemd cloudflared-mv.service на ноуте).
// VS Code dev-tunnel сбросил порт 3000 в private (302 на auth) — вернуть его
// в Public в панели PORTS, тогда можно откатить BACKEND_URL на девтуннель.
// ВНИМАНИЕ: URL quick-tunnel меняется при рестарте cloudflared — при обрыве
// связи проверь `systemctl --user status cloudflared-mv` и URL в
// ~/.cache/cf-mv.log, обнови эту строку и опубликуй OTA.
export const BACKEND_URL = 'https://confidential-phpbb-epic-leisure.trycloudflare.com';