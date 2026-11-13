<#
Sets up, or updates, the Media Service on Windows with Docker Desktop, from a clone of the
repository. Right-click this file > Run with PowerShell, or from PowerShell in this folder (Windows
refuses to run scripts by default; -ExecutionPolicy Bypass lifts that for this one run, as Run with
PowerShell does):

  powershell -ExecutionPolicy Bypass -File .\install-windows.ps1     first install; after a pull, the update
    ... -PublicUrl https://example.com/ffmpeg      the address clients use
    ... -Models fast,balanced                      whisper models: fast, balanced, accurate, none

install.sh does this on a Linux server. Here Docker Desktop runs the containers, with these
differences: the database, Redis and the files live in Docker volumes (Postgres refuses a Windows
folder), and there is no egress firewall (the service's own guard still refuses private addresses).
Everything else stays in this folder: .env (back it up: it holds the encryption key), the models,
the nightly database backups and the release history. DEPLOY-QUICKSTART.md, "Windows".

Written for Windows PowerShell 5.1 and PowerShell 7, in ASCII: 5.1 reads a file without a byte
order mark in the system code page.
#>
[CmdletBinding()]
param(
    # The address clients use, http(s)://host[:port][/path]; a path when a reverse proxy serves
    # the service under one. First install default: http://127.0.0.1:<HttpPort>.
    [string]$PublicUrl,
    # Whisper models for transcription: any of fast, balanced, accurate, or none.
    # First install default: all three (about 920 MB).
    [string[]]$Models,
    # The release to run, a git SHA. Default: the commit this clone has checked out.
    [string]$Version,
    # The bundled proxy's port on this PC (first install; default 8085).
    [int]$HttpPort = 0,
    # Docker Compose project name (first install; default media). Volumes are named after it.
    [string]$ProjectName,
    # Don't wait for Enter at the end (for scripts; Run with PowerShell closes the window).
    [switch]$NoPause
)

$script:Here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$script:Utf8 = New-Object System.Text.UTF8Encoding $false
$script:Image = 'ghcr.io/bytebunch/media-service'
$script:ContainerModels = '/models'

function Write-Step([string]$Text) { [Console]::Out.WriteLine("==> $Text") }
function Write-Note([string]$Text) { [Console]::Out.WriteLine($Text) }

# --- .env --------------------------------------------------------------------------------------

# The value of KEY in .env text, or $null when there is no such line.
function Get-EnvValue([string]$Text, [string]$Key) {
    foreach ($line in ($Text -split "`n")) {
        if ($line.StartsWith("$Key=")) { return $line.Substring($Key.Length + 1).TrimEnd("`r") }
    }
    return $null
}

# .env text with KEY set to VALUE: the first KEY= line replaced (later duplicates dropped), or the
# line appended. The value is taken literally; line endings are kept as they are.
function Edit-EnvText([string]$Text, [string]$Key, [string]$Value) {
    $lines = New-Object System.Collections.Generic.List[string]
    $found = $false
    foreach ($line in ($Text -split "`n")) {
        if ($line.StartsWith("$Key=")) {
            if ($found) { continue }
            $found = $true
            $ending = if ($line.EndsWith("`r")) { "`r" } else { '' }
            $lines.Add("$Key=$Value$ending")
        } else {
            $lines.Add($line)
        }
    }
    $result = $lines -join "`n"
    if (-not $found) {
        if ($result.Length -gt 0 -and -not $result.EndsWith("`n")) { $result += "`n" }
        $result += "$Key=$Value`n"
    }
    return $result
}

function Get-RandomByte([int]$Count) {
    $bytes = New-Object byte[] $Count
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return , $bytes
}

function Get-RandomHex([int]$Count) {
    return -join ((Get-RandomByte $Count) | ForEach-Object { $_.ToString('x2') })
}

function Get-RandomBase64([int]$Count) { return [Convert]::ToBase64String((Get-RandomByte $Count)) }

# The values install.sh writes on a first install, plus the Docker volumes Windows needs.
function Get-FirstEnvValue([string]$Url, [int]$Port, [string]$Project) {
    $password = Get-RandomHex 24          # hex: it goes inside DATABASE_URL
    return [ordered]@{
        COMPOSE_PROJECT_NAME  = $Project
        COMPOSE_PROFILES      = 'local-db,local-redis,proxy'
        MEDIA_IMAGE           = $script:Image
        MEDIA_FILES_PATH      = 'media-files'
        PGDATA_PATH           = 'media-pgdata'
        REDIS_DATA_PATH       = 'media-redis'
        HTTP_PORT             = [string]$Port
        HTTP_BIND             = '127.0.0.1'
        PUBLIC_BASE_URL       = $Url
        POSTGRES_USER         = 'ytdlp_app'
        POSTGRES_DB           = 'media'
        POSTGRES_PASSWORD     = $password
        DATABASE_URL          = "postgres://ytdlp_app:$password@postgres:5432/media"
        REDIS_URL             = 'redis://redis:6379'
        LINK_SIGNING_SECRET   = Get-RandomBase64 32
        TOKEN_ENCRYPTION_KEYS = 'v1:' + (Get-RandomBase64 32)
    }
}

# The Docker volumes .env names: Postgres refuses a data folder on a Windows drive, and files are
# much faster inside Docker's own disk. Local changes go in this file too, so it's never replaced.
$script:OverrideText = @'
# Windows (install-windows.ps1): the database, Redis and downloaded files in Docker volumes.
# Postgres refuses a Windows folder. Add your own local changes below.
volumes:
  media-files:
  media-pgdata:
  media-redis:
'@

# A public address as the service accepts it: http(s), host, optional port and path, nothing else.
function Test-PublicUrl([string]$Url) {
    $parsed = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$parsed)) { return $false }
    if ($parsed.Scheme -ne 'http' -and $parsed.Scheme -ne 'https') { return $false }
    return ($parsed.Query -eq '' -and $parsed.Fragment -eq '' -and $parsed.UserInfo -eq '')
}

