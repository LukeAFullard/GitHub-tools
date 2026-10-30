/**
 * Formats processed GitHub Issue threads & NLP summaries into Claude XML, Markdown, Generic XML, or JSON.
 */
import { escapeXml, escapeCdata, stripXmlInvalidChars, getMarkdownFence } from './formatters.js';

function formatNlpOverviewText(nlpData, selectedIssues) {
    if (!nlpData || (!nlpData.clusters?.length && !nlpData.ngrams?.length)) return '';
    const selectedSet = new Set(selectedIssues.map(i => i.number));
    let lines = [];

    if (nlpData.clusters && nlpData.clusters.length > 0) {
        lines.push('Topic Clusters (in selection / total scanned):');
        for (const c of nlpData.clusters) {
            const inSel = c.issueNumbers.filter(n => selectedSet.has(n));
            if (inSel.length > 0) {
                const sampleRefs = inSel.slice(0, 8).map(n => `#${n}`).join(', ');
                lines.push(`  - [${c.label}] (${inSel.length}/${c.count} issues): ${sampleRefs}${inSel.length > 8 ? '...' : ''}`);
            }
        }
    }

    if (nlpData.ngrams && nlpData.ngrams.length > 0) {
        const activeNgrams = nlpData.ngrams
            .map(ng => ({ ...ng, selCount: ng.issueNumbers.filter(n => selectedSet.has(n)).length }))
            .filter(ng => ng.selCount > 0)
            .slice(0, 10);
        if (activeNgrams.length > 0) {
            lines.push('Frequent Phrases: ' + activeNgrams.map(ng => `"${ng.phrase}" (${ng.selCount})`).join(', '));
        }
    }

    return lines.join('\n');
}

export function formatIssuesClaudeXml(repoInfo, issues, options = {}) {
    const startIndex = options.startIndex || 1;
    const nlpOverview = options.includeNlpSummary ? formatNlpOverviewText(options.nlpData, issues) : '';

    const failedCount = issues.filter(i => i.commentsFetchFailed).length;
    const truncatedCount = issues.filter(i => i.commentsTruncated).length;

    let doc = `<documents>\n`;
    doc += `  <!-- Global Repository Issues Context -->\n`;
    doc += `  <context>\n`;
    if (options.partNote) {
        doc += `    <note>${escapeXml(options.partNote)}</note>\n`;
    }
    if (failedCount > 0 || truncatedCount > 0) {
        doc += `    <warnings>${failedCount > 0 ? `${failedCount} thread(s) failed to fetch comments. ` : ''}${truncatedCount > 0 ? `${truncatedCount} thread(s) truncated at API page limit.` : ''}</warnings>\n`;
    }
    doc += `    <repository>${escapeXml(`${repoInfo.owner}/${repoInfo.repo}`)}</repository>\n`;
    doc += `    <issue_count>${issues.length}</issue_count>\n`;
    if (nlpOverview) {
        doc += `    <nlp_overview>\n${escapeXml(nlpOverview)}\n    </nlp_overview>\n`;
    }
    doc += `  </context>\n\n`;

    issues.forEach((iss, idx) => {
        doc += `  <document index="${startIndex + idx}" issue_number="${iss.number}">\n`;
        doc += `    <source>Issue #${iss.number}: ${escapeXml(iss.title)}</source>\n`;
        doc += `    <metadata>\n`;
        doc += `      <state>${escapeXml(iss.state)}${iss.stateReason ? ` (${escapeXml(iss.stateReason)})` : ''}</state>\n`;
        doc += `      <author role="${escapeXml(iss.authorAssociation)}">${escapeXml(iss.author)}</author>\n`;
        doc += `      <created_at>${escapeXml(iss.createdAt)}</created_at>\n`;
        if (iss.closedAt) doc += `      <closed_at>${escapeXml(iss.closedAt)}</closed_at>\n`;
        if (iss.labels && iss.labels.length > 0) {
            doc += `      <labels>${escapeXml(iss.labels.join(', '))}</labels>\n`;
        }
        if (iss.reactionsTotal > 0) {
            doc += `      <reactions total="${iss.reactionsTotal}" plus_one="${iss.reactionsPlusOne}" />\n`;
        }
        if (iss.relatedIssues && iss.relatedIssues.length > 0) {
            doc += `      <related_issues>${iss.relatedIssues.map(n => `#${n}`).join(', ')}</related_issues>\n`;
        }
        if (iss.commentsFetchFailed) {
            doc += `      <comments_warning>Comment thread fetch failed (${escapeXml(iss.commentsFetchError || 'API error')})</comments_warning>\n`;
        }
        if (iss.commentsTruncated) {
            doc += `      <comments_note>Comment thread truncated at API page limit</comments_note>\n`;
        }
        doc += `    </metadata>\n`;

        doc += `    <document_content>\n`;
        const bodyClean = stripXmlInvalidChars(iss.cleanedBody || '(No description provided)');
        doc += `      <issue_body>\n<![CDATA[\n${escapeCdata(bodyClean)}\n]]>\n      </issue_body>\n`;

        if (iss.cleanedComments && iss.cleanedComments.length > 0) {
            doc += `      <comments count="${iss.cleanedComments.length}">\n`;
            iss.cleanedComments.forEach((c, cIdx) => {
                const cClean = stripXmlInvalidChars(c.body);
                doc += `        <comment index="${cIdx + 1}" author="${escapeXml(c.author)}" role="${escapeXml(c.role)}" date="${escapeXml(c.createdAt)}">\n<![CDATA[\n${escapeCdata(cClean)}\n]]>\n        </comment>\n`;
            });
            doc += `      </comments>\n`;
        }
        doc += `    </document_content>\n`;
        doc += `  </document>\n`;
    });

    if (options.instructions) {
        const instStr = stripXmlInvalidChars(options.instructions);
        doc += `  <instructions>\n<![CDATA[\n${escapeCdata(instStr)}\n]]>\n  </instructions>\n`;
    }

    doc += `</documents>`;
    return { text: doc, ext: 'xml', mime: 'application/xml' };
}

