import test from 'node:test';
import assert from 'node:assert/strict';

import {
    escapeXml,
    escapeCdata,
    getMarkdownFence,
    formatClaudeXml,
    formatMarkdown,
    formatGenericXml,
    formatJson,
    chunkContextOutput
} from '../js/formatters.js';

import { minifyCode } from '../js/minifier.js';
import { parseRepoInput, extractRateLimitHeaders } from '../js/github-api.js';
import { estimateTokens } from '../js/tokenizer.js';
import { generateTree } from '../js/tree.js';

test('formatters: escapeXml', () => {
    assert.equal(escapeXml('<script>alert("xss & ' + "'" + '")</script>'), '&lt;script&gt;alert(&quot;xss &amp; &apos;&quot;)&lt;/script&gt;');
    assert.equal(escapeXml(null), '');
});

test('formatters: escapeCdata', () => {
    assert.equal(escapeCdata('hello ]]> world'), 'hello ]]]]><![CDATA[> world');
    assert.equal(escapeCdata('normal text'), 'normal text');
});

test('formatters: getMarkdownFence', () => {
    assert.equal(getMarkdownFence('const x = 1;'), '```');
    assert.equal(getMarkdownFence('```js\ncode\n```'), '````');
    assert.equal(getMarkdownFence('````nested````'), '`````');
});

test('formatters: Claude XML formatting', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo' };
    const branch = 'main';
    const treeText = '├── index.js\n';
    const files = [{ path: 'index.js', content: 'console.log("<hello>");' }];

    const result = formatClaudeXml(repoInfo, branch, treeText, files);
    assert.equal(result.ext, 'xml');
    assert.match(result.text, /<repository>user\/my-repo<\/repository>/);
    assert.match(result.text, /&lt;hello&gt;/);
});

test('formatters: Generic XML CDATA escaping', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo' };
    const files = [{ path: 'test.txt', content: 'end ]]> block' }];
    const result = formatGenericXml(repoInfo, 'main', '', files);

    assert.match(result.text, /<!\[CDATA\[\nend \]\]\]\]><!\[CDATA\[> block\n\]\]>/);
});

test('formatters: Markdown fence generation', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo' };
    const files = [{ path: 'test.md', content: '```js\nconsole.log(1);\n```' }];
    const result = formatMarkdown(repoInfo, 'main', '', files);

    assert.match(result.text, /````md/);
});

test('minifier: JS comment stripping preserves strings and URLs', () => {
    const code = `
    // This is a comment
    const url = "https://example.com/path?a=1//2";
    /* Multi-line
       comment */
    const text = 'hello // world';
    `;
    const minified = minifyCode(code, 'app.js', 'aggressive');
    assert.ok(minified.includes('const url = "https://example.com/path?a=1//2";'));
    assert.ok(minified.includes("const text = 'hello // world';"));
    assert.ok(!minified.includes('This is a comment'));
    assert.ok(!minified.includes('Multi-line'));
});

test('minifier: Python comment stripping preserves strings and shebang', () => {
    const code = `#!/usr/bin/env python
# This is a comment
url = "https://example.com/#anchor"
msg = 'hello # world'
""" Triple quoted
    # comment inside string
"""
`;
    const minified = minifyCode(code, 'script.py', 'aggressive');
    assert.ok(minified.startsWith('#!/usr/bin/env python'));
    assert.ok(minified.includes('url = "https://example.com/#anchor"'));
    assert.ok(minified.includes("msg = 'hello # world'"));
    assert.ok(minified.includes('# comment inside string'));
    assert.ok(!minified.includes('# This is a comment'));
});

test('github-api: parseRepoInput validation', () => {
    assert.deepEqual(parseRepoInput('LukeAFullard/senti'), { owner: 'LukeAFullard', repo: 'senti' });
    assert.deepEqual(parseRepoInput('https://github.com/LukeAFullard/senti.git'), { owner: 'LukeAFullard', repo: 'senti' });
    assert.deepEqual(parseRepoInput('https://github.com/LukeAFullard/senti/extra/path'), { owner: 'LukeAFullard', repo: 'senti' });
    assert.equal(parseRepoInput('invalid-input'), null);
    assert.equal(parseRepoInput('bad owner/repo name!'), null);
    assert.equal(parseRepoInput(''), null);
});

test('tokenizer: estimateTokens', () => {
    const count = estimateTokens('function helloWorld() { return 42; }');
    assert.ok(count > 0);
});

test('minifier: JS comment stripping preserves RegExp literals', () => {
    const code = `
    // comment before
    const pattern = /^https?:\\/\\//;
    const regexWithCommentLike = /a\\/b/*c/;
    /* comment after */
    `;
    const minified = minifyCode(code, 'app.js', 'aggressive');
    assert.ok(!minified.includes('comment before'));
    assert.ok(!minified.includes('comment after'));
    assert.ok(minified.includes('const pattern = /^https?:\\/\\//;'));
});

test('formatters: linear chunking does not stall or throw', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo' };
    const files = Array.from({ length: 50 }, (_, i) => ({
        path: `file_${i}.js`,
        content: `console.log("File ${i} content repeat ".repeat(20));`
    }));

    const chunks = chunkContextOutput('claude-xml', repoInfo, 'main', '├── file.js\n', files, 200, estimateTokens);
    assert.ok(chunks.length > 1);
});

test('github-api: extractRateLimitHeaders converts strings to numbers', () => {
    const map = new Map([
        ['x-ratelimit-remaining', '4999'],
        ['x-ratelimit-limit', '5000'],
        ['x-ratelimit-reset', '1600000000'],
        ['retry-after', '30']
    ]);
    const mockResponse = {
        headers: {
            get: (k) => map.get(k) || null
        }
    };

    const parsed = extractRateLimitHeaders(mockResponse);
    assert.strictEqual(parsed.remaining, 4999);
    assert.strictEqual(parsed.limit, 5000);
    assert.strictEqual(parsed.reset, 1600000000);
    assert.strictEqual(parsed.retryAfter, 30);
});

test('tree: generateTree handles prototype property collisions safely', () => {
    const paths = ['toString/file.js', 'constructor/test.js', 'valueOf/index.js'];
    const ascii = generateTree(paths);
    assert.ok(ascii.includes('toString'));
    assert.ok(ascii.includes('constructor'));
    assert.ok(ascii.includes('valueOf'));
});
