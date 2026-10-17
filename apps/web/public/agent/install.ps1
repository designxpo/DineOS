# DineOS print agent installer for Windows (the billing PC).
#
# Copy the command from DineOS > Settings > Printers > Add print computer. Run it in PowerShell
# opened with "Run as administrator". It sets DINEOS_WEB, DINEOS_API and DINEOS_TOKEN, then runs:
#   irm https://<your DineOS site>/agent/install.ps1 | iex
#
# It installs Node.js 22 LTS if needed, puts the agent in C:\ProgramData\DineOS and starts it as a
# scheduled task that runs at startup (as SYSTEM) and restarts if it stops. Run it again to update.
# To remove: Unregister-ScheduledTask -TaskName 'DineOS Print Agent' -Confirm:$false

function Install-DineosAgent {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $web = $env:DINEOS_WEB
  $api = $env:DINEOS_API
  $token = $env:DINEOS_TOKEN
  if (-not $web -or -not $api -or -not ($token -like 'dv_*')) {
    Write-Host 'Copy the full command from DineOS (Settings > Printers) and run it again.' -ForegroundColor Red
    return
  }
  # The agent and its key travel over these addresses: HTTPS only (plain HTTP just for local tests).
  foreach ($url in @($web, $api)) {
    if ($url -notmatch '^https://' -and $url -notmatch '^http://(localhost|127\.0\.0\.1)([:/]|$)') {
      Write-Host "The DineOS address must start with https:// ($url)" -ForegroundColor Red
      return
    }
  }
  $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Close this window, open PowerShell with "Run as administrator", and paste the command again.' -ForegroundColor Red
    return
  }

  # Node.js 20 or later.
  $node = $null
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($found) {
    $major = [int](& $found.Source -p "process.versions.node.split('.')[0]")
    if ($major -ge 20) { $node = $found.Source }
  }
  if (-not $node) {
    Write-Host '==> Installing Node.js 22 LTS'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
    } else {
      $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
      $version = (Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1).version
      $msi = Join-Path $env:TEMP "node-$version-$arch.msi"
      Invoke-WebRequest "https://nodejs.org/dist/$version/node-$version-$arch.msi" -OutFile $msi -UseBasicParsing
      Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait
    }
    $node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (-not (Test-Path $node)) {
      Write-Host 'Node.js did not install. Install Node.js 22 LTS from https://nodejs.org and run the command again.' -ForegroundColor Red
      return
    }
  }

  $dir = Join-Path $env:ProgramData 'DineOS'
  $task = 'DineOS Print Agent'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Write-Host "==> Downloading the DineOS print agent to $dir"
  $agent = Join-Path $dir 'dineos-agent.mjs'
  $download = "$agent.new"
  Invoke-WebRequest "$web/agent/dineos-agent.mjs" -OutFile $download -UseBasicParsing
  # Install only the exact file published with the site (a damaged, cut-off or stale download is
  # refused, and the running agent is left as it was).
  $expected = ([string](Invoke-RestMethod "$web/agent/dineos-agent.mjs.sha256")).Trim().Split(' ')[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 $download).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) {
    Remove-Item $download -Force
    Write-Host 'The downloaded agent does not match its published checksum, so nothing was installed. Run the command again.' -ForegroundColor Red
    return
  }
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  Move-Item -Force $download $agent

  $config = [ordered]@{ api_url = $api; token = $token; log_file = 'agent.log' }
  if ($env:DINEOS_HUB -eq '1') { $config.hub = $true }
  $configFile = Join-Path $dir 'dineos-agent.json'
  [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json))
  # The file holds the outlet's printing key: only SYSTEM and administrators may read it.
  icacls $configFile /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null

  Write-Host '==> Starting it with Windows'
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\dineos-agent.mjs`"" -WorkingDirectory $dir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $task

  if ($config.hub) {
    # Staff phones and tablets reach the outlet hub on port 4100 while the internet is down.
    if (-not (Get-NetFirewallRule -DisplayName 'DineOS outlet hub' -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName 'DineOS outlet hub' -Direction Inbound -Protocol TCP -LocalPort 4100 -Action Allow -Profile Private, Domain | Out-Null
    }
  }

  Remove-Item Env:DINEOS_TOKEN -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host 'Done. In DineOS (Settings > Printers) this computer shows as Online within a minute; choose its printers there.' -ForegroundColor Green
  Write-Host "Log: $dir\agent.log"
}

Install-DineosAgent
