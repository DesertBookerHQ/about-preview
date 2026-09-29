// Adds the tracking tools of the previous site to the three pages, and names
// them in the privacy policy.
//
//   node tools/patch-tracking.cjs
//
// Every replacement must match exactly once; otherwise the script stops before
// writing anything. It cannot be applied twice.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets');
const read = (file) => fs.readFileSync(file, 'utf8');

function replaceOnce(src, from, to, label) {
  const first = src.indexOf(from);
  if (first === -1) throw new Error(`no match: ${label}`);
  if (src.indexOf(from, first + 1) !== -1) throw new Error(`ambiguous match: ${label}`);
  return src.slice(0, first) + to + src.slice(first + from.length);
}

function findBundle(prefix) {
  const found = fs.readdirSync(assets).filter((f) => f.startsWith(prefix + '-') && f.endsWith('.js'));
  if (found.length !== 1) throw new Error(`expected one ${prefix}-*.js, found ${found.length}`);
  return found[0];
}

function hashedName(prefix, content) {
  const hash = crypto.createHash('sha256').update(content).digest('base64url').slice(0, 8);
  return `${prefix}-${hash}.js`;
}

// Copied as they stood on desertbooker.com on 2026-09-29, ids included.
const HEAD_TAGS = `    <!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-5NJKECRKT6"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'G-5NJKECRKT6');
    </script>
    <!-- Google Tag Manager -->
    <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
    new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
    j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
    'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
    })(window,document,'script','dataLayer','GTM-546BHFXM');</script>
    <!-- End Google Tag Manager -->
    <!-- Microsoft Clarity -->
    <script type="text/javascript">
      (function(c,l,a,r,i,t,y){
          c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
          t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
          y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
      })(window, document, "clarity", "script", "xsjmlmrlzq");
    </script>
`;

const BODY_TAG = `    <!-- Google Tag Manager (noscript) -->
    <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-546BHFXM"
    height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
    <!-- End Google Tag Manager (noscript) -->
`;

function addTags(html, label) {
  if (html.includes('googletagmanager.com')) throw new Error(`already has tracking: ${label}`);
  // After the charset and viewport, which must stay first in the head.
  html = replaceOnce(
    html,
    '    <meta name="theme-color" content="#FF5A2C" />\n',
    '    <meta name="theme-color" content="#FF5A2C" />\n' + HEAD_TAGS,
    `${label} head`,
  );
  return replaceOnce(html, '  <body>\n', '  <body>\n' + BODY_TAG, `${label} body`);
}

// ---------------------------------------------------------------- legal bundle
const LEGAL_OLD = findBundle('LegalPage');
let legal = read(path.join(assets, LEGAL_OLD));

legal = replaceOnce(
  legal,
  '{kind:"p",text:"We use Google Analytics (GA4) to understand how users interact with our website. This may ' +
    'include data such as page views, device information, browser information, and interactions. Google Analytics ' +
    'may use cookies or similar technologies to collect this information."}',
  '{kind:"p",text:"We use Google Analytics (GA4), loaded through Google Tag Manager, to understand how users ' +
    'interact with our website. This may include data such as page views, device information, browser information, ' +
    'and interactions."},' +
    '{kind:"p",text:"We also use Microsoft Clarity, which records how visitors move, scroll and click on our pages, ' +
    'so that we can improve them."},' +
    '{kind:"p",text:"These tools may use cookies or similar technologies to collect this information."}',
  'analytics section',
);

legal = replaceOnce(
  legal,
  'items:["Tally (forms)","Google Analytics","Google Sheets (waitlist)"]',
  'items:["Tally (forms)","Google Analytics","Google Tag Manager","Microsoft Clarity","Google Sheets (waitlist)"]',
  'third-party list',
);

// ------------------------------------------------- rename what changed, rewire
const LEGAL_NEW = hashedName('LegalPage', legal);
const writes = [[path.join(assets, LEGAL_NEW), legal]];
const removals = [LEGAL_OLD];

const normalise = (text) => text.replace(/\r\n/g, '\n');

writes.push([path.join(root, 'index.html'), addTags(normalise(read(path.join(root, 'index.html'))), 'index.html')]);

for (const [prefix, page] of [['privacy', 'privacy-policy/index.html'], ['terms', 'terms-of-service/index.html']]) {
  const old = findBundle(prefix);
  let js = read(path.join(assets, old));
  js = replaceOnce(js, `"./${LEGAL_OLD}"`, `"./${LEGAL_NEW}"`, `${old} import`);
  const name = hashedName(prefix, js);
  writes.push([path.join(assets, name), js]);
  removals.push(old);

  let html = normalise(read(path.join(root, page)));
  html = replaceOnce(html, `../assets/${old}`, `../assets/${name}`, `${page} script`);
  html = replaceOnce(html, `../assets/${LEGAL_OLD}`, `../assets/${LEGAL_NEW}`, `${page} preload`);
  writes.push([path.join(root, page), addTags(html, page)]);
}

for (const [file, content] of writes) fs.writeFileSync(file, content);
for (const name of removals) fs.unlinkSync(path.join(assets, name));

console.log('written:');
for (const [file] of writes) console.log('  ' + path.relative(root, file));
console.log('removed:');
for (const name of removals) console.log('  assets/' + name);
