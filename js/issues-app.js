/**
 * Controller for GitHub Issues Explorer & Context Packer (issues.html)
 */
import { parseRepoInput, fetchRateLimit, sleep } from './github-api.js';
import { fetchIssuesManifest, fetchCommentsForIssues } from './github-issues-api.js';
import { processIssueThread, extractIssueReferences } from './issue-cleaner.js';
import { buildIssuesOutput, chunkIssuesOutput } from './issue-formatters.js';
import { escapeXml } from './formatters.js';
import { estimateTokens, estimateTokensAsync } from './tokenizer.js';
import { scanForSecrets } from './secrets.js';
import { switchTab } from './ui-tabs.js';

let abortController = null;
let allIssues = [];
let selectedIssueNumbers = new Set();
let cachedCommentsByIssue = new Map();
let fetchFailuresMap = new Map();
let nlpResults = { clusters: [], ngrams: [], similarMap: {} };
let activeTopicFilter = null;
let currentRepoInfo = null;
let generatedChunks = [];
let activeChunkIndex = 0;
let packedOutputText = '';
let outputExt = 'xml';
let outputMime = 'application/xml';
let currentBudgetWindow = 200000;
let currentAppState = 'empty';
let nlpWorker = null;
let buildGeneration = 0;
let inputDebounceTimer = null;

const dom = {
    repoUrl: document.getElementById('repoUrl'),
    switchToCodeLink: document.getElementById('switchToCodeLink'),
    maxIssuesLimit: document.getElementById('maxIssuesLimit'),
    includePrs: document.getElementById('includePrs'),
    pat: document.getElementById('pat'),
    loadIssuesBtn: document.getElementById('loadIssuesBtn'),
    abortBtn: document.getElementById('abortBtn'),
    optionsToggleBtn: document.getElementById('optionsToggleBtn'),
    optionsDrawer: document.getElementById('optionsDrawer'),
    repoInputError: document.getElementById('repoInputError'),
    quotaVal: document.getElementById('quotaVal'),
    resetVal: document.getElementById('resetVal'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    shareUrlBtn: document.getElementById('shareUrlBtn'),

    format: document.getElementById('format'),
    commentScope: document.getElementById('commentScope'),
    maxLogLines: document.getElementById('maxLogLines'),
    chunkLimit: document.getElementById('chunkLimit'),
    stripImages: document.getElementById('stripImages'),
    filterBots: document.getElementById('filterBots'),
    filterNoise: document.getElementById('filterNoise'),
    includeNlpSummary: document.getElementById('includeNlpSummary'),
    redactSecrets: document.getElementById('redactSecrets'),
    aggressiveRedact: document.getElementById('aggressiveRedact'),
    stripTemplates: document.getElementById('stripTemplates'),
    aiInstructions: document.getElementById('aiInstructions'),
    instructionsCharCount: document.getElementById('instructionsCharCount'),
    clearInstructionsBtn: document.getElementById('clearInstructionsBtn'),

    nlpBanner: document.getElementById('nlpBanner'),
    nlpMetaBadge: document.getElementById('nlpMetaBadge'),
    nlpBody: document.getElementById('nlpBody'),
    topicClustersContainer: document.getElementById('topicClustersContainer'),
    ngramsContainer: document.getElementById('ngramsContainer'),
    clearNlpFilterBtn: document.getElementById('clearNlpFilterBtn'),
    selectActiveTopicBtn: document.getElementById('selectActiveTopicBtn'),
    toggleNlpCollapseBtn: document.getElementById('toggleNlpCollapseBtn'),

    statTokens: document.getElementById('statTokens'),
    targetBudgetDisplay: document.getElementById('targetBudgetDisplay'),
    budgetFill: document.getElementById('budgetFill'),
    budgetStatusText: document.getElementById('budgetStatusText'),
    statChunks: document.getElementById('statChunks'),
    statIssues: document.getElementById('statIssues'),
    statComments: document.getElementById('statComments'),
    statChars: document.getElementById('statChars'),

    issuesCard: document.getElementById('issuesCard'),
    selectedTokensBadge: document.getElementById('selectedTokensBadge'),
    issueSearchInput: document.getElementById('issueSearchInput'),
    searchMatchCount: document.getElementById('searchMatchCount'),
    stateFilter: document.getElementById('stateFilter'),
    labelFilter: document.getElementById('labelFilter'),
    sortFilter: document.getElementById('sortFilter'),
    dateFromFilter: document.getElementById('dateFromFilter'),
    dateToFilter: document.getElementById('dateToFilter'),
    minCommentsFilter: document.getElementById('minCommentsFilter'),
    selectAllVisibleBtn: document.getElementById('selectAllVisibleBtn'),
    deselectAllBtn: document.getElementById('deselectAllBtn'),
    selectLinkedBtn: document.getElementById('selectLinkedBtn'),
    exportNlpOnlyBtn: document.getElementById('exportNlpOnlyBtn'),
    issuesEmptyState: document.getElementById('issuesEmptyState'),
    issuesListContainer: document.getElementById('issuesListContainer'),
    buildContextBtn: document.getElementById('buildContextBtn'),

    outputCard: document.getElementById('outputCard'),
    chunkSelectLabel: document.getElementById('chunkSelectLabel'),
    chunkSelect: document.getElementById('chunkSelect'),
    wrapToggleBtn: document.getElementById('wrapToggleBtn'),
    copyBtn: document.getElementById('copyBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    downloadAllBtn: document.getElementById('downloadAllBtn'),
    secretsWarningPanel: document.getElementById('secretsWarningPanel'),
    secretsWarningSummary: document.getElementById('secretsWarningSummary'),
    excludeAllSecretsBtn: document.getElementById('excludeAllSecretsBtn'),
    secretsTableBody: document.getElementById('secretsTableBody'),
    previewNotice: document.getElementById('previewNotice'),
    outputEmptyState: document.getElementById('outputEmptyState'),
    previewArea: document.getElementById('previewArea'),

    logHeader: document.getElementById('logHeader'),
    logSummary: document.getElementById('logSummary'),
    logToggleBtn: document.getElementById('logToggleBtn'),
    progressTrack: document.getElementById('progressTrack'),
    progressFill: document.getElementById('progressFill'),
    log: document.getElementById('log'),
    tabIssuesBtn: document.getElementById('tabIssuesBtn'),
    tabOutputBtn: document.getElementById('tabOutputBtn'),
    mobilePrimaryBtn: document.getElementById('mobilePrimaryBtn'),
    step1: document.getElementById('step1'),
    step2: document.getElementById('step2'),
    step3: document.getElementById('step3'),
    toastContainer: document.getElementById('toastContainer')
};

function showToast(message, type = 'info') {
    if (!dom.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
    }, 3500);
}

function log(msg) {
    if (dom.log) {
        dom.log.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
        dom.log.scrollTop = dom.log.scrollHeight;
    }
    if (dom.logSummary) {
        dom.logSummary.textContent = msg.replace(/^\[[A-Z]+\]\s*/, '');
    }
}

function updateProgressBar(percent) {
    const val = Math.min(100, Math.max(0, Math.round(percent)));
    if (dom.progressFill) dom.progressFill.style.width = `${val}%`;
    if (dom.progressTrack) dom.progressTrack.setAttribute('aria-valuenow', val.toString());
}

function setAppState(state) {
    currentAppState = state;
    if (dom.step1) dom.step1.classList.toggle('active', state === 'empty');
    if (dom.step2) dom.step2.classList.toggle('active', state === 'loaded');
    if (dom.step3) dom.step3.classList.toggle('active', state === 'built');

    if (dom.mobilePrimaryBtn) {
        dom.mobilePrimaryBtn.textContent = state === 'empty'
            ? 'Load issues'
            : state === 'loaded'
                ? 'Fetch threads & build'
                : 'Copy context';
    }
}

function initTheme() {
    try {
        const savedTheme = localStorage.getItem('app_theme');
        if (savedTheme === 'dark' || savedTheme === 'light') {
            document.documentElement.setAttribute('data-theme', savedTheme);
        }
    } catch (_) {}
}
initTheme();

if (dom.themeToggleBtn) {
    dom.themeToggleBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const isDarkSystem = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const next = current === 'dark' ? 'light' : current === 'light' ? 'dark' : (isDarkSystem ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('app_theme', next); } catch (_) {}
    });
}

