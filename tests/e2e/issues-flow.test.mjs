import test from 'node:test';
import assert from 'node:assert/strict';
import { el, fire, wait } from './helpers/dom-stub.mjs';
import { installFakeGithub } from './helpers/fake-github.mjs';

// The app is a module singleton, so these tests run in order against one loaded instance.
const fake = installFakeGithub();
await import('../../js/issues-app.js');

const commentsIn = () => ((el('previewArea').value || '').match(/Real comment/g) || []).length;
const logText = () => String(el('log').textContent || '');

test('load: manifest loads and the first 25 open issues are selected', async () => {
    el('repoUrl').value = 'o/r';
    await el('loadIssuesBtn').click();
    await wait(50);
    assert.match(logText(), /Loaded \d+ items/);
});

test('build with comment scope "none" fetches no comments', async () => {
    const before = fake.calls.length;
    el('commentScope').value = 'none';
    await el('buildContextBtn').click();
    await wait(100);
    assert.equal(fake.calls.length, before);
    assert.equal(commentsIn(), 0);
    assert.ok((el('previewArea').value || '').length > 1000);
});

test('switching scope to "all" fetches comments through the bulk endpoint', async () => {
    const before = fake.calls.length;
    el('commentScope').value = 'all';
    await fire('commentScope', 'change');
    await wait(300);
    const made = fake.calls.slice(before);
    assert.ok(commentsIn() > 0, 'comments must appear in the output');
    assert.ok(made.length <= 4, `expected the bulk path (<=4 requests), got ${made.length}`);
    assert.ok(made.every(c => c.includes('/issues/comments')), 'should use repo-wide endpoint');
    assert.match(logText(), /Comments: \d+ kept of \d+ fetched/);
});

test('rebuilding after an unrelated option change reuses the comment cache', async () => {
    const before = fake.calls.length;
    const kept = commentsIn();
    el('stripImages').checked = !el('stripImages').checked;
    await fire('stripImages', 'change');
    await wait(200);
    assert.equal(fake.calls.length, before);
    assert.equal(commentsIn(), kept);
});

test('maintainers scope keeps fewer comments than all', async () => {
    const all = commentsIn();
    el('commentScope').value = 'maintainers';
    await fire('commentScope', 'change');
    await wait(200);
    const m = commentsIn();
    assert.ok(m > 0 && m < all, `maintainers=${m} all=${all}`);
});

test('commentScopeBar click sets commentScope and triggers change', async () => {
    await fire('commentScopeBar', 'click', {
        target: {
            closest: () => ({ dataset: { scope: 'maintainers' } })
        }
    });
    assert.equal(el('commentScope').value, 'maintainers');
});

test('selection telemetry displays selectionSummary and hiddenSelectedNote', async () => {
    // 25 issues selected
    assert.match(el('selectionSummary').textContent, /25 selected · ~\d+ tokens \(estimated\)/);

    // Apply a search filter that matches none of the selected issues
    el('issueSearchInput').value = 'nonexistent_search_query_xyz';
    await fire('issueSearchInput', 'input');
    await wait(50);

    assert.equal(el('hiddenSelectedNote').textContent, '25 selected issue(s) are hidden by the current filters.');

    // Reset search
    el('issueSearchInput').value = '';
    await fire('issueSearchInput', 'input');
    await wait(50);
    assert.equal(el('hiddenSelectedNote').textContent, '');
});

test('targetBar sets format and chunkLimit preset values', async () => {
    await fire('targetBar', 'click', {
        target: {
            closest: () => ({ dataset: { target: 'chatgpt' } })
        }
    });
    assert.equal(el('format').value, 'markdown');
    assert.equal(el('chunkLimit').value, '128000');
});

test('exampleRepos chip click sets repoUrl and triggers issues load', async () => {
    const beforeCalls = fake.calls.length;
    await fire('exampleRepos', 'click', {
        target: {
            closest: () => ({ dataset: { repo: 'o/r' } })
        }
    });
    await wait(100);
    assert.equal(el('repoUrl').value, 'o/r');
    const madeCalls = fake.calls.slice(beforeCalls);
    assert.ok(madeCalls.some(c => c.includes('/issues')), 'fake GitHub received an /issues request');
});
