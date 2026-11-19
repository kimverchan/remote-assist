$ErrorActionPreference = 'Continue'

$log = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'fix-regkey.log'
function Log($m) {
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -Path $log -Value "$ts  $m" -Encoding UTF8
}

$relative = 'SOFTWARE\Classes\Directory\Background\shell\WSL'
$keyPath  = 'HKLM:\' + $relative
$admins   = New-Object System.Security.Principal.NTAccount('BUILTIN\Administrators')
$systemAc = New-Object System.Security.Principal.NTAccount('NT AUTHORITY\SYSTEM')

Log '================ start ================'
Log ("identity : " + [Security.Principal.WindowsIdentity]::GetCurrent().Name)
Log ("exists   : " + (Test-Path $keyPath))
if (-not (Test-Path $keyPath)) { Log 'nothing to do'; Log '================ end ================'; exit 0 }

# ---- step 1: take ownership (SYSTEM token has SeTakeOwnershipPrivilege enabled)
try {
    $k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(
            $relative,
            [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
            [System.Security.AccessControl.RegistryRights]::TakeOwnership)
    if ($null -eq $k) { throw 'OpenSubKey returned null' }
    $sec = $k.GetAccessControl([System.Security.AccessControl.AccessControlSections]::None)
    $sec.SetOwner($admins)
    $k.SetAccessControl($sec)
    $k.Close()
    Log 'step1 take-ownership : OK'
} catch {
    Log ("step1 take-ownership : FAIL -> " + $_.Exception.Message)
}

# ---- step 2: grant full control to Administrators and SYSTEM
try {
    $k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(
            $relative,
            [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
            [System.Security.AccessControl.RegistryRights]::ChangePermissions)
    if ($null -eq $k) { throw 'OpenSubKey returned null' }
    $sec = $k.GetAccessControl()
    $sec.SetAccessRule((New-Object System.Security.AccessControl.RegistryAccessRule(
            $admins, 'FullControl', 'ContainerInherit', 'None', 'Allow')))
    $sec.SetAccessRule((New-Object System.Security.AccessControl.RegistryAccessRule(
            $systemAc, 'FullControl', 'ContainerInherit', 'None', 'Allow')))
    $k.SetAccessControl($sec)
    $k.Close()
    Log 'step2 set-permissions : OK'
} catch {
    Log ("step2 set-permissions : FAIL -> " + $_.Exception.Message)
}

# ---- step 3: remove the damaged key so the MSI can recreate it cleanly
try {
    $parent = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(
                'SOFTWARE\Classes\Directory\Background\shell', $true)
    if ($null -eq $parent) { throw 'parent OpenSubKey returned null' }
    Log ("parent visible subkeys: " + ($parent.GetSubKeyNames() -join ', '))
    $parent.DeleteSubKeyTree('WSL', $false)
    $parent.Close()
    Log 'step3 delete-subkeytree : OK'
} catch {
    Log ("step3 delete-subkeytree : FAIL -> " + $_.Exception.Message)
}

Log ("exists after : " + (Test-Path $keyPath))
Log '================= end ================='
