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
let cachedRepoInfo = null;
let cachedBranch = "";

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
    abortBtn: document.getElementById('abortBtn'),
    progressTrack: document.getElementById('progressTrack'),
    progressFill: document.getElementById('progressFill'),
    log: document.getElementById('log'),
    treeCard: document.getElementById('treeCard'),
    treeContainer: document.getElementById('treeContainer'),
    manifestCount: document.getElementById('manifestCount'),
    selectedCount: document.getElementById('selectedCount'),
    selectAllBtn: document.getElementById('selectAllBtn'),
    deselectAllBtn: document.getElementById('deselectAllBtn'),
    startDownloadBtn: document.getElementById('startDownloadBtn'),
    outputCard: document.getElementById('outputCard'),
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
    dom.log.style.display = 'block';
    dom.log.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    dom.log.scrollTop = dom.log.scrollHeight;
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

async function repackBundleInMemory() {
    if (!cachedRawFiles || cachedRawFiles.length === 0 || !cachedRepoInfo) return;

    const minifyMode = dom.minifyMode ? dom.minifyMode.value : 'none';
    log(`⚡ Re-packing cached files in memory (${dom.format.value}, minify: ${minifyMode})...`);

    const processedFiles = cachedRawFiles.map(f => ({
        path: f.path,
        content: minifyCode(f.rawContent, f.path, minifyMode)
    }));

    const paths = processedFiles.map(f => f.path);
    const treeAscii = generateTree(paths);
    const chunkLimitVal = parseInt(dom.chunkLimit.value, 10) || 0;

    generatedChunks = chunkContextOutput(
        dom.format.value,
        cachedRepoInfo,
        cachedBranch,
        treeAscii,
        processedFiles,
        chunkLimitVal,
        estimateTokens
    );

    let limitExceeded = false;
    for (const chunk of generatedChunks) {
        if (chunk.exceedsLimit) limitExceeded = true;
    }
    if (limitExceeded) {
        log(`⚠️ Warning: One or more single files exceed your requested chunk limit of ${chunkLimitVal} tokens.`);
    }

    activeChunkIndex = 0;
    const firstChunk = generatedChunks[0];
    packedOutputText = firstChunk.text;
    outputExt = firstChunk.ext;
    outputMime = firstChunk.mime;

    const estTokens = await estimateTokensAsync(packedOutputText);

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
    dom.outputCard.style.display = 'flex';
    log(`✅ Context bundle ready: ${generatedChunks.length} chunk(s), ~${estTokens.toLocaleString()} tokens in active chunk.`);
}

// Auto-repack on setting changes if files are already cached
if (dom.format) dom.format.addEventListener('change', () => repackBundleInMemory());
if (dom.minifyMode) dom.minifyMode.addEventListener('change', () => repackBundleInMemory());
if (dom.chunkLimit) dom.chunkLimit.addEventListener('change', () => repackBundleInMemory());

