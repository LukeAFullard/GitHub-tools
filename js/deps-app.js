/**
 * Controller for the Dependencies tab (deps.html): finds manifests in a GitHub repo or a local
 * .zip, looks up licenses on deps.dev, groups them for review and packs a report for an AI.
 */
import { parseRepoInput } from './github-api.js';
import { fetchRepoInfo, fetchRepoManifests, readZipManifests, collectDirectDependencies, resolveLicenses } from './deps-api.js';
import { classifyLicense, guessLicenseFromText, LICENSE_GROUPS, GROUP_LABELS, GROUP_HINTS } from './license-classify.js';
import { buildDepsOutput, groupCounts, sortPackages } from './deps-formatters.js';
import { parseZipArchive } from './zip-loader.js';
import { escapeXml } from './formatters.js';
import { estimateTokensAsync } from './tokenizer.js';
import { TARGETS, detectTarget } from './targets.js';
import { switchTab } from './ui-tabs.js';
import { renderBanner } from './ui-banner.js';
import { buildTabHref } from './nav.js';

const $ = id => document.getElementById(id);
const dom = {
    repoUrl: $('repoUrl'), loadBtn: $('loadDepsBtn'), uploadZipBtn: $('uploadZipBtn'), zipFileInput: $('zipFileInput'),
    abortBtn: $('abortBtn'), optionsToggleBtn: $('optionsToggleBtn'), optionsToggleSummary: $('optionsToggleSummary'),
    optionsDrawer: $('optionsDrawer'), drawerDoneBtn: $('drawerDoneBtn'), drawerTokenLink: $('drawerTokenLink'),
    tokenPanel: $('tokenPanel'), tokenPanelMessage: $('tokenPanelMessage'), pat: $('pat'),
    repoInputError: $('repoInputError'), sourceNote: $('sourceNote'), exampleRepos: $('exampleRepos'),
    targetBar: $('targetBar'), formatField: $('formatField'), format: $('format'),
    includeTransitive: $('includeTransitive'), includeDev: $('includeDev'), skipExamples: $('skipExamples'),
    compactPermissive: $('compactPermissive'), aiInstructions: $('aiInstructions'),
    instructionsCharCount: $('instructionsCharCount'), clearInstructionsBtn: $('clearInstructionsBtn'),
    statPackages: $('statPackages'), repoLicenseText: $('repoLicenseText'), statTokens: $('statTokens'),
    targetBudgetDisplay: $('targetBudgetDisplay'), groupPills: $('groupPills'),
    depSearchInput: $('depSearchInput'), ecosystemFilter: $('ecosystemFilter'), relationFilter: $('relationFilter'),
    advisoriesOnly: $('advisoriesOnly'), matchCount: $('matchCount'), depsEmptyState: $('depsEmptyState'),
    depsList: $('depsList'), outputScopeNote: $('outputScopeNote'),
    wrapToggleBtn: $('wrapToggleBtn'), copyBtn: $('copyBtn'), downloadBtn: $('downloadBtn'),
    warningBanner: $('warningBanner'), summaryCard: $('summaryCard'), outputEmptyState: $('outputEmptyState'),
    togglePreviewBtn: $('togglePreviewBtn'), previewArea: $('previewArea'),
    logHeader: $('logHeader'), logSummary: $('logSummary'), logToggleBtn: $('logToggleBtn'),
    progressTrack: $('progressTrack'), progressFill: $('progressFill'), log: $('log'),
    tabListBtn: $('tabListBtn'), tabOutputBtn: $('tabOutputBtn'), depsCard: $('depsCard'), outputCard: $('outputCard'),
    mobilePrimaryBtn: $('mobilePrimaryBtn'), step1: $('step1'), step2: $('step2'), step3: $('step3'),
    themeToggleBtn: $('themeToggleBtn'), shareUrlBtn: $('shareUrlBtn'), toastContainer: $('toastContainer'),
    tabCodeLink: $('tabCodeLink'), tabIssuesLink: $('tabIssuesLink'), tabDiscussionsLink: $('tabDiscussionsLink'), tabDepsLink: $('tabDepsLink')
};

const VALID_FORMATS = ['claude-xml', 'markdown', 'generic-xml', 'json'];
let state = {
    appState: 'empty',          // 'empty' | 'loaded'
    targetKey: 'claude',
    budget: 200000,
    source: null,               // { kind: 'github', owner, repo } | { kind: 'zip', archive }
    repoName: '',
    sourceText: '',
    repoLicense: null,
    manifests: [],
    directDeps: [],
    packages: [],
    warnings: [],
    groupFilter: null,
    output: null
};
let controller = null;
let generation = 0;

