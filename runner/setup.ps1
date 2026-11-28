<#
.SYNOPSIS
Builds the virtual machine that runs PR Verify's jobs on this PC, and starts the
loop that gives it one job at a time.

.DESCRIPTION
Builds everything from nothing on every run, so the same command works after
the PC is wiped: VirtualBox if it is missing, the firewall rule, Ubuntu's
installer image, the machine, and the clean snapshot each job starts from. The
machine shares nothing with this PC: no folders, clipboard, drag and drop or
VirtualBox guest software, and no network but the internet. Installing
VirtualBox and adding the firewall rule ask for administrator rights, together
in one prompt; nothing else runs elevated.

.PARAMETER Repository
The repositories, as owner/name, whose jobs labeled pr-verify-vm run here.

.PARAMETER NetworkLimit
The machine's network speed, and the installer image's download speed, where
M is megabytes a second.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string[]] $Repository,
    [int] $Cpus = 0,
    [int] $MemoryMB = 0,
    [string] $NetworkLimit = '5M'
)

. (Join-Path $PSScriptRoot 'machine.ps1')

function Assert-Prerequisite {
    foreach ($tool in @('ssh.exe', 'ssh-keygen.exe', 'curl.exe', 'gh.exe', 'winget.exe')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw "Setup needs $tool on PATH."
        }
    }
    & gh.exe auth status | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Setup needs gh signed in: the job loop registers a runner with it for every job.'
    }
    foreach ($name in $Repository) {
        if ($name -notmatch '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$') {
            throw "'$name' is not a repository written as owner/name."
        }
    }
}

function Invoke-AdministratorStep {
    $adminScript = Join-Path $PSScriptRoot 'admin.ps1'
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$adminScript`""
    $elevated = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
        -ArgumentList $arguments
    if ($elevated.ExitCode -ne 0) {
        throw "The administrator step failed, so the machine is not built. Its error is in $(Join-Path $LogDirectory 'runner.log')."
    }
}

function Assert-VirtualBoxVersion {
    # 7.1 is the first to install Ubuntu 24.04 unattended.
    $version = (Invoke-VBoxManage @('--version')) -replace '^(\d+\.\d+).*$', '$1'
    if ([version]$version -lt [version]'7.1') {
        throw "VirtualBox $version is installed; setup needs 7.1 or later."
    }
}

function Remove-PreviousRunner {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    if (Test-MachineExists) {
        Stop-Machine
        Invoke-VBoxManage @('unregistervm', $MachineName, '--delete') | Out-Null
    }
    $leftovers = @($SshKey, "$SshKey.pub", $KnownHosts, (Join-Path $StateDirectory 'machine'))
    Remove-Item -Recurse -Force -Path $leftovers -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
}

# The newest 24.04 server image, checked against the SHA-256 Ubuntu publishes,
# and downloaded only when the copy here is missing or stale.
function Get-UbuntuInstaller {
    $release = 'https://releases.ubuntu.com/24.04'
    $sums = & curl.exe -fsSL "$release/SHA256SUMS"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not read $release/SHA256SUMS."
    }
    $pattern = '^([0-9a-f]{64}) \*?(ubuntu-(24\.04[.0-9]*)-live-server-amd64\.iso)$'
    $images = $sums | Select-String -Pattern $pattern | ForEach-Object { $_.Matches[0] }
    if (-not $images) {
        throw "Ubuntu's SHA256SUMS names no 24.04 server image."
    }
    # The list holds every point release still published, oldest first.
    $newest = $images | Sort-Object { [version]$_.Groups[3].Value } | Select-Object -Last 1
    $expectedHash = $newest.Groups[1].Value
    $installer = Join-Path $StateDirectory $newest.Groups[2].Value
    if ((Test-Path $installer) -and (Get-FileHash $installer -Algorithm SHA256).Hash -eq $expectedHash) {
        return $installer
    }
    $partial = "$installer.partial"
    & curl.exe --fail --location --continue-at - --limit-rate $NetworkLimit `
        --output $partial "$release/$(Split-Path $installer -Leaf)"
    if ($LASTEXITCODE -ne 0) {
        throw 'Downloading the Ubuntu installer image failed.'
    }
    if ((Get-FileHash $partial -Algorithm SHA256).Hash -ne $expectedHash) {
        Remove-Item -Force $partial
        throw "The installer image's SHA-256 does not match the one Ubuntu publishes."
    }
    Move-Item -Force $partial $installer
    return $installer
}

