[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$Dev,
    [switch]$SkipBuild,
    [switch]$SkipLink
)

$ErrorActionPreference = "Stop"

function Invoke-BunCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$BunArguments
    )

    & $script:BunExecutable @BunArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Bun 命令执行失败（退出码 $LASTEXITCODE）：bun $($BunArguments -join ' ')"
    }
}

function Remove-RepositoryDependencyDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetDirectory,
        [Parameter(Mandatory = $true)]
        [string]$AllowedPrefix
    )

    $resolvedDirectory = [System.IO.Path]::GetFullPath($TargetDirectory)
    if (-not $resolvedDirectory.StartsWith($AllowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝清理仓库之外的路径：$resolvedDirectory"
    }

    if (Test-Path -LiteralPath $resolvedDirectory) {
        Write-Host "清理残缺依赖：$resolvedDirectory"
        Remove-Item -LiteralPath $resolvedDirectory -Recurse -Force
    }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "此脚本仅用于 Windows；macOS 和 Linux 请继续使用 bun install。"
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$repositoryPrefix = $repositoryRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$cliDirectory = Join-Path $repositoryRoot "packages\cli"
$bunCommand = Get-Command bun -CommandType Application -ErrorAction Stop
$script:BunExecutable = $bunCommand.Source
$rootModules = Join-Path $repositoryRoot "node_modules"
$cliModules = Join-Path $repositoryRoot "packages\cli\node_modules"
$bridgeModules = Join-Path $repositoryRoot "packages\macos-bridge\node_modules"

if ($Clean) {
    # 只清理仓库内可重新生成的依赖目录，并在删除前校验绝对路径边界。
    foreach ($directory in @($rootModules, $cliModules, $bridgeModules)) {
        Remove-RepositoryDependencyDirectory -TargetDirectory $directory -AllowedPrefix $repositoryPrefix
    }
}

$stagingRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "tmp"))
$stagingPrefix = $stagingRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
$stagingDirectory = Join-Path $stagingRoot (
    "claudish-windows-install-{0}" -f [System.Guid]::NewGuid().ToString("N")
)
$stagingDirectory = [System.IO.Path]::GetFullPath($stagingDirectory)
if (-not $stagingDirectory.StartsWith($stagingPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝在仓库临时目录之外创建安装暂存区：$stagingDirectory"
}

New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
$temporaryConfig = Join-Path $stagingDirectory "bunfig.toml"

try {
    # Windows 专用配置仅在本次安装中生效，不改变 macOS/Linux 的默认行为。
    @'
[install]
linker = "hoisted"
globalStore = false

[install.cache]
disable = true
'@ | Set-Content -LiteralPath $temporaryConfig -Encoding utf8

    # 在仓库 workspace 之外生成 CLI 清单，并保留仓库锁文件的精确解析版本。
    $generatorArguments = @(
        (Join-Path $PSScriptRoot "create-windows-staging.cjs"),
        (Join-Path $cliDirectory "package.json"),
        (Join-Path $repositoryRoot "bun.lock"),
        $stagingDirectory
    )
    if ($Dev) {
        $generatorArguments += "--dev"
    }
    Invoke-BunCommand -BunArguments $generatorArguments

    $baseInstallArguments = @(
        "install",
        "--config=$temporaryConfig",
        "--backend=copyfile",
        "--cwd=$stagingDirectory"
    )
    if (-not $Dev) {
        $baseInstallArguments += "--omit=dev"
    }

    # 先让 Bun 仅裁剪无关锁条目，再用冻结锁文件执行正式安装。
    Invoke-BunCommand -BunArguments ($baseInstallArguments + "--lockfile-only")
    $installArguments = $baseInstallArguments + "--frozen-lockfile"
    Invoke-BunCommand -BunArguments $installArguments

    $stagedModules = Join-Path $stagingDirectory "node_modules"
    if (-not (Test-Path -LiteralPath $stagedModules)) {
        throw "Bun 安装完成后未生成暂存依赖目录：$stagedModules"
    }

    # 暂存安装成功后再替换仓库依赖，避免失败时留下半安装状态。
    foreach ($directory in @($rootModules, $cliModules)) {
        Remove-RepositoryDependencyDirectory -TargetDirectory $directory -AllowedPrefix $repositoryPrefix
    }
    Move-Item -LiteralPath $stagedModules -Destination $rootModules

    if (-not $SkipBuild) {
        Invoke-BunCommand -BunArguments @("run", "--cwd", $cliDirectory, "build")
    }

    if (-not $SkipLink) {
        Push-Location -LiteralPath $cliDirectory
        try {
            Invoke-BunCommand -BunArguments @("link")
        }
        finally {
            Pop-Location
        }
    }

    Write-Host "Claudish Windows 源码安装完成。" -ForegroundColor Green
    if ($SkipBuild) {
        Write-Host "已跳过构建。"
    }
    if ($SkipLink) {
        Write-Host "已跳过全局链接。"
    }
}
finally {
    if (Test-Path -LiteralPath $stagingDirectory) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