# --- The release ---------------------------------------------------------------------------------

# The commit this folder's git clone has checked out, read from .git itself, so git needn't be
# installed (GitHub Desktop doesn't put it on PATH). $null outside a clone.
function Get-CheckoutSha([string]$Start) {
    $dir = $Start
    while ($dir) {
        $git = Join-Path $dir '.git'
        if (Test-Path -LiteralPath $git -PathType Container) { break }
        if (Test-Path -LiteralPath $git -PathType Leaf) {
            # A worktree: .git is a file naming the real git directory.
            $pointer = ([IO.File]::ReadAllText($git)).Trim()
            if ($pointer -notmatch '^gitdir:\s*(.+)$') { return $null }
            $git = $Matches[1]
            if (-not [IO.Path]::IsPathRooted($git)) { $git = Join-Path $dir $git }
            break
        }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { return $null }
        $dir = $parent
    }
    if (-not $dir) { return $null }
    $headFile = Join-Path $git 'HEAD'
    if (-not (Test-Path -LiteralPath $headFile)) { return $null }
    $head = ([IO.File]::ReadAllText($headFile)).Trim()
    if ($head -match '^[0-9a-f]{40}$') { return $head }
    if ($head -notmatch '^ref:\s*(\S+)$') { return $null }
    $ref = $Matches[1]
    $refFile = Join-Path $git ($ref -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (Test-Path -LiteralPath $refFile) {
        $sha = ([IO.File]::ReadAllText($refFile)).Trim()
        if ($sha -match '^[0-9a-f]{40}$') { return $sha }
    }
    $packed = Join-Path $git 'packed-refs'
    if (Test-Path -LiteralPath $packed) {
        foreach ($line in [IO.File]::ReadAllLines($packed)) {
            if ($line -match "^([0-9a-f]{40}) $([regex]::Escape($ref))$") { return $Matches[1] }
        }
    }
    return $null
}

# --- Whisper models ------------------------------------------------------------------------------

# models.sh's catalog (name, repository, file, size, SHA-256): one list for Linux and Windows.
function Get-ModelCatalog([string]$ModelsScript) {
    $text = [IO.File]::ReadAllText($ModelsScript)
    if ($text -notmatch "(?s)CATALOG='(.*?)'") { throw "No model catalog in $ModelsScript." }
    $catalog = @()
    foreach ($line in ($Matches[1] -split "`n")) {
        $parts = $line.Trim() -split '\|'
        if ($parts.Count -ne 5) { continue }
        $catalog += [pscustomobject]@{
            Name = $parts[0]; Repo = $parts[1]; File = $parts[2]; Bytes = [long]$parts[3]; Sha = $parts[4]
        }
    }
    return $catalog
}

# The FFMPEG_WHISPER_* values for these models, as `models.sh env` writes them: the last named is
# the default; none or nothing turns transcription off. `powershell -File` passes -Models a,b as the
# one string 'a,b', so names are split on commas here.
function Get-ModelEnvValue($Catalog, [string[]]$Names) {
    $chosen = @($Names | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -ne 'none' })
    if ($chosen.Count -eq 0) {
        return [ordered]@{ FFMPEG_WHISPER_MODELS = ''; FFMPEG_WHISPER_DEFAULT_MODEL = ''; FFMPEG_WHISPER_VAD_MODEL = '' }
    }
    $pairs = foreach ($name in $chosen) {
        $entry = $Catalog | Where-Object { $_.Name -eq $name -and $_.Name -ne 'vad' }
        if (-not $entry) { throw "Unknown model '$name' (fast, balanced, accurate, none)." }
        '"' + $name + '":"' + $script:ContainerModels + '/' + $entry.File + '"'
    }
    $vad = $Catalog | Where-Object { $_.Name -eq 'vad' }
    return [ordered]@{
        FFMPEG_WHISPER_MODELS        = "'{" + ($pairs -join ',') + "}'"
        FFMPEG_WHISPER_DEFAULT_MODEL = $chosen[-1]
        FFMPEG_WHISPER_VAD_MODEL     = "$($script:ContainerModels)/$($vad.File)"
    }
}