// --- Main Processing Pipeline ---
dom.packBtn.addEventListener('click', async () => {
    const repoInfo = parseRepoInput(dom.repoUrl.value);
    if (!repoInfo) {
        alert('Please enter a valid owner/repo (e.g., "LukeAFullard/senti")');
        return;
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
    dom.outputCard.style.display = 'none';

    try {
        log(`Querying GitHub API for ${repoInfo.owner}/${repoInfo.repo}...`);

        let targetBranch = dom.branch.value.trim();
        if (!targetBranch) {
            targetBranch = await resolveDefaultBranch(
                repoInfo.owner,
                repoInfo.repo,
                pat,
                abortController.signal,
                updateRateLimitUI
            );
        }
        log(`Target branch: ${targetBranch}`);

        log(`Fetching recursive file manifest...`);
        const rawTree = await fetchRepoTree(
            repoInfo.owner,
            repoInfo.repo,
            targetBranch,
            pat,
            abortController.signal,
            updateRateLimitUI
        );

        if (rawTree.truncated) {
            log(`⚠️ Warning: Git repository tree is truncated by GitHub API (>10,000 files). Some deeply nested files may not be visible.`);
        }

        // Filter valid source candidates
        const processable = rawTree.filter(node => {
            if (node.type !== 'blob') return false;
            const pathParts = node.path.split('/');
            const filename = pathParts[pathParts.length - 1].toLowerCase();

            if (pathParts.some(p => IGNORED_DIRS.has(p.toLowerCase()))) return false;
            if (IGNORED_FILES.has(filename)) return false;

            if (customIgnoredExts.some(ext => filename === ext || filename.endsWith('.' + ext))) return false;
            if (node.size && node.size > maxKb * 1024) return false;

            return true;
        });

        log(`Discovered ${rawTree.length} objects. Filtered to ${processable.length} text source files.`);

        // Render Interactive Pre-Download Selection Tree
        dom.manifestCount.textContent = processable.length;
        dom.selectedCount.textContent = processable.length;
        dom.treeCard.style.display = 'flex';

        let activeSelection = [...processable];

        const treeControls = renderInteractiveTree(
            processable,
            dom.treeContainer,
            (selectedNodes) => {
                activeSelection = selectedNodes;
                dom.selectedCount.textContent = activeSelection.length;
            }
        );

        dom.selectAllBtn.onclick = () => treeControls.selectAll(true);
        dom.deselectAllBtn.onclick = () => treeControls.selectAll(false);

        log(`🔍 Review file selection in tree above and click "⚡ Pack Selected Files" when ready.`);

        await new Promise((resolve, reject) => {
            const onStart = () => {
                cleanup();
                resolve();
            };
            const onAbort = () => {
                cleanup();
                reject(new DOMException('Aborted by user', 'AbortError'));
            };
            const cleanup = () => {
                dom.startDownloadBtn.removeEventListener('click', onStart);
                if (abortController.signal) {
                    abortController.signal.removeEventListener('abort', onAbort);
                }
            };
            dom.startDownloadBtn.addEventListener('click', onStart);
            if (abortController.signal) {
                abortController.signal.addEventListener('abort', onAbort);
            }
        });

        if (activeSelection.length === 0) {
            log('⚠️ No files selected for packing.');
            return;
        }

        log(`Starting download for ${activeSelection.length} selected file(s)...`);

        const collectedFiles = [];
        let emptyCount = 0;
        let failedCount = 0;

        for (let i = 0; i < activeSelection.length; i++) {
            const node = activeSelection[i];
            log(`[${i + 1}/${activeSelection.length}] Fetching ${node.path}...`);

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
                    updateRateLimitUI
                );

                if (result.backoff) {
                    retries++;
                    const backoffTime = Math.min(result.backoff, 60);
                    log(`🚨 Rate limit warning for ${node.path}. Retry ${retries}/3 cooling down for ${backoffTime}s...`);
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
                // Inspect first ~512 chars for null bytes to detect binary content
                const sample = rawContent.slice(0, 512);
                if (sample.includes('\0')) {
                    log(`⚠️ Skipping ${node.path}: Binary content detected (null bytes).`);
                    continue;
                }
                collectedFiles.push({ path: node.path, rawContent: rawContent });
            } else {
                failedCount++;
                log(`❌ Failed to fetch ${node.path}${result && result.error ? `: ${result.error}` : ''}`);
            }

            dom.progressFill.style.width = `${Math.round(((i + 1) / activeSelection.length) * 100)}%`;

            if (throttleMs > 0 && i < activeSelection.length - 1) {
                await sleep(throttleMs, abortController.signal);
            }
        }

        log(`Download complete: ${collectedFiles.length} file(s) processed (${emptyCount} empty), ${failedCount} failed.`);

        if (collectedFiles.length === 0) {
            log('⚠️ No content could be fetched from the selected files.');
            return;
        }

        cachedRawFiles = collectedFiles;
        cachedRepoInfo = repoInfo;
        cachedBranch = targetBranch;

        await repackBundleInMemory();

    } catch (err) {
        if (err.name === 'AbortError') {
            log('🛑 Process cancelled by user.');
        } else {
            log(`❌ Error: ${err.message}`);
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
        const originalText = dom.copyBtn.textContent;
        dom.copyBtn.textContent = '✅ Copied!';
        setTimeout(() => { dom.copyBtn.textContent = originalText; }, 2000);
    } catch (_) {
        alert('Unable to copy automatically. Please copy directly from the preview textarea.');
    }
});
