/**
 * GitHub Issues & Comments REST Client
 * Uses smart bulk vs. per-issue comment fetching to preserve API quota.
 */
import { GITHUB_API_BASE } from './config.js';
import { extractRateLimitHeaders, isRateLimitResponse, sleep } from './github-api.js';

function getAuthHeader(pat) {
    if (!pat) return {};
    const token = pat.trim();
    if (token.startsWith('github_pat_') || token.startsWith('gho_') || token.startsWith('ghu_') || token.startsWith('ghs_')) {
        return { 'Authorization': `Bearer ${token}` };
    }
    return { 'Authorization': `token ${token}` };
}

async function fetchWithRetry(url, pat, signal, onHeaders) {
    const headers = {
        'Accept': 'application/vnd.github.v3+json',
        ...getAuthHeader(pat)
    };
    let retries = 0;
    while (retries < 3) {
        const res = await fetch(url, { headers, signal });
        const meta = extractRateLimitHeaders(res);
        if (onHeaders) onHeaders(meta);

        if (res.ok) {
            return await res.json();
        }
        if (isRateLimitResponse(res, meta)) {
            const nowSec = Math.floor(Date.now() / 1000);
            const waitSec = meta.retryAfter ?? (meta.reset ? Math.max(1, meta.reset - nowSec) : 60);
            if (waitSec > 90 || retries >= 2) {
                const when = meta.reset ? new Date(meta.reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'later';
                throw new Error(`GitHub rate limit reached. Resets at ${when}. Add a token to raise the limit.`);
            }
            retries++;
            await sleep(waitSec * 1000, signal);
            continue;
        }
        throw new Error(`GitHub API error (${res.status}): ${res.statusText}`);
    }
}

/**
 * Fetches paginated issues manifest (100 items per page).
 * Includes full issue title, body, labels, state_reason, reactions, and comment count.
 */
export async function fetchIssuesManifest(owner, repo, options = {}) {
    const {
        maxItems = 300,
        itemType = 'issues', // 'issues' | 'prs' | 'both'
        pat = '',
        signal,
        onHeaders,
        onProgress
    } = options;

    const collected = [];
    let page = 1;
    const HARD_MAX_PAGES = 30;
    let lastBatchWasFull = false;

    while (collected.length < maxItems && page <= HARD_MAX_PAGES) {
        const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=all&per_page=100&sort=created&direction=desc&page=${page}`;
        const batch = await fetchWithRetry(url, pat, signal, onHeaders);

        if (!Array.isArray(batch) || batch.length === 0) {
            lastBatchWasFull = false;
            break;
        }

        lastBatchWasFull = batch.length === 100;

        for (const raw of batch) {
            const isPr = Boolean(raw.pull_request);
            if (itemType === 'issues' && isPr) continue;
            if (itemType === 'prs' && !isPr) continue;

            const mergedAt = raw.pull_request ? raw.pull_request.merged_at : null;
            let stateReason = raw.state_reason || null;
            if (isPr && mergedAt) {
                stateReason = 'completed';
            }

            collected.push({
                number: raw.number,
                title: raw.title || '',
                state: raw.state || 'open',
                stateReason,
                mergedAt,
                isPullRequest: isPr,
                author: raw.user ? raw.user.login : 'ghost',
                authorType: raw.user ? raw.user.type : 'User',
                authorAssociation: raw.author_association || 'NONE',
                createdAt: raw.created_at ? raw.created_at.slice(0, 10) : '',
                closedAt: raw.closed_at ? raw.closed_at.slice(0, 10) : null,
                commentsCount: raw.comments || 0,
                reactionsTotal: (raw.reactions && raw.reactions.total_count) || 0,
                reactionsPlusOne: (raw.reactions && raw.reactions['+1']) || 0,
                labels: Array.isArray(raw.labels) ? raw.labels.map(l => typeof l === 'string' ? l : l.name).filter(Boolean) : [],
                body: raw.body || '',
                htmlUrl: raw.html_url || ''
            });

            if (collected.length >= maxItems) break;
        }

        if (onProgress) onProgress(collected.length, maxItems);
        if (batch.length < 100) break;
        page++;
    }

    collected.stoppedEarly = collected.length < maxItems && lastBatchWasFull;
    return collected;
}

/**
 * Fetches comments for selected issues.
 * Uses direct per-issue endpoints for small selections, or bulk repo comment pages when efficient.
 */
async function fetchAllPages(baseUrl, pat, signal, onHeaders, maxPages = 10) {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
        const batch = await fetchWithRetry(`${baseUrl}&page=${page}`, pat, signal, onHeaders);
        if (!Array.isArray(batch) || batch.length === 0) return { items, truncated: false };
        items.push(...batch);
        if (batch.length < 100) return { items, truncated: false };
    }
    return { items, truncated: true };
}

export async function fetchCommentsForIssues(owner, repo, selectedIssues, options = {}) {
    const {
        pat = '',
        signal,
        onHeaders,
        onProgress,
        onThread,
        throttleMs = 60,
        maxCommentPages = 10
    } = options;

    const commentsByIssue = new Map();
    const failures = [];
    const needsComments = selectedIssues.filter(iss => iss.commentsCount > 0);

    if (needsComments.length === 0) {
        return { commentsByIssue, failures };
    }

    const concurrency = 4;
    let idx = 0;
    let completed = 0;

    async function worker() {
        while (idx < needsComments.length) {
            if (signal && signal.aborted) break;
            const current = needsComments[idx++];
            const baseUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${current.number}/comments?per_page=100`;

            try {
                const { items: rawComments, truncated } = await fetchAllPages(baseUrl, pat, signal, onHeaders, maxCommentPages);
                const formatted = (rawComments || []).map(c => ({
                    id: c.id,
                    author: c.user ? c.user.login : 'ghost',
                    authorType: c.user ? c.user.type : 'User',
                    authorAssociation: c.author_association || 'NONE',
                    createdAt: c.created_at ? c.created_at.slice(0, 10) : '',
                    reactionsPlusOne: (c.reactions && c.reactions['+1']) || 0,
                    body: c.body || ''
                }));
                if (truncated) formatted.truncated = true;
                commentsByIssue.set(current.number, formatted);
                if (onThread) {
                    try { onThread(current.number, formatted); } catch (_) {}
                }
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                failures.push({ number: current.number, error: err.message || String(err) });
            }

            completed++;
            if (onProgress) onProgress(completed, needsComments.length);
            if (throttleMs > 0) await sleep(throttleMs, signal);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, needsComments.length) }, () => worker());
    await Promise.all(workers);

    if (signal && signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }

    return { commentsByIssue, failures };
}