// ------------------------------------------------------------------ small UI helpers

function showToast(message, type = 'info') {
    if (!dom.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 250); }, 3500);
}

function log(msg) {
    if (dom.log) { dom.log.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`; dom.log.scrollTop = dom.log.scrollHeight; }
    if (dom.logSummary) dom.logSummary.textContent = msg.replace(/^\[[A-Z]+\]\s*/, '');
}

function progress(percent) {
    const v = Math.min(100, Math.max(0, Math.round(percent)));
    if (dom.progressFill) dom.progressFill.style.width = `${v}%`;
    if (dom.progressTrack) dom.progressTrack.setAttribute('aria-valuenow', String(v));
}

function showError(msg) {
    if (!dom.repoInputError) return;
    dom.repoInputError.textContent = msg || '';
    dom.repoInputError.style.display = msg ? 'block' : 'none';
}

function showTokenPanel(message = '') {
    if (dom.tokenPanel) { dom.tokenPanel.hidden = false; dom.tokenPanel.removeAttribute('hidden'); }
    if (dom.tokenPanelMessage) dom.tokenPanelMessage.textContent = message;
}

function copyLabel() {
    const names = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
    return names[state.targetKey] ? `Copy for ${names[state.targetKey]}` : 'Copy';
}

function setAppState(next) {
    state.appState = next;
    if (document.body) document.body.classList.toggle('is-empty', next === 'empty');
    if (dom.step1) dom.step1.classList.toggle('active', next === 'empty');
    if (dom.step2) dom.step2.classList.toggle('active', next === 'loaded');
    if (dom.mobilePrimaryBtn) dom.mobilePrimaryBtn.textContent = next === 'empty' ? 'Load dependencies' : copyLabel();
}

const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
};

// ------------------------------------------------------------------ settings & target

function updateSettingsSummary() {
    const target = TARGETS[state.targetKey] || TARGETS.custom;
    const parts = [target.label, dom.includeTransitive.checked ? 'direct + transitive' : 'direct only'];
    if (dom.includeDev.checked) parts.push('with dev');
    if (dom.optionsToggleSummary) dom.optionsToggleSummary.textContent = `Settings: ${parts.join(' · ')}`;
}

function saveSettings() {
    store.set('cfg_deps_includeTransitive', String(dom.includeTransitive.checked));
    store.set('cfg_deps_includeDev', String(dom.includeDev.checked));
    store.set('cfg_deps_skipExamples', String(dom.skipExamples.checked));
    store.set('cfg_deps_compactPermissive', String(dom.compactPermissive.checked));
    store.set('cfg_deps_aiInstructions', dom.aiInstructions.value);
    if (dom.format) store.set('cfg_format', dom.format.value);
}

function loadSettings() {
    const bool = (k, el) => { const v = store.get(k); if (v !== null && el) el.checked = v === 'true'; };
    bool('cfg_deps_includeTransitive', dom.includeTransitive);
    bool('cfg_deps_includeDev', dom.includeDev);
    bool('cfg_deps_skipExamples', dom.skipExamples);
    bool('cfg_deps_compactPermissive', dom.compactPermissive);
    const inst = store.get('cfg_deps_aiInstructions');
    if (inst !== null) dom.aiInstructions.value = inst;
    const fmt = store.get('cfg_format');
    if (VALID_FORMATS.includes(fmt) && dom.format) dom.format.value = fmt;
    const budget = parseInt(store.get('cfg_budgetWindow') || '', 10);
    if (budget > 0) state.budget = budget;
    dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
}

export function applyTarget(key) {
    state.targetKey = key in TARGETS ? key : 'custom';
    const t = TARGETS[state.targetKey];
    if (state.targetKey !== 'custom' && t.format) {
        if (dom.format) dom.format.value = t.format;
        if (t.budget) state.budget = t.budget;
    }
    if (dom.formatField) dom.formatField.hidden = state.targetKey !== 'custom';
    if (dom.targetBar) {
        dom.targetBar.querySelectorAll('button[data-target]').forEach(b => {
            b.setAttribute('aria-pressed', b.dataset.target === state.targetKey ? 'true' : 'false');
        });
    }
    store.set('cfg_target', state.targetKey);
    updateSettingsSummary();
    if (dom.copyBtn) dom.copyBtn.textContent = copyLabel();
    rebuildOutput();
}

// ------------------------------------------------------------------ filtering & rendering

function filteredPackages() {
    const q = (dom.depSearchInput.value || '').trim().toLowerCase();
    const eco = dom.ecosystemFilter.value;
    const rel = dom.relationFilter.value;
    const advOnly = dom.advisoriesOnly.checked;
    return state.packages.filter(p => {
        if (state.groupFilter && p.license.group !== state.groupFilter) return false;
        if (eco && p.ecosystem !== eco) return false;
        if (rel && p.relation !== rel) return false;
        if (advOnly && !(p.advisories && p.advisories.length)) return false;
        if (q && !p.name.toLowerCase().includes(q) && !(p.license.expression || '').toLowerCase().includes(q)) return false;
        return true;
    });
}

function renderGroupPills() {
    const counts = groupCounts(state.packages);
    dom.groupPills.innerHTML = '';
    for (const g of LICENSE_GROUPS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `nlp-pill license-pill license-${g}${state.groupFilter === g ? ' active' : ''}`;
        btn.setAttribute('aria-pressed', state.groupFilter === g ? 'true' : 'false');
        btn.title = GROUP_HINTS[g];
        btn.innerHTML = `<span>${escapeXml(GROUP_LABELS[g])}</span><span class="nlp-pill-count">${counts[g]}</span>`;
        btn.disabled = counts[g] === 0;
        btn.addEventListener('click', () => {
            state.groupFilter = state.groupFilter === g ? null : g;
            renderAll();
        });
        dom.groupPills.appendChild(btn);
    }
}

function renderList() {
    const visible = sortPackages(filteredPackages());
    dom.matchCount.textContent = state.packages.length ? `${visible.length} / ${state.packages.length}` : '';
    if (state.packages.length === 0) {
        dom.depsEmptyState.style.display = 'flex';
        dom.depsList.style.display = 'none';
        return visible;
    }
    dom.depsEmptyState.style.display = 'none';
    dom.depsList.style.display = 'block';
    dom.depsList.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const p of visible.slice(0, 1000)) {
        const li = document.createElement('li');
        li.className = 'issue-item dep-item';
        const main = document.createElement('div');
        main.className = 'issue-main';
        const title = document.createElement('div');
        title.className = 'issue-title-row';
        const badge = document.createElement('span');
        badge.className = `issue-state-badge license-badge license-${p.license.group}`;
        badge.textContent = GROUP_LABELS[p.license.group];
        badge.title = GROUP_HINTS[p.license.group];
        const name = document.createElement('span');
        name.className = 'issue-title';
        name.textContent = `${p.name}@${p.version || '?'}`;
        const lic = document.createElement('span');
        lic.className = 'issue-number';
        lic.textContent = p.license.expression || (p.status === 'not-found' ? 'not on deps.dev' : 'no license data');
        title.append(badge, name, lic);
        const meta = document.createElement('div');
        meta.className = 'issue-meta-row';
        const bits = [p.ecosystem, p.relation + (p.dev ? ' (dev)' : '')];
        if (p.via && p.via.length) bits.push(`via ${p.via.slice(0, 2).join(', ')}${p.via.length > 2 ? '…' : ''}`);
        if (p.versionKind === 'range-min') bits.push('lowest version in range');
        if (p.versionKind === 'latest') bits.push('latest release');
        meta.innerHTML = bits.map(b => `<span>${escapeXml(b)}</span>`).join('<span>•</span>');
        if (p.advisories && p.advisories.length) {
            const adv = document.createElement('span');
            adv.className = 'issue-label-pill dep-advisory';
            adv.textContent = `${p.advisories.length} advisor${p.advisories.length === 1 ? 'y' : 'ies'}`;
            adv.title = p.advisories.slice(0, 10).join(', ');
            meta.appendChild(adv);
        }
        for (const note of p.license.notes || []) {
            const n = document.createElement('span');
            n.className = 'issue-label-pill';
            n.textContent = note;
            meta.appendChild(n);
        }
        main.append(title, meta);
        li.appendChild(main);
        frag.appendChild(li);
    }
    dom.depsList.appendChild(frag);
    if (visible.length > 1000) {
        const more = document.createElement('li');
        more.className = 'field-helper';
        more.style.padding = '0.5rem 0.85rem';
        more.textContent = `Showing the first 1,000 of ${visible.length}. The output includes all of them.`;
        dom.depsList.appendChild(more);
    }
    return visible;
}

let outputGen = 0;
async function rebuildOutput() {
    if (state.appState !== 'loaded') return;
    const myGen = ++outputGen;
    const visible = filteredPackages();
    const out = buildDepsOutput(dom.format.value, {
        repoName: state.repoName,
        source: state.sourceText,
        repoLicense: state.repoLicense,
        packages: visible,
        manifests: state.manifests,
        includeTransitive: dom.includeTransitive.checked,
        includeDev: dom.includeDev.checked,
        compactPermissive: dom.compactPermissive.checked,
        warnings: state.warnings,
        instructions: dom.aiInstructions.value
    });
    state.output = out;
    dom.previewArea.value = out.text.slice(0, 45000) + (out.text.length > 45000 ? '\n\n... [Truncated for preview] ...' : '');
    dom.outputEmptyState.style.display = 'none';
    if (dom.togglePreviewBtn) dom.togglePreviewBtn.style.display = 'inline-flex';
    dom.copyBtn.disabled = false;
    dom.downloadBtn.disabled = false;
    dom.copyBtn.textContent = copyLabel();
    const filtersOn = visible.length !== state.packages.length;
    dom.outputScopeNote.textContent = filtersOn
        ? `The output includes the ${visible.length} package${visible.length === 1 ? '' : 's'} shown (filters are on).`
        : `The output includes all ${visible.length} package${visible.length === 1 ? '' : 's'}.`;

    const tokens = await estimateTokensAsync(out.text);
    if (myGen !== outputGen) return;
    dom.statTokens.textContent = tokens.toLocaleString();
    dom.targetBudgetDisplay.textContent = tokens > state.budget
        ? `over the ${state.budget.toLocaleString()} target: filter or list permissive packages briefly`
        : `of ${state.budget.toLocaleString()}`;
    const counts = groupCounts(visible);
    const review = counts['strong-copyleft'] + counts['weak-copyleft'] + counts['restricted'];
    const advisories = visible.reduce((n, p) => n + ((p.advisories && p.advisories.length) ? 1 : 0), 0);
    dom.summaryCard.innerHTML = '';
    for (const line of [
        `${visible.length} package${visible.length === 1 ? '' : 's'} · about ${tokens.toLocaleString()} tokens`,
        `${review} to review (copyleft or restricted) · ${counts.unknown} unknown`,
        `${advisories} with known security advisories`
    ]) {
        const el = document.createElement('div');
        el.textContent = line;
        dom.summaryCard.appendChild(el);
    }
    dom.summaryCard.hidden = false;
}

function renderAll() {
    renderGroupPills();
    renderList();
    rebuildOutput();
}

function fillEcosystemFilter() {
    const ecos = [...new Set(state.packages.map(p => p.ecosystem))].sort();
    dom.ecosystemFilter.innerHTML = '<option value="">Ecosystem: All</option>'
        + ecos.map(e => `<option value="${e}">${e} (${state.packages.filter(p => p.ecosystem === e).length})</option>`).join('');
}

function resetView() {
    state.packages = [];
    state.groupFilter = null;
    state.output = null;
    state.warnings = [];
    dom.statPackages.textContent = '0';
    dom.statTokens.textContent = '0';
    dom.repoLicenseText.textContent = '-';
    dom.previewArea.value = '';
    dom.previewArea.style.display = 'none';
    dom.copyBtn.disabled = true;
    dom.downloadBtn.disabled = true;
    dom.summaryCard.hidden = true;
    dom.outputEmptyState.style.display = 'flex';
    if (dom.togglePreviewBtn) {
        dom.togglePreviewBtn.style.display = 'none';
        dom.togglePreviewBtn.setAttribute('aria-expanded', 'false');
        dom.togglePreviewBtn.textContent = 'Show preview';
    }
    renderBanner(dom.warningBanner, []);
    renderGroupPills();
    renderList();
}

// ------------------------------------------------------------------ loading

async function load(source) {
    showError('');
    if (controller) controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const myGen = ++generation;
    resetView();
    state.source = source;
    dom.loadBtn.disabled = true;
    dom.abortBtn.style.display = 'inline-flex';
    dom.progressTrack.style.display = 'block';
    progress(2);
    dom.log.textContent = '';
    const pat = dom.pat.value.trim();

    try {
        let manifestResult;
        if (source.kind === 'zip') {
            state.repoName = source.archive.label;
            state.sourceText = `local archive ${source.archive.fileName}`;
            state.repoLicense = null;
            dom.sourceNote.hidden = false;
            dom.sourceNote.textContent = `Reading ${source.archive.fileName} in your browser. Only package names and versions are sent to deps.dev.`;
            log(`[ZIP] Looking for manifests in ${source.archive.fileName}...`);
            manifestResult = await readZipManifests(source.archive, { skipExamples: dom.skipExamples.checked });
            const licFile = source.archive.treeNodes.find(n => /^(LICENSE|LICENCE|COPYING)(\.(md|txt))?$/i.test(n.path));
            if (licFile) {
                try {
                    const head = (await source.archive.readText(licFile.path)).slice(0, 2000);
                    state.repoLicense = guessLicenseFromText(head);
                } catch (_) {}
            }
        } else {
            dom.sourceNote.hidden = true;
            state.repoName = `${source.owner}/${source.repo}`;
            state.sourceText = `GitHub repository ${source.owner}/${source.repo}`;
            log(`[FETCH] Reading ${state.repoName} from GitHub...`);
            const info = await fetchRepoInfo(source.owner, source.repo, { pat, signal });
            state.repoLicense = info.license ? classifyLicense(info.license) : null;
            state.sourceText += ` (branch ${info.branch})`;
            manifestResult = await fetchRepoManifests(source.owner, source.repo, { pat, branch: info.branch, isPrivate: info.isPrivate, skipExamples: dom.skipExamples.checked, signal });
            try { localStorage.setItem('cfg_lastRepo', state.repoName); } catch (_) {}
        }
        if (myGen !== generation) return;
        progress(15);

        const { manifests, failed, skipped, treeTruncated } = manifestResult;
        state.manifests = manifests.map(m => m.path);
        if (treeTruncated) state.warnings.push('GitHub returned a partial file list, so some manifests may be missing.');
        if (skipped > 0) state.warnings.push(`${skipped} more manifest file(s) were found but not read (limit 60).`);
        if (failed.length) state.warnings.push(`${failed.length} manifest file(s) could not be read: ${failed.map(f => f.path).slice(0, 5).join(', ')}.`);
        dom.repoLicenseText.textContent = state.repoLicense && state.repoLicense.expression ? state.repoLicense.expression : 'not detected';
        log(`[INFO] Found ${manifests.length} manifest(s): ${state.manifests.slice(0, 8).join(', ')}${manifests.length > 8 ? '…' : ''}`);
        if (manifests.length === 0) {
            showToast('No supported manifest files found (package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml).', 'warn');
            log('[WARN] No supported manifest files found.');
            setAppState('empty');
            return;
        }

        const { deps, parseErrors } = collectDirectDependencies(manifests);
        state.directDeps = deps;
        for (const e of parseErrors) state.warnings.push(`${e.path}: ${e.error}.`);
        log(`[INFO] ${deps.length} direct dependencies. Looking up licenses on deps.dev...`);
        await resolve(signal, myGen);
    } catch (err) {
        if (err.name === 'AbortError') { log('[CANCEL] Cancelled.'); return; }
        log(`[ERROR] ${err.message}`);
        showToast(err.message, 'error');
        if (err.status === 404 || err.status === 403 || err.status === 429) showTokenPanel(err.status === 404 ? 'If this is a private repo, add a token.' : '');
    } finally {
        if (myGen === generation) {
            dom.loadBtn.disabled = false;
            dom.abortBtn.style.display = 'none';
        }
    }
}

/** Re-runs the deps.dev lookup with the current options (results are cached, so this is quick). */
async function resolve(signal, myGen) {
    const t0 = Date.now();
    const { packages, capped } = await resolveLicenses(state.directDeps, {
        includeTransitive: dom.includeTransitive.checked,
        includeDev: dom.includeDev.checked,
        signal,
        onProgress: (done, total) => progress(15 + (done / Math.max(total, 1)) * 85)
    });
    if (myGen !== generation) return;
    state.packages = packages;
    state.warnings = state.warnings.filter(w => !w.startsWith('Stopped at'));
    if (capped) state.warnings.push('Stopped at 1,500 packages; the list is incomplete.');
    const failedLookups = packages.filter(p => p.status === 'error').length;
    if (failedLookups) state.warnings.push(`${failedLookups} license lookup(s) failed; they are listed as unknown.`);
    progress(100);
    fillEcosystemFilter();
    dom.statPackages.textContent = packages.length.toLocaleString();
    renderBanner(dom.warningBanner, state.warnings.map(w => ({ level: 'warn', text: w })));
    setAppState('loaded');
    renderAll();
    log(`[SUCCESS] ${packages.length} packages checked in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
    showToast(`Checked ${packages.length} packages.`, 'info');
}

function rerunResolve() {
    if (state.appState !== 'loaded' || !state.directDeps.length) return;
    if (controller) controller.abort();
    controller = new AbortController();
    const myGen = ++generation;
    log('[INFO] Updating the package list...');
    resolve(controller.signal, myGen).catch(err => {
        if (err.name !== 'AbortError') { log(`[ERROR] ${err.message}`); showToast(err.message, 'error'); }
    });
}

async function openZip(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name || '')) { showError('Choose a .zip file.'); return; }
    try {
        const archive = await parseZipArchive(file);
        await load({ kind: 'zip', archive });
    } catch (err) {
        showError(err.message || 'Could not read that .zip file.');
        showToast(err.message || 'Could not read that .zip file.', 'error');
    }
}