function New-SshKey {
    # A raw command line, since Windows PowerShell drops the empty argument that
    # tells ssh-keygen the key has no passphrase.
    $arguments = "-q -t ed25519 -N `"`" -C $MachineName -f `"$SshKey`""
    $keygen = Start-Process ssh-keygen.exe -ArgumentList $arguments -Wait -PassThru -NoNewWindow
    if ($keygen.ExitCode -ne 0) {
        throw 'Creating the SSH key failed.'
    }
    return (Get-Content "$SshKey.pub" -Raw).Trim()
}

function Get-DefaultCpuCount {
    $logical = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
    return [Math]::Max(2, [Math]::Min(4, [Math]::Floor($logical / 2)))
}

function Get-DefaultMemoryMB {
    $totalMB = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB
    return [Math]::Max(4096, [Math]::Min(8192, [Math]::Floor($totalMB / 4)))
}

# Nothing shared with this PC and no devices it does not need. VirtualBox's NAT
# keeps it from this PC's loopback, and its SSH server is reachable from this
# PC only.
function New-Machine {
    $machineFolder = Join-Path $StateDirectory 'machine'
    Invoke-VBoxManage @('createvm', '--name', $MachineName, '--ostype', 'Ubuntu_64',
        '--basefolder', $machineFolder, '--register') | Out-Null
    Invoke-VBoxManage @('bandwidthctl', $MachineName, 'add', 'network',
        '--type', 'network', '--limit', $NetworkLimit) | Out-Null
    Invoke-VBoxManage @('modifyvm', $MachineName,
        '--cpus', $Cpus, '--memory', $MemoryMB, '--vram', '16', '--graphicscontroller', 'vmsvga',
        '--audio-enabled', 'off', '--usb-ohci', 'off', '--usb-ehci', 'off', '--usb-xhci', 'off',
        '--clipboard-mode', 'disabled', '--drag-and-drop', 'disabled', '--vrde', 'off',
        '--rtc-use-utc', 'on', '--boot1', 'disk', '--boot2', 'dvd', '--boot3', 'none', '--boot4', 'none',
        '--nic1', 'nat', '--nic-bandwidth-group1', 'network',
        '--nat-localhostreachable1', 'off', '--nat-dns-host-resolver1', 'on',
        '--nat-pf1', "ssh,tcp,127.0.0.1,$SshPort,,22") | Out-Null
    $disk = Join-Path $machineFolder "$MachineName\disk.vdi"
    Invoke-VBoxManage @('createmedium', 'disk', '--filename', $disk, '--size', '65536') | Out-Null
    Invoke-VBoxManage @('storagectl', $MachineName, '--name', 'SATA', '--add', 'sata',
        '--controller', 'IntelAhci', '--portcount', '2') | Out-Null
    Invoke-VBoxManage @('storageattach', $MachineName, '--storagectl', 'SATA', '--port', '0',
        '--device', '0', '--type', 'hdd', '--medium', $disk) | Out-Null
}

function Write-Utf8File {
    param([string] $Path, [string] $Text)
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

function New-RandomPassword {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes)
}

function Install-Ubuntu {
    param([string] $Installer, [string] $PublicKey)
    $template = Join-Path $StateDirectory 'user-data'
    $userData = (Get-Content (Join-Path $PSScriptRoot 'user-data') -Raw).Replace('__SSH_PUBLIC_KEY__', $PublicKey)
    Write-Utf8File $template $userData
    $passwordFile = Join-Path $StateDirectory 'password'
    Write-Utf8File $passwordFile (New-RandomPassword)
    try {
        Invoke-VBoxManage @('unattended', 'install', $MachineName, "--iso=$Installer",
            '--user=runner', "--user-password-file=$passwordFile", '--full-user-name=runner',
            '--hostname=pr-verify-vm.localdomain', '--locale=en_US', '--time-zone=UTC',
            '--no-install-additions', "--script-template=$template", '--start-vm=headless') | Out-Host
    } finally {
        Remove-Item -Force $passwordFile
    }
    Write-Log 'Installing Ubuntu, which takes about 15 minutes.'
    Wait-MachineState -State @('poweroff') -Timeout ([TimeSpan]::FromMinutes(90))
    Remove-InstallerDisc
}

