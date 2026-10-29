/**
 * Main Application Controller & DOM Orchestration
 */
import { IGNORED_DIRS, IGNORED_FILES } from './config.js';
import { estimateTokens, estimateTokensAsync } from './tokenizer.js';
import { generateTree, renderInteractiveTree } from './tree.js';
import { buildContextOutput, chunkContextOutput } from './formatters.js';
import { minifyCode } from './minifier.js';
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
let cachedSkippedPaths = new Set(); // Set of paths that failed or were binary skips
let cachedRepoInfo = null;
let cachedBranch = "";
let currentActiveSelection = [];
let isPrivateRepo = false;
let currentGeneration = 0;
let repackGeneration = 0;

function updateCachedRawFiles(newFiles) {
    const map = new Map(cachedRawFiles.map(f => [f.path, f]));
    for (const f of newFiles) {
        if (f && f.path) map.set(f.path, f);
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
    if (dom.previewArea) dom.previewArea.value = "";
    if (dom.outputEmptyState) dom.outputEmptyState.style.display = 'flex';
    if (dom.previewArea) dom.previewArea.style.display = 'none';
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
}

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
    packBtn: document.getElementById('packBtn'),
    shareUrlBtn: document.getElementById('shareUrlBtn'),
    abortBtn: document.getElementById('abortBtn'),
    progressTrack: document.getElementById('progressTrack'),
    progressFill: document.getElementById('progressFill'),
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
    startDownloadBtn: document.getElementById('startDownloadBtn'),
    outputCard: document.getElementById('outputCard'),
    outputEmptyState: document.getElementById('outputEmptyState'),
    statFiles: document.getElementById('statFiles'),
    statTokens: document.getElementById('statTokens'),
    statChars: document.getElementById('statChars'),
    statChunks: document.getElementById('statChunks'),
    chunkSelectLabel: document.getElementById('chunkSelectLabel'),
    chunkSelect: document.getElementById('chunkSelect'),
    previewArea: document.getElementById('previewArea'),
    downloadBtn: document.getElementById('downloadBtn'),
    downloadAllBtn: document.getElementById('downloadAllBtn'),
    copyBtn: document.getElementById('copyBtn')
};

function log(msg) {
    if (dom.log) {
        dom.log.style.display = 'block';
        dom.log.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
        dom.log.scrollTop = dom.log.scrollHeight;
    }
}

