# Corre las seis corridas del protocolo contra la branch de evaluación.
# Toma DATABASE_URL de backend/.env.eval (sin mostrarla); el resto, de .env.
# Uso, desde backend/:  powershell -File scripts/eval/correr-todo.ps1 [-SoloVerificar]
param([switch]$SoloVerificar)
$ErrorActionPreference = "Stop"
$linea = Get-Content .env.eval | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
if (-not $linea) { throw "Falta DATABASE_URL en .env.eval" }
$env:DATABASE_URL = ($linea -replace '^\s*DATABASE_URL\s*=\s*', '') -replace '^"|"$', ''
$env:EVAL_BRANCH_OK = "1"
# Node escribe advertencias en stderr; con "Stop", PowerShell 5.1 las trataría
# como errores y cortaría el ciclo después de la primera corrida.
$ErrorActionPreference = "Continue"

if ($SoloVerificar) {
  npx tsx scripts/eval/verificar-branch.ts
  exit $LASTEXITCODE
}
foreach ($modelo in "gemini-3.1-flash-lite", "gemini-3.5-flash-lite") {
  foreach ($corrida in 1, 2, 3) {
    # Dos pasadas: la segunda reintenta los mensajes que fallaron (429/503).
    foreach ($pasada in 1, 2) {
      npx tsx scripts/eval/evaluar.ts --modelo $modelo --corrida $corrida --pausa 4500
    }
  }
}