function Remove-InstallerDisc {
    $info = Invoke-VBoxManage @('showvminfo', $MachineName, '--machinereadable')
    foreach ($line in $info) {
        if ($line -match '^"(.+)-(\d+)-(\d+)"="(.+\.v?iso)"$') {
            Invoke-VBoxManage @('storageattach', $MachineName, '--storagectl', $Matches[1],
                '--port', $Matches[2], '--device', $Matches[3], '--medium', 'emptydrive') | Out-Null
        }
    }
}

function Get-SemgrepImage {
    $workflow = Join-Path $PSScriptRoot '..\.github\workflows\pr-verify.yml'
    $match = Select-String -Path $workflow -Pattern '^\s*SEMGREP_IMAGE:\s*(\S+)\s*$' | Select-Object -First 1
    return $match.Matches[0].Groups[1].Value
}

function Initialize-Guest {
    Start-Machine
    # Installed moments ago and has run nothing else, so its host key is
    # recorded on first contact; every later connection requires that key.
    Wait-Guest -Timeout ([TimeSpan]::FromMinutes(5)) -HostKeyChecking 'accept-new'
    $provision = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'provision.sh')))
    if ((Invoke-Guest -Command "echo $provision | base64 -d > /tmp/provision.sh") -ne 0) {
        throw 'Copying the provisioning script into the machine failed.'
    }
    $semgrepImage = Get-SemgrepImage
    if ((Invoke-Guest -Command "sudo bash /tmp/provision.sh '$semgrepImage' && rm /tmp/provision.sh") -ne 0) {
        throw 'Provisioning the machine failed.'
    }
    Test-MachineIsolation
    Invoke-Guest -Command 'sudo systemctl poweroff' | Out-Null
    Wait-MachineState -State @('poweroff') -Timeout ([TimeSpan]::FromMinutes(2))
    Invoke-VBoxManage @('snapshot', $MachineName, 'take', $SnapshotName,
        '--description', 'Provisioned. Every job starts from here.') | Out-Null
}

# Proves the rules hold before any job runs: the machine reaches GitHub, but
# not this PC, through VirtualBox's NAT or the network, and not the router.
function Test-MachineIsolation {
    if ((Invoke-Guest -Command 'curl -fsS --max-time 20 -o /dev/null https://api.github.com') -ne 0) {
        throw 'The machine cannot reach GitHub.'
    }
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1
    $address = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex | Select-Object -First 1
    $blocked = @("10.0.2.2:$SshPort", "$($address.IPAddress):445", "$($address.IPAddress):135",
        "$($route.NextHop):53", "$($route.NextHop):80")
    foreach ($target in $blocked) {
        $targetHost, $targetPort = $target -split ':'
        if ((Invoke-Guest -Command "timeout 5 bash -c '</dev/tcp/$targetHost/$targetPort'") -eq 0) {
            throw "The machine reached $target, which it must not."
        }
    }
}

# The loop runs from a copy, so it keeps running what setup installed whatever
# branch this checkout moves to.
function Register-JobLoop {
    $installed = Join-Path $StateDirectory 'scripts'
    New-Item -ItemType Directory -Force -Path $installed | Out-Null
    Copy-Item -Force -Destination $installed -Path @(
        (Join-Path $PSScriptRoot 'machine.ps1'),
        (Join-Path $PSScriptRoot 'serve.ps1'))
    Set-Content -Path $RepositoryList -Value $Repository -Encoding utf8
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $serve = Join-Path $installed 'serve.ps1'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$serve`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
}

Assert-Prerequisite
Invoke-AdministratorStep
Assert-VirtualBoxVersion
if ($Cpus -eq 0) {
    $Cpus = Get-DefaultCpuCount
}
if ($MemoryMB -eq 0) {
    $MemoryMB = Get-DefaultMemoryMB
}
Remove-PreviousRunner
$installer = Get-UbuntuInstaller
$publicKey = New-SshKey
New-Machine
Install-Ubuntu -Installer $installer -PublicKey $publicKey
Initialize-Guest
Register-JobLoop
Write-Log "Ready: jobs labeled $RunnerLabel in $($Repository -join ', ') run here, one at a time."
