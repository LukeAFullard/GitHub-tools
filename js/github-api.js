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

export function parseRepoInput(input, overrideBranch = null) {
    if (!input || typeof input !== 'string') return null;
    let urlStr = input.trim();
    try {
        if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
            const urlObj = new URL(urlStr);
            urlStr = urlObj.pathname;
        }
    } catch (_) {}

    let cleaned = urlStr.replace(/^https?:\/\/github\.com\//i, '');
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

    if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
        const tail = parts.slice(3);
        const tailStr = tail.join('/');
        const cleanBranch = overrideBranch ? overrideBranch.trim() : null;

        if (cleanBranch) {
            if (tailStr === cleanBranch || tailStr.startsWith(cleanBranch + '/')) {
                branch = cleanBranch;
                subpath = tailStr.slice(cleanBranch.length + 1) || null;
            } else {
                branch = cleanBranch;
                subpath = tailStr;
            }
        } else {
            branch = parts[3];
            if (parts.length > 4) {
                subpath = parts.slice(4).join('/');
            }
        }
    } else if (overrideBranch && overrideBranch.trim()) {
        branch = overrideBranch.trim();
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
    const parseRetryAfter = () => {
        const val = response.headers.get('retry-after');
        if (!val) return null;
        const seconds = parseInt(val, 10);
        if (!Number.isNaN(seconds)) return seconds;
        const dateMs = Date.parse(val);
        if (!Number.isNaN(dateMs)) {
            const diffSec = Math.ceil((dateMs - Date.now()) / 1000);
            return diffSec > 0 ? diffSec : 0;
        }
        return null;
    };
    return {
        remaining: parseHeaderInt('x-ratelimit-remaining'),
        limit: parseHeaderInt('x-ratelimit-limit'),
        reset: parseHeaderInt('x-ratelimit-reset'),
        retryAfter: parseRetryAfter()
    };
}

export function isRateLimitResponse(response, headersMeta) {
    if (response.status === 429) return true;
    if (response.status === 403) {
        if (headersMeta && headersMeta.remaining === 0) return true;
        if (headersMeta && headersMeta.retryAfter) return true;
    }
    return false;
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

    let retries = 0;
    while (retries < 3) {
        const res = await fetch(url, { headers, signal });
        const headersMeta = extractRateLimitHeaders(res);
        if (onHeaders) onHeaders(headersMeta);

        if (res.ok) {
            const data = await res.json();
            const tree = data.tree || [];
            tree.truncated = Boolean(data.truncated);
            return tree;
        }

        const isRateLimit = isRateLimitResponse(res, headersMeta);
        if (isRateLimit && retries < 2) {
            retries++;
            const backoff = headersMeta.retryAfter || 60;
            await sleep(Math.min(backoff, 60) * 1000, signal);
            continue;
        }

        if (res.status === 403 && !isRateLimit) {
            throw new Error(`Access forbidden (${res.status}): Permission denied or authentication failed.`);
        }
        throw new Error(`Tree lookup failed (${res.status}): ${res.statusText}`);
    }
}

export async function fetchRepoZipball(owner, repo, branch, pat, signal, onHeaders) {
    const headers = {
        'Accept': 'application/vnd.github.v3+json',
        ...getAuthHeader(pat)
    };
    const refEncoded = encodeURIComponent(branch);
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${refEncoded}`;

    const res = await fetch(url, { headers, signal });
    if (onHeaders) onHeaders(extractRateLimitHeaders(res));

    if (!res.ok) {
        throw new Error(`Zipball download failed (${res.status}): ${res.statusText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return new Uint8Array(arrayBuffer);
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
                return { success: true, content: text, status: res.status, isPrivate: false };
            }
            if (res.status === 429) {
                return { success: false, backoff: 60, status: res.status, isPrivate: false };
            }
            if (res.status === 403) {
                const headersMeta = extractRateLimitHeaders(res);
                if (isRateLimitResponse(res, headersMeta)) {
                    return { success: false, backoff: headersMeta.retryAfter || 60, status: res.status, isPrivate: false };
                }
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

        const headersMeta = extractRateLimitHeaders(res);
        if (isRateLimitResponse(res, headersMeta)) {
            const retryAfter = headersMeta.retryAfter || 60;
            return { success: false, backoff: retryAfter, status: res.status, isPrivate };
        }
        if (res.ok) {
            const text = await res.text();
            return { success: true, content: text, status: res.status, isPrivate };
        }
        return { success: false, error: `HTTP ${res.status}: ${res.statusText}`, status: res.status, isPrivate };
    }

    return { success: false, error: `HTTP 404: File not found`, status: 404, isPrivate };
}
