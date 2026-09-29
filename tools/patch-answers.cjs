// Patches the built bundles so the waitlist saves every answer.
//
//   node tools/patch-answers.cjs
//
// This repository holds build output, so the change is made as exact-string
// replacements in the minified code. Every replacement must match exactly once;
// otherwise the script stops before writing anything. It cannot be applied
// twice: the second run finds no anchors.
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

// /assets/ is served immutable for a year, so changed content needs a new name.
function hashedName(prefix, content) {
  const hash = crypto.createHash('sha256').update(content).digest('base64url').slice(0, 8);
  return `${prefix}-${hash}.js`;
}

// ---------------------------------------------------------------- about bundle
const ABOUT_OLD = findBundle('about');
let about = read(path.join(assets, ABOUT_OLD));

// 1. Copy for a failed save.
about = replaceOnce(
  about,
  'retry:"Something went wrong and we could not add you. Please try again in a moment."}',
  'retry:"Something went wrong and we could not add you. Please try again in a moment.",' +
    'saveFailed:"We could not save your answers. Please try again."}',
  'copy',
);

// 2. Shared state, page context and the save queue, around the request helper.
//    One session object serves both rendered instances of the component.
about = replaceOnce(
  about,
  'async function submitWaitlist(t){const r=new AbortController,a=setTimeout(()=>r.abort(),2e4);' +
    'try{const s=await fetch(waitlistEndpoint,{method:"POST",body:JSON.stringify(t),signal:r.signal}),' +
    'n=JSON.parse(await s.text());return n&&typeof n=="object"?n:{ok:!1,error:"server_error"}}' +
    'catch(s){return{ok:!1,error:"network"}}finally{clearTimeout(a)}}',
  'const waitlistSession={id:"",email:"",tryId:"",tryEmail:"",seq:0,savedSeq:0,saved:"",chain:Promise.resolve()},' +
    // Read once at load: the page later rewrites its own address with pushState.
    'waitlistContext=(()=>{const t={referrer:"",utm_source:"",utm_medium:"",utm_campaign:"",language:"",timezone:""};' +
    'try{const r=window.location,a=r.hash.indexOf("?"),s=new URLSearchParams(r.search),' +
    'n=new URLSearchParams(a===-1?"":r.hash.slice(a+1));' +
    'for(const l of["utm_source","utm_medium","utm_campaign"])t[l]=(s.get(l)||n.get(l)||"").slice(0,100);' +
    'const o=document.referrer;' +
    'o&&new URL(o).origin!==r.origin&&(t.referrer=o.slice(0,300)),' +
    't.language=(navigator.language||"").slice(0,35),' +
    't.timezone=(Intl.DateTimeFormat().resolvedOptions().timeZone||"").slice(0,64)}catch(r){}return t})();' +
    'function waitlistNewId(){try{if(typeof crypto.randomUUID=="function")return crypto.randomUUID()}catch(t){}' +
    'return"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,t=>{const r=Math.random()*16|0;' +
    'return(t==="x"?r:r&3|8).toString(16)})}' +
    'async function submitWaitlist(t,r){const a=new AbortController,s=setTimeout(()=>a.abort(),r&&r.timeout||2e4);' +
    'try{const n=await fetch(waitlistEndpoint,r&&r.keepalive?' +
    '{method:"POST",body:JSON.stringify(t),signal:a.signal,keepalive:!0}:' +
    '{method:"POST",body:JSON.stringify(t),signal:a.signal}),' +
    'o=JSON.parse(await n.text());return o&&typeof o=="object"?o:{ok:!1,error:"server_error"}}' +
    'catch(n){return{ok:!1,error:"network"}}finally{clearTimeout(s)}}' +
    'function waitlistSnapshot(t,r){return{id:waitlistSession.id,email:waitlistSession.email,audience:t,answers:r}}' +
    'function waitlistPost(t,r,a,s){return submitWaitlist({action:"answers",id:t.id,email:t.email,seq:a,' +
    'audience:t.audience,answers:t.answers},s).then(n=>(n.ok===!0&&n.stale!==!0&&t.id===waitlistSession.id&&' +
    'a>waitlistSession.savedSeq&&(waitlistSession.saved=r,waitlistSession.savedSeq=a),n))}' +
    // Saves go out one at a time. The counter is taken when the snapshot is
    // made, so a newer snapshot always carries the higher number. A save that
    // a newer one has overtaken while it waited is dropped: every snapshot is
    // complete, so only the newest matters. The last save (s) is always sent.
    'function waitlistSave(t,s){const r=JSON.stringify(t),a=++waitlistSession.seq;' +
    'return waitlistSession.chain=waitlistSession.chain.then(()=>' +
    '!t.id||t.id!==waitlistSession.id||r===waitlistSession.saved||a<waitlistSession.savedSeq||' +
    '!s&&a<waitlistSession.seq?{ok:!0}:' +
    'waitlistPost(t,r,a)),waitlistSession.chain}' +
    'function waitlistFlush(t){const r=JSON.stringify(t);' +
    '!t.id||r===waitlistSession.saved||waitlistPost(t,r,++waitlistSession.seq,{keepalive:!0})}',
  'request helpers',
);

