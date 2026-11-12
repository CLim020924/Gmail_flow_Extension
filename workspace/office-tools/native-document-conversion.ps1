param(
  [Parameter(Mandatory = $true)]
  [string]$JobFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [Console]::InputEncoding = $utf8NoBom
  [Console]::OutputEncoding = $utf8NoBom
  $OutputEncoding = $utf8NoBom
}
catch {}

function ConvertTo-AsciiJson {
  param([object]$Value)

  $json = $Value | ConvertTo-Json -Depth 10 -Compress
  $builder = New-Object System.Text.StringBuilder
  foreach ($character in $json.ToCharArray()) {
    $codePoint = [int][char]$character
    if ($codePoint -gt 127) {
      [void]$builder.Append(('\u{0:x4}' -f $codePoint))
    }
    else {
      [void]$builder.Append($character)
    }
  }
  return $builder.ToString()
}

function Write-JsonFile {
  param([string]$Path, [object]$Value)

  $json = ConvertTo-AsciiJson -Value $Value
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json, $encoding)
}

function Write-ProgressMarker {
  param([object]$Value)

  $json = ConvertTo-AsciiJson -Value $Value
  [Console]::Out.WriteLine("CMOE_PROGRESS:$json")
}

function Get-SafeErrorCode {
  param([object]$ErrorRecord, [string]$Fallback)

  $message = ''
  try { $message = [string]$ErrorRecord.Exception.Message } catch {}
  if ($message -match '^[A-Z][A-Z0-9_]{2,95}$') { return $message }
  return $Fallback
}

function Assert-NotCancelled {
  param([string]$CancelPath)

  if (-not [string]::IsNullOrWhiteSpace($CancelPath) -and [System.IO.File]::Exists($CancelPath)) {
    throw 'DOCUMENT_CONVERSION_CANCELLED'
  }
}

function Release-ComReference {
  param([object]$Value, [switch]$Final)

  if ($null -eq $Value) { return }
  try {
    if ([System.Runtime.InteropServices.Marshal]::IsComObject($Value)) {
      if ($Final) { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value) }
      else { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Value) }
    }
  }
  catch {}
}

function Normalize-Engine {
  param([object]$Value)

  $requested = ([string]$Value).Trim().ToLowerInvariant()
  switch ($requested) {
    'powerpoint' { return 'powerpoint' }
    'word' { return 'word' }
    'excel' { return 'excel' }
    'hancomwriter' { return 'hancomWriter' }
    'hancomcell' { return 'hancomCell' }
    default { throw 'UNSUPPORTED_ENGINE' }
  }
}

function New-EngineApplication {
  param([string]$Engine)

  [string[]]$progIds = switch ($Engine) {
    'powerpoint' { @('PowerPoint.Application') }
    'word' { @('Word.Application') }
    'excel' { @('Excel.Application') }
    'hancomWriter' { @('HWPFrame.HwpObject', 'HWPFrame.HwpObject.2') }
    'hancomCell' { @('HCell.Application', 'HCell.Application.1') }
    default { throw 'UNSUPPORTED_ENGINE' }
  }
  foreach ($progId in $progIds) {
    try {
      $application = New-Object -ComObject $progId
      if ($null -ne $application) {
        Write-Output -NoEnumerate $application
        return
      }
    }
    catch {}
  }
  throw 'ENGINE_COM_START_FAILED'
}

