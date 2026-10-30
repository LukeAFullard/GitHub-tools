/**
 * Main Application Controller & DOM Orchestration
 */
import { ALWAYS_IGNORED_DIRS, ROOT_IGNORED_DIRS, IGNORED_FILES } from './config.js';

function isIgnoredDirPath(dirParts) {
    if (!dirParts || dirParts.length === 0) return false;
    for (let i = 0; i < dirParts.length; i++) {
        const seg = dirParts[i].toLowerCase();
        if (ALWAYS_IGNORED_DIRS.has(seg)) return true;
        if (i === 0 && ROOT_IGNORED_DIRS.has(seg)) return true;
    }
    return false;
}
import { estimateTokens, estimateTokensAsync } from './tokenizer.js';
import { generateTree, renderInteractiveTree } from './tree.js';
import { buildContextOutput, chunkContextOutput, escapeXml } from './formatters.js';
import { minifyCode } from './minifier.js';
import { scanForSecrets, redactSecrets } from './secrets.js';
import {
    parseRepoInput,
    fetchRateLimit,
    resolveDefaultBranch,
    fetchRepoTree,
    fetchFileContent,
    sleep
} from './github-api.js';

let abortController = null;
let generatedChunks = [];
let activeChunkIndex = 0;
let packedOutputText = "";
let outputExt = "xml";
let outputMime = "application/xml";

let cachedRawFiles = []; // [{ path: string, rawContent: string }]
let secretsMap = new Map(); // path -> Array<{ type, line, preview }>
let activeTreeControls = null;

let cachedSkippedPaths = new Set();
let cachedRepoInfo = null;
let cachedBranch = "";
let currentActiveSelection = [];
let isPrivateRepo = false;
let currentGeneration = 0;
let repackGeneration = 0;
let isDownloading = false;
let activeFetchCount = 0;

let currentBudgetWindow = 200000;
let currentAppState = 'empty'; // 'empty' | 'loaded' | 'built'
let totalTokensAllChunks = 0;

const dom = {
    repoUrl: document.getElementById('repoUrl'),
    branch: document.getElementById('branch'),
    pat: document.getElementById('pat'),
    quotaVal: document.getElementById('quotaVal'),
    resetVal: document.getElementById('resetVal'),
    format: document.getElementById('format'),
    maxKb: document.getElementById('maxKb'),
    throttleMs: document.getElementById('throttleMs'),
    ignoreExt: document.getElementById('ignoreExt'),
    minifyMode: document.getElementById('minifyMode'),
    chunkLimit: document.getElementById('chunkLimit'),
    redactSecrets: document.getElementById('redactSecrets'),
    aiInstructions: document.getElementById('aiInstructions'),
    clearInstructionsBtn: document.getElementById('clearInstructionsBtn'),
    instructionsCharCount: document.getElementById('instructionsCharCount'),
    secretsWarningPanel: document.getElementById('secretsWarningPanel'),
    secretsWarningSummary: document.getElementById('secretsWarningSummary'),
    excludeAllSecretsBtn: document.getElementById('excludeAllSecretsBtn'),
    secretsTableBody: document.getElementById('secretsTableBody'),
    packBtn: document.getElementById('packBtn'),
    shareUrlBtn: document.getElementById('shareUrlBtn'),
    abortBtn: document.getElementById('abortBtn'),
    optionsToggleBtn: document.getElementById('optionsToggleBtn'),
    optionsDrawer: document.getElementById('optionsDrawer'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    repoInputError: document.getElementById('repoInputError'),
    progressTrack: document.getElementById('progressTrack'),
    progressFill: document.getElementById('progressFill'),
    logHeader: document.getElementById('logHeader'),
    logSummary: document.getElementById('logSummary'),
    logToggleBtn: document.getElementById('logToggleBtn'),
    log: document.getElementById('log'),
    treeCard: document.getElementById('treeCard'),
    treeEmptyState: document.getElementById('treeEmptyState'),
    treeContainer: document.getElementById('treeContainer'),
    manifestCount: document.getElementById('manifestCount'),
    selectedCount: document.getElementById('selectedCount'),
    selectedTokensBadge: document.getElementById('selectedTokensBadge'),
    selectAllBtn: document.getElementById('selectAllBtn'),
    deselectAllBtn: document.getElementById('deselectAllBtn'),
    deselectLargeBtn: document.getElementById('deselectLargeBtn'),
    largeFileThresholdKb: document.getElementById('largeFileThresholdKb'),
    expandAllBtn: document.getElementById('expandAllBtn'),
    collapseAllBtn: document.getElementById('collapseAllBtn'),
    treeFilterInput: document.getElementById('treeFilterInput'),
    searchMatchCount: document.getElementById('searchMatchCount'),
    startDownloadBtn: document.getElementById('startDownloadBtn'),
    outputCard: document.getElementById('outputCard'),
    outputEmptyState: document.getElementById('outputEmptyState'),
    statFiles: document.getElementById('statFiles'),
    statTokens: document.getElementById('statTokens'),
    statChars: document.getElementById('statChars'),
    statChunks: document.getElementById('statChunks'),
    targetBudgetDisplay: document.getElementById('targetBudgetDisplay'),
    budgetFill: document.getElementById('budgetFill'),
    budgetStatusText: document.getElementById('budgetStatusText'),
    chunkSelectLabel: document.getElementById('chunkSelectLabel'),
    chunkSelect: document.getElementById('chunkSelect'),
    previewNotice: document.getElementById('previewNotice'),
    previewArea: document.getElementById('previewArea'),
    wrapToggleBtn: document.getElementById('wrapToggleBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    downloadAllBtn: document.getElementById('downloadAllBtn'),
    copyBtn: document.getElementById('copyBtn'),
    toastContainer: document.getElementById('toastContainer'),
    tabFilesBtn: document.getElementById('tabFilesBtn'),
    tabOutputBtn: document.getElementById('tabOutputBtn'),
    stickyActionBar: document.getElementById('stickyActionBar'),
    mobilePrimaryBtn: document.getElementById('mobilePrimaryBtn'),
    step1: document.getElementById('step1'),
    step2: document.getElementById('step2'),
    step3: document.getElementById('step3')
};

// --- Toast & Inline Notifications ---
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

function showInlineError(msg) {
    if (dom.repoInputError) {
        if (msg) {
            dom.repoInputError.textContent = msg;
            dom.repoInputError.style.display = 'block';
        } else {
            dom.repoInputError.style.display = 'none';
        }
    }
}

// --- Theme Management ---
function initTheme() {
    try {
        const savedTheme = localStorage.getItem('app_theme');
        if (savedTheme === 'dark' || savedTheme === 'light') {
            document.documentElement.setAttribute('data-theme', savedTheme);
        }
    } catch (_) {}
}

if (dom.themeToggleBtn) {
    dom.themeToggleBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        let next = 'dark';
        if (current === 'dark') next = 'light';
        else if (current === 'light') next = 'dark';
        else {
            const isDarkSystem = window.matchMedia('(prefers-color-scheme: dark)').matches;
            next = isDarkSystem ? 'light' : 'dark';
        }
        document.documentElement.setAttribute('data-theme', next);
        try {
            localStorage.setItem('app_theme', next);
        } catch (_) {}
    });
}
initTheme();

