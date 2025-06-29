@echo off
REM Vai para a pasta do script, independente de onde for chamado
pushd %~dp0

REM Instala dependências (faça apenas na primeira execução)
echo Instalando dependências...
npm install express multer

REM Inicia o servidor
echo Iniciando o servidor...
node server.js

REM Mantém a janela aberta após o servidor subir
pause
