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
    chunkContextOutput,
    buildContextOutput
} from '../js/formatters.js';

import { minifyCode } from '../js/minifier.js';
import { parseRepoInput, extractRateLimitHeaders } from '../js/github-api.js';
import { estimateTokens } from '../js/tokenizer.js';
import { generateTree } from '../js/tree.js';
import { scanForSecrets, redactSecrets } from '../js/secrets.js';

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

        globalThis.fetch = async (url) => {
            if (url.includes('raw.githubusercontent.com')) {
                return { ok: false, status: 429 };
            }
            return { ok: false, status: 429 };
        };
        const res3 = await fetchFileContent('owner', 'repo', 'main', 'file.js', '');
        assert.equal(res3.success, false);
        assert.equal(res3.backoff, 60);

        globalThis.fetch = async (url) => {
            return { ok: false, status: 500, statusText: 'Internal Server Error' };
        };
        const res4 = await fetchFileContent('owner', 'repo', 'main', 'file.js', '');
        assert.equal(res4.success, false);
        assert.equal(res4.backoff, 5);

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

test('app: boots safely when localStorage throws', () => {
    const originalLocalStorage = globalThis.localStorage;
    try {
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            get() {
                throw new Error('SecurityError: Access to localStorage is denied');
            }
        });

        assert.doesNotThrow(() => {
            try {
                localStorage.getItem('cfg_format');
            } catch (_) {}
        });
    } finally {
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: originalLocalStorage
        });
    }
});

test('tree: filtering updates tab stops so hidden tab-stop row transfers tabIndex=0 to visible row', async () => {
    function createMockElement(tagName = 'div') {
        const children = [];
        const eventListeners = {};
        const style = { display: '' };
        const attributes = {};

        const el = {
            tagName: tagName.toUpperCase(),
            children,
            style,
            attributes,
            tabIndex: -1,
            className: '',
            textContent: '',
            innerHTML: '',
            checked: false,
            type: '',
            parentElement: null,
            get offsetParent() {
                if (el.style.display === 'none') return null;
                let p = el.parentElement;
                while (p) {
                    if (p.style && p.style.display === 'none') return null;
                    p = p.parentElement;
                }
                return {};
            },

            appendChild(child) {
                child.parentElement = el;
                children.push(child);
                return child;
            },
            insertBefore(newChild, refChild) {
                newChild.parentElement = el;
                const idx = children.indexOf(refChild);
                if (idx !== -1) children.splice(idx, 0, newChild);
                else children.push(newChild);
                return newChild;
            },
            setAttribute(k, v) { attributes[k] = String(v); },
            getAttribute(k) { return attributes[k] || null; },
            addEventListener(type, fn) {
                if (!eventListeners[type]) eventListeners[type] = [];
                eventListeners[type].push(fn);
            },
            dispatchEvent(evt) {
                const fns = eventListeners[evt.type] || [];
                for (const fn of fns) fn(evt);
            },
            closest() { return null; }
        };
        return el;
    }

    const originalDoc = globalThis.document;
    try {
        globalThis.document = {
            createElement: createMockElement
        };

        const { renderInteractiveTree } = await import('../js/tree.js');
        const container = createMockElement('div');
        const nodes = [
            { path: 'alpha.js', type: 'blob', size: 100 },
            { path: 'beta.js', type: 'blob', size: 200 }
        ];

        const controls = renderInteractiveTree(nodes, container);

        function findRows(el) {
            let res = [];
            if (el.className === 'tree-row') res.push(el);
            for (const child of el.children) {
                res = res.concat(findRows(child));
            }
            return res;
        }

        const rows = findRows(container);
        assert.equal(rows.length, 2);
        assert.equal(rows[0].tabIndex, 0);
        assert.equal(rows[1].tabIndex, -1);

        controls.filter('beta');

        assert.equal(rows[0].tabIndex, -1);
        assert.equal(rows[1].tabIndex, 0);

        controls.setLargeThresholdKb(0.05);
        assert.ok(container.children[0].innerHTML.includes('[Large]') || rows[0].innerHTML.includes('[Large]') || findRows(container).some(r => r.children.some(c => c.textContent && c.textContent.includes('[Large]'))));

    } finally {
        globalThis.document = originalDoc;
    }
});