// --- Persistence ---
function updateCharCount() {
    if (dom.instructionsCharCount && dom.aiInstructions) {
        dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
    }
}

function loadSavedSettings() {
    try {
        if (dom.format && localStorage.getItem('cfg_format')) dom.format.value = localStorage.getItem('cfg_format');
        if (dom.minifyMode && localStorage.getItem('cfg_minifyMode')) dom.minifyMode.value = localStorage.getItem('cfg_minifyMode');
        if (dom.chunkLimit && localStorage.getItem('cfg_chunkLimit')) dom.chunkLimit.value = localStorage.getItem('cfg_chunkLimit');
        if (dom.maxKb && localStorage.getItem('cfg_maxKb')) dom.maxKb.value = localStorage.getItem('cfg_maxKb');
        if (dom.throttleMs && localStorage.getItem('cfg_throttleMs')) dom.throttleMs.value = localStorage.getItem('cfg_throttleMs');
        if (dom.ignoreExt && localStorage.getItem('cfg_ignoreExt')) dom.ignoreExt.value = localStorage.getItem('cfg_ignoreExt');
        if (dom.redactSecrets && localStorage.getItem('cfg_redactSecrets') !== null) {
            dom.redactSecrets.checked = localStorage.getItem('cfg_redactSecrets') !== 'false';
        }
        if (dom.aiInstructions && localStorage.getItem('cfg_aiInstructions') !== null) {
            dom.aiInstructions.value = localStorage.getItem('cfg_aiInstructions');
            updateCharCount();
        }
        if (localStorage.getItem('cfg_budgetWindow')) {
            currentBudgetWindow = parseInt(localStorage.getItem('cfg_budgetWindow'), 10) || 200000;
        }
    } catch (_) {}
}

function saveSettings() {
    try {
        if (dom.format) localStorage.setItem('cfg_format', dom.format.value);
        if (dom.minifyMode) localStorage.setItem('cfg_minifyMode', dom.minifyMode.value);
        if (dom.chunkLimit) localStorage.setItem('cfg_chunkLimit', dom.chunkLimit.value);
        if (dom.maxKb) localStorage.setItem('cfg_maxKb', dom.maxKb.value);
        if (dom.throttleMs) localStorage.setItem('cfg_throttleMs', dom.throttleMs.value);
        if (dom.ignoreExt) localStorage.setItem('cfg_ignoreExt', dom.ignoreExt.value);
        if (dom.redactSecrets) localStorage.setItem('cfg_redactSecrets', dom.redactSecrets.checked ? 'true' : 'false');
        if (dom.aiInstructions) localStorage.setItem('cfg_aiInstructions', dom.aiInstructions.value);
        localStorage.setItem('cfg_budgetWindow', currentBudgetWindow.toString());
    } catch (_) {}
}

// Options Drawer Toggle
if (dom.optionsToggleBtn && dom.optionsDrawer) {
    dom.optionsToggleBtn.addEventListener('click', () => {
        const isOpen = dom.optionsDrawer.classList.contains('open');
        if (isOpen) {
            dom.optionsDrawer.classList.remove('open');
            dom.optionsToggleBtn.setAttribute('aria-expanded', 'false');
        } else {
            dom.optionsDrawer.classList.add('open');
            dom.optionsToggleBtn.setAttribute('aria-expanded', 'true');
        }
    });
}

// Log Details Toggle
let logOpen = false;
if (dom.logToggleBtn && dom.log) {
    dom.logToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        logOpen = !logOpen;
        dom.log.style.display = logOpen ? 'block' : 'none';
        dom.logToggleBtn.textContent = logOpen ? 'Hide log' : 'Details';
    });
}
if (dom.logHeader) {
    dom.logHeader.addEventListener('click', () => {
        if (dom.logToggleBtn) dom.logToggleBtn.click();
    });
}

function updateProgressBar(percent) {
    const val = Math.min(100, Math.max(0, Math.round(percent)));
    if (dom.progressFill) dom.progressFill.style.width = `${val}%`;
    if (dom.progressTrack) dom.progressTrack.setAttribute('aria-valuenow', val.toString());
}

function log(msg) {
    if (dom.log) {
        dom.log.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
        dom.log.scrollTop = dom.log.scrollHeight;
    }
    if (dom.logSummary) {
        const cleanMsg = msg.replace(/^\[[A-Z]+\]\s*/, '');
        dom.logSummary.textContent = cleanMsg;
    }
}

// --- App State & Sequence Steps ---
function setAppState(state, note = '') {
    currentAppState = state;
    if (dom.step1) dom.step1.classList.toggle('active', state === 'empty');
    if (dom.step2) dom.step2.classList.toggle('active', state === 'loaded');
    if (dom.step3) dom.step3.classList.toggle('active', state === 'built');

    if (dom.mobilePrimaryBtn) {
        if (state === 'empty') {
            dom.mobilePrimaryBtn.textContent = 'Load files';
        } else if (state === 'loaded') {
            dom.mobilePrimaryBtn.textContent = note ? note : 'Build context';
        } else if (state === 'built') {
            dom.mobilePrimaryBtn.textContent = 'Copy context';
        }
    }
    if (dom.startDownloadBtn) {
        const textSpan = dom.startDownloadBtn.querySelector('span') || dom.startDownloadBtn;
        if (state === 'loaded' && note) {
            textSpan.textContent = note;
        } else {
            textSpan.textContent = 'Build context';
        }
    }
}

// --- Mobile Tab Switching & Accessible Tabs ---
function switchTab(activeTabBtn, inactiveTabBtn, activeCard, inactiveCard) {
    activeTabBtn.classList.add('active');
    activeTabBtn.setAttribute('aria-selected', 'true');
    activeTabBtn.setAttribute('tabindex', '0');

    inactiveTabBtn.classList.remove('active');
    inactiveTabBtn.setAttribute('aria-selected', 'false');
    inactiveTabBtn.setAttribute('tabindex', '-1');

    activeCard.classList.add('active-mobile');
    inactiveCard.classList.remove('active-mobile');
}

