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
import { parseRepoInput, extractRateLimitHeaders, fetchRepoZipball } from '../js/github-api.js';
import { estimateTokens } from '../js/tokenizer.js';
import { generateTree, renderInteractiveTree } from '../js/tree.js';

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
    const repoInfo = { owner: 'user', repo: 'my-repo', url: 'http://localhost/?repo=user/my-repo' };
    const branch = 'main';
    const treeText = '├── index.js\n';
    const files = [{ path: 'index.js', content: 'console.log("<hello>");' }];

    const result = formatClaudeXml(repoInfo, branch, treeText, files);
    assert.equal(result.ext, 'xml');
    assert.match(result.text, /<repository>user\/my-repo<\/repository>/);
    assert.match(result.text, /<url>http:\/\/localhost\/\?repo=user\/my-repo<\/url>/);
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
    assert.deepEqual(parseRepoInput('LukeAFullard/senti'), { owner: 'LukeAFullard', repo: 'senti', branch: null, subpath: null });
    assert.deepEqual(parseRepoInput('https://github.com/LukeAFullard/senti.git'), { owner: 'LukeAFullard', repo: 'senti', branch: null, subpath: null });
    assert.deepEqual(parseRepoInput('https://github.com/LukeAFullard/senti/tree/dev/src/components'), { owner: 'LukeAFullard', repo: 'senti', branch: 'dev', subpath: 'src/components' });
    assert.equal(parseRepoInput('invalid-input'), null);
    assert.equal(parseRepoInput('bad owner/repo name!'), null);
    assert.equal(parseRepoInput(''), null);
});

test('tokenizer: estimateTokens', () => {
    const count = estimateTokens('function helloWorld() { return 42; }');
    assert.ok(count > 0);
});

test('minifier: JS comment stripping preserves RegExp literals and distinguishes division', () => {
    const code = `
    // comment before
    const pattern = /^https?:\\/\\//;
    const regexWithCommentLike = /a\\/b/*c/;
    const myreturn = 10 / 2;
    /* comment after */
    `;
    const minified = minifyCode(code, 'app.js', 'aggressive');
    assert.ok(!minified.includes('comment before'));
    assert.ok(!minified.includes('comment after'));
    assert.ok(minified.includes('const pattern = /^https?:\\/\\//;'));
    assert.ok(minified.includes('const myreturn = 10 / 2;'));
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

test('github-api: fetchRepoZipball export function exists', () => {
    assert.equal(typeof fetchRepoZipball, 'function');
});

test('minifier: block comment removal inserts space to prevent token merging', () => {
    const code = 'return/*comment*/x;';
    const minified = minifyCode(code, 'app.js', 'aggressive');
    assert.equal(minified, 'return x;');
});

test('minifier: unquoted hash in YAML value is not treated as comment', () => {
    const code = 'value: abc#def\nurl: http://example.com/#anchor';
    const minified = minifyCode(code, 'config.yaml', 'aggressive');
    assert.ok(minified.includes('value: abc#def'));
    assert.ok(minified.includes('url: http://example.com/#anchor'));
});

test('minifier: blank lines inside Python triple quoted strings are preserved', () => {
    const code = 'x = """\nline1\n\nline3\n"""';
    const minified = minifyCode(code, 'script.py', 'aggressive');
    assert.ok(minified.includes('line1\n\nline3'));
});

test('github-api: parseRepoInput handles query strings and blob URLs', () => {
    const parsedQuery = parseRepoInput('https://github.com/owner/repo/tree/main/src?ref=123');
    assert.deepEqual(parsedQuery, { owner: 'owner', repo: 'repo', branch: 'main', subpath: 'src' });

    const parsedBlob = parseRepoInput('https://github.com/owner/repo/blob/main/src/index.js');
    assert.deepEqual(parsedBlob, { owner: 'owner', repo: 'repo', branch: 'main', subpath: 'src/index.js' });
});

test('github-api: Retry-After HTTP-date parsing', () => {
    const futureDateStr = new Date(Date.now() + 45000).toUTCString();
    const map = new Map([['retry-after', futureDateStr]]);
    const response = { headers: { get: (k) => map.get(k) || null } };
    const meta = extractRateLimitHeaders(response);
    assert.ok(meta.retryAfter >= 40 && meta.retryAfter <= 50);
});

test('formatters: markdown file path extension extraction in directories with dots', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'v1.0.0/src/component.js', content: 'const a = 1;' }];
    const res = formatMarkdown(repoInfo, 'main', '', files);
    assert.ok(res.text.includes('```js'));
});
