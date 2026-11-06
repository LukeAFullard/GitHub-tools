/**
 * Formats a dependency + license report as AI context: Claude XML, Markdown, generic XML or JSON.
 *
 * Packages are grouped by license group, most attention first (restricted, strong copyleft,
 * weak copyleft, unknown, permissive). With `compactPermissive`, permissive packages are listed
 * as one line each to save tokens.
 */
import { escapeXml, escapeCdata, stripXmlInvalidChars, getMarkdownFence } from './formatters.js';
import { LICENSE_GROUPS, GROUP_LABELS, GROUP_HINTS } from './license-classify.js';

export const REPORT_NOTE = 'License groups are a heuristic to guide review, not legal advice and not a compatibility verdict: '
    + 'obligations depend on how each package is used (linking, distribution, hosted service). '
    + 'License, advisory and project health data come from deps.dev (health: OpenSSF Scorecard). Versions come from lockfiles '
    + 'where present; otherwise, where a manifest gives a range, the lowest version in the range (or the latest release when '
    + 'none is given) was checked, so installed versions may differ.';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unrated' };

/** "GHSA-x (high 7.5)" for each advisory, worst first. */
function advisoryList(p) {
    const details = p.advisoryDetails && p.advisoryDetails.length ? p.advisoryDetails : (p.advisories || []).map(id => ({ id, severity: 'unknown', score: null }));
    return details.map(a => `${a.id} (${a.severity === 'unknown' ? 'unrated' : `${a.severity}${a.score ? ` ${a.score}` : ''}`})`);
}

/** Every advisory across the packages, worst first: { package, advisory }. */
export function collectAdvisories(packages) {
    const rows = [];
    for (const p of packages) {
        const details = p.advisoryDetails && p.advisoryDetails.length ? p.advisoryDetails : (p.advisories || []).map(id => ({ id, severity: 'unknown', score: null, title: '', aliases: [] }));
        for (const a of details) rows.push({ p, a });
    }
    return rows.sort((x, y) => SEVERITY_RANK[x.a.severity] - SEVERITY_RANK[y.a.severity] || (y.a.score || 0) - (x.a.score || 0) || x.p.name.localeCompare(y.p.name));
}

function fixText(p) {
    if (p.relation !== 'direct' || !p.latest || !p.outdated) return '';
    return p.upgradeClears ? `latest ${p.latest} clears ${p.upgradeClears} of ${p.advisories.length}` : `latest ${p.latest}`;
}

function lockText(ctx) {
    return ctx.lockfiles && ctx.lockfiles.length
        ? `Exact versions from lockfiles: ${ctx.lockfiles.join(', ')}`
        : 'No lockfile found: versions estimated from manifest ranges';
}

const ORDER = Object.fromEntries(LICENSE_GROUPS.map((g, i) => [g, i]));

export function sortPackages(packages) {
    return [...packages].sort((a, b) =>
        ORDER[a.license.group] - ORDER[b.license.group]
        || (a.relation === b.relation ? 0 : a.relation === 'direct' ? -1 : 1)
        || a.ecosystem.localeCompare(b.ecosystem)
        || a.name.localeCompare(b.name));
}

export function groupCounts(packages) {
    const counts = Object.fromEntries(LICENSE_GROUPS.map(g => [g, 0]));
    for (const p of packages) counts[p.license.group]++;
    return counts;
}

function versionBasis(p) {
    if (p.versionKind === 'range-min') return 'lowest version in range';
    if (p.versionKind === 'latest') return 'latest release (no version pinned)';
    return '';
}

function packageNotes(p) {
    const notes = [...(p.license.notes || [])];
    if (p.status === 'not-found') notes.push('not found on deps.dev');
    if (p.status === 'error') notes.push(`lookup failed: ${p.error || 'error'}`);
    if (p.healthFlags && p.healthFlags.length) notes.push(...p.healthFlags);
    else if (p.deprecated) notes.push('deprecated or yanked');
    if (p.relation === 'direct' && p.outdated && p.latest) {
        notes.push(p.upgradeClears ? `outdated: latest ${p.latest} clears ${p.upgradeClears} advisor${p.upgradeClears === 1 ? 'y' : 'ies'}` : `outdated: latest ${p.latest}`);
    }
    const basis = versionBasis(p);
    if (basis) notes.push(`version: ${basis}`);
    return notes;
}