export function formatIssuesMarkdown(repoInfo, issues, options = {}) {
    const nlpOverview = options.includeNlpSummary ? formatNlpOverviewText(options.nlpData, issues) : '';
    const failedCount = issues.filter(i => i.commentsFetchFailed).length;
    const truncatedCount = issues.filter(i => i.commentsTruncated).length;

    let md = '';
    if (options.partNote) {
        md += `> **Note:** ${options.partNote}\n\n`;
    }
    if (failedCount > 0 || truncatedCount > 0) {
        md += `> **Warning:** ${failedCount > 0 ? `${failedCount} thread(s) failed to fetch comments. ` : ''}${truncatedCount > 0 ? `${truncatedCount} thread(s) truncated at API page limit.` : ''}\n\n`;
    }
    md += `# GitHub Issues: ${repoInfo.owner}/${repoInfo.repo}\n`;
    md += `Included Issues: ${issues.length}\n\n`;

    if (nlpOverview) {
        const fence = getMarkdownFence(nlpOverview);
        md += `## NLP Topic & Phrase Overview\n${fence}text\n${nlpOverview}\n${fence}\n\n`;
    }

    md += `## Issue Threads\n\n`;
    for (const iss of issues) {
        const stateTag = iss.stateReason ? `${iss.state.toUpperCase()} (${iss.stateReason})` : iss.state.toUpperCase();
        md += `### [#${iss.number}] ${iss.title}\n`;
        md += `- **State:** ${stateTag} | **Author:** @${iss.author} (${iss.authorAssociation}) | **Created:** ${iss.createdAt}${iss.closedAt ? ` | **Closed:** ${iss.closedAt}` : ''}\n`;
        if (iss.labels && iss.labels.length > 0) {
            md += `- **Labels:** ${iss.labels.join(', ')}\n`;
        }
        if (iss.relatedIssues && iss.relatedIssues.length > 0) {
            md += `- **Referenced Issues:** ${iss.relatedIssues.map(n => `#${n}`).join(', ')}\n`;
        }
        if (iss.commentsFetchFailed) {
            md += `> **Warning:** Comment thread fetch failed (${iss.commentsFetchError || 'API error'}).\n`;
        }
        if (iss.commentsTruncated) {
            md += `> **Note:** Only first ${iss.cleanedComments ? iss.cleanedComments.length : 0} comments included (thread truncated at API limit).\n`;
        }
        md += `\n#### Description\n${iss.cleanedBody || '*(No description)*'}\n\n`;

        if (iss.cleanedComments && iss.cleanedComments.length > 0) {
            md += `#### Comments (${iss.cleanedComments.length})\n\n`;
            iss.cleanedComments.forEach((c, idx) => {
                md += `**[Comment ${idx + 1}] @${c.author} (${c.role}) on ${c.createdAt}:**\n${c.body}\n\n`;
            });
        }
        md += `---\n\n`;
    }

    if (options.instructions) {
        md += `## Instructions\n\n${options.instructions}\n`;
    }

    return { text: md, ext: 'md', mime: 'text/markdown' };
}