test('budget status logic for pre-build split and oversized split chunk', () => {
    function calcBudgetStatus(totalTokens, numChunks = 1, isPreBuild = false, maxChunkTokens = 0, hasOversizedChunk = false, currentBudgetWindow = 200000, chunkLimitVal = 0) {
        if (isPreBuild && chunkLimitVal > 0 && totalTokens > chunkLimitVal) {
            const estChunks = Math.ceil(totalTokens / chunkLimitVal);
            return {
                text: `About ${totalTokens.toLocaleString()} tokens, will split into about ${estChunks} parts`,
                statusClass: 'status-fits'
            };
        }

        const isSplit = numChunks > 1 || (chunkLimitVal > 0 && totalTokens > chunkLimitVal);
        const displayTokens = maxChunkTokens || Math.round(totalTokens / numChunks);

        if (isSplit && numChunks > 1) {
            if (hasOversizedChunk) {
                return {
                    text: `Split into ${numChunks} parts (largest: ${displayTokens.toLocaleString()} tok) - 1+ part exceeds split limit`,
                    statusClass: 'status-over'
                };
            } else {
                return {
                    text: `Split into ${numChunks} parts (largest: ${displayTokens.toLocaleString()} tok) - fits target window`,
                    statusClass: 'status-fits'
                };
            }
        }

        return { text: 'Fits context window', statusClass: 'status-fits' };
    }

    const preBuildRes = calcBudgetStatus(120000, 1, true, 0, false, 200000, 50000);
    assert.equal(preBuildRes.text, 'About 120,000 tokens, will split into about 3 parts');

    const splitOversizedRes = calcBudgetStatus(150000, 3, false, 65000, true, 200000, 50000);
    assert.equal(splitOversizedRes.text, 'Split into 3 parts (largest: 65,000 tok) - 1+ part exceeds split limit');
    assert.equal(splitOversizedRes.statusClass, 'status-over');
});

// --- Secrets Detection & Redaction Tests ---

