# Локальный MatrixRTC стенд

Стенд работает только на этом Windows-компьютере через Docker Desktop. Compose-проект — `sonora-lab`; существующие контейнеры и Matrix VM друга не используются. Node.js, Universe и Codex продолжают работать на Windows с существующим входом ChatGPT.

| Компонент | Адрес с Windows | Образ |
| --- | --- | --- |
| Synapse | `http://127.0.0.1:18008` | `ghcr.io/element-hq/synapse:v1.165.0` |
| LiveKit, сигнализация | `ws://127.0.0.1:17880` | `livekit/livekit-server:v1.13.11` |
| LiveKit, ICE | TCP `127.0.0.1:17881`, UDP `127.0.0.1:17882` | тот же |
| MatrixRTC JWT | `http://127.0.0.1:16080` | `ghcr.io/element-hq/lk-jwt-service:0.9.0` |
| Element, профиль `ui` | `http://127.0.0.1:18081` | `ghcr.io/element-hq/element-web:v1.12.33` |

Server name — `sonora.local`. Это Matrix-идентификатор сервера; DNS для него на Windows не требуется. В Element уже прописан HTTP-адрес Synapse. В браузере можно зарегистрировать отдельный локальный аккаунт без почты. Для автоматического входа и настоящего звонка боту использовать [native-адаптер](matrix-native.md); он проверен с синтетической речью.

## Запуск и проверка

Из корня проекта:

```powershell
docker compose -f infra/compose.yml config --quiet
docker compose -f infra/compose.yml --profile ui up -d --wait --wait-timeout 90
node infra/lab.mjs
```

Для запуска без Element опустить `--profile ui`. Инициализатор `synapse-init` один раз создаёт конфигурацию и подпись внутри Docker volume `sonora-lab_synapse-data`; состояние сохраняется между запусками. Проверочная программа создаёт двух новых участников и приватную комнату, включает состояние Megolm, проверяет выдачу JWT обоим участникам и отказы анонимному запросу и участнику чужой комнаты, затем отзывает Matrix-токены через logout. В stdout попадают только счётчики и результаты проверок. Сами тестовые аккаунты и комнаты остаются в локальной базе.

Ожидаемый результат:

```json
{"healthyServices":3,"authenticatedParticipants":2,"encryptedRoomState":true,"signedLiveKitTokens":2,"deniedAnonymousAndNonMember":true}
```

Проверка состояния и обычная остановка с сохранением базы:

```powershell
docker compose -f infra/compose.yml --profile ui ps
docker compose -f infra/compose.yml --profile ui down
```

Не добавлять `--volumes`, если нужны созданные аккаунты и комнаты. Остановка ограничена проектом `sonora-lab`.

## Авторизация адаптера

Текущая интеграция использует application service: Synapse проверяет Matrix bearer-токен, JWT-сервис проверяет членство пользователя в комнате через MSC4502, затем создаёт комнату LiveKit и выдаёт JWT через MSC4512. Адаптер не получает статические ключи application service или LiveKit.

1. Зарегистрировать отдельного пользователя через `POST /_matrix/client/v3/register`: `username`, случайный `password`, `auth: {"type":"m.login.dummy"}`. Для уже существующего аккаунта использовать обычный password login. Хранить `access_token` и `device_id` в памяти процесса.
2. Создать приватную комнату, пригласить второго пользователя и выполнить join. Шифрование комнаты задаётся событием `m.room.encryption` с `algorithm: "m.megolm.v1.aes-sha2"`.
3. Прочитать с Matrix bearer-токеном `GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports`. Сервер объявляет современный transport `{type: "livekit", url: "ws://127.0.0.1:17880", server_name: "sonora.local"}` и совместимый `livekit_service_url: "http://127.0.0.1:16080"`.
4. С тем же bearer-токеном отправить `POST /_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token` на **Synapse**:

