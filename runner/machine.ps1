# The runner's virtual machine and how the scripts here control it: its name,
# where its files live, and starting, stopping and reaching it. Dot-sourced by
# setup.ps1 and serve.ps1.

$ErrorActionPreference = 'Stop'

$MachineName = 'pr-verify-vm'
# The label a workflow's runs-on names to run its jobs here.
$RunnerLabel = 'pr-verify-vm'
$SnapshotName = 'clean'
$TaskName = 'PR Verify runner'
# Reaches the machine's SSH server through VirtualBox's NAT, on this PC only.
$SshPort = 2222

$StateDirectory = Join-Path $env:LOCALAPPDATA 'pr-verify-vm'
$SshKey = Join-Path $StateDirectory 'ssh-key'
$KnownHosts = Join-Path $StateDirectory 'known_hosts'
$RepositoryList = Join-Path $StateDirectory 'repositories.txt'
$LogDirectory = Join-Path $StateDirectory 'logs'

# Read from the PC's settings, not this process's environment, which predates a
# VirtualBox installed since the process started.
function Get-VirtualBoxDirectory {
    $directory = [Environment]::GetEnvironmentVariable('VBOX_MSI_INSTALL_PATH', 'Machine')
    if (-not $directory) {
        $directory = Join-Path $env:ProgramFiles 'Oracle\VirtualBox'
    }
    # The installer's variable ends in a backslash, which would escape the
    # closing quote of a quoted argument.
    return $directory.TrimEnd('\')
}

function Invoke-VBoxManage {
    param([Parameter(Mandatory)] [string[]] $Arguments)
    $vboxManage = Join-Path (Get-VirtualBoxDirectory) 'VBoxManage.exe'
    $output = & $vboxManage @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "VBoxManage $($Arguments[0]) failed with exit code $LASTEXITCODE."
    }
    return $output
}

function Test-MachineExists {
    $machines = Invoke-VBoxManage @('list', 'vms')
    return [bool]($machines | Where-Object { $_ -like "`"$MachineName`" *" })
}

# One of VirtualBox's machine states, such as running or poweroff.
function Get-MachineState {
    $info = Invoke-VBoxManage @('showvminfo', $MachineName, '--machinereadable')
    $stateLine = $info | Where-Object { $_ -like 'VMState=*' }
    return $stateLine -replace '^VMState="(.*)"$', '$1'
}

function Wait-MachineState {
    param(
        [Parameter(Mandatory)] [string[]] $State,
        [Parameter(Mandatory)] [TimeSpan] $Timeout
    )
    $deadline = (Get-Date) + $Timeout
    while ((Get-MachineState) -notin $State) {
        if ((Get-Date) -gt $deadline) {
            throw "The machine did not reach $($State -join ' or ') within $Timeout."
        }
        Start-Sleep -Seconds 5
    }
}

# Cuts the power, as a job's machine is thrown away and never shut down cleanly.
function Stop-Machine {
    if ((Get-MachineState) -in @('running', 'paused', 'stuck')) {
        Invoke-VBoxManage @('controlvm', $MachineName, 'poweroff') | Out-Null
    }
    Wait-MachineState -State @('poweroff', 'aborted', 'saved') -Timeout ([TimeSpan]::FromMinutes(2))
}

# Back to the snapshot setup took, so nothing one job did reaches the next.
function Reset-Machine {
    Stop-Machine
    Invoke-VBoxManage @('snapshot', $MachineName, 'restore', $SnapshotName) | Out-Null
}

function Start-Machine {
    Invoke-VBoxManage @('startvm', $MachineName, '--type', 'headless') | Out-Null
    Set-MachinePriority
}

# Below normal, so the PC's own work comes first. VirtualBox's hardening can
# refuse this, which costs only responsiveness, so it is logged, not fatal.
function Set-MachinePriority {
    $filter = "Name = 'VBoxHeadless.exe'"
    $processes = Get-CimInstance Win32_Process -Filter $filter |
        Where-Object { $_.CommandLine -like "*$MachineName*" }
    foreach ($process in $processes) {
        try {
            (Get-Process -Id $process.ProcessId).PriorityClass = 'BelowNormal'
        } catch {
            Write-Log "Could not lower the machine's priority: $($_.Exception.Message)"
        }
    }
}

# No agent, no forwarding of any kind, and only the host key setup recorded.
function Get-SshArguments {
    param([string] $HostKeyChecking = 'yes')
    return @(
        '-i', $SshKey,
        '-p', $SshPort,
        '-o', 'IdentitiesOnly=yes',
        '-o', "UserKnownHostsFile=$KnownHosts",
        '-o', "StrictHostKeyChecking=$HostKeyChecking",
        '-o', 'ForwardAgent=no',
        '-o', 'ForwardX11=no',
        '-o', 'ClearAllForwardings=yes',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        '-o', 'LogLevel=ERROR'
    )
}

function Invoke-Guest {
    param(
        [Parameter(Mandatory)] [string] $Command,
        [string] $HostKeyChecking = 'yes'
    )
    $sshArguments = Get-SshArguments -HostKeyChecking $HostKeyChecking
    & ssh.exe @sshArguments 'runner@127.0.0.1' $Command | Out-Host
    return $LASTEXITCODE
}

function Wait-Guest {
    param(
        [TimeSpan] $Timeout = [TimeSpan]::FromMinutes(3),
        [string] $HostKeyChecking = 'yes'
    )
    $deadline = (Get-Date) + $Timeout
    while ((Invoke-Guest -Command 'true' -HostKeyChecking $HostKeyChecking) -ne 0) {
        if ((Get-Date) -gt $deadline) {
            throw "The machine's SSH server did not answer within $Timeout."
        }
        Start-Sleep -Seconds 5
    }
}

function Write-Log {
    param([Parameter(Mandatory)] [string] $Message)
    New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
    $line = "$(Get-Date -Format 's') $Message"
    Add-Content -Path (Join-Path $LogDirectory 'runner.log') -Value $line -Encoding utf8
    Write-Host $line
}
