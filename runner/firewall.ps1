# Blocks the runner's virtual machine from the local network and from this PC's
# own services, leaving it the internet a job needs. VirtualBox's NAT makes the
# machine's connections from VirtualBox's own process, so a Windows Firewall
# rule on that program covers everything the machine sends. Setup runs this
# with administrator rights, the only step that needs them.
param([Parameter(Mandatory)] [string] $VirtualBoxDirectory)

$ErrorActionPreference = 'Stop'

$ruleGroup = 'PR Verify runner'
# Private, link-local and carrier-grade NAT ranges: the home network, the
# router, VPNs such as Tailscale, and this PC's own addresses on them.
$localRanges = @(
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16',
    '100.64.0.0/10',
    'fc00::/7',
    'fe80::/10'
)

# A rule does nothing while the firewall is off, so setup stops instead.
$disabledProfiles = Get-NetFirewallProfile | Where-Object { -not $_.Enabled }
if ($disabledProfiles) {
    throw "Windows Firewall is off for the $($disabledProfiles.Name -join ', ') profile. Turn it on so the machine's rules apply."
}

Get-NetFirewallRule -Group $ruleGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
# A headless machine runs in VBoxHeadless.exe; one opened in VirtualBox's window
# runs in VirtualBoxVM.exe.
foreach ($program in @('VBoxHeadless.exe', 'VirtualBoxVM.exe')) {
    $rule = @{
        DisplayName   = "PR Verify runner: no local network for $program"
        Group         = $ruleGroup
        Direction     = 'Outbound'
        Action        = 'Block'
        Program       = Join-Path $VirtualBoxDirectory $program
        RemoteAddress = $localRanges
    }
    New-NetFirewallRule @rule | Out-Null
}
