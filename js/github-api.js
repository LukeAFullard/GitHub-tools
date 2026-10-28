/**
 * Direct GitHub REST API & Raw Content Client
 * Enforces API rate limits, backoff periods, and anti-abuse pacing.
 */
import { GITHUB_API_BASE, GITHUB_RAW_BASE } from './config.js';

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function parseRepoInput(input) {
    input = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    const parts = input.split('/');
    return parts.length >= 2 ? { owner: parts[0], repo: parts[1] } : null;
}

export function extractRateLimitHeaders(response) {
    return {
        remaining: response.headers.get('x-ratelimit-remaining'),
        limit: response.headers.get('x-ratelimit-limit'),
        reset: response.headers.get('x-ratelimit-reset'),
        retryAfter: response.headers.get('retry-after')
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

    const res = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, { headers, signal });
    if (onHeaders) onHeaders(extractRateLimitHeaders(res));

    if (!res.ok) {
        throw new Error(`Repository lookup failed (${res.status}): ${res.statusText}`);
    }
    const data = await res.json();
    return data.default_branch || 'main';
}

export async function fetchRepoTree(owner, repo, branch, pat, signal, onHeaders) {
    const headers = { 'Accept': 'application/vnd.github.v3+json', ...getAuthHeader(pat) };

    const res = await fetch(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        { headers, signal }
    );
    if (onHeaders) onHeaders(extractRateLimitHeaders(res));

    if (!res.ok) {
        const headersMeta = extractRateLimitHeaders(res);
        if (res.status === 403 || res.status === 429) {
            throw new Error(`Rate limit hit. ${headersMeta.retryAfter ? `Backoff: ${headersMeta.retryAfter}s.` : 'Provide a PAT to continue.'}`);
        }
        throw new Error(`Tree lookup failed (${res.status}): ${res.statusText}`);
    }

    const data = await res.json();
    return data.tree || [];
}

export async function fetchFileContent(owner, repo, branch, path, pat, signal, onHeaders) {
    if (pat) {
        const headers = {
            'Accept': 'application/vnd.github.raw+json',
            ...getAuthHeader(pat)
        };
        const res = await fetch(
            `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
            { headers, signal }
        );
        if (onHeaders) onHeaders(extractRateLimitHeaders(res));

        if (res.status === 429 || res.status === 403) {
            const retryAfter = parseInt(res.headers.get('retry-after') || '60', 10);
            return { backoff: retryAfter };
        }
        if (res.ok) {
            const text = await res.text();
            return { content: text };
        }
        return { content: '' };
    } else {
        const rawUrl = `${GITHUB_RAW_BASE}/${owner}/${repo}/${branch}/${path}`;
        const res = await fetch(rawUrl, { signal });
        if (res.ok) {
            const text = await res.text();
            return { content: text };
        }
        return { content: '' };
    }
}