export function formatIssuesGenericXml(repoInfo, issues, options = {}) {
    const nlpOverview = options.includeNlpSummary ? formatNlpOverviewText(options.nlpData, issues) : '';
    const failedCount = issues.filter(i => i.commentsFetchFailed).length;
    const truncatedCount = issues.filter(i => i.commentsTruncated).length;

    let xml = `<issues_repository name="${escapeXml(`${repoInfo.owner}/${repoInfo.repo}`)}" count="${issues.length}">\n`;
    if (options.partNote) {
        xml += `  <note>${escapeXml(options.partNote)}</note>\n`;
    }
    if (failedCount > 0 || truncatedCount > 0) {
        xml += `  <warnings>${failedCount > 0 ? `${failedCount} thread(s) failed to fetch comments. ` : ''}${truncatedCount > 0 ? `${truncatedCount} thread(s) truncated at API page limit.` : ''}</warnings>\n`;
    }
    if (nlpOverview) {
        xml += `  <nlp_overview>${escapeXml(nlpOverview)}</nlp_overview>\n`;
    }
    xml += `  <issues>\n`;
    for (const iss of issues) {
        xml += `    <issue number="${iss.number}" state="${escapeXml(iss.state)}" author="${escapeXml(iss.author)}" role="${escapeXml(iss.authorAssociation)}" created="${escapeXml(iss.createdAt)}">\n`;
        xml += `      <title>${escapeXml(iss.title)}</title>\n`;
        if (iss.commentsFetchFailed) {
            xml += `      <comments_warning>${escapeXml(iss.commentsFetchError || 'Comment thread fetch failed')}</comments_warning>\n`;
        }
        if (iss.commentsTruncated) {
            xml += `      <comments_warning>Comment thread truncated at API limit</comments_warning>\n`;
        }
        xml += `      <body><![CDATA[\n${escapeCdata(stripXmlInvalidChars(iss.cleanedBody))}\n]]></body>\n`;
        if (iss.cleanedComments && iss.cleanedComments.length > 0) {
            xml += `      <comments>\n`;
            for (const c of iss.cleanedComments) {
                xml += `        <comment author="${escapeXml(c.author)}" role="${escapeXml(c.role)}" date="${escapeXml(c.createdAt)}"><![CDATA[\n${escapeCdata(stripXmlInvalidChars(c.body))}\n]]></comment>\n`;
            }
            xml += `      </comments>\n`;
        }
        xml += `    </issue>\n`;
    }
    xml += `  </issues>\n`;
    if (options.instructions) {
        xml += `  <instructions><![CDATA[\n${escapeCdata(stripXmlInvalidChars(options.instructions))}\n]]></instructions>\n`;
    }
    xml += `</issues_repository>`;
    return { text: xml, ext: 'xml', mime: 'application/xml' };
}