if (dom.switchToCodeLink) {
    dom.switchToCodeLink.addEventListener('click', () => {
        const repoVal = dom.repoUrl ? dom.repoUrl.value.trim() : '';
        if (repoVal) {
            dom.switchToCodeLink.href = `index.html?repo=${encodeURIComponent(repoVal)}`;
        }
    });
}

let lastRateLimitRemaining = Infinity;

function updateRateLimitUI(meta) {
    if (!meta) return;
    if (meta.remaining !== null && meta.remaining !== undefined && meta.limit !== null) {
        lastRateLimitRemaining = meta.remaining;
        dom.quotaVal.textContent = `${meta.remaining} / ${meta.limit}`;
        dom.quotaVal.className = meta.remaining < 5 ? 'rate-critical' : meta.remaining < 20 ? 'rate-warning' : 'rate-normal';
    }
    if (meta.reset) {
        const resetDate = new Date(meta.reset * 1000);
        dom.resetVal.textContent = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
}

async function refreshRateLimitBadge() {
    try {
        const info = await fetchRateLimit(dom.pat.value.trim());
        updateRateLimitUI(info);
    } catch (_) {}
}
if (dom.repoUrl) {
    dom.repoUrl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            dom.loadIssuesBtn.click();
        }
    });
}

dom.pat.addEventListener('change', refreshRateLimitBadge);
refreshRateLimitBadge();

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('repo') && dom.repoUrl) {
    dom.repoUrl.value = urlParams.get('repo');
}

dom.optionsToggleBtn.addEventListener('click', () => {
    const isOpen = dom.optionsDrawer.classList.toggle('open');
    dom.optionsToggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
});

