@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo Трекер тренировок
echo На этом компьютере: http://localhost:8080
echo.
echo На айфоне в той же сети Wi-Fi откройте адрес:
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | ForEach-Object { 'http://' + $_.IPAddress + ':8080' }"
echo.
echo Чтобы закрыть трекер, закройте это окно.
echo.
python -m http.server 8080 --bind 0.0.0.0
if errorlevel 1 py -m http.server 8080 --bind 0.0.0.0
