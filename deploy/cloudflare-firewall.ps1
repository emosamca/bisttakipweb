# BIST Portfoy Takip - Uygulama portlarini yalnizca Cloudflare'e acar
# Yonetici (Administrator) PowerShell'de calistirin.
#
# Kullanim:
#   .\deploy\cloudflare-firewall.ps1                 # 3000 ve 3443
#   .\deploy\cloudflare-firewall.ps1 -Ports 3443     # yalnizca belirtilen portlar
#
# Cloudflare IP listesi https://www.cloudflare.com/ips adresinden alinir;
# erisilemezse asagidaki yedek liste kullanilir. Liste nadiren degisir,
# yine de arada bir scripti yeniden calistirmak yeterli.

param(
  [int[]]$Ports = @(3000, 3443)
)

$ErrorActionPreference = "Stop"

# Yedek liste (2026-10-28 itibariyla)
$fallback = @(
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"
)

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $v4 = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 "https://www.cloudflare.com/ips-v4").Content
  $v6 = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 "https://www.cloudflare.com/ips-v6").Content
  $ranges = ($v4 + "`n" + $v6) -split "\s+" | Where-Object { $_ -match "/" }
  if ($ranges.Count -lt 10) { throw "liste beklenenden kisa" }
  Write-Host "Cloudflare IP listesi indirildi ($($ranges.Count) aralik)."
} catch {
  $ranges = $fallback
  Write-Host "Cloudflare IP listesi indirilemedi ($($_.Exception.Message)); yedek liste kullaniliyor."
}

foreach ($p in $Ports) {
  $name = "BIST Takip $p"
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort $p -RemoteAddress $ranges | Out-Null
  Write-Host "Kural guncellendi: TCP $p yalnizca Cloudflare IP'lerine acik."
}

# Windows, node.exe ilk kez port actiginda "Node.js JavaScript Runtime" gibi
# programa ozel, tum portlara ve tum IP'lere acik izin kurallari olusturabilir.
# Izin kurallari birlesir; bunlar acik kalirsa yukaridaki kisitlama ise yaramaz.
$nodeRules = Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like "*\node.exe" } |
  Get-NetFirewallRule | Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" -and $_.Enabled -eq "True" }
foreach ($r in $nodeRules) {
  Disable-NetFirewallRule -Name $r.Name
  Write-Host "Devre disi birakildi (node.exe icin genel izin): $($r.DisplayName)"
}

# Bu portlari herkese acan baska kurallar varsa uyar (otomatik dokunulmaz)
$others = Get-NetFirewallPortFilter -Protocol TCP | Where-Object {
  $lp = @($_.LocalPort)
  ($Ports | Where-Object { $lp -contains "$_" }).Count -gt 0
} | Get-NetFirewallRule | Where-Object {
  $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" -and $_.Enabled -eq "True" -and
  $_.DisplayName -notlike "BIST Takip *"
}
foreach ($r in $others) {
  Write-Host "UYARI: '$($r.DisplayName)' kurali da bu portlara izin veriyor; gerekmiyorsa kapatin:"
  Write-Host "  Disable-NetFirewallRule -DisplayName '$($r.DisplayName)'"
}

Write-Host "`nTamam. Disaridan https://<sunucu-ip>:3443 artik acilmamali; site Cloudflare uzerinden calisir."