if (dom.tabFilesBtn && dom.tabOutputBtn) {
    dom.tabFilesBtn.addEventListener('click', () => {
        switchTab(dom.tabFilesBtn, dom.tabOutputBtn, dom.treeCard, dom.outputCard);
    });

    dom.tabOutputBtn.addEventListener('click', () => {
        switchTab(dom.tabOutputBtn, dom.tabFilesBtn, dom.outputCard, dom.treeCard);
    });

    const tabs = [dom.tabFilesBtn, dom.tabOutputBtn];
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
    dom.mobilePrimaryBtn.addEventListener('click', () => {
        if (currentAppState === 'empty') {
            dom.packBtn.click();
        } else if (currentAppState === 'loaded') {
            dom.startDownloadBtn.click();
            if (dom.tabOutputBtn) dom.tabOutputBtn.click();
        } else if (currentAppState === 'built') {
            dom.copyBtn.click();
        }
    });
}

// Wrap toggle
if (dom.wrapToggleBtn && dom.previewArea) {
    dom.wrapToggleBtn.addEventListener('click', () => {
        const isWrapped = dom.previewArea.classList.contains('wrap');
        if (isWrapped) {
            dom.previewArea.classList.remove('wrap');
            dom.wrapToggleBtn.classList.remove('primary');
            dom.wrapToggleBtn.classList.add('secondary');
        } else {
            dom.previewArea.classList.add('wrap');
            dom.wrapToggleBtn.classList.add('primary');
            dom.wrapToggleBtn.classList.remove('secondary');
        }
    });
}

// Budget Meter Presets
document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const val = parseInt(btn.getAttribute('data-preset'), 10);
        if (val) {
            currentBudgetWindow = val;
            if (dom.chunkLimit) {
                dom.chunkLimit.value = val.toString();
                dom.chunkLimit.dispatchEvent(new Event('change', { bubbles: true }));
            }
            saveSettings();
        }
    });
});

function updateBudgetMeterUI(totalTokens, numChunks = 1, isPreBuild = false, maxChunkTokens = 0, hasOversizedChunk = false) {
    if (dom.targetBudgetDisplay) {
        dom.targetBudgetDisplay.textContent = `of ${currentBudgetWindow.toLocaleString()} estimated tokens${isPreBuild ? ' (pre-build estimate)' : ''}`;
    }

    const chunkLimitVal = parseInt(dom.chunkLimit ? dom.chunkLimit.value : '0', 10) || 0;

    if (isPreBuild && chunkLimitVal > 0 && totalTokens > chunkLimitVal) {
        const estChunks = Math.ceil(totalTokens / chunkLimitVal);
        const ratio = currentBudgetWindow > 0 ? (totalTokens / currentBudgetWindow) : 0;
        const pct = Math.min(Math.round((totalTokens / currentBudgetWindow) * 100), 100);

        if (dom.budgetFill) {
            dom.budgetFill.style.width = `${pct}%`;
            dom.budgetFill.className = 'budget-fill ' + (
                ratio <= 0.85 ? 'fits' : ratio <= 1.0 ? 'near' : 'over'
            );
        }

        if (dom.budgetStatusText) {
            dom.budgetStatusText.textContent = `About ${totalTokens.toLocaleString()} tokens, will split into about ${estChunks} parts`;
            dom.budgetStatusText.className = 'budget-status-text ' + (
                ratio <= 0.85 ? 'status-fits' : ratio <= 1.0 ? 'status-near' : 'status-over'
            );
        }
        return;
    }

    const isSplit = numChunks > 1 || (chunkLimitVal > 0 && totalTokens > chunkLimitVal);
    const evaluatedTokens = isSplit ? (maxChunkTokens || (chunkLimitVal > 0 ? Math.min(totalTokens, chunkLimitVal) : Math.round(totalTokens / numChunks))) : totalTokens;

    const ratio = currentBudgetWindow > 0 ? (evaluatedTokens / currentBudgetWindow) : 0;
    const pct = Math.min(Math.round((totalTokens / currentBudgetWindow) * 100), 100);

    if (dom.budgetFill) {
        dom.budgetFill.style.width = `${pct}%`;
        dom.budgetFill.className = 'budget-fill ' + (
            (hasOversizedChunk || ratio > 1.0) ? 'over' : ratio <= 0.85 ? 'fits' : 'near'
        );
    }

    if (dom.budgetStatusText) {
        if (isSplit && numChunks > 1) {
            const displayTokens = maxChunkTokens || Math.round(totalTokens / numChunks);
            if (hasOversizedChunk) {
                dom.budgetStatusText.textContent = `Split into ${numChunks} parts (largest: ${displayTokens.toLocaleString()} tok) - 1+ part exceeds split limit`;
                dom.budgetStatusText.className = 'budget-status-text status-over';
            } else {
                dom.budgetStatusText.textContent = `Split into ${numChunks} parts (largest: ${displayTokens.toLocaleString()} tok) - fits target window`;
                dom.budgetStatusText.className = 'budget-status-text status-fits';
            }
        } else if (ratio <= 0.85) {
            dom.budgetStatusText.textContent = 'Fits context window';
            dom.budgetStatusText.className = 'budget-status-text status-fits';
        } else if (ratio <= 1.0) {
            dom.budgetStatusText.textContent = 'Near context limit';
            dom.budgetStatusText.className = 'budget-status-text status-near';
        } else {
            const overTokens = (totalTokens - currentBudgetWindow).toLocaleString();
            dom.budgetStatusText.textContent = `Over by ${overTokens} tokens. Split into parts or deselect files.`;
            dom.budgetStatusText.className = 'budget-status-text status-over';
        }
    }
}

function incrementActiveFetches() {
    activeFetchCount++;
    if (dom.abortBtn) dom.abortBtn.style.display = 'inline-flex';
}

function decrementActiveFetches() {
    activeFetchCount = Math.max(0, activeFetchCount - 1);
    if (activeFetchCount === 0 && dom.abortBtn) {
        dom.abortBtn.style.display = 'none';
    }
}

function updateCachedRawFiles(newFiles) {
    const map = new Map(cachedRawFiles.map(f => [f.path, f]));
    for (const f of newFiles) {
        if (f && f.path) {
            map.set(f.path, f);
            if (!secretsMap.has(f.path)) {
                const findings = scanForSecrets(f.path, f.rawContent);
                secretsMap.set(f.path, findings);
            }
        }
    }
    cachedRawFiles = Array.from(map.values());
}

