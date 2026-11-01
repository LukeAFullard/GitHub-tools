process.env.DOM_STUB_PAGE = 'deps.html';
const { el, wait, fire } = await import('./helpers/dom-stub.mjs');
const test = (await import('node:test')).default;
const assert = (await import('node:assert/strict')).default;

// Fake GitHub repo with two manifests (one in an examples folder) and a fake deps.dev.
const files = {
    'package.json': JSON.stringify({ name: 'demo', dependencies: { express: '4.18.2' }, devDependencies: { jest: '29.7.0' } }),
    'requirements.txt': 'PyQt5==5.15.10\n',
    'examples/x/package.json': JSON.stringify({ dependencies: { leftpad: '1.0.0' } })
};
const licenses = { 'npm/express/4.18.2': ['MIT'], 'npm/gpl-lib/2.0.0': ['GPL-3.0-only'], 'pypi/pyqt5/5.15.10': ['GPL-3.0'], 'npm/jest/29.7.0': ['MIT'] };
const calls = [];
globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'raw.githubusercontent.com') {
        const path = decodeURIComponent(u.pathname.split('/').slice(4).join('/'));
        return files[path] !== undefined ? new Response(files[path], { status: 200 }) : new Response('404', { status: 404 });
    }
    if (u.hostname === 'api.deps.dev') {
        const p = decodeURIComponent(u.pathname.replace('/v3/systems/', ''));
        let m = /^(\w+)\/packages\/(.+)\/versions\/([^:]+):dependencies$/.exec(p);
        if (m) return m[2] === 'express' ? json({ nodes: [{ versionKey: { name: 'express', version: '4.18.2' }, relation: 'SELF' }, { versionKey: { name: 'gpl-lib', version: '2.0.0' }, relation: 'DIRECT' }] }) : json({}, 404);
        m = /^(\w+)\/packages\/(.+)\/versions\/(.+)$/.exec(p);
        if (m) { const l = licenses[`${m[1]}/${m[2]}/${m[3]}`]; return l ? json({ licenses: l, advisoryKeys: m[2] === 'express' ? [{ id: 'GHSA-x' }] : [] }) : json({}, 404); }
        return json({}, 404);
    }
    if (u.pathname === '/repos/o/r') return json({ default_branch: 'main', private: false, license: { spdx_id: 'Apache-2.0', name: 'Apache' } });
    if (u.pathname.startsWith('/repos/o/r/git/trees/')) return json({ tree: Object.keys(files).map(path => ({ path, type: 'blob' })) });
    return json({ message: 'Not Found' }, 404);
};

const app = await import('../../js/deps-app.js');
const out = () => el('previewArea').value || '';

test('loads a GitHub repo, reads manifests (skipping examples) and checks licenses', async () => {
    el('repoUrl').value = 'o/r';
    await el('loadDepsBtn').click();
    await wait(150);
    assert.equal(el('statPackages').textContent, '3', 'express, gpl-lib (transitive) and pyqt5; jest is dev');
    assert.equal(el('repoLicenseText').textContent, 'Apache-2.0');
    assert.ok(!calls.some(c => c.includes('examples/')), 'example folders are skipped');
    assert.match(out(), /<repository_license>Apache-2\.0 \(Permissive\)<\/repository_license>/);
    assert.match(out(), /name="gpl-lib"[^>]*relation="transitive"[^>]*via="express"/);
    assert.match(out(), /name="pyqt5"[^>]*license="GPL-3\.0"/);
    assert.equal(el('copyBtn').disabled, false);
    assert.equal(el('copyBtn').textContent, 'Copy for Claude');
});

test('filters narrow the packed output', async () => {
    el('ecosystemFilter').value = 'pypi';
    await fire('ecosystemFilter', 'change');
    await wait(50);
    assert.match(out(), /<package_count>1<\/package_count>/);
    assert.match(el('outputScopeNote').textContent, /the 1 package shown \(filters are on\)/);
    el('ecosystemFilter').value = '';
    await fire('ecosystemFilter', 'change');
    await wait(50);
});

test('including dev dependencies re-runs the lookup', async () => {
    el('includeDev').checked = true;
    await fire('includeDev', 'change');
    await wait(150);
    assert.equal(el('statPackages').textContent, '4');
    assert.match(out(), /^npm:jest@29\.7\.0 \(MIT\) \[dev\]$/m, 'permissive packages are listed briefly, dev marked');
});

test('target bar switches the format', async () => {
    await fire('targetBar', 'click', { target: { closest: () => ({ dataset: { target: 'chatgpt' } }) } });
    await wait(50);
    assert.match(out(), /^# Dependency License Report: o\/r$/m);
    assert.equal(el('copyBtn').textContent, 'Copy for ChatGPT');
    assert.ok(typeof app.applyTarget === 'function');
});