let logOpen = false;
dom.logToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    logOpen = !logOpen;
    dom.log.style.display = logOpen ? 'block' : 'none';
    dom.logToggleBtn.textContent = logOpen ? 'Hide log' : 'Details';
});
dom.logHeader.addEventListener('click', () => dom.logToggleBtn.click());

dom.toggleNlpCollapseBtn.addEventListener('click', () => {
    const hidden = dom.nlpBody.style.display === 'none';
    dom.nlpBody.style.display = hidden ? 'grid' : 'none';
    dom.toggleNlpCollapseBtn.textContent = hidden ? 'Hide insights' : 'Show insights';
});

function getFilteredIssues() {
    const q = (dom.issueSearchInput.value || '').trim().toLowerCase();
    const stateVal = dom.stateFilter.value;
    const labelVal = dom.labelFilter.value;
    const sortVal = dom.sortFilter.value;
    const dateFrom = dom.dateFromFilter.value;
    const dateTo = dom.dateToFilter.value;
    const minComments = parseInt(dom.minCommentsFilter.value, 10) || 0;

    const filtered = allIssues.filter(iss => {
        if (activeTopicFilter && !activeTopicFilter.numbers.has(iss.number)) return false;

        if (stateVal === 'open' && iss.state !== 'open') return false;
        if (stateVal === 'closed' && iss.state !== 'closed') return false;
        if (stateVal === 'completed' && (iss.state !== 'closed' || iss.stateReason !== 'completed')) return false;
        if (stateVal === 'not_planned' && (iss.state !== 'closed' || iss.stateReason !== 'not_planned')) return false;

        if (labelVal && !iss.labels.includes(labelVal)) return false;
        if (dateFrom && iss.createdAt < dateFrom) return false;
        if (dateTo && iss.createdAt > dateTo) return false;
        if (iss.commentsCount < minComments) return false;

        if (q) {
            const matchNum = `#${iss.number}` === q || String(iss.number) === q;
            const matchText = iss.title.toLowerCase().includes(q) ||
                iss.body.toLowerCase().includes(q) ||
                iss.author.toLowerCase().includes(q);
            if (!matchNum && !matchText) return false;
        }
        return true;
    });

    filtered.sort((a, b) => {
        if (sortVal === 'oldest') return a.number - b.number;
        if (sortVal === 'comments') return b.commentsCount - a.commentsCount;
        if (sortVal === 'reactions') return b.reactionsTotal - a.reactionsTotal;
        return b.number - a.number;
    });

    return filtered;
}

function updateSelectionTelemetry() {
    const selectedList = allIssues.filter(iss => selectedIssueNumbers.has(iss.number));
    let totalBodyBytes = 0;
    for (const iss of selectedList) {
        totalBodyBytes += (iss.title.length + iss.body.length);
    }
    const estBodyTokens = Math.round(totalBodyBytes / 3.8);
    dom.selectedTokensBadge.textContent = `${selectedList.length} selected (~${estBodyTokens.toLocaleString()} body tok)`;
}

function renderIssuesList() {
    const visible = getFilteredIssues();
    dom.searchMatchCount.textContent = `${visible.length} / ${allIssues.length}`;

    if (allIssues.length === 0) {
        dom.issuesEmptyState.style.display = 'flex';
        dom.issuesListContainer.style.display = 'none';
        return;
    }

    dom.issuesEmptyState.style.display = 'none';
    dom.issuesListContainer.style.display = 'block';
    dom.issuesListContainer.innerHTML = '';

    const fragment = document.createDocumentFragment();

    for (const iss of visible) {
        const li = document.createElement('li');
        li.className = 'issue-item';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'issue-checkbox';
        cb.checked = selectedIssueNumbers.has(iss.number);

        cb.addEventListener('change', (e) => {
            e.stopPropagation();
            if (cb.checked) selectedIssueNumbers.add(iss.number);
            else selectedIssueNumbers.delete(iss.number);
            updateSelectionTelemetry();
        });

        li.addEventListener('click', (e) => {
            if (e.target === cb || e.target.classList.contains('issue-sim-badge')) return;
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change'));
        });

        const main = document.createElement('div');
        main.className = 'issue-main';

        const titleRow = document.createElement('div');
        titleRow.className = 'issue-title-row';

        const badge = document.createElement('span');
        const isNotPlanned = iss.state === 'closed' && iss.stateReason === 'not_planned';
        badge.className = `issue-state-badge ${iss.state === 'open' ? 'issue-state-open' : isNotPlanned ? 'issue-state-not-planned' : 'issue-state-closed'}`;
        badge.textContent = isNotPlanned ? 'not planned' : iss.state;

        const numSpan = document.createElement('span');
        numSpan.className = 'issue-number';
        numSpan.textContent = `#${iss.number}`;

        const titleSpan = document.createElement('span');
        titleSpan.className = 'issue-title';
        titleSpan.textContent = iss.title;

        titleRow.append(badge, numSpan, titleSpan);

        const metaRow = document.createElement('div');
        metaRow.className = 'issue-meta-row';
        metaRow.innerHTML = `<span>@${escapeXml(iss.author)}</span><span>• ${escapeXml(iss.createdAt)}</span><span>• 💬 ${iss.commentsCount}</span>`;
        if (iss.reactionsTotal > 0) {
            metaRow.innerHTML += `<span>• 👍 ${iss.reactionsTotal}</span>`;
        }

        for (const lbl of iss.labels.slice(0, 4)) {
            const pill = document.createElement('span');
            pill.className = 'issue-label-pill';
            pill.textContent = lbl;
            metaRow.appendChild(pill);
        }

        const simList = nlpResults.similarMap && nlpResults.similarMap[iss.number];
        if (simList && simList.length > 0) {
            const simBtn = document.createElement('button');
            simBtn.type = 'button';
            simBtn.className = 'issue-sim-badge';
            simBtn.title = `Click to also select similar issue(s): ${simList.map(n => '#' + n).join(', ')}`;
            simBtn.textContent = `~${simList.length} similar (${simList.slice(0, 2).map(n => '#' + n).join(', ')})`;
            simBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                selectedIssueNumbers.add(iss.number);
                simList.forEach(n => selectedIssueNumbers.add(n));
                renderIssuesList();
                updateSelectionTelemetry();
                showToast(`Selected #${iss.number} and ${simList.length} similar issue(s).`, 'info');
            });
            metaRow.appendChild(simBtn);
        }

        main.append(titleRow, metaRow);
        li.append(cb, main);
        fragment.appendChild(li);
    }

    dom.issuesListContainer.appendChild(fragment);
    updateSelectionTelemetry();
}