// 3. Save when the question changes, and once more when the page is hidden.
about = replaceOnce(
  about,
  'consentRef=x.useRef(null);',
  'consentRef=x.useRef(null),snapRef=x.useRef(null);snapRef.current=snapshotAnswers;' +
    'x.useEffect(()=>{i==="questions"&&waitlistSave(snapRef.current())},[c,i]);' +
    'x.useEffect(()=>{if(i!=="questions")return;' +
    'const d=()=>{document.visibilityState==="hidden"&&waitlistFlush(snapRef.current())};' +
    'return document.addEventListener("visibilitychange",d),' +
    '()=>document.removeEventListener("visibilitychange",d)},[i]);',
  'save effects',
);

// 4. The snapshot holds only the questions on the current path, and the done
//    screen waits for the last save.
about = replaceOnce(
  about,
  'function he(){h("done")}',
  'function snapshotAnswers(){const d=(m[Ce.key]||[])[0]??null,k={};' +
    'for(const R of Oe(s,d)){const D=(C[R.key]||"").trim();' +
    'if(R.options===null){D&&(k[R.key]=D);continue}' +
    'const W=(m[R.key]||[]).filter(K=>R.options.includes(K));' +
    'W.length&&(k[R.key]=R.multi?W:W[0]),W.includes(le)&&D&&(k[R.key+"_other"]=D)}' +
    'return waitlistSnapshot(s==="operator"?"operator":"traveler",k)}' +
    // Only a failure that a retry can fix holds the person back. Any other
    // reply (a missing row, or an older script that does not know "answers")
    // lets them through: their email is already on the list.
    'async function he(){if(sending)return;setSending(!0),setNotice(null);' +
    'const d=await waitlistSave(snapshotAnswers(),!0);setSending(!1),' +
    'd.ok!==!0&&["network","server_error","busy"].includes(d.error)?' +
    'setNotice({tone:"error",text:waitlistCopy.saveFailed}):h("done")}',
  'snapshot and final save',
);

// 5. Nothing moves while the last save is in flight.
about = replaceOnce(about, 'function Y(){var R;', 'function Y(){var R;if(sending)return;', 'Y guard');
about = replaceOnce(
  about,
  'function $e(){c===0?h("email"):p(c-1)}',
  'function $e(){sending||(setNotice(null),c===0?h("email"):p(c-1))}',
  'Back guard',
);
about = replaceOnce(about, 'function se(d,k){E(', 'function se(d,k){sending||E(', 'text guard');
about = replaceOnce(about, 'function ne(d,k){var D;', 'function ne(d,k){var D;if(sending)return;', 'choice guard');
about = replaceOnce(about, 'function Se(d,k){const R=', 'function Se(d,k){if(sending)return;const R=', 'toggle guard');

// 6. The email step: a join that can be repeated safely, with the page context.
about = replaceOnce(
  about,
  'const k=d.currentTarget.elements.namedItem("website");setSending(!0),setNotice(null);' +
    'const R=await submitWaitlist({email:o.trim(),consent:!0,audience:s==="operator"?"operator":"traveler",' +
    'page:window.location.pathname,website:k?k.value:""});setSending(!1);' +
    'if(R.ok===!0){R.duplicate===!0?setNotice({tone:"info",text:waitlistCopy.duplicate}):h("questions");return}',
  'const k=d.currentTarget.elements.namedItem("website"),W=o.trim(),D=W.toLowerCase(),' +
    'K=s==="operator"?"operator":"traveler";' +
    // Back from the first question, then the same email: already joined.
    'if(waitlistSession.id&&waitlistSession.email===D){setNotice(null),h("questions");return}' +
    // A retry for the same email keeps its id, so a lost reply is not a duplicate.
    'waitlistSession.tryEmail!==D&&(waitlistSession.tryEmail=D,waitlistSession.tryId=waitlistNewId());' +
    'setSending(!0),setNotice(null);' +
    'const R=await submitWaitlist({action:"join",id:waitlistSession.tryId,email:W,consent:!0,audience:K,' +
    'page:window.location.pathname,website:k?k.value:"",device:r?"mobile":"desktop",...waitlistContext});' +
    'setSending(!1);' +
    'if(R.ok===!0){if(R.duplicate===!0){setNotice({tone:"info",text:waitlistCopy.duplicate});return}' +
    'waitlistSession.id=typeof R.id=="string"&&R.id?R.id:waitlistSession.tryId,waitlistSession.email=D,' +
    'waitlistSession.savedSeq=waitlistSession.seq,' +
    'waitlistSession.saved=JSON.stringify(waitlistSnapshot(K,{})),h("questions");return}',
  'email submit',
);

