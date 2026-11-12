param(
  [Parameter(Mandatory = $true)]
  [string]$JobFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Write-JsonFile {
  param([string]$Path, [object]$Value)
  $json = $Value | ConvertTo-Json -Depth 12 -Compress
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
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

function Assert-NotCancelled {
  param([string]$CancelPath)
  if (-not [string]::IsNullOrWhiteSpace($CancelPath) -and [System.IO.File]::Exists($CancelPath)) {
    throw 'DOCUMENT_TOOL_CANCELLED'
  }
}

function Get-SafeErrorCode {
  param([object]$ErrorValue, [string]$Fallback)
  $message = if ($null -ne $ErrorValue.Exception -and $ErrorValue.Exception.Message) {
    [string]$ErrorValue.Exception.Message
  }
  else { [string]$ErrorValue }
  if ($message -match '^[A-Z][A-Z0-9_]{2,127}$') { return $message }
  return $Fallback
}

function Get-NormalizedExtension {
  param([string]$Path)
  return [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
}

function Assert-InputIdentity {
  param([string]$Path, [object]$ExpectedIdentity)
  if ($null -eq $ExpectedIdentity) { throw 'INPUT_IDENTITY_INVALID' }
  $expectedBytes = 0L
  if (-not [long]::TryParse([string]$ExpectedIdentity.bytes, [ref]$expectedBytes) -or $expectedBytes -lt 1) {
    throw 'INPUT_IDENTITY_INVALID'
  }
  $expectedHash = ([string]$ExpectedIdentity.sha256).Trim().ToLowerInvariant()
  if ($expectedHash -notmatch '^[a-f0-9]{64}$') { throw 'INPUT_IDENTITY_INVALID' }
  $file = Get-Item -LiteralPath $Path -Force
  if (-not $file.PSIsContainer -and [long]$file.Length -eq $expectedBytes) {
    $actualHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]::Equals($actualHash, $expectedHash, [System.StringComparison]::Ordinal)) { return }
  }
  throw 'INPUT_IDENTITY_CHANGED'
}

function Resolve-InputPath {
  param([string]$Path, [string]$Kind, [object]$ExpectedIdentity)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'INPUT_NOT_FOUND' }
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  if (-not [System.IO.File]::Exists($fullPath)) { throw 'INPUT_NOT_FOUND' }
  $extension = Get-NormalizedExtension -Path $fullPath
  $allowed = if ($Kind -eq 'word') { @('.doc', '.docx', '.odt', '.rtf') } else { @('.xls', '.xlsx', '.ods', '.csv') }
  $rejected = if ($Kind -eq 'word') { @('.docm', '.dotm', '.dot', '.dotx') } else { @('.xlsm', '.xlsb', '.xlam', '.xltm', '.xlt', '.xltx') }
  if ($rejected -contains $extension) { throw 'MACRO_FORMAT_REJECTED' }
  if ($allowed -notcontains $extension) { throw 'INPUT_FORMAT_INVALID' }
  Assert-InputIdentity -Path $fullPath -ExpectedIdentity $ExpectedIdentity
  return $fullPath
}

