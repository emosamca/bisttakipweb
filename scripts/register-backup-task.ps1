<#
  Gunluk veritabani yedegi icin Windows Gorev Zamanlayici kaydi olusturur.
  Yedek script'inin yolunu kendi konumundan bulur; elle yol yazmak gerekmez.

  YONETICI PowerShell'de, depo icinden:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-backup-task.ps1

  Ne yapacagini gormek icin (kayit yapmaz):
    ... -File .\scripts\register-backup-task.ps1 -DryRun

  Gorevi kaldirmak icin:
    Unregister-ScheduledTask -TaskName 'BistTakip DB Yedek' -Confirm:$false
#>
[CmdletBinding()]
param(
  # Gunluk calisma saati (24 saat, 'SS:dd')
  [string] $At = '22:00',
  # Gorev adi
  [string] $TaskName = 'BistTakip DB Yedek',
  # Yedek klasoru (bos ise backup-db.ps1 kendi varsayilanini kullanir)
  [string] $BackupDir,
  # Kac gunluk yedek saklansin
  [int]    $KeepDays = 14,
  # Yalnizca ne yapacagini yazar, kayit olusturmaz
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

try {
  $backupScript = Join-Path $PSScriptRoot 'backup-db.ps1'
  if (-not (Test-Path $backupScript)) { throw "backup-db.ps1 bulunamadi: $backupScript" }

  $repoRoot = Split-Path -Parent $PSScriptRoot
  $envFile = Join-Path $repoRoot '.env'
  if (-not (Test-Path $envFile)) { throw ".env bulunamadi: $envFile (script depo icinden calistirilmali)" }

  # Saat dogrulamasi ve bugunun o saatine ayarli tetikleyici zamani
  $parsed = [datetime]::MinValue
  if (-not [datetime]::TryParseExact($At, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref] $parsed)) {
    throw "Saat 'SS:dd' formatinda olmali (orn 22:00). Verilen: $At"
  }
  $triggerAt = [datetime]::Today.AddHours($parsed.Hour).AddMinutes($parsed.Minute)

  # backup-db.ps1'e gecilecek argumanlar
  $inner = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -KeepDays {1}' -f $backupScript, $KeepDays
  if ($BackupDir) { $inner += ' -BackupDir "{0}"' -f $BackupDir }

  Write-Output "Gorev adi : $TaskName"
  Write-Output "Calisma   : her gun $At"
  Write-Output "Komut     : powershell.exe $inner"
  Write-Output "Kullanici : SYSTEM (oturum acik olmasa da calisir, parola saklanmaz)"

  if ($DryRun) {
    Write-Output ''
    Write-Output 'DryRun: kayit YAPILMADI.'
    exit 0
  }

  $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) { throw 'Bu script YONETICI olarak calistirilmali (Register-ScheduledTask yonetici ister).' }

  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $inner
  $trigger = New-ScheduledTaskTrigger -Daily -At $triggerAt
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
                -ExecutionTimeLimit (New-TimeSpan -Hours 1)

  # Ayni isimde gorev varsa once kaldir (yeniden calistirilabilir olsun)
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Ayni isimli eski gorev kaldirildi."
  }

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -User 'SYSTEM' -RunLevel Highest -Description 'Gunluk PostgreSQL yedegi (bisttakip)' | Out-Null

  Write-Output ''
  Write-Output "Gorev kaydedildi. Simdi test icin:"
  Write-Output "  Start-ScheduledTask -TaskName '$TaskName'"
  Write-Output "  Get-ScheduledTaskInfo -TaskName '$TaskName' | Select-Object LastRunTime, LastTaskResult"
  Write-Output "(LastTaskResult 0 ise basarili; yedek klasorundeki yedek.log ayrintiyi gosterir.)"
  exit 0
} catch {
  Write-Output ('HATA: ' + $_.Exception.Message)
  exit 1
}
