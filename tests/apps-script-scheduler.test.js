const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let now = Date.parse('2026-11-12T00:00:00.000Z');
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(value) { super(arguments.length ? value : now); }
  static now() { return now; }
}

const properties = new Map();
const files = new Map();
const folders = new Map();
const drafts = new Map();
const triggers = [];
let nextId = 1;
let sentCount = 0;
const sleepCalls = [];

class Range {
  constructor(sheet, row, column, rows, columns) { Object.assign(this, { sheet, row, column, rows, columns }); }
  setValues(values) {
    for (let r = 0; r < this.rows; r += 1) {
      while (this.sheet.values.length < this.row + r) this.sheet.values.push([]);
      for (let c = 0; c < this.columns; c += 1) this.sheet.values[this.row + r - 1][this.column + c - 1] = values[r][c];
    }
    return this;
  }
  getValues() {
    return Array.from({ length: this.rows }, (_, r) => Array.from({ length: this.columns }, (_, c) => this.sheet.values[this.row + r - 1]?.[this.column + c - 1] ?? ''));
  }
}

class Sheet {
  constructor() { this.values = []; }
  getLastRow() { return this.values.length; }
  getRange(row, column, rows, columns) { return new Range(this, row, column, rows, columns); }
  appendRow(values) { this.values.push([...values]); }
  deleteRow(row) { this.values.splice(row - 1, 1); }
  hideSheet() {}
}

const sheet = new Sheet();
const spreadsheet = {
  getId: () => 'spreadsheet-1',
  getUrl: () => 'https://docs.google.com/spreadsheets/d/spreadsheet-1',
  getSheetByName: (name) => name === '_gmail_flow_online_queue' && sheet.values.length ? sheet : null,
  insertSheet: () => sheet
};

function makeFile(name, content) {
  const id = `file-${nextId++}`;
  const file = {
    id, name, content, trashed: false,
    getId: () => id,
    setContent(value) { file.content = value; return file; },
    getBlob: () => ({ getDataAsString: () => file.content }),
    setTrashed(value) { file.trashed = value; }
  };
  files.set(id, file);
  return file;
}

function makeDraft(to, subject, body) {
  const id = `draft-${nextId++}`;
  const draft = {
    id, to, subject, body, deleted: false, sent: false,
    getId: () => id,
    deleteDraft() { draft.deleted = true; drafts.delete(id); },
    send() {
      draft.sent = true; drafts.delete(id); sentCount += 1;
      return { getId: () => `message-${id}`, getThread: () => ({ getId: () => `thread-${id}` }) };
    }
  };
  drafts.set(id, draft);
  return draft;
}

const context = vm.createContext({
  Date: FakeDate,
  Set,
  Map,
  JSON,
  Math,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  PropertiesService: { getScriptProperties: () => ({
    getProperty: (key) => properties.get(key) || '',
    setProperty: (key, value) => properties.set(key, value)
  }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
  SpreadsheetApp: {
    create: () => spreadsheet,
    openById: () => spreadsheet
  },
  DriveApp: {
    createFolder: (name) => {
      const id = `folder-${nextId++}`;
      const folder = { id, name, getId: () => id, getUrl: () => `https://drive.google.com/drive/folders/${id}`, createFile: (fileName, content) => makeFile(fileName, content) };
      folders.set(id, folder);
      return folder;
    },
    getFolderById: (id) => folders.get(id),
    getFileById: (id) => files.get(id)
  },
  GmailApp: { createDraft: (to, subject, body) => makeDraft(to, subject, body), getDraft: (id) => drafts.get(id) || null },
  Utilities: {
    getUuid: () => `uuid-${nextId++}-abcdefghijklmnopqrstuvwxyz`,
    base64Decode: (value) => Buffer.from(value, 'base64'),
    newBlob: (bytes, type, name) => ({ bytes, type, name }),
    sleep: (milliseconds) => sleepCalls.push(milliseconds)
  },
  ScriptApp: {
    getProjectTriggers: () => triggers,
    newTrigger: (handler) => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => triggers.push({ getHandlerFunction: () => handler }) }) }) }),
    deleteTrigger: (trigger) => triggers.splice(triggers.indexOf(trigger), 1),
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/test/exec' })
  },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'sender@example.com' }), getScriptTimeZone: () => 'Asia/Seoul' },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: (content) => ({ content, setMimeType() { return this; }, getContent() { return this.content; } })
  },
  MimeType: { PLAIN_TEXT: 'text/plain' }
});

