$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$python = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
if (-not (Test-Path $python)) {
    throw "Не найден Python 3.12. Установите его для пользователя, без WSL."
}
if (-not (Test-Path ".\.venv\Scripts\python.exe")) {
    & $python -m venv .venv
}
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
& .\.venv\Scripts\python.exe -m app