# The model files .env refers to, from the catalog.
function Get-ReferencedModel([string]$EnvText, $Catalog) {
    $wanted = @()
    foreach ($key in 'FFMPEG_WHISPER_MODELS', 'FFMPEG_WHISPER_VAD_MODEL') {
        $value = Get-EnvValue $EnvText $key
        if (-not $value) { continue }
        foreach ($match in [regex]::Matches($value, "$([regex]::Escape($script:ContainerModels))/([A-Za-z0-9._-]+)")) {
            $file = $match.Groups[1].Value
            $entry = $Catalog | Where-Object { $_.File -eq $file }
            if (-not $entry) { throw "$file in .env is not in the model catalog (models.sh)." }
            if (-not ($wanted | Where-Object { $_.File -eq $file })) { $wanted += $entry }
        }
    }
    return $wanted
}

# Downloads each model that's missing or the wrong size, checking its SHA-256.
function Sync-WhisperModel($Entries, [string]$Folder) {
    New-Item -ItemType Directory -Force -Path $Folder | Out-Null
    foreach ($entry in $Entries) {
        $target = Join-Path $Folder $entry.File
        if ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).Length -eq $entry.Bytes) {
            Write-Note "ok    $($entry.File)"
            continue
        }
        $part = "$target.part"
        Write-Note ("fetch {0} ({1} MB)" -f $entry.File, [math]::Round($entry.Bytes / 1MB))
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'   # Windows PowerShell's progress bar slows downloads to a crawl
        Invoke-WebRequest -UseBasicParsing -Uri "https://huggingface.co/$($entry.Repo)/resolve/main/$($entry.File)" -OutFile $part
        $sha = (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($sha -ne $entry.Sha) {
            Remove-Item -LiteralPath $part -Force
            throw "$($entry.File): SHA-256 does not match the pinned value."
        }
        Move-Item -LiteralPath $part -Destination $target -Force
        Write-Note "ok    $($entry.File)"
    }
}

# --- Docker ----------------------------------------------------------------------------------------

# Runs docker; returns its exit code and output. Continue, because Windows PowerShell turns a
# native command's stderr into an exception under Stop.
function Invoke-Docker([string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $output = & docker @Arguments 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($output -join "`n").Trim() }
}

function Invoke-Compose([string[]]$Arguments) {
    return Invoke-Docker (@('compose', '--project-directory', $script:Here) + $Arguments)
}

function Get-LastLine([string]$Text) {
    $lines = @($Text -split "`n" | Where-Object { $_.Trim() })
    if ($lines.Count -eq 0) { return '' }
    return $lines[-1].Trim()
}

# What to do about a failed pull, from Docker's last line (as install.sh does).
function Get-PullAdvice([string]$Reason, [string]$Tag) {
    if ($Reason -match 'no matching manifest|no match for platform') {
        return 'The image is built for amd64 (x64) PCs only, and Docker asked for another platform. Run this again: on an ARM PC it asks for the amd64 build, which Docker runs emulated.'
    }
    if ($Reason -match 'not found|manifest unknown') {
        return "No image is tagged $Tag. CI publishes one a few minutes after each push to main: wait and run this again, or pass -Version with a commit whose CI run finished."
    }
    if ($Reason -match 'denied|unauthorized|authentication required') {
        return "The registry refused the pull. The image is public, so an old saved login is the likely cause: in Docker Desktop, sign out of ghcr.io (or run: docker logout ghcr.io) and try again."
    }
    if ($Reason -match 'no space left') { return "Docker's disk is full: free space in Docker Desktop (Settings > Resources)." }
    return 'Check the internet connection and that Docker Desktop is running.'
}

