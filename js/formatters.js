/**
 * Output Schemas for LLM Context Packaging
 */

export function stripXmlInvalidChars(str) {
    if (!str) return '';
    return String(str).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F]/g, '');
}

export function escapeXml(str) {
    if (!str) return '';
    return stripXmlInvalidChars(String(str))
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function escapeCdata(str) {
    if (!str) return '';
    return stripXmlInvalidChars(String(str)).replace(/\]\]\>/g, ']]]]><![CDATA[>');
}

export function getMarkdownFence(content) {
    if (!content) return '```';
    const matches = content.match(/`+/g);
    if (!matches) return '```';
    let maxLen = 0;
    for (const m of matches) {
        if (m.length > maxLen) maxLen = m.length;
    }
    const fenceLen = Math.max(3, maxLen + 1);
    return '`'.repeat(fenceLen);
}

export function formatClaudeXml(repoInfo, branch, treeText, files, options = {}) {
    const startIndex = (options && options.startIndex) || 1;
    let doc = `<documents>\n`;
    doc += `  <!-- Global Repository Context -->\n`;
    doc += `  <context>\n`;
    doc += `    <repository>${escapeXml(`${repoInfo.owner}/${repoInfo.repo}`)}</repository>\n`;
    doc += `    <branch>${escapeXml(branch)}</branch>\n`;
    if (repoInfo.url) {
        doc += `    <url>${escapeXml(repoInfo.url)}</url>\n`;
    }
    if (treeText) {
        doc += `    <structure>\n${escapeXml(treeText)}    </structure>\n`;
    }
    doc += `  </context>\n\n`;

    files.forEach((file, idx) => {
        doc += `  <document index="${startIndex + idx}">\n`;
        doc += `    <source>${escapeXml(file.path)}</source>\n`;
        let contentStr = stripXmlInvalidChars(file.content || '');
        if (contentStr.includes('</document_content>') || contentStr.includes('</document>') || contentStr.includes('<') || contentStr.includes('&') || contentStr.includes(']]>')) {
            contentStr = `<![CDATA[\n${escapeCdata(contentStr)}\n]]>`;
        }
        doc += `    <document_content>\n${contentStr}\n    </document_content>\n`;
        doc += `  </document>\n`;
    });
    doc += `</documents>`;
    return {
        text: doc,
        ext: 'xml',
        mime: 'application/xml'
    };
}

export function formatMarkdown(repoInfo, branch, treeText, files, options = {}) {
    const treeFence = getMarkdownFence(treeText);
    let md = `# Repository: ${repoInfo.owner}/${repoInfo.repo}\nBranch: ${branch}\n`;
    if (repoInfo.url) {
        md += `Source URL: ${repoInfo.url}\n`;
    }
    if (treeText) {
        md += `\n## Structure\n${treeFence}text\n${treeText}${treeFence}\n\n`;
    }
    md += `## Files\n\n`;
    for (const file of files) {
        const filename = file.path.split('/').pop();
        const ext = filename.includes('.') ? filename.split('.').pop() : '';
        const fence = getMarkdownFence(file.content);
        const pathFence = file.path.includes('`') ? '`` ' + file.path + ' ``' : '`' + file.path + '`';
        md += `### File: ${pathFence}\n${fence}${ext}\n${file.content}\n${fence}\n\n`;
    }
    return {
        text: md,
        ext: 'md',
        mime: 'text/markdown'
    };
}

export function formatGenericXml(repoInfo, branch, treeText, files, options = {}) {
    let xml = `<repository name="${escapeXml(`${repoInfo.owner}/${repoInfo.repo}`)}" branch="${escapeXml(branch)}"${repoInfo.url ? ` url="${escapeXml(repoInfo.url)}"` : ''}>\n`;
    if (treeText) {
        xml += `<structure>\n${escapeXml(treeText)}</structure>\n`;
    }
    xml += `<files>\n`;
    for (const file of files) {
        xml += `<file path="${escapeXml(file.path)}">\n<![CDATA[\n${escapeCdata(stripXmlInvalidChars(file.content))}\n]]>\n</file>\n`;
    }
    xml += `</files>\n</repository>`;
    return {
        text: xml,
        ext: 'xml',
        mime: 'application/xml'
    };
}

export function formatJson(repoInfo, branch, treeText, files, options = {}) {
    const json = JSON.stringify({
        repository: `${repoInfo.owner}/${repoInfo.repo}`,
        branch,
        ...(repoInfo.url ? { url: repoInfo.url } : {}),
        ...(treeText ? { structure: treeText } : {}),
        files
    }, null, 2);
    return {
        text: json,
        ext: 'json',
        mime: 'application/json'
    };
}

export function chunkContextOutput(format, repoInfo, branch, treeText, files, chunkTokenLimit, estimateTokensFn) {
    if (!chunkTokenLimit || chunkTokenLimit <= 0) {
        const output = buildContextOutput(format, repoInfo, branch, treeText, files);
        output.exceedsLimit = false;
        return [output];
    }

    // Estimate header/template overhead for an empty repository output
    const emptyOutput = buildContextOutput(format, repoInfo, branch, treeText, []);
    const baseOverheadTokens = estimateTokensFn(emptyOutput.text);

    // Pre-calculate token counts per single file using empty treeText to avoid re-scanning tree topology
    const emptyBase = buildContextOutput(format, repoInfo, branch, '', []);
    const emptyBaseTokens = estimateTokensFn(emptyBase.text);

    const fileTokens = files.map((file) => {
        const singleOutput = buildContextOutput(format, repoInfo, branch, '', [file]);
        const tokens = estimateTokensFn(singleOutput.text) - emptyBaseTokens;
        return Math.max(0, tokens);
    });

    const chunks = [];
    let currentFiles = [];
    let currentTokens = baseOverheadTokens;
    let currentStartIndex = 1;

    for (let i = 0; i < files.length; i++) {
        const fTokens = fileTokens[i];

        if (currentFiles.length > 0 && currentTokens + fTokens > chunkTokenLimit) {
            const treeForChunk = chunks.length === 0 ? treeText : '';
            const chunkOutput = buildContextOutput(format, repoInfo, branch, treeForChunk, currentFiles, { startIndex: currentStartIndex });
            chunkOutput.exceedsLimit = estimateTokensFn(chunkOutput.text) > chunkTokenLimit;
            chunks.push(chunkOutput);

            currentStartIndex += currentFiles.length;
            currentFiles = [files[i]];
            currentTokens = baseOverheadTokens + fTokens;
        } else {
            currentFiles.push(files[i]);
            currentTokens += fTokens;
        }
    }

    if (currentFiles.length > 0) {
        const treeForChunk = chunks.length === 0 ? treeText : '';
        const chunkOutput = buildContextOutput(format, repoInfo, branch, treeForChunk, currentFiles, { startIndex: currentStartIndex });
        chunkOutput.exceedsLimit = estimateTokensFn(chunkOutput.text) > chunkTokenLimit;
        chunks.push(chunkOutput);
    }

    return chunks;
}

export function buildContextOutput(format, repoInfo, branch, treeText, files, options = {}) {
    switch (format) {
        case 'claude-xml':
            return formatClaudeXml(repoInfo, branch, treeText, files, options);
        case 'markdown':
            return formatMarkdown(repoInfo, branch, treeText, files, options);
        case 'generic-xml':
            return formatGenericXml(repoInfo, branch, treeText, files, options);
        case 'json':
            return formatJson(repoInfo, branch, treeText, files, options);
        default:
            return formatClaudeXml(repoInfo, branch, treeText, files, options);
    }
}