function isBinaryContent(content) {
    if (!content) return false;
    const sample = content.slice(0, 1024);
    if (sample.includes('\0')) return true;
    let nonPrintable = 0;
    for (let i = 0; i < sample.length; i++) {
        const code = sample.charCodeAt(i);
        if (code < 9 || (code > 13 && code < 32) || code === 65533) {
            nonPrintable++;
        }
    }
    return sample.length > 0 && (nonPrintable / sample.length) > 0.05;
}

function clearOutputState() {
    generatedChunks = [];
    activeChunkIndex = 0;
    packedOutputText = "";
    totalTokensAllChunks = 0;
    if (dom.previewArea) dom.previewArea.value = "";
    if (dom.outputEmptyState) dom.outputEmptyState.style.display = 'flex';
    if (dom.previewNotice) dom.previewNotice.style.display = 'none';
    if (dom.previewArea) dom.previewArea.style.display = 'none';
    if (dom.secretsWarningPanel) dom.secretsWarningPanel.style.display = 'none';
    if (dom.statFiles) dom.statFiles.textContent = '0';
    if (dom.statChars) dom.statChars.textContent = '0';
    if (dom.statTokens) dom.statTokens.textContent = '0';
    if (dom.statChunks) dom.statChunks.textContent = '0';
    if (dom.chunkSelectLabel) dom.chunkSelectLabel.style.display = 'none';
    if (dom.chunkSelect) dom.chunkSelect.style.display = 'none';
    if (dom.downloadAllBtn) dom.downloadAllBtn.style.display = 'none';
    if (dom.chunkSelect) dom.chunkSelect.innerHTML = '';
    if (dom.downloadBtn) dom.downloadBtn.disabled = true;
    if (dom.copyBtn) dom.copyBtn.disabled = true;
    updateBudgetMeterUI(0, 1, false);
}

function updateRateLimitUI(meta) {
    if (meta.remaining !== null && meta.remaining !== undefined && meta.limit !== null && meta.limit !== undefined) {
        const remaining = typeof meta.remaining === 'number' ? meta.remaining : parseInt(meta.remaining, 10);
        const limit = typeof meta.limit === 'number' ? meta.limit : parseInt(meta.limit, 10);
        if (!Number.isNaN(remaining) && !Number.isNaN(limit)) {
            dom.quotaVal.textContent = `${remaining} / ${limit}`;
            dom.quotaVal.className = (
                remaining < 5 ? 'rate-critical' : remaining < 20 ? 'rate-warning' : 'rate-normal'
            );
        }
    }
    if (meta.reset) {
        const resetSec = typeof meta.reset === 'number' ? meta.reset : parseInt(meta.reset, 10);
        if (!Number.isNaN(resetSec)) {
            const resetDate = new Date(resetSec * 1000);
            dom.resetVal.textContent = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
    }
}

async function refreshRateLimitBadge() {
    try {
        const pat = dom.pat.value.trim();
        const info = await fetchRateLimit(pat);
        updateRateLimitUI(info);
    } catch (_) {}
}

dom.pat.addEventListener('change', refreshRateLimitBadge);
refreshRateLimitBadge();
loadSavedSettings();

function applyUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const repoParam = params.get('repo');
    const branchParam = params.get('branch');
    const formatParam = params.get('format');
    const minifyParam = params.get('minify');

    const validFormats = ['claude-xml', 'markdown', 'generic-xml', 'json'];
    const validMinify = ['none', 'basic', 'aggressive'];

    if (repoParam && dom.repoUrl) dom.repoUrl.value = repoParam;
    if (branchParam && dom.branch) dom.branch.value = branchParam;
    if (formatParam && validFormats.includes(formatParam) && dom.format) dom.format.value = formatParam;
    if (minifyParam && validMinify.includes(minifyParam) && dom.minifyMode) dom.minifyMode.value = minifyParam;
}

clearOutputState();
applyUrlParams();

function getDeepLinkUrl() {
    const repo = dom.repoUrl ? dom.repoUrl.value.trim() : '';
    const branch = dom.branch ? dom.branch.value.trim() : '';
    const format = dom.format ? dom.format.value : '';
    const minify = dom.minifyMode ? dom.minifyMode.value : '';

    const url = new URL(window.location.href.split('?')[0]);
    if (repo) url.searchParams.set('repo', repo);
    if (branch) url.searchParams.set('branch', branch);
    if (format) url.searchParams.set('format', format);
    if (minify) url.searchParams.set('minify', minify);
    return url.toString();
}

