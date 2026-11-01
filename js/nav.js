/**
 * Navigation helpers between the Code, Issues and Discussions tabs.
 */

/**
 * Builds the destination URL when navigating between tabs.
 *
 * @param {'code'|'issues'|'discussions'|'deps'} page - Target page identifier.
 * @param {string} [repoText] - Current repository input text (e.g. "owner/repo" or GitHub URL).
 * @returns {string} The relative URL to the destination page, including the ?repo= parameter if repoText is present.
 */
export function buildTabHref(page, repoText) {
    const pages = { code: 'index.html', issues: 'issues.html', discussions: 'discussions.html', deps: 'deps.html' };
    const base = pages[page] || 'issues.html';
    const trimmed = (repoText || '').trim();
    if (!trimmed) {
        return base;
    }
    return `${base}?repo=${encodeURIComponent(trimmed)}`;
}
