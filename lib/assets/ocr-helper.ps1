# devbox VM Manager - OCR helper (lib/ocr.js starts it; nothing else does).
#
# Windows' own OCR engine (Windows.Media.Ocr, part of Windows 10/11 - nothing is
# installed) behind a line protocol, so the engine is loaded once and every
# screen read after that takes 0.1-0.6 s:
#   startup  -> one line: {"ready":true|false,"language":"en-US","maxDimension":10000,"error":...}
#   request  <- one line: {"id":7,"path":"C:\\...\\screen.png"}
#   reply    -> one line: {"id":7,"ok":true,"width":1280,"height":800,"ms":140,
#                          "lines":[{"text":"...","x":0,"y":0,"w":10,"h":10}, ...]}
#            or          {"id":7,"ok":false,"error":"..."}
# Positions are in the PNG's pixels (lib/ocr.js enlarges small screens before
# they get here and scales the positions back). An empty line or end of input
# ends the helper.
#
# Windows PowerShell 5.1 only: PowerShell 7 cannot load WinRT types.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Send($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) {
        # no OCR-capable language in the user's list: English, when its recognizer is installed
        try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US')) } catch { $engine = $null }
    }
    if (-not $engine) {
        Send ([ordered]@{ ready = $false; error = 'no OCR language is installed in Windows (Settings > Time & Language > Language: add a language and its "Optical character recognition" feature)' })
        exit 0
    }
    Send ([ordered]@{ ready = $true; language = $engine.RecognizerLanguage.LanguageTag; maxDimension = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension })
} catch {
    Send ([ordered]@{ ready = $false; error = 'the Windows OCR engine could not be loaded: ' + $_.Exception.Message })
    exit 0
}

function Await($op, [Type]$type) {
    $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    try { $null = $t.Wait(-1) } catch {
        # Task.Wait wraps the real error in AggregateException ("One or more errors occurred")
        $e = $_.Exception
        while ($e.InnerException) { $e = $e.InnerException }
        throw $e.Message
    }
    $t.Result
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line.Trim() -eq '') { break }
    $id = $null
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        # StorageFile refuses forward slashes ("The parameter is incorrect"): a full Windows path
        $path = [IO.Path]::GetFullPath([string]$req.path)
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        try {
            $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $w = [int]$dec.PixelWidth; $h = [int]$dec.PixelHeight
            # the parameterless overload: PowerShell 5.1 cannot pass the pixel-format
            # overloads' WinRT enums ("Argument types do not match"); enlarging is done
            # by the caller (lib/ocr.js), which divides the positions by its scale
            $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
            $lines = New-Object System.Collections.Generic.List[object]
            foreach ($l in $res.Lines) {
                $x1 = [double]::MaxValue; $y1 = [double]::MaxValue; $x2 = 0.0; $y2 = 0.0
                foreach ($wd in $l.Words) {
                    $r = $wd.BoundingRect
                    if ($r.X -lt $x1) { $x1 = $r.X }
                    if ($r.Y -lt $y1) { $y1 = $r.Y }
                    if ($r.X + $r.Width -gt $x2) { $x2 = $r.X + $r.Width }
                    if ($r.Y + $r.Height -gt $y2) { $y2 = $r.Y + $r.Height }
                }
                if ($x1 -eq [double]::MaxValue) { $x1 = 0; $y1 = 0 }
                $lines.Add([ordered]@{
                    text = [string]$l.Text
                    x = [int][Math]::Round($x1); y = [int][Math]::Round($y1)
                    w = [int][Math]::Round($x2 - $x1); h = [int][Math]::Round($y2 - $y1)
                })
            }
            # .ToArray(), not @($lines): PowerShell 5.1 throws "Argument types do not
            # match" for @(<generic List>) inside a hashtable literal
            Send ([ordered]@{ id = $id; ok = $true; width = $w; height = $h; ms = [int]$sw.ElapsedMilliseconds; lines = $lines.ToArray() })
        } finally {
            $stream.Dispose()
        }
    } catch {
        Send ([ordered]@{ id = $id; ok = $false; error = $_.Exception.Message })
    }
}
