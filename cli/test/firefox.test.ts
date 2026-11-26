// Ported from an earlier prototype (27 tests), plus tests for the push command.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHROME_LOCALES } from '../src/locales.ts';
import {
  addonUrl,
  amoDefaultLocale,
  AMO_LIMITS,
  AMO_PROD_LOCALES,
  buildPatchBody,
  codePointLength,
  mapChromeLocale,
  resolveLocaleArg,
  signAmoJwt,
} from '../src/stores/firefox.ts';
import { main } from '../src/cli.ts';
import { copyFixture } from './helpers.ts';

const amo = (code: string) => {
  const m = mapChromeLocale(code);
  return m.ok ? m.amo : null;
};

test('list sizes match the sources', () => {
  assert.equal(CHROME_LOCALES.length, 55);
  assert.equal(AMO_PROD_LOCALES.length, 44);
});

test('direct mappings: underscore becomes dash, AMO case kept', () => {
  assert.deepEqual(amo('pt_BR'), ['pt-BR']);
  assert.deepEqual(amo('pt_PT'), ['pt-PT']);
  assert.deepEqual(amo('zh_CN'), ['zh-CN']);
  assert.deepEqual(amo('zh_TW'), ['zh-TW']);
  assert.deepEqual(amo('en_GB'), ['en-GB']);
  assert.deepEqual(amo('en_US'), ['en-US']);
  assert.deepEqual(amo('he'), ['he']);
  assert.deepEqual(amo('de'), ['de']);
});

test('aliases', () => {
  assert.deepEqual(amo('en'), ['en-US']);
  assert.deepEqual(amo('es'), ['es-ES']);
  assert.deepEqual(amo('sv'), ['sv-SE']);
  assert.deepEqual(amo('no'), ['nb-NO']);
});

test('es_419 fans out to all Latin American Spanish locales', () => {
  const m = mapChromeLocale('es_419');
  assert.ok(m.ok);
  assert.deepEqual(m.amo, ['es-AR', 'es-CL', 'es-MX']);
  assert.equal(m.rule, 'fan-out');
});

test('partial fan-out keeps only accepted targets', () => {
  assert.deepEqual(mapChromeLocale('es_419', ['es-MX', 'en-US']).ok && mapChromeLocale('es_419', ['es-MX']), {
    ok: true, chrome: 'es_419', amo: ['es-MX'], rule: 'fan-out', source: 'our choice', priority: 1,
  });
});

test('unsupported Chrome locales are skipped, not folded', () => {
  for (const code of ['fil', 'en_AU', 'ar', 'bg', 'id', 'th', 'hi']) {
    const m = mapChromeLocale(code);
    assert.equal(m.ok, false, code);
  }
  const fil = mapChromeLocale('fil');
  assert.ok(!fil.ok && fil.reason.includes('tl'));
});

test('a custom supported list enables more locales', () => {
  assert.deepEqual(mapChromeLocale('ar', [...AMO_PROD_LOCALES, 'ar']).ok, true);
});

test('every Chrome locale either maps into the AMO list or gives a reason', () => {
  let mapped = 0;
  for (const code of CHROME_LOCALES) {
    const m = mapChromeLocale(code);
    if (m.ok) {
      mapped++;
      for (const l of m.amo) assert.ok(AMO_PROD_LOCALES.includes(l), `${code} -> ${l}`);
    } else {
      assert.ok(m.reason.length > 0);
    }
  }
  assert.equal(mapped, 33);
});

test('resolveLocaleArg accepts AMO or Chrome codes', () => {
  assert.deepEqual(resolveLocaleArg('pt-BR'), ['pt-BR']);
  assert.deepEqual(resolveLocaleArg('pt_br'), ['pt-BR']);
  assert.deepEqual(resolveLocaleArg('es_419'), ['es-AR', 'es-CL', 'es-MX']);
  assert.deepEqual(resolveLocaleArg('ar'), []);
});