function updateSecretsWarningPanel(selectedFiles) {
    if (!dom.secretsWarningPanel || !dom.secretsTableBody || !dom.secretsWarningSummary) return;

    const selectedPaths = new Set(selectedFiles.map(f => f.path));
    let totalFindings = 0;
    const flaggedPaths = new Set();
    const rows = [];

    for (const file of selectedFiles) {
        const findings = secretsMap.get(file.path) || [];
        if (findings.length > 0) {
            flaggedPaths.add(file.path);
            totalFindings += findings.length;
            for (const f of findings) {
                rows.push({
                    path: file.path,
                    type: f.type,
                    line: f.line,
                    preview: f.preview
                });
            }
        }
    }

    if (totalFindings === 0) {
        dom.secretsWarningPanel.style.display = 'none';
        return;
    }

    dom.secretsWarningPanel.style.display = 'block';
    dom.secretsWarningSummary.textContent = `${totalFindings} possible secret${totalFindings === 1 ? '' : 's'} in ${flaggedPaths.size} file${flaggedPaths.size === 1 ? '' : 's'}.`;

    dom.secretsTableBody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeXml(r.path)}</td>
            <td>${escapeXml(r.type)}</td>
            <td>${r.line}</td>
            <td>${escapeXml(r.preview)}</td>
            <td><button type="button" class="secondary btn-xs exclude-secret-btn" data-path="${escapeXml(r.path)}">Exclude file</button></td>
        </tr>
    `).join('');

    dom.secretsTableBody.querySelectorAll('.exclude-secret-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const path = btn.getAttribute('data-path');
            if (path && activeTreeControls) {
                activeTreeControls.setPathsChecked([path], false);
            }
        });
    });

    if (dom.excludeAllSecretsBtn) {
        dom.excludeAllSecretsBtn.onclick = () => {
            if (activeTreeControls && flaggedPaths.size > 0) {
                activeTreeControls.setPathsChecked(Array.from(flaggedPaths), false);
            }
        };
    }
}

async function repackBundleInMemory(activeSelectionNodes = currentActiveSelection) {
    repackGeneration++;
    const thisRepackGen = repackGeneration;

    let selection = activeSelectionNodes || currentActiveSelection;

    if (!cachedRawFiles || cachedRawFiles.length === 0 || !cachedRepoInfo || !selection || selection.length === 0) {
        clearOutputState();
        if (selection && selection.length === 0) {
            log(`[WARN] No files selected for context build.`);
        }
        return;
    }

    const selectedPaths = new Set(selection.map(n => n.path));
    const targetFiles = cachedRawFiles.filter(f => selectedPaths.has(f.path));

    if (targetFiles.length === 0) {
        clearOutputState();
        return;
    }

    const minifyMode = dom.minifyMode ? dom.minifyMode.value : 'none';
    const isRedact = dom.redactSecrets ? dom.redactSecrets.checked : true;
    const instructions = dom.aiInstructions ? dom.aiInstructions.value : '';

    log(`[PACK] Building context from ${targetFiles.length} files (${dom.format.value}, shrink: ${minifyMode}, redact: ${isRedact})...`);

    const processedFiles = targetFiles.map(f => {
        let content = f.rawContent;
        if (isRedact) {
            content = redactSecrets(content, f.path);
        }
        if (minifyMode !== 'none') {
            content = minifyCode(content, f.path, minifyMode);
        }
        return {
            path: f.path,
            content
        };
    });

    const paths = processedFiles.map(f => f.path);
    const treeAscii = generateTree(paths);
    const chunkLimitVal = parseInt(dom.chunkLimit.value, 10) || 0;

    const repoUrl = (cachedRepoInfo && cachedRepoInfo.owner && cachedRepoInfo.repo)
        ? `https://github.com/${cachedRepoInfo.owner}/${cachedRepoInfo.repo}`
        : getDeepLinkUrl();

    const repoWithUrl = { ...cachedRepoInfo, url: repoUrl };

    const newChunks = chunkContextOutput(
        dom.format.value,
        repoWithUrl,
        cachedBranch,
        treeAscii,
        processedFiles,
        chunkLimitVal,
        estimateTokens,
        { instructions }
    );

    const firstChunk = newChunks[0];
    const newPackedOutputText = firstChunk.text;

    const estTokens = await estimateTokensAsync(newPackedOutputText);

    if (thisRepackGen !== repackGeneration) {
        return;
    }

    generatedChunks = newChunks;
    activeChunkIndex = 0;
    packedOutputText = newPackedOutputText;
    outputExt = firstChunk.ext;
    outputMime = firstChunk.mime;

    const totalChars = newChunks.reduce((acc, c) => acc + c.text.length, 0);
    const chunkTokensPromises = newChunks.map(c => estimateTokensAsync(c.text));
    const chunkTokensList = await Promise.all(chunkTokensPromises);
    totalTokensAllChunks = chunkTokensList.reduce((a, b) => a + b, 0);

    let maxChunkTokens = 0;
    let hasOversizedChunk = false;
    newChunks.forEach((c, idx) => {
        const cTokens = chunkTokensList[idx];
        if (cTokens > maxChunkTokens) maxChunkTokens = cTokens;
        if (c.exceedsLimit || (chunkLimitVal > 0 && cTokens > chunkLimitVal)) {
            hasOversizedChunk = true;
            log(`[WARN] Chunk part ${idx + 1}/${newChunks.length} (~${cTokens.toLocaleString()} tokens) exceeds limit of ${chunkLimitVal.toLocaleString()} tokens.`);
        }
    });

    dom.statFiles.textContent = processedFiles.length;
    dom.statChars.textContent = totalChars.toLocaleString();
    dom.statTokens.textContent = totalTokensAllChunks.toLocaleString();
    dom.statChunks.textContent = generatedChunks.length;

    updateBudgetMeterUI(totalTokensAllChunks, generatedChunks.length, false, maxChunkTokens, hasOversizedChunk);
    updateSecretsWarningPanel(targetFiles);

    if (generatedChunks.length > 1) {
        dom.chunkSelectLabel.style.display = 'inline-block';
        dom.chunkSelect.style.display = 'inline-block';
        dom.downloadAllBtn.style.display = 'inline-flex';
        dom.chunkSelect.innerHTML = generatedChunks.map((_, idx) => `<option value="${idx}">Part ${idx + 1} of ${generatedChunks.length}</option>`).join('');
    } else {
        dom.chunkSelectLabel.style.display = 'none';
        dom.chunkSelect.style.display = 'none';
        dom.downloadAllBtn.style.display = 'none';
        dom.chunkSelect.innerHTML = '';
    }

    dom.previewArea.value = packedOutputText.slice(0, 45000) + (packedOutputText.length > 45000 ? '\n\n... [Truncated for preview; complete text will download] ...' : '');
    if (dom.outputEmptyState) dom.outputEmptyState.style.display = 'none';
    if (dom.previewNotice) dom.previewNotice.style.display = packedOutputText.length > 45000 ? 'block' : 'none';
    if (dom.previewArea) dom.previewArea.style.display = 'block';
    if (dom.downloadBtn) dom.downloadBtn.disabled = false;
    if (dom.copyBtn) dom.copyBtn.disabled = false;

    setAppState('built');
    log(`[SUCCESS] Context ready: ${generatedChunks.length} part(s), ~${totalTokensAllChunks.toLocaleString()} total tokens.`);
}

// Auto-repack on setting changes if files are already cached
[dom.format, dom.minifyMode, dom.chunkLimit].forEach(el => {
    if (el) {
        el.addEventListener('change', () => {
            saveSettings();
            repackBundleInMemory();
        });
    }
});
[dom.maxKb, dom.throttleMs, dom.ignoreExt].forEach(el => {
    if (el) {
        el.addEventListener('change', () => {
            saveSettings();
        });
    }
});
if (dom.redactSecrets) {
    dom.redactSecrets.addEventListener('change', () => {
        saveSettings();
        repackBundleInMemory();
    });
}
if (dom.aiInstructions) {
    dom.aiInstructions.addEventListener('input', () => {
        updateCharCount();
        saveSettings();
        repackBundleInMemory();
    });
}

if (dom.clearInstructionsBtn) {
    dom.clearInstructionsBtn.addEventListener('click', () => {
        if (dom.aiInstructions) {
            dom.aiInstructions.value = '';
            updateCharCount();
        }
        try {
            localStorage.removeItem('cfg_aiInstructions');
        } catch (_) {}
        saveSettings();
        repackBundleInMemory();
    });
}

document.querySelectorAll('.preset-buttons button[data-instruction]').forEach(btn => {
    btn.addEventListener('click', () => {
        const instText = btn.getAttribute('data-instruction');
        if (instText && dom.aiInstructions) {
            dom.aiInstructions.value = instText;
            updateCharCount();
            saveSettings();
            repackBundleInMemory();
        }
    });
});

