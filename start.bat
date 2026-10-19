@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ====================================================
echo 🌍 正在啟動《感恩星球｜Lumi 的每日心光日記》...
echo ====================================================
if exist ".venv\Scripts\python.exe" (
    start "" http://127.0.0.1:5000
    .venv\Scripts\python.exe app.py
) else (
    echo 尚未建立虛擬環境，正在為您自動建立 .venv 並安裝套件...
    python -m venv .venv
    .venv\Scripts\pip.exe install -r requirements.txt
    start "" http://127.0.0.1:5000
    .venv\Scripts\python.exe app.py
)
pause

