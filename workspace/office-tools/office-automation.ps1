param(
  [Parameter(Mandatory = $true)]
  [string]$JobFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 otherwise writes redirected output using the active
# system code page. Electron decodes the worker pipes as UTF-8, so make the
# contract explicit before emitting progress or diagnostic text.
try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [Console]::InputEncoding = $utf8NoBom
  [Console]::OutputEncoding = $utf8NoBom
  $OutputEncoding = $utf8NoBom
}
catch {}

function Write-JsonFile {
  param([string]$Path, [object]$Value)
  $json = $Value | ConvertTo-Json -Depth 8 -Compress
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Export-PresentationPdf {
  param([object]$Presentation, [string]$Path)

  try {
    # PrintRange is a required COM argument even though PowerPoint accepts
    # Nothing for it. Supplying the arguments through RangeType avoids the
    # parameter-count mismatch seen with the two-argument shorthand on some
    # Office versions.
    $Presentation.ExportAsFixedFormat($Path, 2, 1, 0, 1, 1, 0, $null, 1)
  }
  catch {
    # Older PowerPoint builds can still reject ExportAsFixedFormat through
    # late-bound COM. SaveAs PDF uses the same Office renderer and is a safe
    # compatibility fallback for the already validated temporary destination.
    try {
      if ([System.IO.File]::Exists($Path)) { [System.IO.File]::Delete($Path) }
      $Presentation.SaveAs($Path, 32, -1)
    }
    catch {
      throw 'POWERPOINT_PDF_EXPORT_FAILED'
    }
  }
}

function Assert-NotCancelled {
  param([string]$CancelPath)
  if (-not [string]::IsNullOrWhiteSpace($CancelPath) -and [System.IO.File]::Exists($CancelPath)) {
    throw 'DOCUMENT_TOOL_CANCELLED'
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

function Merge-Presentations {
  param([object]$PowerPoint, [string[]]$InputPaths, [string]$Path, [string]$CancelPath)

  $presentations = $null
  $presentation = $null
  $targetSlides = $null
  $targetDesigns = $null
  $targetPageSetup = $null
  $sourcePresentation = $null
  $sourceSlides = $null
  $sourceDesigns = $null
  $sourcePageSetup = $null
  $sourceDesign = $null
  $sourceSlide = $null
  $sourceSlideDesign = $null
  $sourceLayout = $null
  $targetSlide = $null
  $targetSlideDesign = $null
  $targetSlideLayout = $null
  $slideMaster = $null
  $customLayouts = $null
  $targetLayout = $null
  $clonedDesigns = @{}
  try {
    if ($InputPaths.Count -lt 2) { throw 'INPUT_COUNT_INVALID' }
    Assert-NotCancelled -CancelPath $CancelPath
    foreach ($candidate in $InputPaths) {
      if (-not [System.IO.File]::Exists([System.IO.Path]::GetFullPath($candidate))) { throw 'INPUT_NOT_FOUND' }
    }
    if ([System.IO.File]::Exists($Path)) { throw 'OUTPUT_EXISTS' }
    $outputDirectory = [System.IO.Path]::GetDirectoryName($Path)
    if (-not [System.IO.Directory]::Exists($outputDirectory)) { throw 'OUTPUT_DIRECTORY_NOT_FOUND' }

    # Keeping the first package as the physical base preserves its document
    # properties, masters, theme, embedded fonts, media and slide relations.
    # PowerPoint then owns every added relationship instead of trying to join
    # OPC zip parts by filename.
    [System.IO.File]::Copy([System.IO.Path]::GetFullPath($InputPaths[0]), $Path, $false)
    $attributes = [System.IO.File]::GetAttributes($Path)
    if (($attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
      $writableAttributes = [System.IO.FileAttributes]([int]$attributes -band (-bnot [int][System.IO.FileAttributes]::ReadOnly))
      [System.IO.File]::SetAttributes($Path, $writableAttributes)
    }
    Assert-NotCancelled -CancelPath $CancelPath

    $presentations = $PowerPoint.Presentations
    $presentation = $presentations.Open($Path, 0, 0, 0)
    if ([int]$presentation.ReadOnly -ne 0) { throw 'POWERPOINT_PPTX_OUTPUT_READ_ONLY' }
    $targetSlides = $presentation.Slides
    $targetDesigns = $presentation.Designs
    try {
      $targetPageSetup = $presentation.PageSetup
      $targetSlideWidth = [double]$targetPageSetup.SlideWidth
      $targetSlideHeight = [double]$targetPageSetup.SlideHeight
    }
    finally {
      Release-ComReference -Value $targetPageSetup
      $targetPageSetup = $null
    }
    if ([int]$targetSlides.Count -lt 1) { throw 'POWERPOINT_PPTX_MERGE_FAILED' }

    for ($sourceIndex = 1; $sourceIndex -lt $InputPaths.Count; $sourceIndex += 1) {
      Assert-NotCancelled -CancelPath $CancelPath
      $sourcePath = [System.IO.Path]::GetFullPath($InputPaths[$sourceIndex])
      $clonedDesigns = @{}
      $slideMetadata = New-Object System.Collections.Generic.List[object]
      try {
        $sourcePresentation = $presentations.Open($sourcePath, -1, 0, 0)
        $sourceSlides = $sourcePresentation.Slides
        $sourceDesigns = $sourcePresentation.Designs
        try {
          $sourcePageSetup = $sourcePresentation.PageSetup
          $sourceSlideWidth = [double]$sourcePageSetup.SlideWidth
          $sourceSlideHeight = [double]$sourcePageSetup.SlideHeight
        }
        finally {
          Release-ComReference -Value $sourcePageSetup
          $sourcePageSetup = $null
        }
        if ([Math]::Abs($sourceSlideWidth - $targetSlideWidth) -gt 0.01 -or [Math]::Abs($sourceSlideHeight - $targetSlideHeight) -gt 0.01) {
          throw 'POWERPOINT_PPTX_SIZE_MISMATCH'
        }
        $sourceSlideCount = [int]$sourceSlides.Count
        if ($sourceSlideCount -lt 1) { throw 'POWERPOINT_PPTX_MERGE_FAILED' }

        # InsertFromFile alone can map incoming placeholders onto the target
        # design. Clone each source design first, and remember each slide's
        # design/layout indexes so the inserted slide can be rebound to the cloned
        # master and custom layout without flattening media or animation.
        for ($designIndex = 1; $designIndex -le [int]$sourceDesigns.Count; $designIndex += 1) {
          Assert-NotCancelled -CancelPath $CancelPath
          $sourceDesign = $sourceDesigns.Item($designIndex)
          try {
            $appendIndex = [int]$targetDesigns.Count + 1
            $clonedDesign = $targetDesigns.Clone($sourceDesign, $appendIndex)
            if ($null -eq $clonedDesign) { throw 'POWERPOINT_PPTX_STYLE_REBIND_FAILED' }
            $clonedDesigns[[string]$designIndex] = $clonedDesign
            $clonedDesign = $null
          }
          catch { throw 'POWERPOINT_PPTX_STYLE_REBIND_FAILED' }
          finally {
            Release-ComReference -Value $sourceDesign
            $sourceDesign = $null
          }
        }

        for ($slideIndex = 1; $slideIndex -le $sourceSlideCount; $slideIndex += 1) {
          Assert-NotCancelled -CancelPath $CancelPath
          try {
            $sourceSlide = $sourceSlides.Item($slideIndex)
            $sourceSlideDesign = $sourceSlide.Design
            $sourceLayout = $sourceSlide.CustomLayout
            $slideMetadata.Add([pscustomobject]@{
              designIndex = [int]$sourceSlideDesign.Index
              layoutIndex = [int]$sourceLayout.Index
            })
          }
          finally {
            Release-ComReference -Value $sourceLayout
            $sourceLayout = $null
            Release-ComReference -Value $sourceSlideDesign
            $sourceSlideDesign = $null
            Release-ComReference -Value $sourceSlide
            $sourceSlide = $null
          }
        }

        Assert-NotCancelled -CancelPath $CancelPath
        $beforeCount = [int]$targetSlides.Count
        $insertedCount = [int]$targetSlides.InsertFromFile($sourcePath, $beforeCount)
        if ($insertedCount -ne $sourceSlideCount) { throw 'POWERPOINT_PPTX_MERGE_FAILED' }
        Assert-NotCancelled -CancelPath $CancelPath

        for ($slideOffset = 0; $slideOffset -lt $sourceSlideCount; $slideOffset += 1) {
          Assert-NotCancelled -CancelPath $CancelPath
          $metadata = $slideMetadata[$slideOffset]
          $clonedDesign = $clonedDesigns[[string]$metadata.designIndex]
          if ($null -eq $clonedDesign) { throw 'POWERPOINT_PPTX_STYLE_REBIND_FAILED' }
          try {
            $layoutIndex = [int]$metadata.layoutIndex
            $slideMaster = $clonedDesign.SlideMaster
            $customLayouts = $slideMaster.CustomLayouts
            if ($layoutIndex -lt 1 -or $layoutIndex -gt [int]$customLayouts.Count) {
              throw 'POWERPOINT_PPTX_STYLE_REBIND_FAILED'
            }
            $targetLayout = $customLayouts.Item($layoutIndex)
            $targetSlide = $targetSlides.Item($beforeCount + $slideOffset + 1)
            $targetSlide.Design = $clonedDesign
            $targetSlide.CustomLayout = $targetLayout

            # Never report success merely because the slides were inserted. A
            # failed style assignment can silently remap placeholders to the
            # destination theme, so verify both COM relationships immediately.
            $targetSlideDesign = $targetSlide.Design
            $targetSlideLayout = $targetSlide.CustomLayout
            if ([int]$targetSlideDesign.Index -ne [int]$clonedDesign.Index -or [int]$targetSlideLayout.Index -ne $layoutIndex) {
              throw 'POWERPOINT_PPTX_STYLE_REBIND_FAILED'
            }
          }
          catch { throw 'POWERPOINT_PPTX_STYLE_REBIND_FAILED' }
          finally {
            Release-ComReference -Value $targetSlideLayout
            $targetSlideLayout = $null
            Release-ComReference -Value $targetSlideDesign
            $targetSlideDesign = $null
            Release-ComReference -Value $targetSlide
            $targetSlide = $null
            Release-ComReference -Value $targetLayout
            $targetLayout = $null
            Release-ComReference -Value $customLayouts
            $customLayouts = $null
            Release-ComReference -Value $slideMaster
            $slideMaster = $null
            $clonedDesign = $null
          }
        }
      }
      finally {
        Release-ComReference -Value $targetSlideLayout
        $targetSlideLayout = $null
        Release-ComReference -Value $targetSlideDesign
        $targetSlideDesign = $null
        Release-ComReference -Value $targetSlide
        $targetSlide = $null
        Release-ComReference -Value $targetLayout
        $targetLayout = $null
        Release-ComReference -Value $customLayouts
        $customLayouts = $null
        Release-ComReference -Value $slideMaster
        $slideMaster = $null
        Release-ComReference -Value $sourceLayout
        $sourceLayout = $null
        Release-ComReference -Value $sourceSlideDesign
        $sourceSlideDesign = $null
        Release-ComReference -Value $sourceSlide
        $sourceSlide = $null
        Release-ComReference -Value $sourceDesign
        $sourceDesign = $null
        Release-ComReference -Value $sourcePageSetup
        $sourcePageSetup = $null
        foreach ($design in @($clonedDesigns.Values)) { Release-ComReference -Value $design }
        $clonedDesigns.Clear()
        Release-ComReference -Value $sourceDesigns
        $sourceDesigns = $null
        Release-ComReference -Value $sourceSlides
        $sourceSlides = $null
        if ($null -ne $sourcePresentation) {
          try { $sourcePresentation.Close() } catch {}
          Release-ComReference -Value $sourcePresentation -Final
          $sourcePresentation = $null
        }
      }
    }

    Assert-NotCancelled -CancelPath $CancelPath
    try { $presentation.Save() }
    catch { throw 'POWERPOINT_PPTX_SAVE_FAILED' }
    return [int]$targetSlides.Count
  }
  catch {
    $message = if ($_.Exception.Message) { [string]$_.Exception.Message } else { 'POWERPOINT_PPTX_MERGE_FAILED' }
    if ($message -in @(
      'INPUT_COUNT_INVALID',
      'INPUT_NOT_FOUND',
      'OUTPUT_EXISTS',
      'OUTPUT_DIRECTORY_NOT_FOUND',
      'POWERPOINT_PPTX_OUTPUT_READ_ONLY',
      'POWERPOINT_PPTX_SIZE_MISMATCH',
      'POWERPOINT_PPTX_STYLE_REBIND_FAILED',
      'POWERPOINT_PPTX_SAVE_FAILED',
      'DOCUMENT_TOOL_CANCELLED'
    )) { throw $message }
    throw 'POWERPOINT_PPTX_MERGE_FAILED'
  }
  finally {
    Release-ComReference -Value $targetSlideLayout
    Release-ComReference -Value $targetSlideDesign
    Release-ComReference -Value $targetSlide
    Release-ComReference -Value $targetLayout
    Release-ComReference -Value $customLayouts
    Release-ComReference -Value $slideMaster
    Release-ComReference -Value $sourceLayout
    Release-ComReference -Value $sourceSlideDesign
    Release-ComReference -Value $sourceSlide
    Release-ComReference -Value $sourceDesign
    Release-ComReference -Value $sourcePageSetup
    foreach ($design in @($clonedDesigns.Values)) { Release-ComReference -Value $design }
    $clonedDesigns.Clear()
    Release-ComReference -Value $sourceDesigns
    Release-ComReference -Value $sourceSlides
    if ($null -ne $sourcePresentation) {
      try { $sourcePresentation.Close() } catch {}
      Release-ComReference -Value $sourcePresentation -Final
      $sourcePresentation = $null
    }
    Release-ComReference -Value $targetDesigns
    $targetDesigns = $null
    Release-ComReference -Value $targetPageSetup
    $targetPageSetup = $null
    Release-ComReference -Value $targetSlides
    $targetSlides = $null
    if ($null -ne $presentation) {
      try { if ([int]$presentation.Saved -eq 0) { $presentation.Saved = -1 } } catch {}
      try { $presentation.Close() } catch {}
      Release-ComReference -Value $presentation -Final
      $presentation = $null
    }
    Release-ComReference -Value $presentations
    $presentations = $null
  }
}

function Split-Presentation {
  param([object]$PowerPoint, [string]$InputPath, [object[]]$Outputs, [string]$CancelPath)

  $presentations = $null
  $sourcePresentation = $null
  $sourceSlides = $null
  $sourceSlide = $null
  $targetPresentation = $null
  $targetSlides = $null
  $targetSlide = $null
  $createdOutputs = New-Object System.Collections.Generic.List[string]
  $normalizedPlans = New-Object System.Collections.Generic.List[object]
  $splitResults = New-Object System.Collections.Generic.List[object]
  try {
    Assert-NotCancelled -CancelPath $CancelPath
    $inputPath = [System.IO.Path]::GetFullPath([string]$InputPath)
    if (-not [System.IO.File]::Exists($inputPath)) { throw 'INPUT_NOT_FOUND' }
    if (-not [string]::Equals([System.IO.Path]::GetExtension($inputPath), '.pptx', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'POWERPOINT_PPTX_SPLIT_INPUT_INVALID'
    }

    $outputItems = @($Outputs)
    if ($outputItems.Count -lt 1 -or $outputItems.Count -gt 500) { throw 'POWERPOINT_PPTX_SPLIT_OUTPUT_COUNT_INVALID' }
    $outputPathKeys = @{}
    for ($outputIndex = 0; $outputIndex -lt $outputItems.Count; $outputIndex += 1) {
      $outputItem = $outputItems[$outputIndex]
      $outputPath = [System.IO.Path]::GetFullPath([string]$outputItem.outputPath)
      if (-not [string]::Equals([System.IO.Path]::GetExtension($outputPath), '.pptx', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'POWERPOINT_PPTX_SPLIT_OUTPUT_INVALID'
      }
      if ([string]::Equals($inputPath, $outputPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'POWERPOINT_PPTX_SPLIT_OUTPUT_INVALID'
      }
      $outputKey = $outputPath.ToLowerInvariant()
      if ($outputPathKeys.ContainsKey($outputKey)) { throw 'POWERPOINT_PPTX_SPLIT_OUTPUT_DUPLICATED' }
      $outputPathKeys[$outputKey] = $true
      if ([System.IO.File]::Exists($outputPath)) { throw 'OUTPUT_EXISTS' }
      $outputDirectory = [System.IO.Path]::GetDirectoryName($outputPath)
      if (-not [System.IO.Directory]::Exists($outputDirectory)) { throw 'OUTPUT_DIRECTORY_NOT_FOUND' }
      $normalizedPlans.Add([pscustomobject]@{
        index = $outputIndex
        outputPath = $outputPath
        rawPages = @($outputItem.pages)
      })
    }

    $presentations = $PowerPoint.Presentations
    $sourcePresentation = $presentations.Open($inputPath, -1, 0, 0)
    $sourceSlides = $sourcePresentation.Slides
    $sourceSlideCount = [int]$sourceSlides.Count
    if ($sourceSlideCount -lt 1) { throw 'POWERPOINT_PPTX_SPLIT_INPUT_INVALID' }
    $sourceSlideIds = New-Object System.Collections.Generic.List[int]
    $sourceSlideIdKeys = @{}
    for ($slideIndex = 1; $slideIndex -le $sourceSlideCount; $slideIndex += 1) {
      try {
        $sourceSlide = $sourceSlides.Item($slideIndex)
        $sourceSlideId = [int]$sourceSlide.SlideID
      }
      finally {
        Release-ComReference -Value $sourceSlide
        $sourceSlide = $null
      }
      $sourceSlideIdKey = [string]$sourceSlideId
      if ($sourceSlideId -le 0 -or $sourceSlideIdKeys.ContainsKey($sourceSlideIdKey)) {
        throw 'POWERPOINT_PPTX_SPLIT_INPUT_INVALID'
      }
      $sourceSlideIdKeys[$sourceSlideIdKey] = $true
      $sourceSlideIds.Add($sourceSlideId)
    }

    $selectedPages = @{}
    foreach ($plan in @($normalizedPlans.ToArray())) {
      $pages = New-Object System.Collections.Generic.List[int]
      $priorPage = 0
      foreach ($rawPage in @($plan.rawPages)) {
        $page = 0
        if (-not [int]::TryParse([string]$rawPage, [ref]$page)) { throw 'POWERPOINT_PPTX_SPLIT_PAGE_INVALID' }
        if ($page -lt 1 -or $page -gt $sourceSlideCount) { throw 'POWERPOINT_PPTX_SPLIT_PAGE_OUT_OF_RANGE' }
        if ($page -le $priorPage) { throw 'POWERPOINT_PPTX_SPLIT_PAGE_ORDER_INVALID' }
        $pageKey = [string]$page
        if ($selectedPages.ContainsKey($pageKey)) { throw 'POWERPOINT_PPTX_SPLIT_PAGE_DUPLICATED' }
        $selectedPages[$pageKey] = $true
        $pages.Add($page)
        $priorPage = $page
      }
      if ($pages.Count -lt 1) { throw 'POWERPOINT_PPTX_SPLIT_PAGE_INVALID' }
      $plan.PSObject.Properties.Remove('rawPages')
      $plan | Add-Member -NotePropertyName pages -NotePropertyValue ([int[]]$pages.ToArray())
    }

    try { if ([int]$sourcePresentation.Saved -eq 0) { $sourcePresentation.Saved = -1 } } catch {}
    try { $sourcePresentation.Close() } catch {}
    Release-ComReference -Value $sourceSlides
    $sourceSlides = $null
    Release-ComReference -Value $sourcePresentation -Final
    $sourcePresentation = $null

    foreach ($plan in @($normalizedPlans.ToArray())) {
      Assert-NotCancelled -CancelPath $CancelPath
      $outputPath = [string]$plan.outputPath
      [System.IO.File]::Copy($inputPath, $outputPath, $false)
      $createdOutputs.Add($outputPath)
      $attributes = [System.IO.File]::GetAttributes($outputPath)
      if (($attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
        $writableAttributes = [System.IO.FileAttributes]([int]$attributes -band (-bnot [int][System.IO.FileAttributes]::ReadOnly))
        [System.IO.File]::SetAttributes($outputPath, $writableAttributes)
      }
      Assert-NotCancelled -CancelPath $CancelPath

      try {
        $targetPresentation = $presentations.Open($outputPath, 0, 0, 0)
        if ([int]$targetPresentation.ReadOnly -ne 0) { throw 'POWERPOINT_PPTX_OUTPUT_READ_ONLY' }
        $targetSlides = $targetPresentation.Slides
        if ([int]$targetSlides.Count -ne $sourceSlideCount) { throw 'POWERPOINT_PPTX_SPLIT_INPUT_CHANGED' }
        for ($slideIndex = 1; $slideIndex -le $sourceSlideCount; $slideIndex += 1) {
          try {
            $targetSlide = $targetSlides.Item($slideIndex)
            if ([int]$targetSlide.SlideID -ne [int]($sourceSlideIds[$slideIndex - 1])) {
              throw 'POWERPOINT_PPTX_SPLIT_INPUT_CHANGED'
            }
          }
          finally {
            Release-ComReference -Value $targetSlide
            $targetSlide = $null
          }
        }
        $keptPages = @{}
        foreach ($page in @($plan.pages)) { $keptPages[[string]$page] = $true }

        for ($slideIndex = $sourceSlideCount; $slideIndex -ge 1; $slideIndex -= 1) {
          Assert-NotCancelled -CancelPath $CancelPath
          if ($keptPages.ContainsKey([string]$slideIndex)) { continue }
          try {
            $targetSlide = $targetSlides.Item($slideIndex)
            $targetSlide.Delete()
          }
          finally {
            Release-ComReference -Value $targetSlide
            $targetSlide = $null
          }
        }
        if ([int]$targetSlides.Count -ne @($plan.pages).Count) { throw 'POWERPOINT_PPTX_SPLIT_COUNT_MISMATCH' }
        Assert-NotCancelled -CancelPath $CancelPath
        try { $targetPresentation.Save() }
        catch { throw 'POWERPOINT_PPTX_SPLIT_SAVE_FAILED' }
        if (-not [System.IO.File]::Exists($outputPath)) { throw 'OUTPUT_NOT_CREATED' }

        $retainedSlideIds = New-Object System.Collections.Generic.List[int]
        for ($retainedIndex = 1; $retainedIndex -le [int]$targetSlides.Count; $retainedIndex += 1) {
          try {
            $targetSlide = $targetSlides.Item($retainedIndex)
            $retainedSlideId = [int]$targetSlide.SlideID
          }
          finally {
            Release-ComReference -Value $targetSlide
            $targetSlide = $null
          }
          $expectedPage = [int](@($plan.pages)[$retainedIndex - 1])
          $expectedSlideId = [int]($sourceSlideIds[$expectedPage - 1])
          if ($retainedSlideId -ne $expectedSlideId) { throw 'POWERPOINT_PPTX_SPLIT_SLIDE_ID_MISMATCH' }
          $retainedSlideIds.Add($retainedSlideId)
        }

        $splitResult = [pscustomobject]@{
          index = [int]$plan.index
          outputPath = $outputPath
          pages = [int[]]@($plan.pages)
          slideCount = [int]$targetSlides.Count
          slideIds = [int[]]$retainedSlideIds.ToArray()
        }
        $splitResults.Add($splitResult)
        $progress = [pscustomobject]@{
          index = [int]$plan.index
          ok = $true
          completed = $splitResults.Count
          total = $normalizedPlans.Count
          pages = [int[]]@($plan.pages)
          slideCount = [int]$targetSlides.Count
          slideIds = [int[]]$retainedSlideIds.ToArray()
        } | ConvertTo-Json -Depth 4 -Compress
        [Console]::Out.WriteLine("CMOE_PROGRESS:$progress")
        [Console]::Out.Flush()
      }
      finally {
        Release-ComReference -Value $targetSlide
        $targetSlide = $null
        Release-ComReference -Value $targetSlides
        $targetSlides = $null
        if ($null -ne $targetPresentation) {
          try { if ([int]$targetPresentation.Saved -eq 0) { $targetPresentation.Saved = -1 } } catch {}
          try { $targetPresentation.Close() } catch {}
          Release-ComReference -Value $targetPresentation -Final
          $targetPresentation = $null
        }
      }
    }

    Assert-NotCancelled -CancelPath $CancelPath
    return [pscustomobject]@{
      sourceSlideCount = $sourceSlideCount
      sourceSlideIds = [int[]]$sourceSlideIds.ToArray()
      outputs = [object[]]$splitResults.ToArray()
    }
  }
  catch {
    $message = if ($_.Exception.Message) { [string]$_.Exception.Message } else { 'POWERPOINT_PPTX_SPLIT_FAILED' }
    foreach ($createdPath in @($createdOutputs.ToArray())) {
      try { if ([System.IO.File]::Exists($createdPath)) { [System.IO.File]::Delete($createdPath) } } catch {}
    }
    if ($message -in @(
      'INPUT_NOT_FOUND',
      'OUTPUT_EXISTS',
      'OUTPUT_DIRECTORY_NOT_FOUND',
      'POWERPOINT_PPTX_OUTPUT_READ_ONLY',
      'POWERPOINT_PPTX_SPLIT_INPUT_INVALID',
      'POWERPOINT_PPTX_SPLIT_INPUT_CHANGED',
      'POWERPOINT_PPTX_SPLIT_OUTPUT_COUNT_INVALID',
      'POWERPOINT_PPTX_SPLIT_OUTPUT_INVALID',
      'POWERPOINT_PPTX_SPLIT_OUTPUT_DUPLICATED',
      'POWERPOINT_PPTX_SPLIT_PAGE_INVALID',
      'POWERPOINT_PPTX_SPLIT_PAGE_OUT_OF_RANGE',
      'POWERPOINT_PPTX_SPLIT_PAGE_ORDER_INVALID',
      'POWERPOINT_PPTX_SPLIT_PAGE_DUPLICATED',
      'POWERPOINT_PPTX_SPLIT_COUNT_MISMATCH',
      'POWERPOINT_PPTX_SPLIT_SLIDE_ID_MISMATCH',
      'POWERPOINT_PPTX_SPLIT_SAVE_FAILED',
      'OUTPUT_NOT_CREATED',
      'DOCUMENT_TOOL_CANCELLED'
    )) { throw $message }
    throw 'POWERPOINT_PPTX_SPLIT_FAILED'
  }
  finally {
    Release-ComReference -Value $sourceSlide
    Release-ComReference -Value $targetSlide
    Release-ComReference -Value $targetSlides
    if ($null -ne $targetPresentation) {
      try { if ([int]$targetPresentation.Saved -eq 0) { $targetPresentation.Saved = -1 } } catch {}
      try { $targetPresentation.Close() } catch {}
      Release-ComReference -Value $targetPresentation -Final
    }
    Release-ComReference -Value $sourceSlides
    if ($null -ne $sourcePresentation) {
      try { if ([int]$sourcePresentation.Saved -eq 0) { $sourcePresentation.Saved = -1 } } catch {}
      try { $sourcePresentation.Close() } catch {}
      Release-ComReference -Value $sourcePresentation -Final
    }
    Release-ComReference -Value $presentations
  }
}

$job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
$resultPath = [string]$job.resultPath
if ([string]::IsNullOrWhiteSpace($resultPath)) { throw 'MISSING_RESULT_PATH' }
$cancelPath = if ($null -ne $job.PSObject.Properties['cancelPath']) { [string]$job.cancelPath } else { '' }

$powerPoint = $null
$fatalError = $null
$results = New-Object System.Collections.Generic.List[object]
$startedPowerPoint = $false
$originalAutomationSecurity = $null
$originalDisplayAlerts = $null

try {
  Assert-NotCancelled -CancelPath $cancelPath
  if (@(Get-Process -Name 'POWERPNT' -ErrorAction SilentlyContinue).Count -gt 0) { throw 'POWERPOINT_IN_USE' }
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $startedPowerPoint = $true
  try { $originalAutomationSecurity = $powerPoint.AutomationSecurity } catch {}
  try { $originalDisplayAlerts = $powerPoint.DisplayAlerts } catch {}
  try { $powerPoint.AutomationSecurity = 3 } catch {}
  try { $powerPoint.DisplayAlerts = 1 } catch {}

  if ([string]$job.operation -eq 'probe') {
    $results.Add([pscustomobject]@{ ok = $true; version = [string]$powerPoint.Version })
  }
  else {
    $items = @($job.items)
    for ($index = 0; $index -lt $items.Count; $index += 1) {
      $item = $items[$index]
      $presentation = $null
      try {
        if ([string]$job.operation -eq 'split-pptx') {
          $split = Split-Presentation -PowerPoint $powerPoint -InputPath ([string]$item.inputPath) -Outputs @($item.outputs) -CancelPath $cancelPath
          $results.Add([pscustomobject]@{
            ok = $true
            index = $index
            sourceSlideCount = [int]$split.sourceSlideCount
            sourceSlideIds = [int[]]@($split.sourceSlideIds)
            outputs = [object[]]@($split.outputs)
          })
          continue
        }

        $outputPath = [System.IO.Path]::GetFullPath([string]$item.outputPath)
        if ([System.IO.File]::Exists($outputPath)) { throw 'OUTPUT_EXISTS' }
        $outputDirectory = [System.IO.Path]::GetDirectoryName($outputPath)
        if (-not [System.IO.Directory]::Exists($outputDirectory)) { throw 'OUTPUT_DIRECTORY_NOT_FOUND' }

        if ([string]$job.operation -eq 'merge-pptx') {
          $inputPaths = @($item.inputPaths | ForEach-Object { [System.IO.Path]::GetFullPath([string]$_) })
          $slideCount = Merge-Presentations -PowerPoint $powerPoint -InputPaths $inputPaths -Path $outputPath -CancelPath $cancelPath
          if (-not [System.IO.File]::Exists($outputPath)) { throw 'OUTPUT_NOT_CREATED' }
          $results.Add([pscustomobject]@{ ok = $true; index = $index; outputPath = $outputPath; slideCount = $slideCount })
          $progress = [pscustomobject]@{ index = $index; ok = $true; slideCount = $slideCount } | ConvertTo-Json -Compress
          Write-Output "CMOE_PROGRESS:$progress"
          continue
        }

        $inputPath = [System.IO.Path]::GetFullPath([string]$item.inputPath)
        if (-not [System.IO.File]::Exists($inputPath)) { throw 'INPUT_NOT_FOUND' }

        $presentation = $powerPoint.Presentations.Open($inputPath, -1, 0, 0)
        if ([string]$job.operation -eq 'pdf') {
          Export-PresentationPdf -Presentation $presentation -Path $outputPath
        }
        elseif ([string]$job.operation -eq 'png') {
          $slideNumber = [int]$item.slideNumber
          if ($slideNumber -lt 1 -or $slideNumber -gt $presentation.Slides.Count) { throw 'SLIDE_NOT_FOUND' }
          $width = 1600
          $height = [Math]::Max(1, [Math]::Round($width * $presentation.PageSetup.SlideHeight / $presentation.PageSetup.SlideWidth))
          $presentation.Slides.Item($slideNumber).Export($outputPath, 'PNG', $width, $height)
        }
        else {
          throw 'UNSUPPORTED_OPERATION'
        }

        if (-not [System.IO.File]::Exists($outputPath)) { throw 'OUTPUT_NOT_CREATED' }
        $results.Add([pscustomobject]@{ ok = $true; index = $index; outputPath = $outputPath })
        $progress = [pscustomobject]@{ index = $index; ok = $true } | ConvertTo-Json -Compress
        Write-Output "CMOE_PROGRESS:$progress"
      }
      catch {
        $message = if ($_.Exception.Message) { [string]$_.Exception.Message } else { 'POWERPOINT_OPERATION_FAILED' }
        $results.Add([pscustomobject]@{ ok = $false; index = $index; error = $message })
        $progress = [pscustomobject]@{ index = $index; ok = $false; error = $message } | ConvertTo-Json -Compress
        Write-Output "CMOE_PROGRESS:$progress"
      }
      finally {
        if ($null -ne $presentation) {
          try { $presentation.Close() } catch {}
          try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) } catch {}
          $presentation = $null
        }
      }
    }
  }
}
catch {
  $fatalError = if ($_.Exception.Message) { [string]$_.Exception.Message } else { 'POWERPOINT_START_FAILED' }
}
finally {
  if ($null -ne $powerPoint) {
    if ($null -ne $originalAutomationSecurity) { try { $powerPoint.AutomationSecurity = $originalAutomationSecurity } catch {} }
    if ($null -ne $originalDisplayAlerts) { try { $powerPoint.DisplayAlerts = $originalDisplayAlerts } catch {} }
    if ($startedPowerPoint) {
      try { if ($powerPoint.Presentations.Count -eq 0) { $powerPoint.Quit() } } catch {}
    }
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint) } catch {}
    $powerPoint = $null
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  Write-JsonFile -Path $resultPath -Value ([pscustomobject]@{
    ok = [string]::IsNullOrWhiteSpace([string]$fatalError)
    fatalError = $fatalError
    # Windows PowerShell 5.1 throws "Argument types do not match" when a
    # Generic.List[object] is expanded with @() inside a PSCustomObject.
    results = [object[]]$results.ToArray()
  })
}

if (-not [string]::IsNullOrWhiteSpace([string]$fatalError)) { exit 1 }
exit 0