// --- Main Processing Pipeline ---
dom.packBtn.addEventListener('click', async () => {
    showInlineError('');
    if (abortController) {
        abortController.abort();
    }

    const repoInfo = parseRepoInput(dom.repoUrl.value);
    if (!repoInfo) {
        showInlineError("Enter a repo as owner/name or a GitHub URL.");
        return;
    }

    currentGeneration++;
    const thisGen = currentGeneration;

    cachedRawFiles = [];
    secretsMap.clear();
    cachedSkippedPaths.clear();
    cachedRepoInfo = null;
    cachedBranch = "";
    currentActiveSelection = [];
    isPrivateRepo = false;
    clearOutputState();

    const userTypedBranch = dom.branch ? dom.branch.value.trim() : '';

    if (dom.branch) {
        const parsedWithOverride = parseRepoInput(dom.repoUrl.value, userTypedBranch);
        if (parsedWithOverride && parsedWithOverride.branch) {
            repoInfo.branch = parsedWithOverride.branch;
            repoInfo.subpath = parsedWithOverride.subpath;
        }
        if (repoInfo.branch && !userTypedBranch) {
            dom.branch.value = repoInfo.branch;
        }
    }

    const pat = dom.pat.value.trim();
    const maxKb = parseInt(dom.maxKb.value, 10) || 150;
    const throttleMs = parseInt(dom.throttleMs.value, 10) || 80;
    const customIgnoredExts = Array.from(new Set(
        dom.ignoreExt.value.split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean)
    ));

    abortController = new AbortController();
    dom.packBtn.disabled = true;
    dom.abortBtn.style.display = 'inline-flex';
    dom.progressTrack.style.display = 'block';
    updateProgressBar(0);
    dom.log.textContent = '';
    if (dom.outputEmptyState) dom.outputEmptyState.style.display = 'flex';
    if (dom.previewArea) dom.previewArea.style.display = 'none';

    try {
        log(`[FETCH] Querying GitHub API for ${repoInfo.owner}/${repoInfo.repo}...`);

        let targetBranch = userTypedBranch || repoInfo.branch || '';
        let rawTree = null;

        try {
            const repoMeta = await resolveDefaultBranch(
                repoInfo.owner,
                repoInfo.repo,
                pat,
                abortController.signal,
                updateRateLimitUI
            );
            if (!targetBranch) targetBranch = repoMeta.branch;
            isPrivateRepo = repoMeta.isPrivate;
        } catch (err) {
            if (err.message && err.message.includes('404')) {
                showToast("Can't find that repo or branch. For a private repo, add a token with read access to contents.", "error");
            } else if (err.message && err.message.includes('rate limit')) {
                showToast("GitHub rate limit reached. Add a token to raise the limit.", "error");
            }
        }

        log(`[FETCH] Target branch: ${targetBranch}${isPrivateRepo ? ' (Private Repository)' : ''}`);

        try {
            rawTree = await fetchRepoTree(
                repoInfo.owner,
                repoInfo.repo,
                targetBranch,
                pat,
                abortController.signal,
                updateRateLimitUI
            );
        } catch (err) {
            if (!userTypedBranch && repoInfo.treeTail && repoInfo.treeTail.includes('/')) {
                const tailParts = repoInfo.treeTail.split('/');
                for (let len = tailParts.length; len >= 1; len--) {
                    const candidateBranch = tailParts.slice(0, len).join('/');
                    if (candidateBranch === targetBranch) continue;
                    const candidateSubpath = tailParts.slice(len).join('/') || null;
                    try {
                        rawTree = await fetchRepoTree(
                            repoInfo.owner,
                            repoInfo.repo,
                            candidateBranch,
                            pat,
                            abortController.signal,
                            updateRateLimitUI
                        );
                        targetBranch = candidateBranch;
                        repoInfo.branch = candidateBranch;
                        repoInfo.subpath = candidateSubpath;
                        if (dom.branch) dom.branch.value = candidateBranch;
                        log(`[FETCH] Resolved branch with slash: ${targetBranch}`);
                        break;
                    } catch (_) {}
                }
            }
            if (!rawTree) throw err;
        }

        if (rawTree.truncated) {
            log(`[WARN] GitHub returned a partial file list. Narrow the path or pick a branch with fewer files.`);
            showToast("GitHub returned a partial file list. Narrow the path or pick a branch with fewer files.", "warn");
        }

        let ignoredDirCount = 0;
        let ignoredFileCount = 0;
        let ignoredExtCount = 0;
        let ignoredSizeCount = 0;

        const processable = rawTree.filter(node => {
            if (node.type !== 'blob') return false;
            if (node.mode === '120000') return false;
            const pathParts = node.path.split('/');
            const filename = pathParts[pathParts.length - 1].toLowerCase();
            const dirParts = pathParts.slice(0, -1);

            if (isIgnoredDirPath(dirParts)) {
                ignoredDirCount++;
                return false;
            }
            if (IGNORED_FILES.has(filename)) {
                ignoredFileCount++;
                return false;
            }
            if (customIgnoredExts.some(ext => filename === ext || filename.endsWith('.' + ext))) {
                ignoredExtCount++;
                return false;
            }
            if (node.size !== undefined && node.size > maxKb * 1024) {
                ignoredSizeCount++;
                return false;
            }

            return true;
        });

        log(`[FETCH] Discovered ${rawTree.length} objects. Excluded: ${ignoredDirCount} in ignored dirs, ${ignoredFileCount} ignored files, ${ignoredExtCount} ignored exts, ${ignoredSizeCount} >${maxKb}KB. Selected ${processable.length} files.`);

        dom.manifestCount.textContent = processable.length;
        dom.selectedCount.textContent = processable.length;
        if (dom.treeEmptyState) dom.treeEmptyState.style.display = 'none';
        if (dom.treeContainer) dom.treeContainer.style.display = 'block';

        let activeSelection = [...processable];

        const treeControls = renderInteractiveTree(
            processable,
            dom.treeContainer,
            async (selectedNodes) => {
                activeSelection = selectedNodes;
                currentActiveSelection = selectedNodes;
                dom.selectedCount.textContent = activeSelection.length;
                if (treeControls.getSelectedStats && dom.selectedTokensBadge) {
                    const stats = treeControls.getSelectedStats();
                    dom.selectedTokensBadge.textContent = `~${stats.estTokens.toLocaleString()} tokens selected`;
                    updateBudgetMeterUI(stats.estTokens, 1, true);
                }
                if (currentAppState === 'built') {
                    setAppState('loaded', 'Rebuild context');
                }
                if (cachedRawFiles && cachedRawFiles.length > 0) {
                    if (currentActiveSelection && currentActiveSelection.length > 0) {
                        await fetchSelectedFilesDelta(currentActiveSelection);
                    }
                    repackBundleInMemory(currentActiveSelection);
                }
            },
            parseInt(dom.largeFileThresholdKb ? dom.largeFileThresholdKb.value : '50', 10) || 50
        );
        activeTreeControls = treeControls;
        currentActiveSelection = activeSelection;

        if (treeControls.getSelectedStats && dom.selectedTokensBadge) {
            const stats = treeControls.getSelectedStats();
            dom.selectedTokensBadge.textContent = `~${stats.estTokens.toLocaleString()} tokens selected`;
            updateBudgetMeterUI(stats.estTokens, 1, true);
        }

        dom.selectAllBtn.onclick = () => treeControls.selectAll(true);
        dom.deselectAllBtn.onclick = () => treeControls.selectAll(false);
        if (dom.deselectLargeBtn) {
            dom.deselectLargeBtn.onclick = () => {
                const kbVal = parseInt(dom.largeFileThresholdKb ? dom.largeFileThresholdKb.value : '50', 10) || 50;
                treeControls.deselectLarge(kbVal * 1024);
            };
        }
        if (dom.largeFileThresholdKb) {
            dom.largeFileThresholdKb.onchange = () => {
                const kbVal = parseInt(dom.largeFileThresholdKb.value, 10) || 50;
                treeControls.setLargeThresholdKb(kbVal);
            };
        }
        if (dom.expandAllBtn) dom.expandAllBtn.onclick = () => treeControls.expandAll(true);
        if (dom.collapseAllBtn) dom.collapseAllBtn.onclick = () => treeControls.expandAll(false);

        if (dom.treeFilterInput) {
            dom.treeFilterInput.value = repoInfo.subpath || '';
            const doFilter = () => {
                const count = treeControls.filter(dom.treeFilterInput.value, false);
                if (dom.searchMatchCount) {
                    dom.searchMatchCount.textContent = dom.treeFilterInput.value ? `${count} matches` : '';
                }
            };
            dom.treeFilterInput.oninput = doFilter;
            if (repoInfo.subpath) {
                const subpathCount = treeControls.filter(repoInfo.subpath, true);
                if (treeControls.selectBySubpath) {
                    treeControls.selectBySubpath(repoInfo.subpath);
                }
                if (dom.searchMatchCount) {
                    dom.searchMatchCount.textContent = `${subpathCount} matches`;
                }
            }
        }

        window.onkeydown = (e) => {
            if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
                e.preventDefault();
                if (dom.treeFilterInput) dom.treeFilterInput.focus();
            }
        };

        setAppState('loaded');
        showToast(`Loaded manifest: ${processable.length} files.`, 'info');

        let hasDownloaded = false;

        let deltaFetchQueue = Promise.resolve();
        function fetchSelectedFilesDelta(selectionToFetch) {
            deltaFetchQueue = deltaFetchQueue.then(async () => {
                if (thisGen !== currentGeneration) return;
                const cachedPaths = new Set(cachedRawFiles.map(f => f.path));
                const missingNodes = selectionToFetch.filter(n => !cachedPaths.has(n.path) && !cachedSkippedPaths.has(n.path));

                if (missingNodes.length === 0) return;

                log(`[FETCH] Fetching ${missingNodes.length} newly checked file(s)...`);
                const concurrency = 5;
                let index = 0;
                const results = new Array(missingNodes.length);

                if (!abortController || abortController.signal.aborted) {
                    abortController = new AbortController();
                }
                const signal = abortController.signal;
                incrementActiveFetches();
                dom.progressTrack.style.display = 'block';
                updateProgressBar(0);
                let completedDelta = 0;

                try {
                    async function worker() {
                        while (index < missingNodes.length) {
                            if (signal.aborted) break;
                            if (thisGen !== currentGeneration) break;
                            const i = index++;
                            const node = missingNodes[i];

                            let retries = 0;
                            let result = null;
                            while (retries < 3) {
                                result = await fetchFileContent(
                                    repoInfo.owner,
                                    repoInfo.repo,
                                    targetBranch,
                                    node.path,
                                    pat,
                                    signal,
                                    updateRateLimitUI,
                                    isPrivateRepo
                                );
                                if (result && result.isPrivate) {
                                    isPrivateRepo = true;
                                }
                                if (result && result.backoff) {
                                    retries++;
                                    await sleep(Math.min(result.backoff, 60) * 1000, signal);
                                    continue;
                                }
                                break;
                            }
                            if (result && result.success) {
                                if (isBinaryContent(result.content)) {
                                    cachedSkippedPaths.add(node.path);
                                    log(`[WARN] Delta skip ${node.path}: Binary content detected.`);
                                } else {
                                    results[i] = { path: node.path, rawContent: result.content };
                                }
                            } else {
                                if (result && result.status === 404) {
                                    cachedSkippedPaths.add(node.path);
                                }
                                log(`[ERROR] Failed to fetch delta ${node.path}${result && result.error ? `: ${result.error}` : ''}`);
                            }

                            completedDelta++;
                            updateProgressBar((completedDelta / missingNodes.length) * 100);

                            if (throttleMs > 0) {
                                await sleep(throttleMs, signal);
                            }
                        }
                    }

                    const workers = Array.from({ length: Math.min(concurrency, missingNodes.length) }, () => worker());
                    await Promise.all(workers);

                    if (thisGen === currentGeneration) {
                        const newlyFetched = results.filter(Boolean);
                        updateCachedRawFiles(newlyFetched);
                    }
                } finally {
                    decrementActiveFetches();
                }
            }).catch((err) => {
                if (err.name === 'AbortError') {
                    log('[CANCEL] Delta fetch cancelled.');
                } else {
                    log(`[ERROR] Delta fetch error: ${err.message || err}`);
                }
                decrementActiveFetches();
            });
            return deltaFetchQueue;
        }

        await new Promise((resolve, reject) => {
            const onStart = async () => {
                if (isDownloading) {
                    log('[WARN] Download already in progress...');
                    return;
                }
                if (!hasDownloaded) {
                    hasDownloaded = true;
                    isDownloading = true;
                    cleanup();
                    resolve();
                } else {
                    isDownloading = true;
                    try {
                        if (currentActiveSelection && currentActiveSelection.length > 0) {
                            await fetchSelectedFilesDelta(currentActiveSelection);
                        }
                        repackBundleInMemory(currentActiveSelection);
                    } finally {
                        isDownloading = false;
                    }
                }
            };
            const onAbort = () => {
                cleanup();
                reject(new DOMException('Aborted by user', 'AbortError'));
            };
            const cleanup = () => {
                if (abortController.signal) {
                    abortController.signal.removeEventListener('abort', onAbort);
                }
            };
            dom.startDownloadBtn.onclick = onStart;
            if (abortController.signal) {
                abortController.signal.addEventListener('abort', onAbort);
            }
        });

        const selectionSnapshot = [...currentActiveSelection];

        if (selectionSnapshot.length === 0) {
            log('[WARN] No files selected for context build.');
            clearOutputState();
            return;
        }

        log(`[FETCH] Starting download for ${selectionSnapshot.length} selected file(s)...`);

        const results = new Array(selectionSnapshot.length);
        let emptyCount = 0;
        let failedCount = 0;
        let completedCount = 0;

        const concurrency = 5;
        let index = 0;

        async function worker() {
            while (index < selectionSnapshot.length) {
                if (abortController.signal && abortController.signal.aborted) break;
                const i = index++;
                const node = selectionSnapshot[i];

                let retries = 0;
                let result = null;

                while (retries < 3) {
                    result = await fetchFileContent(
                        repoInfo.owner,
                        repoInfo.repo,
                        targetBranch,
                        node.path,
                        pat,
                        abortController.signal,
                        updateRateLimitUI,
                        isPrivateRepo
                    );

                    if (result && result.isPrivate) {
                        isPrivateRepo = true;
                    }

                    if (result && result.backoff) {
                        retries++;
                        const backoffTime = Math.min(result.backoff, 60);
                        log(`[RETRY] Cooling down for ${backoffTime}s...`);
                        await sleep(backoffTime * 1000, abortController.signal);
                        continue;
                    }
                    break;
                }

                if (result && result.success) {
                    const rawContent = result.content;
                    if (rawContent.length === 0) {
                        emptyCount++;
                    }
                    if (isBinaryContent(rawContent)) {
                        cachedSkippedPaths.add(node.path);
                        log(`[WARN] Skipping ${node.path}: Binary content.`);
                    } else {
                        results[i] = { path: node.path, rawContent: rawContent };
                    }
                } else {
                    if (result && result.status === 404) {
                        cachedSkippedPaths.add(node.path);
                    }
                    failedCount++;
                    log(`[ERROR] Failed to fetch ${node.path}${result && result.error ? `: ${result.error}` : ''}`);
                }

                completedCount++;
                updateProgressBar((completedCount / selectionSnapshot.length) * 100);

                if (throttleMs > 0) {
                    await sleep(throttleMs, abortController.signal);
                }
            }
        }

        const workers = Array.from({ length: Math.min(concurrency, selectionSnapshot.length) }, () => worker());
        await Promise.all(workers);

        const collectedFiles = results.filter(Boolean);

        log(`[SUCCESS] Download complete: ${collectedFiles.length} file(s) fetched.`);

        if (collectedFiles.length === 0) {
            showToast("No content could be fetched from selected files.", "warn");
            return;
        }

        cachedRawFiles = collectedFiles;
        secretsMap.clear();
        for (const f of collectedFiles) {
            secretsMap.set(f.path, scanForSecrets(f.path, f.rawContent));
        }

        cachedRepoInfo = repoInfo;
        cachedBranch = targetBranch;

        if (currentActiveSelection && currentActiveSelection.length > 0) {
            await fetchSelectedFilesDelta(currentActiveSelection);
        }

        await repackBundleInMemory();

    } catch (err) {
        if (err.name === 'AbortError') {
            log('[CANCEL] Process cancelled.');
            showToast("Cancelled.", "info");
        } else {
            log(`[ERROR] Error: ${err.message}`);
            showToast(`Error: ${err.message}`, "error");
        }
    } finally {
        isDownloading = false;
        dom.packBtn.disabled = false;
        dom.abortBtn.style.display = 'none';
    }
});