test('builds per-locale objects for each field', () => {
  const r = buildPatchBody({
    en: { name: 'Tab Tidy', summary: 'Tidy tabs', description: 'Long text' },
    pt_BR: { name: 'Tab Tidy', summary: 'Organize abas' },
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.body, {
    name: { 'en-US': 'Tab Tidy', 'pt-BR': 'Tab Tidy' },
    summary: { 'en-US': 'Tidy tabs', 'pt-BR': 'Organize abas' },
    description: { 'en-US': 'Long text' },
  });
  assert.ok(r.warnings.some((w) => w.includes('content review')));
});

test('missing field is omitted, not nulled', () => {
  const r = buildPatchBody({ de: { description: 'Text' } });
  assert.deepEqual(r.body, { description: { de: 'Text' } });
  assert.ok(!r.warnings.some((w) => w.includes('content review')));
});

test('es_419 fan-out copies the values to es-AR, es-CL, es-MX', () => {
  const r = buildPatchBody({ es_419: { name: 'Hola' } });
  assert.deepEqual(r.body.name, { 'es-AR': 'Hola', 'es-CL': 'Hola', 'es-MX': 'Hola' });
});

test('more specific file wins: en_US beats en', () => {
  const r = buildPatchBody({ en: { name: 'Generic' }, en_US: { name: 'Specific' } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.body.name, { 'en-US': 'Specific' });
  assert.equal(r.sources['en-US'], 'en_US');
});

test('equal priority collision is an error', () => {
  // pt_BR and pt-BR are both direct mappings to pt-BR
  const r = buildPatchBody({ pt_BR: { name: 'A' }, 'pt-BR': { name: 'B' } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /both map to pt-BR/);
});

test('direct code beats alias: nb_NO beats no', () => {
  const r = buildPatchBody({ no: { name: 'A' }, nb_NO: { name: 'B' } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.body.name, { 'nb-NO': 'B' });
});

test('unsupported locales produce a warning and are left out', () => {
  const r = buildPatchBody({ en: { name: 'A' }, ar: { name: 'B' }, fil: { name: 'C' } });
  assert.deepEqual(Object.keys(r.body.name!), ['en-US']);
  assert.ok(r.warnings.some((w) => w.startsWith('skip ar')));
  assert.ok(r.warnings.some((w) => w.startsWith('skip fil')));
});

test('length limits use code points', () => {
  const emoji = '😀'.repeat(50); // 50 code points, 100 UTF-16 units
  assert.equal(codePointLength(emoji), 50);
  assert.deepEqual(buildPatchBody({ en: { name: emoji } }).errors, []);
  const tooLong = buildPatchBody({ en: { name: 'x'.repeat(AMO_LIMITS.name + 1) } });
  assert.match(tooLong.errors[0]!, /51 characters, limit is 50/);
  assert.equal(buildPatchBody({ en: { summary: 'x'.repeat(251) } }).errors.length, 1);
  assert.equal(buildPatchBody({ en: { description: 'x'.repeat(15001) } }).errors.length, 1);
});

test('fan-out reports a bad value once, not once per target', () => {
  const r = buildPatchBody({ es_419: { name: 'x'.repeat(60) } });
  assert.deepEqual(r.errors, ['es_419.name: 60 characters, limit is 50']);
});

test('the losing less specific file gets a warning', () => {
  const r = buildPatchBody({ en: { name: 'Generic' }, en_US: { name: 'Specific' } });
  assert.ok(r.warnings.includes('en-US: using en_US, not the less specific en'));
});

test('empty strings are errors', () => {
  const r = buildPatchBody({ en: { name: '  ', summary: 'ok' } });
  assert.deepEqual(r.errors, ['en.name: empty; remove the key to leave it unchanged']);
});

test('remove sends null for all fields of that locale', () => {
  const r = buildPatchBody({ en: { name: 'A' } }, { remove: ['de', 'pt_BR'] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.body.name, { 'en-US': 'A', de: null, 'pt-BR': null });
  assert.deepEqual(r.body.summary, { de: null, 'pt-BR': null });
  assert.deepEqual(r.body.description, { de: null, 'pt-BR': null });
});

test('remove refuses the default locale, unknown locales, and locales with a file', () => {
  assert.match(buildPatchBody({}, { remove: ['en-US'] }).errors[0]!, /default locale/);
  assert.match(buildPatchBody({ de: { name: 'A' } }, { remove: ['de'], defaultLocale: 'de' }).errors[0]!, /default locale/);
  assert.match(buildPatchBody({}, { remove: ['ar'] }).errors[0]!, /not a locale AMO accepts/);
  assert.match(buildPatchBody({ de: { name: 'A' } }, { remove: ['de'] }).errors[0]!, /also has a listing file/);
});

test('empty input is an error', () => {
  assert.deepEqual(buildPatchBody({}).errors, ['nothing to send']);
});

test('addon id is URL-encoded', () => {
  assert.equal(
    addonUrl('https://addons.mozilla.org/', '{abc-123}'),
    'https://addons.mozilla.org/api/v5/addons/addon/%7Babc-123%7D/',
  );
  assert.equal(addonUrl('https://addons.mozilla.org', 'tab@tidy'), 'https://addons.mozilla.org/api/v5/addons/addon/tab%40tidy/');
});

test('sample listings with es_419 build a valid body', () => {
  const r = buildPatchBody({
    en: { name: 'Tab Tidy', summary: 'Group tabs.', description: 'Long.' },
    es_419: { name: 'Tab Tidy', summary: 'Agrupa pestañas.', description: 'Largo.' },
    pt_BR: { name: 'Tab Tidy', summary: 'Agrupe abas.', description: 'Longo.' },
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Object.keys(r.body.name!), ['en-US', 'es-AR', 'es-CL', 'es-MX', 'pt-BR']);
});

test('JWT: HS256, claims, signature, exp <= 5 minutes', () => {
  const token = signAmoJwt('user:12345:67', 'fake-secret', { now: 1_700_000_000_000, jti: 'n1', ttlSeconds: 999 });
  const [h, p, s] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h!, 'base64url').toString()), { alg: 'HS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
  assert.deepEqual(claims, { iss: 'user:12345:67', jti: 'n1', iat: 1_700_000_000, exp: 1_700_000_300 });
  const expected = createHmac('sha256', 'fake-secret').update(`${h}.${p}`).digest('base64url');
  assert.equal(s, expected);
});

test('JWT: default ttl is 60s and jti is unique', () => {
  const a = JSON.parse(Buffer.from(signAmoJwt('i', 's').split('.')[1]!, 'base64url').toString());
  const b = JSON.parse(Buffer.from(signAmoJwt('i', 's').split('.')[1]!, 'base64url').toString());
  assert.equal(a.exp - a.iat, 60);
  assert.notEqual(a.jti, b.jti);
});

// ---- push firefox command ----

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
});

function captureFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: 1 }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const log = console.log;
  const err = console.error;
  let out = '';
  console.log = (...a: unknown[]) => { out += a.join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { out += a.join(' ') + '\n'; };
  try {
    return { result: await fn(), out };
  } finally {
    console.log = log;
    console.error = err;
  }
}

test('amoDefaultLocale maps the Chrome default_locale', () => {
  assert.equal(amoDefaultLocale('en'), 'en-US');
  assert.equal(amoDefaultLocale('pt_BR'), 'pt-BR');
  assert.equal(amoDefaultLocale('ar'), null);
});

test('push firefox: dry run is the default and never calls the network', async () => {
  const dir = copyFixture();
  writeFileSync(join(dir, 'listing/de.json'), JSON.stringify({ name: 'TabNest', summary: 'Tabs speichern.', description: 'Text.' }));
  writeFileSync(join(dir, 'listing/ar.json'), JSON.stringify({ name: 'TabNest', summary: 'x', description: 'y' }));
  process.env.AMO_JWT_ISSUER = 'user:1:2';
  process.env.AMO_JWT_SECRET = 'fake';
  const calls = captureFetch();
  const { result, out } = await quiet(() => main(['push', 'firefox', '--dir', dir]));
  assert.equal(result, 0);
  assert.equal(calls.length, 0);
  assert.match(out, /PATCH https:\/\/addons\.mozilla\.org\/api\/v5\/addons\/addon\/tabnest\//);
  assert.match(out, /"de": "Tabs speichern\."/);
  assert.match(out, /Cannot be sent to AMO \(1\):\n  ar: AMO does not accept "ar"/);
  assert.match(out, /Dry run: nothing sent/);
  assert.ok(!out.includes('fake'), 'the secret is never printed');
});

test('push firefox: --send without the env vars does not send', async () => {
  const dir = copyFixture();
  delete process.env.AMO_JWT_ISSUER;
  delete process.env.AMO_JWT_SECRET;
  const calls = captureFetch();
  const { result, out } = await quiet(() => main(['push', 'firefox', '--dir', dir, '--send']));
  assert.equal(result, 2);
  assert.equal(calls.length, 0);
  assert.match(out, /needs AMO_JWT_ISSUER and AMO_JWT_SECRET/);
});

test('push firefox: errors stop the send', async () => {
  const dir = copyFixture();
  writeFileSync(join(dir, 'listing/de.json'), JSON.stringify({ name: 'x'.repeat(51), summary: 's', description: 'd' }));
  process.env.AMO_JWT_ISSUER = 'user:1:2';
  process.env.AMO_JWT_SECRET = 'fake';
  const calls = captureFetch();
  const { result, out } = await quiet(() => main(['push', 'firefox', '--dir', dir, '--send']));
  assert.equal(result, 1);
  assert.equal(calls.length, 0);
  assert.match(out, /de\.name: 51 characters, limit is 50/);
});

test('push firefox: --send with both env vars sends one PATCH with a JWT', async () => {
  const dir = copyFixture();
  process.env.AMO_JWT_ISSUER = 'user:1:2';
  process.env.AMO_JWT_SECRET = 'fake-secret';
  const calls = captureFetch();
  const { result } = await quiet(() => main(['push', 'firefox', '--dir', dir, '--send', '--addon', '{guid@x}']));
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://addons.mozilla.org/api/v5/addons/addon/%7Bguid%40x%7D/');
  assert.equal(calls[0]!.init?.method, 'PATCH');
  const auth = (calls[0]!.init?.headers as Record<string, string>).Authorization!;
  assert.match(auth, /^JWT [\w-]+\.[\w-]+\.[\w-]+$/);
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.name['en-US'], 'TabNest – Tab Manager & Session Saver');
  assert.ok(body.description['en-US'].includes('\n- Save all open tabs'));
});

test('push firefox: --addon is required without config', async () => {
  const dir = copyFixture();
  writeFileSync(join(dir, '.localizer/config.json'), '{}');
  const { result, out } = await quiet(() => main(['push', 'firefox', '--dir', dir]));
  assert.equal(result, 2);
  assert.match(out, /--addon/);
});
