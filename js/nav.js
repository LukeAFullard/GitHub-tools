/**
 * Navigation helpers between Code Packer and Issues Explorer.
 */

/**
 * Builds the destination URL when navigating between 'code' and 'issues' tabs.
 *
 * @param {'code'|'issues'} page - Target page identifier.
 * @param {string} [repoText] - Current repository input text (e.g. "owner/repo" or GitHub URL).
 * @returns {string} The relative URL to the destination page, including the ?repo= parameter if repoText is present.
 */
export function buildTabHref(page, repoText) {
    const base = page === 'code' ? 'index.html' : 'issues.html';
    const trimmed = (repoText || '').trim();
    if (!trimmed) {
        return base;
    }
    return `${base}?repo=${encodeURIComponent(trimmed)}`;
}
