/**
 * Dependency + license resolution for the Dependencies tab.
 *
 * Sources:
 *  - The repository's manifest files (package.json, requirements*.txt, pyproject.toml, go.mod,
 *    Cargo.toml), read from GitHub or a local .zip.
 *  - deps.dev (https://docs.deps.dev/api/v3/), a free public API by Google with no key, that
 *    allows browser requests. It gives each package version's licenses and known security
 *    advisories, and dependency graphs for npm, PyPI and Cargo (not Go; go.mod already lists
 *    indirect modules). Package names and versions are sent to deps.dev; nothing else is.
 *
 * GitHub's own SBOM export is not used: its synchronous endpoint closes on 13 November 2026 and
 * the replacement is an asynchronous job that redirects to a temporary download URL.
 */
import { GITHUB_API_BASE } from './config.js';
import { fetchRepoTree, fetchFileContent, extractRateLimitHeaders, sleep } from './github-api.js';
import { findManifestPaths, parseManifest } from './manifest-parsers.js';
import { classifyLicense } from './license-classify.js';

export const DEPS_DEV_BASE = 'https://api.deps.dev/v3';
const SYSTEMS = { npm: 'npm', pypi: 'pypi', go: 'go', cargo: 'cargo' };
const GRAPH_SYSTEMS = new Set(['npm', 'pypi', 'cargo']);

export class DepsError extends Error {
    constructor(message, status = null) {
        super(message);
        this.name = 'DepsError';
        this.status = status;
    }
}

// ------------------------------------------------------------------ GitHub side

function authHeaders(pat) {
    if (!pat) return {};
    const token = pat.trim();
    return { 'Authorization': /^(github_pat_|gho_|ghu_|ghs_)/.test(token) ? `Bearer ${token}` : `token ${token}` };
}