```json
{
  "server_name": "sonora.local",
  "url": "ws://127.0.0.1:17880",
  "room_id": "<joined Matrix room>",
  "slot_id": "m.call#ROOM",
  "member_id": "<unique MatrixRTC member id>"
}
```

5. Ответ содержит `jwt`; подключиться к `ws://127.0.0.1:17880` через LiveKit SDK с этим JWT. Для участников одной комнаты и одного `slot_id` сервис выдаёт одинаковую медиакомнату и разные participant identities. `slot_id` должен совпадать с `session.slotId` SDK, `member_id` — с объявленным участником. Объявление MatrixRTC-участия и обмен ключами выполняет адаптер/MatrixRTC SDK; одна выдача JWT этих действий не заменяет.

Готовые функции в `infra/lab.mjs`: `createLabUser(localpart?, displayName?)`, `createLabRoom(owner, guest)`, `getLiveKitToken(user, roomId, memberId?, slotId?)`, `matrixRequest(path, options)`. Пользователь возвращается в форме `{userId, deviceId, accessToken}`. Пароль генерируется случайно и не выводится; токены возвращаются вызывающему коду только в памяти. Не выводить целиком возвращённые объекты и не сохранять их в JSON или `.env`.

Устаревший маршрут `/sfu/get` с Matrix OpenID в этом стенде не используется: он требует отдельного HTTPS federation discovery. Современный C-S маршрут выше проверен вживую и позволяет обойтись без установки локальных CA и изменения hosts. JWT-контейнер разделяет network namespace LiveKit, поэтому один SFU loopback-адрес доступен и ему, и Windows-клиенту.

## Границы стенда и проверенный результат

На 11 ноября 2026 проверены: HTTP 200 у Synapse `/health`, LiveKit `/` и JWT `/healthz`; готовность контейнеров Synapse/JWT/Element; регистрация и `whoami` двух участников; transport discovery; состояние шифрования комнаты; HMAC-подпись, срок действия и grants двух JWT; отказы HTTP 401/403. Стенд оставлен работающим. Перезапуск сохраняет Docker volume.

Эта проверка не доказывает доставку аудио, MatrixRTC key exchange или E2EE медиадорожек: эти проверки относятся к адаптеру. Состояние `m.room.encryption` не является доказательством шифрования LiveKit-медиа. Для loopback ICE использовать Chromium или нативный SDK: официальный dev-конфиг Element предупреждает, что Firefox игнорирует loopback ICE-кандидаты.

В `app-service.yaml` и `livekit.yaml` лежат явно публичные dev-ключи, а регистрация открыта. Все опубликованные порты привязаны к `127.0.0.1`; не менять привязку на `0.0.0.0` и не использовать эти конфиги на удалённом сервере. В стенде нет OpenAI-ключей или скопированного Codex auth. Обычные access logs Synapse отключены, чтобы не сохранять query-токены. Для production потребуются собственные секреты, HTTPS, закрытая регистрация и сетевой ICE/TURN-конфиг.

## Официальные источники

- [Element Call: dev Docker Compose](https://github.com/element-hq/element-call/blob/main/docker-compose-dev.yml) и [dev LiveKit config](https://github.com/element-hq/element-call/blob/main/backend/dev_livekit.yaml): один сервер вместо двух, локальные ICE-кандидаты и application service.
- [MatrixRTC authorization service 0.9.0](https://github.com/element-hq/lk-jwt-service/releases/tag/v0.9.0), [настройка сервиса](https://github.com/element-hq/lk-jwt-service/blob/v0.9.0/README.md), [точная C-S схема](https://github.com/element-hq/lk-jwt-service/blob/v0.9.0/src/requests.rs).
- [Synapse 1.165.0](https://github.com/element-hq/synapse/releases/tag/v1.165.0), [LiveKit 1.13.11](https://github.com/livekit/livekit/releases/tag/v1.13.11), [Element Web 1.12.33](https://github.com/element-hq/element-web/releases/tag/v1.12.33): закреплённые опубликованные версии на дату проверки.