function updateRateLimitUI(meta) {
    if (meta.remaining !== null && meta.remaining !== undefined && meta.limit !== null && meta.limit !== undefined) {
        const remaining = typeof meta.remaining === 'number' ? meta.remaining : parseInt(meta.remaining, 10);
        const limit = typeof meta.limit === 'number' ? meta.limit : parseInt(meta.limit, 10);
        if (!Number.isNaN(remaining) && !Number.isNaN(limit)) {
            dom.quotaVal.textContent = `${remaining} / ${limit}`;
            dom.quotaVal.className = 'rate-status ' + (
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

async function repackBundleInMemory(activeSelectionNodes = currentActiveSelection) {
    repackGeneration++;
    const thisRepackGen = repackGeneration;

    let selection = activeSelectionNodes || currentActiveSelection;

    if (!cachedRawFiles || cachedRawFiles.length === 0 || !cachedRepoInfo || !selection || selection.length === 0) {
        clearOutputState();
        if (selection && selection.length === 0) {
            log(`[WARN] No files selected for packing.`);
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
    log(`[PACK] Re-packing ${targetFiles.length} cached files in memory (${dom.format.value}, minify: ${minifyMode})...`);

    const processedFiles = targetFiles.map(f => ({
        path: f.path,
        content: minifyCode(f.rawContent, f.path, minifyMode)
    }));

    const paths = processedFiles.map(f => f.path);
    const treeAscii = generateTree(paths);
    const chunkLimitVal = parseInt(dom.chunkLimit.value, 10) || 0;

    const repoWithUrl = { ...cachedRepoInfo, url: getDeepLinkUrl() };

    const newChunks = chunkContextOutput(
        dom.format.value,
        repoWithUrl,
        cachedBranch,
        treeAscii,
        processedFiles,
        chunkLimitVal,
        estimateTokens
    );

    let limitExceeded = false;
    for (const chunk of newChunks) {
        if (chunk.exceedsLimit) limitExceeded = true;
    }
    if (limitExceeded) {
        log(`[WARN] Warning: One or more single files exceed your requested chunk limit of ${chunkLimitVal} tokens.`);
    }

    const firstChunk = newChunks[0];
    const newPackedOutputText = firstChunk.text;

    const estTokens = await estimateTokensAsync(newPackedOutputText);

    if (thisRepackGen !== repackGeneration) {
        // Out-of-order completion, ignore
        return;
    }

    generatedChunks = newChunks;
    activeChunkIndex = 0;
    packedOutputText = newPackedOutputText;
    outputExt = firstChunk.ext;
    outputMime = firstChunk.mime;

    dom.statFiles.textContent = processedFiles.length;
    dom.statChars.textContent = packedOutputText.length.toLocaleString();
    dom.statTokens.textContent = estTokens.toLocaleString();
    dom.statChunks.textContent = generatedChunks.length;

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
    if (dom.previewArea) dom.previewArea.style.display = 'block';
    if (dom.downloadBtn) dom.downloadBtn.disabled = false;
    if (dom.copyBtn) dom.copyBtn.disabled = false;
    log(`[SUCCESS] Context bundle ready: ${generatedChunks.length} chunk(s), ~${estTokens.toLocaleString()} tokens in active chunk.`);
}

// Auto-repack on setting changes if files are already cached
if (dom.format) dom.format.addEventListener('change', () => repackBundleInMemory());
if (dom.minifyMode) dom.minifyMode.addEventListener('change', () => repackBundleInMemory());
if (dom.chunkLimit) dom.chunkLimit.addEventListener('change', () => repackBundleInMemory());

// --- Main Processing Pipeline ---
dom.packBtn.addEventListener('click', async () => {
    if (abortController) {
        abortController.abort();
    }

    const repoInfo = parseRepoInput(dom.repoUrl.value);
    if (!repoInfo) {
        alert('Please enter a valid owner/repo (e.g., "LukeAFullard/senti")');
        return;
    }

    currentGeneration++;
    const thisGen = currentGeneration;

    // Reset repo cache state on new repo lookup
    cachedRawFiles = [];
    cachedSkippedPaths.clear();
    cachedRepoInfo = null;
    cachedBranch = "";
    currentActiveSelection = [];
    isPrivateRepo = false;
    clearOutputState();

    // Auto-fill branch and subpath filter if present in pasted GitHub URL
    if (dom.branch) {
        const userBranch = dom.branch.value.trim();
        const parsedWithOverride = parseRepoInput(dom.repoUrl.value, userBranch);
        if (parsedWithOverride && parsedWithOverride.branch) {
            repoInfo.branch = parsedWithOverride.branch;
            repoInfo.subpath = parsedWithOverride.subpath;
        }
        if (repoInfo.branch && !userBranch) {
            dom.branch.value = repoInfo.branch;
        }
    }

    const pat = dom.pat.value.trim();
    const maxKb = parseInt(dom.maxKb.value, 10) || 150;
    const throttleMs = parseInt(dom.throttleMs.value, 10) || 80;
    const minifyMode = dom.minifyMode ? dom.minifyMode.value : 'none';
    const customIgnoredExts = Array.from(new Set(
        dom.ignoreExt.value.split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean)
    ));

    abortController = new AbortController();
    dom.packBtn.disabled = true;
    dom.abortBtn.style.display = 'inline-flex';
    dom.progressTrack.style.display = 'block';
    dom.progressFill.style.width = '0%';
    dom.log.textContent = '';
    if (dom.outputEmptyState) dom.outputEmptyState.style.display = 'flex';
    if (dom.previewArea) dom.previewArea.style.display = 'none';

    try {
        log(`[FETCH] Querying GitHub API for ${repoInfo.owner}/${repoInfo.repo}...`);

        let targetBranch = dom.branch.value.trim() || repoInfo.branch || '';

        if (!targetBranch || pat) {
            const repoMeta = await resolveDefaultBranch(
                repoInfo.owner,
                repoInfo.repo,
                pat,
                abortController.signal,
                updateRateLimitUI
            );
            if (!targetBranch) targetBranch = repoMeta.branch;
            isPrivateRepo = repoMeta.isPrivate;
        }

        log(`[FETCH] Target branch: ${targetBranch}${isPrivateRepo ? ' (Private Repository)' : ''}`);

        log(`[FETCH] Fetching recursive file manifest...`);
        const rawTree = await fetchRepoTree(
            repoInfo.owner,
            repoInfo.repo,
            targetBranch,
            pat,
            abortController.signal,
            updateRateLimitUI
        );

        if (rawTree.truncated) {
            log(`[WARN] Warning: Git repository tree is truncated by GitHub API (100,000 entries / 7MB limit). Some deeply nested files may not be visible.`);
        }

        // Filter valid source candidates
        const processable = rawTree.filter(node => {
            if (node.type !== 'blob') return false;
            if (node.mode === '120000') return false; // Exclude symlinks
            const pathParts = node.path.split('/');
            const filename = pathParts[pathParts.length - 1].toLowerCase();

            if (pathParts.some(p => IGNORED_DIRS.has(p.toLowerCase()))) return false;
            if (IGNORED_FILES.has(filename)) return false;

            if (customIgnoredExts.some(ext => filename === ext || filename.endsWith('.' + ext))) return false;
            if (node.size !== undefined && node.size > maxKb * 1024) return false;

            return true;
        });

        log(`[FETCH] Discovered ${rawTree.length} objects. Filtered to ${processable.length} text source files.`);

        // Render Interactive Pre-Download Selection Tree
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
                    dom.selectedTokensBadge.textContent = `~${stats.estTokens.toLocaleString()} tok`;
                }
                // If files are already cached, fetch any missing delta files and update packed bundle dynamically
                if (cachedRawFiles && cachedRawFiles.length > 0) {
                    if (currentActiveSelection && currentActiveSelection.length > 0) {
                        await fetchSelectedFilesDelta(currentActiveSelection);
                    }
                    repackBundleInMemory(currentActiveSelection);
                }
            }
        );
        currentActiveSelection = activeSelection;

        // Initial token badge update
        if (treeControls.getSelectedStats && dom.selectedTokensBadge) {
            const stats = treeControls.getSelectedStats();
            dom.selectedTokensBadge.textContent = `~${stats.estTokens.toLocaleString()} tok`;
        }

        dom.selectAllBtn.onclick = () => treeControls.selectAll(true);
        dom.deselectAllBtn.onclick = () => treeControls.selectAll(false);
        if (dom.deselectLargeBtn) {
            dom.deselectLargeBtn.onclick = () => {
                const kbVal = parseInt(dom.largeFileThresholdKb ? dom.largeFileThresholdKb.value : '50', 10) || 50;
                treeControls.deselectLarge(kbVal * 1024);
            };
        }
        if (dom.expandAllBtn) dom.expandAllBtn.onclick = () => treeControls.expandAll(true);
        if (dom.collapseAllBtn) dom.collapseAllBtn.onclick = () => treeControls.expandAll(false);
        if (dom.treeFilterInput) {
            dom.treeFilterInput.value = repoInfo.subpath || '';
            dom.treeFilterInput.oninput = () => treeControls.filter(dom.treeFilterInput.value, false);
            if (repoInfo.subpath) {
                treeControls.filter(repoInfo.subpath, true);
                if (treeControls.selectBySubpath) {
                    treeControls.selectBySubpath(repoInfo.subpath);
                }
            }
        }

        log(`[INSPECT] Review file selection in tree above and click "Pack Selected Files" when ready.`);

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
                dom.abortBtn.style.display = 'inline-flex';
                dom.progressTrack.style.display = 'block';
                dom.progressFill.style.width = '0%';
                let completedDelta = 0;

                try {
                    async function worker() {
                        while (index < missingNodes.length) {
                            if (signal.aborted) break;
                            if (thisGen !== currentGeneration) break;
                            const i = index++;
                            const node = missingNodes[i];
                            log(`[FETCH] Fetching delta ${node.path}...`);

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
                            dom.progressFill.style.width = `${Math.round((completedDelta / missingNodes.length) * 100)}%`;

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
                    dom.abortBtn.style.display = 'none';
                }
            }).catch((err) => {
                if (err.name === 'AbortError') {
                    log('[CANCEL] Delta fetch cancelled by user.');
                } else {
                    log(`[ERROR] Delta fetch error: ${err.message || err}`);
                }
                dom.abortBtn.style.display = 'none';
            });
            return deltaFetchQueue;
        }

        await new Promise((resolve, reject) => {
            const onStart = async () => {
                if (!hasDownloaded) {
                    hasDownloaded = true;
                    cleanup();
                    resolve();
                } else {
                    if (currentActiveSelection && currentActiveSelection.length > 0) {
                        await fetchSelectedFilesDelta(currentActiveSelection);
                    }
                    repackBundleInMemory(currentActiveSelection);
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
            log('[WARN] No files selected for packing.');
            clearOutputState();
            return;
        }

        log(`[FETCH] Starting parallel download for ${selectionSnapshot.length} selected file(s) (concurrency: 5)...`);

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
                log(`[FETCH] [${i + 1}/${selectionSnapshot.length}] Fetching ${node.path}...`);

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
                        log(`[LIMIT] Rate limit warning for ${node.path}. Retry ${retries}/3 cooling down for ${backoffTime}s...`);
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
                        log(`[WARN] Skipping ${node.path}: Binary content detected.`);
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
                dom.progressFill.style.width = `${Math.round((completedCount / selectionSnapshot.length) * 100)}%`;

                if (throttleMs > 0) {
                    await sleep(throttleMs, abortController.signal);
                }
            }
        }

        const workers = Array.from({ length: Math.min(concurrency, selectionSnapshot.length) }, () => worker());
        await Promise.all(workers);

        const collectedFiles = results.filter(Boolean);

        log(`[SUCCESS] Download complete: ${collectedFiles.length} file(s) processed (${emptyCount} empty), ${failedCount} failed.`);

        if (collectedFiles.length === 0) {
            log('[WARN] No content could be fetched from the selected files.');
            return;
        }

        cachedRawFiles = collectedFiles;
        cachedRepoInfo = repoInfo;
        cachedBranch = targetBranch;

        await repackBundleInMemory();

    } catch (err) {
        if (err.name === 'AbortError') {
            log('[CANCEL] Process cancelled by user.');
        } else {
            log(`[ERROR] Error: ${err.message}`);
        }
    } finally {
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

    const estTokens = await estimateTokensAsync(packedOutputText);
    dom.statChars.textContent = packedOutputText.length.toLocaleString();
    dom.statTokens.textContent = estTokens.toLocaleString();
    dom.previewArea.value = packedOutputText.slice(0, 45000) + (packedOutputText.length > 45000 ? '\n\n... [Truncated for preview; complete text will download] ...' : '');
});

dom.downloadBtn.addEventListener('click', () => {
    const repoInfo = parseRepoInput(dom.repoUrl.value) || { repo: 'bundle' };
    const blob = new Blob([packedOutputText], { type: outputMime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const suffix = generatedChunks.length > 1 ? `-part${activeChunkIndex + 1}-of-${generatedChunks.length}` : '';
    a.download = `${repoInfo.repo}${suffix}-llm-context.${outputExt}`;
    a.click();
    URL.revokeObjectURL(url);
});

dom.downloadAllBtn.addEventListener('click', async () => {
    const repoInfo = parseRepoInput(dom.repoUrl.value) || { repo: 'bundle' };
    for (let i = 0; i < generatedChunks.length; i++) {
        const chunk = generatedChunks[i];
        const blob = new Blob([chunk.text], { type: chunk.mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${repoInfo.repo}-part${i + 1}-of-${generatedChunks.length}-llm-context.${chunk.ext}`;
        a.click();
        URL.revokeObjectURL(url);
        await sleep(150, abortController ? abortController.signal : null);
    }
});

dom.copyBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(packedOutputText);
        const originalHTML = dom.copyBtn.innerHTML;
        dom.copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Copied!</span>`;
        setTimeout(() => { dom.copyBtn.innerHTML = originalHTML; }, 2000);
    } catch (_) {
        alert('Unable to copy automatically. Please copy directly from the preview textarea.');
    }
});

if (dom.shareUrlBtn) {
    dom.shareUrlBtn.addEventListener('click', async () => {
        const deepLink = getDeepLinkUrl();
        try {
            await navigator.clipboard.writeText(deepLink);
            const originalHTML = dom.shareUrlBtn.innerHTML;
            dom.shareUrlBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Link Copied!</span>`;
            setTimeout(() => { dom.shareUrlBtn.innerHTML = originalHTML; }, 2000);
        } catch (_) {
            alert(`Deep-Link URL:\n${deepLink}`);
        }
    });
}
