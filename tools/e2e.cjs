// Drives the built site in Chromium with the Apps Script endpoint mocked, so
// nothing is ever written to the real sheet.
//
//   node tools/e2e.cjs <path to the playwright package> [screenshot folder]
//
// Set PW_EXE to a Chromium executable if the package's own browser is missing.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pwPath = process.argv[2];
const shots = process.argv[3] || '';
if (!pwPath) {
  console.error('usage: node tools/e2e.cjs <path to the playwright package> [screenshot folder]');
  process.exit(2);
}
const { chromium } = require(pwPath);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.xml': 'application/xml', '.txt': 'text/plain',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? '  -> ' + detail : ''}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shot = (target, name) => (shots ? target.screenshot({ path: path.join(shots, name) }) : null);

const COPY = {
  consentMissing: 'Please tick the box to agree to receive updates.',
  duplicate: "You're already on the list.",
  invalidEmail: 'That email address does not look right. Please check it and try again.',
  retry: 'Something went wrong and we could not add you. Please try again in a moment.',
  saveFailed: 'We could not save your answers. Please try again.',
};

// A reply is { body } | { body, delay } | { abort: true } | { status, raw }.
const ok = () => ({ body: { ok: true } });
function backend({ join, answers } = {}) {
  return (payload, n) =>
    payload.action === 'answers'
      ? (answers ? answers(payload, n) : ok())
      : (join ? join(payload, n) : { body: { ok: true, id: payload.id } });
}

async function open(browser, base, options = {}) {
  const { viewport = { width: 1280, height: 900 }, url = '/#waitlist', respond = backend(), referer } = options;
  const context = await browser.newContext({ viewport, locale: 'en-GB', timezoneId: 'Asia/Dubai' });
  const page = await context.newPage();
  const calls = [];
  const errors = [];
  const blocked = new Set();

  await page.addInitScript(() => {
    window.__fetches = [];
    const original = window.fetch;
    window.fetch = function (input, init) {
      window.__fetches.push({
        url: String(input),
        keys: init ? Object.keys(init).sort() : [],
        keepalive: !!(init && init.keepalive),
        body: init && typeof init.body === 'string' ? init.body : null,
      });
      return original.apply(this, arguments);
    };
  });

  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (!blocked.has(u) && !u.startsWith('https://script.google.com/')) errors.push('request failed: ' + u);
  });

  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = req.url();
    if (u.startsWith(base)) return route.continue();
    if (u.startsWith('https://script.google.com/macros/s/')) {
      const payload = JSON.parse(req.postData());
      const call = { method: req.method(), type: req.headers()['content-type'] || '', payload };
      calls.push(call);
      const reply = respond(payload, calls.filter((c) => c.payload.action === payload.action).length);
      if (reply.delay) await new Promise((r) => setTimeout(r, reply.delay));
      if (reply.abort) return route.abort('failed');
      return route.fulfill({
        status: reply.status || 200,
        contentType: reply.raw ? 'text/html' : 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: reply.raw || JSON.stringify(reply.body),
      });
    }
    blocked.add(u);
    return route.abort();
  });

  await page.goto(base + url, { waitUntil: 'load', referer });
  const panel = page.locator('[id="waitlist"]:visible').first();
  const form = page.locator('form:visible').first();
  await form.waitFor();

  const t = { context, page, panel, form, calls, errors };
  t.joins = () => calls.filter((c) => c.payload.action !== 'answers');
  t.saves = () => calls.filter((c) => c.payload.action === 'answers');
  t.lastSave = () => t.saves().slice(-1)[0].payload;
  t.waitSaves = async (n) => {
    for (let i = 0; i < 100 && t.saves().length < n; i++) await page.waitForTimeout(50);
    await page.waitForTimeout(80);
    return t.saves().length;
  };
  t.join = async (email) => {
    await form.locator('input[type=email]').fill(email);
    await form.locator('input[name=consent]').check();
    await form.locator('button[type=submit]').click();
  };
  // The question is also in a screen-reader legend, so match the visible line.
  t.question = (text) =>
    panel.locator('p[aria-live]').filter({ hasText: new RegExp('^' + esc(text) + '$') }).waitFor({ timeout: 5000 });
  t.pick = (label) => panel.locator('label').filter({ hasText: new RegExp('^' + esc(label) + '$') }).first().click();
  t.button = (name) => panel.getByRole('button', { name, exact: true });
  t.done = (text) => panel.getByText(text).first().waitFor({ timeout: 5000 });
  t.close = () => context.close();
  return t;
}

