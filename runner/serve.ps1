# The job loop setup starts at every sign-in. It watches the repositories setup
# listed for a job waiting on the pr-verify-vm label, and runs each one alone in
# the machine, fresh from its clean snapshot. Each job gets a runner
# registration that works once, made here with this PC's gh sign-in, which
# never enters the machine. After the job the machine is thrown away.

. (Join-Path $PSScriptRoot 'machine.ps1')

$PollSeconds = 30
# Past the gate's and the review's own time limits, so only a hung job meets it.
$JobLimit = [TimeSpan]::FromMinutes(40)
# A registration no job takes in this time is given up: the job it was made for
# was cancelled or ran elsewhere.
$PickupLimit = [TimeSpan]::FromMinutes(5)
$KeptJobLogs = 50

function Invoke-GitHub {
    param([Parameter(Mandatory)] [string[]] $Arguments)
    $output = & gh.exe api @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "gh api $($Arguments -join ' ') failed."
    }
    $text = $output | Out-String
    if (-not $text.Trim()) {
        return $null
    }
    return $text | ConvertFrom-Json
}

# The first listed repository with a job waiting for this machine. A run whose
# first job has started is in progress while its later jobs wait.
function Find-WaitingRepository {
    param([string[]] $Repository)
    foreach ($name in $Repository) {
        foreach ($status in @('queued', 'in_progress')) {
            $runs = Invoke-GitHub @("repos/$name/actions/runs?status=$status&per_page=20")
            foreach ($run in $runs.workflow_runs) {
                $jobs = Invoke-GitHub @("repos/$name/actions/runs/$($run.id)/jobs?filter=latest&per_page=100")
                $waiting = $jobs.jobs | Where-Object { $_.status -eq 'queued' -and $_.labels -contains $RunnerLabel }
                if ($waiting) {
                    return $name
                }
            }
        }
    }
    return $null
}

function New-Registration {
    param([string] $Repository)
    $runnerName = "$MachineName-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    return Invoke-GitHub @('--method', 'POST', "repos/$Repository/actions/runners/generate-jitconfig",
        '-f', "name=$runnerName", '-F', 'runner_group_id=1', '-f', "labels[]=$RunnerLabel",
        '-f', 'work_folder=_work')
}

function Remove-Registration {
    param([string] $Repository, [long] $RunnerId)
    try {
        Invoke-GitHub @('--method', 'DELETE', "repos/$Repository/actions/runners/$RunnerId") | Out-Null
    } catch {
        # A runner that finished its job has already removed itself.
        return
    }
}

# True once the runner has taken a job. A runner that is gone has finished one.
function Test-RunnerPickedUp {
    param([string] $Repository, [long] $RunnerId)
    try {
        return [bool](Invoke-GitHub @("repos/$Repository/actions/runners/$RunnerId")).busy
    } catch {
        return $true
    }
}

function New-JobLog {
    $old = Get-ChildItem -Path $LogDirectory -Filter 'job-*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip ($KeptJobLogs - 1)
    $old | Remove-Item -Force
    return Join-Path $LogDirectory "job-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
}

# The runner inside the machine, over SSH. Start-Process takes one command line,
# so an argument with a space in it is quoted.
function Start-Runner {
    param([string] $Configuration, [string] $Log)
    $sshArguments = (Get-SshArguments) + @('runner@127.0.0.1', "~/actions-runner/run.sh --jitconfig $Configuration")
    $quoted = $sshArguments | ForEach-Object {
        if ($_ -match '\s') {
            "`"$_`""
        } else {
            $_
        }
    }
    return Start-Process ssh.exe -ArgumentList ($quoted -join ' ') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $Log -RedirectStandardError "$Log.err"
}

function Wait-Runner {
    param($Runner, [string] $Repository, [long] $RunnerId)
    $started = Get-Date
    $pickedUp = $false
    while (-not $Runner.HasExited) {
        $elapsed = (Get-Date) - $started
        if ($elapsed -gt $JobLimit) {
            Write-Log "The job in $Repository ran past $JobLimit, so its machine was stopped."
            return
        }
        if (-not $pickedUp) {
            $pickedUp = Test-RunnerPickedUp -Repository $Repository -RunnerId $RunnerId
            if (-not $pickedUp -and $elapsed -gt $PickupLimit) {
                Write-Log "No job in $Repository took the runner within $PickupLimit."
                return
            }
        }
        Start-Sleep -Seconds 15
    }
    Write-Log "The runner for $Repository finished with exit code $($Runner.ExitCode)."
}

function Invoke-Job {
    param([string] $Repository)
    Reset-Machine
    Start-Machine
    Wait-Guest
    $registration = New-Registration -Repository $Repository
    $runnerId = $registration.runner.id
    Write-Log "Runner $($registration.runner.name) registered for $Repository."
    $runner = $null
    try {
        $runner = Start-Runner -Configuration $registration.encoded_jit_config -Log (New-JobLog)
        Wait-Runner -Runner $runner -Repository $Repository -RunnerId $runnerId
    } finally {
        if ($runner -and -not $runner.HasExited) {
            $runner.Kill()
        }
        Remove-Registration -Repository $Repository -RunnerId $runnerId
        Reset-Machine
    }
}

$repositories = Get-Content -Path $RepositoryList | Where-Object { $_ }
Write-Log "The job loop started for $($repositories -join ', ')."
# A machine left running by a loop that stopped mid-job.
Reset-Machine
while ($true) {
    try {
        $repository = Find-WaitingRepository -Repository $repositories
        if ($repository) {
            Invoke-Job -Repository $repository
            continue
        }
    } catch {
        Write-Log "The job loop hit an error and carries on: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $PollSeconds
}
