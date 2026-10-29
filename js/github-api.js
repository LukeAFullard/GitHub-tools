/**
 * Direct GitHub REST API & Raw Content Client
 * Enforces API rate limits, backoff periods, and anti-abuse pacing.
 */
import { GITHUB_API_BASE, GITHUB_RAW_BASE } from './config.js';

export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            return reject(new DOMException('Aborted', 'AbortError'));
        }
        let timer = null;
        const onAbort = () => {
            if (timer) clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
    });
}

export function parseRepoInput(input) {
    if (!input || typeof input !== 'string') return null;
    let cleaned = input.trim().replace(/^https?:\/\/github\.com\//i, '');
    cleaned = cleaned.replace(/^\/+|\/+$/g, '');
    const parts = cleaned.split('/');
    if (parts.length < 2) return null;
    const owner = parts[0].trim();
    let repo = parts[1].trim().replace(/\.git$/i, '');
    if (!owner || !repo) return null;
    const validOwner = /^[a-zA-Z0-9_-]+$/.test(owner);
    const validRepo = /^[a-zA-Z0-9_.-]+$/.test(repo);
    if (!validOwner || !validRepo) return null;

    let branch = null;
    let subpath = null;

    if (parts.length >= 4 && parts[2] === 'tree') {
        branch = parts[3];
        if (parts.length > 4) {
            subpath = parts.slice(4).join('/');
        }
    }

    return { owner, repo, branch, subpath };
}

export function extractRateLimitHeaders(response) {
    if (!response || !response.headers) {
        return { remaining: null, limit: null, reset: null, retryAfter: null };
    }
    const parseHeaderInt = (name) => {
        const val = response.headers.get(name);
        if (val === null || val === undefined) return null;
        const parsed = parseInt(val, 10);
        return Number.isNaN(parsed) ? null : parsed;
    };
    return {
        remaining: parseHeaderInt('x-ratelimit-remaining'),
        limit: parseHeaderInt('x-ratelimit-limit'),
        reset: parseHeaderInt('x-ratelimit-reset'),
        retryAfter: parseHeaderInt('retry-after')
    };
}

function getAuthHeader(pat) {
    if (!pat) return {};
    const token = pat.trim();
    if (token.startsWith('github_pat_') || token.startsWith('gho_') || token.startsWith('ghu_') || token.startsWith('ghs_')) {
        return { 'Authorization': `Bearer ${token}` };
    }
    return { 'Authorization': `token ${token}` };
}

export async function fetchRateLimit(pat = '') {
    const headers = { 'Accept': 'application/vnd.github.v3+json', ...getAuthHeader(pat) };

    const res = await fetch(`${GITHUB_API_BASE}/rate_limit`, { headers });
    if (!res.ok) throw new Error('Failed to retrieve rate limit info');

    const data = await res.json();
    return {
        remaining: data.resources.core.remaining,
        limit: data.resources.core.limit,
        reset: data.resources.core.reset
    };
}

export async function resolveDefaultBranch(owner, repo, pat, signal, onHeaders) {
    const headers = { 'Accept': 'application/vnd.github.v3+json', ...getAuthHeader(pat) };
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    const res = await fetch(url, { headers, signal });
    if (onHeaders) onHeaders(extractRateLimitHeaders(res));

    if (!res.ok) {
        throw new Error(`Repository lookup failed (${res.status}): ${res.statusText}`);
    }
    const data = await res.json();
    const branch = data.default_branch || 'main';
    const isPrivate = Boolean(data.private);
    return { branch, isPrivate };
}

export async function fetchRepoTree(owner, repo, branch, pat, signal, onHeaders) {
    const headers = { 'Accept': 'application/vnd.github.v3+json', ...getAuthHeader(pat) };
    const branchEncoded = branch.split('/').map(encodeURIComponent).join('/');
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${branchEncoded}?recursive=1`;

    const res = await fetch(url, { headers, signal });
    if (onHeaders) onHeaders(extractRateLimitHeaders(res));

    if (!res.ok) {
        const headersMeta = extractRateLimitHeaders(res);
        if (res.status === 403 || res.status === 429) {
            throw new Error(`Rate limit hit. ${headersMeta.retryAfter ? `Backoff: ${headersMeta.retryAfter}s.` : 'Provide a PAT to continue.'}`);
        }
        throw new Error(`Tree lookup failed (${res.status}): ${res.statusText}`);
    }

    const data = await res.json();
    const tree = data.tree || [];
    tree.truncated = Boolean(data.truncated);
    return tree;
}

export async function fetchFileContent(owner, repo, branch, path, pat, signal, onHeaders, isPrivate = false) {
    const pathEncoded = path.split('/').map(encodeURIComponent).join('/');
    const branchPath = branch.split('/').map(encodeURIComponent).join('/');
    const rawUrl = `${GITHUB_RAW_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${branchPath}/${pathEncoded}`;

    // Try fetching from raw.githubusercontent.com first if repo is NOT known to be private
    if (!isPrivate) {
        try {
            const res = await fetch(rawUrl, { signal });
            if (res.ok) {
                const text = await res.text();
                return { success: true, content: text, status: res.status };
            }
            if (res.status === 429 || res.status === 403) {
                return { success: false, backoff: 60, status: res.status };
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
        }
    }

    // Fall back to REST API (required for private repos)
    if (pat) {
        const headers = {
            'Accept': 'application/vnd.github.raw+json',
            ...getAuthHeader(pat)
        };
        const branchQuery = encodeURIComponent(branch);
        const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${pathEncoded}?ref=${branchQuery}`;
        const res = await fetch(url, { headers, signal });
        if (onHeaders) onHeaders(extractRateLimitHeaders(res));

        if (res.status === 429 || res.status === 403) {
            const headersMeta = extractRateLimitHeaders(res);
            const retryAfter = headersMeta.retryAfter || 60;
            return { success: false, backoff: retryAfter, status: res.status };
        }
        if (res.ok) {
            const text = await res.text();
            return { success: true, content: text, status: res.status };
        }
        return { success: false, error: `HTTP ${res.status}: ${res.statusText}`, status: res.status };
    }

    return { success: false, error: `HTTP 404: File not found`, status: 404 };
}