// ------------------------------------------------------------------ wiring

dom.loadBtn.addEventListener('click', () => {
    const info = parseRepoInput(dom.repoUrl.value);
    if (!info) { showError('Enter a repo as owner/name or a GitHub URL.'); return; }
    load({ kind: 'github', owner: info.owner, repo: info.repo });
});
dom.repoUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dom.loadBtn.click(); } });
dom.abortBtn.addEventListener('click', () => { if (controller) controller.abort(); });
dom.uploadZipBtn.addEventListener('click', () => dom.zipFileInput.click());
dom.zipFileInput.addEventListener('change', () => {
    const f = dom.zipFileInput.files && dom.zipFileInput.files[0];
    dom.zipFileInput.value = '';
    openZip(f);
});

dom.optionsToggleBtn.addEventListener('click', () => {
    const open = dom.optionsDrawer.classList.toggle('open');
    dom.optionsToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
});
if (dom.drawerDoneBtn) dom.drawerDoneBtn.addEventListener('click', () => dom.optionsToggleBtn.click());
if (dom.drawerTokenLink) dom.drawerTokenLink.addEventListener('click', (e) => { e.preventDefault(); showTokenPanel(''); });

let logOpen = false;
dom.logToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    logOpen = !logOpen;
    dom.log.style.display = logOpen ? 'block' : 'none';
    dom.logToggleBtn.textContent = logOpen ? 'Hide log' : 'Details';
});
dom.logHeader.addEventListener('click', () => dom.logToggleBtn.click());

