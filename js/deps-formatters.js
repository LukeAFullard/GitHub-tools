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
    + 'License and advisory data come from deps.dev. Where a manifest gives a version range, the lowest version in the range '
    + '(or the latest release when none is given) was checked, so installed versions may differ.';

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
    if (p.deprecated) notes.push('deprecated');
    const basis = versionBasis(p);
    if (basis) notes.push(`version: ${basis}`);
    return notes;
}

const relationText = p => `${p.relation}${p.dev ? ' (dev)' : ''}`;
const viaText = p => (p.via && p.via.length ? p.via.slice(0, 3).join(', ') + (p.via.length > 3 ? ` +${p.via.length - 3} more` : '') : '');
const licenseText = p => p.license.expression || 'none found';
const briefLine = p => `${p.ecosystem}:${p.name}@${p.version || '?'} (${licenseText(p)})${p.dev ? ' [dev]' : ''}`;

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
                if (p.advisories && p.advisories.length) doc += ` advisories="${escapeXml(p.advisories.join(' '))}"`;
                if (notes.length) doc += ` notes="${escapeXml(notes.join('; '))}"`;
                doc += ' />\n';
            }
        }
        doc += '      </license_group>\n    </document_content>\n  </document>\n';
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
            md += `| ${mdCell(p.name)} | ${mdCell(p.version || '?')} | ${p.ecosystem} | ${relationText(p)} | ${mdCell(licenseText(p))} | ${mdCell(viaText(p))} | ${mdCell((p.advisories || []).join(', '))} | ${mdCell(packageNotes(p).join('; '))} |\n`;
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
    xml += `  <summary>${escapeXml(summaryText(counts))}</summary>\n`;
    if (ctx.warnings && ctx.warnings.length) xml += `  <warnings>${escapeXml(ctx.warnings.join(' '))}</warnings>\n`;
    xml += `  <note>${escapeXml(REPORT_NOTE)}</note>\n`;
    for (const [group, list] of byGroup(ctx.packages)) {
        xml += `  <group name="${group}" count="${list.length}">\n`;
        for (const p of list) {
            const notes = packageNotes(p);
            xml += `    <package ecosystem="${p.ecosystem}" name="${escapeXml(p.name)}" version="${escapeXml(p.version || '?')}" relation="${relationText(p)}" license="${escapeXml(licenseText(p))}"`
                + `${viaText(p) ? ` via="${escapeXml(viaText(p))}"` : ''}${p.advisories && p.advisories.length ? ` advisories="${escapeXml(p.advisories.join(' '))}"` : ''}${notes.length ? ` notes="${escapeXml(notes.join('; '))}"` : ''} />\n`;
        }
        xml += '  </group>\n';
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
            ...(p.advisories && p.advisories.length ? { advisories: p.advisories } : {}),
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
 *   warnings?: string[], instructions?: string }} ctx
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
