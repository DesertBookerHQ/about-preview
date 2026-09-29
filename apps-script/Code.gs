/**
 * DesertBooker waitlist: Google Apps Script web app.
 *
 * Receives the waitlist form from desertbooker.com and stores it in one tab of
 * a Google Sheet: one row per email, one column per answer.
 *
 * Requests arrive as POST with a JSON body sent as text/plain.
 *
 *   join     { action?, id?, email, consent, audience, page, website, device,
 *              referrer, utm_source, utm_medium, utm_campaign, language,
 *              timezone, name? }
 *            A request with no "action" is a join, so older site builds work.
 *
 *   answers  { action: "answers", id, email, seq, audience, answers: {...} }
 *            Overwrites every answer column of the row that carries this id.
 *
 * Run checkSheet() first (it only reads), then setup() (it adds the columns).
 * Run useQuestionHeaders() to name the answer columns after the questions.
 */

// ------------------------------------------------------------------ SETTINGS

// Leave empty if this script was opened from the sheet (Extensions > Apps Script).
// Otherwise paste the ID from the sheet's address:
// https://docs.google.com/spreadsheets/d/THIS_PART/edit
var SPREADSHEET_ID = '';

// Leave empty to let the script pick the tab. Otherwise the exact tab name.
var SHEET_NAME = '';

// ------------------------------------------------------------ END OF SETTINGS

var VERSION = 4;