[dom.issueSearchInput, dom.stateFilter, dom.labelFilter, dom.sortFilter, dom.dateFromFilter, dom.dateToFilter, dom.minCommentsFilter].forEach(el => {
    if (el) el.addEventListener('input', renderIssuesList);
});

let currentNlpRequestId = 0;

function runNlpAnalysis(issues) {
    if (!nlpWorker) {
        nlpWorker = new Worker(new URL('./nlp.worker.js', import.meta.url), { type: 'module' });
        nlpWorker.onmessage = (e) => {
            if (!e.data || e.data.id !== currentNlpRequestId) return;
            nlpResults = e.data || { clusters: [], ngrams: [], similarMap: {} };
            renderNlpBanner();
            renderIssuesList();
        };
        nlpWorker.onerror = (err) => {
            log(`[WARN] NLP worker error: ${err.message || String(err)}`);
        };
    }
    currentNlpRequestId++;
    nlpWorker.postMessage({
        id: currentNlpRequestId,
        issues: issues.map(i => ({ number: i.number, title: i.title, body: i.body }))
    });
}

function renderNlpBanner() {
    if (!allIssues.length) {
        dom.nlpBanner.style.display = 'none';
        return;
    }
    dom.nlpBanner.style.display = 'flex';
    dom.nlpMetaBadge.textContent = `${nlpResults.clusters.length} clusters, ${nlpResults.ngrams.length} key phrases across ${allIssues.length} issues`;

    dom.topicClustersContainer.innerHTML = '';
    for (const c of nlpResults.clusters) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isActive = activeTopicFilter && activeTopicFilter.label === c.label;
        btn.className = `nlp-pill${isActive ? ' active' : ''}`;
        btn.innerHTML = `<span>${escapeXml(c.label)}</span><span class="nlp-pill-count">${c.count}</span>`;
        btn.addEventListener('click', () => toggleTopicFilter('cluster', c.label, c.issueNumbers));
        dom.topicClustersContainer.appendChild(btn);
    }

    dom.ngramsContainer.innerHTML = '';
    for (const ng of nlpResults.ngrams) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isActive = activeTopicFilter && activeTopicFilter.label === ng.phrase;
        btn.className = `nlp-pill${isActive ? ' active' : ''}`;
        btn.innerHTML = `<span>"${escapeXml(ng.phrase)}"</span><span class="nlp-pill-count">${ng.count}</span>`;
        btn.addEventListener('click', () => toggleTopicFilter('ngram', ng.phrase, ng.issueNumbers));
        dom.ngramsContainer.appendChild(btn);
    }
}

function toggleTopicFilter(type, label, issueNumbers) {
    if (activeTopicFilter && activeTopicFilter.label === label) {
        activeTopicFilter = null;
        dom.clearNlpFilterBtn.style.display = 'none';
        dom.selectActiveTopicBtn.style.display = 'none';
    } else {
        activeTopicFilter = { type, label, numbers: new Set(issueNumbers) };
        dom.clearNlpFilterBtn.style.display = 'inline-flex';
        dom.selectActiveTopicBtn.style.display = 'inline-flex';
    }
    renderNlpBanner();
    renderIssuesList();
}

dom.clearNlpFilterBtn.addEventListener('click', () => {
    activeTopicFilter = null;
    dom.clearNlpFilterBtn.style.display = 'none';
    dom.selectActiveTopicBtn.style.display = 'none';
    renderNlpBanner();
    renderIssuesList();
});

dom.selectActiveTopicBtn.addEventListener('click', () => {
    if (!activeTopicFilter) return;
    for (const num of activeTopicFilter.numbers) {
        selectedIssueNumbers.add(num);
    }
    renderIssuesList();
    showToast(`Selected ${activeTopicFilter.numbers.size} issues in "${activeTopicFilter.label}".`, 'info');
});

