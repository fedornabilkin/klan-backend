#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$SshKey = (Join-Path $env:USERPROFILE '.ssh\ablakin-bot-actions'),
    [string]$KnownHostsFile = (Join-Path $env:USERPROFILE '.ssh\ablakin-bot-known-hosts')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$project = Join-Path $root 'Project'
$config = Get-Content -LiteralPath (Join-Path $project '.local\postgres.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$envLine = @(Get-Content -LiteralPath (Join-Path $project '.env') -Encoding UTF8 |
    Where-Object { $_ -match '^\s*DEMO_DATABASE_URL\s*=' })
if ($envLine.Count -ne 1) { throw 'Expected one DEMO_DATABASE_URL in Project/.env.' }
try {
    $uri = [uri](($envLine[0] -split '=', 2)[1].Trim().Trim('"', "'"))
} catch { throw 'Invalid local database URL in Project/.env.' }
if ($uri.Scheme -notin 'postgres', 'postgresql' -or $uri.Host -notin 'localhost', '127.0.0.1' -or
    $config.host -ne '127.0.0.1' -or $uri.Port -ne $config.port -or $uri.AbsolutePath -ne '/klan_demo' -or
    $config.database -ne 'klan_demo') { throw 'Expected the configured local klan_demo database.' }
$login = $uri.UserInfo -split ':', 2
$pgArgs = @('-X', '-q', '-w', '-h', '127.0.0.1', '-p', [string]$config.port, '-U',
    [Uri]::UnescapeDataString($login[0]), '-d', 'klan_demo')
$psql = Join-Path $config.binDir 'psql.exe'
$ctl = Join-Path $config.binDir 'pg_ctl.exe'
$deploy = Join-Path $root 'Deploy'
$sql = Join-Path $deploy 'reviewed-data.sql'
$worker = Join-Path $deploy 'apply-reviewed-data.sh'
$temp = [IO.Directory]::CreateDirectory((Join-Path ([IO.Path]::GetTempPath()) ('klan-reviewed-' + [guid]::NewGuid().ToString('N')))).FullName
$copy = Join-Path $temp 'reviewed.copy'
$previousPassword = $env:PGPASSWORD
$previousEncoding = $env:PGCLIENTENCODING
try {
    if ($login.Count -eq 2) { $env:PGPASSWORD = [Uri]::UnescapeDataString($login[1]) }
    $env:PGCLIENTENCODING = 'UTF8'
    & $ctl -D $config.dataDir status *> $null
    if ($LASTEXITCODE -eq 3) {
        & $ctl -D $config.dataDir -l $config.logFile -w -t 30 start
        if ($LASTEXITCODE -ne 0) { throw 'Could not start local PostgreSQL.' }
    } elseif ($LASTEXITCODE -ne 0) { throw 'Could not identify the configured local PostgreSQL cluster.' }
    & $psql @pgArgs -v export_mode=on -o $copy -f $sql
    if ($LASTEXITCODE -ne 0 -or (Get-Item -LiteralPath $copy).Length -le 0) { throw 'Local export failed.' }
    Write-Host 'Verified klan_demo: 734 members, 192 city names, 23 teams, 1 challenge, 451 Telegram bindings.'
    if (-not $Apply) {
        Write-Host 'Local check complete. Run again with -Apply to replace production data.'
        return
    }
    if (-not (Test-Path -LiteralPath $SshKey -PathType Leaf) -or -not (Test-Path -LiteralPath $KnownHostsFile -PathType Leaf)) {
        throw 'Missing deployment SSH key or pinned known-hosts file.'
    }
    $target = 'deploy@92.63.98.81'
    $options = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=none',
        '-o', ('UserKnownHostsFile="' + $KnownHostsFile.Replace('\','/') + '"'), '-i', $SshKey)
    $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $copy).Hash.ToLowerInvariant()
    $job = & ssh.exe @options $target 'umask 077 && mktemp -d /opt/klan/backend/.reviewed.XXXXXXXX'
    if ($LASTEXITCODE -ne 0 -or $job -cnotmatch '^/opt/klan/backend/\.reviewed\.[a-zA-Z0-9]{8}$') { throw 'Could not create a private upload directory.' }
    $removeUpload = "rm -f -- $job/reviewed.copy $job/reviewed-data.sql $job/apply-reviewed-data.sh && rmdir -- $job"
    $dispatched = $false
    try {
        & scp.exe @options $copy $sql $worker "${target}:$job/"
        if ($LASTEXITCODE -ne 0) { throw 'Upload failed before import.' }
        # The remote shell owns cleanup from here, including if the client loses its connection.
        $dispatched = $true
        & ssh.exe @options $target "trap '$removeUpload' EXIT; bash $job/apply-reviewed-data.sh $digest"
        if ($LASTEXITCODE -ne 0) { throw 'Production import did not report success. Check the output above.' }
    } finally {
        if (-not $dispatched) { & ssh.exe @options $target $removeUpload }
    }
} finally {
    $env:PGPASSWORD = $previousPassword
    $env:PGCLIENTENCODING = $previousEncoding
    if (Test-Path -LiteralPath $copy) { Remove-Item -LiteralPath $copy -Force }
    [IO.Directory]::Delete($temp)
}
