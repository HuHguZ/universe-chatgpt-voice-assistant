# Synthetic Russian speech

Four fixed test prompts, generated offline with Windows SAPI Microsoft Irina,
stored as gzip-compressed PCM16 mono 48 kHz WAV. These are synthetic fixtures,
not recordings of a user's microphone. All platforms read the same audio;
no local speech synthesizer is needed to run a smoke check.

| File | Spoken request |
| --- | --- |
| `request.wav.gz` | Который сейчас час? Проверь точное время на этом компьютере с помощью инструмента. |
| `command.wav.gz` | Проверь установленную версию Node.js на этом компьютере с помощью инструмента и скажи результат. |
| `memory.wav.gz` | Проверь на этом компьютере, сколько установлено оперативной памяти и сколько сейчас свободно. Используй реальные системные команды и скажи результат. |
| `hangup.wav.gz` | Пожалуйста, заверши текущий голосовой звонок. Выйди из звонка. |

`scripts/test-speech.ps1` is an optional Windows-only regeneration tool.
`scripts/test-audio.ts` decompresses fixtures into ignored `runtime/` files.
