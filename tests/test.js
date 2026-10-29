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

test('formatters: Claude XML formatting emits raw content', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo', url: 'http://localhost/?repo=user/my-repo' };
    const branch = 'main';
    const treeText = '├── index.js\n';
    const files = [{ path: 'index.js', content: 'console.log("<hello>");' }];

    const result = formatClaudeXml(repoInfo, branch, treeText, files);
    assert.equal(result.ext, 'xml');
    assert.match(result.text, /<repository>user\/my-repo<\/repository>/);
    assert.match(result.text, /<url>http:\/\/localhost\/\?repo=user\/my-repo<\/url>/);
    assert.match(result.text, /console\.log\("<hello>"\);/);
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
    assert.deepEqual(parseRepoInput('LukeAFullard/senti'), { owner: 'LukeAFullard', repo: 'senti', branch: null, subpath: null, treeTail: null });
    assert.deepEqual(parseRepoInput('https://github.com/LukeAFullard/senti.git'), { owner: 'LukeAFullard', repo: 'senti', branch: null, subpath: null, treeTail: null });
    assert.deepEqual(parseRepoInput('https://github.com/LukeAFullard/senti/tree/dev/src/components'), { owner: 'LukeAFullard', repo: 'senti', branch: 'dev', subpath: 'src/components', treeTail: 'dev/src/components' });
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
    assert.deepEqual(parsedQuery, { owner: 'owner', repo: 'repo', branch: 'main', subpath: 'src', treeTail: 'main/src' });

    const parsedBlob = parseRepoInput('https://github.com/owner/repo/blob/main/src/index.js');
    assert.deepEqual(parsedBlob, { owner: 'owner', repo: 'repo', branch: 'main', subpath: 'src/index.js', treeTail: 'main/src/index.js' });
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

test('minifier: CSS url(//host/a.css) is preserved and not stripped as line comment', () => {
    const code = '@import url(//cdn.example.com/style.css);';
    const minified = minifyCode(code, 'style.css', 'aggressive');
    assert.ok(minified.includes('url(//cdn.example.com/style.css)'));
});

test('minifier: JSX apostrophe in text does not truncate subsequent lines', () => {
    const code = 'const text = <p>Don\'t stop</p>;\nconst url = "//cdn.example.com/script.js";';
    const minified = minifyCode(code, 'Component.jsx', 'aggressive');
    assert.ok(minified.includes("Don't stop"));
    assert.ok(minified.includes('//cdn.example.com/script.js'));
});

test('minifier: Markdown files in aggressive mode do not strip blank lines', () => {
    const code = '# Title\n\nParagraph 1\n\nParagraph 2';
    const minified = minifyCode(code, 'README.md', 'aggressive');
    assert.equal(minified, code);
});

test('github-api: parseRepoInput with branch containing slashes', () => {
    const parsed = parseRepoInput('https://github.com/owner/repo/tree/feature/ui/src/app', 'feature/ui');
    assert.deepEqual(parsed, { owner: 'owner', repo: 'repo', branch: 'feature/ui', subpath: 'src/app', treeTail: 'feature/ui/src/app' });
});

test('formatters: Claude XML wraps CDATA when closing document tags exist in content', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'test.xml', content: '</document> inside content' }];
    const res = formatClaudeXml(repoInfo, 'main', '', files);
    assert.ok(res.text.includes('<![CDATA['), 'Expected CDATA block for content containing closing document tags');
});

test('minifier: HTML textarea content is preserved during aggressive minification', () => {
    const code = '<textarea>\n  line 1\n\n  line 2\n</textarea>';
    const minified = minifyCode(code, 'index.html', 'aggressive');
    assert.ok(minified.includes('line 1\n\n  line 2'));
});

test('minifier: JS template literal interpolation preserves expressions and literal text surrounding interpolation', () => {
    const code = 'const msg = `hello ${val /* comment */ || "world `nested`"}!`;';
    const minified = minifyCode(code, 'app.js', 'aggressive');
    assert.ok(!minified.includes('comment'), 'Minified was: ' + JSON.stringify(minified));
    assert.ok(minified.includes('const msg = `hello ${'), 'Minified was: ' + JSON.stringify(minified));
    assert.ok(minified.includes('world `nested`'), 'Minified was: ' + JSON.stringify(minified));
    assert.ok(minified.includes('}!`;'), 'Minified was: ' + JSON.stringify(minified));
});

test('minifier: Python inline comment without preceding space is stripped', () => {
    const code = 'x = 1;#inline comment\ny = [1, 2]#comment2';
    const minified = minifyCode(code, 'script.py', 'aggressive');
    assert.equal(minified, 'x = 1;\ny = [1, 2]');
});

test('minifier: Shell parameter expansion ${var#pattern} and unquoted hash are preserved', () => {
    const code = 'echo ${var#prefix}\n echo foo#bar\n# Real comment';
    const minified = minifyCode(code, 'script.sh', 'aggressive');
    assert.ok(minified.includes('echo ${var#prefix}'));
    assert.ok(minified.includes('echo foo#bar'));
    assert.ok(!minified.includes('Real comment'));
});