function Resolve-OutputPath {
  param([string]$Path, [string]$Kind, [string[]]$InputPaths)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'OUTPUT_FORMAT_INVALID' }
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $expectedExtension = if ($Kind -eq 'word') { '.docx' } else { '.xlsx' }
  if (-not [string]::Equals((Get-NormalizedExtension -Path $fullPath), $expectedExtension, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OUTPUT_FORMAT_INVALID'
  }
  $directory = [System.IO.Path]::GetDirectoryName($fullPath)
  if (-not [System.IO.Directory]::Exists($directory)) { throw 'OUTPUT_DIRECTORY_NOT_FOUND' }
  if ([System.IO.File]::Exists($fullPath)) { throw 'OUTPUT_EXISTS' }
  foreach ($inputPath in @($InputPaths)) {
    if ([string]::Equals($inputPath, $fullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'OUTPUT_EQUALS_INPUT'
    }
  }
  return $fullPath
}

function New-StagingPath {
  param([string]$OutputPath)
  $directory = [System.IO.Path]::GetDirectoryName($OutputPath)
  $extension = [System.IO.Path]::GetExtension($OutputPath)
  do {
    $name = '.cmoe-' + [Guid]::NewGuid().ToString('N') + $extension
    $candidate = [System.IO.Path]::Combine($directory, $name)
  } while ([System.IO.File]::Exists($candidate))
  return $candidate
}

function Open-WordReadOnly {
  param([object]$Documents, [string]$InputPath)
  $rejectPassword = [Guid]::NewGuid().ToString('N')
  try {
    return $Documents.OpenNoRepairDialog(
      $InputPath,
      $false,
      $true,
      $false,
      $rejectPassword,
      $rejectPassword,
      $false,
      $rejectPassword,
      $rejectPassword,
      [System.Type]::Missing,
      [System.Type]::Missing,
      $false,
      $false,
      [System.Type]::Missing,
      $true,
      [System.Type]::Missing
    )
  }
  catch { throw 'WORD_INPUT_OPEN_FAILED' }
}

function Open-WordWritable {
  param([object]$Documents, [string]$InputPath)
  $rejectPassword = [Guid]::NewGuid().ToString('N')
  try {
    return $Documents.OpenNoRepairDialog(
      $InputPath,
      $false,
      $false,
      $false,
      $rejectPassword,
      $rejectPassword,
      $false,
      $rejectPassword,
      $rejectPassword,
      [System.Type]::Missing,
      [System.Type]::Missing,
      $false,
      $false,
      [System.Type]::Missing,
      $true,
      [System.Type]::Missing
    )
  }
  catch { throw 'WORD_OUTPUT_VERIFY_FAILED' }
}

function Assert-WordNoMacros {
  param([object]$Document)
  $hasMacros = $false
  try { $hasMacros = [bool]$Document.HasVBProject }
  catch { throw 'WORD_MACRO_INSPECTION_FAILED' }
  if ($hasMacros) { throw 'WORD_MACRO_INPUT_REJECTED' }
}

function Assert-WordDocumentSecurity {
  param([object]$Document)
  $hasPassword = $false
  $protectionType = -1
  $signatures = $null
  $signatureCount = 0
  $permission = $null
  $irmEnabled = $false
  try { $hasPassword = [bool]$Document.HasPassword }
  catch { throw 'WORD_SECURITY_INSPECTION_FAILED' }
  if ($hasPassword) { throw 'WORD_PASSWORD_INPUT_REJECTED' }
  try { $protectionType = [int]$Document.ProtectionType }
  catch { throw 'WORD_SECURITY_INSPECTION_FAILED' }
  if ($protectionType -ne -1) { throw 'WORD_PROTECTED_INPUT_REJECTED' }
  try {
    $signatures = $Document.Signatures
    $signatureCount = [int]$signatures.Count
  }
  catch { throw 'WORD_SECURITY_INSPECTION_FAILED' }
  finally { Release-ComReference -Value $signatures }
  if ($signatureCount -gt 0) { throw 'WORD_SIGNED_INPUT_REJECTED' }
  try {
    $permission = $Document.Permission
    $irmEnabled = [bool]$permission.Enabled
  }
  catch { throw 'WORD_SECURITY_INSPECTION_FAILED' }
  finally { Release-ComReference -Value $permission }
  if ($irmEnabled) { throw 'WORD_IRM_INPUT_REJECTED' }
}

function Get-WordDocumentFacts {
  param([object]$Word, [string]$InputPath, [object]$ExpectedIdentity, [string]$CancelPath)
  $documents = $null
  $document = $null
  $sections = $null
  $revisions = $null
  $comments = $null
  try {
    Assert-NotCancelled -CancelPath $CancelPath
    Assert-InputIdentity -Path $InputPath -ExpectedIdentity $ExpectedIdentity
    $documents = $Word.Documents
    $document = Open-WordReadOnly -Documents $documents -InputPath $InputPath
    Assert-WordNoMacros -Document $document
    Assert-WordDocumentSecurity -Document $document
    $sections = $document.Sections
    $revisions = $document.Revisions
    $comments = $document.Comments
    $pageCount = [int]$document.ComputeStatistics(2)
    $sectionCount = [int]$sections.Count
    if ($pageCount -lt 1 -or $sectionCount -lt 1) { throw 'WORD_INPUT_EMPTY' }
    return [pscustomobject]@{
      pageCount = $pageCount
      sectionCount = $sectionCount
      revisionCount = [int]$revisions.Count
      commentCount = [int]$comments.Count
    }
  }
  finally {
    Release-ComReference -Value $comments
    Release-ComReference -Value $revisions
    Release-ComReference -Value $sections
    if ($null -ne $document) {
      try { $document.Close(0) } catch {}
      Release-ComReference -Value $document -Final
    }
    Release-ComReference -Value $documents
  }
}

function Disconnect-WordHeaderFooterLinks {
  param([object]$Document, [int]$StartSectionIndex)
  $sections = $null
  $section = $null
  $headers = $null
  $footers = $null
  $header = $null
  $footer = $null
  $detached = 0
  $failures = 0
  try {
    $sections = $Document.Sections
    $firstBoundarySection = [Math]::Max(1, $StartSectionIndex)
    $lastBoundarySection = [Math]::Min([int]$sections.Count, $firstBoundarySection)
    for ($sectionIndex = $firstBoundarySection; $sectionIndex -le $lastBoundarySection; $sectionIndex += 1) {
      try {
        $section = $sections.Item($sectionIndex)
        $headers = $section.Headers
        $footers = $section.Footers
        for ($kindIndex = 1; $kindIndex -le 3; $kindIndex += 1) {
          try {
            $header = $headers.Item($kindIndex)
            if ([bool]$header.LinkToPrevious) {
              $header.LinkToPrevious = $false
              if ([bool]$header.LinkToPrevious) { $failures += 1 } else { $detached += 1 }
            }
          }
          catch { $failures += 1 }
          finally {
            Release-ComReference -Value $header
            $header = $null
          }
          try {
            $footer = $footers.Item($kindIndex)
            if ([bool]$footer.LinkToPrevious) {
              $footer.LinkToPrevious = $false
              if ([bool]$footer.LinkToPrevious) { $failures += 1 } else { $detached += 1 }
            }
          }
          catch { $failures += 1 }
          finally {
            Release-ComReference -Value $footer
            $footer = $null
          }
        }
      }
      finally {
        Release-ComReference -Value $headers
        $headers = $null
        Release-ComReference -Value $footers
        $footers = $null
        Release-ComReference -Value $section
        $section = $null
      }
    }
    return [pscustomobject]@{ detached = $detached; failures = $failures }
  }
  finally {
    Release-ComReference -Value $header
    Release-ComReference -Value $footer
    Release-ComReference -Value $headers
    Release-ComReference -Value $footers
    Release-ComReference -Value $section
    Release-ComReference -Value $sections
  }
}

function Verify-WordOutput {
  param([object]$Word, [string]$Path)
  $documents = $null
  $document = $null
  $sections = $null
  try {
    $documents = $Word.Documents
    $document = Open-WordReadOnly -Documents $documents -InputPath $Path
    Assert-WordNoMacros -Document $document
    Assert-WordDocumentSecurity -Document $document
    $sections = $document.Sections
    $pageCount = [int]$document.ComputeStatistics(2)
    $sectionCount = [int]$sections.Count
    if ($pageCount -lt 1 -or $sectionCount -lt 1) { throw 'WORD_OUTPUT_VERIFY_FAILED' }
    return [pscustomobject]@{ pageCount = $pageCount; sectionCount = $sectionCount }
  }
  catch {
    $code = Get-SafeErrorCode -ErrorValue $_ -Fallback 'WORD_OUTPUT_VERIFY_FAILED'
    if ($code -like 'WORD_MACRO_*') { throw $code }
    throw 'WORD_OUTPUT_VERIFY_FAILED'
  }
  finally {
    Release-ComReference -Value $sections
    if ($null -ne $document) {
      try { $document.Close(0) } catch {}
      Release-ComReference -Value $document -Final
    }
    Release-ComReference -Value $documents
  }
}

function Merge-WordDocuments {
  param([object]$Word, [object]$Item, [string]$CancelPath)
  $documents = $null
  $sourceDocument = $null
  $targetDocument = $null
  $targetContent = $null
  $insertRange = $null
  $targetSections = $null
  $stagingPath = ''
  $outputPath = ''
  $published = $false
  try {
    $rawInputPaths = @($Item.inputPaths)
    $identities = @($Item.expectedIdentities)
    if ($rawInputPaths.Count -lt 2 -or $rawInputPaths.Count -gt 500 -or $identities.Count -ne $rawInputPaths.Count) {
      throw 'INPUT_COUNT_INVALID'
    }
    $inputPaths = New-Object System.Collections.Generic.List[string]
    for ($index = 0; $index -lt $rawInputPaths.Count; $index += 1) {
      $inputPaths.Add((Resolve-InputPath -Path ([string]$rawInputPaths[$index]) -Kind 'word' -ExpectedIdentity $identities[$index]))
    }
    $outputPath = Resolve-OutputPath -Path ([string]$Item.outputPath) -Kind 'word' -InputPaths ([string[]]$inputPaths.ToArray())
    $stagingPath = New-StagingPath -OutputPath $outputPath
    $documents = $Word.Documents

    $sourceFacts = New-Object System.Collections.Generic.List[object]
    for ($index = 0; $index -lt $inputPaths.Count; $index += 1) {
      $sourceFacts.Add((Get-WordDocumentFacts -Word $Word -InputPath $inputPaths[$index] -ExpectedIdentity $identities[$index] -CancelPath $CancelPath))
    }

    Assert-NotCancelled -CancelPath $CancelPath
    Assert-InputIdentity -Path $inputPaths[0] -ExpectedIdentity $identities[0]
    $sourceDocument = Open-WordReadOnly -Documents $documents -InputPath $inputPaths[0]
    Assert-WordNoMacros -Document $sourceDocument
    Assert-WordDocumentSecurity -Document $sourceDocument
    try { $sourceDocument.SaveAs2($stagingPath, 16) }
    catch { throw 'WORD_SAVE_FAILED' }
    try { $sourceDocument.Close(0) } catch {}
    Release-ComReference -Value $sourceDocument -Final
    $sourceDocument = $null

    $targetDocument = Open-WordWritable -Documents $documents -InputPath $stagingPath
    Assert-WordNoMacros -Document $targetDocument
    Assert-WordDocumentSecurity -Document $targetDocument
    $detachedLinks = 0
    $headerFooterLinkFailures = 0
    for ($index = 1; $index -lt $inputPaths.Count; $index += 1) {
      Assert-NotCancelled -CancelPath $CancelPath
      Assert-InputIdentity -Path $inputPaths[$index] -ExpectedIdentity $identities[$index]
      $targetSections = $targetDocument.Sections
      $priorSectionCount = [int]$targetSections.Count
      Release-ComReference -Value $targetSections
      $targetSections = $null
      $targetContent = $targetDocument.Content
      $insertAt = [Math]::Max(0, [int]$targetContent.End - 1)
      Release-ComReference -Value $targetContent
      $targetContent = $null
      $insertRange = $targetDocument.Range($insertAt, $insertAt)
      try {
        $insertRange.InsertBreak(2)
        $insertRange.Collapse(0)
        $insertRange.InsertFile($inputPaths[$index], '', $false, $false, $false)
      }
      catch { throw 'WORD_INSERT_FAILED' }
      finally {
        Release-ComReference -Value $insertRange
        $insertRange = $null
      }
      $linkResult = Disconnect-WordHeaderFooterLinks -Document $targetDocument -StartSectionIndex ($priorSectionCount + 1)
      $detachedLinks += [int]$linkResult.detached
      $headerFooterLinkFailures += [int]$linkResult.failures
    }
    Assert-NotCancelled -CancelPath $CancelPath
    try { $targetDocument.Save() }
    catch { throw 'WORD_SAVE_FAILED' }
    try { $targetDocument.Close(0) } catch {}
    Release-ComReference -Value $targetDocument -Final
    $targetDocument = $null

    $stagingFacts = Verify-WordOutput -Word $Word -Path $stagingPath
    Assert-NotCancelled -CancelPath $CancelPath
    if ([System.IO.File]::Exists($outputPath)) { throw 'OUTPUT_EXISTS' }
    try { [System.IO.File]::Move($stagingPath, $outputPath) }
    catch { throw 'OUTPUT_PUBLISH_FAILED' }
    $stagingPath = ''
    $published = $true
    $finalFacts = Verify-WordOutput -Word $Word -Path $outputPath
    if ([int]$finalFacts.pageCount -ne [int]$stagingFacts.pageCount -or [int]$finalFacts.sectionCount -ne [int]$stagingFacts.sectionCount) {
      throw 'WORD_OUTPUT_VERIFY_FAILED'
    }
    return [pscustomobject]@{
      outputPath = $outputPath
      sourceCount = $inputPaths.Count
      sourcePageCounts = [int[]]@($sourceFacts.ToArray() | ForEach-Object { [int]$_.pageCount })
      pageCount = [int]$finalFacts.pageCount
      sectionCount = [int]$finalFacts.sectionCount
      headerFooterLinksDetached = [int]$detachedLinks
      headerFooterLinkFailures = [int]$headerFooterLinkFailures
    }
  }
  catch {
    if ($published -and -not [string]::IsNullOrWhiteSpace($outputPath)) {
      try { if ([System.IO.File]::Exists($outputPath)) { [System.IO.File]::Delete($outputPath) } } catch {}
    }
    $code = Get-SafeErrorCode -ErrorValue $_ -Fallback 'WORD_MERGE_FAILED'
    throw $code
  }
  finally {
    Release-ComReference -Value $insertRange
    Release-ComReference -Value $targetContent
    Release-ComReference -Value $targetSections
    if ($null -ne $targetDocument) {
      try { $targetDocument.Close(0) } catch {}
      Release-ComReference -Value $targetDocument -Final
    }
    if ($null -ne $sourceDocument) {
      try { $sourceDocument.Close(0) } catch {}
      Release-ComReference -Value $sourceDocument -Final
    }
    Release-ComReference -Value $documents
    if (-not [string]::IsNullOrWhiteSpace($stagingPath)) {
      try { if ([System.IO.File]::Exists($stagingPath)) { [System.IO.File]::Delete($stagingPath) } } catch {}
    }
  }
}

function Open-ExcelReadOnly {
  param([object]$Workbooks, [string]$InputPath)
  $rejectPassword = [Guid]::NewGuid().ToString('N')
  try {
    return $Workbooks.Open(
      $InputPath,
      0,
      $true,
      [System.Type]::Missing,
      $rejectPassword,
      $rejectPassword,
      $true,
      [System.Type]::Missing,
      [System.Type]::Missing,
      $false,
      $false,
      [System.Type]::Missing,
      $false,
      $true,
      0
    )
  }
  catch { throw 'EXCEL_INPUT_OPEN_FAILED' }
}

function Open-ExcelWritable {
  param([object]$Workbooks, [string]$InputPath)
  $rejectPassword = [Guid]::NewGuid().ToString('N')
  try {
    return $Workbooks.Open(
      $InputPath,
      0,
      $false,
      [System.Type]::Missing,
      $rejectPassword,
      $rejectPassword,
      $true,
      [System.Type]::Missing,
      [System.Type]::Missing,
      $false,
      $false,
      [System.Type]::Missing,
      $false,
      $true,
      0
    )
  }
  catch { throw 'EXCEL_OUTPUT_VERIFY_FAILED' }
}

function Get-ExcelMacroSheetCount {
  param([object]$Workbook)
  $macroSheets = $null
  $internationalMacroSheets = $null
  try {
    $macroSheets = $Workbook.Excel4MacroSheets
    $internationalMacroSheets = $Workbook.Excel4IntlMacroSheets
    return [int]$macroSheets.Count + [int]$internationalMacroSheets.Count
  }
  catch { throw 'EXCEL_MACRO_INSPECTION_FAILED' }
  finally {
    Release-ComReference -Value $internationalMacroSheets
    Release-ComReference -Value $macroSheets
  }
}

function Assert-ExcelNoMacros {
  param([object]$Workbook)
  $hasVba = $false
  try { $hasVba = [bool]$Workbook.HasVBProject }
  catch { throw 'EXCEL_MACRO_INSPECTION_FAILED' }
  if ($hasVba -or (Get-ExcelMacroSheetCount -Workbook $Workbook) -gt 0) {
    throw 'EXCEL_MACRO_INPUT_REJECTED'
  }
}

function Assert-ExcelWorkbookSecurity {
  param([object]$Workbook)
  $hasPassword = $false
  $protectStructure = $false
  $signatures = $null
  $signatureCount = 0
  $permission = $null
  $irmEnabled = $false
  try {
    $hasPassword = [bool]$Workbook.HasPassword
    $protectStructure = [bool]$Workbook.ProtectStructure
  }
  catch { throw 'EXCEL_SECURITY_INSPECTION_FAILED' }
  if ($hasPassword) { throw 'EXCEL_PASSWORD_INPUT_REJECTED' }
  if ($protectStructure) { throw 'EXCEL_WORKBOOK_PROTECTED_REJECTED' }
  try {
    $signatures = $Workbook.Signatures
    $signatureCount = [int]$signatures.Count
  }
  catch { throw 'EXCEL_SECURITY_INSPECTION_FAILED' }
  finally { Release-ComReference -Value $signatures }
  if ($signatureCount -gt 0) { throw 'EXCEL_SIGNED_INPUT_REJECTED' }
  try {
    $permission = $Workbook.Permission
    $irmEnabled = [bool]$permission.Enabled
  }
  catch { throw 'EXCEL_SECURITY_INSPECTION_FAILED' }
  finally { Release-ComReference -Value $permission }
  if ($irmEnabled) { throw 'EXCEL_IRM_INPUT_REJECTED' }
}

function Get-ExcelSheetType {
  param([object]$Sheet)
  $typeValue = 0
  try { $typeValue = [int]$Sheet.Type } catch { return 'unknown' }
  switch ($typeValue) {
    -4167 { return 'worksheet' }
    -4109 { return 'chart' }
    -4116 { return 'dialog' }
    3 { return 'excel4Macro' }
    4 { return 'excel4IntlMacro' }
    default { return 'other' }
  }
}

function Get-ExcelVisibility {
  param([object]$Sheet)
  $value = 0
  try { $value = [int]$Sheet.Visible } catch { return 'unknown' }
  if ($value -eq -1) { return 'visible' }
  if ($value -eq 2) { return 'veryHidden' }
  if ($value -eq 0) { return 'hidden' }
  return 'unknown'
}

function Get-ExcelExternalLinkCount {
  param([object]$Workbook)
  $links = $null
  $connections = $null
  $count = 0
  try {
    foreach ($linkType in @(1, 2)) {
      $links = $Workbook.LinkSources($linkType)
      if ($null -ne $links) { $count += @($links).Count }
      $links = $null
    }
    $connections = $Workbook.Connections
    $count += [int]$connections.Count
    return $count
  }
  catch { throw 'EXCEL_EXTERNAL_LINK_INSPECTION_FAILED' }
  finally {
    Release-ComReference -Value $connections
    Release-ComReference -Value $links
  }
}

function Get-ExcelWorkbookFacts {
  param([object]$Excel, [string]$InputPath, [object]$ExpectedIdentity, [string]$CancelPath)
  $workbooks = $null
  $workbook = $null
  $sheets = $null
  $sheet = $null
  try {
    Assert-NotCancelled -CancelPath $CancelPath
    Assert-InputIdentity -Path $InputPath -ExpectedIdentity $ExpectedIdentity
    $workbooks = $Excel.Workbooks
    $workbook = Open-ExcelReadOnly -Workbooks $workbooks -InputPath $InputPath
    Assert-ExcelNoMacros -Workbook $workbook
    Assert-ExcelWorkbookSecurity -Workbook $workbook
    $sheets = $workbook.Sheets
    $sheetCount = [int]$sheets.Count
    if ($sheetCount -lt 1) { throw 'EXCEL_INPUT_EMPTY' }
    $sheetFacts = New-Object System.Collections.Generic.List[object]
    for ($sheetIndex = 1; $sheetIndex -le $sheetCount; $sheetIndex += 1) {
      try {
        $sheet = $sheets.Item($sheetIndex)
        $sheetFacts.Add([pscustomobject]@{
          index = $sheetIndex - 1
          name = [string]$sheet.Name
          type = Get-ExcelSheetType -Sheet $sheet
          visibility = Get-ExcelVisibility -Sheet $sheet
        })
      }
      finally {
        Release-ComReference -Value $sheet
        $sheet = $null
      }
    }
    return [pscustomobject]@{
      sheetCount = $sheetCount
      sheets = [object[]]$sheetFacts.ToArray()
      externalLinkCount = [int](Get-ExcelExternalLinkCount -Workbook $workbook)
    }
  }
  finally {
    Release-ComReference -Value $sheet
    Release-ComReference -Value $sheets
    if ($null -ne $workbook) {
      try { $workbook.Close($false) } catch {}
      Release-ComReference -Value $workbook -Final
    }
    Release-ComReference -Value $workbooks
  }
}

function Truncate-ExcelSheetName {
  param([string]$Value, [int]$Length)
  if ($Length -lt 1) { return '' }
  if ($Value.Length -le $Length) { return $Value }
  $result = $Value.Substring(0, $Length)
  if ($result.Length -gt 0 -and [char]::IsHighSurrogate($result[$result.Length - 1])) {
    $result = $result.Substring(0, $result.Length - 1)
  }
  return $result
}

function Get-UniqueExcelSheetName {
  param([string]$Value, [hashtable]$UsedNames, [int]$FallbackIndex)
  $base = [System.Text.RegularExpressions.Regex]::Replace([string]$Value, '[\\/:?*\[\]\x00-\x1F]', ' ')
  $base = [System.Text.RegularExpressions.Regex]::Replace($base, '\s+', ' ').Trim().Trim("'").Trim()
  if ([string]::IsNullOrWhiteSpace($base)) { $base = 'Sheet ' + [Math]::Max(1, $FallbackIndex) }
  $base = Truncate-ExcelSheetName -Value $base -Length 31
  $candidate = $base
  $suffixIndex = 2
  while ($UsedNames.ContainsKey($candidate.ToLowerInvariant()) -or [string]::Equals($candidate, 'History', [System.StringComparison]::OrdinalIgnoreCase)) {
    $suffix = ' (' + $suffixIndex + ')'
    $candidate = (Truncate-ExcelSheetName -Value $base -Length (31 - $suffix.Length)) + $suffix
    $suffixIndex += 1
  }
  $UsedNames[$candidate.ToLowerInvariant()] = $true
  return $candidate
}

function Get-ExcelWorkbookLinkSources {
  param([object]$Workbook)
  $items = New-Object System.Collections.Generic.List[string]
  try {
    $values = $Workbook.LinkSources(1)
    if ($null -ne $values) {
      foreach ($value in @($values)) {
        $text = ([string]$value).Trim()
        if (-not [string]::IsNullOrWhiteSpace($text)) { $items.Add($text) }
      }
    }
    return [string[]]$items.ToArray()
  }
  catch { throw 'EXCEL_SHEET_REFERENCE_REBIND_FAILED' }
}

function Test-ExcelWorkbookHasListObjects {
  param([object]$Workbook)
  $worksheets = $null
  $worksheet = $null
  $listObjects = $null
  try {
    $worksheets = $Workbook.Worksheets
    for ($index = 1; $index -le [int]$worksheets.Count; $index += 1) {
      try {
        $worksheet = $worksheets.Item($index)
        $listObjects = $worksheet.ListObjects
        if ([int]$listObjects.Count -gt 0) { return $true }
      }
      finally {
        Release-ComReference -Value $listObjects
        $listObjects = $null
        Release-ComReference -Value $worksheet
        $worksheet = $null
      }
    }
    return $false
  }
  catch {
    # Unknown sheet features take the safer one-at-a-time route rather than
    # risking an interactive grouped-copy failure in background Excel.
    return $true
  }
  finally {
    Release-ComReference -Value $listObjects
    Release-ComReference -Value $worksheet
    Release-ComReference -Value $worksheets
  }
}

function Test-ExcelLinkMatchesPath {
  param([string]$LinkSource, [string]$SourcePath)
  $link = ([string]$LinkSource).Trim().Trim('"')
  $source = [System.IO.Path]::GetFullPath($SourcePath)
  if ([string]::Equals($link, $source, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  try {
    $resolvedLink = [System.IO.Path]::GetFullPath($link)
    return [string]::Equals($resolvedLink, $source, [System.StringComparison]::OrdinalIgnoreCase)
  }
  catch { return $false }
}

function Repair-ExcelCopiedSelfLinks {
  param([object]$Workbook, [string]$SourcePath)
  $targetPath = [string]$Workbook.FullName
  if ([string]::IsNullOrWhiteSpace($targetPath) -or -not [System.IO.File]::Exists($targetPath)) {
    throw 'EXCEL_SHEET_REFERENCE_REBIND_FAILED'
  }
  $matchingLinks = @(Get-ExcelWorkbookLinkSources -Workbook $Workbook | Where-Object {
    Test-ExcelLinkMatchesPath -LinkSource ([string]$_) -SourcePath $SourcePath
  })
  foreach ($link in $matchingLinks) {
    try { [void]$Workbook.ChangeLink([string]$link, $targetPath, 1) }
    catch { throw 'EXCEL_SHEET_REFERENCE_REBIND_FAILED' }
  }
  $remainingLinks = @(Get-ExcelWorkbookLinkSources -Workbook $Workbook | Where-Object {
    (Test-ExcelLinkMatchesPath -LinkSource ([string]$_) -SourcePath $SourcePath) -or
      (Test-ExcelLinkMatchesPath -LinkSource ([string]$_) -SourcePath $targetPath)
  })
  if ($remainingLinks.Count -gt 0) { throw 'EXCEL_SHEET_REFERENCE_REBIND_FAILED' }
}

function Copy-ExcelSheetsIndividually {
  param(
    [object]$SourceSheets,
    [object]$TargetWorkbook,
    [int]$SourceSheetCount,
    [string]$TemporaryPrefix,
    [int]$SourceIndex,
    [string]$CancelPath
  )
  $sourceSheet = $null
  $targetSheets = $null
  $afterSheet = $null
  $copiedSheet = $null
  try {
    # Give every source sheet a collision-free in-memory name before copying.
    # Excel then has an unambiguous target when copied cross-sheet formulas are
    # rebound from the disposable source snapshot to the staged workbook.
    for ($sheetOffset = 0; $sheetOffset -lt $SourceSheetCount; $sheetOffset += 1) {
      Assert-NotCancelled -CancelPath $CancelPath
      try {
        $sourceSheet = $SourceSheets.Item($sheetOffset + 1)
        $sourceSheet.Name = Truncate-ExcelSheetName -Value ($TemporaryPrefix + ($SourceIndex + 1) + '_' + ($sheetOffset + 1)) -Length 31
      }
      catch { throw 'EXCEL_SHEET_NAME_FAILED' }
      finally {
        Release-ComReference -Value $sourceSheet
        $sourceSheet = $null
      }
    }

    $targetSheets = $TargetWorkbook.Sheets
    $copiedStart = [int]$targetSheets.Count + 1
    Release-ComReference -Value $targetSheets
    $targetSheets = $null

    for ($sheetOffset = 0; $sheetOffset -lt $SourceSheetCount; $sheetOffset += 1) {
      Assert-NotCancelled -CancelPath $CancelPath
      $targetSheets = $TargetWorkbook.Sheets
      $beforeCount = [int]$targetSheets.Count
      $restoreAfterVisibility = $false
      $afterVisibility = -1
      $visibilityRestoreFailed = $false
      try {
        $afterSheet = $targetSheets.Item($beforeCount)
        $afterVisibility = [int]$afterSheet.Visible
        if ($afterVisibility -ne -1) {
          $afterSheet.Visible = -1
          $restoreAfterVisibility = $true
        }
        $sourceSheet = $SourceSheets.Item($sheetOffset + 1)
        [void]$sourceSheet.Copy([System.Type]::Missing, $afterSheet)
      }
      catch { throw 'EXCEL_SHEET_COPY_FAILED' }
      finally {
        if ($restoreAfterVisibility -and $null -ne $afterSheet) {
          try { $afterSheet.Visible = $afterVisibility }
          catch { $visibilityRestoreFailed = $true }
        }
        Release-ComReference -Value $sourceSheet
        $sourceSheet = $null
        Release-ComReference -Value $afterSheet
        $afterSheet = $null
        Release-ComReference -Value $targetSheets
        $targetSheets = $null
      }
      if ($visibilityRestoreFailed) { throw 'EXCEL_SHEET_COPY_FAILED' }

      try {
        $targetSheets = $TargetWorkbook.Sheets
        if ([int]$targetSheets.Count -ne ($beforeCount + 1)) { throw 'EXCEL_SHEET_COPY_FAILED' }
        $copiedSheet = $targetSheets.Item($beforeCount + 1)
        $expectedTemporaryName = Truncate-ExcelSheetName -Value ($TemporaryPrefix + ($SourceIndex + 1) + '_' + ($sheetOffset + 1)) -Length 31
        if (-not [string]::Equals([string]$copiedSheet.Name, $expectedTemporaryName, [System.StringComparison]::Ordinal)) {
          $copiedSheet.Name = $expectedTemporaryName
        }
      }
      catch {
        $code = Get-SafeErrorCode -ErrorValue $_ -Fallback 'EXCEL_SHEET_NAME_FAILED'
        throw $code
      }
      finally {
        Release-ComReference -Value $copiedSheet
        $copiedSheet = $null
        Release-ComReference -Value $targetSheets
        $targetSheets = $null
      }
    }
    return $copiedStart
  }
  finally {
    Release-ComReference -Value $copiedSheet
    Release-ComReference -Value $afterSheet
    Release-ComReference -Value $targetSheets
    Release-ComReference -Value $sourceSheet
  }
}

function Get-ExcelWorksheetDataBounds {
  param([object]$Worksheet)
  $cells = $null
  $anchor = $null
  $lastRowCell = $null
  $lastColumnCell = $null
  try {
    $cells = $Worksheet.Cells
    $anchor = $cells.Item(1, 1)
    $lastRowCell = $cells.Find('*', $anchor, -4123, 2, 1, 2, $false, $false, $false)
    $lastColumnCell = $cells.Find('*', $anchor, -4123, 2, 2, 2, $false, $false, $false)
    if ($null -eq $lastRowCell -and $null -eq $lastColumnCell) {
      return [pscustomobject]@{ rowCount = 0; columnCount = 0 }
    }
    if ($null -eq $lastRowCell -or $null -eq $lastColumnCell) { throw 'EXCEL_COMBINED_SHEET_FAILED' }
    $rowCount = [int]$lastRowCell.Row
    $columnCount = [int]$lastColumnCell.Column
    if ($rowCount -lt 1 -or $rowCount -gt 1048576 -or $columnCount -lt 1 -or $columnCount -gt 16384) {
      throw 'EXCEL_COMBINED_SHEET_FAILED'
    }
    return [pscustomobject]@{ rowCount = $rowCount; columnCount = $columnCount }
  }
  catch {
    $code = Get-SafeErrorCode -ErrorValue $_ -Fallback 'EXCEL_COMBINED_SHEET_FAILED'
    throw $code
  }
  finally {
    Release-ComReference -Value $lastColumnCell
    Release-ComReference -Value $lastRowCell
    Release-ComReference -Value $anchor
    Release-ComReference -Value $cells
  }
}

function ConvertTo-NormalizedExcelHeaderValue {
  param([object]$Value)
  if ($null -eq $Value -or $Value -is [System.DBNull]) { return '' }
  try {
    $text = [System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture)
    $text = $text.Normalize([System.Text.NormalizationForm]::FormKC)
    $text = [System.Text.RegularExpressions.Regex]::Replace($text, '\s+', ' ').Trim()
    return $text.ToUpperInvariant()
  }
  catch { throw 'EXCEL_COMBINED_SHEET_FAILED' }
}

function Get-ExcelNormalizedHeaderValues {
  param([object]$Worksheet, [int]$ColumnCount)
  $cells = $null
  $cell = $null
  try {
    if ($ColumnCount -lt 1 -or $ColumnCount -gt 16384) { throw 'EXCEL_COMBINED_SHEET_FAILED' }
    $headers = New-Object System.Collections.Generic.List[string]
    $cells = $Worksheet.Cells
    for ($column = 1; $column -le $ColumnCount; $column += 1) {
      try {
        $cell = $cells.Item(1, $column)
        $headers.Add((ConvertTo-NormalizedExcelHeaderValue -Value $cell.Value2))
      }
      finally {
        Release-ComReference -Value $cell
        $cell = $null
      }
    }
    return [string[]]$headers.ToArray()
  }
  catch {
    $code = Get-SafeErrorCode -ErrorValue $_ -Fallback 'EXCEL_COMBINED_SHEET_FAILED'
    throw $code
  }
  finally {
    Release-ComReference -Value $cell
    Release-ComReference -Value $cells
  }
}

function Test-ExcelHeaderValuesEqual {
  param([string[]]$Left, [string[]]$Right)
  if ($Left.Count -ne $Right.Count) { return $false }
  for ($index = 0; $index -lt $Left.Count; $index += 1) {
    if (-not [string]::Equals([string]$Left[$index], [string]$Right[$index], [System.StringComparison]::Ordinal)) {
      return $false
    }
  }
  return $true
}

function Add-ExcelCombinedSheet {
  param(
    [object]$Excel,
    [object]$Workbook,
    [hashtable]$UsedNames,
    [int]$OriginalSheetCount,
    [string]$CancelPath,
    [string]$RequestedName
  )
  $sheets = $null
  $beforeSheet = $null
  $combinedSheet = $null
  $sourceSheet = $null
  $sourceCells = $null
  $sourceTopLeft = $null
  $sourceBottomRight = $null
  $sourceRange = $null
  $destinationCells = $null
  $destinationCell = $null
  $destinationBottomRight = $null
  $destinationRange = $null
  try {
    Assert-NotCancelled -CancelPath $CancelPath
    $sheets = $Workbook.Sheets
    if ([int]$sheets.Count -ne $OriginalSheetCount -or $OriginalSheetCount -lt 1) {
      throw 'EXCEL_COMBINED_SHEET_FAILED'
    }
    $beforeSheet = $sheets.Item(1)
    try { $combinedSheet = $sheets.Add($beforeSheet, [System.Type]::Missing, 1, -4167) }
    catch { throw 'EXCEL_COMBINED_SHEET_FAILED' }
    $combinedBaseName = if ([string]::IsNullOrWhiteSpace($RequestedName)) {
      -join @([char]0xC804, [char]0xCCB4, [char]0x20, [char]0xD1B5, [char]0xD569)
    } else { [string]$RequestedName }
    $combinedName = Get-UniqueExcelSheetName -Value $combinedBaseName -UsedNames $UsedNames -FallbackIndex 1
    try {
      $combinedSheet.Name = $combinedName
      $combinedSheet.Visible = -1
    }
    catch { throw 'EXCEL_COMBINED_SHEET_FAILED' }

    $expectedHeader = $null
    $combinedRowCount = 0
    $combinedColumnCount = 0
    for ($sheetIndex = 2; $sheetIndex -le ($OriginalSheetCount + 1); $sheetIndex += 1) {
      Assert-NotCancelled -CancelPath $CancelPath
      try {
        $sourceSheet = $sheets.Item($sheetIndex)
        if ((Get-ExcelSheetType -Sheet $sourceSheet) -ne 'worksheet') { continue }
        $bounds = Get-ExcelWorksheetDataBounds -Worksheet $sourceSheet
        if ([int]$bounds.rowCount -lt 1) { continue }
        $headers = @(Get-ExcelNormalizedHeaderValues -Worksheet $sourceSheet -ColumnCount ([int]$bounds.columnCount))
        if ($null -eq $expectedHeader) {
          $headerHasContent = @($headers | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0
          if (-not $headerHasContent) { throw 'EXCEL_COMBINED_HEADER_MISSING' }
          $expectedHeader = [string[]]$headers
          $combinedColumnCount = [int]$bounds.columnCount
          $sourceStartRow = 1
        }
        else {
          if (-not (Test-ExcelHeaderValuesEqual -Left ([string[]]$expectedHeader) -Right ([string[]]$headers))) {
            throw 'EXCEL_COMBINED_HEADER_MISMATCH'
          }
          $sourceStartRow = 2
        }
        if ([int]$bounds.rowCount -lt $sourceStartRow) { continue }

        $sourceCells = $sourceSheet.Cells
        $sourceTopLeft = $sourceCells.Item($sourceStartRow, 1)
        $sourceBottomRight = $sourceCells.Item([int]$bounds.rowCount, [int]$bounds.columnCount)
        $sourceRange = $sourceSheet.Range($sourceTopLeft, $sourceBottomRight)
        $destinationCells = $combinedSheet.Cells
        $rowsToCopy = [int]$bounds.rowCount - $sourceStartRow + 1
        if (($combinedRowCount + $rowsToCopy) -gt 1048576) { throw 'EXCEL_COMBINED_ROW_LIMIT_EXCEEDED' }
        $destinationCell = $destinationCells.Item($combinedRowCount + 1, 1)
        $destinationBottomRight = $destinationCells.Item($combinedRowCount + $rowsToCopy, [int]$bounds.columnCount)
        $destinationRange = $combinedSheet.Range($destinationCell, $destinationBottomRight)
        try {
          $destinationRange.Value2 = $sourceRange.Value2
          [void]$sourceRange.Copy()
          [void]$destinationRange.PasteSpecial(-4122)
        }
        catch { throw 'EXCEL_COMBINED_SHEET_FAILED' }
        $combinedRowCount += $rowsToCopy
      }
      finally {
        Release-ComReference -Value $destinationRange
        $destinationRange = $null
        Release-ComReference -Value $destinationBottomRight
        $destinationBottomRight = $null
        Release-ComReference -Value $destinationCell
        $destinationCell = $null
        Release-ComReference -Value $destinationCells
        $destinationCells = $null
        Release-ComReference -Value $sourceRange
        $sourceRange = $null
        Release-ComReference -Value $sourceBottomRight
        $sourceBottomRight = $null
        Release-ComReference -Value $sourceTopLeft
        $sourceTopLeft = $null
        Release-ComReference -Value $sourceCells
        $sourceCells = $null
        Release-ComReference -Value $sourceSheet
        $sourceSheet = $null
      }
    }
    if ($null -eq $expectedHeader) { throw 'EXCEL_COMBINED_HEADER_MISSING' }
    try { $Excel.CutCopyMode = $false } catch {}
    return [pscustomobject]@{
      combinedSheetAdded = $true
      combinedSheetName = $combinedName
      combinedRowCount = [int]$combinedRowCount
      combinedColumnCount = [int]$combinedColumnCount
      combinedDataMode = 'calculated-values-with-cell-formatting'
      normalizedHeader = if ($null -eq $expectedHeader) { [string[]]@() } else { [string[]]$expectedHeader }
    }
  }
  catch {
    $code = Get-SafeErrorCode -ErrorValue $_ -Fallback 'EXCEL_COMBINED_SHEET_FAILED'
    throw $code
  }
  finally {
    try { $Excel.CutCopyMode = $false } catch {}
    Release-ComReference -Value $destinationRange
    Release-ComReference -Value $destinationBottomRight
    Release-ComReference -Value $destinationCell
    Release-ComReference -Value $destinationCells
    Release-ComReference -Value $sourceRange
    Release-ComReference -Value $sourceBottomRight
    Release-ComReference -Value $sourceTopLeft
    Release-ComReference -Value $sourceCells
    Release-ComReference -Value $sourceSheet
    Release-ComReference -Value $combinedSheet
    Release-ComReference -Value $beforeSheet
    Release-ComReference -Value $sheets
  }
}

function Verify-ExcelOutput {
  param(
    [object]$Excel,
    [string]$Path,
    [string[]]$ExpectedNames,
    [string[]]$ExpectedTypes,
    [string[]]$ExpectedVisibility,
    [object]$ExpectedCombined
  )
  $workbooks = $null
  $workbook = $null
  $sheets = $null
  $sheet = $null
  try {
    $workbooks = $Excel.Workbooks
    $workbook = Open-ExcelReadOnly -Workbooks $workbooks -InputPath $Path
    Assert-ExcelNoMacros -Workbook $workbook
    Assert-ExcelWorkbookSecurity -Workbook $workbook
    $sheets = $workbook.Sheets
    if ([int]$sheets.Count -ne $ExpectedNames.Count -or $ExpectedNames.Count -lt 1) { throw 'EXCEL_OUTPUT_VERIFY_FAILED' }
    $names = New-Object System.Collections.Generic.List[string]
    $types = New-Object System.Collections.Generic.List[string]
    $visibility = New-Object System.Collections.Generic.List[string]
    for ($index = 1; $index -le [int]$sheets.Count; $index += 1) {
      try {
        $sheet = $sheets.Item($index)
        $actualName = [string]$sheet.Name
        $actualType = Get-ExcelSheetType -Sheet $sheet
        $actualVisibility = Get-ExcelVisibility -Sheet $sheet
        if ((-not [string]::Equals($actualName, $ExpectedNames[$index - 1], [System.StringComparison]::Ordinal)) -or
          (-not [string]::Equals($actualType, $ExpectedTypes[$index - 1], [System.StringComparison]::Ordinal)) -or
          (-not [string]::Equals($actualVisibility, $ExpectedVisibility[$index - 1], [System.StringComparison]::Ordinal))) {
          throw 'EXCEL_OUTPUT_VERIFY_FAILED'
        }
        $names.Add($actualName)
        $types.Add($actualType)
        $visibility.Add($actualVisibility)
      }
      finally {
        Release-ComReference -Value $sheet
        $sheet = $null
      }
    }
    $combinedSheetAdded = $null -ne $ExpectedCombined -and [bool]$ExpectedCombined.combinedSheetAdded
    $combinedSheetName = ''
    $combinedRowCount = 0
    $combinedColumnCount = 0
    if ($combinedSheetAdded) {
      try {
        $sheet = $sheets.Item(1)
        if ((Get-ExcelSheetType -Sheet $sheet) -ne 'worksheet') { throw 'EXCEL_COMBINED_OUTPUT_VERIFY_FAILED' }
        $bounds = Get-ExcelWorksheetDataBounds -Worksheet $sheet
        $combinedSheetName = [string]$sheet.Name
        $combinedRowCount = [int]$bounds.rowCount
        $combinedColumnCount = [int]$bounds.columnCount
        if ((-not [string]::Equals($combinedSheetName, [string]$ExpectedCombined.combinedSheetName, [System.StringComparison]::Ordinal)) -or
          $combinedRowCount -ne [int]$ExpectedCombined.combinedRowCount -or
          $combinedColumnCount -ne [int]$ExpectedCombined.combinedColumnCount) {
          throw 'EXCEL_COMBINED_OUTPUT_VERIFY_FAILED'
        }
        if ($combinedColumnCount -gt 0) {
          $actualHeader = @(Get-ExcelNormalizedHeaderValues -Worksheet $sheet -ColumnCount $combinedColumnCount)
          $expectedHeader = @($ExpectedCombined.normalizedHeader)
          if (-not (Test-ExcelHeaderValuesEqual -Left ([string[]]$actualHeader) -Right ([string[]]$expectedHeader))) {
            throw 'EXCEL_COMBINED_OUTPUT_VERIFY_FAILED'
          }
        }
        elseif (@($ExpectedCombined.normalizedHeader).Count -ne 0) { throw 'EXCEL_COMBINED_OUTPUT_VERIFY_FAILED' }
      }
      finally {
        Release-ComReference -Value $sheet
        $sheet = $null
      }
    }
    return [pscustomobject]@{
      sheetCount = $names.Count
      sheetNames = [string[]]$names.ToArray()
      sheetTypes = [string[]]$types.ToArray()
      sheetVisibility = [string[]]$visibility.ToArray()
      externalLinkCount = [int](Get-ExcelExternalLinkCount -Workbook $workbook)
      combinedSheetAdded = [bool]$combinedSheetAdded
      combinedSheetName = $combinedSheetName
      combinedRowCount = [int]$combinedRowCount
      combinedColumnCount = [int]$combinedColumnCount
    }
  }
  catch {
    $code = Get-SafeErrorCode -ErrorValue $_ -Fallback 'EXCEL_OUTPUT_VERIFY_FAILED'
    throw $code
  }
  finally {
    Release-ComReference -Value $sheet
    Release-ComReference -Value $sheets
    if ($null -ne $workbook) {
      try { $workbook.Close($false) } catch {}
      Release-ComReference -Value $workbook -Final
    }
    Release-ComReference -Value $workbooks
  }
}

function Merge-ExcelWorkbooks {
  param([object]$Excel, [object]$Item, [string]$CancelPath)
  $workbooks = $null
  $targetWorkbook = $null
  $sourceWorkbook = $null
  $targetSheets = $null
  $sourceSheets = $null
  $sourceSheet = $null
  $sheet = $null
  $afterSheet = $null
  $stagingPath = ''
  $outputPath = ''
  $published = $false
  $combinedFacts = $null
  try {
    $rawInputPaths = @($Item.inputPaths)
    $identities = @($Item.expectedIdentities)
    if ($rawInputPaths.Count -lt 2 -or $rawInputPaths.Count -gt 500 -or $identities.Count -ne $rawInputPaths.Count) {
      throw 'INPUT_COUNT_INVALID'
    }
    $inputPaths = New-Object System.Collections.Generic.List[string]
    for ($index = 0; $index -lt $rawInputPaths.Count; $index += 1) {
      $inputPaths.Add((Resolve-InputPath -Path ([string]$rawInputPaths[$index]) -Kind 'excel' -ExpectedIdentity $identities[$index]))
    }
    $outputPath = Resolve-OutputPath -Path ([string]$Item.outputPath) -Kind 'excel' -InputPaths ([string[]]$inputPaths.ToArray())
    $addCombinedSheet = $false
    if ($null -ne $Item.PSObject.Properties['addCombinedSheet']) {
      if ($Item.addCombinedSheet -isnot [bool]) { throw 'INPUT_FORMAT_INVALID' }
      $addCombinedSheet = [bool]$Item.addCombinedSheet
    }
    $useFileNameAsSheetName = $false
    if ($null -ne $Item.PSObject.Properties['useFileNameAsSheetName']) {
      if ($Item.useFileNameAsSheetName -isnot [bool]) { throw 'INPUT_FORMAT_INVALID' }
      $useFileNameAsSheetName = [bool]$Item.useFileNameAsSheetName
    }
    $sourceFileNames = @($Item.sourceFileNames)
    if ($sourceFileNames.Count -ne $inputPaths.Count -or @($sourceFileNames | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
      throw 'INPUT_FORMAT_INVALID'
    }
    $requestedCombinedSheetName = ''
    if ($null -ne $Item.PSObject.Properties['combinedSheetName']) {
      if ($Item.combinedSheetName -isnot [string]) { throw 'INPUT_FORMAT_INVALID' }
      $requestedCombinedSheetName = [string]$Item.combinedSheetName
      if ($requestedCombinedSheetName.Length -gt 160) { throw 'INPUT_FORMAT_INVALID' }
    }
    $stagingPath = New-StagingPath -OutputPath $outputPath
    $workbooks = $Excel.Workbooks

    $sourceFacts = New-Object System.Collections.Generic.List[object]
    for ($index = 0; $index -lt $inputPaths.Count; $index += 1) {
      $sourceFacts.Add((Get-ExcelWorkbookFacts -Excel $Excel -InputPath $inputPaths[$index] -ExpectedIdentity $identities[$index] -CancelPath $CancelPath))
    }

    $usedNames = @{}
    $expectedNames = New-Object System.Collections.Generic.List[string]
    $expectedTypes = New-Object System.Collections.Generic.List[string]
    $expectedVisibility = New-Object System.Collections.Generic.List[string]
    $temporaryPrefix = 'CMOE_' + [Guid]::NewGuid().ToString('N').Substring(0, 12) + '_'
    $physicalBase = [string]::Equals((Get-NormalizedExtension -Path $inputPaths[0]), '.xlsx', [System.StringComparison]::OrdinalIgnoreCase)
    $baseStrategy = if ($physicalBase) { 'physical-first-xlsx' } else { 'new-workbook-compatibility' }
    $defaultSheetCount = 0
    $firstSourceToCopy = 0

    Assert-NotCancelled -CancelPath $CancelPath
    if ($physicalBase) {
      Assert-InputIdentity -Path $inputPaths[0] -ExpectedIdentity $identities[0]
      try { [System.IO.File]::Copy($inputPaths[0], $stagingPath, $false) }
      catch { throw 'EXCEL_BASE_COPY_FAILED' }
      try {
        $attributes = [System.IO.File]::GetAttributes($stagingPath)
        if (($attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
          $writable = [System.IO.FileAttributes]([int]$attributes -band (-bnot [int][System.IO.FileAttributes]::ReadOnly))
          [System.IO.File]::SetAttributes($stagingPath, $writable)
        }
      }
      catch { throw 'EXCEL_BASE_COPY_FAILED' }
      $targetWorkbook = Open-ExcelWritable -Workbooks $workbooks -InputPath $stagingPath
      if ([bool]$targetWorkbook.ReadOnly) { throw 'EXCEL_BASE_COPY_FAILED' }
      Assert-ExcelNoMacros -Workbook $targetWorkbook
      Assert-ExcelWorkbookSecurity -Workbook $targetWorkbook
      try { $targetWorkbook.CheckCompatibility = $false } catch {}
      $targetSheets = $targetWorkbook.Sheets
      if ([int]$targetSheets.Count -ne [int]$sourceFacts[0].sheetCount) { throw 'INPUT_IDENTITY_CHANGED' }
      for ($sheetOffset = 0; $sheetOffset -lt [int]$targetSheets.Count; $sheetOffset += 1) {
        $sourceSheetFact = @($sourceFacts[0].sheets)[$sheetOffset]
        try {
          $sheet = $targetSheets.Item($sheetOffset + 1)
          $actualName = [string]$sheet.Name
          $actualType = Get-ExcelSheetType -Sheet $sheet
          $actualVisibility = Get-ExcelVisibility -Sheet $sheet
          if ((-not [string]::Equals($actualName, [string]$sourceSheetFact.name, [System.StringComparison]::Ordinal)) -or
            (-not [string]::Equals($actualType, [string]$sourceSheetFact.type, [System.StringComparison]::Ordinal)) -or
            (-not [string]::Equals($actualVisibility, [string]$sourceSheetFact.visibility, [System.StringComparison]::Ordinal))) {
            throw 'INPUT_IDENTITY_CHANGED'
          }
          $requestedName = if ($useFileNameAsSheetName -and [int]$sourceFacts[0].sheetCount -eq 1) {
            [System.IO.Path]::GetFileNameWithoutExtension([string]$sourceFileNames[0])
          } else { $actualName }
          $desiredName = Get-UniqueExcelSheetName -Value $requestedName -UsedNames $usedNames -FallbackIndex ($expectedNames.Count + 1)
          if (-not [string]::Equals($actualName, $desiredName, [System.StringComparison]::Ordinal)) {
            try { $sheet.Name = $desiredName }
            catch { throw 'EXCEL_SHEET_NAME_FAILED' }
          }
          $expectedNames.Add($desiredName)
          $expectedTypes.Add($actualType)
          $expectedVisibility.Add($actualVisibility)
        }
        finally {
          Release-ComReference -Value $sheet
          $sheet = $null
        }
      }
      Release-ComReference -Value $targetSheets
      $targetSheets = $null
      # The individual-copy fallback reopens this checkpoint. Persist a
      # file-name-based rename on the physical base before that can happen.
      try { $targetWorkbook.Save() }
      catch { throw 'EXCEL_SAVE_FAILED' }
      $firstSourceToCopy = 1
    }
    else {
      try { $targetWorkbook = $workbooks.Add() }
      catch { throw 'EXCEL_MERGE_FAILED' }
      try { $targetWorkbook.CheckCompatibility = $false } catch {}
      $targetSheets = $targetWorkbook.Sheets
      $defaultSheetCount = [int]$targetSheets.Count
      Release-ComReference -Value $targetSheets
      $targetSheets = $null
      try { $targetWorkbook.SaveAs($stagingPath, 51) }
      catch { throw 'EXCEL_SAVE_FAILED' }
    }

    for ($sourceIndex = $firstSourceToCopy; $sourceIndex -lt $inputPaths.Count; $sourceIndex += 1) {
      Assert-NotCancelled -CancelPath $CancelPath
      Assert-InputIdentity -Path $inputPaths[$sourceIndex] -ExpectedIdentity $identities[$sourceIndex]
      try { $sourceWorkbook = Open-ExcelReadOnly -Workbooks $workbooks -InputPath $inputPaths[$sourceIndex] }
      catch { throw 'EXCEL_INPUT_OPEN_FAILED' }
      Assert-ExcelNoMacros -Workbook $sourceWorkbook
      Assert-ExcelWorkbookSecurity -Workbook $sourceWorkbook
      $sourceSheets = $sourceWorkbook.Sheets
      $sourceSheetCount = [int]$sourceSheets.Count
      if ($sourceSheetCount -ne [int]$sourceFacts[$sourceIndex].sheetCount -or $sourceSheetCount -lt 1) {
        throw 'INPUT_IDENTITY_CHANGED'
      }
      $targetSheets = $targetWorkbook.Sheets
      $beforeCount = [int]$targetSheets.Count
      Release-ComReference -Value $targetSheets
      $targetSheets = $null
      $copiedIndividually = $sourceSheetCount -eq 1 -or (Test-ExcelWorkbookHasListObjects -Workbook $sourceWorkbook)

      if (-not $copiedIndividually) {
        $targetSheets = $targetWorkbook.Sheets
        $afterSheet = $targetSheets.Item($beforeCount)
        $restoreAfterVisibility = $false
        $afterVisibility = -1
        try {
          $afterVisibility = [int]$afterSheet.Visible
          if ($afterVisibility -ne -1) {
            $afterSheet.Visible = -1
            $restoreAfterVisibility = $true
          }
          [void]$sourceSheets.Copy([System.Type]::Missing, $afterSheet)
        }
        catch { $copiedIndividually = $true }
        finally {
          if ($restoreAfterVisibility -and $null -ne $afterSheet) {
            try { $afterSheet.Visible = $afterVisibility }
            catch { $copiedIndividually = $true }
          }
          Release-ComReference -Value $afterSheet
          $afterSheet = $null
          Release-ComReference -Value $targetSheets
          $targetSheets = $null
        }
      }

      if ($copiedIndividually) {
        # Reopen the last verified checkpoint so a failed grouped copy cannot
        # leave partial sheets, names, or workbook-scoped objects behind.
        try { $targetWorkbook.Close($false) } catch {}
        Release-ComReference -Value $targetWorkbook -Final
        $targetWorkbook = $null
        $targetWorkbook = Open-ExcelWritable -Workbooks $workbooks -InputPath $stagingPath
        if ([bool]$targetWorkbook.ReadOnly) { throw 'EXCEL_BASE_COPY_FAILED' }
        try { $targetWorkbook.CheckCompatibility = $false } catch {}
        $copiedStart = Copy-ExcelSheetsIndividually `
          -SourceSheets $sourceSheets `
          -TargetWorkbook $targetWorkbook `
          -SourceSheetCount $sourceSheetCount `
          -TemporaryPrefix $temporaryPrefix `
          -SourceIndex $sourceIndex `
          -CancelPath $CancelPath
        Repair-ExcelCopiedSelfLinks -Workbook $targetWorkbook -SourcePath ([string]$sourceWorkbook.FullName)
      }
      else { $copiedStart = $beforeCount + 1 }

      $targetSheets = $targetWorkbook.Sheets
      if ([int]$targetSheets.Count -ne ($beforeCount + $sourceSheetCount)) { throw 'EXCEL_SHEET_COPY_FAILED' }

      if (-not $physicalBase -and $sourceIndex -eq 0) {
        for ($deleteIndex = 0; $deleteIndex -lt $defaultSheetCount; $deleteIndex += 1) {
          try {
            $sheet = $targetSheets.Item(1)
            $sheet.Delete()
          }
          finally {
            Release-ComReference -Value $sheet
            $sheet = $null
          }
        }
      }
      Release-ComReference -Value $targetSheets
      $targetSheets = $null
      $targetSheets = $targetWorkbook.Sheets
      $copiedStart = [int]$targetSheets.Count - $sourceSheetCount + 1

      for ($sheetOffset = 0; $sheetOffset -lt $sourceSheetCount; $sheetOffset += 1) {
        try {
          $sheet = $targetSheets.Item($copiedStart + $sheetOffset)
          $sheet.Name = Truncate-ExcelSheetName -Value ($temporaryPrefix + ($sourceIndex + 1) + '_' + ($sheetOffset + 1)) -Length 31
        }
        catch { throw 'EXCEL_SHEET_NAME_FAILED' }
        finally {
          Release-ComReference -Value $sheet
          $sheet = $null
        }
      }

      for ($sheetOffset = 0; $sheetOffset -lt $sourceSheetCount; $sheetOffset += 1) {
        $sourceSheetFact = @($sourceFacts[$sourceIndex].sheets)[$sheetOffset]
        $requestedName = if ($useFileNameAsSheetName -and $sourceSheetCount -eq 1) {
          [System.IO.Path]::GetFileNameWithoutExtension([string]$sourceFileNames[$sourceIndex])
        } else { [string]$sourceSheetFact.name }
        $desiredName = Get-UniqueExcelSheetName -Value $requestedName -UsedNames $usedNames -FallbackIndex ($expectedNames.Count + 1)
        try {
          $sheet = $targetSheets.Item($copiedStart + $sheetOffset)
          $sheet.Name = $desiredName
          $actualType = Get-ExcelSheetType -Sheet $sheet
          $actualVisibility = Get-ExcelVisibility -Sheet $sheet
          if ((-not [string]::Equals($actualType, [string]$sourceSheetFact.type, [System.StringComparison]::Ordinal)) -or
            (-not [string]::Equals($actualVisibility, [string]$sourceSheetFact.visibility, [System.StringComparison]::Ordinal))) {
            throw 'EXCEL_SHEET_COPY_FAILED'
          }
          $expectedNames.Add($desiredName)
          $expectedTypes.Add($actualType)
          $expectedVisibility.Add($actualVisibility)
        }
        catch {
          $code = Get-SafeErrorCode -ErrorValue $_ -Fallback 'EXCEL_SHEET_NAME_FAILED'
          throw $code
        }
        finally {
          Release-ComReference -Value $sheet
          $sheet = $null
        }
      }
      Release-ComReference -Value $targetSheets
      $targetSheets = $null
      Release-ComReference -Value $sourceSheets
      $sourceSheets = $null
      try { $sourceWorkbook.Close($false) } catch {}
      Release-ComReference -Value $sourceWorkbook -Final
      $sourceWorkbook = $null
      try { $targetWorkbook.Save() }
      catch { throw 'EXCEL_SAVE_FAILED' }
    }

    if ($addCombinedSheet) {
      $combinedFacts = Add-ExcelCombinedSheet `
        -Excel $Excel `
        -Workbook $targetWorkbook `
        -UsedNames $usedNames `
        -OriginalSheetCount $expectedNames.Count `
        -CancelPath $CancelPath `
        -RequestedName $requestedCombinedSheetName
      $expectedNames.Insert(0, [string]$combinedFacts.combinedSheetName)
      $expectedTypes.Insert(0, 'worksheet')
      $expectedVisibility.Insert(0, 'visible')
    }

    Assert-NotCancelled -CancelPath $CancelPath
    try { $targetWorkbook.Save() }
    catch { throw 'EXCEL_SAVE_FAILED' }
    try { $targetWorkbook.Close($false) } catch {}
    Release-ComReference -Value $targetWorkbook -Final
    $targetWorkbook = $null

    $stagingFacts = Verify-ExcelOutput -Excel $Excel -Path $stagingPath -ExpectedNames ([string[]]$expectedNames.ToArray()) -ExpectedTypes ([string[]]$expectedTypes.ToArray()) -ExpectedVisibility ([string[]]$expectedVisibility.ToArray()) -ExpectedCombined $combinedFacts
    Assert-NotCancelled -CancelPath $CancelPath
    if ([System.IO.File]::Exists($outputPath)) { throw 'OUTPUT_EXISTS' }
    try { [System.IO.File]::Move($stagingPath, $outputPath) }
    catch { throw 'OUTPUT_PUBLISH_FAILED' }
    $stagingPath = ''
    $published = $true
    $finalFacts = Verify-ExcelOutput -Excel $Excel -Path $outputPath -ExpectedNames ([string[]]$expectedNames.ToArray()) -ExpectedTypes ([string[]]$expectedTypes.ToArray()) -ExpectedVisibility ([string[]]$expectedVisibility.ToArray()) -ExpectedCombined $combinedFacts
    if ([int]$finalFacts.sheetCount -ne [int]$stagingFacts.sheetCount) { throw 'EXCEL_OUTPUT_VERIFY_FAILED' }
    return [pscustomobject]@{
      outputPath = $outputPath
      sourceCount = $inputPaths.Count
      sourceSheetCounts = [int[]]@($sourceFacts.ToArray() | ForEach-Object { [int]$_.sheetCount })
      sheetCount = [int]$finalFacts.sheetCount
      sheetNames = [string[]]$finalFacts.sheetNames
      sheetTypes = [string[]]$finalFacts.sheetTypes
      sheetVisibility = [string[]]$finalFacts.sheetVisibility
      externalLinkCount = [int]$finalFacts.externalLinkCount
      baseStrategy = $baseStrategy
      combinedSheetAdded = [bool]$finalFacts.combinedSheetAdded
      combinedSheetName = [string]$finalFacts.combinedSheetName
      combinedRowCount = [int]$finalFacts.combinedRowCount
      combinedColumnCount = [int]$finalFacts.combinedColumnCount
      combinedDataMode = if ([bool]$finalFacts.combinedSheetAdded) { 'calculated-values-with-cell-formatting' } else { '' }
    }
  }
  catch {
    if ($published -and -not [string]::IsNullOrWhiteSpace($outputPath)) {
      try { if ([System.IO.File]::Exists($outputPath)) { [System.IO.File]::Delete($outputPath) } } catch {}
    }
    $code = Get-SafeErrorCode -ErrorValue $_ -Fallback 'EXCEL_MERGE_FAILED'
    throw $code
  }
  finally {
    Release-ComReference -Value $afterSheet
    Release-ComReference -Value $sourceSheet
    Release-ComReference -Value $sheet
    Release-ComReference -Value $sourceSheets
    Release-ComReference -Value $targetSheets
    if ($null -ne $sourceWorkbook) {
      try { $sourceWorkbook.Close($false) } catch {}
      Release-ComReference -Value $sourceWorkbook -Final
    }
    if ($null -ne $targetWorkbook) {
      try { $targetWorkbook.Close($false) } catch {}
      Release-ComReference -Value $targetWorkbook -Final
    }
    Release-ComReference -Value $workbooks
    if (-not [string]::IsNullOrWhiteSpace($stagingPath)) {
      try { if ([System.IO.File]::Exists($stagingPath)) { [System.IO.File]::Delete($stagingPath) } } catch {}
    }
  }
}

$job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
$resultPath = [string]$job.resultPath
if ([string]::IsNullOrWhiteSpace($resultPath)) { throw 'MISSING_RESULT_PATH' }
$resultPath = [System.IO.Path]::GetFullPath($resultPath)
$resultDirectory = [System.IO.Path]::GetDirectoryName($resultPath)
if (-not [System.IO.Directory]::Exists($resultDirectory)) { throw 'MISSING_RESULT_PATH' }
$cancelPath = if ($null -ne $job.PSObject.Properties['cancelPath']) { [string]$job.cancelPath } else { '' }
$operation = [string]$job.operation
$isWord = $operation -in @('inspect-word', 'merge-word')
$isExcel = $operation -in @('inspect-excel', 'merge-excel')

$application = $null
$fatalError = $null
$results = New-Object System.Collections.Generic.List[object]
$startedApplication = $false
$originalAutomationSecurity = $null
$originalDisplayAlerts = $null
$originalUpdateLinksAtOpen = $null
$originalEnableEvents = $null
$originalAskToUpdateLinks = $null
$originalAlertBeforeOverwriting = $null
$originalCalculation = $null
$originalCalculateBeforeSave = $null

try {
  Assert-NotCancelled -CancelPath $cancelPath
  if (-not $isWord -and -not $isExcel) { throw 'UNSUPPORTED_OPERATION' }
  if ($isWord -and @(Get-Process -Name 'WINWORD' -ErrorAction SilentlyContinue).Count -gt 0) { throw 'WORD_IN_USE' }
  if ($isExcel -and @(Get-Process -Name 'EXCEL' -ErrorAction SilentlyContinue).Count -gt 0) { throw 'EXCEL_IN_USE' }

  try {
    if ($isWord) { $application = New-Object -ComObject Word.Application }
    else { $application = New-Object -ComObject Excel.Application }
    $startedApplication = $true
  }
  catch {
    if ($isWord) { throw 'WORD_START_FAILED' }
    throw 'EXCEL_START_FAILED'
  }

  try { $originalAutomationSecurity = $application.AutomationSecurity } catch {}
  try { $originalDisplayAlerts = $application.DisplayAlerts } catch {}
  try { $application.AutomationSecurity = 3 } catch {}
  if ($isWord) {
    try { $originalUpdateLinksAtOpen = $application.Options.UpdateLinksAtOpen } catch {}
    try { $application.Visible = $false } catch {}
    try { $application.DisplayAlerts = 0 } catch {}
    try { $application.Options.UpdateLinksAtOpen = $false } catch {}
  }
  else {
    try { $originalEnableEvents = $application.EnableEvents } catch {}
    try { $originalAskToUpdateLinks = $application.AskToUpdateLinks } catch {}
    try { $originalAlertBeforeOverwriting = $application.AlertBeforeOverwriting } catch {}
    try { $originalCalculation = $application.Calculation } catch {}
    try { $originalCalculateBeforeSave = $application.CalculateBeforeSave } catch {}
    try { $application.Visible = $false } catch {}
    try { $application.DisplayAlerts = $false } catch {}
    try { $application.EnableEvents = $false } catch {}
    try { $application.AskToUpdateLinks = $false } catch {}
    try { $application.AlertBeforeOverwriting = $false } catch {}
    try { $application.Calculation = -4135 } catch {}
    try { $application.CalculateBeforeSave = $false } catch {}
  }

  $items = @($job.items)
  if ($items.Count -lt 1 -or $items.Count -gt 500) { throw 'INPUT_COUNT_INVALID' }
  for ($index = 0; $index -lt $items.Count; $index += 1) {
    Assert-NotCancelled -CancelPath $cancelPath
    $item = $items[$index]
    try {
      if ($operation -eq 'inspect-word') {
        $inputPath = Resolve-InputPath -Path ([string]$item.inputPath) -Kind 'word' -ExpectedIdentity $item.expectedIdentity
        $facts = Get-WordDocumentFacts -Word $application -InputPath $inputPath -ExpectedIdentity $item.expectedIdentity -CancelPath $cancelPath
        $result = [pscustomobject]@{
          ok = $true
          index = $index
          pageCount = [int]$facts.pageCount
          sectionCount = [int]$facts.sectionCount
          revisionCount = [int]$facts.revisionCount
          commentCount = [int]$facts.commentCount
        }
      }
      elseif ($operation -eq 'inspect-excel') {
        $inputPath = Resolve-InputPath -Path ([string]$item.inputPath) -Kind 'excel' -ExpectedIdentity $item.expectedIdentity
        $facts = Get-ExcelWorkbookFacts -Excel $application -InputPath $inputPath -ExpectedIdentity $item.expectedIdentity -CancelPath $cancelPath
        $result = [pscustomobject]@{
          ok = $true
          index = $index
          sheetCount = [int]$facts.sheetCount
          sheets = [object[]]$facts.sheets
          externalLinkCount = [int]$facts.externalLinkCount
        }
      }
      elseif ($operation -eq 'merge-word') {
        $merged = Merge-WordDocuments -Word $application -Item $item -CancelPath $cancelPath
        $result = [pscustomobject]@{
          ok = $true
          index = $index
          outputPath = [string]$merged.outputPath
          sourceCount = [int]$merged.sourceCount
          sourcePageCounts = [int[]]$merged.sourcePageCounts
          pageCount = [int]$merged.pageCount
          sectionCount = [int]$merged.sectionCount
          headerFooterLinksDetached = [int]$merged.headerFooterLinksDetached
        }
      }
      else {
        $merged = Merge-ExcelWorkbooks -Excel $application -Item $item -CancelPath $cancelPath
        $result = [pscustomobject]@{
          ok = $true
          index = $index
          outputPath = [string]$merged.outputPath
          sourceCount = [int]$merged.sourceCount
          sourceSheetCounts = [int[]]$merged.sourceSheetCounts
          sheetCount = [int]$merged.sheetCount
          sheetNames = [string[]]$merged.sheetNames
          sheetTypes = [string[]]$merged.sheetTypes
          sheetVisibility = [string[]]$merged.sheetVisibility
          externalLinkCount = [int]$merged.externalLinkCount
          baseStrategy = [string]$merged.baseStrategy
          combinedSheetAdded = [bool]$merged.combinedSheetAdded
          combinedSheetName = [string]$merged.combinedSheetName
          combinedRowCount = [int]$merged.combinedRowCount
          combinedColumnCount = [int]$merged.combinedColumnCount
          combinedDataMode = [string]$merged.combinedDataMode
        }
      }
      $results.Add($result)
      $progress = [pscustomobject]@{ ok = $true; index = $index } | ConvertTo-Json -Compress
      [Console]::Out.WriteLine('CMOE_PROGRESS:' + $progress)
      [Console]::Out.Flush()
    }
    catch {
      $fallback = if ($isWord) { 'WORD_OPERATION_FAILED' } else { 'EXCEL_OPERATION_FAILED' }
      $errorCode = Get-SafeErrorCode -ErrorValue $_ -Fallback $fallback
      $result = [pscustomobject]@{ ok = $false; index = $index; error = $errorCode }
      $results.Add($result)
      $progress = $result | ConvertTo-Json -Compress
      [Console]::Out.WriteLine('CMOE_PROGRESS:' + $progress)
      [Console]::Out.Flush()
    }
  }
}
catch {
  $fatalError = Get-SafeErrorCode -ErrorValue $_ -Fallback $(if ($isWord) { 'WORD_START_FAILED' } else { 'EXCEL_START_FAILED' })
}
finally {
  if ($null -ne $application) {
    if ($null -ne $originalAutomationSecurity) { try { $application.AutomationSecurity = $originalAutomationSecurity } catch {} }
    if ($null -ne $originalDisplayAlerts) { try { $application.DisplayAlerts = $originalDisplayAlerts } catch {} }
    if ($isWord -and $null -ne $originalUpdateLinksAtOpen) {
      try { $application.Options.UpdateLinksAtOpen = $originalUpdateLinksAtOpen } catch {}
    }
    if ($isExcel) {
      if ($null -ne $originalEnableEvents) { try { $application.EnableEvents = $originalEnableEvents } catch {} }
      if ($null -ne $originalAskToUpdateLinks) { try { $application.AskToUpdateLinks = $originalAskToUpdateLinks } catch {} }
      if ($null -ne $originalAlertBeforeOverwriting) { try { $application.AlertBeforeOverwriting = $originalAlertBeforeOverwriting } catch {} }
      if ($null -ne $originalCalculation) { try { $application.Calculation = $originalCalculation } catch {} }
      if ($null -ne $originalCalculateBeforeSave) { try { $application.CalculateBeforeSave = $originalCalculateBeforeSave } catch {} }
    }
    if ($startedApplication) { try { $application.Quit() } catch {} }
    Release-ComReference -Value $application -Final
    $application = $null
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  Write-JsonFile -Path $resultPath -Value ([pscustomobject]@{
    ok = [string]::IsNullOrWhiteSpace([string]$fatalError)
    fatalError = $fatalError
    results = [object[]]$results.ToArray()
  })
}

if (-not [string]::IsNullOrWhiteSpace([string]$fatalError)) { exit 1 }
exit 0
