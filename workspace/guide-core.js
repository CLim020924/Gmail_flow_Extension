(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkspaceGuideCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const GUIDE_VERSION = 13;

  const step = (id, page, target, title, description, interaction = 'next', extra = {}) => ({
    id, page, target, title, description, interaction, ...extra
  });

  const documentStep = (id, target, title, description, interaction = 'next', documentMode = '', extra = {}) => step(
    id,
    'documentEditor',
    target,
    title,
    description,
    interaction,
    { ...(documentMode ? { documentMode } : {}), ...extra }
  );

  const GUIDES = [
    {
      id: 'workspace-overview',
      group: 'featured',
      icon: '처음',
      name: '처음부터 끝까지 체험',
      description: '프로젝트를 고르고 명단·일정·캘린더·결과표·Zoom·메일이 이어지는 전체 흐름을 익힙니다.',
      minutes: 7,
      startPage: 'dashboard',
      steps: [
        step('overview-project', 'dashboard', '#activeProjectName', '이 프로젝트에서 연습합니다', '지금 보이는 자료는 가이드 전용입니다. 입력하거나 바꿔도 실제 프로젝트에는 저장되지 않습니다.'),
        step('overview-global-calendar', 'dashboard', '#dashboardCalendarPanel', '모든 프로젝트 일정을 한곳에서 봅니다', '프로젝트 색으로 일정을 구분하고, 일정을 누르면 해당 프로젝트 캘린더로 바로 이동합니다.'),
        step('overview-switcher', 'dashboard', '#projectSwitcher', '프로젝트를 먼저 확인하세요', '상단에서 현재 프로젝트를 바꿉니다. 프로젝트마다 명단·일정·메일 결과가 서로 섞이지 않습니다.'),
        step('overview-summary', 'dashboard', '.summary-grid', '현재 상태를 한눈에 봅니다', '사람 수, 일정 수, 확인할 문제를 먼저 보고 오늘 할 일을 판단할 수 있습니다.'),
        step('overview-workflow', 'dashboard', '#workflowGrid', '업무는 원하는 순서로 구성합니다', '명단부터 메일까지 필요한 단계만 두고, 이름·설명·순서는 프로젝트에 맞게 바꿀 수 있습니다.'),
        step('overview-open-people', 'dashboard', '[data-workflow-open="people"]', '명단 준비를 열어보세요', '업무 흐름의 명단 준비를 누르면 원본 명단과 단계별 명단을 함께 관리할 수 있습니다.', 'target'),
        step('overview-roster', 'people', '#rosterEditorTable', '명단은 표에서 바로 다룹니다', '셀을 클릭해 입력하고, 여러 셀을 드래그해 복사·붙여넣기·채우기 작업을 연습해보세요.', 'practice'),
        step('overview-back-from-people', 'people', '[data-nav="dashboard"]', '프로젝트 홈으로 돌아가세요', '각 프로그램을 마치면 프로젝트 홈에서 다음 업무를 이어서 열 수 있습니다.', 'target'),
        step('overview-open-schedule', 'dashboard', '[data-workflow-open="schedule"]', '일정 편성을 열어보세요', '명단에서 사용할 역할과 가능한 시간으로 전체 일정을 만들고 직접 조정합니다.', 'target'),
        step('overview-schedule-setup', 'schedule', '#scheduleSetupDetails', '역할과 시간대를 먼저 정합니다', '역할 이름은 자유롭게 바꿀 수 있습니다. 진행자·참여자뿐 아니라 어떤 분야의 구분도 사용할 수 있습니다.'),
        step('overview-session-planner', 'schedule', '#sessionCalendarBoard', '사람 중심으로 재배치합니다', '사람을 선택하거나 끌어서 다른 시간에 놓으면 이동·교환이 전체 일정에 미치는 영향을 먼저 보여줍니다.', 'practice'),
        step('overview-back-from-schedule', 'schedule', '[data-nav="dashboard"]', '프로젝트 홈으로 돌아가세요', '편성 결과는 같은 프로젝트의 다음 프로그램에서 그대로 이어집니다.', 'target'),
        step('overview-open-calendar', 'dashboard', '[data-workflow-open="projectCalendar"]', '전체 캘린더를 열어보세요', '큰 세션 구간과 그 안의 그룹 배치를 같은 프로젝트 자료로 이어서 관리합니다.', 'target'),
        step('overview-calendar-session', 'projectCalendar', '[data-session-card="guide-calendar-session"]', '운영할 세션 구간을 눌러보세요', '전체 일정에는 큰 기간만 보여 복잡도를 낮추고, 구간을 열면 그룹별 세부 배치가 나타납니다.', 'target'),
        step('overview-calendar-individual', 'projectCalendar', '[data-session-open-legacy]', '개별 일정 관리로 이어갑니다', '필요할 때만 개별 일정 화면을 열어 진행 내용, 담당자와 외부 회의 상태를 다룹니다.', 'target'),
        step('overview-calendar-event', 'projectCalendar', '[data-calendar-event="guide-slot-future-a"]', '미래 일정을 눌러보세요', '세션 그룹 배치와 같은 원본 일정에서 진행 내용, 담당자, Zoom 연결과 변경 기능을 확인합니다.', 'target'),
        step('overview-calendar-detail', 'projectCalendar', '#calendarDetail', '한 일정의 모든 정보를 봅니다', '고객 사정으로 시간이 바뀌면 여기서 관련 일정과 사람을 함께 보며 재조정할 수 있습니다.'),
        step('overview-back-from-calendar', 'projectCalendar', '[data-nav="dashboard"]', '프로젝트 홈으로 돌아가세요', '캘린더에서 확인한 일정을 결과표와 외부 서비스 업무로 이어갑니다.', 'target'),
        step('overview-open-layout', 'dashboard', '[data-workflow-open="layout"]', '결과표 화면을 열어보세요', '확정된 일정은 원하는 표 형태로 확인한 뒤 Excel 또는 CSV로 저장합니다.', 'target'),
        step('overview-layout-preview', 'layout', '#outputPreviewTable', '저장 전에 결과를 확인합니다', '내보낼 파일과 같은 내용을 먼저 보여주므로 잘못된 배치나 누락을 확인할 수 있습니다.'),
        step('overview-back-from-layout', 'layout', '[data-nav="dashboard"]', '프로젝트 홈으로 돌아가세요', '결과를 확인했으면 같은 업무 흐름에서 회의 준비를 이어갑니다.', 'target'),
        step('overview-open-zoom', 'dashboard', '[data-workflow-open="zoom"]', 'Zoom 화면을 열어보세요', '일정마다 사용할 계정과 회의 생성 대상을 확인합니다.', 'target'),
        step('overview-zoom-plan', 'zoom', '#zoomPlanTable', '회의는 일정과 연결됩니다', '회의를 만든 뒤 일정이 바뀌면 다시 확인해야 할 회의를 분명히 표시합니다.'),
        step('overview-back-from-zoom', 'zoom', '[data-nav="dashboard"]', '프로젝트 홈으로 돌아가세요', '회의 준비가 끝나면 마지막 안내 메일 단계로 이어갑니다.', 'target'),
        step('overview-open-mail', 'dashboard', '[data-workflow-open="gmailFlow"]', '안내 메일을 열어보세요', '명단·개인 일정·Zoom 링크를 받는 사람마다 자동으로 합칩니다.', 'target'),
        step('overview-mail-preview', 'gmailFlow', '#mailPreviewTable', '사람별 결과를 마지막에 확인합니다', 'Gmail에 저장하기 전에 각 사람의 제목·본문·개인 일정을 직접 확인하고 필요한 사람만 따로 수정할 수 있습니다.'),
        step('overview-finish', 'gmailFlow', '.mail-primary-actions', '전체 흐름을 익혔습니다', '개별 프로그램 가이드에서는 셀 드래그, 일정 교환, 외부 서비스 준비를 더 자세히 연습할 수 있습니다.')
      ]
    },
    {
      id: 'projects-workflow',
      group: 'management',
      icon: 'P',
      name: '프로젝트·업무 구성',
      description: '새 프로젝트, 업무 템플릿, 단계 편집과 프로젝트별 설정을 체험합니다.',
      minutes: 5,
      startPage: 'projects',
      steps: [
        step('projects-list', 'projects', '#projectCards', '프로젝트는 독립된 작업 공간입니다', '고객·과정·기간이 다른 일은 프로젝트를 나눠 관리합니다.'),
        step('projects-new', 'projects', '#newProjectButton', '새 프로젝트를 눌러보세요', '이름과 기간, 시작할 업무 템플릿을 고르는 창이 열립니다.', 'target'),
        step('projects-name', 'projects', '#projectName', '프로젝트 이름과 기간을 입력합니다', '지금 입력한 내용은 연습용이며 실제 프로젝트 목록에는 남지 않습니다.', 'practice'),
        step('projects-template', 'projects', '#newProjectTemplatePicker', '업무 템플릿을 선택합니다', '템플릿은 시작 구조일 뿐입니다. 만든 뒤에도 단계 이름과 순서를 자유롭게 바꿀 수 있습니다.', 'practice'),
        step('projects-start-steps', 'projects', '#newProjectWorkflowDetails', '시작할 프로그램을 원하는 순서에 넣습니다', '필요할 때만 펼쳐 명단·일정뿐 아니라 문서 편집도 추가하고 ↑↓로 중간 위치에 배치할 수 있습니다.'),
        step('projects-create', 'projects', '#newProjectForm button[type="submit"]', '만들기 동작을 체험해보세요', '가이드에서는 실제 프로젝트 대신 지금의 연습 프로젝트를 계속 사용합니다.', 'simulate', { simulation: 'finish-new-project' }),
        step('projects-workflow', 'dashboard', '#workflowGrid', '프로젝트의 업무 흐름입니다', '프로그램 단계와 체크리스트·문서 검토 같은 범용 단계를 한 흐름에 섞을 수 있습니다.'),
        step('projects-edit', 'dashboard', '#editWorkflowButton', '업무 구성 편집을 눌러보세요', '단계의 이름·설명·순서와 필요한 추가 업무를 설정할 수 있습니다.', 'target'),
        step('projects-editor', 'dashboard', '#workflowEditorList', '단계를 직접 구성합니다', '자주 바뀌지 않는 구조는 업무 템플릿으로 저장해 새 프로젝트에도 그대로 적용할 수 있습니다.', 'practice'),
        step('projects-save-workflow', 'dashboard', '#workflowEditorForm button[type="submit"]', '프로젝트 적용을 체험합니다', '연습 중 변경은 실제 프로젝트나 전역 템플릿에 저장되지 않습니다.', 'simulate', { simulation: 'finish-workflow-editor' }),
        step('projects-settings', 'dashboard', '#projectSettingsButton', '프로젝트 설정을 눌러보세요', '기간·기본 일정 규칙과 이 프로젝트만 사용할 예외 계정을 설정합니다.', 'target'),
        step('projects-settings-fields', 'dashboard', '#projectSettingsDialog .dialog-body', '기본값은 필요할 때만 바꿉니다', '평소에는 Workspace 전역 구조와 기본 계정을 이어받고, 이 프로젝트만 다른 경우에만 예외를 둡니다.', 'practice'),
        step('projects-settings-save', 'dashboard', '#projectSettingsForm button[type="submit"]', '설정 저장 동작을 체험합니다', '가이드가 끝나면 입력한 연습값은 모두 사라집니다.', 'simulate', { simulation: 'finish-project-settings' })
      ]
    },
    {
      id: 'people', group: 'program', moduleId: 'people', icon: '명', name: '명단',
      description: '셀 입력·드래그·복사·붙여넣기, 컬럼과 단계 명단, 그룹 작업표까지 연습합니다.', minutes: 6, startPage: 'people',
      steps: [
        step('people-overview', 'people', '#rosterManagerSummary', '원본 명단이 모든 작업의 기준입니다', '원본을 고치면 일정과 메일도 같은 사람을 사용합니다. 단계별로 일부 인원만 쓰는 명단은 아래에서 따로 만듭니다.'),
        step('people-columns', 'people', '#rosterEditorTable thead', '컬럼 이름과 의미를 정합니다', '이름·이메일·전화번호 외에도 부서, 반, 자격, 메모처럼 필요한 컬럼을 자유롭게 추가할 수 있습니다.', 'practice'),
        step('people-cell', 'people', '#rosterEditorTable [data-sheet-row="1"][data-sheet-col="0"] input', '셀을 직접 수정해보세요', '입력한 값은 연습용 명단에만 반영됩니다. Enter와 방향키로 다음 셀로 이동할 수 있습니다.', 'practice'),
        step('people-range', 'people', '#rosterEditorTable tbody', '여러 셀을 드래그해보세요', '마우스로 범위를 끌어 선택한 뒤 Ctrl+C/V, Delete, Ctrl+Z를 사용해보세요. 표 위의 셀 작업 메뉴에서도 채우기와 행·열 작업을 찾을 수 있습니다.', 'practice'),
        step('people-selection', 'people', '#rosterSelectionStatus', '선택 범위를 확인합니다', 'A2:C4처럼 현재 선택한 범위가 표시되어 큰 명단에서도 실수를 줄여줍니다.'),
        step('people-toolbar', 'people', '.roster-compact-toolbar', '표 도구는 가까운 곳에 모았습니다', '행·열 추가, 실행 취소, 선택 영역 작업을 표 위에서 바로 사용할 수 있습니다.'),
        step('people-views', 'people', '#rosterViewSelect', '원본을 복제하지 않고 단계 명단을 만듭니다', '합격자, A반, 참석자처럼 필요한 인원만 포함한 명단을 만들 수 있고 원본은 유지됩니다.', 'practice'),
        step('people-work', 'people', '#rosterStartTask', '이 명단으로 할 작업을 고릅니다', '그룹 나누기, 짝 연결, 자유 작업표, 일정, 설문, 메일로 이어갈 수 있습니다.'),
        step('people-arrangement', 'arrange', '#arrangementBoard', '그룹·짝 결과도 표에서 수정합니다', '자동 초안이 마음에 들지 않으면 셀을 드래그하거나 직접 입력해 원하는 배치로 바꿀 수 있습니다.', 'practice')
      ]
    },
    {
      id: 'forms', group: 'program', moduleId: 'forms', icon: '설', name: '설문',
      description: '질문 편집, 전역 양식, 미리보기, 실제 생성과 응답 연결 흐름을 체험합니다.', minutes: 6, startPage: 'forms',
      steps: [
        step('forms-title', 'forms', '#formTitleInput', '설문 제목을 직접 편집합니다', '자유 설문은 처음부터 만들고, 명단·가능 시간과 이을 때는 상단 시작 양식을 고른 뒤 제목과 질문을 자유롭게 바꿔보세요.', 'practice'),
        step('forms-question', 'forms', '#addFormQuestion', '필요한 질문을 하나 추가해보세요', '질문 카드에서 유형·선택지·필수 여부를 정하고 섹션이나 설명·이미지도 필요한 만큼 섞을 수 있습니다.', 'target'),
        step('forms-template-save', 'forms', '#saveSharedFormTemplate', '완성한 구성은 전역 양식으로 저장합니다', '저장한 양식은 특정 프로젝트에 묶이지 않아 새 프로젝트에서도 다시 불러올 수 있습니다. 가이드에서는 실제 보관함에 저장하지 않습니다.'),
        step('forms-preview-open', 'forms', '#previewGoogleFormDraft', '하단에서 응답 화면을 미리 봅니다', '미리보기는 Google에 아무것도 만들지 않고 응답자에게 보일 화면만 엽니다. 버튼을 눌러 확인해보세요.', 'target'),
        step('forms-preview-close', 'forms', '#closeFormPreview', '미리보기와 실제 생성을 구분합니다', '내용을 확인했으면 닫으세요. 편집 화면으로 돌아가도 아직 Google 설문은 생성되지 않은 상태입니다.', 'target'),
        step('forms-create', 'forms', '#createGoogleForm', 'Google 설문 생성 동작을 체험하세요', '가이드에서는 로그인이나 Google API를 호출하지 않고 생성 결과만 보여줍니다.', 'simulate', { simulation: 'google-form' }),
        step('forms-import', 'forms', '#importGoogleForm', 'Google에서 만든 설문도 가져옵니다', '편집 주소를 붙여넣어 기존 설문을 이 프로젝트와 연결할 수 있습니다. 고급 기능은 Google Forms에서 편집한 뒤 다시 불러오면 됩니다.'),
        step('forms-sync', 'forms', '#syncFormResponses', '응답 가져오기를 체험하세요', '가이드의 가상 응답이 명단과 사람별 가능 시간에 반영되는 과정을 보여줍니다.', 'simulate', { simulation: 'google-responses' })
      ]
    },
    {
      id: 'schedule', group: 'program', moduleId: 'schedule', icon: '일', name: '일정 편성',
      description: '역할·시간·가능 시간, 자동 편성, 사람 이동과 셀 직접 수정을 연습합니다.', minutes: 7, startPage: 'schedule',
      steps: [
        step('schedule-roles', 'schedule', '#roleEditor', '역할 이름과 필요한 인원을 정합니다', '진행자·참여자라는 고정 개념이 아닙니다. 면접관, 장비, 차량처럼 원하는 역할로 바꿀 수 있습니다.', 'practice'),
        step('schedule-slots', 'schedule', '#scheduleAddEventButton', '날짜와 시간을 버튼으로 선택합니다', '한 일정은 달력형 날짜와 시간 입력으로 추가하고, 여러 날이면 시작일과 종료일을 각각 선택하세요.', 'target'),
        step('schedule-slot-editor', 'schedule', '#calendarEventDialog .calendar-event-body', '일정 이름과 범위를 한 화면에서 정합니다', '1시간·2시간·09시–18시 빠른 선택을 쓸 수 있고 종료가 시작보다 빠르면 저장 전에 바로 알려줍니다.', 'practice'),
        step('schedule-slots-advanced', 'schedule', '.schedule-bulk-details', '여러 줄 붙여넣기는 고급 기능입니다', '이미 정리된 일정 목록이 있을 때만 펼쳐서 사용하세요. 평소에는 위 날짜·시간 선택이 더 쉽습니다.'),
        step('schedule-availability', 'schedule', '#availabilityMatrix', '사람별 가능한 시간을 표시합니다', '체크하지 않은 시간이 가능한지 불가능한지는 편성 규칙에서 선택할 수 있습니다.', 'practice'),
        step('schedule-generate', 'schedule', '#generateScheduleButton', '조건에 맞춰 다시 편성해보세요', '잠긴 일정은 유지하고, 나머지만 역할·가능 시간·반복 조건에 맞춰 계산합니다.', 'simulate', { simulation: 'schedule-generate' }),
        step('schedule-person', 'schedule', '[data-session-person="guide-person-2"]', '일정을 바꿀 사람을 선택하세요', '현재 배치와 옮길 수 있는 일정이 캘린더에 표시됩니다.', 'target'),
        step('schedule-move', 'schedule', '#sessionCalendarBoard', '다른 일정에 놓아 변경을 미리 봅니다', '카드를 클릭하거나 사람을 끌어 놓아보세요. 이동·교환·충돌을 적용 전에 확인합니다.', 'practice'),
        step('schedule-preview', 'schedule', '#sessionChangePreview', '변경 영향은 적용 전에 확인합니다', '가능 시간 위반이나 정원 변화, 다시 확인할 Zoom·메일 대상을 함께 보여줍니다.', 'next', { prepare: 'schedule-preview' }),
        step('schedule-sheet', 'schedule', '#scheduleBoard', '전체 표에서도 직접 수정할 수 있습니다', '셀 드래그, 복사·붙여넣기, Delete와 실행 취소를 사용해 많은 일정을 빠르게 다듬습니다.', 'practice')
      ]
    },
    {
      id: 'project-calendar', group: 'program', moduleId: 'projectCalendar', icon: '캘', name: '캘린더',
      description: '전체 세션부터 그룹 시간 배치, 개별 진행표와 사람 재조정까지 이어서 체험합니다.', minutes: 10, startPage: 'projectCalendar',
      steps: [
        step('calendar-session-overview', 'projectCalendar', '[data-session-overview]', '먼저 큰 세션 구간만 봅니다', '프로젝트 전체 일정에서는 세부 그룹을 숨기고 운영 기간만 보여 한눈에 흐름을 파악합니다.', 'practice'),
        step('calendar-session-range', 'projectCalendar', '.pss-overview-grid', '빈 날짜를 누른 채 범위로 끌어보세요', '21일부터 25일까지처럼 드래그하면 시작일과 종료일이 한 번에 선택되고, 쉬운 편집창에서 이름과 상태만 정하면 됩니다.', 'practice'),
        step('calendar-session-open', 'projectCalendar', '[data-session-card="guide-calendar-session"]', '샘플 세션을 열어보세요', '이제 이 구간에 속한 그룹과 세부 시간 배치를 한 화면에서 봅니다.', 'target'),
        step('calendar-session-views', 'projectCalendar', '.pss-view-switch', '일·주·월 보기를 바꿉니다', '당일 운영은 일, 여러 그룹 비교는 주, 긴 흐름은 월 보기로 전환합니다.', 'practice'),
        step('calendar-session-time', 'projectCalendar', '.pss-display-settings', '보이는 시간과 눈금은 직접 정합니다', '시작·종료 시간과 5분부터 2시간까지의 간격을 선택하므로 시간 형식을 외워 입력할 필요가 없습니다.', 'practice'),
        step('calendar-session-groups', 'projectCalendar', '[data-session-unassigned-pool]', '명단으로 만든 그룹을 배치합니다', '그룹 카드에는 구성원이 이어져 있고, 카드를 시간표로 끌거나 배치 버튼을 눌러 원하는 날짜와 시간에 놓습니다.', 'practice'),
        step('calendar-session-board', 'projectCalendar', '.pss-placement-workspace', '같은 시간에도 여러 그룹을 나란히 봅니다', '동시에 진행하는 그룹은 겹치지 않게 나뉘어 표시되고, 블록을 다시 끌어 날짜와 시간을 바꿀 수 있습니다.', 'practice'),
        step('calendar-session-unassign', 'projectCalendar', '.pss-unassign-drop', '배치만 빼도 그룹은 남습니다', '취소할 블록을 이 영역에 놓으면 시간표에서만 빠지고, 그룹 구성은 다음 배치를 위해 그대로 유지됩니다.'),
        step('calendar-session-print', 'projectCalendar', '.pss-print-button', '보이는 구간을 인쇄합니다', '접힌 항목까지 모두 포함한 표로 바꾸어 날짜·시간·그룹·구성원과 역할을 빠짐없이 출력합니다.'),
        step('calendar-open-individual', 'projectCalendar', '[data-session-open-legacy]', '개별 일정 관리로 이동해보세요', '그룹 배치와 같은 원본 일정에서 진행 내용, 담당자, Zoom·메일 후속 작업을 더 세밀하게 다룹니다.', 'target'),
        step('calendar-view', 'projectCalendar', '.calendar-toolbar', '개별 일정은 월·주와 필터로 찾습니다', '지난 일정은 회색, 임박 일정은 강조되어 지금 확인할 일을 빠르게 찾을 수 있습니다.', 'practice'),
        step('calendar-grid', 'projectCalendar', '#projectCalendarGrid', '개별 일정도 빈 날짜를 드래그할 수 있습니다', '세션 밖의 별도 일정이나 예외 운영 일정을 시작·종료 날짜와 시간으로 추가합니다.', 'practice'),
        step('calendar-event', 'projectCalendar', '[data-calendar-event="guide-slot-future-a"]', '변경할 미래 일정을 눌러보세요', '오른쪽에 진행 내용과 담당자, 외부 회의 상태가 열립니다.', 'target'),
        step('calendar-detail', 'projectCalendar', '#calendarDetail', '한 일정의 운영 정보를 모아 봅니다', '누가 무엇을 몇 시부터 몇 시까지 진행하는지와 전체 배치를 함께 확인합니다.'),
        step('calendar-edit', 'projectCalendar', '#calendarEditEvent', '날짜·시간은 간편 편집창에서 바꿉니다', '시작 날짜·시간과 종료 날짜·시간을 각각 선택하므로 형식을 외워 입력할 필요가 없습니다.'),
        step('calendar-agenda', 'projectCalendar', '#calendarAgenda', '일정 안의 세부 진행을 확인합니다', '오리엔테이션, 휴식, 면담처럼 일정 내부의 시간표와 담당자를 기록합니다.'),
        step('calendar-adjust', 'projectCalendar', '#calendarAdjustEvent', '일정 조정을 눌러보세요', '시간 이동뿐 아니라 다른 일정과 사람을 교환하거나 섞어 재배치할 수 있습니다.', 'target'),
        step('calendar-adjust-time', 'projectCalendar', '#calendarAdjustmentDialog .calendar-adjustment-section:nth-of-type(1)', '먼저 바뀔 날짜와 시간을 정합니다', '진행 내용과 현재 배치는 새 시간으로 함께 따라갑니다.', 'practice'),
        step('calendar-adjust-related', 'projectCalendar', '#calendarRelatedPicker', '관련 일정을 함께 선택할 수 있습니다', '한 고객의 변경 때문에 다른 일정까지 바뀔 때 필요한 일정만 골라 한 번에 비교합니다.', 'practice'),
        step('calendar-adjust-people', 'projectCalendar', '#calendarAdjustmentAssignments', '사람과 역할의 목적지를 정합니다', '옮길 곳만 고르면 이동·교환·혼합 재배치를 자동으로 판단합니다.', 'practice'),
        step('calendar-adjust-impact', 'projectCalendar', '#calendarAdjustmentImpact', '적용 전 영향을 확인합니다', '충돌, 정원, 가능 시간과 다시 확인할 Zoom·메일을 한 번에 검토합니다.'),
        step('calendar-adjust-apply', 'projectCalendar', '#calendarApplyAdjustment', '변경 적용을 체험하세요', '입력한 날짜·시간과 사람 재배치를 연습 프로젝트에 실제로 반영합니다. 바꾼 값이 없으면 안전한 예시 이동을 만들어 보여줍니다.', 'simulate', { simulation: 'calendar-adjustment' }),
        step('calendar-adjust-result', 'projectCalendar', '#calendarDetail', '변경 결과와 후속 작업을 확인합니다', '바뀐 일정과 배치가 캘린더에 반영되고, 다시 확인해야 할 Zoom·안내 메일 상태까지 함께 표시됩니다.')
      ]
    },
    {
      id: 'layout', group: 'program', moduleId: 'layout', icon: '표', name: '일정표',
      description: '표 형태를 바꾸고 저장될 내용을 확인한 뒤 내보내기를 체험합니다.', minutes: 3, startPage: 'layout',
      steps: [
        step('layout-type', 'layout', '#layoutType', '필요한 표 형태를 고릅니다', '전체 목록, 진행 담당 포함, Zoom 링크 포함 형태를 목적에 맞게 선택하세요.', 'practice'),
        step('layout-preview', 'layout', '#outputPreviewTable', '저장될 내용을 먼저 확인합니다', '화면의 표가 실제 Excel·CSV에 들어갈 내용입니다.'),
        step('layout-versions', 'layout', '#scheduleVersionList', '중요한 시점은 일정 버전으로 남깁니다', '대규모 재편성 전 상태를 저장해두면 비교하거나 되돌릴 때 안전합니다.'),
        step('layout-excel', 'layout', '#exportExcelButton', 'Excel 저장을 체험하세요', '가이드에서는 파일을 만들거나 저장 창을 열지 않고 결과만 확인합니다.', 'simulate', { simulation: 'export-excel' }),
        step('layout-csv', 'layout', '#exportCsvButton', 'CSV도 같은 방식으로 저장할 수 있습니다', '다른 시스템으로 옮길 때 사용할 단순 표 형식입니다.', 'simulate', { simulation: 'export-csv' })
      ]
    },
    {
      id: 'zoom', group: 'program', moduleId: 'zoom', icon: 'Z', name: 'Zoom',
      description: '전역 계정과 일정별 계정, 생성 대상과 변경 후 재확인을 체험합니다.', minutes: 4, startPage: 'zoom',
      steps: [
        step('zoom-readiness', 'zoom', '#zoomReadiness', '먼저 계정과 일정 준비 상태를 확인합니다', 'Workspace에서 한 번 연결한 기본 계정을 모든 프로젝트가 사용하고, 필요한 일정만 다른 계정을 고를 수 있습니다.'),
        step('zoom-plan', 'zoom', '#zoomPlanTable', '일정마다 생성 상태를 봅니다', '이미 연결된 회의는 다시 만들지 않으며, 바뀐 일정은 재확인 대상으로 표시합니다.', 'practice'),
        step('zoom-prepare', 'zoom', '#prepareZoomMeetings', '생성할 회의를 확인해보세요', '실제 API 호출 전에 몇 개의 회의가 어떤 계정으로 만들어질지 준비합니다.', 'target'),
        step('zoom-create', 'zoom', '#createZoomMeetings', 'Zoom 회의 만들기를 체험하세요', '가이드에서는 Zoom 로그인이나 회의 생성을 하지 않고 일정 연결 결과만 모의로 보여줍니다.', 'simulate', { simulation: 'zoom-meetings' }),
        step('zoom-result', 'zoom', '#zoomPlanTable', '회의 결과는 일정에 연결됩니다', '이후 날짜·시간이 바뀌면 기존 회의를 정리하거나 다시 만들 대상이 자동으로 표시됩니다.')
      ]
    },
    {
      id: 'gmail', group: 'program', moduleId: 'gmailFlow', icon: 'G', name: '메일',
      description: '전역 계정, 사람별 변수, 미리보기와 Gmail 초안 저장을 체험합니다.', minutes: 5, startPage: 'gmailFlow',
      steps: [
        step('gmail-account', 'gmailFlow', '#gmailFlowAccountButton', 'Workspace 기본 Gmail 계정을 사용합니다', '프로젝트마다 다시 로그인하지 않고, 예외가 필요한 프로젝트만 다른 계정을 지정합니다.'),
        step('gmail-subject', 'gmailFlow', '#mailSubjectTemplate', '공통 제목을 작성합니다', '{프로젝트}, {이름} 같은 항목은 받는 사람마다 실제 값으로 바뀝니다.', 'practice'),
        step('gmail-body', 'gmailFlow', '#mailBodyEditor', '서식 있는 본문을 편집합니다', 'Excel 표를 붙여넣거나 굵게·색상·목록 서식을 사용해 안내문을 만들 수 있습니다.', 'practice'),
        step('gmail-tokens', 'gmailFlow', '#templateVariablePalette', '명단과 일정 변수를 삽입합니다', '항목을 클릭해 커서 위치에 넣어보세요. 사용자 정의 명단 컬럼도 자동으로 표시됩니다.', 'practice'),
        step('gmail-prepare', 'gmailFlow', '#prepareMailPackage', '받는 사람별 메일을 만들어보세요', '명단·개인 일정·Zoom 링크를 합쳐 미리보기 표를 만듭니다.', 'target'),
        step('gmail-preview', 'gmailFlow', '#mailPreviewTable', '사람별 최종 내용을 확인합니다', '특정 사람만 다른 안내가 필요하면 해당 행에서 개인 메일을 따로 수정할 수 있습니다.'),
        step('gmail-create', 'gmailFlow', '#createGmailDrafts', 'Gmail 저장을 체험하세요', '가이드에서는 Gmail에 접속하지 않고 몇 명의 초안이 준비되는지만 모의로 보여줍니다.', 'simulate', { simulation: 'gmail-drafts' })
      ]
    },
    {
      id: 'document-editor', group: 'program', moduleId: 'documentEditor', icon: '문서', name: '문서 편집',
      description: '변환·합치기·나누기·일괄 만들기 네 모드에서 문서 형식을 고르고, 미리 확인하고, 안전하게 결과를 만드는 흐름을 체험합니다.', minutes: 21, startPage: 'documentEditor',
      steps: [
        documentStep('document-editor-modes', '.document-mode-picker', '먼저 할 작업을 고릅니다', '문서 편집을 열면 변환·합치기·나누기·일괄 만들기 네 모드가 가장 먼저 보입니다. 모드를 바꿔도 각 작업의 파일 목록과 입력값은 따로 유지됩니다.'),

        documentStep('document-pptx-pdf-mode', '[data-document-mode="pptxPdf"]', '변환을 선택하세요', 'PowerPoint·Word·한글·Excel·한셀 문서를 인식하고, 원본 형식과 결과 형식을 함께 기준으로 알맞은 프로그램을 고르는 모드입니다.', 'target'),
        documentStep('document-pptx-pdf-route', '#documentConversionRoutePicker', '원본 형식 → 결과 형식을 먼저 정합니다', '변환 화면의 맨 위에서 무엇을 무엇으로 바꿀지 한눈에 확인합니다. PPTX → PDF뿐 아니라 DOCX → HWP, HWPX → DOCX, XLSX → CELL처럼 양쪽 형식을 먼저 정하면 그 경로와 필요한 프로그램이 계속 표시됩니다.', 'next', 'pptxPdf'),
        documentStep('document-pptx-pdf-source', '#documentConversionSource', '원본 형식을 고르세요', '자동 감지를 그대로 쓰거나 PPTX·HWP·XLSX처럼 원본 형식을 직접 고를 수 있습니다. 직접 고르면 파일 선택 창도 그 형식만 보여주므로 잘못 섞는 일을 줄입니다.', 'practice', 'pptxPdf'),
        documentStep('document-pptx-pdf-environment', '#pptxPdfEngineNotice', '필요한 구성만 자동으로 준비합니다', '원본과 결과 형식에 맞는 Microsoft·한컴 프로그램과 글꼴을 확인합니다. 자동 준비가 가능한 공개 글꼴은 항목별 설치 또는 ‘필요한 구성 자동 준비’로 처리하고, 라이선스가 필요하면 공식 설치 화면을 열어줍니다.', 'next', 'pptxPdf'),
        documentStep('document-pptx-pdf-files', '#choosePptxFiles', '변환할 문서를 한번에 고르세요', '자동 감지라면 지원 문서를 함께 고를 수 있고, 원본 형식을 직접 골랐다면 그 형식만 선택됩니다. 가이드에서는 실제 파일 창을 열지 않고 한국어 이름의 샘플 문서 세 개를 목록에 추가합니다.', 'simulate', 'pptxPdf', { simulation: 'document-pptx-files' }),
        documentStep('document-pptx-pdf-list', '#pptxPdfFileList', '파일별 상태를 확인합니다', '파일을 더 고르면 기존 목록에 추가되고, 변환 전에 필요 없는 파일만 목록에서 뺄 수 있습니다.', 'next', 'pptxPdf'),
        documentStep('document-pptx-pdf-rule', '#documentConversionTargets', '결과 형식을 고릅니다', '프레젠테이션은 PDF·PPT·PPTX·PPTM·ODP, 일반 문서는 PDF·DOC·DOCX·DOCM·ODT·RTF·HWP·HWPX, 스프레드시트는 PDF·XLS·XLSX·XLSM·XLSB·ODS·CSV·CELL·NXL 중 현재 원본에서 만들 수 있는 결과만 보여줍니다. 매크로 원본에서 자동화가 빠지는 결과는 선택 단계에서 경고하고, 자동 감지에서 여러 형식을 섞었다면 모든 파일에 공통으로 적용할 수 있는 결과만 남습니다.', 'practice', 'pptxPdf'),
        documentStep('document-pptx-pdf-output', '#choosePptxPdfOutput', '결과를 받을 폴더를 정하세요', '가이드 결과 폴더를 모의로 선택합니다. 같은 이름의 파일이 있으면 “(2)”를 붙여 기존 결과와 원본을 모두 보호합니다.', 'simulate', 'pptxPdf', { simulation: 'document-pptx-output' }),
        documentStep('document-pptx-pdf-run', '#runPptxPdf', '일괄 변환을 체험하세요', '가이드에서는 파일을 쓰지 않고 선택한 결과 형식으로 각 파일이 완료되는 상태만 모의로 보여줍니다.', 'simulate', 'pptxPdf', { simulation: 'document-pptx-convert' }),
        documentStep('document-pptx-pdf-result', '#pptxPdfRunStatus', '파일별 결과를 마지막으로 확인합니다', '완료·실패가 파일별로 남아 문제가 있는 파일만 다시 선택해 처리할 수 있습니다.', 'next', 'pptxPdf'),

        documentStep('document-pdf-merge-mode', '[data-document-mode="pdfMerge"]', '합치기를 선택하세요', 'PDF·PowerPoint·Word·Excel·여러 문서 중 결과 형태를 안쪽에서 고른 뒤, 목록의 위에서 아래 순서로 하나의 파일을 만듭니다.', 'target'),
        documentStep('document-pdf-merge-format', '[data-document-merge-mode="pdfMerge"]', 'PDF 합치기를 고르세요', 'PDF의 모든 페이지를 목록 순서대로 이어 하나의 PDF로 만듭니다.', 'target', 'pdfMerge'),
        documentStep('document-pdf-merge-files', '#chooseDocumentMergeFiles', '합칠 PDF를 추가하세요', '가이드에서는 서로 다른 분량의 한국어 샘플 PDF 세 개를 선택한 순서대로 추가합니다. 같은 파일도 필요하면 여러 번 넣을 수 있습니다.', 'simulate', 'pdfMerge', { simulation: 'document-merge-pdf-files' }),
        documentStep('document-pdf-merge-order', '.document-merge-source', '위에서 아래가 결과 순서입니다', '순서가 통째로 반대라면 ‘순서 뒤집기’를 한 번 누르고, 세부 위치는 손잡이·↑↓ 버튼으로 조정합니다. ×는 해당 파일만 목록에서 뺍니다.', 'practice', 'pdfMerge'),
        documentStep('document-pdf-merge-preview', '#documentMergePreview', '합칠 순서와 분량을 확인합니다', '이 영역은 실제 문서 화면이 아니라 파일 순서와 각 파일의 쪽 수, 전체 쪽 수를 확인하는 구성표입니다.', 'next', 'pdfMerge'),
        documentStep('document-pdf-merge-output', '#chooseDocumentMergeOutput', '결과 이름과 폴더를 정하세요', '결과 이름을 입력한 뒤 가이드 폴더 선택을 모의로 완료합니다. .pdf 확장자는 자동으로 붙습니다.', 'simulate', 'pdfMerge', { simulation: 'document-merge-pdf-output' }),
        documentStep('document-pdf-merge-run', '#runDocumentMerge', 'PDF 합치기를 체험하세요', '현재 목록 순서와 요약을 기준으로 모의 실행하며 실제 파일은 만들지 않습니다.', 'simulate', 'pdfMerge', { simulation: 'document-merge-pdf-run' }),
        documentStep('document-pdf-merge-result', '#previewDocumentMergeOutput', '실제 결과 파일을 열어 확인합니다', '‘결과 미리보기’는 방금 저장된 실제 PDF를 기본 뷰어로 엽니다. ‘완료 폴더 열기’는 눈에 잘 띄는 초록색 버튼으로 따로 제공됩니다.', 'next', 'pdfMerge'),

        documentStep('document-pptx-merge-mode', '[data-document-merge-mode="pptxMerge"]', 'PowerPoint 합치기로 바꿔보세요', '여러 프레젠테이션의 슬라이드를 현재 목록 순서대로 하나로 연결합니다.', 'target', 'pdfMerge'),
        documentStep('document-pptx-merge-capability', '#documentMergeFormatBadge', '원본 형식과 배치를 보호합니다', '슬라이드 크기와 글꼴·테마를 확인하고 합칠 수 없는 파일은 실행 전에 알려줍니다.', 'next', 'pptxMerge'),
        documentStep('document-pptx-merge-files', '#chooseDocumentMergeFiles', '합칠 PPTX를 추가하세요', '가이드에서는 한국어 제목의 샘플 프레젠테이션 세 개와 슬라이드 수를 선택 순서대로 표시합니다.', 'simulate', 'pptxMerge', { simulation: 'document-merge-pptx-files' }),
        documentStep('document-pptx-merge-order', '#documentMergeFileList', '슬라이드 묶음의 순서를 정합니다', '전체 순서는 ‘순서 뒤집기’, 세부 순서는 손잡이·↑↓로 조정합니다. 같은 파일을 두 번 넣어도 각각 독립적으로 이동하거나 삭제할 수 있습니다.', 'practice', 'pptxMerge'),
        documentStep('document-pptx-merge-preview', '#documentMergePreview', '전체 슬라이드 구성을 확인합니다', '여기서는 파일별 시작 위치와 슬라이드 수를 확인합니다. 실제 결과 화면은 합치기가 끝난 뒤 별도 버튼으로 엽니다.', 'next', 'pptxMerge'),
        documentStep('document-pptx-merge-output', '#chooseDocumentMergeOutput', '결과 이름과 폴더를 정하세요', '결과 이름을 입력한 뒤 가이드 폴더 선택을 모의로 완료합니다. .pptx 확장자는 자동으로 붙습니다.', 'simulate', 'pptxMerge', { simulation: 'document-merge-pptx-output' }),
        documentStep('document-pptx-merge-run', '#runDocumentMerge', 'PPTX 합치기를 체험하세요', '현재 목록 순서대로 슬라이드가 이어진 상태를 모의로 완료하며 원본은 바꾸지 않습니다.', 'simulate', 'pptxMerge', { simulation: 'document-merge-pptx-run' }),
        documentStep('document-pptx-merge-result', '#previewDocumentMergeOutput', '실제 결과 파일을 열어 확인합니다', '‘결과 미리보기’는 방금 저장된 실제 PPTX를 연결된 PowerPoint 앱으로 열고, ‘완료 폴더 열기’는 저장 위치를 바로 엽니다.', 'next', 'pptxMerge'),

        documentStep('document-word-merge-mode', '[data-document-merge-mode="wordMerge"]', 'Word 합치기로 바꿔보세요', '여러 Word 문서를 목록 순서대로 이어 하나의 DOCX로 만듭니다. 다음 문서는 새 페이지에서 시작합니다.', 'target', 'pptxMerge'),
        documentStep('document-word-merge-capability', '#documentMergeFormatBadge', 'Microsoft Word 환경을 확인합니다', 'DOCX는 Word에서 직접 연결합니다. DOC·ODT·RTF는 선택할 수 있지만 호환 입력이므로 서식과 페이지가 달라질 수 있어 완료 후 실제 결과 확인이 필요합니다. Word가 열려 있으면 작업 중인 문서를 보호하도록 먼저 닫으라고 안내합니다.', 'next', 'wordMerge'),
        documentStep('document-word-merge-files', '#chooseDocumentMergeFiles', '이어 붙일 Word 문서를 추가하세요', '가이드에서는 DOCX·DOC·ODT 샘플 세 개와 예상 쪽 수를 선택 순서대로 표시합니다. 실제 파일이나 Word는 열지 않습니다.', 'simulate', 'wordMerge', { simulation: 'document-merge-word-files' }),
        documentStep('document-word-merge-order', '#documentMergeFileList', '문서가 이어질 순서를 정합니다', '위에서 아래 순서대로 문서가 이어지고 각 다음 문서는 새 페이지에서 시작합니다. 끌기·↑↓·순서 뒤집기·개별 삭제를 그대로 사용할 수 있습니다.', 'practice', 'wordMerge'),
        documentStep('document-word-merge-preview', '#documentMergePreview', '문서 순서와 예상 분량을 확인합니다', 'Word는 합친 뒤 다시 페이지를 계산할 수 있으므로 여기서는 문서별 순서와 예상 쪽 수만 보여줍니다. 최종 페이지·머리글·바닥글은 완료 뒤 실제 결과 미리보기에서 확인합니다.', 'next', 'wordMerge'),
        documentStep('document-word-merge-output', '#chooseDocumentMergeOutput', 'DOCX 이름과 폴더를 정하세요', '결과 이름을 입력한 뒤 가이드 폴더 선택을 모의로 완료합니다. .docx 확장자는 자동으로 붙고 기존 파일은 덮어쓰지 않습니다.', 'simulate', 'wordMerge', { simulation: 'document-merge-word-output' }),
        documentStep('document-word-merge-run', '#runDocumentMerge', 'Word 합치기를 체험하세요', '현재 파일 순서대로 다음 페이지에서 이어지는 DOCX 완료 상태를 모의로 표시하며 실제 파일은 만들지 않습니다.', 'simulate', 'wordMerge', { simulation: 'document-merge-word-run' }),
        documentStep('document-word-merge-result', '#previewDocumentMergeOutput', '실제 Word 결과를 확인합니다', '‘결과 미리보기’로 저장된 DOCX를 연결된 Word 앱에서 열어 페이지 나눔·머리글·바닥글을 확인하고, ‘완료 폴더 열기’로 저장 위치를 엽니다.', 'next', 'wordMerge'),

        documentStep('document-excel-merge-mode', '[data-document-merge-mode="excelMerge"]', 'Excel 합치기로 바꿔보세요', '여러 Excel 파일을 파일 순서와 각 파일 안의 시트 순서대로 하나의 XLSX에 복사합니다. 이 PC에 없는 글꼴이 있어도 원본의 글꼴 지정값을 유지해 합치며, 화면·인쇄 모양은 완료 파일에서 확인합니다.', 'target', 'wordMerge'),
        documentStep('document-excel-merge-capability', '#documentMergeFormatBadge', 'Microsoft Excel 환경을 확인합니다', 'XLSX의 시트는 Excel에서 직접 복사합니다. XLS·ODS·CSV는 선택할 수 있지만 호환 입력이므로 수식·차트·서식이 달라질 수 있어 완료 후 확인해야 합니다. Excel이 열려 있으면 먼저 닫으라고 안내합니다.', 'next', 'excelMerge'),
        documentStep('document-excel-merge-files', '#chooseDocumentMergeFiles', '합칠 Excel 파일을 추가하세요', '가이드에서는 XLSX·XLS·ODS 샘플과 각 파일 안의 시트 이름을 불러옵니다. 실제 파일이나 Excel은 열지 않습니다.', 'simulate', 'excelMerge', { simulation: 'document-merge-excel-files' }),
        documentStep('document-excel-merge-order', '#documentMergeFileList', '파일 순서가 먼저입니다', '결과는 위에서 아래의 파일 순서, 그 안에서는 원래 시트 순서로 만들어집니다. 순서 뒤집기는 파일만 뒤집고 각 파일 안의 시트 순서는 바꾸지 않습니다.', 'practice', 'excelMerge'),
        documentStep('document-excel-merge-names', '#documentMergeExcelOptions', '시트 이름과 전체 통합 시트를 선택합니다', '시트가 하나뿐인 파일은 파일명을 시트 이름으로 쓸 수 있습니다. 전체 통합 시트를 추가하면 바로 아래에서 그 시트 이름도 정할 수 있고, 같은 이름은 자동으로 구분됩니다.', 'next', 'excelMerge'),
        documentStep('document-excel-merge-preview', '#documentMergePreview', '최종 시트 순서를 확인합니다', '명단 → 일정처럼 파일별 시트 흐름을 표시합니다. 같은 이름은 명단, 명단 (2)처럼 자동 구분한 실제 결과 이름까지 실행 전에 보여줍니다.', 'next', 'excelMerge'),
        documentStep('document-excel-merge-output', '#chooseDocumentMergeOutput', 'XLSX 이름과 폴더를 정하세요', '결과 이름을 입력한 뒤 가이드 폴더 선택을 모의로 완료합니다. .xlsx 확장자는 자동으로 붙고 기존 파일은 덮어쓰지 않습니다.', 'simulate', 'excelMerge', { simulation: 'document-merge-excel-output' }),
        documentStep('document-excel-merge-run', '#runDocumentMerge', 'Excel 합치기를 체험하세요', '파일 순서와 각 파일 안의 시트 순서대로 복사된 XLSX 완료 상태를 모의로 표시하며 실제 파일은 만들지 않습니다.', 'simulate', 'excelMerge', { simulation: 'document-merge-excel-run' }),
        documentStep('document-excel-merge-result', '#previewDocumentMergeOutput', '실제 Excel 결과를 확인합니다', '‘결과 미리보기’로 저장된 XLSX를 연결된 Excel 앱에서 열어 시트 순서·수식·차트를 확인하고, ‘완료 폴더 열기’로 저장 위치를 엽니다.', 'next', 'excelMerge'),

        documentStep('document-mixed-merge-mode', '[data-document-merge-mode="documentPdfMerge"]', '서로 다른 문서를 PDF 하나로 모아보세요', 'PowerPoint·Word·한글·Excel·한셀·PDF가 섞여 있어도 목록 순서대로 인쇄·공유용 PDF 하나를 만듭니다.', 'target', 'excelMerge'),
        documentStep('document-mixed-merge-environment', '#documentMergeFormatBadge', '각 문서는 원본 프로그램으로 처리합니다', '대체 글꼴이나 임의 변환기를 몰래 사용하지 않습니다. 필요한 공개 구성과 정확한 공개 글꼴은 자동 준비하고, 라이선스가 필요한 프로그램은 공식 설치 화면으로 이어집니다.', 'next', 'documentPdfMerge'),
        documentStep('document-mixed-merge-files', '#chooseDocumentMergeFiles', '형식이 다른 문서를 함께 추가하세요', '가이드에서는 PPTX·HWPX·XLSX 샘플을 목록에 추가합니다. 실제 파일과 프로그램은 열지 않습니다.', 'simulate', 'documentPdfMerge', { simulation: 'document-merge-documents-files' }),
        documentStep('document-mixed-merge-order', '#documentMergeFileList', '문서 종류와 관계없이 순서를 정합니다', '위에서 아래 순서가 최종 PDF의 페이지 순서입니다. 끌기·↑↓·순서 뒤집기·개별 삭제를 그대로 사용할 수 있습니다.', 'practice', 'documentPdfMerge'),
        documentStep('document-mixed-merge-output', '#chooseDocumentMergeOutput', 'PDF 이름과 저장 폴더를 정하세요', '모든 원본은 그대로 두고 .pdf 결과 하나만 새로 만듭니다. 같은 이름이 있으면 덮어쓰지 않습니다.', 'simulate', 'documentPdfMerge', { simulation: 'document-merge-documents-output' }),
        documentStep('document-mixed-merge-run', '#runDocumentMerge', '여러 문서 합치기를 체험하세요', '각 원본을 PDF로 안전하게 만든 다음 검증된 페이지를 목록 순서대로 잇는 과정을 모의로 완료합니다.', 'simulate', 'documentPdfMerge', { simulation: 'document-merge-documents-run' }),
        documentStep('document-mixed-merge-result', '#previewDocumentMergeOutput', '최종 PDF를 열어 확인합니다', '‘결과 미리보기’로 페이지 순서와 글꼴·배치를 확인하고, ‘완료 폴더 열기’로 저장 위치를 바로 엽니다.', 'next', 'documentPdfMerge'),

        documentStep('document-split-mode', '[data-document-mode="documentSplit"]', '나누기를 선택하세요', 'PDF 또는 PowerPoint 파일 하나를 일정한 분량으로 자르거나 원하는 쪽·슬라이드끼리 그룹으로 묶어 여러 파일로 만듭니다.', 'target'),
        documentStep('document-split-pdf-kind', '[data-document-split-kind="pdf"]', '먼저 PDF 나누기를 고르세요', 'PDF는 별도 문서 프로그램 없이 페이지별 새 PDF를 만듭니다. 페이지 화면은 유지되지만 문서 전체 목차·전자서명·양식·첨부는 이어지지 않을 수 있습니다.', 'target', 'documentSplit'),
        documentStep('document-split-file', '#chooseDocumentSplitFile', '나눌 PDF 하나를 선택하세요', '가이드에서는 10쪽짜리 한국어 샘플 PDF를 불러옵니다. 실제 파일 창을 열거나 원본을 바꾸지 않습니다.', 'simulate', 'documentSplit', { simulation: 'document-split-file' }),
        documentStep('document-split-equal', '#documentSplitEqualSize', '파일 하나당 쪽 수를 입력하세요', '2를 입력하면 1–2, 3–4, 5–6, 7–8, 9–10처럼 순서대로 다섯 파일이 됩니다. 마지막에 남는 쪽은 마지막 파일에만 넣습니다.', 'practice', 'documentSplit'),
        documentStep('document-split-plan', '#documentSplitPlanPreview', '실행 전에 결과 구성을 확인합니다', '만들 파일의 기본 이름과 각 파일에 들어갈 쪽을 바로 계산해 보여줍니다. 원본 이름과 쪽 범위를 조합한 기본 이름이 자동으로 붙습니다.', 'next', 'documentSplit'),
        documentStep('document-split-custom-method', '[for="documentSplitMethodCustom"]', '이번에는 쪽 그룹을 직접 정해보세요', '그룹마다 1, 3, 5-6처럼 쉼표와 범위를 함께 쓸 수 있고, 결과 파일 이름을 비우면 안전한 기본 이름을 사용합니다.', 'target', 'documentSplit'),
        documentStep('document-split-groups', '#documentSplitGroups', '그룹·이름·누락 여부를 함께 확인합니다', '샘플은 1·3·5–6, 4·7–9, 2로 세 그룹을 만들고 10쪽은 일부러 선택하지 않았습니다. 같은 쪽을 여러 그룹에 넣거나 범위를 벗어나면 실행 전에 막고, ‘그룹 추가’로 더 만들 수 있습니다.', 'practice', 'documentSplit'),
        documentStep('document-split-omission', '#documentSplitValidationSummary', '선택하지 않은 쪽은 한 번 더 알려줍니다', '나누기 버튼을 누르면 빠진 쪽이 어느 결과에도 포함되지 않는다는 확인창이 열립니다. 취소하면 파일을 만들지 않고, 계속을 눌러야 누락을 허용합니다.', 'next', 'documentSplit'),
        documentStep('document-split-output', '#chooseDocumentSplitOutput', '결과를 받을 폴더를 정하세요', '가이드 결과 폴더를 모의로 선택합니다. 같은 이름의 기존 파일은 덮어쓰지 않습니다.', 'simulate', 'documentSplit', { simulation: 'document-split-output' }),
        documentStep('document-split-run', '#runDocumentSplit', '파일 나누기를 체험하세요', '현재 구성으로 여러 결과 파일을 만든 완료 상태만 모의로 보여주며 실제 PDF는 쓰지 않습니다.', 'simulate', 'documentSplit', { simulation: 'document-split-run' }),
        documentStep('document-split-results', '#documentSplitResults', '각 결과를 따로 미리 볼 수 있습니다', '완료된 파일마다 이름과 포함 쪽을 확인하고 ‘결과 미리보기’로 해당 파일만 엽니다.', 'next', 'documentSplit'),
        documentStep('document-split-folder', '#openDocumentSplitOutput', '완료 폴더를 바로 엽니다', '눈에 잘 띄는 초록색 버튼으로 나눈 파일이 저장된 폴더를 한 번에 열 수 있습니다.', 'next', 'documentSplit'),
        documentStep('document-split-pptx-kind', '[data-document-split-kind="pptx"]', 'PowerPoint도 같은 방식으로 나눕니다', 'PDF에서 입력한 내용은 그대로 두고 PPTX 전용 상태로 전환합니다. 이 안에서는 쪽 대신 슬라이드 번호를 사용합니다.', 'target', 'documentSplit'),
        documentStep('document-split-pptx-capability', '#documentSplitFormatBadge', 'PPTX는 PowerPoint를 우선 사용합니다', 'Microsoft PowerPoint를 사용할 수 있으면 원본 테마·글꼴·미디어를 유지하는 방식으로 먼저 나눕니다. 설치되어 있지 않거나 열려 있으면 작업 중인 문서를 건드리지 않고 내장 분할을 사용하며, 글꼴·배치·애니메이션이 달라질 가능성과 누락 슬라이드, 숨은 제목 목록·검토 댓글 정리를 한 확인창에서 안내합니다. 취소하면 파일을 만들지 않고, 계속하면 결과 확인 필요 상태로 저장합니다.', 'next', 'documentSplit'),

        documentStep('document-excel-dedupe-mode', '[data-document-mode="excelDeduplicate"]', '정리를 선택하세요', 'Excel 파일 하나를 분석하고, 행 전체의 셀 내용과 수식이 완전히 같은 중복 행을 시트별로 정리합니다.', 'target'),
        documentStep('document-excel-dedupe-file', '#chooseExcelDeduplicateFile', 'Excel 파일을 분석해보세요', '가이드에서는 세 시트의 행 수와 중복 위치를 모의로 분석합니다. 빈 행은 문서 배치일 수 있어 중복에서 제외합니다.', 'simulate', 'excelDeduplicate', { simulation: 'document-excel-dedupe-file' }),
        documentStep('document-excel-dedupe-columns', '#excelDeduplicateCriteriaMode', '행 전체 또는 기준 열을 고릅니다', 'A와 C처럼 여러 열을 고르면 그 값 조합이 모두 같은 행만 중복으로 판단합니다. 위 시트 목록은 기준 열 설정 화면을 바꾸는 용도이며, 같은 열 위치를 여러 시트에 한 번에 적용할 수도 있습니다.', 'simulate', 'excelDeduplicate', { simulation: 'document-excel-dedupe-columns' }),
        documentStep('document-excel-dedupe-sheets', '#excelDeduplicateSheetList', '정리할 시트를 여러 개 고릅니다', '현재 비교 기준에서 중복이 있는 시트는 체크박스로 여러 개 동시에 선택할 수 있습니다. 중복이 없는 시트는 그대로 유지됩니다.', 'practice', 'excelDeduplicate'),
        documentStep('document-excel-dedupe-output', '#chooseExcelDeduplicateOutput', '새 파일을 저장할 폴더를 정하세요', '원본을 바꾸지 않고 _중복제거가 붙은 새 XLSX를 만드는 상태를 모의로 준비합니다.', 'simulate', 'excelDeduplicate', { simulation: 'document-excel-dedupe-output' }),
        documentStep('document-excel-dedupe-run', '#runExcelDeduplicate', '선택 시트를 정리해보세요', '각 중복 묶음의 첫 행은 남기고 나머지만 제거한 뒤 저장 파일을 다시 검사하는 과정을 모의로 완료합니다.', 'simulate', 'excelDeduplicate', { simulation: 'document-excel-dedupe-run' }),
        documentStep('document-excel-dedupe-result', '#excelDeduplicateResult', '시트별 결과를 확인합니다', '시트마다 제거된 행 수와 정리 전후 행 수를 확인한 뒤 실제 결과 파일을 열 수 있습니다.', 'next', 'excelDeduplicate'),

        documentStep('document-excel-compare-task', '[data-excel-cleanup-task="compare"]', '명단 비교·분류로 바꿉니다', '서로 다른 두 Excel 파일에서 같은 사람을 찾고 그룹별 시트로 나누는 작업입니다.', 'target', 'excelDeduplicate'),
        documentStep('document-excel-compare-a', '#chooseExcelCompareA', '첫 번째 명단을 선택하세요', '가이드용 신청 명단을 불러오고 제목 아래의 실제 열 이름 행과 이메일 열을 자동으로 선택합니다.', 'simulate', 'excelDeduplicate', { simulation: 'document-excel-compare-a' }),
        documentStep('document-excel-compare-b', '#chooseExcelCompareB', '대조할 명단을 선택하세요', '열 순서와 이름이 다른 가이드용 참석 결과를 불러오고 같은 사람을 찾을 메일 주소 열을 선택합니다.', 'simulate', 'excelDeduplicate', { simulation: 'document-excel-compare-b' }),
        documentStep('document-excel-compare-rules', '#excelCompareRuleList', '문자와 그룹 이름을 연결합니다', '비교 이메일에 .onsemi가 있으면 온세미 시트로, B 파일의 회사 열에 삼성이 있으면 삼성전자 시트로 보내는 규칙을 모의로 입력합니다.', 'simulate', 'excelDeduplicate', { simulation: 'document-excel-compare-rules' }),
        documentStep('document-excel-compare-analysis', '#analyzeExcelCompare', '저장 전에 인원수를 확인합니다', '동일 인물, 그룹 분류, 기타, 중복 키와 양쪽 미매칭 인원수를 모의로 계산합니다.', 'simulate', 'excelDeduplicate', { simulation: 'document-excel-compare-analysis' }),
        documentStep('document-excel-compare-output', '#chooseExcelCompareOutput', '새 결과 파일의 폴더를 고릅니다', '두 원본은 그대로 두고 그룹별 시트가 포함될 가이드 결과 폴더를 준비합니다.', 'simulate', 'excelDeduplicate', { simulation: 'document-excel-compare-output' }),
        documentStep('document-excel-compare-run', '#runExcelCompare', '그룹 시트를 만들어보세요', '온세미·삼성전자·기타·중복 확인·미매칭 시트를 만든 뒤 다시 검사한 완료 상태를 모의로 보여줍니다.', 'simulate', 'excelDeduplicate', { simulation: 'document-excel-compare-run' }),
        documentStep('document-excel-compare-result', '#excelCompareResult', '결과 시트를 한눈에 확인합니다', '각 시트의 행 수를 확인하고 실제 작업에서는 결과 파일이나 완료 폴더를 바로 열 수 있습니다.', 'next', 'excelDeduplicate'),

        documentStep('document-template-mode', '[data-document-mode="certificateMaker"]', '일괄 만들기를 선택하세요', '수료증·확인서·이름표처럼 같은 양식의 일부 글자만 바꿔 여러 문서를 만드는 모드입니다.', 'target'),
        documentStep('document-template-flow', '.certificate-flow-strip', '네 단계만 순서대로 진행합니다', '양식 선택, 바꿀 글자 선택, 표 입력·미리보기, 일괄 생성 순서로 필요한 곳만 보여줍니다.', 'next', 'certificateMaker'),
        documentStep('document-template-file', '#chooseCertificateTemplate', 'PPTX 양식을 선택하세요', '가이드용 수료증 양식을 불러옵니다. 실제 파일 창이나 문서 변환은 실행하지 않습니다.', 'simulate', 'certificateMaker', { simulation: 'document-certificate-template' }),
        documentStep('document-template-name', '[data-certificate-block="guide-certificate-name"]', '첫 번째로 이름 영역을 누르세요', '누른 순서가 아래 표의 열 순서가 됩니다. 먼저 이름을 1번 열로 선택합니다.', 'target', 'certificateMaker'),
        documentStep('document-template-session', '[data-certificate-block="guide-certificate-session"]', '두 번째로 과정명 영역을 누르세요', '양식의 모든 글자를 바꾸지 않고, 문서마다 달라질 글자만 고릅니다.', 'target', 'certificateMaker'),
        documentStep('document-template-date', '[data-certificate-block="guide-certificate-date"]', '마지막으로 날짜 영역을 누르세요', '선택 번호가 미리보기 위에 표시되어 열 순서를 바로 확인할 수 있습니다.', 'target', 'certificateMaker'),
        documentStep('document-template-fields', '#certificateFieldList', '선택한 항목의 순서와 이름을 확인합니다', '열 이름은 알아보기 쉽게 바꿀 수 있고, 잘못 고른 항목만 빼거나 다시 순서대로 고를 수 있습니다.', 'practice', 'certificateMaker'),
        documentStep('document-template-roster', '#importCertificateRoster', '프로젝트 명단과 이어서 사용할 수 있습니다', '현재 프로젝트, 다른 프로젝트, Workspace 저장 명단을 출처별 카드로 구분해 보고 필요한 열만 문서 항목에 연결합니다. 원본 명단은 수정되지 않습니다.', 'next', 'certificateMaker'),
        documentStep('document-template-data', '#importCertificateData', '여러 명의 정보를 한번에 가져오세요', '가이드에서는 이름·과정명·날짜가 든 샘플 표 세 행을 모의로 불러옵니다.', 'simulate', 'certificateMaker', { simulation: 'document-certificate-data' }),
        documentStep('document-template-grid', '#certificateDataTable', '한 행이 문서 하나가 됩니다', '셀을 직접 수정하거나 Excel처럼 드래그, 복사·붙여넣기, 우클릭 채우기를 사용해보세요.', 'practice', 'certificateMaker'),
        documentStep('document-template-preview', '#previewCertificateRow', '현재 행의 실제 결과를 미리 확인하세요', '가이드에서는 샘플 값을 양식에 합성한 미리보기만 만듭니다. 파일은 쓰지 않습니다.', 'simulate', 'certificateMaker', { simulation: 'document-certificate-preview' }),
        documentStep('document-template-preview-result', '#certificatePreviewStage', '글자 크기와 줄바꿈을 확인합니다', '일괄 생성 전에 임의의 행을 앞뒤로 이동하며 이름이 긴 경우까지 확인할 수 있습니다.', 'next', 'certificateMaker'),
        documentStep('document-template-filename', '#certificateFilenameTemplate', '행 정보로 파일 이름을 만드세요', '일반 글자와 {A}·{B} 또는 {이름}·{과정명}을 함께 쓸 수 있습니다. 열 칩을 누르면 현재 커서 위치에 들어가고 현재 행의 실제 파일명이 즉시 표시됩니다.', 'practice', 'certificateMaker'),
        documentStep('document-template-output', '#chooseCertificateOutput', '결과 폴더와 형식을 정하세요', 'PDF와 수정 가능한 PPTX 중 필요한 형식을 고르고 가이드 결과 폴더를 모의로 선택합니다.', 'simulate', 'certificateMaker', { simulation: 'document-certificate-output' }),
        documentStep('document-template-generate', '#generateCertificates', '행별 문서 생성을 체험하세요', '실제 양식을 수정하거나 결과 파일을 쓰지 않고 세 개 문서의 완료 상태만 모의로 보여줍니다.', 'simulate', 'certificateMaker', { simulation: 'document-certificate-generate' }),
        documentStep('document-template-result', '#certificateRunStatus', '완료 개수와 예외를 확인합니다', '각 행은 별도 파일로 만들어지며 같은 이름이 있어도 기존 파일은 덮어쓰지 않습니다.', 'next', 'certificateMaker')
      ]
    },
    {
      id: 'workspace-management', group: 'management', icon: 'W', name: '계정·저장·프로그램 관리',
      description: '전역 계정 카드, 저장 자료, 추가 프로그램과 Drive 설정을 익힙니다.', minutes: 6, startPage: 'connections',
      steps: [
        step('management-connections', 'connections', '#connectionList', '계정은 Workspace에서 한 번 연결합니다', 'Forms·Drive·Gmail·Zoom 카드를 크게 나눠 보여주며 모든 프로젝트가 기본 계정을 이어받습니다.'),
        step('management-service', 'connections', '[data-service-card="zoom"]', '서비스별 연결 상태를 확인합니다', '연결 필요 카드를 누르면 공식 로그인으로 이동하지만 가이드에서는 실제 창을 열지 않습니다.', 'practice'),
        step('management-connect', 'connections', '[data-service-card="zoom"] [data-service-connect]', '계정 연결 동작을 체험하세요', '가이드용 연결 완료 상태만 표시하며 토큰이나 키를 저장하지 않습니다.', 'simulate', { simulation: 'connect-service' }),
        step('management-library-nav', 'connections', '[data-nav="library"]', '저장 자료로 이동해보세요', '여러 프로젝트에서 다시 쓸 명단·메일 양식·업무 템플릿을 모아둡니다.', 'target'),
        step('management-library', 'library', '#libraryWorkflowTemplateList', '반복되는 구조는 템플릿으로 저장합니다', '새 프로젝트를 만들 때 같은 업무 흐름과 기본 규칙으로 시작할 수 있습니다.'),
        step('management-modules-nav', 'library', '[data-nav="modules"]', '추가 프로그램으로 이동해보세요', '필요한 프로그램을 Workspace에 설치하거나 빠른 실행으로 열 수 있습니다.', 'target'),
        step('management-modules', 'modules', '#moduleCatalog', '프로그램은 필요한 것만 보이게 합니다', '기본 프로그램과 외부 확장을 한곳에서 관리하되 프로젝트 사용 화면은 단순하게 유지합니다.'),
        step('management-settings-nav', 'modules', '[data-nav="settings"]', '환경 설정으로 이동해보세요', '저장 위치와 표시 설정, 가이드를 이곳에서 관리합니다.', 'target'),
        step('management-storage', 'settings', '#storageMode', '이 PC 저장과 Drive 동기화를 고릅니다', 'Drive를 선택해도 로그인 토큰은 이 PC의 보안 저장소에만 남습니다.', 'practice'),
        step('management-drive-account', 'settings', '#workspaceDriveConnection', 'Workspace 전체를 저장할 계정을 정합니다', '연결된 Drive가 여러 개일 때만 이 선택이 필요합니다.', 'practice'),
        step('management-drive-push', 'settings', '#pushDriveState', 'Drive 저장을 체험하세요', '가이드에서는 업로드하거나 실제 자료를 덮어쓰지 않고 동기화 결과만 모의로 보여줍니다.', 'simulate', { simulation: 'drive-push' }),
        step('management-guide', 'settings', '.guide-settings-panel', '가이드는 언제든 다시 시작할 수 있습니다', 'Esc로 즉시 끝낼 수 있고, 종료하면 최신 실제 자료로 안전하게 돌아갑니다.')
      ]
    }
  ];

  const guideById = (id) => GUIDES.find((guide) => guide.id === id) || null;

  function dateKeyInSeoul(value = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function addDateDays(dateKey, days) {
    const date = new Date(`${dateKey}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    return date.toISOString().slice(0, 10);
  }

  function createDemoState(Core, now = new Date()) {
    if (!Core?.createEmptyState || !Core?.createProject || !Core?.normalizeState) throw new Error('WorkspaceCore가 필요합니다.');
    const today = dateKeyInSeoul(now);
    let demo = Core.createEmptyState();
    const allModules = Core.MODULE_CATALOG.map((module) => module.id);
    const created = Core.createProject(demo, {
      id: 'guide-demo-project',
      name: '가이드 체험 프로젝트',
      client: '샘플 프로그램 운영',
      description: '실제 자료에 저장되지 않는 가이드 전용 프로젝트',
      startDate: addDateDays(today, -7),
      endDate: addDateDays(today, 14),
      preset: 'full',
      installedModules: allModules,
      settings: {
        timezone: 'Asia/Seoul', sessionDurationMinutes: 60,
        participantMin: 1, participantMax: 4, coachRequired: false,
        changeApprovalRequired: true,
        defaultConnectionIds: { forms: 'guide-forms', drive: 'guide-drive', gmail: 'guide-gmail', zoom: 'guide-zoom' }
      }
    });
    demo = created.state;
    const project = demo.projects.find((item) => item.id === 'guide-demo-project');
    const columns = [
      { id: 'guide-column-name', name: '이름', type: 'name' },
      { id: 'guide-column-email', name: '이메일', type: 'email' },
      { id: 'guide-column-group', name: '구분', type: 'group' },
      { id: 'guide-column-note', name: '요청사항', type: 'text' }
    ];
    const peopleSeed = [
      ['guide-person-1', '김가람', 'garam@example.com', 'A팀', '오전 선호', ['guide-role-facilitator']],
      ['guide-person-2', '이누리', 'nuri@example.com', 'A팀', '', ['guide-role-participant']],
      ['guide-person-3', '박다온', 'daon@example.com', 'B팀', '첫날 오후 불가', ['guide-role-participant']],
      ['guide-person-4', '최라온', 'raon@example.com', 'B팀', '', ['guide-role-participant']],
      ['guide-person-5', '정마루', 'maru@example.com', '운영', '', ['guide-role-support']]
    ];
    const people = peopleSeed.map(([id, name, email, group, note, roleIds], index) => ({
      id, sourceOrder: index,
      values: { 'guide-column-name': name, 'guide-column-email': email, 'guide-column-group': group, 'guide-column-note': note },
      name, email, phone: '', group, roleIds, active: true
    }));
    const roles = [
      { id: 'guide-role-facilitator', name: '진행 담당', candidateFilter: 'manual', minPerSession: 1, maxPerSession: 1, targetSessions: 2, active: true, color: '#2879b8' },
      { id: 'guide-role-participant', name: '참여 인원', candidateFilter: 'manual', minPerSession: 1, maxPerSession: 3, targetSessions: 1, active: true, color: '#2f8f5b' },
      { id: 'guide-role-support', name: '운영 지원', candidateFilter: 'manual', minPerSession: 0, maxPerSession: 1, targetSessions: 1, active: true, color: '#8a5fb5' }
    ];
    const calendarSessionId = 'guide-calendar-session';
    const slots = [
      { id: 'guide-slot-past', calendarSessionId, scheduleGroupId: 'guide-calendar-group-past', date: addDateDays(today, -2), startTime: '10:00', endTime: '11:30', label: '사전 오리엔테이션', status: 'confirmed', locked: true },
      { id: 'guide-slot-future-a', calendarSessionId, scheduleGroupId: 'guide-calendar-group-a', date: addDateDays(today, 1), startTime: '10:00', endTime: '11:30', label: 'A그룹 1차 미팅', status: 'confirmed', locked: false, zoomConnectionId: 'guide-zoom' },
      { id: 'guide-slot-future-b', calendarSessionId, scheduleGroupId: 'guide-calendar-group-b', date: addDateDays(today, 1), startTime: '14:00', endTime: '15:30', label: 'B그룹 1차 미팅', status: 'confirmed', locked: false, zoomConnectionId: 'guide-zoom' },
      { id: 'guide-slot-future-c', calendarSessionId, scheduleGroupId: 'guide-calendar-group-c', date: addDateDays(today, 3), startTime: '11:00', endTime: '12:30', label: 'C그룹 후속 미팅', status: 'draft', locked: false, zoomConnectionId: 'guide-zoom' }
    ];
    const assignments = [
      { id: 'guide-assignment-past-1', slotId: 'guide-slot-past', calendarSessionId, scheduleGroupId: 'guide-calendar-group-past', personId: 'guide-person-1', roleId: 'guide-role-facilitator', locked: true },
      { id: 'guide-assignment-past-2', slotId: 'guide-slot-past', calendarSessionId, scheduleGroupId: 'guide-calendar-group-past', personId: 'guide-person-2', roleId: 'guide-role-participant', locked: true },
      { id: 'guide-assignment-a-1', slotId: 'guide-slot-future-a', calendarSessionId, scheduleGroupId: 'guide-calendar-group-a', personId: 'guide-person-1', roleId: 'guide-role-facilitator', locked: false },
      { id: 'guide-assignment-a-2', slotId: 'guide-slot-future-a', calendarSessionId, scheduleGroupId: 'guide-calendar-group-a', personId: 'guide-person-2', roleId: 'guide-role-participant', locked: false },
      { id: 'guide-assignment-a-3', slotId: 'guide-slot-future-a', calendarSessionId, scheduleGroupId: 'guide-calendar-group-a', personId: 'guide-person-5', roleId: 'guide-role-support', locked: false },
      { id: 'guide-assignment-b-1', slotId: 'guide-slot-future-b', calendarSessionId, scheduleGroupId: 'guide-calendar-group-b', personId: 'guide-person-1', roleId: 'guide-role-facilitator', locked: false },
      { id: 'guide-assignment-b-2', slotId: 'guide-slot-future-b', calendarSessionId, scheduleGroupId: 'guide-calendar-group-b', personId: 'guide-person-3', roleId: 'guide-role-participant', locked: false },
      { id: 'guide-assignment-c-1', slotId: 'guide-slot-future-c', calendarSessionId, scheduleGroupId: 'guide-calendar-group-c', personId: 'guide-person-4', roleId: 'guide-role-participant', locked: false }
    ];
    const availability = Object.fromEntries(people.map((person, index) => [
      person.id,
      slots.filter((slot) => slot.id !== 'guide-slot-past' && !(person.id === 'guide-person-3' && slot.id === 'guide-slot-future-a') && !(index === 3 && slot.id === 'guide-slot-future-b')).map((slot) => slot.id)
    ]));
    const workColumns = [
      { id: 'guide-work-column-group', name: '그룹' },
      { id: 'guide-work-column-name', name: '이름' },
      { id: 'guide-work-column-note', name: '메모' }
    ];
    const workRows = people.slice(0, 4).map((person, index) => ({
      id: `guide-work-row-${index + 1}`, personId: person.id,
      values: {
        'guide-work-column-group': index < 2 ? '그룹 1' : '그룹 2',
        'guide-work-column-name': person.name,
        'guide-work-column-note': ''
      }
    }));
    const definition = {
      id: 'guide-form-definition', type: 'availability', title: '가이드 체험 프로젝트 가능 시간 조사',
      description: '성함과 이메일을 확인하고 실제로 참여 가능한 시간을 모두 선택해주세요.', collectEmail: 'RESPONDER_INPUT',
      questions: [
        { key: 'name', title: '성함', kind: 'text', required: true },
        { key: 'slots', title: '참여 가능한 시간', kind: 'checkbox', required: true, options: slots.map((slot) => ({ value: `[${slot.id}] ${slot.date} ${slot.startTime}-${slot.endTime} · ${slot.label}`, slotId: slot.id })) },
        { key: 'notes', title: '상세 요청사항', kind: 'paragraph', required: false }
      ], createdAt: new Date(now).toISOString()
    };
    project.data = {
      ...project.data,
      rosterName: '가이드 샘플 명단', columns, people,
      rosterViews: [{ id: 'guide-roster-view-a', name: 'A팀 진행 명단', parentId: null, personIds: ['guide-person-1', 'guide-person-2'], excludedPersonIds: [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }],
      activeRosterViewId: null,
      workItems: [{ id: 'guide-work-group', name: '가이드 그룹 편성', type: 'grouping', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), sourceRosterUpdatedAt: new Date(now).toISOString(), settings: { method: 'sequential', groupSize: 2 }, columns: workColumns, rows: workRows }],
      activeWorkItemId: 'guide-work-group', roles, slots, availability, assignments,
      activities: [
        { id: 'guide-activity-orientation', eventId: 'guide-slot-future-a', title: '오리엔테이션', description: '진행 순서와 준비물을 확인합니다.', startOffsetMinutes: 0, durationMinutes: 20, status: 'planned', order: 0, locked: false },
        { id: 'guide-activity-session', eventId: 'guide-slot-future-a', title: '핵심 진행', description: '샘플 활동을 진행합니다.', startOffsetMinutes: 20, durationMinutes: 60, status: 'planned', order: 1, locked: false }
      ],
      activityAssignments: [
        { id: 'guide-activity-assignment-1', activityId: 'guide-activity-orientation', personId: 'guide-person-5', roleId: 'guide-role-support' },
        { id: 'guide-activity-assignment-2', activityId: 'guide-activity-session', personId: 'guide-person-1', roleId: 'guide-role-facilitator' }
      ],
      conflicts: [], scheduleSheetInitialized: true,
      scheduleSheetColumns: [
        { id: 'guide-schedule-date', key: 'date', name: '날짜', kind: 'system', roleId: null },
        { id: 'guide-schedule-start', key: 'startTime', name: '시작', kind: 'system', roleId: null },
        { id: 'guide-schedule-end', key: 'endTime', name: '종료', kind: 'system', roleId: null },
        { id: 'guide-schedule-label', key: 'label', name: '일정명', kind: 'system', roleId: null },
        { id: 'guide-schedule-facilitator', key: 'role:guide-role-facilitator', name: '진행 담당', kind: 'role', roleId: 'guide-role-facilitator' },
        { id: 'guide-schedule-participant', key: 'role:guide-role-participant', name: '참여 인원', kind: 'role', roleId: 'guide-role-participant' },
        { id: 'guide-schedule-status', key: 'status', name: '상태', kind: 'system', roleId: null }
      ],
      scheduleCustomValues: {},
      scheduleRules: { avoidRepeatPairing: true, avoidPastPairing: true, groupPreference: 'different', unmarkedMeansAvailable: false, rosterViewId: null },
      versions: [{ id: 'guide-version-1', name: '최초 확정안', createdAt: new Date(now).toISOString(), slots, assignments, availability }],
      forms: {
        definitions: [definition],
        linkedForms: [],
        selectedFormId: null, lastResponseSyncAt: null
      },
      communication: {
        subjectTemplate: '[{프로젝트}] {이름}님 일정 안내',
        bodyTemplate: '{이름}님, 아래 일정으로 안내드립니다.\n\n{개인일정}\n\n문의사항은 회신해주세요.',
        bodyHtmlTemplate: '<p><strong>{이름}</strong>님, 아래 일정으로 안내드립니다.</p><p>{개인일정}</p><p>문의사항은 회신해주세요.</p>',
        mailEdits: {}, lastPreparedAt: null
      },
      layout: { type: 'calendarCoach', name: '가이드 일정표', fields: ['date', 'time', 'role', 'person', 'status'] },
      externalArtifacts: [{
        kind: 'zoom', externalId: 'guide-zoom-meeting-past', slotId: 'guide-slot-past', connectionId: 'guide-zoom',
        status: 'created', joinUrl: '', createdAt: new Date(now).toISOString()
      }],
      extensionData: {
        projectCalendar: {
          view: 'month', deletedSessionIds: [], deletedGroupIds: [],
          sessions: [{
            id: calendarSessionId, title: '가이드 실습 운영 세션', startDate: addDateDays(today, -2), endDate: addDateDays(today, 3), color: '#1769aa', status: 'confirmed',
            viewSettings: { dayStart: '08:00', dayEnd: '18:00', stepMinutes: 30, view: 'week' }, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
          }],
          groups: [
            { id: 'guide-calendar-group-past', sessionId: calendarSessionId, name: '사전 안내 그룹', color: '#7b8791', members: [{ id: 'guide-person-1', personId: 'guide-person-1', roleId: 'guide-role-facilitator' }, { id: 'guide-person-2', personId: 'guide-person-2', roleId: 'guide-role-participant' }], deletedMemberIds: [] },
            { id: 'guide-calendar-group-a', sessionId: calendarSessionId, name: 'A그룹', color: '#2879b8', members: [{ id: 'guide-person-1', personId: 'guide-person-1', roleId: 'guide-role-facilitator' }, { id: 'guide-person-2', personId: 'guide-person-2', roleId: 'guide-role-participant' }, { id: 'guide-person-5', personId: 'guide-person-5', roleId: 'guide-role-support' }], deletedMemberIds: [] },
            { id: 'guide-calendar-group-b', sessionId: calendarSessionId, name: 'B그룹', color: '#2f8f5b', members: [{ id: 'guide-person-1', personId: 'guide-person-1', roleId: 'guide-role-facilitator' }, { id: 'guide-person-3', personId: 'guide-person-3', roleId: 'guide-role-participant' }], deletedMemberIds: [] },
            { id: 'guide-calendar-group-c', sessionId: calendarSessionId, name: 'C그룹', color: '#8a5fb5', members: [{ id: 'guide-person-4', personId: 'guide-person-4', roleId: 'guide-role-participant' }], deletedMemberIds: [] }
          ]
        }
      }
    };
    project.moduleState = Object.fromEntries(allModules.map((id) => [id, { status: 'inProgress', updatedAt: new Date(now).toISOString(), summary: '가이드 연습 자료 준비됨' }]));
    project.workflow = project.workflow.map((workflowStep, index) => ({ ...workflowStep, order: index, status: 'inProgress', updatedAt: new Date(now).toISOString() }));
    demo.connections = [
      { id: 'guide-forms', type: 'forms', label: '가이드 Google 계정', account: 'guide@example.com', status: 'connected', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
      { id: 'guide-drive', type: 'drive', label: '가이드 Drive 계정', account: 'guide@example.com', status: 'connected', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
      { id: 'guide-gmail', type: 'gmail', label: '가이드 Gmail 계정', account: 'guide@example.com', status: 'connected', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
      { id: 'guide-zoom', type: 'zoom', label: '가이드 Zoom 계정', account: 'guide@example.com', status: 'connected', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }
    ];
    demo.preferences.storageMode = 'local';
    demo.preferences.workspaceDriveConnectionId = 'guide-drive';
    demo.preferences.globalDefaultConnectionIds = { gmail: 'guide-gmail', zoom: 'guide-zoom' };
    demo.library.rosters = [{ id: 'guide-library-roster', name: '가이드 샘플 명단', columns, people, createdAt: new Date(now).toISOString() }];
    demo.library.mailTemplates = [{ id: 'guide-library-mail', name: '가이드 일정 안내', subjectTemplate: project.data.communication.subjectTemplate, bodyTemplate: project.data.communication.bodyTemplate, bodyHtmlTemplate: project.data.communication.bodyHtmlTemplate, createdAt: new Date(now).toISOString() }];
    demo.activeProjectId = project.id;
    return Core.normalizeState(demo);
  }

  function positionCoach(targetRect, coachSize, viewport, gap = 14) {
    const margin = 12;
    const width = Math.min(coachSize.width, Math.max(240, viewport.width - (margin * 2)));
    const height = Math.min(coachSize.height, Math.max(160, viewport.height - (margin * 2)));
    const candidates = [
      { placement: 'right', left: targetRect.right + gap, top: targetRect.top + ((targetRect.height - height) / 2) },
      { placement: 'left', left: targetRect.left - width - gap, top: targetRect.top + ((targetRect.height - height) / 2) },
      { placement: 'bottom', left: targetRect.left + ((targetRect.width - width) / 2), top: targetRect.bottom + gap },
      { placement: 'top', left: targetRect.left + ((targetRect.width - width) / 2), top: targetRect.top - height - gap }
    ];
    const fits = (candidate) => candidate.left >= margin && candidate.top >= margin
      && candidate.left + width <= viewport.width - margin && candidate.top + height <= viewport.height - margin;
    const chosen = candidates.find(fits) || candidates
      .map((candidate) => {
        const left = Math.max(margin, Math.min(candidate.left, viewport.width - width - margin));
        const top = Math.max(margin, Math.min(candidate.top, viewport.height - height - margin));
        const overlapX = Math.max(0, Math.min(left + width, targetRect.right) - Math.max(left, targetRect.left));
        const overlapY = Math.max(0, Math.min(top + height, targetRect.bottom) - Math.max(top, targetRect.top));
        return { ...candidate, left, top, overlap: overlapX * overlapY };
      })
      .sort((a, b) => a.overlap - b.overlap)[0];
    return { placement: chosen.placement, left: Math.round(chosen.left), top: Math.round(chosen.top), width: Math.round(width), maxHeight: Math.round(height) };
  }

  return {
    GUIDE_VERSION,
    GUIDES,
    guideById,
    createDemoState,
    dateKeyInSeoul,
    addDateDays,
    positionCoach
  };
});