dom.selectAllVisibleBtn.addEventListener('click', () => {
    const visible = getFilteredIssues();
    for (const iss of visible) selectedIssueNumbers.add(iss.number);
    renderIssuesList();
});

dom.deselectAllBtn.addEventListener('click', () => {
    selectedIssueNumbers.clear();
    renderIssuesList();
});

dom.selectLinkedBtn.addEventListener('click', () => {
    const knownNumbers = new Set(allIssues.map(i => i.number));
    let added = 0;
    for (const iss of allIssues) {
        if (!selectedIssueNumbers.has(iss.number)) continue;
        const refs = extractIssueReferences(iss.body, iss.number);
        for (const r of refs) {
            if (knownNumbers.has(r) && !selectedIssueNumbers.has(r)) {
                selectedIssueNumbers.add(r);
                added++;
            }
        }
    }
    renderIssuesList();
    showToast(added > 0 ? `Added ${added} cross-referenced issue(s).` : 'No new linked issues found in current selection.', 'info');
});

dom.loadIssuesBtn.addEventListener('click', async () => {
    dom.repoInputError.style.display = 'none';
    const repoInfo = parseRepoInput(dom.repoUrl.value);
    if (!repoInfo) {
        dom.repoInputError.style.display = 'block';
        return;
    }

    if (abortController) abortController.abort();
    abortController = new AbortController();

    currentRepoInfo = repoInfo;
    allIssues = [];
    selectedIssueNumbers.clear();
    cachedCommentsByIssue.clear();
    fetchFailuresMap.clear();
    activeTopicFilter = null;
    nlpResults = { clusters: [], ngrams: [], similarMap: {} };
    currentNlpRequestId++;
    renderNlpBanner();

    dom.loadIssuesBtn.disabled = true;
    dom.abortBtn.style.display = 'inline-flex';
    dom.progressTrack.style.display = 'block';
    updateProgressBar(5);

    const maxItems = parseInt(dom.maxIssuesLimit.value, 10) || 300;
    const itemType = dom.includePrs.value;
    const pat = dom.pat.value.trim();

    try {
        log(`[FETCH] Loading up to ${maxItems} ${itemType} from ${repoInfo.owner}/${repoInfo.repo}...`);
        const manifest = await fetchIssuesManifest(repoInfo.owner, repoInfo.repo, {
            maxItems,
            itemType,
            pat,
            signal: abortController.signal,
            onHeaders: updateRateLimitUI,
            onProgress: (loaded, total) => updateProgressBar((loaded / total) * 100)
        });

        allIssues = manifest;
        const openOnes = allIssues.filter(i => i.state === 'open');
        const initialSelect = (openOnes.length > 0 ? openOnes : allIssues).slice(0, 25);
        for (const iss of initialSelect) selectedIssueNumbers.add(iss.number);

        const labelCounts = new Map();
        for (const iss of allIssues) {
            for (const l of iss.labels) labelCounts.set(l, (labelCounts.get(l) || 0) + 1);
        }
        const sortedLabels = Array.from(labelCounts.entries()).sort((a, b) => b[1] - a[1]);
        dom.labelFilter.innerHTML = `<option value="">Label: All labels (${sortedLabels.length})</option>` +
            sortedLabels.map(([l, cnt]) => `<option value="${escapeXml(l)}">${escapeXml(l)} (${cnt})</option>`).join('');

        renderIssuesList();
        runNlpAnalysis(allIssues);
        setAppState('loaded');

        if (manifest.stoppedEarly) {
            log(`[WARN] Reached scan limit (30 pages). Found ${allIssues.length} items.`);
            showToast(`Scanned 30 pages, found ${allIssues.length} items. Raise limit or select 'Issues & PRs'.`, 'warn');
        } else {
            log(`[SUCCESS] Loaded ${allIssues.length} items. Running background NLP topic clustering...`);
            showToast(`Loaded ${allIssues.length} items.`, 'info');
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            log('[CANCEL] Manifest load cancelled.');
        } else {
            log(`[ERROR] ${err.message}`);
            showToast(err.message, 'error');
        }
    } finally {
        dom.loadIssuesBtn.disabled = false;
        dom.abortBtn.style.display = 'none';
    }
});

