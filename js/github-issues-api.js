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
        let apiMessage = '';
        if (res.status === 403 || res.status === 429) {
            try { apiMessage = (await res.clone().json()).message || ''; } catch (_) {}
        }
        if (isRateLimitResponse(res, meta) || (res.status === 403 && /rate limit|abuse/i.test(apiMessage))) {
            const nowSec = Math.floor(Date.now() / 1000);
            const waitSec = meta.retryAfter ?? (meta.reset ? Math.max(1, meta.reset - nowSec) : 60);
            if (waitSec > 90 || retries >= 2) {
                const when = meta.reset ? new Date(meta.reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'later';
                const rlErr = new Error(`GitHub rate limit reached. Resets at ${when}. Add a token to raise the limit.`);
                rlErr.isRateLimit = true;
                throw rlErr;
            }
            retries++;
            await sleep(waitSec * 1000, signal);
            continue;
        }
        if (!apiMessage) {
            try { apiMessage = (await res.clone().json()).message || ''; } catch (_) {}
        }
        throw new Error(`GitHub API error (${res.status}): ${apiMessage || res.statusText || 'request failed'}`);
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

/**
 * Estimates request cost of the two comment strategies.
 * per-issue: one request per 100 comments for every selected issue (min 1 each).
 * bulk: GET /repos/{o}/{r}/issues/comments?since=<oldest selected issue date>, 100 per page,
 *       covering every comment in the repo updated since then (issues AND PRs).
 * `universe` is the loaded issue list, used to estimate how many comments fall in the window.
 */
export function estimateCommentFetchCost(needsComments, universe, maxCommentPages = 10) {
    const perIssue = needsComments.reduce(
        (sum, iss) => sum + Math.min(maxCommentPages, Math.max(1, Math.ceil(iss.commentsCount / 100))), 0);
    const dates = needsComments.map(i => i.createdAt).filter(Boolean).sort();
    const sinceDate = dates.length ? dates[0] : null;
    if (!sinceDate || !Array.isArray(universe) || universe.length === 0) {
        return { perIssue, bulkPages: Infinity, sinceDate };
    }
    const inWindow = universe.reduce((sum, i) => sum + (i.createdAt && i.createdAt >= sinceDate ? (i.commentsCount || 0) : 0), 0);
    return { perIssue, bulkPages: Math.max(1, Math.ceil(inWindow / 100)), sinceDate };
}

export async function fetchCommentsForIssues(owner, repo, selectedIssues, options = {}) {
    const {
        pat = '',
        signal,
        onHeaders,
        onProgress,
        onThread,
        throttleMs = 60,
        maxCommentPages = 10,
        strategy = 'auto', // 'auto' | 'per-issue' | 'bulk'
        universe = null
    } = options;

    const commentsByIssue = new Map();
    const failures = [];
    const stats = { strategy: 'per-issue', requests: 0, bulkPages: 0, bulkVerified: 0, perIssueRequestsEstimate: 0 };
    const countingHeaders = (meta) => { stats.requests++; if (onHeaders) onHeaders(meta); };
    const needsComments = selectedIssues.filter(iss => iss.commentsCount > 0);

    if (needsComments.length === 0) {
        return { commentsByIssue, failures, stats };
    }

    const formatComment = c => ({
        id: c.id,
        author: c.user ? c.user.login : 'ghost',
        authorType: c.user ? c.user.type : 'User',
        authorAssociation: c.author_association || 'NONE',
        createdAt: c.created_at ? c.created_at.slice(0, 10) : '',
        reactionsPlusOne: (c.reactions && c.reactions['+1']) || 0,
        body: c.body || ''
    });

    const cost = estimateCommentFetchCost(needsComments, universe, maxCommentPages);
    stats.perIssueRequestsEstimate = cost.perIssue;
    const useBulk = strategy === 'bulk'
        || (strategy === 'auto' && cost.perIssue >= 4 && cost.bulkPages <= cost.perIssue * 0.3);

    let pending = needsComments;

    if (useBulk && cost.sinceDate) {
        stats.strategy = 'bulk';
        const budget = Math.max(2, Math.ceil(cost.perIssue * 0.35));
        const wanted = new Set(needsComments.map(i => i.number));
        const byIssue = new Map();
        const baseUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments?per_page=100&since=${cost.sinceDate}T00:00:00Z`;
        try {
            const { items } = await fetchAllPages(baseUrl, pat, signal, countingHeaders, budget);
            stats.bulkPages = Math.ceil(items.length / 100);
            for (const c of items) {
                const m = /\/issues\/(\d+)$/.exec(c.issue_url || '');
                if (!m) continue;
                const num = Number(m[1]);
                if (!wanted.has(num)) continue;
                if (!byIssue.has(num)) byIssue.set(num, []);
                byIssue.get(num).push(formatComment(c));
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            if (err.isRateLimit) {
                // Per-issue requests would hit the same wall: report every thread as failed and stop.
                for (const iss of needsComments) failures.push({ number: iss.number, error: err.message });
                stats.rateLimited = true;
                return { commentsByIssue, failures, stats };
            }
            // Bulk failed (e.g. rate limit mid-way): fall back to per-issue for everything.
            byIssue.clear();
        }

        // Accept an issue from the bulk result only when the count matches what the
        // issues list reported; anything else (cut-off pages, new/deleted comments) is
        // re-fetched per issue so we never emit a silently partial thread.
        const stillPending = [];
        let done = 0;
        for (const iss of needsComments) {
            const got = byIssue.get(iss.number);
            if (got && got.length === iss.commentsCount) {
                if (got.length > maxCommentPages * 100) {
                    got.length = maxCommentPages * 100;
                    got.truncated = true;
                }
                commentsByIssue.set(iss.number, got);
                stats.bulkVerified++;
                done++;
                if (onThread) { try { onThread(iss.number, got); } catch (_) {} }
            } else {
                stillPending.push(iss);
            }
        }
        if (onProgress && done > 0) onProgress(done, needsComments.length);
        pending = stillPending;
        if (pending.length === 0) return { commentsByIssue, failures, stats };
        stats.strategy = 'bulk+per-issue';
    }

    const concurrency = 4;
    let idx = 0;
    let completed = needsComments.length - pending.length;

    let rateLimitError = null;
    async function worker() {
        while (idx < pending.length) {
            if (signal && signal.aborted) break;
            if (rateLimitError) break;
            const current = pending[idx++];
            const baseUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${current.number}/comments?per_page=100`;

            try {
                const { items: rawComments, truncated } = await fetchAllPages(baseUrl, pat, signal, countingHeaders, maxCommentPages);
                const formatted = (rawComments || []).map(formatComment);
                if (truncated) formatted.truncated = true;
                commentsByIssue.set(current.number, formatted);
                if (onThread) {
                    try { onThread(current.number, formatted); } catch (_) {}
                }
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                failures.push({ number: current.number, error: err.message || String(err) });
                if (err.isRateLimit) rateLimitError = err;
            }

            completed++;
            if (onProgress) onProgress(completed, needsComments.length);
            if (throttleMs > 0) await sleep(throttleMs, signal);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, pending.length) }, () => worker());
    await Promise.all(workers);

    if (signal && signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }

    if (rateLimitError) {
        stats.rateLimited = true;
        const seen = new Set(failures.map(f => f.number));
        for (const iss of pending) {
            if (!commentsByIssue.has(iss.number) && !seen.has(iss.number)) {
                failures.push({ number: iss.number, error: rateLimitError.message });
            }
        }
    }

    return { commentsByIssue, failures, stats };
}