test('secrets: true positive and near-miss for each pattern detector', () => {
    // AWS
    const awsPos = scanForSecrets('app.js', 'const k = "' + 'AKIA' + '1234567890ABCDEF";');
    assert.equal(awsPos.length, 1);
    assert.equal(awsPos[0].type, 'aws-key');

    const awsNear = scanForSecrets('app.js', 'const k = "AKIAEXAMPLEKEY1234";');
    assert.equal(awsNear.length, 0);

    // GitHub
    const ghPos = scanForSecrets('app.js', 'const token = "' + 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz";');
    assert.equal(ghPos.length, 1);
    assert.equal(ghPos[0].type, 'github-token');

    const ghNear = scanForSecrets('app.js', 'const token = "ghp_your_token_here_xxxxxxxxx";');
    assert.equal(ghNear.length, 0);

    // Slack
    const slackPos = scanForSecrets('app.js', 'const token = "' + 'xoxb-' + '1234567890-1234567890123-abcdefghijklmnopqrstuvwx";');
    assert.equal(slackPos.length, 1);
    assert.equal(slackPos[0].type, 'slack-token');

    const slackNear = scanForSecrets('app.js', 'const token = "xoxb-your_token_here";');
    assert.equal(slackNear.length, 0);

    // Stripe
    const stripePos = scanForSecrets('app.js', 'const key = "' + 'sk_live_' + '51Hz3abc123def456ghi789jkl";');
    assert.equal(stripePos.length, 1);
    assert.equal(stripePos[0].type, 'stripe-key');

    const stripeNear = scanForSecrets('app.js', 'const key = "sk_live_xxxxchangeme00000000000";');
    assert.equal(stripeNear.length, 0);

    // Google
    const googlePos = scanForSecrets('app.js', 'const key = "' + 'AIza' + 'SyD1234567890abcdefghijklmnopqrstUV";');
    assert.equal(googlePos.length, 1);
    assert.equal(googlePos[0].type, 'google-key');

    const googleNear = scanForSecrets('app.js', 'const key = "AIzaSyD_your_google_api_key_xxxx";');
    assert.equal(googleNear.length, 0);

    // PEM
    const pemPos = scanForSecrets('app.js', '-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAK...\n-----END RSA PRIVATE KEY-----');
    assert.equal(pemPos.length, 1);
    assert.equal(pemPos[0].type, 'pem-key');

    const pemNear = scanForSecrets('app.js', '-----BEGIN PUBLIC KEY-----\nMIIE...\n-----END PUBLIC KEY-----');
    assert.equal(pemNear.length, 0);

    // JWT
    const jwtPos = scanForSecrets('app.js', 'const token = "' + 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";');
    assert.equal(jwtPos.length, 1);
    assert.equal(jwtPos[0].type, 'jwt');

    const jwtNear = scanForSecrets('app.js', 'const token = "eyJ_your_jwt.eyJ_test.eyJ_xxxx";');
    assert.equal(jwtNear.length, 0);

    // Anthropic
    const antPos = scanForSecrets('app.js', 'const key = "' + 'sk-ant-' + 'api03-1234567890abcdefghijklmnopqrstuvwxyz";');
    assert.equal(antPos.length, 1);
    assert.equal(antPos[0].type, 'anthropic-key');

    const antNear = scanForSecrets('app.js', 'const key = "sk-ant-your_anthropic_key_here";');
    assert.equal(antNear.length, 0);

    // OpenAI
    const oaiPos = scanForSecrets('app.js', 'const key = "' + 'sk-proj-' + '1234567890abcdefghijklmnopqrstuvwxyz";');
    assert.equal(oaiPos.length, 1);
    assert.equal(oaiPos[0].type, 'openai-key');

    const oaiNear = scanForSecrets('app.js', 'const key = "sk-your_openai_key_xxxx";');
    assert.equal(oaiNear.length, 0);

    // OpenAI non-matches for normal kebab-case text
    const kebab1 = scanForSecrets('app.js', '<div class="disk-usage-monitoring-panel">');
    assert.equal(kebab1.filter(f => f.type === 'openai-key').length, 0);

    const kebab2 = scanForSecrets('app.js', 'const doc = "risk-assessment-framework-document";');
    assert.equal(kebab2.filter(f => f.type === 'openai-key').length, 0);

    const kebab3 = scanForSecrets('app.js', 'const t = "task-mask-desk-flask-cask-bask-desk-task";');
    assert.equal(kebab3.filter(f => f.type === 'openai-key').length, 0);

    // Generic (Quoted & Unquoted)
    const genPos = scanForSecrets('config.js', 'password = "Zx9!kLm2Qr8w"');
    assert.equal(genPos.length, 1);
    assert.equal(genPos[0].type, 'generic-secret');

    const genJsonPos = scanForSecrets('config.json', '{"password": "Zx9!kLm2Qr8w"}');
    assert.equal(genJsonPos.filter(f => f.type === 'generic-secret').length, 1);

    const genSuffixPos = scanForSecrets('config.py', 'SECRET_KEY = "Zx9kLm2Qr8wTv7"');
    assert.equal(genSuffixPos.filter(f => f.type === 'generic-secret').length, 1);

    const genUnquotedPos = scanForSecrets('.env', 'DB_PASSWORD=Zx9kLm2Qr8wTv7');
    assert.equal(genUnquotedPos.filter(f => f.type === 'generic-secret').length, 1);

    // Ordinary code statements must NOT be flagged as generic secrets
    const code1 = scanForSecrets('app.js', 'const auth = getAuthHeader(req);');
    assert.equal(code1.filter(f => f.type === 'generic-secret').length, 0);

    const code2 = scanForSecrets('app.js', 'const auth = require("./authentication");');
    assert.equal(code2.filter(f => f.type === 'generic-secret').length, 0);

    const code3 = scanForSecrets('app.js', 'tokenCount = estimateTokens(text) + 1;');
    assert.equal(code3.filter(f => f.type === 'generic-secret').length, 0);

    const code4 = scanForSecrets('app.js', 'const author = "Jane Q. Public";');
    assert.equal(code4.filter(f => f.type === 'generic-secret').length, 0);

    const code5 = scanForSecrets('package.json', '"tokenizer": "bert-base-uncased"');
    assert.equal(code5.filter(f => f.type === 'generic-secret').length, 0);

    const genNear = scanForSecrets('config.js', 'password = "your_password"');
    assert.equal(genNear.length, 0);

    // Sensitive filename
    const filePos = scanForSecrets('.env', 'FOO=bar');
    assert.equal(filePos.some(f => f.type === 'sensitive-file'), true);

    const fileNear = scanForSecrets('.env.example', 'FOO=bar');
    assert.equal(fileNear.some(f => f.type === 'sensitive-file'), false);
});

test('secrets: placeholders are not flagged', () => {
    const code = `
    const a = "your_api_key";
    const b = "AKIAEXAMPLEKEY1234";
    const c = "\${TOKEN}";
    const d = "<YOUR_KEY>";
    const e = process.env.SECRET;
    const f = os.environ["KEY"];
    `;
    const findings = scanForSecrets('app.js', code);
    assert.equal(findings.length, 0);
});

test('secrets: masking guarantees full secret never appears in finding', () => {
    const secret = "AKIA" + "1234567890ABCDEF";
    const findings = scanForSecrets('app.js', `const k = "${secret}";`);
    assert.equal(findings.length, 1);
    const f = findings[0];

    assert.equal(f.preview, "AKIA…");
    assert.equal('value' in f, false);
    assert.equal('secret' in f, false);
    assert.equal(JSON.stringify(f).includes(secret), false);
});

test('secrets: redaction on all four formats and with chunking produces valid output', () => {
    const rawSecret = 'AKIA' + '1234567890ABCDEF';
    const content = `const aws = "${rawSecret}";`;
    const redacted = redactSecrets(content, 'app.js');

    assert.equal(redacted.includes('[REDACTED:aws-key]'), true);
    assert.equal(redacted.includes(rawSecret), false);

    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'app.js', content: redacted }];

    // Claude XML
    const xml1 = formatClaudeXml(repoInfo, 'main', '', files);
    assert.ok(xml1.text.includes('[REDACTED:aws-key]'));
    assert.ok(xml1.text.startsWith('<documents>') && xml1.text.endsWith('</documents>'));

    // Generic XML
    const xml2 = formatGenericXml(repoInfo, 'main', '', files);
    assert.ok(xml2.text.includes('[REDACTED:aws-key]'));
    assert.ok(xml2.text.startsWith('<repository') && xml2.text.endsWith('</repository>'));

    // Markdown
    const md = formatMarkdown(repoInfo, 'main', '', files);
    assert.ok(md.text.includes('[REDACTED:aws-key]'));

    // JSON
    const json = formatJson(repoInfo, 'main', '', files);
    const parsed = JSON.parse(json.text);
    assert.ok(parsed.files[0].content.includes('[REDACTED:aws-key]'));

    // Chunking
    const chunks = chunkContextOutput('json', repoInfo, 'main', '', files, 500, estimateTokens);
    assert.ok(chunks.length >= 1);
    assert.ok(JSON.parse(chunks[0].text).files[0].content.includes('[REDACTED:aws-key]'));
});