// 7. Loading on the final button, and the message line under it.
about = replaceOnce(
  about,
  'onClick:Y,children:ce})}):null,',
  'onClick:Y,loading:sending,children:ce})}):null,' +
    'notice?e.jsx("p",{role:"alert",className:(r?"mt-3 text-meta":"order-6 mt-3 text-sm")+" text-error-600",' +
    'children:notice.text}):null,',
  'final button',
);

// 8. Back and Skip wait too. Skip carries the spinner where there is no button.
about = replaceOnce(
  about,
  'onClick:$e,iconLeft:e.jsx(Ga,{}),children:z.back})',
  'onClick:$e,disabled:sending,iconLeft:e.jsx(Ga,{}),children:z.back})',
  'Back link',
);
about = replaceOnce(
  about,
  'onClick:()=>c===0&&s==="traveller"?he():Y(),children:z.skip})',
  'onClick:()=>c===0&&s==="traveller"?he():Y(),disabled:sending,loading:sending&&!Le,children:z.skip})',
  'Skip link',
);

// ---------------------------------------------------------------- legal bundle
const LEGAL_OLD = findBundle('LegalPage');
let legal = read(path.join(assets, LEGAL_OLD));

legal = replaceOnce(
  legal,
  '{kind:"p",text:"When you join our waitlist, we collect your email address and whether you are joining as a ' +
    'traveller or as a camp or operator. We use this only to send you updates about our launch."},',
  '{kind:"p",text:"When you join our waitlist, we collect:"},' +
    '{kind:"list",items:[' +
    '"Your email address, and whether you are joining as a traveller or as a camp or operator",' +
    '"Your answers to the questions that follow, including the name of your camp if you are an operator",' +
    '"Whether you used the mobile or the desktop version of the page",' +
    '"The website or campaign link that brought you to us",' +
    '"The language and time zone set in your browser"]},' +
    '{kind:"p",text:"We use your email and answers to send you updates about our launch that fit what you told us. ' +
    'We use the other details to understand how visitors find us."},',
  'waitlist section',
);

// ------------------------------------------------- rename what changed, rewire
const ABOUT_NEW = hashedName('about', about);
const LEGAL_NEW = hashedName('LegalPage', legal);

const writes = [
  [path.join(assets, ABOUT_NEW), about],
  [path.join(assets, LEGAL_NEW), legal],
];
const removals = [ABOUT_OLD, LEGAL_OLD];

let indexHtml = read(path.join(root, 'index.html'));
indexHtml = replaceOnce(indexHtml, `./assets/${ABOUT_OLD}`, `./assets/${ABOUT_NEW}`, 'index.html script');
writes.push([path.join(root, 'index.html'), indexHtml]);

for (const [prefix, page] of [['privacy', 'privacy-policy/index.html'], ['terms', 'terms-of-service/index.html']]) {
  const old = findBundle(prefix);
  let js = read(path.join(assets, old));
  js = replaceOnce(js, `"./${LEGAL_OLD}"`, `"./${LEGAL_NEW}"`, `${old} import`);
  const name = hashedName(prefix, js);
  writes.push([path.join(assets, name), js]);
  removals.push(old);

  let html = read(path.join(root, page));
  html = replaceOnce(html, `../assets/${old}`, `../assets/${name}`, `${page} script`);
  html = replaceOnce(html, `../assets/${LEGAL_OLD}`, `../assets/${LEGAL_NEW}`, `${page} preload`);
  writes.push([path.join(root, page), html]);
}

for (const [file, content] of writes) fs.writeFileSync(file, content);
for (const name of removals) fs.unlinkSync(path.join(assets, name));

console.log('written:');
for (const [file] of writes) console.log('  ' + path.relative(root, file));
console.log('removed:');
for (const name of removals) console.log('  assets/' + name);