const relationText = p => `${p.relation}${p.dev ? ' (dev)' : ''}`;
const viaText = p => (p.via && p.via.length ? p.via.slice(0, 3).join(', ') + (p.via.length > 3 ? ` +${p.via.length - 3} more` : '') : '');
const licenseText = p => p.license.expression || 'none found';
// Brief lines still carry advisories: a permissive license says nothing about security.
const briefLine = p => `${p.ecosystem}:${p.name}@${p.version || '?'} (${licenseText(p)})${p.dev ? ' [dev]' : ''}${p.advisories && p.advisories.length ? ` [advisories: ${advisoryList(p).join(', ')}]` : ''}`;

function scopeText(ctx) {
    return `${ctx.includeTransitive ? 'Direct and transitive' : 'Direct'} dependencies${ctx.includeDev ? ', including development/test dependencies' : ', runtime only (development/test dependencies excluded)'}`;
}

function summaryText(counts) {
    return LICENSE_GROUPS.map(g => `${GROUP_LABELS[g]}: ${counts[g]}`).join(', ');
}

function byGroup(packages) {
    const groups = new Map(LICENSE_GROUPS.map(g => [g, []]));
    for (const p of sortPackages(packages)) groups.get(p.license.group).push(p);
    return [...groups.entries()].filter(([, list]) => list.length > 0);
}

function repoLicenseText(ctx) {
    if (!ctx.repoLicense || !ctx.repoLicense.expression) return 'not detected';
    return `${ctx.repoLicense.expression} (${GROUP_LABELS[ctx.repoLicense.group]})`;
}

// ------------------------------------------------------------------ Claude XML

function formatClaudeXml(ctx) {
    const counts = groupCounts(ctx.packages);
    let doc = '<documents>\n  <!-- Dependency License Report -->\n  <context>\n';
    doc += `    <repository>${escapeXml(ctx.repoName)}</repository>\n`;
    if (ctx.source) doc += `    <source>${escapeXml(ctx.source)}</source>\n`;
    doc += `    <repository_license>${escapeXml(repoLicenseText(ctx))}</repository_license>\n`;
    doc += `    <scope>${escapeXml(scopeText(ctx))}</scope>\n`;
    if (ctx.manifests && ctx.manifests.length) doc += `    <manifests>${escapeXml(ctx.manifests.join(', '))}</manifests>\n`;
    doc += `    <versions>${escapeXml(lockText(ctx))}</versions>\n`;
    doc += `    <package_count>${ctx.packages.length}</package_count>\n`;
    doc += `    <summary>${escapeXml(summaryText(counts))}</summary>\n`;
    if (ctx.warnings && ctx.warnings.length) doc += `    <warnings>${escapeXml(ctx.warnings.join(' '))}</warnings>\n`;
    doc += `    <note>${escapeXml(REPORT_NOTE)}</note>\n  </context>\n\n`;

    let index = 1;
    for (const [group, list] of byGroup(ctx.packages)) {
        doc += `  <document index="${index++}">\n    <source>${escapeXml(GROUP_LABELS[group])} licenses (${list.length})</source>\n`;
        doc += `    <document_content>\n      <license_group name="${group}" hint="${escapeXml(GROUP_HINTS[group])}">\n`;
        if (group === 'permissive' && ctx.compactPermissive) {
            doc += `        <packages format="ecosystem:name@version (license)">\n${escapeXml(list.map(briefLine).join('\n'))}\n        </packages>\n`;
        } else {
            for (const p of list) {
                const notes = packageNotes(p);
                doc += `        <package ecosystem="${p.ecosystem}" name="${escapeXml(p.name)}" version="${escapeXml(p.version || '?')}" relation="${relationText(p)}" license="${escapeXml(licenseText(p))}"`;
                if (viaText(p)) doc += ` via="${escapeXml(viaText(p))}"`;
                if (p.advisories && p.advisories.length) doc += ` advisories="${escapeXml(advisoryList(p).join(', '))}"`;
                if (notes.length) doc += ` notes="${escapeXml(notes.join('; '))}"`;
                doc += ' />\n';
            }
        }
        doc += '      </license_group>\n    </document_content>\n  </document>\n';
    }
    const advisories = collectAdvisories(ctx.packages);
    if (advisories.length) {
        doc += `  <document index="${index++}">\n    <source>Security advisories (${advisories.length})</source>\n    <document_content>\n`;
        for (const { p, a } of advisories) {
            doc += `      <advisory id="${escapeXml(a.id)}" severity="${a.severity}"${a.score ? ` cvss="${a.score}"` : ''} package="${escapeXml(`${p.name}@${p.version || '?'}`)}" relation="${relationText(p)}"`
                + `${a.aliases && a.aliases.length ? ` aliases="${escapeXml(a.aliases.join(' '))}"` : ''}${fixText(p) ? ` fix="${escapeXml(fixText(p))}"` : ''}>${escapeXml(a.title || '')}</advisory>\n`;
        }
        doc += '    </document_content>\n  </document>\n';
    }
    if (ctx.instructions && ctx.instructions.trim()) {
        doc += `  <instructions>\n<![CDATA[\n${escapeCdata(stripXmlInvalidChars(ctx.instructions.trim()))}\n]]>\n  </instructions>\n`;
    }
    doc += '</documents>';
    return { text: doc, ext: 'xml', mime: 'application/xml' };
}

