#!/bin/bash
# Mac: dê dois cliques neste arquivo para abrir o app no navegador.
cd "$(dirname "$0")"
PORT=8765
if ! command -v python3 >/dev/null 2>&1; then
  osascript -e 'display dialog "É preciso instalar o Python 3 (python.org) para abrir o app localmente." buttons {"OK"}'
  exit 1
fi
python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
sleep 1
open "http://localhost:$PORT"
echo "Notas da Consulta está aberto em http://localhost:$PORT"
echo "Deixe esta janela aberta durante a reunião. Feche-a para encerrar."
wait $SERVER