async function buildSelectedContext(summaryOnly = false) {
    if (!currentRepoInfo || allIssues.length === 0) return;

    buildGeneration++;
    const thisBuildGen = buildGeneration;

    const targetIssues = summaryOnly
        ? getFilteredIssues()
        : allIssues.filter(i => selectedIssueNumbers.has(i.number));

    if (targetIssues.length === 0) {
        showToast('Select at least one issue first.', 'warn');
        return;
    }

    const commentScope = summaryOnly ? 'none' : dom.commentScope.value;
    const pat = dom.pat.value.trim();

    if (commentScope !== 'none') {
        const missingComments = targetIssues.filter(i => i.commentsCount > 0 && !cachedCommentsByIssue.has(i.number));
        if (missingComments.length > 0) {
            if (lastRateLimitRemaining !== Infinity && missingComments.length > (lastRateLimitRemaining - 5)) {
                log(`[WARN] Quota warning: Comment fetch needs ~${missingComments.length} API requests, but only ${lastRateLimitRemaining} remaining.`);
                showToast(`Fetching comments needs ~${missingComments.length} requests; only ${lastRateLimitRemaining} quota left. Add a GitHub token to raise limit.`, 'warn');
            }

            if (abortController) abortController.abort();
            abortController = new AbortController();
            const myController = abortController;
            dom.abortBtn.style.display = 'inline-flex';
            dom.buildContextBtn.disabled = true;
            dom.progressTrack.style.display = 'block';
            updateProgressBar(0);

            try {
                log(`[FETCH] Fetching comment threads for ${missingComments.length} issue(s)...`);
                const { commentsByIssue: fetchedMap, failures } = await fetchCommentsForIssues(currentRepoInfo.owner, currentRepoInfo.repo, missingComments, {
                    pat,
                    signal: abortController.signal,
                    onHeaders: updateRateLimitUI,
                    onProgress: (done, total) => updateProgressBar((done / total) * 100)
                });
                for (const [num, comms] of fetchedMap.entries()) {
                    cachedCommentsByIssue.set(num, comms);
                    fetchFailuresMap.delete(num);
                }
                if (thisBuildGen !== buildGeneration) return;
                if (failures && failures.length > 0) {
                    for (const f of failures) {
                        fetchFailuresMap.set(f.number, f.error);
                    }
                    log(`[WARN] ${failures.length} thread(s) failed to load comments.`);
                    showToast(`${failures.length} thread(s) failed to load comments. Rebuild to retry.`, 'warn');
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    log('[CANCEL] Comment fetch cancelled.');
                    return;
                }
                log(`[ERROR] Comment fetch error: ${err.message}`);
                showToast(err.message, 'error');
            } finally {
                if (abortController === myController) {
                    dom.buildContextBtn.disabled = false;
                    dom.abortBtn.style.display = 'none';
                }
            }
        }
    }

    if (thisBuildGen !== buildGeneration) return;

    const cleanOptions = {
        commentScope,
        stripImages: dom.stripImages.checked,
        filterBots: dom.filterBots.checked,
        filterNoise: dom.filterNoise.checked,
        stripTemplates: dom.stripTemplates.checked,
        isRedact: dom.redactSecrets ? dom.redactSecrets.checked : true,
        aggressiveRedact: dom.aggressiveRedact ? dom.aggressiveRedact.checked : true,
        maxLogLines: parseInt(dom.maxLogLines.value, 10) || 0,
        knownNumbers: new Set(allIssues.map(i => i.number))
    };

    const secretRows = [];
    const flaggedNumbers = new Set();
    for (const iss of targetIssues) {
        const rawComms = cachedCommentsByIssue.get(iss.number) || [];
        const combinedRaw = `${iss.body}\n` + rawComms.map(c => c.body).join('\n');
        const findings = scanForSecrets(`Issue #${iss.number}`, combinedRaw);
        if (findings.length > 0) {
            flaggedNumbers.add(iss.number);
            for (const f of findings) {
                secretRows.push({ number: iss.number, type: f.type, line: f.line, preview: f.preview });
            }
        }
    }
    updateSecretsPanel(secretRows, flaggedNumbers);

    const processedIssues = summaryOnly
        ? []
        : targetIssues.map(iss => {
            const rawComms = cachedCommentsByIssue.get(iss.number) || [];
            const commsFailed = fetchFailuresMap.has(iss.number) && !cachedCommentsByIssue.has(iss.number);
            const commsError = fetchFailuresMap.get(iss.number) || null;
            return processIssueThread(iss, rawComms, {
                ...cleanOptions,
                commentsFetchFailed: commsFailed,
                commentsFetchError: commsError,
                commentsTruncated: Boolean(rawComms.truncated)
            });
        });

    const totalCommentsIncluded = processedIssues.reduce((acc, i) => acc + i.cleanedComments.length, 0);
    const chunkLimitVal = parseInt(dom.chunkLimit.value, 10) || 0;

    const formatOptions = {
        instructions: dom.aiInstructions.value,
        includeNlpSummary: summaryOnly ? true : dom.includeNlpSummary.checked,
        nlpData: nlpResults
    };

    generatedChunks = chunkIssuesOutput(
        dom.format.value,
        currentRepoInfo,
        processedIssues,
        chunkLimitVal,
        estimateTokens,
        formatOptions
    );

    activeChunkIndex = 0;
    const firstChunk = generatedChunks[0];
    packedOutputText = firstChunk.text;
    outputExt = firstChunk.ext;
    outputMime = firstChunk.mime;

    const chunkTokenList = await Promise.all(generatedChunks.map(c => estimateTokensAsync(c.text)));
    if (thisBuildGen !== buildGeneration) return;

    const totalTokens = chunkTokenList.reduce((a, b) => a + b, 0);
    const totalChars = generatedChunks.reduce((acc, c) => acc + c.text.length, 0);

    let hasOversizedChunk = false;
    generatedChunks.forEach((c, idx) => {
        if (c.exceedsLimit) {
            hasOversizedChunk = true;
            log(`[WARN] Chunk part ${idx + 1}/${generatedChunks.length} exceeds limit of ${chunkLimitVal.toLocaleString()} tokens.`);
        }
    });
    if (hasOversizedChunk) {
        showToast('Warning: 1 or more parts exceed the split token limit.', 'warn');
    }

    dom.statTokens.textContent = totalTokens.toLocaleString();
    dom.statChunks.textContent = generatedChunks.length;
    dom.statIssues.textContent = targetIssues.length;
    dom.statComments.textContent = totalCommentsIncluded.toLocaleString();
    dom.statChars.textContent = totalChars.toLocaleString();

    const pct = Math.min(100, Math.round((totalTokens / currentBudgetWindow) * 100));
    const ratio = totalTokens / currentBudgetWindow;
    dom.budgetFill.style.width = `${pct}%`;
    dom.budgetFill.className = 'budget-fill ' + (ratio <= 0.85 ? 'fits' : ratio <= 1.0 ? 'near' : 'over');
    dom.budgetStatusText.textContent = ratio <= 1.0
        ? `Fits target budget (${generatedChunks.length} part${generatedChunks.length === 1 ? '' : 's'})`
        : `Over budget by ${(totalTokens - currentBudgetWindow).toLocaleString()} tokens`;

    if (generatedChunks.length > 1) {
        dom.chunkSelectLabel.style.display = 'inline-block';
        dom.chunkSelect.style.display = 'inline-block';
        dom.downloadAllBtn.style.display = 'inline-flex';
        dom.chunkSelect.innerHTML = generatedChunks.map((_, i) => `<option value="${i}">Part ${i + 1} of ${generatedChunks.length}</option>`).join('');
    } else {
        dom.chunkSelectLabel.style.display = 'none';
        dom.chunkSelect.style.display = 'none';
        dom.downloadAllBtn.style.display = 'none';
    }

    dom.outputEmptyState.style.display = 'none';
    dom.previewNotice.style.display = packedOutputText.length > 45000 ? 'block' : 'none';
    dom.previewArea.style.display = 'block';
    dom.previewArea.value = packedOutputText.slice(0, 45000) + (packedOutputText.length > 45000 ? '\n\n... [Truncated for preview] ...' : '');
    dom.copyBtn.disabled = false;
    dom.downloadBtn.disabled = false;

    setAppState('built');
    log(`[SUCCESS] Packed ${targetIssues.length} issues & ${totalCommentsIncluded} comments (~${totalTokens.toLocaleString()} tokens).`);
}

