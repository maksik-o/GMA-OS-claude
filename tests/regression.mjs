// Run with: node tests/regression.mjs
import { readFile } from 'node:fs/promises';
const source = {};
for (const p of ['js/db.js','js/notes.js','js/contacts.js','js/finance.js','js/kb.js','sw.js']) source[p] = await readFile(new URL('../' + p, import.meta.url), 'utf8');
console.log('Passed:', await run(source), 'regression assertions');
export async function run(source) {
  let passed = 0;
  const assert = (ok, message) => { if (!ok) throw new Error(message); passed++; };
  const extract = (s, name) => {
    const start = s.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('Missing function ' + name);
    return s.slice(start, s.indexOf('\n}', start) + 2);
  };
  const req = new Function(extract(source['js/db.js'], 'req') + '; return req;')();
  const r = { transaction: {}, result: 42 };
  let resolved = false;
  const pending = req(Promise.resolve(r)).then(v => { resolved = true; return v; });
  await Promise.resolve();
  if (r.onsuccess) r.onsuccess();
  await Promise.resolve();
  assert(!resolved, 'Request success must not resolve before commit');
  r.transaction.oncomplete();
  assert(await pending === 42, 'Commit returns request result');
  const bad = { transaction: {}, result: 99 };
  const aborted = req(Promise.resolve(bad)).then(() => false, () => true);
  await Promise.resolve();
  if (bad.onsuccess) bad.onsuccess();
  bad.transaction.onabort();
  assert(await aborted, 'Abort after request success must reject');
  for (const [p, name, field] of [
    ['js/notes.js','applyNotesMerged','notes'],
    ['js/contacts.js','applyContactsMerged','people'],
    ['js/finance.js','applyFinanceMerged','items'],
    ['js/kb.js','applyKbMerged','items']
  ]) {
    const state = { [field]: [] };
    let notified = false;
    const fn = new Function('state','dbBulk','STORE','notify','contactTombstones','dedupeCategories','userChange',
      'return async ' + extract(source[p], name))(
      state, async () => { throw new Error('Simulated disk failure'); }, field,
      () => { notified = true; }, [], async () => false, () => {});
    const failed = await fn([{id:'remote', day:'2026-11-17',weekStart:'2026-11-16', updatedAt:'2026-11-17'}]).then(() => false, () => true);
    assert(failed && !notified, p + ' must report storage failure');
  }
  const handlers = {};
  const puts = [];
  let fetches = 0, globalLookups = 0;
  const cache = { match: async () => undefined, put: async req => { puts.push(req.url); } };
  const fakeCaches = { open: async () => cache, match: async () => { globalLookups++; } };
  new Function('self','caches','location','navigator','fetch','URL','Response',source['sw.js'])(
    { registration: { scope:'https://example.com/app/' }, addEventListener:(n,f) => {handlers[n]=f;} },
    fakeCaches, {origin:'https://example.com'}, {onLine:true},
    async () => { fetches++; return {ok:true,status:200,type:'basic',clone(){return this;}}; },
    URL, {error:() => ({error:true})});
  let response, lifetime;
  handlers.fetch({request:{url:'https://example.com/app/js/app.js',method:'GET',headers:{has:()=>false}},
    respondWith:p => {response=p;},waitUntil:p => {lifetime=p;}});
  await response; await lifetime;
  assert(fetches === 1, 'Cache miss must make one network request');
  assert(globalLookups === 0 && puts.length === 1, 'Use current cache and finish cache write');
  return passed;
}
