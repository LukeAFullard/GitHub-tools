/**
 * Main Application Controller & DOM Orchestration
 */
import { IGNORED_DIRS, IGNORED_FILES } from './config.js';
import { estimateTokens } from './tokenizer.js';
import { generateTree } from './tree.js';
import { buildContextOutput } from './formatters.js';
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
    packBtn: document.getElementById('packBtn'),
    abortBtn: document.getElementById('abortBtn'),
    progressTrack: document.getElementById('progressTrack'),
    progressFill: document.getElementById('progressFill'),
    log: document.getElementById('log'),
    outputCard: document.getElementById('outputCard'),
    statFiles: document.getElementById('statFiles'),
    statTokens: document.getElementById('statTokens'),
    statChars: document.getElementById('statChars'),
    previewArea: document.getElementById('previewArea'),
    downloadBtn: document.getElementById('downloadBtn'),
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

        // Sequential download with secondary rate-limit compliance
        const collectedFiles = [];
        for (let i = 0; i < processable.length; i++) {
            const node = processable[i];
            log(`[${i + 1}/${processable.length}] Fetching ${node.path}...`);

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

            dom.progressFill.style.width = `${Math.round(((i + 1) / processable.length) * 100)}%`;

            if (throttleMs > 0 && i < processable.length - 1) {
                await sleep(throttleMs);
            }
        }

        log(`Structuring bundle into ${dom.format.value}...`);
        const paths = collectedFiles.map(f => f.path);
        const treeAscii = generateTree(paths);

        const output = buildContextOutput(dom.format.value, repoInfo, targetBranch, treeAscii, collectedFiles);
        packedOutputText = output.text;
        outputExt = output.ext;
        outputMime = output.mime;

        log(`Running BPE token estimation...`);
        const estTokens = estimateTokens(packedOutputText);

        dom.statFiles.textContent = collectedFiles.length;
        dom.statChars.textContent = packedOutputText.length.toLocaleString();
        dom.statTokens.textContent = estTokens.toLocaleString();
        dom.previewArea.value = packedOutputText.slice(0, 45000) + (packedOutputText.length > 45000 ? '\n\n... [Truncated for preview; complete text will download] ...' : '');
        dom.outputCard.style.display = 'flex';
        log(`✅ Context bundle ready: ~${estTokens.toLocaleString()} tokens.`);

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

dom.downloadBtn.addEventListener('click', () => {
    const repoInfo = parseRepoInput(dom.repoUrl.value) || { repo: 'bundle' };
    const blob = new Blob([packedOutputText], { type: outputMime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${repoInfo.repo}-llm-context.${outputExt}`;
    a.click();
    URL.revokeObjectURL(url);
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