var EMAIL_RE = /^[A-Za-z0-9][A-Za-z0-9._%+'\-]*@[A-Za-z0-9](?:[A-Za-z0-9.\-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
var ID_RE = /^[A-Za-z0-9\-]{16,64}$/;
var MAX_BODY = 10000;
var CACHE_TTL_SECONDS = 21600;

// Aliases are compared after lowercasing and removing everything but a-z, 0-9.
// "create: false" means the column is used when it exists and never added.
// "label" is the question as the form shows it. A column whose name is the
// label is recognised too, so the sheet can carry the questions as headings.
var FIELDS = [
  { key: 'timestamp', text: false, aliases: ['timestamp', 'time', 'date', 'datetime', 'created', 'createdat', 'submitted', 'submittedat', 'joined', 'joinedat', 'signupdate'] },
  { key: 'email', aliases: ['email', 'emailaddress', 'emailadress', 'mail'] },
  { key: 'audience', aliases: ['audience', 'audiencetype', 'role', 'type', 'usertype'] },
  { key: 'consent', aliases: ['consent', 'consented', 'agreed', 'optin'] },
  { key: 'page', aliases: ['page', 'path', 'pagepath', 'url'] },
  { key: 'name', create: false, aliases: ['name', 'fullname'] },
  { key: 'id', aliases: ['id', 'entryid', 'signupid'] },
  { key: 'device', aliases: ['device', 'devicetype'] },
  { key: 'referrer', aliases: ['referrer', 'referer'] },
  { key: 'utm_source', aliases: ['utmsource'] },
  { key: 'utm_medium', aliases: ['utmmedium'] },
  { key: 'utm_campaign', aliases: ['utmcampaign'] },
  { key: 'language', aliases: ['language', 'lang'] },
  { key: 'timezone', aliases: ['timezone'] },
  { key: 'been_before', label: 'Have you been on a desert trip before?', aliases: ['beenbefore'] },
  { key: 'feeling', label: 'What are you looking for in a desert trip?', aliases: ['feeling'] },
  { key: 'feeling_other', label: 'What are you looking for? (own words)', aliases: ['feelingother'] },
  { key: 'experience', label: 'Which desert experiences?', aliases: ['experience'] },
  { key: 'experience_other', label: 'Which desert experiences? (own words)', aliases: ['experienceother'] },
  { key: 'timing', label: 'When are you thinking of going again?', aliases: ['timing'] },
  { key: 'blocker', label: 'What has kept you from going on a desert trip so far?', aliases: ['blocker'] },
  { key: 'op_area', label: 'Where is your camp?', aliases: ['oparea'] },
  { key: 'op_offer', label: 'What do guests book with you?', aliases: ['opoffer'] },
  { key: 'op_name', label: 'What is the name of your camp?', aliases: ['opname', 'campname'] }
];

var ANSWER_KEYS = [
  'been_before', 'feeling', 'feeling_other', 'experience', 'experience_other',
  'timing', 'blocker', 'op_area', 'op_offer', 'op_name'
];

// ------------------------------------------------------------------ WEB APP

function doGet() {
  return json_({ ok: true, service: 'desertbooker-waitlist', version: VERSION });
}

function doPost(e) {
  try {
    var body = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    if (!body || body.length > MAX_BODY) return json_({ ok: false, error: 'server_error' });

    var data;
    try {
      data = JSON.parse(body);
    } catch (parseError) {
      return json_({ ok: false, error: 'server_error' });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return json_({ ok: false, error: 'server_error' });
    }

    return json_(data.action === 'answers' ? handleAnswers_(data) : handleJoin_(data));
  } catch (error) {
    console.error('doPost failed: ' + (error && error.stack ? error.stack : error));
    return json_({ ok: false, error: 'server_error' });
  }
}

function handleJoin_(data) {
  // A filled honeypot is a bot. It is told "ok" and nothing is stored.
  if (clean_(data.website, 10) !== '') return { ok: true };

  var email = String(data.email === undefined || data.email === null ? '' : data.email).trim();
  if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };
  if (!(data.consent === true || data.consent === 'true')) return { ok: false, error: 'consent_required' };

  return withLock_(function () {
    var sheet = getSheet_();
    var state = resolveColumns_(sheet, true);
    if (state.problem) throw new Error('Sheet is not ready: ' + state.problem);

    var cols = state.cols;
    var rows = readRows_(sheet, cols, state.lastRow);
    var wanted = email.toLowerCase();
    var suppliedId = cleanId_(data.id);

    for (var i = 0; i < rows.emails.length; i++) {
      if (rows.emails[i] !== wanted) continue;
      if (suppliedId && rows.ids[i] === suppliedId) return { ok: true, id: suppliedId };
      return { ok: true, duplicate: true };
    }

    var id = suppliedId && rows.ids.indexOf(suppliedId) === -1 ? suppliedId : Utilities.getUuid();
    var values = {
      timestamp: new Date(),
      email: clean_(email, 254),
      audience: audience_(data.audience) || 'traveler',
      consent: true,
      page: clean_(data.page, 200),
      name: clean_(data.name, 120),
      id: id,
      device: data.device === 'mobile' || data.device === 'desktop' ? data.device : '',
      referrer: clean_(data.referrer, 300),
      utm_source: clean_(data.utm_source, 100),
      utm_medium: clean_(data.utm_medium, 100),
      utm_campaign: clean_(data.utm_campaign, 100),
      language: clean_(data.language, 35),
      timezone: clean_(data.timezone, 64)
    };

    // Empty values are written too: it keeps neighbouring columns in one
    // range, and one range is one round trip to the sheet.
    var pairs = [];
    for (var key in values) {
      if (cols[key]) pairs.push({ col: cols[key], value: values[key] });
    }
    writeCells_(sheet, rows.nextRow, pairs);
    SpreadsheetApp.flush();
    return { ok: true, id: id };
  });
}

function handleAnswers_(data) {
  var id = cleanId_(data.id);
  var email = String(data.email === undefined || data.email === null ? '' : data.email).trim().toLowerCase();
  if (!id || !email) return { ok: false, error: 'not_found' };

  var answers = data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers) ? data.answers : {};
  var seq = Number(data.seq);
  if (!isFinite(seq) || seq < 1) seq = 0;

  return withLock_(function () {
    var sheet = getSheet_();
    var state = resolveColumns_(sheet, true);
    if (state.problem) throw new Error('Sheet is not ready: ' + state.problem);

    var cols = state.cols;
    var rows = readRows_(sheet, cols, state.lastRow);
    var index = rows.ids.indexOf(id);
    if (index === -1 || rows.emails[index] !== email) return { ok: false, error: 'not_found' };

    // An older save that arrives after a newer one must not overwrite it.
    if (seq && lastSeq_(id) >= seq) return { ok: true, stale: true };

    var pairs = [];
    for (var i = 0; i < ANSWER_KEYS.length; i++) {
      var key = ANSWER_KEYS[i];
      if (cols[key]) pairs.push({ col: cols[key], value: answerValue_(answers[key]) });
    }
    var audience = audience_(data.audience);
    if (audience && cols.audience) pairs.push({ col: cols.audience, value: audience });

    writeCells_(sheet, index + 2, pairs);
    SpreadsheetApp.flush();
    if (seq) rememberSeq_(id, seq);
    return { ok: true };
  });
}

