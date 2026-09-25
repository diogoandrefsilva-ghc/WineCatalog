@echo off
rem ====================================================================
rem  Vinhos - Vivino e lojas. Duplo clique: atualiza o codigo (git pull)
rem  e abre o painel no browser, onde se escolhe quantos vinhos, Simular
rem  ou Enriquecer, e se revem e gravam as simulacoes.
rem
rem  Tudo dentro de UM bloco ( ... ) de proposito: o cmd le um .bat aos
rem  bocados enquanto corre, e o git pull pode trocar este ficheiro a meio.
rem  Um bloco e lido inteiro antes de comecar.
rem ====================================================================
(
  chcp 65001 >nul
  title Vinhos - Vivino e lojas
  cd /d "%~dp0"

  echo A atualizar o codigo - git pull...
  git pull --ff-only || echo AVISO: o git pull falhou. Continuo com a versao que ja tens.
  echo.

  where node >nul 2>nul || (
    echo Falta o Node.js - instala-o de https://nodejs.org e volta a abrir.
    pause
    exit /b 1
  )
  if not exist ".env" (
    echo Falta o ficheiro .env nesta pasta, com a SUPABASE_SERVICE_ROLE_KEY - ver o README.md.
    pause
    exit /b 1
  )
  if not exist "node_modules\playwright" (
    echo A instalar o Playwright e o Chromium - so da primeira vez, demora um bocado...
    call npm install || (
      pause
      exit /b 1
    )
    call npx playwright install chromium
  )

  echo A abrir o painel no browser. Deixa esta janela aberta enquanto o usas.
  node painel.mjs
  pause
  exit /b
)