vm.runInContext(fs.readFileSync(require.resolve('../apps-script/Code.gs'), 'utf8'), context, { filename: 'Code.gs' });

function post(payload) {
  return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
}

const setup = context.setupOnlineScheduler();
assert.equal(setup.senderEmail, 'sender@example.com');
assert.equal(triggers.length, 1);
assert.ok(setup.secret.length >= 24);

const unauthorized = post({ action: 'health', secret: 'wrong' });
assert.equal(unauthorized.ok, false);
assert.equal(unauthorized.code, 'UNAUTHORIZED');

const job = {
  id: 'job-1', name: '테스트 예약', senderEmail: 'sender@example.com', scheduledAt: '2026-11-12T00:02:00.000Z', attachments: [],
  items: [{ id: 'item-1', email: 'to@example.com', subject: '제목', body: '본문', variables: { 이름: '테스트' } }]
};
const enqueued = post({ action: 'enqueue', secret: setup.secret, job });
assert.equal(enqueued.ok, true);
assert.equal(enqueued.data.status, 'scheduled');
assert.equal(drafts.size, 1);

const duplicate = post({ action: 'enqueue', secret: setup.secret, job });
assert.equal(duplicate.ok, true);
assert.equal(drafts.size, 1, 'idempotent enqueue must not create another draft');

now = Date.parse('2026-11-12T00:03:00.000Z');
context.runScheduledJobs();
assert.equal(sentCount, 1);
assert.equal(drafts.size, 0);
const completed = post({ action: 'status', secret: setup.secret, jobIds: ['job-1'] });
assert.equal(completed.data.jobs[0].status, 'completed');
assert.match(completed.data.jobs[0].items[0].messageId, /^message-draft-/);
assert.deepEqual(sleepCalls, [], 'a single recipient does not need an interval wait');

const pacedJob = {
  ...job, id: 'job-paced', scheduledAt: '2026-11-12T00:03:01.000Z',
  items: Array.from({ length: 14 }, (_, index) => ({ id: `paced-${index + 1}`, email: `paced-${index + 1}@example.com`, subject: '제목', body: '본문', variables: {} }))
};
assert.equal(post({ action: 'enqueue', secret: setup.secret, job: pacedJob }).ok, true);
now += 2_000;
context.runScheduledJobs();
let pacedStatus = post({ action: 'status', secret: setup.secret, jobIds: ['job-paced'] }).data.jobs[0];
assert.equal(pacedStatus.completed, 12, 'one trigger run must cap a job to the safe delivery slice');
assert.equal(pacedStatus.status, 'scheduled');
assert.equal(sleepCalls.filter((value) => value === 5000).length, 11, 'five-second spacing is applied between sends');
now += 60 * 1000;
context.runScheduledJobs();
pacedStatus = post({ action: 'status', secret: setup.secret, jobIds: ['job-paced'] }).data.jobs[0];
assert.equal(pacedStatus.completed, 14);
assert.equal(pacedStatus.status, 'completed');

now = Date.parse('2026-11-12T00:04:00.000Z');
const cancelJob = { ...job, id: 'job-2', scheduledAt: '2026-11-12T00:10:00.000Z' };
assert.equal(post({ action: 'enqueue', secret: setup.secret, job: cancelJob }).ok, true);
assert.equal(drafts.size, 1);
const canceled = post({ action: 'cancel', secret: setup.secret, jobId: 'job-2' });
assert.equal(canceled.data.status, 'canceled');
assert.equal(drafts.size, 0);

console.log('apps-script scheduler tests passed');
