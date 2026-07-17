// Screen-region OCR for explain context: grabs the pixels around the
// selection and reads them with Windows' built-in OCR engine, fully local.
// Same persistent-PowerShell pattern as the title helper in main.cjs: one
// long-lived process, id-tagged request lines in, id-tagged replies out, so
// a late reply can never be matched to the wrong request.
const { spawn } = require('child_process');

const OCR_HELPER_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System.Runtime.InteropServices;
public class DPIA {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][DPIA]::SetProcessDPIAware()
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  [void]$task.Wait(-1)
  $task.Result
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('en-US'))) }
$tab = [string][char]9
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split($tab)
  $reqId = $parts[0].Trim()
  $text = ''
  try {
    if ($null -ne $engine -and $parts.Count -ge 5) {
      $x = [int]$parts[1]; $y = [int]$parts[2]; $w = [int]$parts[3]; $h = [int]$parts[4]
      $bmp = New-Object System.Drawing.Bitmap($w, $h)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
      $g.Dispose()
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      $ms.Position = 0
      $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $sb = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $r = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
      $sb.Dispose()
      $ms.Dispose()
      $text = (($r.Lines | ForEach-Object { $_.Text }) -join ' ')
    }
  } catch { $text = '' }
  $text = ([string]$text) -replace "[\\r\\n\\t]+", ' '
  [Console]::Out.WriteLine($reqId + $tab + $text)
}
`;

let helper = null;
let pending = new Map();
let seq = 0;

function startOcrHelper() {
  if (helper || process.platform !== 'win32') return;
  try {
    const encoded = Buffer.from(OCR_HELPER_SCRIPT, 'utf16le').toString('base64');
    helper = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    helper.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const resolve = pending.get(line.slice(0, tab));
        if (resolve) {
          pending.delete(line.slice(0, tab));
          resolve(line.slice(tab + 1).trim());
        }
      }
    });
    helper.on('exit', () => {
      helper = null;
      for (const resolve of pending.values()) resolve('');
      pending.clear();
    });
  } catch (e) {
    console.error('[Casrion] OCR helper failed to start:', e.message);
    helper = null;
  }
}

function stopOcrHelper() {
  if (helper) {
    try { helper.kill(); } catch { /* already gone */ }
    helper = null;
  }
  for (const resolve of pending.values()) resolve('');
  pending.clear();
}

// OCR a physical-pixel screen rect. Resolves '' on any failure or timeout;
// explain never waits on this longer than the timeout.
function ocrRegion(x, y, w, h, timeoutMs = 900) {
  startOcrHelper();
  if (!helper) return Promise.resolve('');
  return new Promise((resolve) => {
    const id = String(++seq);
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve('');
    }, timeoutMs);
    pending.set(id, (text) => { clearTimeout(timer); resolve(text); });
    try {
      helper.stdin.write([id, Math.round(x), Math.round(y), Math.round(w), Math.round(h)].join('\t') + '\n');
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve('');
    }
  });
}

// Keep only the words nearest the selection: a big OCR dump would slow the
// model's prefill down more than it helps the answer.
function trimNearest(ocrText, selectionText, windowWords = 100) {
  const words = ocrText.split(/\s+/).filter(Boolean);
  if (words.length <= windowWords) return words.join(' ');
  const selWords = selectionText.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  let anchor = -1;
  if (selWords.length) {
    const lower = words.map((w) => w.toLowerCase());
    for (let i = 0; i < lower.length; i++) {
      if (lower[i].includes(selWords[0])) {
        let hits = 1;
        for (let k = 1; k < selWords.length && i + k < lower.length; k++) {
          if (lower[i + k].includes(selWords[k])) hits++;
        }
        if (hits >= Math.min(selWords.length, 2)) { anchor = i; break; }
      }
    }
  }
  if (anchor < 0) return words.slice(0, windowWords).join(' ');
  const half = Math.floor(windowWords / 2);
  const start = Math.max(0, anchor - half);
  return words.slice(start, start + windowWords).join(' ');
}

module.exports = { startOcrHelper, stopOcrHelper, ocrRegion, trimNearest };
