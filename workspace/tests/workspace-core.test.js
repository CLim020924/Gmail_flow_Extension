const assert = require('node:assert/strict');
const Core = require('../workspace-core');

function run() {
  assert.equal(Core.MODULE_CATALOG.every((module) => module.page === module.id), true);

  let state = Core.createEmptyState();
  assert.equal(state.projects.length, 0);
  const firstNormalizedBuiltins = Core.normalizeState(state).library.workflowTemplates;
  const secondNormalizedBuiltins = Core.normalizeState(Core.normalizeState(state)).library.workflowTemplates;
  assert.deepEqual(secondNormalizedBuiltins, firstNormalizedBuiltins, '기본 업무 템플릿은 앱을 다시 열거나 정규화해도 ID와 시각이 바뀌지 않아야 한다');
  assert.equal(new Set(firstNormalizedBuiltins.flatMap((template) => template.steps.map((step) => step.id))).size, firstNormalizedBuiltins.reduce((count, template) => count + template.steps.length, 0), '기본 업무 템플릿 단계 ID는 서로 겹치지 않아야 한다');
  const concurrentlyNormalizedBuiltins = Core.threeWayMerge(
    { library: { workflowTemplates: firstNormalizedBuiltins } },
    { library: { workflowTemplates: Core.normalizeState(state).library.workflowTemplates } },
    { library: { workflowTemplates: Core.normalizeState(state).library.workflowTemplates } }
  );
  assert.equal(concurrentlyNormalizedBuiltins.library.workflowTemplates.find((template) => template.id === 'template-kac').steps.length, 6, '여러 창의 기본 업무 템플릿 병합이 KAC 단계를 중복시키지 않아야 한다');

  let result = Core.createProject(state, { id: 'project-a', name: '프로젝트 A', preset: 'schedule' });
  state = result.state;
  assert.equal(state.activeProjectId, 'project-a');
  assert.deepEqual(result.project.installedModules.sort(), ['layout', 'people', 'schedule']);

  result = Core.createProject(state, { id: 'project-b', name: '프로젝트 B', preset: 'full' });
  state = result.state;
  assert.equal(state.projects.length, 2);
  assert.equal(state.activeProjectId, 'project-b');

  state = Core.setActiveProject(state, 'project-a');
  assert.equal(Core.getActiveProject(state).name, '프로젝트 A');

  state = Core.setModuleInstalled(state, 'project-a', 'zoom', true);
  assert.equal(Core.getActiveProject(state).installedModules.includes('zoom'), true);

  state = Core.setModuleStatus(state, 'project-a', 'people', 'complete', '10명');
  assert.equal(Core.getProjectProgress(Core.getActiveProject(state)).complete, 1);

  result = Core.addConnection(state, { id: 'zoom-1', type: 'zoom', label: '회사 Zoom 1', account: 'zoom@example.com' });
  state = result.state;
  assert.equal(state.connections.length, 1);

  state = Core.updateProject(state, 'project-a', { settings: { defaultConnectionIds: { zoom: 'zoom-1' } } });
  assert.equal(Core.getActiveProject(state).settings.defaultConnectionIds.zoom, 'zoom-1');

  state = Core.updateProject(state, 'project-a', { data: { externalArtifacts: [{ kind: 'zoom', slotId: 'slot-1', connectionId: 'zoom-1', externalId: 'meeting-1', status: 'created', createdAt: new Date().toISOString() }] } });
  state = Core.setModuleStatus(state, 'project-a', 'zoom', 'complete', '회의 생성 완료');
  const previousConnectionIdentity = Core.connectionIdentity(state.connections.find((connection) => connection.id === 'zoom-1'));
  const authorization = Core.applyConnectionAuthorization(state, 'zoom-1', { connected: true, account: 'replacement@example.com' });
  state = authorization.state;
  assert.equal(authorization.accountChanged, true);
  assert.equal(state.connections.find((connection) => connection.id === 'zoom-1').account, 'replacement@example.com');
  assert.equal(state.projects.find((project) => project.id === 'project-a').data.externalArtifacts[0].status, 'superseded', '계정이 바뀌면 이전 계정의 외부 항목을 다시 사용하지 않아야 한다');
  assert.equal(state.projects.find((project) => project.id === 'project-a').moduleState.zoom.status, 'needsReview');
  assert.equal(Core.connectionIdentityMatches(state.connections.find((connection) => connection.id === 'zoom-1'), previousConnectionIdentity), false, '로그인 전 창이 보낸 외부 API 요청은 새 계정에서 실행하지 않아야 한다');
  assert.equal(Core.connectionIdentityMatches(state.connections.find((connection) => connection.id === 'zoom-1'), Core.connectionIdentity(state.connections.find((connection) => connection.id === 'zoom-1'))), true);
  const artifactBase = { externalArtifacts: [{ kind: 'gmailDraft', personId: 'person-1', connectionId: 'gmail-1', externalId: 'draft-1', status: 'created', updatedAt: '2026-01-01T00:00:00.000Z' }] };
  const artifactRemote = { externalArtifacts: [{ ...artifactBase.externalArtifacts[0], status: 'superseded', replacedAt: '2026-01-01T00:02:00.000Z', replacementReason: '계정 변경' }] };
  const artifactOperationResult = { externalArtifacts: [{ ...artifactBase.externalArtifacts[0], status: 'stale', updatedAt: '2026-01-01T00:03:00.000Z' }] };
  const terminalMerge = Core.threeWayMerge(artifactBase, artifactRemote, artifactOperationResult);
  assert.equal(terminalMerge.externalArtifacts[0].status, 'superseded', '계정 변경으로 종료된 artifact를 느리게 완료된 API 결과가 다시 활성화하지 않아야 한다');
  assert.equal(terminalMerge.externalArtifacts[0].replacementReason, '계정 변경');
  const terminalBaselineMerge = Core.threeWayMerge(artifactRemote, artifactRemote, artifactOperationResult);
  assert.equal(terminalBaselineMerge.externalArtifacts[0].status, 'superseded', '이미 종료된 artifact의 terminal 상태는 후속 저장에서도 유지되어야 한다');

  const concurrentFormLinks = Core.threeWayMerge(
    { linkedForms: [] },
    { linkedForms: [{ formId: 'form-a', title: 'A 설문' }] },
    { linkedForms: [{ formId: 'form-b', title: 'B 설문' }] }
  );
  assert.deepEqual(
    new Set(concurrentFormLinks.linkedForms.map((form) => form.formId)),
    new Set(['form-a', 'form-b']),
    '서로 다른 창에서 연결한 Forms가 배열 last-writer로 유실되지 않아야 한다'
  );
  const editedFormSurvivesStaleDeletion = Core.threeWayMerge(
    { linkedForms: [{ formId: 'form-a', title: '기존 설문', needsReview: false }] },
    { linkedForms: [] },
    { linkedForms: [{ formId: 'form-a', title: '수정 설문', needsReview: true }] }
  );
  assert.equal(editedFormSurvivesStaleDeletion.linkedForms[0].title, '수정 설문', '동시에 수정된 Form 연결을 오래된 창의 삭제로 없애지 않아야 한다');

  result = Core.duplicateProject(state, 'project-a');
  state = result.state;
  assert.equal(state.projects.length, 3);
  assert.equal(result.project.name, '프로젝트 A 복사본');
  assert.equal(result.project.counts.sessions, 0);

  state = Core.archiveProject(state, result.project.id);
  assert.notEqual(state.activeProjectId, result.project.id);
  assert.equal(state.projects.find((project) => project.id === result.project.id).status, 'archived');

  state = Core.removeConnection(state, 'zoom-1');
  assert.equal(state.connections.length, 0);
  assert.equal(state.projects.find((project) => project.id === 'project-a').settings.defaultConnectionIds.zoom, null);
  const missingAuthorization = Core.applyConnectionAuthorization(state, 'zoom-1', { connected: true, account: 'late@example.com' });
  assert.equal(missingAuthorization.connection, null, '로그인 기다리는 동안 삭제된 계정을 다시 만들지 않아야 한다');

  let driveResult = Core.addConnection(state, { id: 'drive-1', type: 'drive', label: '회사 Drive', account: 'drive-one@example.com', status: 'connected' });
  state = driveResult.state;
  assert.equal(Core.workspaceDriveConnection(state).id, 'drive-1', '연결된 Drive가 하나면 Workspace 전체 동기화 계정으로 자동 사용한다');
  driveResult = Core.addConnection(state, { id: 'drive-2', type: 'drive', label: '고객 Drive', account: 'drive-two@example.com', status: 'connected' });
  state = driveResult.state;
  assert.equal(Core.workspaceDriveConnection(state), null, 'Drive가 여러 개면 첫 계정을 임의로 사용하지 않는다');
  state.preferences.workspaceDriveConnectionId = 'drive-2';
  assert.equal(Core.workspaceDriveConnection(state).id, 'drive-2', '명시적으로 선택한 Workspace Drive 계정을 사용한다');
  state.connections.find((connection) => connection.id === 'drive-2').status = 'needsAuth';
  assert.equal(Core.workspaceDriveConnection(state), null, '명시적으로 선택한 Drive가 로그아웃되면 다른 계정으로 자동 전환하지 않는다');
  state.connections.find((connection) => connection.id === 'drive-2').status = 'connected';
  state.preferences.storageMode = 'drive';
  state = Core.removeConnection(state, 'drive-2');
  assert.equal(state.preferences.workspaceDriveConnectionId, null, '선택한 Drive 연결을 삭제하면 전역 동기화 선택도 해제한다');
  assert.equal(state.preferences.storageMode, 'local', '사용 중인 Workspace Drive 계정을 삭제하면 다른 계정으로 자동 업로드하지 않도록 로컬 저장으로 전환한다');

  state = Core.normalizeState(state);
  assert.ok(state.installedExtensions.includes('gmailFlow'));
  assert.equal(state.quickWorkspaces.gmailFlow.id, 'quick-gmailFlow');
  state = Core.updateProject(state, 'quick-gmailFlow', { data: { communication: { subjectTemplate: '빠른 메일' } } });
  assert.equal(state.quickWorkspaces.gmailFlow.data.communication.subjectTemplate, '빠른 메일');
  state = Core.setExtensionInstalled(state, 'gmailFlow', false);
  assert.equal(state.installedExtensions.includes('gmailFlow'), false);
  assert.equal(state.projects.every((project) => !project.installedModules.includes('gmailFlow')), true);
  state = Core.setExtensionInstalled(state, 'gmailFlow', true);
  assert.equal(state.quickWorkspaces.gmailFlow.scope, 'quick');

  assert.ok(state.library.workflowTemplates.some((template) => template.id === 'template-kac'));
  result = Core.createProject(state, { id: 'project-kac', name: 'KAC 4차', templateId: 'template-kac' });
  state = result.state;
  const projectKacStepIds = result.project.workflow.map((step) => step.id);
  assert.deepEqual(Core.normalizeState(state).projects.find((project) => project.id === 'project-kac').workflow.map((step) => step.id), projectKacStepIds, '기존 프로젝트 단계 ID는 기본 템플릿 정규화와 별개로 유지되어야 한다');
  assert.equal(result.project.workflowTemplate.familyId, 'kac');
  assert.ok(result.project.workflow.some((step) => step.type === 'documentReview'));
  const checklistStep = result.project.workflow.find((step) => step.type === 'checklist');
  state = Core.setWorkflowStepStatus(state, result.project.id, checklistStep.id, 'needsReview', '누락 2건');
  assert.equal(Core.getActiveProject(state).workflow.find((step) => step.id === checklistStep.id).notes, '누락 2건');
  const revisedWorkflow = Core.getActiveProject(state).workflow.concat({ type: 'report', name: '최종 보고' });
  state = Core.updateProjectWorkflow(state, result.project.id, revisedWorkflow);
  assert.equal(Core.getActiveProject(state).workflow.at(-1).type, 'report');
  let savedTemplate = Core.saveWorkflowTemplate(state, result.project.id, { name: '우리 회사 KAC' });
  state = savedTemplate.state;
  assert.equal(savedTemplate.template.version, 1);
  savedTemplate = Core.saveWorkflowTemplate(state, result.project.id, { name: '우리 회사 KAC' });
  state = savedTemplate.state;
  assert.equal(savedTemplate.template.version, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(savedTemplate.template.configuration, 'people'), false);
  const templatedProject = Core.createProject(state, { id: 'project-from-template', name: '템플릿 프로젝트', templateId: savedTemplate.template.id });
  assert.equal(templatedProject.project.workflow.length, savedTemplate.template.steps.length);
  assert.equal(templatedProject.project.data.people.length, 0);
  state = templatedProject.state;
  state = Core.removeWorkflowTemplate(state, savedTemplate.template.id);
  assert.equal(state.library.workflowTemplates.some((template) => template.id === savedTemplate.template.id), false);

console.log('workspace-core tests passed');
}

run();
