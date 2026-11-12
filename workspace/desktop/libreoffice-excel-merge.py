#!/usr/bin/env python3
"""Isolated LibreOffice worksheet merge worker.

The Electron main process validates and snapshots every source before invoking
this worker.  The worker still re-checks byte identities, disables macros and
link updates, runs LibreOffice with a per-job profile, and verifies the saved
workbook before returning success.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import uuid
from pathlib import Path

import uno


ALLOWED_EXTENSIONS = {".xlsx"}
MAX_FILES = 500
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_SHEETS = 10_000
MAX_CELLS_PER_SHEET = 1_000_000
MAX_EXCEL_ROWS = 1_048_576
MAX_EXCEL_COLUMNS = 16_384
CONNECT_TIMEOUT_SECONDS = 30


class WorkerError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def fail(code: str) -> None:
    raise WorkerError(code)


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        fail("JOB_FILE_INVALID")
    if not isinstance(value, dict):
        fail("JOB_FILE_INVALID")
    return value


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)


def emit_progress(index: int, completed: int, total: int) -> None:
    value = {"ok": True, "index": index, "completed": completed, "total": total}
    sys.stdout.write("CMOE_PROGRESS:" + json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def normalized_file(path_value: object, extension_required: bool = True) -> Path:
    if not isinstance(path_value, str) or not path_value or "\x00" in path_value:
        fail("PATH_INVALID")
    path = Path(path_value)
    if not path.is_absolute():
        fail("PATH_INVALID")
    try:
        resolved = path.resolve(strict=extension_required)
    except Exception:
        fail("INPUT_NOT_FOUND" if extension_required else "OUTPUT_DIRECTORY_NOT_FOUND")
    return resolved


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
    except Exception:
        fail("INPUT_NOT_FOUND")
    return digest.hexdigest()


def check_cancel(cancel_path: Path | None) -> None:
    if cancel_path is not None and cancel_path.exists():
        fail("DOCUMENT_TOOL_CANCELLED")


def property_value(name: str, value: object):
    item = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    item.Name = name
    item.Value = value
    return item


def file_url(path: Path) -> str:
    return uno.systemPathToFileUrl(str(path))


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def truncate_utf16(value: str, limit: int) -> str:
    result = ""
    used = 0
    for character in value:
        units = utf16_length(character)
        if used + units > limit:
            break
        result += character
        used += units
    return result


def safe_sheet_name(value: object, used_names: set[str], fallback_index: int) -> str:
    base = re.sub(r"[\\/:?*\[\]\x00-\x1f]", " ", str(value or ""))
    base = re.sub(r"\s+", " ", base).strip().strip("'").strip()
    if not base:
        base = f"Sheet {max(1, fallback_index)}"
    base = truncate_utf16(base, 31)
    candidate = base
    suffix_index = 2
    while candidate.casefold() in used_names or candidate.casefold() == "history":
        suffix = f" ({suffix_index})"
        candidate = truncate_utf16(base, 31 - utf16_length(suffix)) + suffix
        suffix_index += 1
    used_names.add(candidate.casefold())
    return candidate


def sheet_visibility(sheet) -> str:
    try:
        return "visible" if bool(sheet.IsVisible) else "hidden"
    except Exception:
        fail("LIBREOFFICE_SHEET_VISIBILITY_FAILED")


def used_area(sheet) -> tuple[int, int]:
    try:
        cursor = sheet.createCursor()
        cursor.gotoEndOfUsedArea(True)
        address = cursor.RangeAddress
        columns = int(address.EndColumn) + 1
        rows = int(address.EndRow) + 1
    except Exception:
        fail("LIBREOFFICE_SHEET_INSPECTION_FAILED")
    if columns < 1 or rows < 1 or columns * rows > MAX_CELLS_PER_SHEET:
        fail("LIBREOFFICE_SHEET_SIZE_INVALID")
    return columns, rows


def normalized_cell(value: object) -> object:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            return str(number)
        return int(number) if number.is_integer() else number
    if value is None:
        return ""
    return str(value)


def sheet_fingerprint(sheet) -> dict:
    columns, rows = used_area(sheet)
    try:
        cell_range = sheet.getCellRangeByPosition(0, 0, columns - 1, rows - 1)
        data = cell_range.getDataArray()
        formulas = cell_range.getFormulaArray()
        draw_count = int(sheet.DrawPage.getCount())
    except Exception:
        fail("LIBREOFFICE_SHEET_INSPECTION_FAILED")
    constants = []
    formula_rows = []
    formula_count = 0
    for row_index, row in enumerate(data):
        constant_row = []
        formula_digest_row = []
        formula_row = formulas[row_index] if row_index < len(formulas) else ()
        for column_index, value in enumerate(row):
            formula = str(formula_row[column_index]) if column_index < len(formula_row) else ""
            if formula.startswith("="):
                formula_count += 1
                constant_row.append("<FORMULA>")
                formula_digest_row.append(formula)
            else:
                constant_row.append(normalized_cell(value))
                formula_digest_row.append("")
        constants.append(constant_row)
        formula_rows.append(formula_digest_row)
    serialized = json.dumps(constants, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    serialized_formulas = json.dumps(formula_rows, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return {
        "rows": rows,
        "columns": columns,
        "constantDigest": hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
        "formulaCount": formula_count,
        "formulaDigest": hashlib.sha256(serialized_formulas.encode("utf-8")).hexdigest(),
        "drawCount": draw_count,
    }


def normalized_header_value(value: object, formula: object) -> str:
    raw = str(formula) if str(formula).startswith("=") else str(normalized_cell(value))
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", raw).strip()).casefold()


def sheet_table_descriptor(sheet) -> dict | None:
    """Return the non-empty rectangular table and a normalized row-1 header."""
    columns, rows = used_area(sheet)
    try:
        cell_range = sheet.getCellRangeByPosition(0, 0, columns - 1, rows - 1)
        data = cell_range.getDataArray()
        formulas = cell_range.getFormulaArray()
    except Exception:
        fail("LIBREOFFICE_SHEET_INSPECTION_FAILED")
    last_row = -1
    last_column = -1
    for row_index, row in enumerate(data):
        formula_row = formulas[row_index] if row_index < len(formulas) else ()
        for column_index, value in enumerate(row):
            formula = str(formula_row[column_index]) if column_index < len(formula_row) else ""
            if formula.startswith("=") or normalized_cell(value) != "":
                last_row = max(last_row, row_index)
                last_column = max(last_column, column_index)
    if last_row < 0 or last_column < 0:
        return None
    effective_rows = last_row + 1
    effective_columns = last_column + 1
    header_formula_row = formulas[0] if formulas else ()
    header = tuple(
        normalized_header_value(
            data[0][column] if data and column < len(data[0]) else "",
            header_formula_row[column] if column < len(header_formula_row) else "",
        )
        for column in range(effective_columns)
    )
    return {
        "rows": effective_rows,
        "columns": effective_columns,
        "header": header,
        "data": tuple(tuple(row[column] for column in range(effective_columns))
                      for row in data[:effective_rows]),
    }


def create_combined_value_sheet(document, combined_name: str, prepared_entries: list) -> dict:
    entries = []
    reference_header = None
    reference_columns = 0
    for sheet_name, descriptor in prepared_entries:
        if descriptor is None:
            continue
        if reference_header is None:
            reference_header = descriptor["header"]
            reference_columns = int(descriptor["columns"])
            if not any(reference_header):
                fail("LIBREOFFICE_COMBINED_HEADER_MISSING")
        elif descriptor["columns"] != reference_columns or descriptor["header"] != reference_header:
            fail("LIBREOFFICE_COMBINED_HEADER_MISMATCH")
        entries.append((sheet_name, descriptor))
    if not entries or reference_header is None:
        fail("LIBREOFFICE_COMBINED_HEADER_MISSING")

    combined_rows = 1 + sum(max(0, int(descriptor["rows"]) - 1) for _, descriptor in entries)
    if (reference_columns < 1 or reference_columns > MAX_EXCEL_COLUMNS
            or combined_rows < 1 or combined_rows > MAX_EXCEL_ROWS
            or reference_columns * combined_rows > MAX_CELLS_PER_SHEET):
        fail("LIBREOFFICE_COMBINED_SHEET_SIZE_INVALID")
    try:
        document.Sheets.insertNewByName(combined_name, 0)
        combined = document.Sheets.getByName(combined_name)
        combined.IsVisible = True
    except Exception:
        fail("LIBREOFFICE_COMBINED_SHEET_CREATE_FAILED")

    destination_row = 0
    try:
        for entry_index, (sheet_name, descriptor) in enumerate(entries):
            source = document.Sheets.getByName(sheet_name)
            source_start_row = 0 if entry_index == 0 else 1
            source_end_row = int(descriptor["rows"]) - 1
            if source_end_row < source_start_row:
                continue
            row_count = source_end_row - source_start_row + 1
            source_range = source.getCellRangeByPosition(
                0, source_start_row, reference_columns - 1, source_end_row
            )
            destination_address = combined.getCellByPosition(0, destination_row).CellAddress
            combined.copyRange(destination_address, source_range.RangeAddress)
            # Keep copied number formats/basic cell formatting, but turn every
            # derived-cell formula into its calculated value snapshot.
            destination_range = combined.getCellRangeByPosition(
                0, destination_row, reference_columns - 1, destination_row + row_count - 1
            )
            values = descriptor["data"][source_start_row:source_end_row + 1]
            destination_range.setDataArray(values)
            destination_row += row_count
    except WorkerError:
        raise
    except Exception:
        fail("LIBREOFFICE_COMBINED_SHEET_CREATE_FAILED")

    descriptor = sheet_table_descriptor(combined)
    if (descriptor is None or descriptor["rows"] != combined_rows
            or descriptor["columns"] != reference_columns
            or descriptor["header"] != reference_header):
        fail("LIBREOFFICE_COMBINED_SHEET_CREATE_FAILED")
    fingerprint = sheet_fingerprint(combined)
    if fingerprint["formulaCount"] != 0:
        fail("LIBREOFFICE_COMBINED_SHEET_CREATE_FAILED")
    return {
        "name": combined_name,
        "visibility": "visible",
        "rows": combined_rows,
        "columns": reference_columns,
        "header": reference_header,
        "fingerprint": fingerprint,
    }


def close_document(document) -> None:
    if document is None:
        return
    try:
        document.close(True)
        return
    except Exception:
        pass
    try:
        document.dispose()
    except Exception:
        pass


def load_document(desktop, path: Path, read_only: bool):
    never_execute = uno.getConstantByName("com.sun.star.document.MacroExecMode.NEVER_EXECUTE")
    no_update = uno.getConstantByName("com.sun.star.document.UpdateDocMode.NO_UPDATE")
    properties = (
        property_value("Hidden", True),
        property_value("ReadOnly", read_only),
        property_value("Silent", True),
        property_value("PickListEntry", False),
        property_value("MacroExecutionMode", never_execute),
        property_value("UpdateDocMode", no_update),
    )
    try:
        document = desktop.loadComponentFromURL(file_url(path), "_blank", 0, properties)
    except Exception:
        fail("LIBREOFFICE_INPUT_OPEN_FAILED")
    if document is None or not document.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
        close_document(document)
        fail("LIBREOFFICE_INPUT_OPEN_FAILED")
    try:
        document.enableAutomaticCalculation(False)
    except Exception:
        pass
    return document


def document_sheets(document) -> list:
    try:
        names = list(document.Sheets.getElementNames())
    except Exception:
        fail("LIBREOFFICE_SHEET_INSPECTION_FAILED")
    if not names or len(names) > MAX_SHEETS:
        fail("LIBREOFFICE_SHEET_COUNT_INVALID")
    if int(document.Sheets.getCount()) != len(names):
        fail("LIBREOFFICE_SHEET_INSPECTION_FAILED")
    return [document.Sheets.getByIndex(index) for index in range(len(names))]


def localize_imported_formula_links(sheet, source_url: str) -> int:
    columns, rows = used_area(sheet)
    quoted_url = source_url.replace("'", "''")
    prefixes = (f"='{quoted_url}'#", f"={source_url}#")
    rewrites = 0
    try:
        for row in range(rows):
            for column in range(columns):
                cell = sheet.getCellByPosition(column, row)
                formula = str(cell.Formula)
                if not formula.startswith("="):
                    continue
                localized = formula
                for prefix in prefixes:
                    if prefix in localized:
                        localized = localized.replace(prefix, "=")
                if localized != formula:
                    cell.Formula = localized
                    rewrites += 1
    except Exception:
        fail("LIBREOFFICE_FORMULA_REBIND_FAILED")
    return rewrites


def copy_exclusive(source: Path, destination: Path) -> None:
    try:
        with source.open("rb") as input_stream, destination.open("xb") as output_stream:
            shutil.copyfileobj(input_stream, output_stream, length=1024 * 1024)
    except FileExistsError:
        fail("OUTPUT_EXISTS")
    except Exception:
        fail("LIBREOFFICE_BASE_COPY_FAILED")


def connect_office(soffice_path: Path, profile_path: Path):
    pipe_name = "cmoe_excel_merge_" + uuid.uuid4().hex
    command = [
        str(soffice_path),
        "--headless",
        "--invisible",
        "--nologo",
        "--nodefault",
        "--nofirststartwizard",
        "--norestore",
        "--nolockcheck",
        f"-env:UserInstallation={file_url(profile_path)}",
        f"--accept=pipe,name={pipe_name};urp;StarOffice.ComponentContext",
    ]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        process = subprocess.Popen(command, cwd=str(soffice_path.parent), stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=flags)
    except Exception:
        fail("LIBREOFFICE_START_FAILED")
    local_context = uno.getComponentContext()
    resolver = local_context.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local_context
    )
    deadline = time.monotonic() + CONNECT_TIMEOUT_SECONDS
    last_error = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        try:
            context = resolver.resolve(
                f"uno:pipe,name={pipe_name};urp;StarOffice.ComponentContext"
            )
            desktop = context.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", context
            )
            return process, desktop
        except Exception as error:
            last_error = error
            time.sleep(0.1)
    try:
        process.terminate()
    except Exception:
        pass
    _ = last_error
    fail("LIBREOFFICE_START_FAILED")


def terminate_office(process, desktop) -> None:
    try:
        if desktop is not None:
            desktop.terminate()
    except Exception:
        pass
    if process is None:
        return
    try:
        process.wait(timeout=10)
        return
    except Exception:
        pass
    try:
        process.terminate()
        process.wait(timeout=5)
        return
    except Exception:
        pass
    try:
        process.kill()
    except Exception:
        pass


def merge(job: dict) -> dict:
    if job.get("operation") != "merge-excel":
        fail("UNSUPPORTED_OPERATION")
    raw_sources = job.get("sources")
    if not isinstance(raw_sources, list) or len(raw_sources) < 2 or len(raw_sources) > MAX_FILES:
        fail("INPUT_COUNT_INVALID")
    add_combined_sheet = job.get("addCombinedSheet", False)
    if not isinstance(add_combined_sheet, bool):
        fail("LIBREOFFICE_EXPECTED_STRUCTURE_INVALID")
    expected_names = job.get("expectedSheetNames")
    expected_source_counts = job.get("expectedSourceSheetCounts")
    combined_name = job.get("combinedSheetName", "")
    if (not isinstance(expected_names, list) or not all(isinstance(name, str) and name for name in expected_names)
            or not isinstance(expected_source_counts, list)
            or len(expected_source_counts) != len(raw_sources)
            or not all(isinstance(count, int) and not isinstance(count, bool) and 1 <= count <= MAX_SHEETS
                       for count in expected_source_counts)
            or not isinstance(combined_name, str)):
        fail("LIBREOFFICE_EXPECTED_STRUCTURE_INVALID")
    original_sheet_count = sum(expected_source_counts)
    if (len(expected_names) != original_sheet_count + (1 if add_combined_sheet else 0)
            or (add_combined_sheet and (not combined_name or expected_names[0] != combined_name))
            or (not add_combined_sheet and combined_name)):
        fail("LIBREOFFICE_EXPECTED_STRUCTURE_INVALID")
    original_expected_names = expected_names[1:] if add_combined_sheet else expected_names
    if (len({name.casefold() for name in expected_names}) != len(expected_names)
            or any(utf16_length(name) > 31 or re.search(r"[\\/:?*\[\]\x00-\x1f]", name)
                   for name in expected_names)):
        fail("LIBREOFFICE_EXPECTED_STRUCTURE_INVALID")
    sources = []
    total_bytes = 0
    for item in raw_sources:
        if not isinstance(item, dict):
            fail("INPUT_IDENTITY_INVALID")
        source = normalized_file(item.get("path"))
        if source.suffix.lower() not in ALLOWED_EXTENSIONS or not source.is_file():
            fail("INPUT_FORMAT_INVALID")
        expected_bytes = item.get("bytes")
        expected_hash = str(item.get("sha256") or "").lower()
        actual_bytes = source.stat().st_size
        if not isinstance(expected_bytes, int) or expected_bytes != actual_bytes or not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
            fail("INPUT_IDENTITY_INVALID")
        if sha256_file(source) != expected_hash:
            fail("INPUT_IDENTITY_CHANGED")
        total_bytes += actual_bytes
        if total_bytes > MAX_TOTAL_BYTES:
            fail("INPUT_TOTAL_SIZE_INVALID")
        sources.append(source)

    output = normalized_file(job.get("outputPath"), extension_required=False)
    if output.suffix.lower() != ".xlsx" or output.exists() or not output.parent.is_dir():
        fail("OUTPUT_EXISTS" if output.exists() else "OUTPUT_FORMAT_INVALID")
    if any(os.path.normcase(str(source)) == os.path.normcase(str(output)) for source in sources):
        fail("OUTPUT_EQUALS_INPUT")
    cancel_value = job.get("cancelPath")
    cancel_path = normalized_file(cancel_value, extension_required=False) if isinstance(cancel_value, str) and cancel_value else None
    soffice = normalized_file(job.get("libreOfficePath"))
    if soffice.name.lower() not in {"soffice.exe", "soffice.com"}:
        fail("LIBREOFFICE_PATH_INVALID")
    profile = normalized_file(job.get("profilePath"), extension_required=False)
    try:
        profile.mkdir(parents=True, exist_ok=False)
    except Exception:
        fail("LIBREOFFICE_PROFILE_FAILED")

    process = None
    desktop = None
    target = None
    opened_sources = []
    try:
        check_cancel(cancel_path)
        process, desktop = connect_office(soffice, profile)
        copy_exclusive(sources[0], output)
        target = load_document(desktop, output, False)
        target_sheets = document_sheets(target)
        if len(target_sheets) != expected_source_counts[0]:
            fail("LIBREOFFICE_EXPECTED_STRUCTURE_INVALID")
        source_sheet_counts = [len(target_sheets)]
        expected = []
        combined_entries = []
        original_name_offset = 0
        first_desired_names = original_expected_names[:len(target_sheets)]
        if len(first_desired_names) != len(target_sheets):
            fail("LIBREOFFICE_EXPECTED_STRUCTURE_INVALID")
        if any(str(sheet.Name) != first_desired_names[index] for index, sheet in enumerate(target_sheets)):
            for index, sheet in enumerate(target_sheets):
                try:
                    sheet.Name = truncate_utf16(f"CMOE_{uuid.uuid4().hex}_{index + 1}", 31)
                except Exception:
                    fail("LIBREOFFICE_SHEET_NAME_FAILED")
            for index, sheet in enumerate(target_sheets):
                try:
                    sheet.Name = first_desired_names[index]
                except Exception:
                    fail("LIBREOFFICE_SHEET_NAME_FAILED")
        for index, sheet in enumerate(target_sheets):
            name = str(sheet.Name)
            if name != original_expected_names[original_name_offset + index]:
                fail("LIBREOFFICE_EXPECTED_STRUCTURE_INVALID")
            expected.append({
                "name": name,
                "visibility": sheet_visibility(sheet),
                "fingerprint": sheet_fingerprint(sheet),
            })
            if add_combined_sheet:
                combined_entries.append((name, sheet_table_descriptor(sheet)))
        original_name_offset += len(target_sheets)

        completed = 1
        emit_progress(0, completed, len(sources))
        for source_index in range(1, len(sources)):
            check_cancel(cancel_path)
            source_copy = profile.parent / f"source-{source_index + 1:04d}.xlsx"
            copy_exclusive(sources[source_index], source_copy)
            source_document = load_document(desktop, source_copy, False)
            opened_sources.append(source_document)
            sheets = document_sheets(source_document)
            if len(sheets) != expected_source_counts[source_index]:
                fail("LIBREOFFICE_EXPECTED_STRUCTURE_INVALID")
            source_sheet_counts.append(len(sheets))
            desired_names = original_expected_names[original_name_offset:original_name_offset + len(sheets)]
            if len(desired_names) != len(sheets):
                fail("LIBREOFFICE_EXPECTED_STRUCTURE_INVALID")
            source_descriptors = [sheet_table_descriptor(sheet) for sheet in sheets] if add_combined_sheet else []
            temporary_names = []
            for offset, sheet in enumerate(sheets):
                temporary = truncate_utf16(f"CMOE_{uuid.uuid4().hex}_{offset + 1}", 31)
                try:
                    sheet.Name = temporary
                except Exception:
                    fail("LIBREOFFICE_SHEET_NAME_FAILED")
                temporary_names.append(temporary)
            for offset, sheet in enumerate(sheets):
                try:
                    sheet.Name = desired_names[offset]
                except Exception:
                    fail("LIBREOFFICE_SHEET_NAME_FAILED")

            for offset, desired_name in enumerate(desired_names):
                check_cancel(cancel_path)
                sheet = source_document.Sheets.getByName(desired_name)
                expected_item = {
                    "name": desired_name,
                    "visibility": sheet_visibility(sheet),
                    "fingerprint": sheet_fingerprint(sheet),
                }
                position = int(target.Sheets.getCount())
                try:
                    imported_position = int(target.Sheets.importSheet(source_document, desired_name, position))
                except Exception:
                    fail("LIBREOFFICE_SHEET_COPY_FAILED")
                if imported_position != position:
                    fail("LIBREOFFICE_SHEET_COPY_FAILED")
                imported = target.Sheets.getByIndex(imported_position)
                localize_imported_formula_links(imported, str(source_document.URL))
                try:
                    imported.IsVisible = expected_item["visibility"] == "visible"
                except Exception:
                    fail("LIBREOFFICE_SHEET_VISIBILITY_FAILED")
                expected.append(expected_item)
                if add_combined_sheet:
                    combined_entries.append((desired_name, source_descriptors[offset]))
            original_name_offset += len(sheets)
            close_document(source_document)
            opened_sources.pop()
            try:
                source_copy.unlink(missing_ok=True)
            except Exception:
                pass
            completed += 1
            emit_progress(source_index, completed, len(sources))

        if original_name_offset != len(original_expected_names):
            fail("LIBREOFFICE_EXPECTED_STRUCTURE_INVALID")

        combined_metadata = None
        if add_combined_sheet:
            check_cancel(cancel_path)
            combined_metadata = create_combined_value_sheet(target, combined_name, combined_entries)
            expected.insert(0, {
                "name": combined_metadata["name"],
                "visibility": combined_metadata["visibility"],
                "fingerprint": combined_metadata["fingerprint"],
            })

        check_cancel(cancel_path)
        try:
            target.store()
        except Exception:
            fail("LIBREOFFICE_SAVE_FAILED")
        close_document(target)
        target = None

        check_cancel(cancel_path)
        verified = load_document(desktop, output, True)
        try:
            sheets = document_sheets(verified)
            if len(sheets) != len(expected):
                fail("LIBREOFFICE_OUTPUT_VERIFY_FAILED")
            actual_names = []
            actual_visibility = []
            for index, sheet in enumerate(sheets):
                expected_item = expected[index]
                actual_name = str(sheet.Name)
                visibility = sheet_visibility(sheet)
                fingerprint = sheet_fingerprint(sheet)
                if actual_name != expected_item["name"] or visibility != expected_item["visibility"]:
                    fail("LIBREOFFICE_OUTPUT_VERIFY_FAILED")
                if fingerprint != expected_item["fingerprint"]:
                    fail("LIBREOFFICE_OUTPUT_CONTENT_CHANGED")
                if index == 0 and combined_metadata is not None:
                    descriptor = sheet_table_descriptor(sheet)
                    if (descriptor is None
                            or descriptor["rows"] != combined_metadata["rows"]
                            or descriptor["columns"] != combined_metadata["columns"]
                            or descriptor["header"] != combined_metadata["header"]
                            or fingerprint["formulaCount"] != 0):
                        fail("LIBREOFFICE_COMBINED_OUTPUT_CHANGED")
                actual_names.append(actual_name)
                actual_visibility.append(visibility)
        finally:
            close_document(verified)

        for source, raw in zip(sources, raw_sources):
            if source.stat().st_size != raw["bytes"] or sha256_file(source) != str(raw["sha256"]).lower():
                fail("INPUT_IDENTITY_CHANGED")
        return {
            "ok": True,
            "engine": "libreoffice",
            "outputPath": str(output),
            "sourceCount": len(sources),
            "sourceSheetCounts": source_sheet_counts,
            "sheetCount": len(actual_names),
            "sheetNames": actual_names,
            "sheetTypes": ["worksheet"] * len(actual_names),
            "sheetVisibility": actual_visibility,
            "baseStrategy": "libreoffice-physical-first-xlsx",
            "contentVerified": True,
            "combinedSheetAdded": add_combined_sheet,
            "combinedSheetName": combined_name if add_combined_sheet else "",
            "combinedRowCount": combined_metadata["rows"] if combined_metadata is not None else 0,
            "combinedColumnCount": combined_metadata["columns"] if combined_metadata is not None else 0,
            "combinedValueSnapshot": add_combined_sheet,
            "combinedDataMode": "calculated-values-with-cell-formatting" if add_combined_sheet else "",
        }
    finally:
        for document in reversed(opened_sources):
            close_document(document)
        close_document(target)
        terminate_office(process, desktop)


def main() -> int:
    result_path = None
    output_path = None
    try:
        if len(sys.argv) != 3 or sys.argv[1] != "--job":
            fail("ARGUMENTS_INVALID")
        job_path = normalized_file(sys.argv[2])
        job = read_json(job_path)
        result_path = normalized_file(job.get("resultPath"), extension_required=False)
        output_value = job.get("outputPath")
        if isinstance(output_value, str) and output_value:
            output_path = Path(output_value)
        result = merge(job)
        if not isinstance(result, dict):
            fail("LIBREOFFICE_OPERATION_FAILED")
        write_json(result_path, {"ok": True, "fatalError": None, "result": result})
        return 0
    except WorkerError as error:
        if output_path is not None:
            try:
                output_path.unlink(missing_ok=True)
            except Exception:
                pass
        if result_path is not None:
            try:
                write_json(result_path, {"ok": False, "fatalError": error.code, "result": None})
            except Exception:
                pass
        return 1
    except Exception:
        if output_path is not None:
            try:
                output_path.unlink(missing_ok=True)
            except Exception:
                pass
        if result_path is not None:
            try:
                write_json(result_path, {"ok": False, "fatalError": "LIBREOFFICE_OPERATION_FAILED", "result": None})
            except Exception:
                pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