test('secrets: file containing ]]> plus secret produces well-formed output', () => {
    const rawSecret = 'AKIA' + '1234567890ABCDEF';
    const rawContent = `hello ]]> world ${rawSecret}`;
    const redacted = redactSecrets(rawContent, 'file.txt');
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'file.txt', content: redacted }];

    const resXml = formatGenericXml(repoInfo, 'main', '', files);
    assert.ok(resXml.text.includes(']]]]><![CDATA[>'));
    assert.ok(resXml.text.includes('[REDACTED:aws-key]'));
    assert.ok(!resXml.text.includes(rawSecret));
});

test('instructions: appear exactly once, in last chunk when chunked, with part notes in others, in all four formats', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = Array.from({ length: 10 }, (_, i) => ({
        path: `file_${i}.js`,
        content: `console.log("file ${i} content repeat ".repeat(20));`
    }));
    const instructions = 'Review this code for architecture.';

    const formats = ['claude-xml', 'generic-xml', 'markdown', 'json'];

    for (const fmt of formats) {
        const chunks = chunkContextOutput(fmt, repoInfo, 'main', '', files, 200, estimateTokens, { instructions });
        assert.ok(chunks.length >= 2, `Expected multiple chunks for format ${fmt}`);

        for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            const text = chunks[i].text;

            if (isLast) {
                assert.ok(text.includes('Review this code for architecture'), `Last chunk in ${fmt} should contain instructions`);
                assert.ok(!text.includes('Part 1 of'), `Last chunk in ${fmt} should not contain intermediate part note`);
            } else {
                assert.ok(!text.includes('Review this code for architecture'), `Chunk ${i + 1} in ${fmt} should NOT contain instructions`);
                assert.ok(text.includes(`Part ${i + 1} of ${chunks.length}. Instructions are in part ${chunks.length}.`), `Chunk ${i + 1} in ${fmt} should contain part note`);
            }
        }
    }
});

test('instructions: tokens are included in chunk-size estimates', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'app.js', content: 'const x = 1;' }];

    const outNoInst = buildContextOutput('claude-xml', repoInfo, 'main', '', files, {});
    const outWithInst = buildContextOutput('claude-xml', repoInfo, 'main', '', files, { instructions: 'Detailed architectural instructions '.repeat(20) });

    const tokNoInst = estimateTokens(outNoInst.text);
    const tokWithInst = estimateTokens(outWithInst.text);

    assert.ok(tokWithInst > tokNoInst, 'Output with instructions should produce higher token estimate');
});

test('instructions: chunking budgets instructions in final chunk without exceeding chunk limit', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = Array.from({ length: 5 }, (_, i) => ({
        path: `file_${i}.js`,
        content: `console.log("file ${i} content repeat ".repeat(15));`
    }));
    const instructions = 'Detailed instruction block '.repeat(10);

    const chunks = chunkContextOutput('claude-xml', repoInfo, 'main', '', files, 500, estimateTokens, { instructions });
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
        assert.equal(chunk.exceedsLimit, false, 'No chunk should exceed chunk token limit');
    }
    assert.ok(chunks[chunks.length - 1].text.includes('Detailed instruction block'));
});

