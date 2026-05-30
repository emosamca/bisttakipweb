# BIST Portfoy Takip - Windows Servis Kurulum Scripti (NSSM ile)
# Yonetici (Administrator) PowerShell'de calistirin.
#
# Kullanim:
#   1) Bu klasoru sunucuya kopyalayin (orn. C:\bist-takip)
#   2) NSSM indirin: https://nssm.cc/download  -> nssm.exe'yi PATH'e veya bu klasore koyun
#   3) Yonetici PowerShell:  .\deploy\install-service.ps1

param(
  [string]$ServiceName = "BistTakip",
  [string]$AppDir      = "$PSScriptRoot\..",
  [string]$NodeExe     = "C:\Program Files\nodejs\node.exe",
  [int]   $Port        = 3000
)

$ErrorActionPreference = "Stop"
$AppDir = (Resolve-Path $AppDir).Path
$server = Join-Path $AppDir "server.js"

Write-Host "Servis adi : $ServiceName"
Write-Host "Uygulama   : $server"
Write-Host "Node       : $NodeExe"
Write-Host "Port       : $Port"

# nssm bulunuyor mu?
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { $nssm = Join-Path $AppDir "nssm.exe" }
if (-not (Test-Path $nssm)) {
  throw "nssm.exe bulunamadi. https://nssm.cc/download adresinden indirip PATH'e veya '$AppDir' klasorune koyun."
}
if (-not (Test-Path $NodeExe)) { throw "node.exe bulunamadi: $NodeExe (Node.js kurulu mu?)" }

# Bagimliliklar
Write-Host "`nnpm install --omit=dev ..."
Push-Location $AppDir
& "$($NodeExe | Split-Path)\npm.cmd" install --omit=dev
Pop-Location

# Log klasoru
$logDir = Join-Path $AppDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Varsa eski servisi kaldir (yoksa dokunma; nssm stderr'ini YONLENDIRME)
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Mevcut '$ServiceName' servisi bulundu, kaldiriliyor..."
  & $nssm stop $ServiceName | Out-Null
  & $nssm remove $ServiceName confirm | Out-Null
  Start-Sleep -Seconds 1
} else {
  Write-Host "Onceki servis yok, yeni kurulum yapilacak."
}

# Servisi kur
& $nssm install $ServiceName $NodeExe "$server"
& $nssm set $ServiceName AppDirectory $AppDir
& $nssm set $ServiceName AppStdout (Join-Path $logDir "out.log")
& $nssm set $ServiceName AppStderr (Join-Path $logDir "err.log")
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 5242880
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName AppEnvironmentExtra "PORT=$Port"
& $nssm set $ServiceName DisplayName "BIST Portfoy Takip"
& $nssm set $ServiceName Description "BIST hisse portfoy takip web uygulamasi"

# Firewall (gelen baglanti) kurali
if (-not (Get-NetFirewallRule -DisplayName "BIST Takip $Port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "BIST Takip $Port" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
  Write-Host "Firewall kurali eklendi (TCP $Port)."
}

& $nssm start $ServiceName
Write-Host "`nKurulum tamam. Test: http://$(hostname):$Port  veya  http://<sunucu-ip>:$Port"
Write-Host "Loglar: $logDir"
