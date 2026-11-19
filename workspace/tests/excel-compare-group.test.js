'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('../vendor/node_modules/exceljs');
const { analyzeExcelCompareGroups, compareAndGroupExcelFiles, normalizeMatchValue } = require('../desktop/excel-compare-group');

(async () => {
  assert.equal(normalizeMatchValue(' 010-1234-5678 '), 'phone:01012345678');
  assert.equal(normalizeMatchValue('USER@Example.COM'), 'user@example.com');
  assert.equal(normalizeMatchValue('홍  길동'), '홍 길동');

  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cmoe-excel-compare-'));
  const sourcePath = path.join(temp, 'survey.xlsx'); const outputPath = path.join(temp, 'result.xlsx');
  try {
    const workbook = new ExcelJS.Workbook();
    const roster = workbook.addWorksheet('전체명단');
    roster.addRows([
      ['이름', '전화번호', '이메일', '반'],
      ['김민지', '010-2222-3333', 'minji@example.com', 'A반'],
      ['홍길동', '010-1234-5678', 'hong@example.com', 'B반'],
      ['미참여', '010-9999-0000', 'none@example.com', 'A반']
    ]);
    const responses = workbook.addWorksheet('설문응답');
    responses.addRows([
      ['성명', '휴대전화', '메일', '응답'],
      ['홍길동', '01012345678', 'HONG@example.com', '참여'],
      ['김민지', '010 2222 3333', 'MINJI@example.com', '미참여'],
      ['명단없음', '010-5555-6666', 'new@example.com', '참여']
    ]);
    await workbook.xlsx.writeFile(sourcePath);

    const options = {
      left: { sheetIndex: 0, headerRow: 1, keyColumn: 3 },
      right: { sheetIndex: 1, headerRow: 1, keyColumn: 3 },
      matchPairs: [{ leftColumn: 1, rightColumn: 1 }, { leftColumn: 2, rightColumn: 2 }, { leftColumn: 3, rightColumn: 3 }],
      baseSide: 'b',
      outputColumns: [
        { source: 'merged', leftColumn: 3, rightColumn: 3, prefer: 'b', label: '이메일' },
        { source: 'merged', leftColumn: 1, rightColumn: 1, prefer: 'a', label: '이름' },
        { source: 'a', columnIndex: 4, label: 'A · 반' },
        { source: 'b', columnIndex: 4, label: 'B · 응답' }
      ],
      filters: [{ source: 'b', columnIndex: 4, operator: 'equals', value: '참여' }],
      rules: []
    };
    const plan = await analyzeExcelCompareGroups(sourcePath, sourcePath, options);
    assert.equal(plan.allMatchedCount, 2);
    assert.equal(plan.matchedCount, 1);
    assert.equal(plan.filteredOutCount, 1);
    assert.equal(plan.classifiedCount, 1);
    assert.equal(plan.otherCount, 0);
    assert.equal(plan.unmatchedACount, 1);
    assert.equal(plan.unmatchedBCount, 1);

    const result = await compareAndGroupExcelFiles(sourcePath, sourcePath, outputPath, options);
    assert.equal(result.allMatchedCount, 2);
    assert.equal(result.matchedCount, 1);
    assert.equal(result.contentVerified, true);
    assert.equal(result.sheets[0].name, '일괄 발송 명단');
    const generated = new ExcelJS.Workbook(); await generated.xlsx.readFile(outputPath);
    const mailSheet = generated.getWorksheet('일괄 발송 명단');
    assert.deepEqual(mailSheet.getRow(1).values.slice(1), ['이메일', '이름', 'A · 반', 'B · 응답']);
    assert.deepEqual(mailSheet.getRow(2).values.slice(1), ['HONG@example.com', '홍길동', 'B반', '참여']);
    assert.equal(mailSheet.getRow(3).values.slice(1).length, 0);
    assert(generated.getWorksheet('미매칭 A'));
    assert(generated.getWorksheet('미매칭 B'));

    console.log('Excel compare multi-column matching, result filtering, merged fields, and selected output ordering passed.');
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