dom.abortBtn.addEventListener('click', () => {
    if (abortController) abortController.abort();
});

dom.chunkSelect.addEventListener('change', async () => {
    activeChunkIndex = parseInt(dom.chunkSelect.value, 10) || 0;
    const chunk = generatedChunks[activeChunkIndex];
    if (!chunk) return;

    packedOutputText = chunk.text;
    outputExt = chunk.ext;
    outputMime = chunk.mime;

    const totalChars = generatedChunks.reduce((acc, c) => acc + c.text.length, 0);
    dom.statChars.textContent = generatedChunks.length > 1
        ? `${packedOutputText.length.toLocaleString()} (Part ${activeChunkIndex + 1}) / ${totalChars.toLocaleString()} total`
        : totalChars.toLocaleString();

    if (dom.previewNotice) dom.previewNotice.style.display = packedOutputText.length > 45000 ? 'block' : 'none';
    dom.previewArea.value = packedOutputText.slice(0, 45000) + (packedOutputText.length > 45000 ? '\n\n... [Truncated for preview; complete text will download] ...' : '');
});

function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

dom.downloadBtn.addEventListener('click', () => {
    const repoInfo = parseRepoInput(dom.repoUrl.value) || { repo: 'bundle' };
    const suffix = generatedChunks.length > 1 ? `-part${activeChunkIndex + 1}-of-${generatedChunks.length}` : '';
    const filename = `${repoInfo.repo}${suffix}-llm-context.${outputExt}`;
    triggerDownload(packedOutputText, filename, outputMime);
    showToast(`Downloaded ${filename}`, 'info');
});

