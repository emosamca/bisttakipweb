<#
  Gunluk veritabani yedegi (PostgreSQL / pg_dump).

  Baglanti bilgisi depodaki .env dosyasindaki DATABASE_URL'den okunur; parola
  script icinde tutulmaz. Yedek "custom" formatta (-Fc) alinir: sikistirilmis
  ve pg_restore ile secmeli geri yuklenebilir.

  Gunde bir kez calisir ve son 14 gunun yedegi saklanir; boylece istenirse
  birkac gun oncesinin durumuna donulebilir. Daha eski dosyalar silinir.

  Elle calistirma:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup-db.ps1

  Geri yukleme (ornek):
    pg_restore --host=localhost --username=postgres --dbname=bisttakip `
               --clean --if-exists "C:\bisttakip-yedek\bisttakip_2026-09-02_2200.dump"
#>
[CmdletBinding()]
param(
  # Yedeklerin yazilacagi klasor (varsayilan: depo klasorunun yanindaki bisttakip-yedek)
  [string] $BackupDir,
  # Kac gunluk yedek saklansin (eskiler silinir). Gunde 1 yedek -> 14 gun geriye donus.
  [int]    $KeepDays = 14,
  # pg_dump.exe yolu (bos ise otomatik bulunur)
  [string] $PgDump,
  # .env dosyasinin yolu (bos ise depo kokundeki .env)
  [string] $EnvFile
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $EnvFile)   { $EnvFile   = Join-Path $repoRoot '.env' }
if (-not $BackupDir) { $BackupDir = Join-Path (Split-Path -Parent $repoRoot) 'bisttakip-yedek' }

function Write-Log {
  param([string] $Message, [string] $Level = 'BILGI')
  $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Write-Output $line
  if (Test-Path $BackupDir) { Add-Content -Path (Join-Path $BackupDir 'yedek.log') -Value $line -Encoding utf8 }
}

try {
  if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }

  # ---- 1) Baglanti bilgisini .env'den oku ----
  if (-not (Test-Path $EnvFile)) { throw ".env bulunamadi: $EnvFile" }
  $match = Select-String -Path $EnvFile -Pattern '^\s*DATABASE_URL\s*=' | Select-Object -First 1
  if (-not $match) { throw ".env icinde DATABASE_URL satiri yok: $EnvFile" }
  $raw = ($match.Line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
  $uri = [uri] $raw
  $userInfo = $uri.UserInfo -split ':', 2
  $dbUser = [uri]::UnescapeDataString($userInfo[0])
  $dbPass = ''
  if ($userInfo.Count -gt 1) { $dbPass = [uri]::UnescapeDataString($userInfo[1]) }
  $dbHost = $uri.Host
  $dbPort = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
  $dbName = $uri.AbsolutePath.TrimStart('/')
  if (-not $dbName) { throw "DATABASE_URL icinde veritabani adi yok" }

  # ---- 2) pg_dump'i bul ----
  if (-not $PgDump) {
    $cmd = Get-Command pg_dump -ErrorAction SilentlyContinue
    if ($cmd) {
      $PgDump = $cmd.Source
    } else {
      # En yuksek surumlu kurulumu sec (C:\Program Files\PostgreSQL\18\bin\pg_dump.exe)
      $candidates = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue |
        Sort-Object { [int]($_.Directory.Parent.Name) } -Descending
      if ($candidates) { $PgDump = $candidates[0].FullName }
    }
  }
  if (-not $PgDump -or -not (Test-Path $PgDump)) {
    throw "pg_dump.exe bulunamadi. -PgDump ile yolunu verin (orn: 'C:\Program Files\PostgreSQL\18\bin\pg_dump.exe')"
  }

  # ---- 3) Yedegi al ----
  $stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
  $outFile = Join-Path $BackupDir ("{0}_{1}.dump" -f $dbName, $stamp)
  Write-Log "Yedek basliyor: $dbName@${dbHost}:$dbPort -> $outFile"

  $env:PGPASSWORD = $dbPass   # parola yalnizca bu surecin ortaminda
  try {
    & $PgDump --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName `
              --format=custom --compress=9 --no-password --file=$outFile
    $code = $LASTEXITCODE
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
  if ($code -ne 0) { throw "pg_dump hata verdi (cikis kodu $code)" }
  if (-not (Test-Path $outFile)) { throw "Yedek dosyasi olusmadi: $outFile" }
  $size = (Get-Item $outFile).Length
  if ($size -lt 1024) { throw "Yedek dosyasi supheli derecede kucuk ($size bayt)" }
  Write-Log ("Yedek tamam: {0} ({1:N2} MB)" -f (Split-Path $outFile -Leaf), ($size / 1MB))

  # ---- 4) Eski yedekleri temizle ----
  $limit = (Get-Date).AddDays(-$KeepDays)
  $old = Get-ChildItem -Path $BackupDir -Filter '*.dump' | Where-Object { $_.LastWriteTime -lt $limit }
  foreach ($f in $old) {
    Remove-Item $f.FullName -Force
    Write-Log "Eski yedek silindi: $($f.Name)"
  }
  $kalan = @(Get-ChildItem -Path $BackupDir -Filter '*.dump').Count
  Write-Log "Klasorde $kalan yedek dosyasi var ($KeepDays gun saklaniyor)"
  exit 0
} catch {
  Write-Log $_.Exception.Message 'HATA'
  exit 1
}