function updateSecretsPanel(rows, flaggedNumbers) {
    if (rows.length === 0) {
        dom.secretsWarningPanel.style.display = 'none';
        return;
    }
    dom.secretsWarningPanel.style.display = 'flex';

    const isRedactOn = dom.redactSecrets ? dom.redactSecrets.checked : true;
    const isAggressiveOn = dom.aggressiveRedact ? dom.aggressiveRedact.checked : true;

    let redactedCount = 0;
    let presentCount = 0;

    const rowData = rows.map(r => {
        const isRedacted = isRedactOn && (r.type !== 'generic-secret' || isAggressiveOn);
        if (isRedacted) redactedCount++;
        else presentCount++;
        return {
            ...r,
            isRedacted
        };
    });

    if (presentCount > 0) {
        const hint = (!isAggressiveOn && isRedactOn)
            ? ' (enable Aggressive redaction or deselect issue)'
            : ' (enable Redact secrets or deselect issue)';
        dom.secretsWarningSummary.textContent = `${rows.length} secret(s) in ${flaggedNumbers.size} issue(s): ${redactedCount} redacted, ${presentCount} still present${hint}.`;
    } else {
        dom.secretsWarningSummary.textContent = `${rows.length} secret(s) in ${flaggedNumbers.size} issue(s) (all redacted).`;
    }

    dom.secretsTableBody.innerHTML = rowData.map(r => `
        <tr>
            <td>#${r.number}</td>
            <td>${escapeXml(r.type)}</td>
            <td>${r.line}</td>
            <td>${escapeXml(r.preview)}</td>
            <td>${r.isRedacted ? '<span class="status-fits" style="font-weight:600;">Redacted</span>' : '<span class="status-over" style="font-weight:600;">Present in output</span>'}</td>
            <td><button type="button" class="secondary btn-xs deselect-secret-issue" data-num="${r.number}">Deselect #${r.number}</button></td>
        </tr>
    `).join('');

    dom.secretsTableBody.querySelectorAll('.deselect-secret-issue').forEach(btn => {
        btn.addEventListener('click', () => {
            const num = parseInt(btn.getAttribute('data-num'), 10);
            selectedIssueNumbers.delete(num);
            renderIssuesList();
            buildSelectedContext(false);
        });
    });

    dom.excludeAllSecretsBtn.onclick = () => {
        for (const num of flaggedNumbers) selectedIssueNumbers.delete(num);
        renderIssuesList();
        buildSelectedContext(false);
    };
}