dom.downloadAllBtn.addEventListener('click', async () => {
    const repoInfo = parseRepoInput(dom.repoUrl.value) || { repo: 'bundle' };
    for (let i = 0; i < generatedChunks.length; i++) {
        const chunk = generatedChunks[i];
        const filename = `${repoInfo.repo}-part${i + 1}-of-${generatedChunks.length}-llm-context.${chunk.ext}`;
        triggerDownload(chunk.text, filename, chunk.mime);
        await sleep(150);
    }
    showToast("Downloaded all parts", "info");
});

dom.copyBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(packedOutputText);
        showToast("Copied context to clipboard!", "info");
        const originalText = dom.copyBtn.textContent;
        dom.copyBtn.textContent = 'Copied!';
        setTimeout(() => { dom.copyBtn.textContent = originalText; }, 2000);
    } catch (_) {
        showToast('Unable to copy automatically. Please copy directly from preview.', 'error');
    }
});

if (dom.shareUrlBtn) {
    dom.shareUrlBtn.addEventListener('click', async () => {
        const deepLink = getDeepLinkUrl();
        try {
            await navigator.clipboard.writeText(deepLink);
            showToast("Deep-link URL copied!", "info");
        } catch (_) {
            showToast(`Link: ${deepLink}`, "info");
        }
    });
}