export function formatIssuesJson(repoInfo, issues, options = {}) {
    const nlpOverview = options.includeNlpSummary ? formatNlpOverviewText(options.nlpData, issues) : '';
    const failedCount = issues.filter(i => i.commentsFetchFailed).length;
    const truncatedCount = issues.filter(i => i.commentsTruncated).length;

    const payload = {
        repository: `${repoInfo.owner}/${repoInfo.repo}`,
        ...(options.partNote ? { note: options.partNote } : {}),
        ...((failedCount > 0 || truncatedCount > 0) ? {
            warnings: `${failedCount > 0 ? `${failedCount} thread(s) failed to fetch comments. ` : ''}${truncatedCount > 0 ? `${truncatedCount} thread(s) truncated at API page limit.` : ''}`
        } : {}),
        ...(nlpOverview ? { nlp_overview: nlpOverview } : {}),
        issues: issues.map(iss => ({
            number: iss.number,
            title: iss.title,
            state: iss.state,
            state_reason: iss.stateReason,
            author: iss.author,
            author_association: iss.authorAssociation,
            created_at: iss.createdAt,
            closed_at: iss.closedAt,
            labels: iss.labels,
            reactions_total: iss.reactionsTotal,
            related_issues: iss.relatedIssues,
            body: iss.cleanedBody,
            comments: iss.cleanedComments,
            ...(iss.commentsFetchFailed ? { comments_warning: iss.commentsFetchError || 'Comment thread fetch failed' } : {}),
            ...(iss.commentsTruncated ? { comments_truncated: true } : {})
        })),
        ...(options.instructions ? { instructions: options.instructions } : {})
    };
    return {
        text: JSON.stringify(payload, null, 2),
        ext: 'json',
        mime: 'application/json'
    };
}

export function buildIssuesOutput(format, repoInfo, issues, options = {}) {
    switch (format) {
        case 'markdown':
            return formatIssuesMarkdown(repoInfo, issues, options);
        case 'generic-xml':
            return formatIssuesGenericXml(repoInfo, issues, options);
        case 'json':
            return formatIssuesJson(repoInfo, issues, options);
        case 'claude-xml':
        default:
            return formatIssuesClaudeXml(repoInfo, issues, options);
    }
}

export function chunkIssuesOutput(format, repoInfo, issues, chunkTokenLimit, estimateTokensFn, options = {}) {
    const instructions = options.instructions || '';
    if (!chunkTokenLimit || chunkTokenLimit <= 0 || issues.length <= 1) {
        const out = buildIssuesOutput(format, repoInfo, issues, { ...options, instructions });
        out.exceedsLimit = chunkTokenLimit > 0 ? estimateTokensFn(out.text) > chunkTokenLimit : false;
        return [out];
    }

    const cleanOpts = { ...options, instructions: '', includeNlpSummary: false };
    const emptyBase = buildIssuesOutput(format, repoInfo, [], cleanOpts);
    const emptyBaseTokens = estimateTokensFn(emptyBase.text);

    const issueTokenEstimates = issues.map(iss => {
        const single = buildIssuesOutput(format, repoInfo, [iss], cleanOpts);
        return Math.max(1, estimateTokensFn(single.text) - emptyBaseTokens);
    });

    const firstChunkHeader = buildIssuesOutput(format, repoInfo, [], { ...options, instructions });
    let runningTokens = estimateTokensFn(firstChunkHeader.text);

    const chunks = [];
    let currentList = [];
    let currentStart = 1;

    for (let i = 0; i < issues.length; i++) {
        const iss = issues[i];
        const t = issueTokenEstimates[i];

        if (currentList.length > 0 && runningTokens + t > chunkTokenLimit) {
            chunks.push({ issues: currentList, startIndex: currentStart });
            currentStart += currentList.length;
            currentList = [iss];
            runningTokens = emptyBaseTokens + t;
        } else {
            currentList.push(iss);
            runningTokens += t;
        }
    }
    if (currentList.length > 0) {
        chunks.push({ issues: currentList, startIndex: currentStart });
    }

    const N = chunks.length;
    return chunks.map((c, idx) => {
        const isLast = idx === N - 1;
        const out = buildIssuesOutput(format, repoInfo, c.issues, {
            ...options,
            includeNlpSummary: idx === 0 ? options.includeNlpSummary : false,
            startIndex: c.startIndex,
            instructions: isLast ? instructions : '',
            partNote: (N > 1 && !isLast) ? `Part ${idx + 1} of ${N}. Instructions are in part ${N}.` : ''
        });
        out.exceedsLimit = estimateTokensFn(out.text) > chunkTokenLimit;
        return out;
    });
}