dom.buildContextBtn.addEventListener('click', () => buildSelectedContext(false));
dom.exportNlpOnlyBtn.addEventListener('click', () => buildSelectedContext(true));
dom.abortBtn.addEventListener('click', () => { if (abortController) abortController.abort(); });

[dom.format, dom.commentScope, dom.maxLogLines, dom.chunkLimit, dom.stripImages, dom.filterBots, dom.filterNoise, dom.includeNlpSummary, dom.redactSecrets, dom.aggressiveRedact, dom.stripTemplates].forEach(el => {
    if (el) el.addEventListener('change', () => {
        if (currentAppState === 'built') buildSelectedContext(false);
    });
});

dom.aiInstructions.addEventListener('input', () => {
    dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
    if (currentAppState === 'built') {
        if (inputDebounceTimer) clearTimeout(inputDebounceTimer);
        inputDebounceTimer = setTimeout(() => {
            buildSelectedContext(false);
        }, 300);
    }
});

if (dom.tabIssuesBtn && dom.tabOutputBtn) {
    dom.tabIssuesBtn.addEventListener('click', () => {
        switchTab(dom.tabIssuesBtn, dom.tabOutputBtn, dom.issuesCard, dom.outputCard);
    });

    dom.tabOutputBtn.addEventListener('click', () => {
        switchTab(dom.tabOutputBtn, dom.tabIssuesBtn, dom.outputCard, dom.issuesCard);
    });

    const tabs = [dom.tabIssuesBtn, dom.tabOutputBtn];
    tabs.forEach((tab, index) => {
        tab.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const nextIndex = (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                tabs[nextIndex].focus();
                tabs[nextIndex].click();
            }
        });
    });
}

if (dom.mobilePrimaryBtn) {
    dom.mobilePrimaryBtn.addEventListener('click', async () => {
        if (currentAppState === 'empty') {
            dom.loadIssuesBtn.click();
        } else if (currentAppState === 'loaded') {
            await buildSelectedContext(false);
            if (dom.tabOutputBtn) dom.tabOutputBtn.click();
        } else if (currentAppState === 'built') {
            dom.copyBtn.click();
        }
    });
}

dom.clearInstructionsBtn.addEventListener('click', () => {
    dom.aiInstructions.value = '';
    dom.instructionsCharCount.textContent = '0 chars';
    if (currentAppState === 'built') buildSelectedContext(false);
});

document.querySelectorAll('.preset-buttons button[data-instruction]').forEach(btn => {
    btn.addEventListener('click', () => {
        dom.aiInstructions.value = btn.getAttribute('data-instruction');
        dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
        if (currentAppState === 'built') buildSelectedContext(false);
    });
});

document.querySelectorAll('.budget-presets .preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const val = parseInt(btn.getAttribute('data-preset'), 10);
        if (val) {
            currentBudgetWindow = val;
            dom.targetBudgetDisplay.textContent = `of ${val.toLocaleString()} estimated tokens`;
            if (currentAppState === 'built') buildSelectedContext(false);
        }
    });
});

dom.chunkSelect.addEventListener('change', () => {
    activeChunkIndex = parseInt(dom.chunkSelect.value, 10) || 0;
    const chunk = generatedChunks[activeChunkIndex];
    if (!chunk) return;
    packedOutputText = chunk.text;
    dom.previewArea.value = packedOutputText.slice(0, 45000) + (packedOutputText.length > 45000 ? '\n\n... [Truncated for preview] ...' : '');
});

function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

dom.downloadBtn.addEventListener('click', () => {
    const repoName = currentRepoInfo ? currentRepoInfo.repo : 'issues';
    const suffix = generatedChunks.length > 1 ? `-part${activeChunkIndex + 1}-of-${generatedChunks.length}` : '';
    triggerDownload(packedOutputText, `${repoName}-issues${suffix}.${outputExt}`, outputMime);
});

dom.downloadAllBtn.addEventListener('click', async () => {
    const repoName = currentRepoInfo ? currentRepoInfo.repo : 'issues';
    for (let i = 0; i < generatedChunks.length; i++) {
        triggerDownload(generatedChunks[i].text, `${repoName}-issues-part${i + 1}-of-${generatedChunks.length}.${generatedChunks[i].ext}`, generatedChunks[i].mime);
        await sleep(150);
    }
});

dom.copyBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(packedOutputText);
        showToast('Copied issues context to clipboard!', 'info');
    } catch (_) {
        showToast('Unable to copy automatically.', 'error');
    }
});

dom.wrapToggleBtn.addEventListener('click', () => {
    dom.previewArea.classList.toggle('wrap');
});

dom.shareUrlBtn.addEventListener('click', async () => {
    const url = new URL(window.location.href.split('?')[0]);
    const repoVal = dom.repoUrl.value.trim();
    if (repoVal) url.searchParams.set('repo', repoVal);
    try {
        await navigator.clipboard.writeText(url.toString());
        showToast('Deep-link URL copied!', 'info');
    } catch (_) {}
});