const Q = {
  been: 'Have you been on a desert trip before?',
  feelYes: 'What are you looking for in a desert trip?',
  feelNo: 'What would make you go on a desert trip?',
  expYes: 'Which desert experiences did you enjoy most?',
  expNo: 'Which desert experiences sound most exciting to you?',
  timing: 'When are you thinking of going again?',
  blocker: 'What has kept you from going on a desert trip so far?',
  area: 'Where is your camp?',
  offer: 'What do guests book with you?',
  camp: 'What is the name of your camp?',
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(
    process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : { channel: process.env.PW_CHANNEL || undefined },
  );
  const mobile = { width: 390, height: 844 };

  // ------------------------------------------------------------ email step
  {
    const t = await open(browser, base);
    await t.form.locator('input[type=email]').fill('new@example.com');
    await t.form.locator('button[type=submit]').click();
    await t.page.waitForTimeout(300);
    check('consent missing: no request sent', t.calls.length === 0);
    check('consent missing: message shown', await t.form.getByText(COPY.consentMissing).isVisible());
    check('consent missing: focus moves to checkbox',
      await t.form.locator('input[name=consent]').evaluate((el) => el === document.activeElement));
    const hp = t.form.locator('input[name=website]');
    check('honeypot: named website', (await hp.count()) === 1);
    check('honeypot: tabindex -1', (await hp.getAttribute('tabindex')) === '-1');
    check('honeypot: autocomplete off', (await hp.getAttribute('autocomplete')) === 'off');
    const box = await hp.boundingBox();
    check('honeypot: off screen', !!box && box.x < 0, JSON.stringify(box));
    check('consent checkbox: required', (await t.form.locator('input[name=consent]').getAttribute('required')) !== null);
    check('consent label text', await t.form.getByText('I agree to receive updates from DesertBooker.').isVisible());
    await t.close();
  }

  {
    const t = await open(browser, base, { respond: backend({ join: (p) => ({ delay: 800, body: { ok: true, id: p.id } }) }) });
    await t.form.locator('input[type=email]').fill('new@example.com');
    await t.form.locator('input[name=consent]').check();
    const button = t.form.locator('button[type=submit]');
    await button.click();
    await t.page.waitForTimeout(200);
    check('join loading: button disabled', await button.isDisabled());
    check('join loading: aria-busy', (await button.getAttribute('aria-busy')) === 'true');
    check('join loading: spinner rendered', (await button.locator('svg.animate-spin').count()) === 1);
    await t.question(Q.been);
    check('join success: moves on to the questions', true);
    await t.close();
  }

  {
    const t = await open(browser, base, { respond: backend({ join: () => ({ body: { ok: true, duplicate: true } }) }) });
    await t.join('dupe@example.com');
    await t.form.getByText(COPY.duplicate).waitFor({ timeout: 5000 });
    check('duplicate: message shown', true);
    check('duplicate: stays on the email step', await t.form.locator('input[type=email]').isVisible());
    check('duplicate: button usable again', await t.form.locator('button[type=submit]').isEnabled());
    await t.form.locator('input[type=email]').fill('other@example.com');
    check('duplicate: message clears on edit', (await t.form.getByText(COPY.duplicate).count()) === 0);
    await t.close();
  }

  for (const [error, text] of [
    ['server_error', COPY.retry], ['busy', COPY.retry],
    ['invalid_email', COPY.invalidEmail], ['consent_required', COPY.consentMissing],
  ]) {
    const t = await open(browser, base, { respond: backend({ join: () => ({ body: { ok: false, error } }) }) });
    await t.join('err@example.com');
    await t.form.getByText(text).waitFor({ timeout: 5000 });
    check(`join ${error}: message shown`, true);
    check(`join ${error}: not advanced`, await t.form.locator('input[type=email]').isVisible());
    await t.close();
  }

  for (const [name, reply] of [
    ['network failure', { abort: true }],
    ['non-JSON response', { status: 500, raw: '<h1>Error</h1>' }],
  ]) {
    const t = await open(browser, base, { respond: backend({ join: () => reply }) });
    await t.join('net@example.com');
    await t.form.getByText(COPY.retry).waitFor({ timeout: 5000 });
    check(`join ${name}: retry message shown`, true);
    check(`join ${name}: button usable again`, await t.form.locator('button[type=submit]').isEnabled());
    await t.close();
  }

  // A reply that never arrives, then a retry: the id must be the same, so the
  // server can tell a retry from a second person.
  {
    const t = await open(browser, base, {
      respond: backend({ join: (p, n) => (n === 1 ? { abort: true } : { body: { ok: true, id: p.id } }) }),
    });
    await t.join('lost@example.com');
    await t.form.getByText(COPY.retry).waitFor({ timeout: 5000 });
    await t.form.locator('button[type=submit]').click();
    await t.question(Q.been);
    const ids = t.joins().map((c) => c.payload.id);
    check('join retry: same id on both attempts', ids.length === 2 && ids[0] === ids[1], ids.join(' / '));
    await t.close();
  }

  // ---------------------------------------- traveller, every question, desktop
  {
    const t = await open(browser, base, {
      url: '/?utm_source=insta&utm_medium=social&utm_campaign=launch#waitlist',
      referer: 'https://www.google.com/',
    });
    await t.join('  New@Example.com ');
    await t.question(Q.been);

    const joined = t.joins()[0];
    const id = joined.payload.id;
    check('join: one request', t.joins().length === 1);
    check('join: POST as text/plain', joined.method === 'POST' && /^text\/plain/.test(joined.type), joined.type);
    check('join: id is a uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), id);
    check('join: payload', same(joined.payload, {
      action: 'join', id, email: 'New@Example.com', consent: true, audience: 'traveler', page: '/', website: '',
      device: 'desktop', referrer: 'https://www.google.com/', utm_source: 'insta', utm_medium: 'social',
      utm_campaign: 'launch', language: 'en-GB', timezone: 'Asia/Dubai',
    }), JSON.stringify(joined.payload));
    await t.page.waitForTimeout(300);
    check('questions open: nothing to save yet', t.saves().length === 0, String(t.saves().length));

    await t.pick('Yes');
    await t.question(Q.feelYes);
    await t.waitSaves(1);
    check('save 1: after the first question', same(t.lastSave().answers, { been_before: 'Yes' }),
      JSON.stringify(t.lastSave()));
    check('save 1: carries id, email, audience',
      t.lastSave().id === id && t.lastSave().email === 'new@example.com' && t.lastSave().audience === 'traveler',
      JSON.stringify(t.lastSave()));

    await t.pick('Something else');
    await t.panel.locator('textarea:visible, input[type=text]:visible').first().fill('  silence  ');
    await t.button('Continue').click();
    await t.question(Q.expYes);
    await t.waitSaves(2);
    check('save 2: own text goes to feeling_other',
      same(t.lastSave().answers, { been_before: 'Yes', feeling: 'Something else', feeling_other: 'silence' }),
      JSON.stringify(t.lastSave().answers));

    await t.pick('Camel ride');
    await t.pick('Stargazing');
    await t.button('Continue').click();
    await t.question(Q.timing);
    await t.waitSaves(3);
    check('save 3: many choices are a list', same(t.lastSave().answers.experience, ['Camel ride', 'Stargazing']),
      JSON.stringify(t.lastSave().answers));

    await t.pick('This winter');
    await t.page.waitForTimeout(300);
    check('last question: a choice alone does not finish', t.saves().length === 3 && await t.button('Done').isVisible());
    await t.button('Done').click();
    await t.done('You are on the list');
    check('finish by button: done screen shown', true);
    check('final save: every answer', same(t.lastSave().answers, {
      been_before: 'Yes', feeling: 'Something else', feeling_other: 'silence',
      experience: ['Camel ride', 'Stargazing'], timing: 'This winter',
    }), JSON.stringify(t.lastSave().answers));
    check('saves: four in total', t.saves().length === 4, String(t.saves().length));
    const seqs = t.saves().map((c) => c.payload.seq);
    check('saves: counter always rises', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), seqs.join(','));
    check('saves: all text/plain POSTs', t.saves().every((c) => c.method === 'POST' && /^text\/plain/.test(c.type)));
    const fetches = (await t.page.evaluate(() => window.__fetches)).filter((f) => f.url.includes('script.google.com'));
    check('fetch: only method, body and signal are set',
      fetches.length === 5 && fetches.every((f) => same(f.keys, ['body', 'method', 'signal'])),
      JSON.stringify(fetches.map((f) => f.keys)));
    check('traveller flow: no console errors', t.errors.length === 0, t.errors.join(' | '));
    await t.close();
  }

  // ------------------------- Yes changed to No, and "Something else" abandoned
  {
    const t = await open(browser, base);
    await t.join('branch@example.com');
    await t.question(Q.been);
    await t.pick('Yes');
    await t.question(Q.feelYes);
    await t.pick('Something else');
    await t.panel.locator('textarea:visible, input[type=text]:visible').first().fill('silence');
    await t.pick('Adventure and adrenaline');
    await t.question(Q.expYes);
    await t.waitSaves(2);
    check('own text is dropped once another choice is made',
      same(t.lastSave().answers, { been_before: 'Yes', feeling: 'Adventure and adrenaline' }),
      JSON.stringify(t.lastSave().answers));

    await t.pick('Safari');
    await t.pick('Stargazing');
    await t.button('Continue').click();
    await t.question(Q.timing);
    await t.pick('This winter');
    await t.button('Back').click();
    await t.question(Q.expYes);
    await t.waitSaves(4);
    check('Back saves the answer chosen before it',
      t.saves().length === 4 && t.lastSave().answers.timing === 'This winter', JSON.stringify(t.lastSave().answers));
    await t.button('Back').click();
    await t.question(Q.feelYes);
    await t.button('Back').click();
    await t.question(Q.been);
    await t.page.waitForTimeout(300);
    check('Back with nothing changed sends nothing', t.saves().length === 4, String(t.saves().length));
    await t.pick('No');
    await t.question(Q.feelNo);
    await t.pick('A romantic trip for two');
    await t.question(Q.expNo);
    await t.button('Continue').click();
    await t.question(Q.blocker);
    await t.panel.locator('textarea:visible').first().fill('too hot');
    await t.button('Done').click();
    await t.done('You are on the list');
    check('Yes to No: timing and the old-path choice are not sent', same(t.lastSave().answers, {
      been_before: 'No', feeling: 'A romantic trip for two', experience: ['Stargazing'], blocker: 'too hot',
    }), JSON.stringify(t.lastSave().answers));
    check('only changed snapshots are sent: seven in total', t.saves().length === 7, String(t.saves().length));
    await t.close();
  }

  // ----------------- operator, reached through the hero link, finished by Enter
  {
    const t = await open(browser, base, { url: '/?utm_source=partner&utm_campaign=camps' });
    await t.page.getByRole('link', { name: 'For camps and operators' }).locator('visible=true').first().click();
    await t.page.waitForTimeout(600);
    check('hero link: address rewritten', /#waitlist\?audience=operator$/.test(t.page.url()), t.page.url());
    await t.join('camp@example.com');
    await t.question(Q.area);
    const p = t.joins()[0].payload;
    check('operator: audience and device', p.audience === 'operator' && p.device === 'desktop', JSON.stringify(p));
    check('operator: UTM survives the address rewrite',
      p.utm_source === 'partner' && p.utm_campaign === 'camps' && p.utm_medium === '', JSON.stringify(p));
    check('operator: no referrer when there is none', p.referrer === '', p.referrer);

    await t.pick('Liwa');
    await t.question(Q.offer);
    await t.pick('Both');
    await t.question(Q.camp);
    await t.waitSaves(2);
    check('operator save 2', same(t.lastSave().answers, { op_area: 'Liwa', op_offer: 'Both' }),
      JSON.stringify(t.lastSave().answers));
    const field = t.panel.locator('input[type=text]:visible').first();
    await field.fill('Dune Camp');
    await field.press('Enter');
    await t.done('Thank you, Dune Camp.');
    check('finish by Enter: done screen shown', true);
    check('operator final save', same(t.lastSave(), {
      action: 'answers', id: p.id, email: 'camp@example.com', seq: t.lastSave().seq, audience: 'operator',
      answers: { op_area: 'Liwa', op_offer: 'Both', op_name: 'Dune Camp' },
    }), JSON.stringify(t.lastSave()));
    check('operator flow: no console errors', t.errors.length === 0, t.errors.join(' | '));
    await t.close();
  }

  // UTM placed after the hash, as some share tools do.
  {
    const t = await open(browser, base, { url: '/#waitlist?audience=operator&utm_source=hashy' });
    await t.join('hash@example.com');
    await t.question(Q.area);
    const p = t.joins()[0].payload;
    check('UTM in the hash is read', p.utm_source === 'hashy' && p.audience === 'operator', JSON.stringify(p));
    await t.close();
  }

  // ------------------------------------------------------- the Skip finishes
  {
    const t = await open(browser, base);
    await t.join('skip1@example.com');
    await t.question(Q.been);
    await t.button('Skip this question').click();
    await t.done('You are on the list');
    check('Skip on the first question: done, nothing to save', t.saves().length === 0, String(t.saves().length));
    await t.close();
  }
  {
    const t = await open(browser, base, { url: '/?audience=operator#waitlist' });
    await t.join('skip3@example.com');
    await t.question(Q.area);
    await t.pick('Al Qudra');
    await t.question(Q.offer);
    await t.pick('Overnight stays');
    await t.question(Q.camp);
    await t.button('Skip this question').click();
    await t.done('Thank you.');
    check('Skip on the last question: earlier answers saved',
      same(t.lastSave().answers, { op_area: 'Al Qudra', op_offer: 'Overnight stays' }),
      JSON.stringify(t.lastSave().answers));
    await t.close();
  }

  // ------------------------------------------------ slow, failed, retried save
  {
    const t = await open(browser, base, {
      url: '/?audience=operator#waitlist',
      respond: backend({ answers: (p) => (p.answers.op_name ? { delay: 1500, body: { ok: true } } : ok()) }),
    });
    await t.join('slow@example.com');
    await t.question(Q.area);
    await t.pick('Liwa');
    await t.question(Q.offer);
    await t.pick('Both');
    await t.question(Q.camp);
    await t.panel.locator('input[type=text]:visible').first().fill('Slow Camp');
    const send = t.button('Send');
    await send.click();
    await t.page.waitForTimeout(400);
    check('slow save: button busy and disabled',
      (await send.getAttribute('aria-busy')) === 'true' && await send.isDisabled());
    check('slow save: Back and Skip disabled',
      await t.button('Back').isDisabled() && await t.button('Skip this question').isDisabled());
    check('slow save: done screen not shown yet', (await t.panel.getByText('Registration received').count()) === 0);
    await shot(t.panel, 'desktop-final-saving.png');
    await t.done('Thank you, Slow Camp.');
    check('slow save: done screen after the reply', true);
    await t.close();
  }

  for (const [name, failure] of [
    ['server error', { body: { ok: false, error: 'server_error' } }],
    ['busy', { body: { ok: false, error: 'busy' } }],
    ['network failure', { abort: true }],
  ]) {
    let finals = 0;
    const t = await open(browser, base, {
      url: '/?audience=operator#waitlist',
      respond: backend({ answers: (p) => (p.answers.op_name && ++finals === 1 ? failure : ok()) }),
    });
    await t.join('fail@example.com');
    await t.question(Q.area);
    await t.pick('Liwa');
    await t.question(Q.offer);
    await t.pick('Both');
    await t.question(Q.camp);
    await t.panel.locator('input[type=text]:visible').first().fill('Retry Camp');
    await t.button('Send').click();
    await t.panel.getByText(COPY.saveFailed).waitFor({ timeout: 5000 });
    check(`final ${name}: message on the question screen`, true);
    check(`final ${name}: done screen not shown`, (await t.panel.getByText('Registration received').count()) === 0);
    check(`final ${name}: button usable again`, await t.button('Send').isEnabled());
    if (name === 'server error') await shot(t.panel, 'desktop-final-failed.png');
    await t.button('Send').click();
    await t.done('Thank you, Retry Camp.');
    check(`final ${name}: retry succeeds`, finals === 2, String(finals));
    await t.close();
  }

  // A slow server and a fast person: saves that were overtaken while they
  // waited are dropped, and the last one still carries every answer.
  {
    const t = await open(browser, base, { respond: backend({ answers: () => ({ delay: 900, body: { ok: true } }) }) });
    await t.join('fast@example.com');
    await t.question(Q.been);
    await t.pick('Yes');
    await t.question(Q.feelYes);
    await t.pick('Adventure and adrenaline');
    await t.question(Q.expYes);
    await t.pick('Safari');
    await t.button('Continue').click();
    await t.question(Q.timing);
    await t.pick('Next year');
    const pressed = Date.now();
    await t.button('Done').click();
    await t.done('You are on the list');
    const waited = Date.now() - pressed;
    check('fast person: overtaken saves are dropped', t.saves().length === 2, String(t.saves().length));
    check('fast person: done after at most two replies', waited < 2400, waited + ' ms');
    check('fast person: last save has every answer', same(t.lastSave().answers, {
      been_before: 'Yes', feeling: 'Adventure and adrenaline', experience: ['Safari'], timing: 'Next year',
    }), JSON.stringify(t.lastSave().answers));
    await t.close();
  }

  // An earlier save that fails must not block the person or lose the answer.
  {
    const t = await open(browser, base, {
      url: '/?audience=operator#waitlist',
      respond: backend({ answers: (p, n) => (n === 1 ? { body: { ok: false, error: 'server_error' } } : ok()) }),
    });
    await t.join('mid@example.com');
    await t.question(Q.area);
    await t.pick('Liwa');
    await t.question(Q.offer);
    check('failed early save: no message, flow continues', (await t.panel.getByText(COPY.saveFailed).count()) === 0);
    await t.pick('Both');
    await t.question(Q.camp);
    await t.button('Skip this question').click();
    await t.done('Thank you.');
    check('failed early save: later saves carry the answer',
      same(t.lastSave().answers, { op_area: 'Liwa', op_offer: 'Both' }), JSON.stringify(t.lastSave().answers));
    await t.close();
  }

  // The row is missing on the server (a bot that tripped the honeypot).
  {
    const t = await open(browser, base, {
      respond: backend({ join: () => ok(), answers: () => ({ body: { ok: false, error: 'not_found' } }) }),
    });
    await t.join('ghost@example.com');
    await t.question(Q.been);
    await t.pick('No');
    await t.question(Q.feelNo);
    await t.button('Skip this question').click();
    await t.question(Q.expNo);
    await t.button('Skip this question').click();
    await t.question(Q.blocker);
    await t.button('Done').click();
    await t.done('You are on the list');
    check('not_found: the person still reaches the done screen', true);
    check('join reply without id: the browser id is used',
      t.saves().every((c) => c.payload.id === t.joins()[0].payload.id));
    await t.close();
  }

  // The script not yet upgraded: it reads every request as a join, so a save
  // comes back as a duplicate or as a validation error. Neither may trap anyone.
  for (const [name, reply] of [
    ['duplicate', { ok: true, duplicate: true }],
    ['consent_required', { ok: false, error: 'consent_required' }],
    ['invalid_email', { ok: false, error: 'invalid_email' }],
  ]) {
    const t = await open(browser, base, { respond: backend({ join: () => ok(), answers: () => ({ body: reply }) }) });
    await t.join('old@example.com');
    await t.question(Q.been);
    await t.pick('Yes');
    await t.question(Q.feelYes);
    await t.button('Skip this question').click();
    await t.question(Q.expYes);
    await t.button('Skip this question').click();
    await t.question(Q.timing);
    await t.button('Done').click();
    await t.done('You are on the list');
    check(`old script replies ${name}: flow completes`, true);
    check(`old script replies ${name}: no error shown`, (await t.panel.getByText(COPY.saveFailed).count()) === 0);
    await t.close();
  }

  // ------------------------------------------------ Back, then the same email
  {
    const t = await open(browser, base, {
      respond: backend({ join: (p, n) => (n === 1 ? { body: { ok: true, id: p.id } } : { body: { ok: true, duplicate: true } }) }),
    });
    await t.join('back@example.com');
    await t.question(Q.been);
    await t.button('Back').click();
    await t.form.waitFor();
    check('Back from the first question: email kept',
      (await t.form.locator('input[type=email]').inputValue()) === 'back@example.com');
    await t.form.locator('button[type=submit]').click();
    await t.question(Q.been);
    check('same email again: questions shown', true);
    check('same email again: no second join', t.joins().length === 1, String(t.joins().length));
    check('same email again: no duplicate message', (await t.panel.getByText(COPY.duplicate).count()) === 0);

    // Switch role on the way back in: the saved audience must follow.
    await t.button('Back').click();
    await t.form.waitFor();
    await t.pick('Camp or operator');
    await t.form.locator('button[type=submit]').click();
    await t.question(Q.area);
    await t.waitSaves(1);
    check('role changed after Back: audience saved', t.lastSave().audience === 'operator' &&
      same(t.lastSave().answers, {}), JSON.stringify(t.lastSave()));
    check('role changed after Back: still one join', t.joins().length === 1);

    // A different email is a different person: a new join with a new id.
    await t.button('Back').click();
    await t.form.waitFor();
    await t.form.locator('input[type=email]').fill('second@example.com');
    await t.form.locator('button[type=submit]').click();
    await t.form.getByText(COPY.duplicate).waitFor({ timeout: 5000 });
    const ids = t.joins().map((c) => c.payload.id);
    check('new email: second join with a new id', ids.length === 2 && ids[0] !== ids[1], ids.join(' / '));
    await t.close();
  }

  // --------------------------------------------- leaving with an answer chosen
  {
    const t = await open(browser, base);
    await t.join('leave@example.com');
    await t.question(Q.been);
    await t.pick('Yes');
    await t.question(Q.feelYes);
    await t.pick('The desert, done in luxury');
    await t.question(Q.expYes);
    await t.waitSaves(2);
    await t.pick('Quad biking');
    await t.page.waitForTimeout(200);
    check('a choice alone is not saved yet', t.saves().length === 2, String(t.saves().length));
    await t.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await t.waitSaves(3);
    check('page hidden: the current choice is saved', same(t.lastSave().answers, {
      been_before: 'Yes', feeling: 'The desert, done in luxury', experience: ['Quad biking'],
    }), JSON.stringify(t.lastSave().answers));
    const last = (await t.page.evaluate(() => window.__fetches)).slice(-1)[0];
    check('page hidden: sent with keepalive', last.keepalive === true, JSON.stringify(last.keys));
    await t.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await t.page.waitForTimeout(300);
    check('page hidden twice: nothing new to send', t.saves().length === 3, String(t.saves().length));
    await t.close();
  }

  // ------------------------------------------------------------------ mobile
  {
    const t = await open(browser, base, { viewport: mobile });
    await t.join('phone@example.com');
    await t.question(Q.been);
    check('mobile: device is mobile', t.joins()[0].payload.device === 'mobile', t.joins()[0].payload.device);
    await t.pick('No');
    await t.question(Q.feelNo);
    await t.pick('Quiet, calm and discovery');
    await t.question(Q.expNo);
    await t.pick('Falconry');
    await t.pick('Something else');
    await t.panel.locator('textarea:visible, input[type=text]:visible').first().fill('tea with a guide');
    await t.button('Continue').click();
    await t.question(Q.blocker);
    await t.panel.locator('textarea:visible').first().fill('no car');
    await shot(t.panel, 'mobile-last-question.png');
    await t.button('Done').click();
    await t.done('You are on the list');
    check('mobile: final save', same(t.lastSave().answers, {
      been_before: 'No', feeling: 'Quiet, calm and discovery',
      experience: ['Falconry', 'Something else'], experience_other: 'tea with a guide', blocker: 'no car',
    }), JSON.stringify(t.lastSave().answers));
    check('mobile: one join', t.joins().length === 1);
    check('mobile: no console errors', t.errors.length === 0, t.errors.join(' | '));
    await t.close();
  }

  // ------------------------------------------- legal pages and document heads
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));

    await page.goto(base + '/privacy-policy/', { waitUntil: 'load' });
    await page.getByRole('heading', { name: '9. Waitlist' }).waitFor({ timeout: 5000 });
    const section = page.locator('section', { has: page.getByRole('heading', { name: '9. Waitlist' }) });
    const text = await section.innerText();
    check('privacy: five things listed', (await section.locator('li').count()) === 5);
    for (const [name, pattern] of [
      ['email and role', /email address.*traveller.*camp or operator/],
      ['answers and camp name', /answers to the questions.*name of your camp/],
      ['device', /mobile or the desktop version/],
      ['traffic source', /website or campaign link/],
      ['language and time zone', /language and time zone/],
      ['Google Sheets', /stored in Google Sheets/],
    ]) check(`privacy: names ${name}`, pattern.test(text), text);
    check('privacy: removal link', (await section.locator('a[href^="mailto:"]').count()) === 1);
    const headings = await page.locator('article h2').allInnerTexts();
    check('privacy: headings numbered 1 to 11',
      headings.length === 11 && headings.every((h, i) => h.startsWith(`${i + 1}. `)), headings.join(' / '));
    await shot(section, 'privacy-section.png');

    await page.goto(base + '/terms-of-service/', { waitUntil: 'load' });
    await page.getByRole('heading', { name: '10. Contact' }).waitFor({ timeout: 5000 });
    check('terms: still renders, numbering untouched', true);

    for (const [url, canonical] of [
      ['/', 'https://desertbooker.com/'],
      ['/privacy-policy/', 'https://desertbooker.com/privacy-policy/'],
      ['/terms-of-service/', 'https://desertbooker.com/terms-of-service/'],
    ]) {
      await page.goto(base + url, { waitUntil: 'load' });
      await page.waitForTimeout(300);
      const head = await page.evaluate(() => ({
        title: document.title,
        description: document.querySelector('meta[name=description]')?.content ?? '',
        canonical: document.querySelector('link[rel=canonical]')?.href ?? '',
        robots: document.querySelectorAll('meta[name=robots]').length,
      }));
      check(`head ${url}`,
        head.title.length > 0 && head.description.length > 0 && head.canonical === canonical && head.robots === 0,
        JSON.stringify(head));
    }
    check('legal pages: no page errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) console.log('failed:\n  ' + failed.map((f) => f.name).join('\n  '));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
