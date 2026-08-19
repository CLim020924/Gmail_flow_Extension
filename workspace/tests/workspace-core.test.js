const assert = require('node:assert/strict');
const Core = require('../workspace-core');

function run() {
  let state = Core.createEmptyState();
  assert.equal(state.projects.length, 0);

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
