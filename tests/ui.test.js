import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBannerItems, renderBanner } from '../js/ui-banner.js';
import { copyLabel } from '../js/ui-labels.js';
import { detectTarget, TARGETS } from '../js/targets.js';
import { buildSettingsSummary } from '../js/settings-summary.js';
import { commentCostHint } from '../js/comment-cost.js';

test('targets: detectTarget identifies known targets and falls back to custom', () => {
    // 3 matches
    assert.equal(detectTarget('claude-xml', 200000), 'claude');
    assert.equal(detectTarget('markdown', 128000), 'chatgpt');
    assert.equal(detectTarget('markdown', 1000000), 'gemini');

    // Mismatches return 'custom'
    assert.equal(detectTarget('json', 200000), 'custom');
    assert.equal(detectTarget('claude-xml', 100000), 'custom');
    assert.equal(detectTarget('markdown', 500000), 'custom');
    assert.equal(detectTarget('unknown', 0), 'custom');
});

test('settings-summary: buildSettingsSummary handles target, minify, redact and chunk limits', () => {
    // Case 1: All features enabled, split chunk limit
    const case1 = buildSettingsSummary({
        targetLabel: 'Claude',
        minifyMode: 'basic',
        redactLevel: 'standard',
        chunkLimit: 200000
    });
    assert.equal(case1, 'Claude · blank lines removed · secrets hidden · split at 200k');

    // Case 2: Aggressive minify and strict secrets, split at 128k
    const case2 = buildSettingsSummary({
        targetLabel: 'ChatGPT',
        minifyMode: 'aggressive',
        redactLevel: 'strict',
        chunkLimit: 128000
    });
    assert.equal(case2, 'ChatGPT · comments removed · strict secret hiding · split at 128k');

    // Case 3: chunkLimit is 0 (no split note), secrets off, minifyMode none
    const case3 = buildSettingsSummary({
        targetLabel: 'Gemini',
        minifyMode: 'none',
        redactLevel: 'off',
        chunkLimit: 0
    });
    assert.equal(case3, 'Gemini · secrets NOT hidden');

    // Case 4: Issues page format (no minifyMode), custom target, chunkLimit 50k
    const case4 = buildSettingsSummary({
        targetLabel: 'Custom',
        minifyMode: 'none',
        redactLevel: 'standard',
        chunkLimit: 50000
    });
    assert.equal(case4, 'Custom · secrets hidden · split at 50k');
});

test('ui: buildBannerItems returns empty array when no warnings or errors apply', () => {
    const items = buildBannerItems({});
    assert.deepEqual(items, []);

    const items2 = buildBannerItems({
        failedThreads: 0,
        rateLimited: false,
        truncatedTree: false,
        skippedLarge: 0,
        redactionOff: false,
        secretCount: 0
    });
    assert.deepEqual(items2, []);
});

test('ui: buildBannerItems handles failedThreads with rate limiting', () => {
    const withReset = buildBannerItems({
        failedThreads: 4,
        rateLimited: true,
        resetTime: '12:34 PM'
    });
    assert.deepEqual(withReset, [{
        level: 'error',
        text: "GitHub's request limit was reached. Comments for 4 issue(s) weren't loaded. Add a token or retry after 12:34 PM."
    }]);

    const withoutReset = buildBannerItems({
        failedThreads: 2,
        rateLimited: true
    });
    assert.deepEqual(withoutReset, [{
        level: 'error',
        text: "GitHub's request limit was reached. Comments for 2 issue(s) weren't loaded. Add a token or retry."
    }]);
});

test('ui: buildBannerItems handles failedThreads without rate limiting', () => {
    const items = buildBannerItems({
        failedThreads: 3,
        rateLimited: false
    });
    assert.deepEqual(items, [{
        level: 'error',
        text: "Comments could not be loaded for 3 issue(s). See Details, then retry."
    }]);
});

test('ui: buildBannerItems handles truncatedTree', () => {
    const items = buildBannerItems({
        truncatedTree: true
    });
    assert.deepEqual(items, [{
        level: 'warn',
        text: 'This repository is very large, so GitHub returned a partial file list.'
    }]);
});

test('ui: buildBannerItems handles skippedLarge', () => {
    const items = buildBannerItems({
        skippedLarge: 5
    });
    assert.deepEqual(items, [{
        level: 'warn',
        text: '5 large file(s) were skipped. Raise "Max file size (KB)" to include them.'
    }]);
});