function Confirm-DockerDesktop {
    # A missing command sets no exit code, so look for it first.
    if (-not (Get-Command -Name docker -ErrorAction SilentlyContinue)) {
        throw 'Docker Desktop is not installed (there is no docker command). Install it from docker.com, start it, then run this again.'
    }
    $version = Invoke-Docker @('version', '--format', '{{.Server.Os}}/{{.Server.Arch}}')
    if ($version.Code -ne 0) { throw 'Docker Desktop is not running. Start it, wait until it says it is running, then run this again.' }
    if ($version.Text -notmatch '^linux/') {
        throw "Docker Desktop is set to Windows containers ($($version.Text)). Switch it to Linux containers (its tray menu), then run this again."
    }
    if ($version.Text -notmatch '/amd64$') {
        Write-Note "Note: Docker reports $($version.Text). The image is built for amd64, so it runs emulated here, more slowly."
    }
    if ((Invoke-Docker @('compose', 'version')).Code -ne 0) { throw 'Docker Compose is missing: update Docker Desktop.' }
    return $version.Text
}

# The api container's health, or '' while it has none yet.
function Get-ApiHealth {
    $id = (Invoke-Compose @('ps', '-q', 'api')).Text
    if (-not $id) { return '' }
    return (Invoke-Docker @('inspect', '--format', '{{ if .State.Health }}{{ .State.Health.Status }}{{ end }}', $id)).Text
}

function Wait-ApiHealthy([int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if ((Get-ApiHealth) -eq 'healthy') { return }
        Start-Sleep -Seconds 3
    }
    throw "The API was not healthy after $Seconds s. Docker Desktop > Containers > $($script:Project) > api > Logs shows why."
}

function Request-ApiKey([string]$Client) {
    $result = Invoke-Compose @('exec', '-T', 'api', 'cli', 'keys:create', $Client, '--quiet')
    $key = Get-LastLine $result.Text
    if ($result.Code -ne 0 -or $key -notmatch '^[A-Za-z0-9_-]{20,}$') {
        throw "Could not create an API key: $(Get-LastLine $result.Text)"
    }
    return $key
}

# The API answering through the bundled proxy, from inside the stack. Retries for a while: the proxy
# looks up a recreated api container again only every few seconds.
function Test-ServiceResponse([string]$Key, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $answer = Invoke-Compose @('exec', '-T', 'proxy', 'wget', '-q', '-O', '-', '--header', "Authorization: Bearer $Key", 'http://127.0.0.1:8080/v1/presets')
        if ($answer.Code -eq 0 -and $answer.Text -match '"download_presets"') { return $true }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    return $false
}

# --- Install or update ---------------------------------------------------------------------------

