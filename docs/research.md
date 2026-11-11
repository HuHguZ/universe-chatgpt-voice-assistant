# Источники исследования

Состояние исследования: 11 ноября 2026 года. Наличие функций в документации или коде проекта не означает, что они проверены в нашем окружении.

## Голос через аккаунт ChatGPT

- [Alisa ChatGPT voice assistant](https://github.com/rison1337/Alisa-ChatGPT-voice-assistant), изучен коммит `24806ecaea2258bbaa0c779ebceb9fdfeebc66fb`. Нативный клиент использует сессию аккаунта, WebRTC и отправку текста через `relay_message`. `client_tools` пуст; готового общего исполнителя инструментов нет.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): интерфейс задач, событий и инструментов. Голосовые методы дополнительно проверены по схеме, сгенерированной установленным Codex CLI 0.167.1 с `--experimental`.
- [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice): голосовой разговор и делегирование задач. Доступ зависит от аккаунта, клиента и настроек рабочего пространства.
- [Вход Codex на машине без браузера](https://learn.chatgpt.com/docs/auth#login-on-headless-devices): device-code авторизация через браузер пользователя.
- [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source): отдельный маршрут интеграции подписочного доступа. Для paid/hosted-приложений действуют отдельные условия.
- [Ограничения Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): этот маршрут не поддерживает аудио/видеовход. Нельзя считать его подтверждением доступа к голосовым методам Codex.

## Matrix и голосовые участники

- [Element Call](https://github.com/element-hq/element-call): MatrixRTC, LiveKit, шифрование звонков.
- [Самостоятельное размещение Element Call](https://github.com/element-hq/element-call/blob/main/docs/self_hosting.md): LiveKit SFU и MatrixRTC authorization service.
- [Экспериментальный MatrixRTC SDK](https://raw.githubusercontent.com/element-hq/element-call/main/sdk/README.md): участие в звонке и медиадорожки без готового интерфейса, пример с шифрованием per participant.
- [MindRoom voice calls](https://github.com/mindroom-ai/mindroom/blob/main/docs/voice-calls.md): агенты присоединяются к Element Call. Голосовые варианты OpenAI используют API-ключи, подписочный Codex отдельно не подтверждён.
- [MindRoom key transport](https://raw.githubusercontent.com/mindroom-ai/mindroom/main/src/mindroom/matrix_rtc/key_transport.py) и [frame keys](https://raw.githubusercontent.com/mindroom-ai/mindroom/main/src/mindroom/matrix_rtc/frame_keys.py): код обмена ключами и их смены при изменении участников. Сквозной тест не запускался.
- [openclaw-matrix-voice](https://github.com/scottgl9/openclaw-matrix-voice): MatrixRTC/LiveKit, приём и публикация звука, объявление участника звонка. Использует отдельные STT/TTS и OpenClaw; совместимость с шифрованием нашего сервера не подтверждена.
- [matrix-voip-agent](https://github.com/AEON-7/matrix-voip-agent): пример для классических звонков Matrix; README исключает Element Call/MatrixRTC group calls.
- [meeting-transcriber](https://github.com/berget-ai/meeting-transcriber): пример присоединения к LiveKit через Matrix OpenID и JWT service, преимущественно транскрибация. В README указано отсутствие поддержки per-participant call E2EE в MVP.
- [LiveKit raw tracks](https://docs.livekit.io/transport/media/raw-tracks/): получение аудиокадров и публикация собственной дорожки.
- [LiveKit E2EE with agents](https://docs.livekit.io/transport/encryption/agents/): для шифрованного звука агенту нужны ключи; Matrix per-participant key exchange не заменяется одним общим ключом из примера LiveKit.

## Инструменты разработки

- `node --version`: `v26.13.0` на Windows-компьютере разработки.
- `npm --version`: `11.20.0`.
- `npm view typescript dist-tags --json`: `latest = 7.0.2`, `beta = 7.1.0-beta`, `next = 7.1.0-dev.20261111.1`.
- Запрос `typescript@7.1` без prerelease не находит стабильный выпуск; `typescript@beta` возвращает `7.1.0-beta`.
- `npm view esbuild version --json`: `0.28.2`.
- `codex login status` на Windows: вход через ChatGPT. Это не проверка доступности Voice и не авторизация VM.

В прототипе установлены точные версии TypeScript `7.1.0-beta` и esbuild `0.28.2`.

## Реальная проверка подписочного голоса

В Codex CLI 0.167.1 WebSocket realtime-транспорт требует API-ключ. Для существующего ChatGPT login заработал WebRTC с `version: "v3"`; v1 возвращал требование обновления протокола. Проверен синтетический русский речевой запрос, настоящий вызов `system_time` и ненулевой голосовой ответ после результата. Секреты аккаунта не копировались. Практические детали описаны в [архитектуре](architecture.md); это экспериментальная возможность, а не гарантия стабильности схемы.
