const OperationsCore = require('../operations-core');

function createdResponsesFromBatchUpdate(updated, requests = []) {
  if (!Array.isArray(updated?.replies)) return null;
  const replies = updated.replies;
  if (Array.isArray(requests) && requests.some((request) => request?.createItem)) {
    return requests.flatMap((request, requestIndex) => request?.createItem ? [replies[requestIndex]?.createItem || null] : []);
  }
  return replies.flatMap((reply) => reply?.createItem ? [reply.createItem] : []);
}

function idsFromCreateItemResponse(response) {
  if (!response || typeof response !== 'object') return { itemId: '', questionIds: [], legacyItem: null };
  const itemId = String(response.itemId || '').trim();
  const questionIds = (Array.isArray(response.questionId) ? response.questionId : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return { itemId, questionIds, legacyItem: response.item && typeof response.item === 'object' ? response.item : null };
}

function createdIdMappings(definitionInput, updated, requests = []) {
  const definition = OperationsCore.normalizeGoogleFormDefinition(definitionInput);
  const createdResponses = createdResponsesFromBatchUpdate(updated, requests);
  const itemIds = {};
  const questionIds = {};
  const questionIdsByItemId = {};
  const rowQuestionIdsByItemId = {};

  definition.items.forEach((item, index) => {
    const response = createdResponses?.[index] || null;
    const responseIds = idsFromCreateItemResponse(response);
    // Create replies are authoritative. The included Form may contain a later
    // collaborator edit, so it is never used as a positional ID fallback.
    const created = responseIds.legacyItem;
    const createdItemId = responseIds.itemId || String(created?.itemId || '').trim();
    if (createdItemId) itemIds[item.id] = createdItemId;
    const officialQuestionIds = responseIds.questionIds;
    if (officialQuestionIds.length) {
      const questionId = officialQuestionIds[0];
      questionIdsByItemId[item.id] = questionId;
      questionIds[item.id] = questionId;
      if (item.key) questionIds[item.key] = questionId;
      if (Array.isArray(item.rows) && item.rows.length) {
        const rowMappings = {};
        item.rows.forEach((row, rowIndex) => {
          const rowQuestionId = officialQuestionIds[rowIndex];
          if (rowQuestionId) rowMappings[row.id] = rowQuestionId;
        });
        if (Object.keys(rowMappings).length) rowQuestionIdsByItemId[item.id] = rowMappings;
      }
      return;
    }
    if (!created) return;
    const questionId = created.questionItem?.question?.questionId;
    if (questionId) {
      questionIdsByItemId[item.id] = questionId;
      questionIds[item.id] = questionId;
      if (item.key) questionIds[item.key] = questionId;
    }
    const rowQuestions = created.questionGroupItem?.questions || [];
    if (rowQuestions.length) {
      const rowMappings = {};
      (item.rows || []).forEach((row, rowIndex) => {
        const rowQuestionId = rowQuestions[rowIndex]?.questionId;
        if (!rowQuestionId) return;
        rowMappings[row.id] = rowQuestionId;
        if (rowIndex === 0) {
          questionIdsByItemId[item.id] = rowQuestionId;
          questionIds[item.id] = rowQuestionId;
          if (item.key) questionIds[item.key] = rowQuestionId;
        }
      });
      if (Object.keys(rowMappings).length) rowQuestionIdsByItemId[item.id] = rowMappings;
    }
  });
  return { itemIds, questionIds, questionIdsByItemId, rowQuestionIdsByItemId };
}

function questionIdsFromBatchUpdate(definition, updated) {
  return createdIdMappings(definition, updated).questionIds;
}

async function createGoogleFormShell(request, definition) {
  const created = await request('https://forms.googleapis.com/v1/forms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ info: { title: definition.title, documentTitle: definition.title } })
  });
  return {
    formId: created.formId,
    revisionId: String(created.revisionId || '').trim(),
    responderUri: created.responderUri || '',
    editUri: `https://docs.google.com/forms/d/${created.formId}/edit`
  };
}

async function configureGoogleForm(request, formId, definition, requests, requiredRevisionId = '') {
  const id = String(formId || '').trim();
  if (!id) throw new Error('질문을 구성할 Google 설문 ID가 없습니다.');
  const revisionId = String(requiredRevisionId || '').trim();
  const updated = await request(`https://forms.googleapis.com/v1/forms/${encodeURIComponent(id)}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests,
      includeFormInResponse: true,
      ...(revisionId ? { writeControl: { requiredRevisionId: revisionId } } : {})
    })
  });
  const mappings = createdIdMappings(definition, updated, requests);
  const singleQuestionKinds = new Set(['shortText', 'paragraph', 'radio', 'checkbox', 'dropdown', 'scale', 'date', 'time', 'rating']);
  const incompleteItems = definition.items.filter((item) => !mappings.itemIds[item.id]);
  const incompleteQuestions = definition.items.filter((item) => singleQuestionKinds.has(item.kind) && !mappings.questionIdsByItemId[item.id]);
  const incompleteGrids = definition.items.filter((item) => ['radioGrid', 'checkboxGrid'].includes(item.kind)
    && Object.keys(mappings.rowQuestionIdsByItemId[item.id] || {}).length !== (item.rows || []).length);
  if (incompleteItems.length || incompleteQuestions.length || incompleteGrids.length) {
    const error = new Error('Google 설문은 만들어졌지만 질문 연결 정보를 완전하게 확인하지 못했습니다. 설문을 다시 가져와 확인해주세요.');
    error.code = 'GOOGLE_FORM_CREATE_MAPPING_INCOMPLETE';
    error.details = {
      missingItemCount: incompleteItems.length,
      missingQuestionCount: incompleteQuestions.length,
      missingGridCount: incompleteGrids.length
    };
    throw error;
  }
  await request(`https://forms.googleapis.com/v1/forms/${encodeURIComponent(id)}:setPublishSettings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } },
      updateMask: 'publishState'
    })
  });
  const finalForm = await request(`https://forms.googleapis.com/v1/forms/${encodeURIComponent(id)}`);
  if (finalForm?.formId && finalForm.formId !== id) {
    const error = new Error('Google 설문 게시 후 다른 설문이 반환되어 작업을 중단했습니다.');
    error.code = 'GOOGLE_FORM_ID_CHANGED';
    throw error;
  }
  const publishState = finalForm?.publishSettings?.publishState;
  if (publishState?.isPublished !== true || publishState?.isAcceptingResponses !== true) {
    const error = new Error('Google 설문은 구성됐지만 게시 상태를 확인하지 못했습니다. Google 설문에서 게시 상태를 확인해주세요.');
    error.code = 'GOOGLE_FORM_PUBLISH_UNCONFIRMED';
    throw error;
  }
  return {
    formId: id,
    ...mappings,
    revisionId: String(finalForm?.revisionId || '').trim(),
    published: true,
    publishSettings: finalForm?.publishSettings || null
  };
}

module.exports = { configureGoogleForm, createGoogleFormShell, createdIdMappings, questionIdsFromBatchUpdate };