test('minifier: HTML script and style tags are preserved during aggressive minification', () => {
    const code = '<script>\n  // JS comment\n  if (a <!-- b) console.log("ok");\n</script>\n<style>\n  /* CSS comment */\n  body { color: red; }\n</style>';
    const minified = minifyCode(code, 'index.html', 'aggressive');
    assert.ok(minified.includes('if (a <!-- b) console.log("ok");'));
    assert.ok(minified.includes('body { color: red; }'));
});

test('github-api: parseRepoInput override branch honors explicit branch over URL tree segment', () => {
    const parsed = parseRepoInput('https://github.com/owner/repo/tree/feature/login/src', 'main');
    assert.deepEqual(parsed, { owner: 'owner', repo: 'repo', branch: 'main', subpath: 'feature/login/src', treeTail: 'feature/login/src' });
});

test('github-api: fetchFileContent with mock fetch (public raw OK, raw 404 REST fallback, 429 backoff)', async () => {
    const originalFetch = globalThis.fetch;
    try {
        // Case 1: Public raw fetch OK
        globalThis.fetch = async (url) => {
            if (url.includes('raw.githubusercontent.com')) {
                return { ok: true, status: 200, text: async () => 'hello world' };
            }
            return { ok: false, status: 404 };
        };
        const { fetchFileContent } = await import('../js/github-api.js');
        const res1 = await fetchFileContent('owner', 'repo', 'main', 'index.js', '');
        assert.equal(res1.success, true);
        assert.equal(res1.content, 'hello world');

        // Case 2: Public raw 404 + PAT -> REST fallback OK
        globalThis.fetch = async (url) => {
            if (url.includes('raw.githubusercontent.com')) {
                return { ok: false, status: 404, statusText: 'Not Found' };
            }
            if (url.includes('api.github.com')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Map(),
                    text: async () => 'rest content'
                };
            }
            return { ok: false, status: 404 };
        };
        const res2 = await fetchFileContent('owner', 'repo', 'main', 'secret.txt', 'ghp_token');
        assert.equal(res2.success, true);
        assert.equal(res2.content, 'rest content');

        // Case 3: Raw 429 rate limit
        globalThis.fetch = async (url) => {
            if (url.includes('raw.githubusercontent.com')) {
                return { ok: false, status: 429 };
            }
            return { ok: false, status: 429 };
        };
        const res3 = await fetchFileContent('owner', 'repo', 'main', 'file.js', '');
        assert.equal(res3.success, false);
        assert.equal(res3.backoff, 60);

    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('minifier: CSS slash is not treated as regex start', () => {
    const code = '.box { font: 12px/1.5 sans-serif; /* comment */ background: 50% / 10%; }';
    const minified = minifyCode(code, 'style.css', 'aggressive');
    assert.ok(!minified.includes('comment'), 'Comment should be removed');
    assert.ok(minified.includes('font: 12px/1.5 sans-serif;'));
    assert.ok(minified.includes('background: 50% / 10%;'));
});

test('minifier: JSX closing tag does not prevent comment stripping', () => {
    const code = '<div>hello</div> // trailing comment';
    const minified = minifyCode(code, 'App.jsx', 'aggressive');
    assert.ok(!minified.includes('trailing comment'));
    assert.ok(minified.includes('<div>hello</div>'));
});

test('minifier: Rust lifetime annotations do not corrupt string state or comments', () => {
    const code = "fn foo<'a>(x: &'a str) {\n    let val = 42; // Rust comment\n}";
    const minified = minifyCode(code, 'lib.rs', 'aggressive');
    assert.ok(!minified.includes('Rust comment'));
    assert.ok(minified.includes("fn foo<'a>(x: &'a str)"));
});

test('formatters: invalid XML control characters are stripped', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'ansi.txt', content: 'hello \x1b[31mred\x1b[0m world\x07' }];
    const res = formatClaudeXml(repoInfo, 'main', '', files);
    assert.ok(!res.text.includes('\x1b'));
    assert.ok(!res.text.includes('\x07'));
    assert.ok(res.text.includes('hello [31mred[0m world'));
});

test('formatters: continuous indexing in Claude XML across chunks', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [
        { path: 'a.js', content: 'const a = 1;' },
        { path: 'b.js', content: 'const b = 2;' }
    ];
    const chunks = chunkContextOutput('claude-xml', repoInfo, 'main', '', files, 40, estimateTokens);
    assert.ok(chunks.length >= 2, 'Expected multiple chunks');
    assert.ok(chunks[0].text.includes('<document index="1">'));
    assert.ok(chunks[1].text.includes('<document index="2">'));
});

test('minifier: basic mode preserves first line leading indentation', () => {
    const code = '  first_line: true\n  second_line: 123\n\n\n';
    const minified = minifyCode(code, 'config.yaml', 'basic');
    assert.equal(minified, '  first_line: true\n  second_line: 123');
});

test('formatters: chunks 2+ omit structure tree to optimize token overhead', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const treeText = '├── large_tree_file_1.js\n├── large_tree_file_2.js\n';
    const files = [
        { path: 'f1.js', content: 'console.log("file 1 content");' },
        { path: 'f2.js', content: 'console.log("file 2 content");' }
    ];
    const chunks = chunkContextOutput('claude-xml', repoInfo, 'main', treeText, files, 50, estimateTokens);
    assert.ok(chunks.length >= 2);
    assert.ok(chunks[0].text.includes('<structure>'));
    assert.ok(!chunks[1].text.includes('<structure>'));
});
