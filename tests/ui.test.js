import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBannerItems, renderBanner } from '../js/ui-banner.js';
import { copyLabel } from '../js/ui-labels.js';

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
