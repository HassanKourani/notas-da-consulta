@echo off
rem Windows: de dois cliques neste arquivo para abrir o app no navegador.
cd /d "%~dp0"
start "" http://localhost:8765
echo Notas da Consulta esta aberto em http://localhost:8765
echo Deixe esta janela aberta durante a reuniao. Feche-a para encerrar.
py -3 -m http.server 8765 --bind 127.0.0.1 || python -m http.server 8765 --bind 127.0.0.1
