# Universe API

HTTP `GET /health`; JSON WebSocket `ws://127.0.0.1:18793/session`. Один владелец до закрытия соединения и завершения очистки ресурсов; второй получает HTTP 409. Чужой browser Origin получает HTTP 403. Нативный локальный клиент может подключаться без Origin. Не публиковать порт в сеть: удалённой аутентификации нет.

## Сообщения клиента

| type | Поля и смысл |
|---|---|
| `session.start` | `voice` (по умолчанию true), `tools` (до 16 функций) |
| `input.text` | `text`: 1–16000 символов, полноценное поручение Codex |
| `input.audio` | `data`: base64 PCM16 LE, `sampleRate`: 16000/24000/48000, `numChannels`: 1/2; максимум 100 мс |
| `tool.result` | `callId`, `result: {success, contentItems: [{type: "inputText", text}]}` |
| `session.interrupt` | Сбросить голос и закрыть сессию; для продолжения подключиться заново, действия не откатываются |
| `session.close` | Закрыть ресурсы; для новой сессии открыть новое соединение |

Первым отправить `session.start`, дождаться `session.started`. JSON ограничен 256 КиБ. Аудио отправлять с реальной скоростью, обычно по 20 мс. Явное прерывание в этом прототипе завершает сессию и соединение. Для продолжения открыть новый WebSocket и отправить `session.start`.

## События сервера

| type | Поля |
|---|---|
| `session.started` | `sessionId`, `voice` |
| `output.audio` | `data`, `sampleRate: 48000`, `numChannels: 1`; PCM16 LE по 20 мс |
| `output.reset` | Остановить и очистить локальное воспроизведение |
| `transcript` | `role`, `delta` либо `text` + `final: true` |
| `task.progress` | `delta`: текст backend-агента |
| `task.completed` | `status` поручения |
| `tool.started` | `callId`, `name` |
| `tool.call` | `callId`, `name`, `arguments`: исполнить клиентскую функцию |
| `tool.completed` | `callId`, `name`, `success` |
| `error` | `message` |
| `session.closed` | Ресурсы закрыты |

`tool.completed` подтверждает ответ клиентского обработчика либо завершение штатного действия Codex. Имена `shell` и `files` обозначают его собственные командные и файловые инструменты; для shell успех требует кода выхода 0. `task.progress` содержит текст модели. При `output.reset` клиент очищает очередь аудио, иначе старый ответ продолжит звучать у слушателя.

## Локальное действие

Рабочий пример: `scripts/smoke.ts` (`npm run smoke`), общий обработчик — `scripts/demo-tool.ts`. Голосовой запуск из Matrix проверяется командой `npm run smoke:command`. Клиент регистрирует:

```json
{
  "type": "session.start",
  "voice": false,
  "tools": [{
    "name": "node_version",
    "description": "Execute installed Node.js --version on the client computer",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
  }]
}
```

При `tool.call` обработчик проверяет имя/аргументы, запускает `execFile(process.execPath, ["--version"])` без shell и возвращает:

```json
{
  "type": "tool.result",
  "callId": "<полученный callId>",
  "result": {
    "success": true,
    "contentItems": [{"type": "inputText", "text": "v26.13.0"}]
  }
}
```

Локальный backend уже умеет выполнять команды и работать с файлами через инструменты Codex и наследует разрешения CLI. Клиентские функции нужны для дополнительных приложений или другой машины. Их JSON Schema описывает аргументы модели, но обработчик обязан проверять их сам. Не интерполировать слова модели в shell-команду клиентского обработчика. Ответить нужно за 30 секунд. При закрытии сессии ожидающие вызовы завершаются ошибкой; отменять уже запущенный процесс клиента обязан сам клиент.

`system_time` встроен. Имена функций — `[a-z][a-z0-9_]{0,63}`, уникальны в сессии. Результат — до 8 частей по 16000 символов. Повторный callId с теми же аргументами получает сохранённый результат, с другими — ошибку.

## Matrix

`MatrixAudioTransport` отдаёт `audio` → отправить `input.audio` в Universe. `output.audio` → `await matrix.input(event)`, `output.reset` → `await matrix.interrupt()`. Передачу выходных кадров сериализовать. При завершении вызвать `matrix.close()`. Полная связка: `scripts/e2e.ts`; требования к аккаунту и шифрованию: [Matrix adapter](matrix-adapter.md).