// ------------------------------------------------------------------ Markdown

const mdCell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function formatMarkdown(ctx) {
    const counts = groupCounts(ctx.packages);
    let md = `# Dependency License Report: ${ctx.repoName}\n\n`;
    if (ctx.source) md += `- **Source:** ${ctx.source}\n`;
    md += `- **Repository license:** ${repoLicenseText(ctx)}\n`;
    md += `- **Scope:** ${scopeText(ctx)}\n`;
    if (ctx.manifests && ctx.manifests.length) md += `- **Manifests:** ${ctx.manifests.join(', ')}\n`;
    md += `- **Versions:** ${lockText(ctx)}\n`;
    md += `- **Packages:** ${ctx.packages.length} (${summaryText(counts)})\n\n`;
    if (ctx.warnings && ctx.warnings.length) md += `> **Warning:** ${ctx.warnings.join(' ')}\n\n`;
    md += `> **Note:** ${REPORT_NOTE}\n\n`;

    for (const [group, list] of byGroup(ctx.packages)) {
        md += `## ${GROUP_LABELS[group]} (${list.length})\n\n${GROUP_HINTS[group]}\n\n`;
        if (group === 'permissive' && ctx.compactPermissive) {
            const body = list.map(briefLine).join('\n');
            const fence = getMarkdownFence(body);
            md += `${fence}text\n${body}\n${fence}\n\n`;
            continue;
        }
        md += '| Package | Version | Ecosystem | Relation | License | Via | Advisories | Notes |\n';
        md += '| --- | --- | --- | --- | --- | --- | --- | --- |\n';
        for (const p of list) {
            md += `| ${mdCell(p.name)} | ${mdCell(p.version || '?')} | ${p.ecosystem} | ${relationText(p)} | ${mdCell(licenseText(p))} | ${mdCell(viaText(p))} | ${mdCell(advisoryList(p).join(', '))} | ${mdCell(packageNotes(p).join('; '))} |\n`;
        }
        md += '\n';
    }
    const advisories = collectAdvisories(ctx.packages);
    if (advisories.length) {
        md += `## Security advisories (${advisories.length})\n\n`;
        md += '| Severity | Advisory | Package | Relation | Title | Fix |\n| --- | --- | --- | --- | --- | --- |\n';
        for (const { p, a } of advisories) {
            md += `| ${SEVERITY_LABEL[a.severity]}${a.score ? ` (${a.score})` : ''} | ${mdCell([a.id, ...(a.aliases || [])].join(', '))} | ${mdCell(`${p.name}@${p.version || '?'}`)} | ${relationText(p)} | ${mdCell(a.title || '')} | ${mdCell(fixText(p))} |\n`;
        }
        md += '\n';
    }
    if (ctx.instructions && ctx.instructions.trim()) md += `## Instructions\n\n${ctx.instructions.trim()}\n`;
    return { text: md, ext: 'md', mime: 'text/markdown' };
}

// ------------------------------------------------------------------ Generic XML

