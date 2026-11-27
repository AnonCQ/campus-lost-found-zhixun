# 一键启动本地课程设计系统（FastAPI 8000 + Vite 5173）
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"

$PythonExe = "D:\DevTools\Anaconda3\envs\yolov11\python.exe"
if (-not (Test-Path $PythonExe)) {
    $PythonExe = "python"
}

Write-Host "[1/2] 正在启动 FastAPI 后端 (http://127.0.0.1:8088) ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:HTTP_PROXY='http://127.0.0.1:7890'; `$env:HTTPS_PROXY='http://127.0.0.1:7890'; & '$PythonExe' -m uvicorn backend.main:app --host 127.0.0.1 --port 8088 --reload"

Write-Host "[2/2] 正在启动 Vite 前端 (http://127.0.0.1:5173) ..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "npm run dev"

Write-Host "启动指令已发送！请等待几秒后访问 http://127.0.0.1:5173 或 http://127.0.0.1:8088/docs" -ForegroundColor Yellow
