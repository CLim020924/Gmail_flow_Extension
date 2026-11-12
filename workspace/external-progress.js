(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkspaceExternalProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clean(value) { return String(value || '').trim(); }

  /**
   * Runs one external API call at a time and requires its local durable commit
   * to finish before the next API call can start. API failures may be handled
   * and skipped; commit failures always abort the batch so a later run cannot
   * unknowingly repeat an already successful external operation.
   */
  async function runDurableBatch(items, { execute, commit, onApiFailure, onCommitted } = {}) {
    if (typeof execute !== 'function' || typeof commit !== 'function') throw new TypeError('execute와 commit 함수가 필요합니다.');
    const successes = [];
    const failures = [];
    for (let index = 0; index < (items || []).length; index += 1) {
      const item = items[index];
      let result;
      try {
        result = await execute(item, index);
      } catch (error) {
        failures.push({ item, index, error });
        if (typeof onApiFailure === 'function') await onApiFailure(item, error, index);
        continue;
      }
      // Deliberately outside the API try/catch: a failed durable commit must
      // stop the batch instead of being mistaken for a harmless API failure.
      const commitResult = await commit(item, result, index);
      const success = { item, index, result, commitResult };
      successes.push(success);
      if (typeof onCommitted === 'function') await onCommitted(success);
    }
    return { successes, failures };
  }

  function latestActiveArtifact(project, kind, predicate = () => true) {
    return (project?.data?.externalArtifacts || [])
      .filter((artifact) => artifact.kind === kind && artifact.status !== 'superseded' && predicate(artifact))
      .sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))[0] || null;
  }

  function pendingZoomSlots(project, connectionIdForSlot) {
    return (project?.data?.slots || []).filter((slot) => {
      const connectionId = clean(connectionIdForSlot?.(slot));
      return slot.status !== 'cancelled'
        && (project?.data?.assignments || []).some((assignment) => assignment.slotId === slot.id)
        && !(project?.data?.externalArtifacts || []).some((artifact) => artifact.kind === 'zoom' && artifact.slotId === slot.id && artifact.connectionId === connectionId && artifact.status === 'created' && clean(artifact.externalId));
    });
  }

  function pendingGmailEntries(project, entries, connectionId) {
    return (entries || []).filter((entry) => {
      const artifact = latestActiveArtifact(project, 'gmailDraft', (candidate) => candidate.personId === entry.personId && candidate.connectionId === connectionId);
      return artifact?.status !== 'created' || !clean(artifact.externalId);
    });
  }

  function findReusableGoogleForm(project, definitionId, connectionId) {
    return (project?.data?.forms?.linkedForms || [])
      .filter((linked) => linked.source === 'created'
        && linked.definitionId === definitionId
        && linked.connectionId === connectionId
        && linked.setupStatus !== 'configured')
      .sort((left, right) => String(right.updatedAt || right.connectedAt || '').localeCompare(String(left.updatedAt || left.connectedAt || '')))[0] || null;
  }

  function upsertGoogleForm(formsInput, linkedForm) {
    const forms = JSON.parse(JSON.stringify(formsInput || { definitions: [], linkedForms: [], selectedFormId: null, lastResponseSyncAt: null }));
    forms.linkedForms ||= [];
    const index = forms.linkedForms.findIndex((item) => item.formId === linkedForm.formId);
    if (index >= 0) forms.linkedForms[index] = { ...forms.linkedForms[index], ...linkedForm };
    else forms.linkedForms.push({ ...linkedForm });
    forms.selectedFormId = linkedForm.formId;
    return forms;
  }

  return {
    runDurableBatch,
    latestActiveArtifact,
    pendingZoomSlots,
    pendingGmailEntries,
    findReusableGoogleForm,
    upsertGoogleForm
  };
});
