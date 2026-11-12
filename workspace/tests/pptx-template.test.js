const assert = require('node:assert/strict');
const { parseSlideTextBlocks, replaceSlideText } = require('../desktop/pptx-template');

const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="수료 문구"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="5000" cy="800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p>
        <a:r><a:rPr lang="ko-KR" sz="2400" b="0"/><a:t>성명: 홍</a:t></a:r>
        <a:r><a:rPr lang="ko-KR" sz="2400" b="1"/><a:t>길동</a:t></a:r>
        <a:r><a:rPr lang="en-US" sz="1800"/><a:t xml:space="preserve"> 님 / ID: sample@example.com</a:t></a:r>
      </a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

const size = { width: 10_000, height: 5_625 };
const [block] = parseSlideTextBlocks(slideXml, 1, size);
assert(block, 'synthetic text block must be detected');
assert.equal(block.text, '성명: 홍길동 님 / ID: sample@example.com');

const nameStart = block.text.indexOf('홍길동');
const emailStart = block.text.indexOf('sample@example.com');
const updatedXml = replaceSlideText(slideXml, 1, new Map([[
  block.id,
  [
    { start: nameStart, end: nameStart + '홍길동'.length, selectedText: '홍길동', value: 'Alexandria Catherine Johnson' },
    { start: emailStart, end: emailStart + 'sample@example.com'.length, selectedText: 'sample@example.com', value: 'a@b.co' }
  ]
]]));
const [updated] = parseSlideTextBlocks(updatedXml, 1, size);
assert.equal(updated.text, '성명: Alexandria Catherine Johnson 님 / ID: a@b.co');
assert.match(updatedXml, /sz="2400" b="0"/);
assert.match(updatedXml, /sz="2400" b="1"/);
assert.match(updatedXml, /sz="1800"/);
assert.match(updatedXml, /Alexandria Catherine Johnson/);

const twoLetterXml = replaceSlideText(slideXml, 1, new Map([[block.id, [
  { start: nameStart, end: nameStart + '홍길동'.length, selectedText: '홍길동', value: '김별' }
]]]));
assert.equal(parseSlideTextBlocks(twoLetterXml, 1, size)[0].text, '성명: 김별 님 / ID: sample@example.com');

assert.throws(() => replaceSlideText(slideXml, 1, new Map([[block.id, [
  { start: nameStart, end: nameStart + 3, selectedText: '다른글자', value: '실패' }
]]])), /선택한 글자가 바뀌었습니다/);

console.log('pptx template partial text replacement tests passed');
