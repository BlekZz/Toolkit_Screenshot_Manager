# Batch OCR via Windows.Media.Ocr — must run under Windows PowerShell 5.1 (powershell.exe)
param(
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [string]$LangTag = "zh-Hant-TW"
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null

$lang = New-Object Windows.Globalization.Language $LangTag
if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) {
    $lang = New-Object Windows.Globalization.Language "zh-Hant"
}
if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) {
    [Console]::Error.WriteLine("No supported OCR language for $LangTag / zh-Hant")
    exit 1
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) {
    [Console]::Error.WriteLine("TryCreateFromLanguage returned null for " + $lang.LanguageTag)
    exit 1
}

$paths = [System.IO.File]::ReadAllLines($ManifestPath) | Where-Object { $_ -ne '' }
$results = foreach ($p in $paths) {
    try {
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $text = @($result.Lines | ForEach-Object { $_.Text }) -join "`n"
        $stream.Dispose(); $bitmap.Dispose()
        [pscustomobject]@{ path = $p; text = $text }
    } catch {
        [pscustomobject]@{ path = $p; error = $_.Exception.Message }
    }
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 3 | Write-Output