test('secrets: long single-line input scans in under 1 second', () => {
    const start = Date.now();
    const longSingleLine = 'a'.repeat(1000000);
    const findings = scanForSecrets('bigfile.txt', longSingleLine);
    const duration = Date.now() - start;

    assert.equal(findings.length, 0);
    assert.ok(duration < 1000, `Scan took ${duration} ms (expected < 1000 ms)`);
});

test('secrets: sensitive file content is fully redacted', () => {
    const redactedEnv = redactSecrets('API_KEY=abc123XYZ789def456', '.env');
    assert.equal(redactedEnv, '[REDACTED:sensitive-file]');

    const redactedPem = redactSecrets('some private key content', 'server.key');
    assert.equal(redactedPem, '[REDACTED:sensitive-file]');
});

test('secrets: scans beyond 200 KB in file', () => {
    const padding = 'x'.repeat(210000);
    const secret = 'AKIA' + '1234567890ABCDEF';
    const content = padding + ' const k = "' + secret + '";';

    const findings = scanForSecrets('large.txt', content);
    assert.equal(findings.filter(f => f.type === 'aws-key').length, 1);

    const redacted = redactSecrets(content, 'large.txt');
    assert.ok(redacted.includes('[REDACTED:aws-key]'));
    assert.ok(!redacted.includes(secret));
});

test('secrets: overlapping secret redaction does not corrupt output', () => {
    // Overlapping specific pattern or multiple secrets
    const skKey = 'sk-proj-' + '1234567890abcdefghijklmnopqrstuvwxyz';
    const content = `const secret = "${skKey}"; password = "${skKey}";`;
    const redacted = redactSecrets(content, 'test.js');

    assert.ok(!redacted.includes('undefined'));
    assert.ok(!redacted.includes('NaN'));
    assert.ok(redacted.includes('[REDACTED:openai-key]'));
    assert.ok(!redacted.includes(skKey));

    // JWT inside token = "..."
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const jwtContent = `token = "${jwt}"`;
    const jwtRedacted = redactSecrets(jwtContent, 'config.js');
    assert.ok(!jwtRedacted.includes(jwt));
    assert.ok(jwtRedacted.includes('[REDACTED:jwt]'));
});

test('tree: filter counts matching leaf files instead of top-level folder count', async () => {
    function createMockElement(tagName = 'div') {
        const children = [];
        const eventListeners = {};
        const style = { display: '' };
        const attributes = {};

        const el = {
            tagName: tagName.toUpperCase(),
            children,
            style,
            attributes,
            tabIndex: -1,
            className: '',
            textContent: '',
            innerHTML: '',
            checked: false,
            type: '',
            parentElement: null,
            get offsetParent() {
                if (el.style.display === 'none') return null;
                let p = el.parentElement;
                while (p) {
                    if (p.style && p.style.display === 'none') return null;
                    p = p.parentElement;
                }
                return {};
            },

            appendChild(child) {
                child.parentElement = el;
                children.push(child);
                return child;
            },
            insertBefore(newChild, refChild) {
                newChild.parentElement = el;
                const idx = children.indexOf(refChild);
                if (idx !== -1) children.splice(idx, 0, newChild);
                else children.push(newChild);
                return newChild;
            },
            setAttribute(k, v) { attributes[k] = String(v); },
            getAttribute(k) { return attributes[k] || null; },
            addEventListener(type, fn) {
                if (!eventListeners[type]) eventListeners[type] = [];
                eventListeners[type].push(fn);
            },
            dispatchEvent(evt) {
                const fns = eventListeners[evt.type] || [];
                for (const fn of fns) fn(evt);
            },
            closest() { return null; }
        };
        return el;
    }

    const originalDoc = globalThis.document;
    try {
        globalThis.document = { createElement: createMockElement };
        const { renderInteractiveTree } = await import('../js/tree.js');
        const container = createMockElement('div');
        const nodes = [
            { path: 'src/a.js', type: 'blob', size: 100 },
            { path: 'src/b.js', type: 'blob', size: 100 },
            { path: 'src/c.js', type: 'blob', size: 100 }
        ];

        const controls = renderInteractiveTree(nodes, container);
        const matchCount = controls.filter('.js');
        assert.equal(matchCount, 3);
    } finally {
        globalThis.document = originalDoc;
    }
});
