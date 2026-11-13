# Tests for deploy/install-windows.ps1 (Pester 5): its pure parts directly, and the install and
# update flow with Docker mocked, since GitHub's Windows runners can't run Linux containers.
# Run with deploy/tests/pester.ps1, on Linux (deploy/tests/run.sh) and on Windows (CI).

BeforeDiscovery {
    $script:OnWindows = $env:OS -eq 'Windows_NT'
    $script:HaveBash = -not $script:OnWindows -and [bool](Get-Command bash -ErrorAction SilentlyContinue)
}

BeforeAll {
    $script:Deploy = Split-Path -Parent $PSScriptRoot
    . (Join-Path $script:Deploy 'install-windows.ps1')
    $script:Catalog = Get-ModelCatalog (Join-Path $script:Deploy 'models.sh')

    function Initialize-TempFolder {
        $dir = Join-Path ([IO.Path]::GetTempPath()) ("iw-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $dir | Out-Null
        return $dir
    }
    function Write-Text([string]$Path, [string]$Text) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
        [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
    }
}

Describe 'install-windows.cmd, the double-click launcher' {
    It 'has CRLF line endings in every checkout, since cmd.exe misreads a batch file without them' {
        $text = [IO.File]::ReadAllText((Join-Path $Deploy 'install-windows.cmd'))
        $text | Should -Match "`r`n"
        $text -replace "`r`n", '' | Should -Not -Match "`n"
    }

    It 'runs the script with its arguments, shows why it stopped and keeps the exit code' -Skip:(-not $OnWindows) {
        Push-Location -LiteralPath $Deploy
        try {
            # cmd merges the script's error into its output; NUL answers the closing pause.
            $output = & cmd.exe /d /c 'install-windows.cmd -PublicUrl ftp://bad.example 2>&1 <NUL'
            $code = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        $code | Should -Be 1
        ($output -join "`n") | Should -Match 'ERROR: -PublicUrl must be http\(s\)'
    }
}

Describe 'Edit-EnvText and Get-EnvValue' {
    It 'replaces the first line of a key, drops its duplicates and keeps the other lines' {
        Edit-EnvText "# c`nA=1`nB=2`nA=3`n" 'A' '9' | Should -BeExactly "# c`nA=9`nB=2`n"
    }

    It 'appends a missing key, also after a last line without a newline' {
        Edit-EnvText "A=1" 'B' '2' | Should -BeExactly "A=1`nB=2`n"
        Edit-EnvText '' 'B' '2' | Should -BeExactly "B=2`n"
    }

    It 'keeps CRLF line endings and takes values literally' {
        $value = 'a$b\c=d&e ''x'' "y"'
        $text = Edit-EnvText "A=1`r`nB=2`r`n" 'A' $value
        $text | Should -BeExactly "A=$value`r`nB=2`r`n"
        Get-EnvValue $text 'A' | Should -BeExactly $value
    }

    It 'reads a value containing = and answers $null for a missing key' {
        Get-EnvValue "KEY=abc==`nAB=1" 'KEY' | Should -BeExactly 'abc=='
        Get-EnvValue "AB=1" 'A' | Should -BeNullOrEmpty
    }
}

Describe 'Get-FirstEnvValue' {
    It 'generates secrets in the shapes the service checks, and the Docker volumes' {
        $values = Get-FirstEnvValue 'http://127.0.0.1:8085' 8085 'media'
        $values.POSTGRES_PASSWORD | Should -Match '^[0-9a-f]{48}$'
        $values.DATABASE_URL | Should -BeExactly "postgres://ytdlp_app:$($values.POSTGRES_PASSWORD)@postgres:5432/media"
        [Convert]::FromBase64String($values.LINK_SIGNING_SECRET).Length | Should -Be 32
        $values.TOKEN_ENCRYPTION_KEYS | Should -Match '^v1:[A-Za-z0-9+/]{43}=$'
        [Convert]::FromBase64String($values.TOKEN_ENCRYPTION_KEYS.Substring(3)).Length | Should -Be 32
        $values.HTTP_BIND | Should -BeExactly '127.0.0.1'
        foreach ($key in 'MEDIA_FILES_PATH', 'PGDATA_PATH', 'REDIS_DATA_PATH') {
            $script:OverrideText | Should -Match "(?m)^  $([regex]::Escape($values[$key])):"
        }
    }

    It 'never repeats a secret' {
        (Get-FirstEnvValue 'x' 1 'm').TOKEN_ENCRYPTION_KEYS | Should -Not -Be (Get-FirstEnvValue 'x' 1 'm').TOKEN_ENCRYPTION_KEYS
    }
}

Describe 'whisper models' {
    It "reads models.sh's catalog" {
        $Catalog.Name | Should -Be @('fast', 'balanced', 'accurate', 'vad')
        ($Catalog | Where-Object Name -EQ 'fast').File | Should -BeExactly 'ggml-base-q8_0.bin'
        ($Catalog | Where-Object Name -EQ 'accurate').Sha | Should -Match '^[0-9a-f]{64}$'
    }

    It 'writes the same .env lines as models.sh env' -Skip:(-not $HaveBash) {
        $expected = & bash (Join-Path $Deploy 'models.sh') env fast balanced accurate
        $values = Get-ModelEnvValue $Catalog @('fast', 'balanced', 'accurate')
        $actual = foreach ($pair in $values.GetEnumerator()) { "$($pair.Key)=$($pair.Value)" }
        $actual | Should -Be $expected
    }

    It 'turns transcription off for none, and refuses a name it does not know' {
        (Get-ModelEnvValue $Catalog @('none')).FFMPEG_WHISPER_MODELS | Should -BeExactly ''
        (Get-ModelEnvValue $Catalog @('none')).FFMPEG_WHISPER_VAD_MODEL | Should -BeExactly ''
        { Get-ModelEnvValue $Catalog @('huge') } | Should -Throw '*Unknown model*'
        { Get-ModelEnvValue $Catalog @('vad') } | Should -Throw '*Unknown model*'
    }

    It 'takes a comma list given as one string, as powershell -File passes -Models fast,balanced' {
        $listed = Get-ModelEnvValue $Catalog @('fast', 'balanced')
        $joined = Get-ModelEnvValue $Catalog @(' fast , balanced,')
        $joined.FFMPEG_WHISPER_MODELS | Should -BeExactly $listed.FFMPEG_WHISPER_MODELS
        $joined.FFMPEG_WHISPER_DEFAULT_MODEL | Should -BeExactly 'balanced'
        (Get-ModelEnvValue $Catalog @('none,')).FFMPEG_WHISPER_MODELS | Should -BeExactly ''
    }

    It 'finds the files .env refers to, once each, and refuses one outside the catalog' {
        $text = "FFMPEG_WHISPER_MODELS='{`"fast`":`"/models/ggml-base-q8_0.bin`",`"x`":`"/models/ggml-base-q8_0.bin`"}'`nFFMPEG_WHISPER_VAD_MODEL=/models/ggml-silero-v6.2.0.bin`n"
        (Get-ReferencedModel $text $Catalog).File | Should -Be @('ggml-base-q8_0.bin', 'ggml-silero-v6.2.0.bin')
        (Get-ReferencedModel "FFMPEG_WHISPER_MODELS=`n" $Catalog) | Should -BeNullOrEmpty
        { Get-ReferencedModel "FFMPEG_WHISPER_VAD_MODEL=/models/evil.bin`n" $Catalog } | Should -Throw '*not in the model catalog*'
    }
}

Describe 'Get-CheckoutSha' {
    BeforeEach {
        $script:Repo = Initialize-TempFolder
        $script:DeployDir = Join-Path $Repo 'deploy'
        New-Item -ItemType Directory -Path $DeployDir | Out-Null
        $script:Sha = 'f88bfd215735c6e15ebb3b9b16346eacead32e61'
    }

    It 'follows HEAD to the branch file, from the deploy folder up' {
        Write-Text (Join-Path $Repo '.git/HEAD') "ref: refs/heads/main`n"
        Write-Text (Join-Path $Repo '.git/refs/heads/main') "$Sha`n"
        Get-CheckoutSha $DeployDir | Should -BeExactly $Sha
    }

    It 'finds a branch that git packed, and a detached HEAD' {
        Write-Text (Join-Path $Repo '.git/HEAD') "ref: refs/heads/main`n"
        Write-Text (Join-Path $Repo '.git/packed-refs') "# pack-refs with: peeled fully-peeled sorted`n$Sha refs/heads/main`n"
        Get-CheckoutSha $DeployDir | Should -BeExactly $Sha
        Write-Text (Join-Path $Repo '.git/HEAD') "$Sha`n"
        Get-CheckoutSha $DeployDir | Should -BeExactly $Sha
    }

    It 'follows a worktree to its git directory' {
        $real = Initialize-TempFolder
        Write-Text (Join-Path $real 'HEAD') "ref: refs/heads/main`n"
        Write-Text (Join-Path $real 'refs/heads/main') "$Sha`n"
        Write-Text (Join-Path $Repo '.git') "gitdir: $real`n"
        Get-CheckoutSha $DeployDir | Should -BeExactly $Sha
    }

    It 'answers $null outside a clone' {
        Get-CheckoutSha $DeployDir | Should -BeNullOrEmpty
    }
}

Describe 'Test-PublicUrl and Get-PullAdvice' {
    It 'accepts http(s) addresses with a port or a path, and nothing else' {
        foreach ($good in 'https://win.example.com/ffmpeg', 'http://127.0.0.1:8085', 'https://a.example.com:8443/x/y') {
            Test-PublicUrl $good | Should -BeTrue -Because $good
        }
        foreach ($bad in 'ftp://a.example.com', 'https://a.example.com/?x=1', 'https://a.example.com/#x', 'https://u:p@a.example.com', 'a.example.com') {
            Test-PublicUrl $bad | Should -BeFalse -Because $bad
        }
    }

    It 'says what a failed pull means' {
        Get-PullAdvice 'manifest unknown' 'abc' | Should -Match 'No image is tagged abc.*CI'
        Get-PullAdvice 'no matching manifest for linux/arm64/v8 in the manifest list entries: no match for platform in manifest: not found' 'abc' |
            Should -Match 'amd64 \(x64\) PCs only'
        Get-PullAdvice 'denied: denied' 'abc' | Should -Match 'docker logout ghcr.io'
        Get-PullAdvice 'dial tcp: lookup ghcr.io: no such host' 'abc' | Should -Match 'internet connection'
    }
}

Describe 'Confirm-DockerDesktop' {
    It 'needs Docker Desktop running Linux containers with Compose' {
        Mock Get-Command { $null } -ParameterFilter { $Name -eq 'docker' }
        { Confirm-DockerDesktop } | Should -Throw '*not installed*'
    }

    It 'names what is wrong' {
        Mock Get-Command { [pscustomobject]@{ Name = 'docker' } } -ParameterFilter { $Name -eq 'docker' }
        Mock Invoke-Docker { [pscustomobject]@{ Code = 1; Text = 'error during connect' } }
        { Confirm-DockerDesktop } | Should -Throw '*not running*'
        Mock Invoke-Docker { [pscustomobject]@{ Code = 0; Text = 'windows/amd64' } }
        { Confirm-DockerDesktop } | Should -Throw '*Windows containers*'
        Mock Invoke-Docker { [pscustomobject]@{ Code = 0; Text = 'linux/amd64' } }
        Confirm-DockerDesktop | Should -BeExactly 'linux/amd64'
    }
}

Describe 'Install-MediaService, with Docker mocked' {
    BeforeEach {
        $script:Here = Initialize-TempFolder
        foreach ($file in '.env.example', 'models.sh', 'docker-compose.yml') {
            Copy-Item (Join-Path $Deploy $file) (Join-Path $Here $file)
        }
        $script:Calls = New-Object System.Collections.Generic.List[string]
        Mock Confirm-DockerDesktop { 'linux/amd64' }
        Remove-Item Env:DOCKER_DEFAULT_PLATFORM -ErrorAction SilentlyContinue
        Mock Invoke-Docker { [pscustomobject]@{ Code = 0; Text = 'healthy' } }
        Mock Invoke-Compose {
            param([string[]]$Arguments)
            $script:Calls.Add($Arguments -join ' ')
            $text = switch -Regex ($Arguments -join ' ') {
                'keys:create installer-smoke' { 'mk_smoke1234567890abcdefghijklmnopq' }
                'keys:create default' { 'mk_first12345678901234567890abcdefg' }
                'wget' { '{"download_presets":[{"name":"best"}]}' }
                '^ps' { 'api-container' }
                default { '' }
            }
            [pscustomobject]@{ Code = 0; Text = $text }
        }
        $script:Release = 'f88bfd215735c6e15ebb3b9b16346eacead32e61'
        $script:Run = @{ Version = $Release; Models = @('none') }
    }

    It 'a first install writes .env and the override, starts the stack and makes the first key' {
        Install-MediaService @Run
        $text = [IO.File]::ReadAllText((Join-Path $Here '.env'))
        Get-EnvValue $text 'IMAGE_TAG' | Should -BeExactly $Release
        Get-EnvValue $text 'MEDIA_IMAGE' | Should -BeExactly 'ghcr.io/bytebunch/media-service'
        Get-EnvValue $text 'PUBLIC_BASE_URL' | Should -BeExactly 'http://127.0.0.1:8085'
        Get-EnvValue $text 'POSTGRES_PASSWORD' | Should -Match '^[0-9a-f]{48}$'
        Get-EnvValue $text 'FFMPEG_WHISPER_MODELS' | Should -BeExactly ''
        [IO.File]::ReadAllText((Join-Path $Here 'docker-compose.override.yml')) | Should -BeExactly $OverrideText
        [IO.File]::ReadAllText((Join-Path $Here '.release-history')) | Should -BeExactly "$Release`n"
        foreach ($folder in 'inbox', 'models', 'backups', 'certs') { Test-Path (Join-Path $Here $folder) | Should -BeTrue }
        $Calls | Should -Contain 'config --quiet'
        $Calls | Should -Contain 'pull --quiet'
        $Calls | Should -Contain 'up -d --remove-orphans'
        ($Calls | Where-Object { $_ -match 'keys:create default' }).Count | Should -Be 1
        $Calls | Should -Contain 'exec -T api cli keys:revoke --key mk_smoke1234567890abcdefghijklmnopq'
        $bytes = [IO.File]::ReadAllBytes((Join-Path $Here '.env'))
        ($bytes[0] -eq 0xEF) | Should -BeFalse
    }

    It 'an update keeps every secret and setting, sets the release, and makes no new key' {
        Install-MediaService @Run
        $before = [IO.File]::ReadAllText((Join-Path $Here '.env'))
        [IO.File]::WriteAllText((Join-Path $Here 'docker-compose.override.yml'), "# mine`n")
        $Calls.Clear()
        $next = '0000000000000000000000000000000000000001'
        Install-MediaService -Version $next -PublicUrl 'https://win.example.com/ffmpeg'
        $after = [IO.File]::ReadAllText((Join-Path $Here '.env'))
        foreach ($key in 'POSTGRES_PASSWORD', 'DATABASE_URL', 'LINK_SIGNING_SECRET', 'TOKEN_ENCRYPTION_KEYS', 'PGDATA_PATH') {
            Get-EnvValue $after $key | Should -BeExactly (Get-EnvValue $before $key) -Because $key
        }
        Get-EnvValue $after 'IMAGE_TAG' | Should -BeExactly $next
        Get-EnvValue $after 'PUBLIC_BASE_URL' | Should -BeExactly 'https://win.example.com/ffmpeg'
        [IO.File]::ReadAllText((Join-Path $Here 'docker-compose.override.yml')) | Should -BeExactly "# mine`n"
        ($Calls | Where-Object { $_ -match 'keys:create default' }).Count | Should -Be 0
        @([IO.File]::ReadAllLines((Join-Path $Here '.release-history'))).Count | Should -Be 2
    }

    It 'asks Docker for the amd64 build on an ARM PC, and leaves an x64 PC alone' {
        Install-MediaService @Run
        Test-Path Env:DOCKER_DEFAULT_PLATFORM | Should -BeFalse
        Mock Confirm-DockerDesktop { 'linux/arm64' }
        Install-MediaService @Run
        $env:DOCKER_DEFAULT_PLATFORM | Should -BeExactly 'linux/amd64'
        Remove-Item Env:DOCKER_DEFAULT_PLATFORM
    }

    It 'stops before anything else when the release, the address or the folder is wrong' {
        { Install-MediaService @Run -PublicUrl 'https://win.example.com/?x=1' } | Should -Throw '*-PublicUrl must be*'
        { Install-MediaService -Version 'not a tag!' } | Should -Throw '*not an image tag*'
        Remove-Item -Force (Join-Path $Here '.env.example')
        { Install-MediaService @Run } | Should -Throw '*deploy folder*'
        Test-Path (Join-Path $Here '.env') | Should -BeFalse
        $Calls.Count | Should -Be 0
    }

    It 'explains a release whose image was not published' {
        Mock Invoke-Compose {
            param([string[]]$Arguments)
            if ($Arguments[0] -eq 'pull') { return [pscustomobject]@{ Code = 1; Text = "Pulling api`nmanifest unknown" } }
            [pscustomobject]@{ Code = 0; Text = '' }
        }
        { Install-MediaService @Run } | Should -Throw "*No image is tagged $Release*"
    }

    It 'fails when the API never answers through the proxy, and still revokes the smoke key' {
        Mock Invoke-Compose {
            param([string[]]$Arguments)
            $script:Calls.Add($Arguments -join ' ')
            $text = if (($Arguments -join ' ') -match 'keys:create') { 'mk_smoke1234567890abcdefghijklmnopq' } elseif ($Arguments[0] -eq 'ps') { 'api' } else { '502 Bad Gateway' }
            [pscustomobject]@{ Code = 0; Text = $text }
        }
        Mock Start-Sleep { }
        Mock Test-ServiceResponse { $false }
        { Install-MediaService @Run } | Should -Throw "*didn't answer through the proxy*"
        $Calls | Should -Contain 'exec -T api cli keys:revoke --key mk_smoke1234567890abcdefghijklmnopq'
    }
}