test('ui: buildBannerItems handles redactionOff with secretCount > 0', () => {
    const items = buildBannerItems({
        redactionOff: true,
        secretCount: 7
    });
    assert.deepEqual(items, [{
        level: 'warn',
        text: 'Secret hiding is off and 7 possible secret(s) were found.'
    }]);

    const itemsIgnored = buildBannerItems({
        redactionOff: false,
        secretCount: 7
    });
    assert.deepEqual(itemsIgnored, []);
});

test('ui: renderBanner creates correct DOM elements and hides when empty', () => {
    const createdElements = [];
    const mockEl = {
        _innerHTML: '',
        style: { display: '' },
        children: [],
        get innerHTML() { return this._innerHTML; },
        set innerHTML(v) { this._innerHTML = v; if (v === '') this.children = []; },
        appendChild(child) {
            this.children.push(child);
            return child;
        }
    };

    const originalDoc = globalThis.document;
    globalThis.document = {
        createElement(tag) {
            const el = { tagName: tag, className: '', textContent: '' };
            createdElements.push(el);
            return el;
        }
    };

    try {
        // Empty items hides element
        renderBanner(mockEl, []);
        assert.equal(mockEl.style.display, 'none');
        assert.equal(mockEl.children.length, 0);

        // With items renders and displays
        const items = [
            { level: 'warn', text: 'Warning message' },
            { level: 'error', text: 'Error message' }
        ];
        renderBanner(mockEl, items);
        assert.equal(mockEl.style.display, 'flex');
        assert.equal(mockEl.children.length, 2);
        assert.equal(mockEl.children[0].className, 'banner-item warn');
        assert.equal(mockEl.children[0].textContent, 'Warning message');
        assert.equal(mockEl.children[1].className, 'banner-item error');
        assert.equal(mockEl.children[1].textContent, 'Error message');
    } finally {
        globalThis.document = originalDoc;
    }
});

test('ui: copyLabel formats single-part and multi-part labels correctly', () => {
    // 1 part
    assert.equal(copyLabel(0, 1), 'Copy');
    assert.equal(copyLabel(0, 0), 'Copy');

    // 3 parts - first part
    assert.equal(copyLabel(0, 3), 'Copy part 1 of 3');

    // 3 parts - part index 1 (second part)
    assert.equal(copyLabel(1, 3), 'Copy part 2 of 3');

    // 3 parts - part index 2 (third part)
    assert.equal(copyLabel(2, 3), 'Copy part 3 of 3');
});

test('commentCostHint: scope none', () => {
    const selected = [{ number: 1, commentsCount: 5, createdAt: '2024-01-01' }];
    const hint = commentCostHint(selected, selected, new Set(), 'none');
    assert.deepEqual(hint, { requests: 0, text: 'No extra requests.' });
});

test('commentCostHint: all cached', () => {
    const selected = [
        { number: 1, commentsCount: 5, createdAt: '2024-01-01' },
        { number: 2, commentsCount: 0, createdAt: '2024-01-02' }
    ];
    const hint = commentCostHint(selected, selected, new Set([1]), 'all');
    assert.deepEqual(hint, { requests: 0, text: 'Comments already loaded.' });
});

test('commentCostHint: 3 issues (per-issue count)', () => {
    const selected = [
        { number: 1, commentsCount: 10, createdAt: '2024-01-01' },
        { number: 2, commentsCount: 15, createdAt: '2024-01-02' },
        { number: 3, commentsCount: 5, createdAt: '2024-01-03' }
    ];
    // Needs 3 issues, perIssue = 1 + 1 + 1 = 3
    // bulk condition requires perIssue >= 4, so it stays perIssue
    const hint = commentCostHint(selected, selected, new Set(), 'all');
    assert.deepEqual(hint, { requests: 3, text: 'About 3 GitHub requests.' });
});

test('commentCostHint: 60 recent issues in a 200-issue universe (bulk, small count)', () => {
    // 200 issues total; the most recent 60 have comments, but total inWindow comments is small
    const universe = [];
    for (let i = 1; i <= 200; i++) {
        universe.push({
            number: i,
            commentsCount: 1,
            createdAt: i <= 60 ? '2024-06-01' : '2023-01-01'
        });
    }
    const selected = universe.slice(0, 60);
    // needs.length = 60, perIssue = 60
    // inWindow = 60 * 1 = 60 comments -> bulkPages = Math.ceil(60/100) = 1
    // bulk = perIssue >= 4 (60 >= 4) && bulkPages (1) <= 60 * 0.3 (18) -> true!
    // n = 1
    const hint = commentCostHint(selected, universe, new Set(), 'all');
    assert.deepEqual(hint, { requests: 1, text: 'About 1 GitHub request.' });
});
