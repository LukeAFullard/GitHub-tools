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
    if (meta.remaining !== null && meta.limit !== null) {
        dom.quotaVal.textContent = `${meta.remaining} / ${meta.limit}`;
        dom.quotaVal.className = 'rate-status ' + (
            meta.remaining < 5 ? 'rate-critical' : meta.remaining < 20 ? 'rate-warning' : 'rate-normal'
        );
    }
    if (meta.reset) {
        const resetDate = new Date(parseInt(meta.reset, 10) * 1000);
        dom.resetVal.textContent = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    const customIgnoredExts = new Set(
        dom.ignoreExt.value.split(',').map(s => s.trim().toLowerCase().replace(/^\./, ''))
    );

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

        // Filter valid source candidates
        const processable = rawTree.filter(node => {
            if (node.type !== 'blob') return false;
            const pathParts = node.path.split('/');
            const filename = pathParts[pathParts.length - 1].toLowerCase();

            if (pathParts.some(p => IGNORED_DIRS.has(p.toLowerCase()))) return false;
            if (IGNORED_FILES.has(filename)) return false;

            const ext = filename.includes('.') ? filename.split('.').pop() : '';
            if (customIgnoredExts.has(ext)) return false;
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
                dom.startDownloadBtn.removeEventListener('click', onStart);
                resolve();
            };
            dom.startDownloadBtn.addEventListener('click', onStart);

            if (abortController.signal) {
                abortController.signal.addEventListener('abort', () => {
                    dom.startDownloadBtn.removeEventListener('click', onStart);
                    reject(new DOMException('Aborted by user', 'AbortError'));
                });
            }
        });

        if (activeSelection.length === 0) {
            log('⚠️ No files selected for packing.');
            return;
        }

        log(`Starting download for ${activeSelection.length} selected file(s)...`);

        // Sequential download with secondary rate-limit compliance
        const collectedFiles = [];
        for (let i = 0; i < activeSelection.length; i++) {
            const node = activeSelection[i];
            log(`[${i + 1}/${activeSelection.length}] Fetching ${node.path}...`);

            const result = await fetchFileContent(
                repoInfo.owner,
                repoInfo.repo,
                targetBranch,
                node.path,
                pat,
                abortController.signal,
                updateRateLimitUI
            );

            if (result.backoff) {
                log(`🚨 Hit secondary limit! Cooling down for ${result.backoff}s...`);
                await sleep(result.backoff * 1000);
                i--; // Retry item
                continue;
            }

            if (result.content) {
                const processedContent = minifyCode(result.content, node.path, minifyMode);
                collectedFiles.push({ path: node.path, content: processedContent });
            }

            dom.progressFill.style.width = `${Math.round(((i + 1) / activeSelection.length) * 100)}%`;

            if (throttleMs > 0 && i < activeSelection.length - 1) {
                await sleep(throttleMs);
            }
        }

        log(`Structuring bundle into ${dom.format.value}...`);
        const paths = collectedFiles.map(f => f.path);
        const treeAscii = generateTree(paths);

        const chunkLimitVal = parseInt(dom.chunkLimit.value, 10) || 0;
        generatedChunks = chunkContextOutput(
            dom.format.value,
            repoInfo,
            targetBranch,
            treeAscii,
            collectedFiles,
            chunkLimitVal,
            estimateTokens
        );

        activeChunkIndex = 0;
        const firstChunk = generatedChunks[0];
        packedOutputText = firstChunk.text;
        outputExt = firstChunk.ext;
        outputMime = firstChunk.mime;

        log(`Running BPE token estimation via Web Worker...`);
        const estTokens = await estimateTokensAsync(packedOutputText);

        dom.statFiles.textContent = collectedFiles.length;
        dom.statChars.textContent = packedOutputText.length.toLocaleString();
        dom.statTokens.textContent = estTokens.toLocaleString();
        dom.statChunks.textContent = generatedChunks.length;

        // Chunk selection dropdown UI setup
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
        await sleep(150);
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