if (dom.targetBar) {
    dom.targetBar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-target]');
        if (b) applyTarget(b.dataset.target);
    });
}
dom.format.addEventListener('change', () => {
    const detected = detectTarget(dom.format.value, state.budget);
    if (detected !== state.targetKey) applyTarget(detected);
    saveSettings();
    rebuildOutput();
});

[dom.includeTransitive, dom.includeDev].forEach(el => el.addEventListener('change', () => { saveSettings(); updateSettingsSummary(); rerunResolve(); }));
dom.skipExamples.addEventListener('change', () => {
    saveSettings();
    if (state.appState === 'loaded' && state.source) load(state.source);
});
dom.compactPermissive.addEventListener('change', () => { saveSettings(); rebuildOutput(); });

let instTimer = null;
dom.aiInstructions.addEventListener('input', () => {
    dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
    saveSettings();
    clearTimeout(instTimer);
    instTimer = setTimeout(rebuildOutput, 300);
});
dom.clearInstructionsBtn.addEventListener('click', () => {
    dom.aiInstructions.value = '';
    dom.instructionsCharCount.textContent = '0 chars';
    saveSettings();
    rebuildOutput();
});
document.querySelectorAll('.preset-buttons button[data-instruction]').forEach(btn => {
    btn.addEventListener('click', () => {
        dom.aiInstructions.value = btn.getAttribute('data-instruction');
        dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
        saveSettings();
        rebuildOutput();
    });
});