function Assert-HancomSecurityModuleRegistration {
  param([string]$ModuleName, [string]$ExpectedSha256)

  if ([string]::IsNullOrWhiteSpace($ModuleName) -or $ModuleName.Length -gt 128 -or $ModuleName -match '[\\/\x00-\x1f\x7f]') { throw 'HANCOM_SECURITY_MODULE_NAME_INVALID' }
  if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'HANCOM_SECURITY_MODULE_HASH_INVALID' }

  $registrations = New-Object System.Collections.Generic.List[object]
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $baseKey = $null
    $moduleKey = $null
    $usesKey = $null
    try {
      $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
      $moduleKey = $baseKey.OpenSubKey('Software\HNC\HwpAutomation\Modules', $false)
      if ($null -eq $moduleKey -or -not ($moduleKey.GetValueNames() -contains $ModuleName)) { continue }
      if ($moduleKey.GetValueKind($ModuleName) -ne [Microsoft.Win32.RegistryValueKind]::String) {
        throw 'HANCOM_SECURITY_MODULE_REGISTRY_TYPE_INVALID'
      }
      $modulePath = [string]$moduleKey.GetValue($ModuleName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $usesKey = $baseKey.OpenSubKey('Software\HNC\HwpAutomation\Modules\Uses', $false)
      if ($null -ne $usesKey -and ($usesKey.GetValueNames() -contains $ModuleName)) {
        if ($usesKey.GetValueKind($ModuleName) -ne [Microsoft.Win32.RegistryValueKind]::DWord) {
          throw 'HANCOM_SECURITY_MODULE_USES_TYPE_INVALID'
        }
        $usesValue = $usesKey.GetValue($ModuleName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -ne $usesValue -and [int64]$usesValue -eq 0) { throw 'HANCOM_SECURITY_MODULE_DISABLED' }
      }
      $registrations.Add([pscustomobject]@{ Path = $modulePath; View = [string]$view })
    }
    finally {
      if ($null -ne $usesKey) { $usesKey.Dispose() }
      if ($null -ne $moduleKey) { $moduleKey.Dispose() }
      if ($null -ne $baseKey) { $baseKey.Dispose() }
    }
  }
  if ($registrations.Count -lt 1) { throw 'HANCOM_SECURITY_MODULE_REGISTRY_MISSING' }
  try {
    $normalizedPaths = @($registrations | ForEach-Object { [IO.Path]::GetFullPath([string]$_.Path) } | Select-Object -Unique)
  }
  catch { throw 'HANCOM_SECURITY_MODULE_FILE_INVALID' }
  if ($normalizedPaths.Count -ne 1) { throw 'HANCOM_SECURITY_MODULE_REGISTRY_AMBIGUOUS' }
  $resolvedPath = [string]$normalizedPaths[0]
  if (-not [IO.Path]::IsPathRooted($resolvedPath) -or $resolvedPath -match '^\\\\' -or [IO.Path]::GetExtension($resolvedPath) -ine '.dll' -or -not [IO.File]::Exists($resolvedPath)) {
    throw 'HANCOM_SECURITY_MODULE_FILE_INVALID'
  }
  $file = Get-Item -LiteralPath $resolvedPath -Force
  if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -lt 256 -or $file.Length -gt 16777216) { throw 'HANCOM_SECURITY_MODULE_FILE_INVALID' }
  $actualSha256 = (Get-FileHash -LiteralPath $resolvedPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $ExpectedSha256.ToLowerInvariant()) { throw 'HANCOM_SECURITY_MODULE_CHANGED' }
  return $resolvedPath
}

function Normalize-Extension {
  param([object]$Value)

  $extension = ([string]$Value).Trim().TrimStart('.').ToLowerInvariant()
  if ($extension -notmatch '^[a-z0-9]{1,16}$') { throw 'EXTENSION_INVALID' }
  return $extension
}