function formatGenericXml(ctx) {
    const counts = groupCounts(ctx.packages);
    let xml = `<dependency_report repository="${escapeXml(ctx.repoName)}" repository_license="${escapeXml(repoLicenseText(ctx))}" count="${ctx.packages.length}">\n`;
    if (ctx.source) xml += `  <source>${escapeXml(ctx.source)}</source>\n`;
    xml += `  <scope>${escapeXml(scopeText(ctx))}</scope>\n`;
    if (ctx.manifests && ctx.manifests.length) xml += `  <manifests>${escapeXml(ctx.manifests.join(', '))}</manifests>\n`;
    xml += `  <versions>${escapeXml(lockText(ctx))}</versions>\n`;
    xml += `  <summary>${escapeXml(summaryText(counts))}</summary>\n`;
    if (ctx.warnings && ctx.warnings.length) xml += `  <warnings>${escapeXml(ctx.warnings.join(' '))}</warnings>\n`;
    xml += `  <note>${escapeXml(REPORT_NOTE)}</note>\n`;
    for (const [group, list] of byGroup(ctx.packages)) {
        xml += `  <group name="${group}" count="${list.length}">\n`;
        for (const p of list) {
            const notes = packageNotes(p);
            xml += `    <package ecosystem="${p.ecosystem}" name="${escapeXml(p.name)}" version="${escapeXml(p.version || '?')}" relation="${relationText(p)}" license="${escapeXml(licenseText(p))}"`
                + `${viaText(p) ? ` via="${escapeXml(viaText(p))}"` : ''}${p.advisories && p.advisories.length ? ` advisories="${escapeXml(advisoryList(p).join(', '))}"` : ''}${notes.length ? ` notes="${escapeXml(notes.join('; '))}"` : ''} />\n`;
        }
        xml += '  </group>\n';
    }
    const advisories = collectAdvisories(ctx.packages);
    if (advisories.length) {
        xml += `  <advisories count="${advisories.length}">\n`;
        for (const { p, a } of advisories) {
            xml += `    <advisory id="${escapeXml(a.id)}" severity="${a.severity}"${a.score ? ` cvss="${a.score}"` : ''} package="${escapeXml(`${p.name}@${p.version || '?'}`)}"${fixText(p) ? ` fix="${escapeXml(fixText(p))}"` : ''}>${escapeXml(a.title || '')}</advisory>\n`;
        }
        xml += '  </advisories>\n';
    }
    if (ctx.instructions && ctx.instructions.trim()) xml += `  <instructions><![CDATA[\n${escapeCdata(stripXmlInvalidChars(ctx.instructions.trim()))}\n]]></instructions>\n`;
    xml += '</dependency_report>';
    return { text: xml, ext: 'xml', mime: 'application/xml' };
}

// ------------------------------------------------------------------ JSON

function formatJson(ctx) {
    const payload = {
        repository: ctx.repoName,
        ...(ctx.source ? { source: ctx.source } : {}),
        repository_license: ctx.repoLicense && ctx.repoLicense.expression ? { expression: ctx.repoLicense.expression, group: ctx.repoLicense.group } : null,
        scope: scopeText(ctx),
        manifests: ctx.manifests || [],
        versions: lockText(ctx),
        summary: groupCounts(ctx.packages),
        ...(ctx.warnings && ctx.warnings.length ? { warnings: ctx.warnings } : {}),
        note: REPORT_NOTE,
        packages: sortPackages(ctx.packages).map(p => ({
            ecosystem: p.ecosystem,
            name: p.name,
            version: p.version,
            relation: p.relation,
            dev: p.dev,
            license: p.license.expression || null,
            license_group: p.license.group,
            ...(p.via && p.via.length ? { via: p.via } : {}),
            ...(p.advisories && p.advisories.length ? {
                advisories: (p.advisoryDetails && p.advisoryDetails.length ? p.advisoryDetails : p.advisories.map(id => ({ id, severity: 'unknown' })))
                    .map(a => ({ id: a.id, severity: a.severity, ...(a.score ? { cvss: a.score } : {}), ...(a.title ? { title: a.title } : {}), ...(a.aliases && a.aliases.length ? { aliases: a.aliases } : {}) }))
            } : {}),
            ...(p.relation === 'direct' && p.latest ? { latest: p.latest, outdated: Boolean(p.outdated), ...(p.upgradeClears ? { upgrade_clears_advisories: p.upgradeClears } : {}) } : {}),
            ...(p.health ? { health: { scorecard: p.health.scorecard, project: p.health.project } } : {}),
            ...(packageNotes(p).length ? { notes: packageNotes(p) } : {}),
            manifests: p.manifests
        })),
        ...(ctx.instructions && ctx.instructions.trim() ? { instructions: ctx.instructions.trim() } : {})
    };
    return { text: JSON.stringify(payload, null, 2), ext: 'json', mime: 'application/json' };
}

/**
 * @param {'claude-xml'|'markdown'|'generic-xml'|'json'} format
 * @param {{ repoName: string, source?: string, repoLicense?: {expression, group}, packages: object[],
 *   manifests?: string[], includeTransitive?: boolean, includeDev?: boolean, compactPermissive?: boolean,
 *   lockfiles?: string[], warnings?: string[], instructions?: string }} ctx
 */
export function buildDepsOutput(format, ctx) {
    switch (format) {
        case 'markdown': return formatMarkdown(ctx);
        case 'generic-xml': return formatGenericXml(ctx);
        case 'json': return formatJson(ctx);
        case 'claude-xml':
        default: return formatClaudeXml(ctx);
    }
}