// ------------------------------------------------- FUNCTIONS YOU RUN BY HAND

/** Reads the sheet and reports what the script would do. Changes nothing. */
function checkSheet() {
  var lines = report_(false);
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/** Adds the missing columns, then reports. Safe to run more than once. */
function setup() {
  var lines = report_(true);
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/**
 * Names the answer columns after the questions, for example "op_area" becomes
 * "Where is your camp?". Only row 1 changes. Safe to run more than once.
 */
function useQuestionHeaders() {
  var lines = ['DesertBooker waitlist script, version ' + VERSION, 'MODE: question headers', ''];
  var sheet = getSheet_();
  var state = resolveColumns_(sheet, true);
  if (state.problem) {
    lines.push('RESULT: STOP. ' + state.problem + ' Send this log before doing anything else.');
  } else {
    var changed = 0;
    for (var i = 0; i < FIELDS.length; i++) {
      var field = FIELDS[i];
      var col = state.cols[field.key];
      if (!field.label || !col) continue;
      var old = state.headers[col - 1] || field.key;
      if (old === field.label) continue;
      sheet.getRange(1, col, 1, 1).setValues([[field.label]]);
      lines.push('  ' + letter_(col) + ': ' + old + '  ->  ' + field.label);
      changed++;
    }
    SpreadsheetApp.flush();
    if (changed) lines.push('');
    lines.push('RESULT: DONE. ' + changed + ' column name(s) changed.');
  }
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

function report_(apply) {
  var lines = [];
  var spreadsheet = getSpreadsheet_();
  var sheet = getSheet_();

  lines.push('DesertBooker waitlist script, version ' + VERSION);
  lines.push(apply ? 'MODE: setup (adds missing columns)' : 'MODE: check (reads only)');
  lines.push('');
  lines.push('FILE (open this address to see the sheet the script writes to)');
  lines.push('  ' + spreadsheet.getName());
  lines.push('  ' + spreadsheet.getUrl());
  lines.push('');
  lines.push('TABS');
  var tabs = spreadsheet.getSheets();
  for (var t = 0; t < tabs.length; t++) {
    lines.push('  ' + (tabs[t].getName() === sheet.getName() ? '> ' : '  ') + tabs[t].getName() +
      ' (' + tabs[t].getLastRow() + ' rows, ' + tabs[t].getLastColumn() + ' columns)');
  }
  lines.push('  The tab marked ">" is the one the script uses.');
  lines.push('');

  var state = resolveColumns_(sheet, apply);

  lines.push('ROW 1');
  if (state.headers.length === 0) {
    lines.push('  (empty)');
  } else {
    for (var h = 0; h < state.headers.length; h++) {
      lines.push('  ' + letter_(h + 1) + ': ' + (state.headers[h] === '' ? '(blank)' : state.headers[h]));
    }
  }
  lines.push('');

  lines.push('COLUMNS THE SCRIPT USES');
  for (var f = 0; f < FIELDS.length; f++) {
    var key = FIELDS[f].key;
    var note = state.notes[key];
    lines.push('  ' + pad_(key, 18) + note);
  }
  lines.push('');

  if (state.unused.length) {
    lines.push('YOUR OTHER COLUMNS (the script never writes to these)');
    for (var u = 0; u < state.unused.length; u++) lines.push('  ' + state.unused[u]);
    lines.push('');
  }

  if (!state.problem) {
    var rows = readRows_(sheet, state.cols, state.lastRow);
    var seen = {};
    var repeated = 0;
    for (var r = 0; r < rows.emails.length; r++) {
      if (!rows.emails[r]) continue;
      if (seen[rows.emails[r]]) repeated++;
      seen[rows.emails[r]] = true;
    }
    if (repeated) state.warnings.push(repeated + ' email(s) appear more than once in the existing rows.');
    if (state.lastRow > rows.nextRow - 1) {
      state.warnings.push('There is content below the last email (row ' + (rows.nextRow - 1) +
        '). New signups are written to row ' + rows.nextRow + '.');
    }
    lines.push('ROWS');
    lines.push('  Signups found: ' + rows.count);
    lines.push('  Signups that answered at least one question: ' + countAnswered_(sheet, state.cols, rows));
    lines.push('  Next signup goes to row: ' + rows.nextRow);
    lines.push('');
  }

  if (state.warnings.length) {
    lines.push('WARNINGS');
    for (var w = 0; w < state.warnings.length; w++) lines.push('  - ' + state.warnings[w]);
    lines.push('');
  }

  if (state.problem) {
    lines.push('RESULT: STOP. ' + state.problem + ' Send this log before doing anything else.');
  } else if (apply) {
    lines.push('RESULT: DONE. ' + state.created.length + ' column(s) added. You can deploy now.');
  } else {
    lines.push('RESULT: OK. ' + state.missing.length + ' column(s) will be added when you run setup.');
  }
  return lines;
}

// ------------------------------------------------------------------- SHEET

function getSpreadsheet_() {
  var spreadsheet = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('No spreadsheet found. Fill in SPREADSHEET_ID at the top of the script.');
  return spreadsheet;
}

function getSheet_() {
  var spreadsheet = getSpreadsheet_();
  if (SHEET_NAME) {
    var named = spreadsheet.getSheetByName(SHEET_NAME);
    if (!named) throw new Error('No tab is called "' + SHEET_NAME + '". Check SHEET_NAME at the top of the script.');
    return named;
  }
  var tabs = spreadsheet.getSheets();
  if (tabs.length === 1) return tabs[0];

  // With several tabs and no name set, prefer the first tab that already has
  // an email column. The choice is remembered so later requests skip the search.
  var remembered = recall_('tab');
  if (remembered) {
    var known = spreadsheet.getSheetByName(remembered);
    if (known) return known;
  }
  var emailAliases = fieldByKey_('email').aliases;
  for (var i = 0; i < tabs.length; i++) {
    var width = tabs[i].getLastColumn();
    if (!width || !tabs[i].getLastRow()) continue;
    var headers = tabs[i].getRange(1, 1, 1, width).getDisplayValues()[0];
    for (var j = 0; j < headers.length; j++) {
      if (emailAliases.indexOf(normalise_(headers[j])) !== -1) {
        remember_('tab', tabs[i].getName());
        return tabs[i];
      }
    }
  }
  return tabs[0];
}

/**
 * Maps every field to a column by reading row 1. With create = true the
 * missing columns are added to the right of the existing ones.
 */
function resolveColumns_(sheet, create) {
  var state = {
    cols: {}, notes: {}, headers: [], unused: [], warnings: [],
    missing: [], created: [], problem: '', lastRow: 0
  };
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  state.lastRow = lastRow;
  if (lastRow > 0 && lastCol > 0) {
    var raw = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    for (var i = 0; i < raw.length; i++) state.headers.push(String(raw[i]).trim());
  }

  var named = 0;
  for (var h = 0; h < state.headers.length; h++) {
    if (state.headers[h] !== '') named++;
    if (EMAIL_RE.test(state.headers[h])) state.problem = 'Row 1 holds a signup, not column names.';
  }
  if (!state.problem && named === 0 && lastRow >= 2) {
    state.problem = 'Row 1 is empty but the rows below it have content.';
  }
  if (state.problem) {
    for (var n = 0; n < FIELDS.length; n++) state.notes[FIELDS[n].key] = 'not checked';
    return state;
  }

  var byName = {};
  var used = {};
  for (var c = 0; c < state.headers.length; c++) {
    var name = normalise_(state.headers[c]);
    if (!name) continue;
    if (byName[name]) {
      state.warnings.push('Columns ' + letter_(byName[name]) + ' and ' + letter_(c + 1) +
        ' have the same name "' + state.headers[c] + '". The script uses ' + letter_(byName[name]) + '.');
    } else {
      byName[name] = c + 1;
    }
  }

  for (var f = 0; f < FIELDS.length; f++) {
    var field = FIELDS[f];
    var names = field.label ? field.aliases.concat([normalise_(field.label)]) : field.aliases;
    for (var a = 0; a < names.length; a++) {
      var col = byName[names[a]];
      if (col && !used[col]) {
        state.cols[field.key] = col;
        used[col] = true;
        state.notes[field.key] = 'column ' + letter_(col) + ' "' + state.headers[col - 1] + '"';
        break;
      }
    }
  }

  // An email column under a name the script does not know is found by content,
  // so a second email column is never added beside it.
  if (!state.cols.email && lastRow >= 2) {
    var found = emailColumnByContent_(sheet, lastRow, lastCol, used);
    if (found) {
      state.cols.email = found;
      used[found] = true;
      state.notes.email = 'column ' + letter_(found) + ' "' + state.headers[found - 1] + '" (found by its content)';
      state.warnings.push('The email column was recognised by its content, not by its name.');
    }
  }

  for (var m = 0; m < FIELDS.length; m++) {
    var pending = FIELDS[m];
    if (state.cols[pending.key]) continue;
    if (pending.create === false) {
      state.notes[pending.key] = 'not in the sheet; left out';
    } else {
      state.missing.push(pending);
      state.notes[pending.key] = 'will be added';
    }
  }

  for (var u = 0; u < state.headers.length; u++) {
    if (!used[u + 1] && state.headers[u] !== '') state.unused.push(letter_(u + 1) + ': ' + state.headers[u]);
  }

  if (create && state.missing.length) {
    var start = lastCol + 1;
    var need = lastCol + state.missing.length;
    if (need > sheet.getMaxColumns()) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());
    }
    var fresh = [];
    for (var k = 0; k < state.missing.length; k++) fresh.push(state.missing[k].key);
    sheet.getRange(1, start, 1, fresh.length).setValues([fresh]);

    var bodyRows = sheet.getMaxRows() - 1;
    for (var p = 0; p < state.missing.length; p++) {
      var added = state.missing[p];
      var at = start + p;
      state.cols[added.key] = at;
      state.created.push(added.key);
      state.notes[added.key] = 'added as column ' + letter_(at);
      // Plain text stops Sheets from turning "12/05" into a date.
      if (added.text !== false && bodyRows > 0) sheet.getRange(2, at, bodyRows, 1).setNumberFormat('@');
    }
    state.missing = [];
  }

  return state;
}

function emailColumnByContent_(sheet, lastRow, lastCol, used) {
  var sample = Math.min(lastRow - 1, 50);
  var values = sheet.getRange(2, 1, sample, lastCol).getDisplayValues();
  var best = 0;
  var bestCount = 0;
  for (var c = 0; c < lastCol; c++) {
    if (used[c + 1]) continue;
    var count = 0;
    for (var r = 0; r < values.length; r++) {
      if (EMAIL_RE.test(String(values[r][c]).trim())) count++;
    }
    if (count > bestCount) {
      best = c + 1;
      bestCount = count;
    }
  }
  return best;
}

function countAnswered_(sheet, cols, rows) {
  var height = rows.nextRow - 2;
  var width = sheet.getLastColumn();
  if (height < 1 || width < 1) return 0;
  var values = sheet.getRange(2, 1, height, width).getDisplayValues();
  var answered = 0;
  for (var r = 0; r < values.length; r++) {
    for (var k = 0; k < ANSWER_KEYS.length; k++) {
      var col = cols[ANSWER_KEYS[k]];
      if (col && col <= width && String(values[r][col - 1]).trim() !== '') {
        answered++;
        break;
      }
    }
  }
  return answered;
}

/** Emails and ids of every data row, lowercased and trimmed, in sheet order. */
function readRows_(sheet, cols, lastRow) {
  var result = { emails: [], ids: [], count: 0, nextRow: 2 };
  if (lastRow < 2 || !cols.email) return result;

  var height = lastRow - 1;
  var emailAt = 0;
  var idAt = 0;
  var emails;
  var ids = null;
  var first = cols.id ? Math.min(cols.email, cols.id) : cols.email;
  var last = cols.id ? Math.max(cols.email, cols.id) : cols.email;
  if (last - first < 12) {
    // Close together: one read covers both columns.
    emails = sheet.getRange(2, first, height, last - first + 1).getDisplayValues();
    emailAt = cols.email - first;
    if (cols.id) {
      ids = emails;
      idAt = cols.id - first;
    }
  } else {
    emails = sheet.getRange(2, cols.email, height, 1).getDisplayValues();
    ids = sheet.getRange(2, cols.id, height, 1).getDisplayValues();
  }
  var lastFilled = -1;
  for (var i = 0; i < height; i++) {
    var email = String(emails[i][emailAt]).trim().toLowerCase();
    result.emails.push(email);
    result.ids.push(ids ? String(ids[i][idAt]).trim() : '');
    if (email) {
      lastFilled = i;
      result.count++;
    }
  }
  result.emails.length = lastFilled + 1;
  result.ids.length = lastFilled + 1;
  result.nextRow = lastFilled + 3;
  return result;
}

/** Writes only the given cells, so columns the owner added are never touched. */
function writeCells_(sheet, row, pairs) {
  if (!pairs.length) return;
  pairs.sort(function (a, b) { return a.col - b.col; });
  try {
    writeRuns_(sheet, row, pairs);
  } catch (error) {
    // Asking for the sheet's size on every request costs a round trip, so the
    // sheet is only made longer when a write shows that it is too short.
    var size = sheet.getMaxRows();
    if (row <= size) throw error;
    sheet.insertRowsAfter(size, row - size + 50);
    writeRuns_(sheet, row, pairs);
  }
}

function writeRuns_(sheet, row, pairs) {
  var start = 0;
  while (start < pairs.length) {
    var end = start;
    while (end + 1 < pairs.length && pairs[end + 1].col === pairs[end].col + 1) end++;
    var run = [];
    for (var i = start; i <= end; i++) run.push(pairs[i].value);
    sheet.getRange(row, pairs[start].col, 1, run.length).setValues([run]);
    start = end + 1;
  }
}

// ------------------------------------------------------------------ VALUES

/**
 * Makes a visitor's text safe to store. Sheets runs any text that starts with
 * = + - or @ as a formula; a leading apostrophe keeps it as plain text.
 */
function clean_(value, max) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return '';
  var text = String(value).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  if (text.length > max) text = text.slice(0, max).trim();
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return text;
}