function Test-ConversionRoute {
  param([string]$Engine, [string]$SourceExtension, [string]$TargetExtension)

  if ($SourceExtension -eq $TargetExtension) { return $false }
  switch ($Engine) {
    'powerpoint' {
      return $SourceExtension -in @('ppt', 'pptx', 'pptm', 'odp') -and $TargetExtension -in @('pdf', 'ppt', 'pptx', 'pptm', 'odp')
    }
    'word' {
      return $SourceExtension -in @('doc', 'docx', 'docm', 'odt', 'rtf') -and $TargetExtension -in @('pdf', 'doc', 'docx', 'docm', 'odt', 'rtf')
    }
    'excel' {
      return $SourceExtension -in @('xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv') -and $TargetExtension -in @('pdf', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv')
    }
    'hancomWriter' {
      if ($SourceExtension -notin @('hwp', 'hwpx', 'doc', 'docx', 'odt', 'rtf')) { return $false }
      if ($SourceExtension -in @('hwp', 'hwpx')) {
        return $TargetExtension -in @('pdf', 'docx', 'odt', 'rtf', 'hwp', 'hwpx')
      }
      return $TargetExtension -in @('hwp', 'hwpx')
    }
    'hancomCell' {
      if ($SourceExtension -notin @('cell', 'nxl', 'xls', 'xlsx', 'xlsm', 'ods', 'csv')) { return $false }
      if ($SourceExtension -in @('cell', 'nxl')) {
        return $TargetExtension -in @('pdf', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv', 'cell', 'nxl')
      }
      return $TargetExtension -in @('cell', 'nxl')
    }
    default { return $false }
  }
}

function Test-SamePath {
  param([string]$Left, [string]$Right)

  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  return [string]::Equals(
    [System.IO.Path]::GetFullPath($Left).TrimEnd('\'),
    [System.IO.Path]::GetFullPath($Right).TrimEnd('\'),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function New-ConversionPlan {
  param(
    [string]$Engine,
    [object]$Item,
    [int]$Index,
    [string]$JobPath,
    [string]$ResultPath,
    [string]$CancelPath
  )

  try { $inputPath = [System.IO.Path]::GetFullPath([string]$Item.inputPath) }
  catch { throw 'INPUT_PATH_INVALID' }
  try { $outputPath = [System.IO.Path]::GetFullPath([string]$Item.outputPath) }
  catch { throw 'OUTPUT_PATH_INVALID' }
  $sourceExtension = Normalize-Extension -Value $Item.sourceExtension
  $targetExtension = Normalize-Extension -Value $Item.targetExtension

  if (-not (Test-ConversionRoute -Engine $Engine -SourceExtension $sourceExtension -TargetExtension $targetExtension)) {
    throw 'UNSUPPORTED_ROUTE'
  }
  if (-not [System.IO.File]::Exists($inputPath)) { throw 'INPUT_NOT_FOUND' }
  $inputInfo = Get-Item -LiteralPath $inputPath
  if (-not $inputInfo.PSIsContainer -and [long]$inputInfo.Length -le 0) { throw 'INPUT_EMPTY' }
  if ($inputInfo.PSIsContainer) { throw 'INPUT_NOT_FILE' }

  $actualSourceExtension = [System.IO.Path]::GetExtension($inputPath).TrimStart('.').ToLowerInvariant()
  $actualTargetExtension = [System.IO.Path]::GetExtension($outputPath).TrimStart('.').ToLowerInvariant()
  if ($actualSourceExtension -ne $sourceExtension) { throw 'SOURCE_EXTENSION_MISMATCH' }
  if ($actualTargetExtension -ne $targetExtension) { throw 'TARGET_EXTENSION_MISMATCH' }
  if (Test-SamePath -Left $inputPath -Right $outputPath) { throw 'INPUT_OUTPUT_PATH_COLLISION' }
  if (Test-SamePath -Left $outputPath -Right $JobPath) { throw 'OUTPUT_PATH_RESERVED' }
  if (Test-SamePath -Left $outputPath -Right $ResultPath) { throw 'OUTPUT_PATH_RESERVED' }
  if (-not [string]::IsNullOrWhiteSpace($CancelPath) -and (Test-SamePath -Left $outputPath -Right $CancelPath)) {
    throw 'OUTPUT_PATH_RESERVED'
  }
  if ([System.IO.File]::Exists($outputPath) -or [System.IO.Directory]::Exists($outputPath)) { throw 'OUTPUT_EXISTS' }
  $outputDirectory = [System.IO.Path]::GetDirectoryName($outputPath)
  if ([string]::IsNullOrWhiteSpace($outputDirectory) -or -not [System.IO.Directory]::Exists($outputDirectory)) {
    throw 'OUTPUT_DIRECTORY_NOT_FOUND'
  }

  return [pscustomobject]@{
    index = $Index
    inputPath = $inputPath
    outputPath = $outputPath
    sourceExtension = $sourceExtension
    targetExtension = $targetExtension
  }
}

function Assert-EngineIdle {
  param([string]$Engine)

  $processNames = switch ($Engine) {
    'powerpoint' { @('POWERPNT') }
    'word' { @('WINWORD') }
    'excel' { @('EXCEL') }
    'hancomWriter' { @('Hwp', 'HwpApp') }
    'hancomCell' { @('HCell', 'HCellApp') }
    default { @() }
  }
  foreach ($processName in $processNames) {
    if (@(Get-Process -Name $processName -ErrorAction SilentlyContinue).Count -gt 0) {
      switch ($Engine) {
        'powerpoint' { throw 'POWERPOINT_IN_USE' }
        'word' { throw 'WORD_IN_USE' }
        'excel' { throw 'EXCEL_IN_USE' }
        'hancomWriter' { throw 'HANCOM_WRITER_IN_USE' }
        'hancomCell' { throw 'HANCOM_CELL_IN_USE' }
      }
    }
  }
}

function Assert-OutputFile {
  param([string]$Path)

  if (-not [System.IO.File]::Exists($Path)) { throw 'OUTPUT_NOT_CREATED' }
  $outputInfo = Get-Item -LiteralPath $Path
  if ($outputInfo.PSIsContainer) { throw 'OUTPUT_NOT_FILE' }
  if ([long]$outputInfo.Length -le 0) { throw 'OUTPUT_EMPTY' }
}

function Remove-GeneratedOutput {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  try {
    if ([System.IO.File]::Exists($Path)) { [System.IO.File]::Delete($Path) }
  }
  catch {}
}

function Test-ComMethod {
  param([object]$Value, [string]$Name)

  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace($Name)) { return $false }
  try { return $null -ne $Value.PSObject.Methods[$Name] }
  catch { return $false }
}

function Export-PowerPointPdf {
  param([object]$Presentation, [string]$OutputPath)

  try {
    $Presentation.ExportAsFixedFormat($OutputPath, 2, 1, 0, 1, 1, 0, $null, 1)
  }
  catch {
    Remove-GeneratedOutput -Path $OutputPath
    try { $Presentation.SaveAs($OutputPath, 32, -1) }
    catch { throw 'POWERPOINT_PDF_EXPORT_FAILED' }
  }
}

function Invoke-PowerPointConversion {
  param([object]$Application, [object]$Plan, [string]$CancelPath)

  $presentations = $null
  $presentation = $null
  try {
    Assert-NotCancelled -CancelPath $CancelPath
    $presentations = $Application.Presentations
    $presentation = $presentations.Open($Plan.inputPath, -1, 0, 0)
    Assert-NotCancelled -CancelPath $CancelPath
    if ($Plan.targetExtension -eq 'pdf') {
      Export-PowerPointPdf -Presentation $presentation -OutputPath $Plan.outputPath
    }
    elseif ($Plan.targetExtension -eq 'ppt') {
      try { $presentation.SaveAs($Plan.outputPath, 1, -1) }
      catch { throw 'POWERPOINT_PPT_SAVE_FAILED' }
    }
    elseif ($Plan.targetExtension -eq 'pptx') {
      try { $presentation.SaveAs($Plan.outputPath, 24, -1) }
      catch { throw 'POWERPOINT_PPTX_SAVE_FAILED' }
    }
    elseif ($Plan.targetExtension -eq 'pptm') {
      try { $presentation.SaveAs($Plan.outputPath, 25, -1) }
      catch { throw 'POWERPOINT_PPTM_SAVE_FAILED' }
    }
    elseif ($Plan.targetExtension -eq 'odp') {
      try { $presentation.SaveAs($Plan.outputPath, 35, -1) }
      catch { throw 'POWERPOINT_ODP_SAVE_FAILED' }
    }
    else { throw 'UNSUPPORTED_ROUTE' }
    Assert-NotCancelled -CancelPath $CancelPath
  }
  finally {
    if ($null -ne $presentation) {
      try { $presentation.Saved = -1 } catch {}
      try { $presentation.Close() } catch {}
      Release-ComReference -Value $presentation -Final
      $presentation = $null
    }
    Release-ComReference -Value $presentations
    $presentations = $null
  }
}

function Save-WordDocument {
  param([object]$Document, [string]$OutputPath, [int]$Format)

  try { $Document.SaveAs2($OutputPath, $Format) }
  catch {
    Remove-GeneratedOutput -Path $OutputPath
    try { $Document.SaveAs($OutputPath, $Format) }
    catch { throw 'WORD_SAVE_FAILED' }
  }
}

function Invoke-WordConversion {
  param([object]$Application, [object]$Plan, [string]$CancelPath)

  $documents = $null
  $document = $null
  try {
    Assert-NotCancelled -CancelPath $CancelPath
    $documents = $Application.Documents
    $document = $documents.Open($Plan.inputPath, $false, $true, $false, '', '', $false, '', '')
    Assert-NotCancelled -CancelPath $CancelPath
    if ($Plan.targetExtension -eq 'pdf') {
      try { $document.ExportAsFixedFormat($Plan.outputPath, 17) }
      catch {
        Remove-GeneratedOutput -Path $Plan.outputPath
        try { $document.SaveAs2($Plan.outputPath, 17) }
        catch { throw 'WORD_PDF_EXPORT_FAILED' }
      }
    }
    elseif ($Plan.targetExtension -eq 'docx') {
      Save-WordDocument -Document $document -OutputPath $Plan.outputPath -Format 16
    }
    elseif ($Plan.targetExtension -eq 'doc') {
      Save-WordDocument -Document $document -OutputPath $Plan.outputPath -Format 0
    }
    elseif ($Plan.targetExtension -eq 'docm') {
      Save-WordDocument -Document $document -OutputPath $Plan.outputPath -Format 13
    }
    elseif ($Plan.targetExtension -eq 'odt') {
      Save-WordDocument -Document $document -OutputPath $Plan.outputPath -Format 23
    }
    elseif ($Plan.targetExtension -eq 'rtf') {
      Save-WordDocument -Document $document -OutputPath $Plan.outputPath -Format 6
    }
    else { throw 'UNSUPPORTED_ROUTE' }
    Assert-NotCancelled -CancelPath $CancelPath
  }
  finally {
    if ($null -ne $document) {
      try { $document.Close(0) } catch {}
      Release-ComReference -Value $document -Final
      $document = $null
    }
    Release-ComReference -Value $documents
    $documents = $null
  }
}

function Invoke-ExcelConversion {
  param([object]$Application, [object]$Plan, [string]$CancelPath)

  $workbooks = $null
  $workbook = $null
  try {
    Assert-NotCancelled -CancelPath $CancelPath
    $workbooks = $Application.Workbooks
    $workbook = $workbooks.Open($Plan.inputPath, 0, $true, $null, '', '', $true)
    Assert-NotCancelled -CancelPath $CancelPath
    if ($Plan.targetExtension -eq 'pdf') {
      try { $workbook.ExportAsFixedFormat(0, $Plan.outputPath) }
      catch { throw 'EXCEL_PDF_EXPORT_FAILED' }
    }
    elseif ($Plan.targetExtension -eq 'xlsx') {
      try { $workbook.SaveAs($Plan.outputPath, 51) }
      catch { throw 'EXCEL_XLSX_SAVE_FAILED' }
    }
    elseif ($Plan.targetExtension -eq 'xls') {
      try { $workbook.SaveAs($Plan.outputPath, 56) }
      catch { throw 'EXCEL_XLS_SAVE_FAILED' }
    }
    elseif ($Plan.targetExtension -eq 'xlsm') {
      try { $workbook.SaveAs($Plan.outputPath, 52) }
      catch { throw 'EXCEL_XLSM_SAVE_FAILED' }
    }
    elseif ($Plan.targetExtension -eq 'xlsb') {
      try { $workbook.SaveAs($Plan.outputPath, 50) }
      catch { throw 'EXCEL_XLSB_SAVE_FAILED' }
    }
    elseif ($Plan.targetExtension -eq 'ods') {
      try { $workbook.SaveAs($Plan.outputPath, 60) }
      catch { throw 'EXCEL_ODS_SAVE_FAILED' }
    }
    elseif ($Plan.targetExtension -eq 'csv') {
      try { $workbook.SaveAs($Plan.outputPath, 62) }
      catch { throw 'EXCEL_CSV_UTF8_SAVE_FAILED' }
    }
    else { throw 'UNSUPPORTED_ROUTE' }
    Assert-NotCancelled -CancelPath $CancelPath
  }
  finally {
    if ($null -ne $workbook) {
      try { $workbook.Close($false) } catch {}
      Release-ComReference -Value $workbook -Final
      $workbook = $null
    }
    Release-ComReference -Value $workbooks
    $workbooks = $null
  }
}

function Save-HwpDocument {
  param([object]$Application, [string]$OutputPath, [string[]]$Formats)

  foreach ($format in $Formats) {
    Remove-GeneratedOutput -Path $OutputPath
    try {
      $saved = $Application.SaveAs($OutputPath, $format, '')
      if ($saved -is [bool] -and -not $saved) { throw 'SAVE_RETURNED_FALSE' }
      if ([System.IO.File]::Exists($OutputPath)) { return }
    }
    catch {}
  }
  throw 'HANCOM_WRITER_SAVE_FAILED'
}

function Invoke-HancomWriterConversion {
  param([object]$Application, [object]$Plan, [string]$CancelPath)

  $opened = $false
  try {
    Assert-NotCancelled -CancelPath $CancelPath
    try {
      $openResult = $Application.Open($Plan.inputPath, '', 'lock:false;suspendpassword:true;versionwarning:false;')
      if ($openResult -is [bool] -and -not $openResult) { throw 'OPEN_RETURNED_FALSE' }
      $opened = $true
    }
    catch { throw 'HANCOM_WRITER_OPEN_FAILED' }
    Assert-NotCancelled -CancelPath $CancelPath
    switch ($Plan.targetExtension) {
      'pdf' { Save-HwpDocument -Application $Application -OutputPath $Plan.outputPath -Formats @('PDF') }
      'docx' { Save-HwpDocument -Application $Application -OutputPath $Plan.outputPath -Formats @('OOXML', 'DOCX') }
      'odt' { Save-HwpDocument -Application $Application -OutputPath $Plan.outputPath -Formats @('ODT') }
      'rtf' { Save-HwpDocument -Application $Application -OutputPath $Plan.outputPath -Formats @('RTF') }
      'hwp' { Save-HwpDocument -Application $Application -OutputPath $Plan.outputPath -Formats @('HWP') }
      'hwpx' { Save-HwpDocument -Application $Application -OutputPath $Plan.outputPath -Formats @('HWPX') }
      default { throw 'UNSUPPORTED_ROUTE' }
    }
    Assert-NotCancelled -CancelPath $CancelPath
  }
  finally {
    if ($opened) {
      try { $Application.Clear(1) } catch {}
    }
  }
}

function Open-HancomCellWorkbook {
  param([object]$Workbooks, [string]$InputPath)

  try { return $Workbooks.Open($InputPath, 0, $true) }
  catch {
    try { return $Workbooks.Open($InputPath) }
    catch { throw 'HANCOM_CELL_OPEN_FAILED' }
  }
}

function Invoke-HancomCellConversion {
  param([object]$Application, [object]$Plan, [string]$CancelPath)

  $workbooks = $null
  $workbook = $null
  try {
    Assert-NotCancelled -CancelPath $CancelPath
    $workbooks = $Application.Workbooks
    $workbook = Open-HancomCellWorkbook -Workbooks $workbooks -InputPath $Plan.inputPath
    Assert-NotCancelled -CancelPath $CancelPath
    if ($Plan.targetExtension -in @('xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv', 'cell', 'nxl')) {
      if (-not (Test-ComMethod -Value $workbook -Name 'SaveAs')) { throw 'HANCOM_CELL_XLSX_SAVE_UNSUPPORTED' }
      try { $workbook.SaveAs($Plan.outputPath) }
      catch { throw 'HANCOM_CELL_SAVE_FAILED' }
    }
    elseif ($Plan.targetExtension -eq 'pdf') {
      if (-not (Test-ComMethod -Value $workbook -Name 'ExportAsFixedFormat')) { throw 'HANCOM_CELL_PDF_EXPORT_UNSUPPORTED' }
      try { $workbook.ExportAsFixedFormat(0, $Plan.outputPath) }
      catch { throw 'HANCOM_CELL_PDF_EXPORT_FAILED' }
    }
    else { throw 'UNSUPPORTED_ROUTE' }
    Assert-NotCancelled -CancelPath $CancelPath
  }
  finally {
    if ($null -ne $workbook) {
      try { $workbook.Close($false) } catch {}
      Release-ComReference -Value $workbook -Final
      $workbook = $null
    }
    Release-ComReference -Value $workbooks
    $workbooks = $null
  }
}

function Invoke-EngineConversion {
  param([string]$Engine, [object]$Application, [object]$Plan, [string]$CancelPath)

  switch ($Engine) {
    'powerpoint' { Invoke-PowerPointConversion -Application $Application -Plan $Plan -CancelPath $CancelPath }
    'word' { Invoke-WordConversion -Application $Application -Plan $Plan -CancelPath $CancelPath }
    'excel' { Invoke-ExcelConversion -Application $Application -Plan $Plan -CancelPath $CancelPath }
    'hancomWriter' { Invoke-HancomWriterConversion -Application $Application -Plan $Plan -CancelPath $CancelPath }
    'hancomCell' { Invoke-HancomCellConversion -Application $Application -Plan $Plan -CancelPath $CancelPath }
    default { throw 'UNSUPPORTED_ENGINE' }
  }
}

function Assert-NativeOutputReadable {
  param([string]$Engine, [object]$Application, [object]$Plan, [string]$CancelPath)

  Assert-NotCancelled -CancelPath $CancelPath
  if ($Plan.targetExtension -eq 'pdf') { return }
  $opened = $null
  $collection = $null
  $hancomWriterOpenAttempted = $false
  try {
    switch ($Engine) {
      'powerpoint' {
        $collection = $Application.Presentations
        $opened = $collection.Open($Plan.outputPath, -1, 0, 0)
      }
      'word' {
        $collection = $Application.Documents
        $opened = $collection.Open($Plan.outputPath, $false, $true, $false, '', '', $false, '', '')
      }
      'excel' {
        $collection = $Application.Workbooks
        $opened = $collection.Open($Plan.outputPath, 0, $true, $null, '', '', $true)
      }
      'hancomWriter' {
        $hancomWriterOpenAttempted = $true
        $openResult = $Application.Open($Plan.outputPath, '', 'lock:false;suspendpassword:true;versionwarning:false;')
        if ($openResult -is [bool] -and -not $openResult) { throw 'OUTPUT_OPEN_RETURNED_FALSE' }
        $opened = $true
      }
      'hancomCell' {
        $collection = $Application.Workbooks
        $opened = Open-HancomCellWorkbook -Workbooks $collection -InputPath $Plan.outputPath
      }
      default { throw 'UNSUPPORTED_ENGINE' }
    }
    if ($null -eq $opened -or ($opened -is [bool] -and -not $opened)) { throw 'OUTPUT_OPEN_RETURNED_EMPTY' }
    Assert-NotCancelled -CancelPath $CancelPath
  }
  catch {
    if ([string]$_.Exception.Message -eq 'DOCUMENT_CONVERSION_CANCELLED') { throw 'DOCUMENT_CONVERSION_CANCELLED' }
    throw 'OUTPUT_REOPEN_FAILED'
  }
  finally {
    if ($Engine -eq 'hancomWriter') {
      if ($hancomWriterOpenAttempted) { try { $Application.Clear(1) } catch {} }
    }
    elseif ($null -ne $opened) {
      if ($Engine -eq 'powerpoint') {
        try { $opened.Saved = -1 } catch {}
        try { $opened.Close() } catch {}
      }
      else { try { $opened.Close($false) } catch {} }
      Release-ComReference -Value $opened -Final
    }
    Release-ComReference -Value $collection
  }
}

$job = $null
$jobPath = ''
$resultPath = ''
$cancelPath = ''
$engine = ''
$fatalError = $null
$engineApplication = $null
$startedEngine = $false
$results = New-Object System.Collections.Generic.List[object]
$plans = New-Object System.Collections.Generic.List[object]
$originalAutomationSecurity = $null
$originalDisplayAlerts = $null
$originalEnableEvents = $null
$originalAskToUpdateLinks = $null

try {
  try { $jobPath = [System.IO.Path]::GetFullPath($JobFile) }
  catch { throw 'JOB_PATH_INVALID' }
  try { $job = Get-Content -LiteralPath $jobPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw 'JOB_JSON_INVALID' }

  if ($null -eq $job.PSObject.Properties['resultPath']) { throw 'MISSING_RESULT_PATH' }
  try { $resultPath = [System.IO.Path]::GetFullPath([string]$job.resultPath) }
  catch { throw 'RESULT_PATH_INVALID' }
  $resultDirectory = [System.IO.Path]::GetDirectoryName($resultPath)
  if ([string]::IsNullOrWhiteSpace($resultDirectory) -or -not [System.IO.Directory]::Exists($resultDirectory)) {
    throw 'RESULT_DIRECTORY_NOT_FOUND'
  }
  if ([System.IO.Directory]::Exists($resultPath)) { throw 'RESULT_PATH_INVALID' }

  if ($null -ne $job.PSObject.Properties['cancelPath'] -and -not [string]::IsNullOrWhiteSpace([string]$job.cancelPath)) {
    try { $cancelPath = [System.IO.Path]::GetFullPath([string]$job.cancelPath) }
    catch { throw 'CANCEL_PATH_INVALID' }
  }
  $engine = Normalize-Engine -Value $job.engine
  Assert-NotCancelled -CancelPath $cancelPath

  $probe = $false
  if ($null -ne $job.PSObject.Properties['probe']) { $probe = [bool]$job.probe }
  [object[]]$items = if ($null -ne $job.PSObject.Properties['items']) { @($job.items) } else { @() }
  if (-not $probe -and $items.Count -lt 1) { throw 'ITEMS_REQUIRED' }
  if ($items.Count -gt 500) { throw 'ITEM_COUNT_EXCEEDED' }
  $hancomSecurityModuleName = ''
  $hancomSecurityModuleSha256 = ''
  if ($engine -eq 'hancomWriter' -and $items.Count -gt 0) {
    if ($null -ne $job.PSObject.Properties['hancomSecurityModuleName']) {
      $hancomSecurityModuleName = [string]$job.hancomSecurityModuleName
    }
    if ($null -ne $job.PSObject.Properties['hancomSecurityModuleSha256']) {
      $hancomSecurityModuleSha256 = [string]$job.hancomSecurityModuleSha256
    }
  }

  for ($index = 0; $index -lt $items.Count; $index += 1) {
    try {
      $plan = New-ConversionPlan -Engine $engine -Item $items[$index] -Index $index -JobPath $jobPath -ResultPath $resultPath -CancelPath $cancelPath
      $plans.Add($plan)
    }
    catch {
      $errorCode = Get-SafeErrorCode -ErrorRecord $_ -Fallback 'ITEM_VALIDATION_FAILED'
      $results.Add([pscustomobject]@{ ok = $false; index = $index; error = $errorCode })
      Write-ProgressMarker -Value ([pscustomobject]@{ index = $index; ok = $false; error = $errorCode })
    }
  }

  if ($engine -eq 'hancomWriter' -and $plans.Count -gt 0) {
    [void](Assert-HancomSecurityModuleRegistration -ModuleName $hancomSecurityModuleName -ExpectedSha256 $hancomSecurityModuleSha256)
  }

  if ($probe -or $plans.Count -gt 0) {
    Assert-NotCancelled -CancelPath $cancelPath
    Assert-EngineIdle -Engine $engine
    try {
      $engineApplication = New-EngineApplication -Engine $engine
      $startedEngine = $true
    }
    catch {
      switch ($engine) {
        'powerpoint' { throw 'POWERPOINT_START_FAILED' }
        'word' { throw 'WORD_START_FAILED' }
        'excel' { throw 'EXCEL_START_FAILED' }
        'hancomWriter' { throw 'HANCOM_WRITER_START_FAILED' }
        'hancomCell' { throw 'HANCOM_CELL_START_FAILED' }
      }
    }

    try { $originalAutomationSecurity = $engineApplication.AutomationSecurity } catch {}
    try { $originalDisplayAlerts = $engineApplication.DisplayAlerts } catch {}
    try { $originalEnableEvents = $engineApplication.EnableEvents } catch {}
    try { $originalAskToUpdateLinks = $engineApplication.AskToUpdateLinks } catch {}
    try { $engineApplication.AutomationSecurity = 3 } catch {}
    if ($engine -eq 'powerpoint') {
      try { $engineApplication.DisplayAlerts = 1 } catch {}
    }
    else {
      try { $engineApplication.DisplayAlerts = 0 } catch {}
    }
    try { $engineApplication.EnableEvents = $false } catch {}
    try { $engineApplication.AskToUpdateLinks = $false } catch {}
    try { $engineApplication.Visible = $false } catch {}

    if ($engine -eq 'hancomWriter' -and $plans.Count -gt 0) {
      # Re-check immediately before the COM registration call so a registry or
      # DLL replacement after job parsing cannot win a time-of-check race.
      [void](Assert-HancomSecurityModuleRegistration -ModuleName $hancomSecurityModuleName -ExpectedSha256 $hancomSecurityModuleSha256)
      try {
        $registered = $engineApplication.RegisterModule('FilePathCheckDLL', $hancomSecurityModuleName)
      }
      catch { throw 'HANCOM_SECURITY_MODULE_REGISTER_FAILED' }
      # Hancom documents a Boolean success result. A false value cannot be
      # treated as a harmless version quirk without an independent prompt-free
      # access proof, so it remains fail-closed.
      if (-not [bool]$registered) { throw 'HANCOM_SECURITY_MODULE_REGISTER_RETURNED_FALSE' }
    }

    if ($probe) {
      $version = ''
      try { $version = [string]$engineApplication.Version } catch {}
      $results.Add([pscustomobject]@{ ok = $true; probe = $true; engine = $engine; version = $version })
    }

    foreach ($plan in [object[]]$plans.ToArray()) {
      $outputCreated = $false
      try {
        Assert-NotCancelled -CancelPath $cancelPath
        Invoke-EngineConversion -Engine $engine -Application $engineApplication -Plan $plan -CancelPath $cancelPath
        Assert-OutputFile -Path $plan.outputPath
        Assert-NativeOutputReadable -Engine $engine -Application $engineApplication -Plan $plan -CancelPath $cancelPath
        $outputCreated = $true
        $results.Add([pscustomobject]@{
          ok = $true
          index = [int]$plan.index
          outputPath = [string]$plan.outputPath
          sourceExtension = [string]$plan.sourceExtension
          targetExtension = [string]$plan.targetExtension
        })
        Write-ProgressMarker -Value ([pscustomobject]@{ index = [int]$plan.index; ok = $true })
      }
      catch {
        $fallback = switch ($engine) {
          'powerpoint' { 'POWERPOINT_CONVERSION_FAILED' }
          'word' { 'WORD_CONVERSION_FAILED' }
          'excel' { 'EXCEL_CONVERSION_FAILED' }
          'hancomWriter' { 'HANCOM_WRITER_CONVERSION_FAILED' }
          'hancomCell' { 'HANCOM_CELL_CONVERSION_FAILED' }
        }
        $errorCode = Get-SafeErrorCode -ErrorRecord $_ -Fallback $fallback
        Remove-GeneratedOutput -Path $plan.outputPath
        $results.Add([pscustomobject]@{ ok = $false; index = [int]$plan.index; error = $errorCode })
        Write-ProgressMarker -Value ([pscustomobject]@{ index = [int]$plan.index; ok = $false; error = $errorCode })
        if ($errorCode -eq 'DOCUMENT_CONVERSION_CANCELLED') { throw $errorCode }
      }
    }
  }
}
catch {
  $fatalError = Get-SafeErrorCode -ErrorRecord $_ -Fallback 'NATIVE_CONVERSION_WORKER_FAILED'
}
finally {
  if ($null -ne $engineApplication) {
    if ($null -ne $originalAutomationSecurity) { try { $engineApplication.AutomationSecurity = $originalAutomationSecurity } catch {} }
    if ($null -ne $originalDisplayAlerts) { try { $engineApplication.DisplayAlerts = $originalDisplayAlerts } catch {} }
    if ($null -ne $originalEnableEvents) { try { $engineApplication.EnableEvents = $originalEnableEvents } catch {} }
    if ($null -ne $originalAskToUpdateLinks) { try { $engineApplication.AskToUpdateLinks = $originalAskToUpdateLinks } catch {} }
    if ($startedEngine) {
      try { $engineApplication.Quit() } catch {}
    }
    Release-ComReference -Value $engineApplication -Final
    $engineApplication = $null
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()

  if (-not [string]::IsNullOrWhiteSpace($resultPath)) {
    $orderedResults = [object[]]@($results.ToArray() | Sort-Object -Property @{ Expression = {
      if ($null -ne $_.PSObject.Properties['index']) { [int]$_.index } else { -1 }
    } })
    Write-JsonFile -Path $resultPath -Value ([pscustomobject]@{
      ok = [string]::IsNullOrWhiteSpace([string]$fatalError)
      engine = $engine
      fatalError = $fatalError
      results = $orderedResults
    })
  }
}

if (-not [string]::IsNullOrWhiteSpace([string]$fatalError)) { exit 1 }
exit 0