function Install-MediaService {
    param([string]$PublicUrl, [string[]]$Models, [string]$Version, [int]$HttpPort, [string]$ProjectName)
    $ErrorActionPreference = 'Stop'
    $envPath = Join-Path $script:Here '.env'
    $example = Join-Path $script:Here '.env.example'
    $override = Join-Path $script:Here 'docker-compose.override.yml'
    $history = Join-Path $script:Here '.release-history'
    if (-not (Test-Path -LiteralPath $example)) {
        throw "Run this from the deploy folder of the repository: $example is missing."
    }
    if ($PublicUrl -and -not (Test-PublicUrl $PublicUrl)) {
        throw "-PublicUrl must be http(s)://host[:port][/path], without a query, # or user name: $PublicUrl"
    }

    $tag = if ($Version) { $Version } else { Get-CheckoutSha $script:Here }
    if (-not $tag) { throw 'This folder is not in a git clone, so pass the release to run: -Version <git SHA>.' }
    if ($tag -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$') { throw "-Version is not an image tag: $tag" }

    Write-Step 'Checking Docker Desktop'
    $platform = Confirm-DockerDesktop
    # The image is amd64 only: on an ARM PC, Docker runs it emulated when asked for that build.
    if ($platform -and $platform -notmatch '/amd64$') { $env:DOCKER_DEFAULT_PLATFORM = 'linux/amd64' }

    foreach ($folder in 'inbox', 'models', 'backups', 'certs') {
        New-Item -ItemType Directory -Force -Path (Join-Path $script:Here $folder) | Out-Null
    }

    $firstInstall = -not (Test-Path -LiteralPath $envPath)
    $catalog = Get-ModelCatalog (Join-Path $script:Here 'models.sh')
    if ($firstInstall) {
        Write-Step 'Writing .env with generated secrets'
        $port = if ($HttpPort -gt 0) { $HttpPort } else { 8085 }
        $url = if ($PublicUrl) { $PublicUrl } else { "http://127.0.0.1:$port" }
        $project = if ($ProjectName) { $ProjectName } else { 'media' }
        $text = [IO.File]::ReadAllText($example)
        $values = Get-FirstEnvValue $url $port $project
        $modelNames = if ($Models) { $Models } else { @('fast', 'balanced', 'accurate') }
        foreach ($pair in (Get-ModelEnvValue $catalog $modelNames).GetEnumerator()) { $values[$pair.Key] = $pair.Value }
        foreach ($pair in $values.GetEnumerator()) { $text = Edit-EnvText $text $pair.Key $pair.Value }
    } else {
        Write-Step 'Keeping .env (its secrets and settings stay as they are)'
        $text = [IO.File]::ReadAllText($envPath)
        if ($PublicUrl) { $text = Edit-EnvText $text 'PUBLIC_BASE_URL' $PublicUrl }
        if ($Models) {
            foreach ($pair in (Get-ModelEnvValue $catalog $Models).GetEnumerator()) { $text = Edit-EnvText $text $pair.Key $pair.Value }
        }
    }
    $text = Edit-EnvText $text 'IMAGE_TAG' $tag
    [IO.File]::WriteAllText($envPath, $text, $script:Utf8)
    $script:Project = Get-EnvValue $text 'COMPOSE_PROJECT_NAME'

    if (-not (Test-Path -LiteralPath $override)) {
        [IO.File]::WriteAllText($override, $script:OverrideText, $script:Utf8)
    }

    $wanted = Get-ReferencedModel $text $catalog
    if ($wanted.Count -gt 0) {
        Write-Step 'Whisper models'
        Sync-WhisperModel $wanted (Join-Path $script:Here 'models')
    }

    $config = Invoke-Compose @('config', '--quiet')
    if ($config.Code -ne 0) { throw "The configuration doesn't load: $(Get-LastLine $config.Text)" }

    Write-Step "Pulling $($script:Image):$tag (a few minutes the first time)"
    $pull = Invoke-Compose @('pull', '--quiet')
    if ($pull.Code -ne 0) {
        $reason = Get-LastLine $pull.Text
        throw "Could not pull the images: $reason`n       $(Get-PullAdvice $reason $tag)"
    }

    Write-Step 'Starting the services (database migrations run first)'
    $up = Invoke-Compose @('up', '-d', '--remove-orphans')
    if ($up.Code -ne 0) { throw "The services did not start: $(Get-LastLine $up.Text)" }

    Write-Step 'Waiting for the API to become healthy'
    Wait-ApiHealthy 300

    Write-Step 'Checking the API through the proxy'
    $smokeKey = Request-ApiKey 'installer-smoke'
    try {
        if (-not (Test-ServiceResponse $smokeKey 30)) {
            throw "The API didn't answer through the proxy. Docker Desktop > Containers > $($script:Project) > proxy > Logs shows why."
        }
    } finally {
        Invoke-Compose @('exec', '-T', 'api', 'cli', 'keys:revoke', '--key', $smokeKey) | Out-Null
    }

    $apiKey = if ($firstInstall) { Request-ApiKey 'default' } else { $null }
    [IO.File]::AppendAllText($history, "$tag`n", $script:Utf8)

    $base = Get-EnvValue $text 'PUBLIC_BASE_URL'
    Write-Step 'Done'
    Write-Note ''
    Write-Note "Media Service $tag is running"
    Write-Note ''
    Write-Note "  On this PC  http://127.0.0.1:$(Get-EnvValue $text 'HTTP_PORT')/docs"
    Write-Note "  Public      $base   (PUBLIC_BASE_URL: links are built from it)"
    if ($apiKey) { Write-Note "  API key     $apiKey   <- shown once, store it now" }
    Write-Note "  Config      $envPath   <- back it up: it holds the encryption key"
    Write-Note ''
    Write-Note 'To update: pull the repository (GitHub Desktop: Fetch origin, then Pull), then run this again.'
}

# Dot-sourcing (the tests) defines the functions without running anything.
if ($MyInvocation.InvocationName -eq '.') { return }

$exitCode = 0
# Compose looks for its files in the current folder, whatever --project-directory says.
Push-Location -LiteralPath $script:Here
try {
    Install-MediaService -PublicUrl $PublicUrl -Models $Models -Version $Version -HttpPort $HttpPort -ProjectName $ProjectName
} catch {
    [Console]::Error.WriteLine("ERROR: $($_.Exception.Message)")
    $exitCode = 1
} finally {
    Pop-Location
}
if (-not $NoPause) { Read-Host 'Press Enter to close' | Out-Null }
exit $exitCode