/** Repository metadata: default branch, privacy and the repo's own license (SPDX ID). */
export async function fetchRepoInfo(owner, repo, { pat = '', signal, onHeaders } = {}) {
    const res = await fetch(`${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers: { 'Accept': 'application/vnd.github.v3+json', ...authHeaders(pat) }, signal
    });
    if (onHeaders) onHeaders(extractRateLimitHeaders(res));
    if (!res.ok) {
        const msg = res.status === 404
            ? "Can't find that repository. For a private repo, add a token with read access."
            : res.status === 403 || res.status === 429
                ? 'GitHub rate limit reached or access forbidden. Add a token to raise the limit.'
                : `Repository lookup failed (${res.status}).`;
        throw new DepsError(msg, res.status);
    }
    const data = await res.json();
    const spdx = data.license && data.license.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? data.license.spdx_id : null;
    return {
        branch: data.default_branch || 'main',
        isPrivate: Boolean(data.private),
        license: spdx,
        licenseName: data.license ? data.license.name : null
    };
}

async function readManifests(list, readText) {
    const manifests = [];
    const failed = [];
    for (const m of list) {
        try {
            manifests.push({ ...m, text: await readText(m.path) });
        } catch (err) {
            if (err && err.name === 'AbortError') throw err;
            failed.push({ path: m.path, error: (err && err.message) || String(err) });
        }
    }
    return { manifests, failed };
}

/** Finds and downloads the manifest files of a GitHub repository. */
export async function fetchRepoManifests(owner, repo, { pat = '', branch, isPrivate = false, skipExamples = true, signal, onHeaders } = {}) {
    const tree = await fetchRepoTree(owner, repo, branch, pat, signal, onHeaders);
    const paths = tree.filter(n => n.type === 'blob').map(n => n.path);
    const { manifests: found, skipped } = findManifestPaths(paths, { skipExamples });
    const { manifests, failed } = await readManifests(found, async (path) => {
        const r = await fetchFileContent(owner, repo, branch, path, pat, signal, onHeaders, isPrivate);
        if (!r || !r.success) throw new Error(r && r.error ? r.error : `HTTP ${r ? r.status : '?'}`);
        return r.content;
    });
    return { manifests, failed, skipped, treeTruncated: Boolean(tree.truncated) };
}

/** Finds and reads the manifest files inside a parsed .zip archive (js/zip-loader.js). */
export async function readZipManifests(archive, { skipExamples = true } = {}) {
    const { manifests: found, skipped } = findManifestPaths(archive.treeNodes.map(n => n.path), { skipExamples });
    const { manifests, failed } = await readManifests(found, path => archive.readText(path));
    return { manifests, failed, skipped, treeTruncated: false };
}

/**
 * Parses manifests into direct dependencies, merging duplicates and skipping packages that are
 * defined in the repository itself (monorepo workspaces).
 */
export function collectDirectDependencies(manifests) {
    const parsed = manifests.map(m => ({ ...m, result: parseManifest(m.path, m.text) }));
    const localNames = new Set(parsed.map(p => p.result.name).filter(Boolean));
    const byKey = new Map();
    for (const p of parsed) {
        for (const d of p.result.deps || []) {
            if (localNames.has(d.name)) continue;
            const key = `${d.ecosystem}|${d.name}|${d.version || ''}`;
            const existing = byKey.get(key);
            if (existing) {
                existing.manifests.add(d.manifest);
                existing.dev = existing.dev && d.dev; // a runtime use anywhere wins
                existing.indirect = existing.indirect && d.indirect;
            } else {
                byKey.set(key, { ...d, manifests: new Set([d.manifest]) });
            }
        }
    }
    return { deps: [...byKey.values()], parseErrors: parsed.filter(p => p.result.error).map(p => ({ path: p.path, error: p.result.error })) };
}

// ------------------------------------------------------------------ deps.dev

const cache = new Map();

/** GET a deps.dev URL with caching, 429/5xx retries and abort support. 404 resolves to null. */
async function depsDevGet(path, signal) {
    const url = `${DEPS_DEV_BASE}/${path}`;
    if (cache.has(url)) return cache.get(url);
    const promise = (async () => {
        for (let attempt = 0; ; attempt++) {
            const res = await fetch(url, { signal });
            if (res.ok) return res.json();
            if (res.status === 404) return null;
            if ((res.status === 429 || res.status >= 500) && attempt < 3) {
                await sleep(500 * 2 ** attempt, signal);
                continue;
            }
            throw new DepsError(`deps.dev request failed (${res.status})`, res.status);
        }
    })();
    cache.set(url, promise);
    promise.catch(() => cache.delete(url));
    return promise;
}

export function clearDepsDevCache() {
    cache.clear();
}

const pkgPath = (eco, name) => `systems/${SYSTEMS[eco]}/packages/${encodeURIComponent(name)}`;

async function defaultVersion(eco, name, signal) {
    const data = await depsDevGet(pkgPath(eco, name), signal);
    if (!data || !Array.isArray(data.versions)) return null;
    const def = data.versions.find(v => v.isDefault) || data.versions[data.versions.length - 1];
    return def ? def.versionKey.version : null;
}

/** Runs tasks with limited concurrency. */
async function pool(items, limit, fn, signal) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const idx = i++;
            await fn(items[idx], idx);
        }
    });
    await Promise.all(workers);
}

/**
 * Looks up licenses (and advisories) for direct dependencies and, optionally, their transitive
 * dependencies. Returns a flat package list.
 *
 * Package: { key, ecosystem, name, version, versionKind, relation: 'direct'|'transitive',
 *   dev, via: string[], manifests: string[], license: {expression, group, notes},
 *   advisories: string[], status: 'ok'|'not-found'|'error', error? }
 */
export async function resolveLicenses(directDeps, options = {}) {
    const {
        includeTransitive = true,
        includeDev = false,
        maxPackages = 1500,
        concurrency = 8,
        signal,
        onProgress
    } = options;

    const packages = new Map();
    let done = 0;
    let total = 0;
    const tick = () => { done++; if (onProgress) onProgress(done, total); };
    let capped = false;

    const add = (p) => {
        const key = `${p.ecosystem}|${p.name}|${p.version || ''}`;
        const existing = packages.get(key);
        if (existing) {
            if (p.relation === 'direct') existing.relation = 'direct';
            existing.dev = existing.dev && p.dev;
            for (const v of p.via || []) if (!existing.via.includes(v)) existing.via.push(v);
            for (const m of p.manifests || []) if (!existing.manifests.includes(m)) existing.manifests.push(m);
            return existing;
        }
        if (packages.size >= maxPackages) { capped = true; return null; }
        const rec = {
            key, ecosystem: p.ecosystem, name: p.name, version: p.version || null, versionKind: p.versionKind || 'exact',
            relation: p.relation, dev: Boolean(p.dev), via: [...(p.via || [])], manifests: [...(p.manifests || [])],
            license: classifyLicense([]), advisories: [], status: 'pending'
        };
        packages.set(key, rec);
        return rec;
    };

    // 1. Direct dependencies (Go modules marked "// indirect" in go.mod count as transitive).
    const direct = directDeps.filter(d => includeDev || !d.dev);
    total = direct.length;
    const directRecs = [];
    await pool(direct, concurrency, async (d) => {
        let version = d.version;
        let versionKind = d.versionKind;
        try {
            if (!version) {
                version = await defaultVersion(d.ecosystem, d.name, signal);
                versionKind = 'latest';
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
        }
        const rec = add({
            ecosystem: d.ecosystem, name: d.name, version, versionKind,
            relation: d.indirect ? 'transitive' : 'direct', dev: d.dev,
            manifests: [...(d.manifests || [d.manifest])]
        });
        if (rec) directRecs.push({ rec, wanted: d });
        tick();
    }, signal);

    // 2. Transitive dependencies from deps.dev's resolved graphs (npm, PyPI, Cargo).
    if (includeTransitive) {
        const roots = directRecs.filter(({ rec }) => rec.relation === 'direct' && !rec.dev && rec.version && GRAPH_SYSTEMS.has(rec.ecosystem));
        total += roots.length;
        await pool(roots, concurrency, async ({ rec }) => {
            try {
                const graph = await depsDevGet(`${pkgPath(rec.ecosystem, rec.name)}/versions/${encodeURIComponent(rec.version)}:dependencies`, signal);
                for (const n of (graph && graph.nodes) || []) {
                    if (n.relation === 'SELF' || !n.versionKey) continue;
                    add({
                        ecosystem: rec.ecosystem, name: n.versionKey.name, version: n.versionKey.version,
                        versionKind: 'exact', relation: 'transitive', dev: false, via: [rec.name], manifests: rec.manifests
                    });
                }
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                rec.graphError = err.message;
            }
            tick();
        }, signal);
    }

    // 3. Licenses and advisories for every package.
    const all = [...packages.values()];
    total += all.length;
    await pool(all, concurrency, async (rec) => {
        try {
            let info = rec.version ? await depsDevGet(`${pkgPath(rec.ecosystem, rec.name)}/versions/${encodeURIComponent(rec.version)}`, signal) : null;
            if (!info && rec.versionKind !== 'exact') {
                // The lowest version in a range may not exist; fall back to the latest release.
                const latest = await defaultVersion(rec.ecosystem, rec.name, signal);
                if (latest && latest !== rec.version) {
                    info = await depsDevGet(`${pkgPath(rec.ecosystem, rec.name)}/versions/${encodeURIComponent(latest)}`, signal);
                    if (info) { rec.version = latest; rec.versionKind = 'latest'; }
                }
            }
            if (!info) {
                rec.status = 'not-found';
            } else {
                rec.status = 'ok';
                rec.license = classifyLicense(info.licenses || []);
                rec.advisories = (info.advisoryKeys || []).map(a => a.id).filter(Boolean);
                rec.deprecated = Boolean(info.isDeprecated);
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            rec.status = 'error';
            rec.error = err.message;
        }
        tick();
    }, signal);

    return { packages: all, capped };
}
