param([switch]$NodeVersion, [switch]$Memory, [switch]$Hangup)
Add-Type -AssemblyName System.Speech
$speechDirectory = Join-Path $PSScriptRoot '..\runtime'
New-Item -ItemType Directory -Path $speechDirectory -Force | Out-Null
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $speech.SelectVoice('Microsoft Irina Desktop')
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $speechFile = if ($Hangup) { 'test-hangup.wav' } elseif ($Memory) { 'test-memory.wav' } elseif ($NodeVersion) { 'test-command.wav' } else { 'test-request.wav' }
    $speechText = if ($Hangup) { 'Пожалуйста, заверши текущий голосовой звонок. Выйди из звонка.' } elseif ($Memory) { 'Проверь на этом компьютере, сколько установлено оперативной памяти и сколько сейчас свободно. Используй реальные системные команды и скажи результат.' } elseif ($NodeVersion) { 'Проверь установленную версию Node.js на этом компьютере с помощью инструмента и скажи результат.' } else { 'Который сейчас час? Проверь точное время на этом компьютере с помощью инструмента.' }
    $speech.SetOutputToWaveFile((Join-Path $speechDirectory $speechFile), $format)
    $speech.Speak($speechText)
} finally {
    $speech.Dispose()
}