function answerValue_(value) {
  if (Array.isArray(value)) {
    var parts = [];
    for (var i = 0; i < value.length && parts.length < 12; i++) {
      var part = String(value[i] === undefined || value[i] === null ? '' : value[i])
        .replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, 100);
      if (part) parts.push(part);
    }
    return clean_(parts.join(', '), 600);
  }
  return clean_(value, 300);
}

function cleanId_(value) {
  var id = typeof value === 'string' ? value.trim() : '';
  return ID_RE.test(id) ? id : '';
}

function audience_(value) {
  return value === 'operator' || value === 'traveler' ? value : '';
}

function normalise_(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fieldByKey_(key) {
  for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].key === key) return FIELDS[i];
  return null;
}

function letter_(column) {
  var out = '';
  while (column > 0) {
    var rest = (column - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    column = (column - rest - 1) / 26;
  }
  return out;
}

function pad_(text, width) {
  while (text.length < width) text += ' ';
  return text;
}

// ----------------------------------------------------------------- PLUMBING

function withLock_(work) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy' };
  try {
    return work();
  } finally {
    lock.releaseLock();
  }
}

function lastSeq_(id) {
  return Number(recall_('seq_' + id)) || 0;
}

function rememberSeq_(id, seq) {
  remember_('seq_' + id, String(seq));
}

// The cache only saves work and guards against out-of-order saves, so a
// failure here is never allowed to fail the request.
function recall_(key) {
  try {
    return CacheService.getScriptCache().get(key) || '';
  } catch (error) {
    return '';
  }
}

function remember_(key, value) {
  try {
    CacheService.getScriptCache().put(key, value, CACHE_TTL_SECONDS);
  } catch (error) {
    // Nothing to do.
  }
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