[dom.depSearchInput, dom.ecosystemFilter, dom.relationFilter, dom.advisoriesOnly].forEach(el => {
    el.addEventListener('input', () => { renderList(); rebuildOutput(); });
    el.addEventListener('change', () => { renderList(); rebuildOutput(); });
});

dom.copyBtn.addEventListener('click', async () => {
    if (!state.output) return;
    try {
        await navigator.clipboard.writeText(state.output.text);
        showToast('Copied the dependency report.', 'info');
        dom.copyBtn.textContent = 'Copied!';
        setTimeout(() => { dom.copyBtn.textContent = copyLabel(); }, 2000);
    } catch (_) {
        showToast('Unable to copy automatically.', 'error');
    }
});
dom.downloadBtn.addEventListener('click', () => {
    if (!state.output) return;
    const blob = new Blob([state.output.text], { type: state.output.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(state.repoName.split('/').pop() || 'repo')}-dependencies.${state.output.ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
});
if (dom.togglePreviewBtn) {
    dom.togglePreviewBtn.addEventListener('click', () => {
        const open = dom.togglePreviewBtn.getAttribute('aria-expanded') !== 'true';
        dom.togglePreviewBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        dom.togglePreviewBtn.textContent = open ? 'Hide preview' : 'Show preview';
        dom.previewArea.style.display = open ? 'block' : 'none';
    });
}
dom.wrapToggleBtn.addEventListener('click', () => {
    const wrapped = dom.previewArea.classList.toggle('wrap');
    dom.wrapToggleBtn.classList.toggle('primary', wrapped);
    dom.wrapToggleBtn.classList.toggle('secondary', !wrapped);
    dom.wrapToggleBtn.setAttribute('aria-pressed', wrapped ? 'true' : 'false');
});

if (dom.tabListBtn && dom.tabOutputBtn) {
    dom.tabListBtn.addEventListener('click', () => switchTab(dom.tabListBtn, dom.tabOutputBtn, dom.depsCard, dom.outputCard));
    dom.tabOutputBtn.addEventListener('click', () => switchTab(dom.tabOutputBtn, dom.tabListBtn, dom.outputCard, dom.depsCard));
}
if (dom.mobilePrimaryBtn) {
    dom.mobilePrimaryBtn.addEventListener('click', () => {
        if (state.appState === 'empty') dom.loadBtn.click();
        else dom.copyBtn.click();
    });
}

if (dom.themeToggleBtn) {
    const saved = store.get('app_theme');
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
    dom.themeToggleBtn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme');
        const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : (sysDark ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', next);
        store.set('app_theme', next);
    });
}
if (dom.shareUrlBtn) {
    dom.shareUrlBtn.addEventListener('click', async () => {
        const url = new URL(window.location.href.split('?')[0]);
        const repo = dom.repoUrl.value.trim();
        if (repo) url.searchParams.set('repo', repo);
        try { await navigator.clipboard.writeText(url.toString()); showToast('Deep-link URL copied!', 'info'); } catch (_) {}
    });
}
[dom.tabCodeLink, dom.tabIssuesLink, dom.tabDiscussionsLink, dom.tabDepsLink].forEach(link => {
    if (!link) return;
    link.addEventListener('click', () => {
        const repo = dom.repoUrl.value;
        if (dom.tabCodeLink) dom.tabCodeLink.href = buildTabHref('code', repo);
        if (dom.tabIssuesLink) dom.tabIssuesLink.href = buildTabHref('issues', repo);
        if (dom.tabDiscussionsLink) dom.tabDiscussionsLink.href = buildTabHref('discussions', repo);
        if (dom.tabDepsLink) dom.tabDepsLink.href = buildTabHref('deps', repo);
    });
});
if (dom.exampleRepos) {
    dom.exampleRepos.addEventListener('click', (e) => {
        const b = e.target.closest('[data-repo]');
        if (!b) return;
        dom.repoUrl.value = b.dataset.repo;
        dom.loadBtn.click();
    });
}

// ------------------------------------------------------------------ startup

const params = new URLSearchParams(window.location.search);
if (params.get('repo')) dom.repoUrl.value = params.get('repo');
else { const last = store.get('cfg_lastRepo'); if (last && !dom.repoUrl.value) dom.repoUrl.value = last; }
loadSettings();
// ?format= wins (lands on "Custom"); else the target saved on any tab; else Claude.
if (VALID_FORMATS.includes(params.get('format'))) {
    dom.format.value = params.get('format');
    applyTarget('custom');
} else {
    const savedTarget = store.get('cfg_target');
    applyTarget(savedTarget && savedTarget in TARGETS ? savedTarget : 'claude');
}
resetView();
setAppState('empty');
