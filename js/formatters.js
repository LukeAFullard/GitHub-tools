/**
 * Output Schemas for LLM Context Packaging
 */

export function escapeXml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function escapeCdata(str) {
    if (!str) return '';
    return String(str).replace(/]]>/g, ']]]]><![CDATA[>');
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

export function formatClaudeXml(repoInfo, branch, treeText, files) {
    let doc = `<documents>\n`;
    doc += `  <!-- Global Repository Context -->\n`;
    doc += `  <context>\n`;
    doc += `    <repository>${escapeXml(`${repoInfo.owner}/${repoInfo.repo}`)}</repository>\n`;
    doc += `    <branch>${escapeXml(branch)}</branch>\n`;
    doc += `    <structure>\n${escapeXml(treeText)}    </structure>\n`;
    doc += `  </context>\n\n`;

    files.forEach((file, idx) => {
        doc += `  <document index="${idx + 1}">\n`;
        doc += `    <source>${escapeXml(file.path)}</source>\n`;
        doc += `    <document_content>\n${escapeXml(file.content)}\n    </document_content>\n`;
        doc += `  </document>\n`;
    });
    doc += `</documents>`;
    return {
        text: doc,
        ext: 'xml',
        mime: 'application/xml'
    };
}

export function formatMarkdown(repoInfo, branch, treeText, files) {
    const treeFence = getMarkdownFence(treeText);
    let md = `# Repository: ${repoInfo.owner}/${repoInfo.repo}\nBranch: ${branch}\n\n`;
    md += `## Structure\n${treeFence}text\n${treeText}${treeFence}\n\n## Files\n\n`;
    for (const file of files) {
        const ext = file.path.includes('.') ? file.path.split('.').pop() : '';
        const fence = getMarkdownFence(file.content);
        md += `### File: \`${file.path.replace(/`/g, '\\`')}\`\n${fence}${ext}\n${file.content}\n${fence}\n\n`;
    }
    return {
        text: md,
        ext: 'md',
        mime: 'text/markdown'
    };
}

export function formatGenericXml(repoInfo, branch, treeText, files) {
    let xml = `<repository name="${escapeXml(`${repoInfo.owner}/${repoInfo.repo}`)}" branch="${escapeXml(branch)}">\n`;
    xml += `<structure>\n${escapeXml(treeText)}</structure>\n<files>\n`;
    for (const file of files) {
        xml += `<file path="${escapeXml(file.path)}">\n<![CDATA[\n${escapeCdata(file.content)}\n]]>\n</file>\n`;
    }
    xml += `</files>\n</repository>`;
    return {
        text: xml,
        ext: 'xml',
        mime: 'application/xml'
    };
}

export function formatJson(repoInfo, branch, treeText, files) {
    const json = JSON.stringify({
        repository: `${repoInfo.owner}/${repoInfo.repo}`,
        branch,
        structure: treeText,
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

    // Pre-calculate token counts per single file wrapped in context format
    const fileTokens = files.map((file, idx) => {
        const singleOutput = buildContextOutput(format, repoInfo, branch, treeText, [file]);
        const tokens = estimateTokensFn(singleOutput.text) - baseOverheadTokens;
        return Math.max(0, tokens);
    });

    const chunks = [];
    let currentFiles = [];
    let currentTokens = baseOverheadTokens;

    for (let i = 0; i < files.length; i++) {
        const fTokens = fileTokens[i];

        if (currentFiles.length > 0 && currentTokens + fTokens > chunkTokenLimit) {
            const chunkOutput = buildContextOutput(format, repoInfo, branch, treeText, currentFiles);
            chunkOutput.exceedsLimit = estimateTokensFn(chunkOutput.text) > chunkTokenLimit;
            chunks.push(chunkOutput);

            currentFiles = [files[i]];
            currentTokens = baseOverheadTokens + fTokens;
        } else {
            currentFiles.push(files[i]);
            currentTokens += fTokens;
        }
    }

    if (currentFiles.length > 0) {
        const chunkOutput = buildContextOutput(format, repoInfo, branch, treeText, currentFiles);
        chunkOutput.exceedsLimit = estimateTokensFn(chunkOutput.text) > chunkTokenLimit;
        chunks.push(chunkOutput);
    }

    return chunks;
}

export function buildContextOutput(format, repoInfo, branch, treeText, files) {
    switch (format) {
        case 'claude-xml':
            return formatClaudeXml(repoInfo, branch, treeText, files);
        case 'markdown':
            return formatMarkdown(repoInfo, branch, treeText, files);
        case 'generic-xml':
            return formatGenericXml(repoInfo, branch, treeText, files);
        case 'json':
            return formatJson(repoInfo, branch, treeText, files);
        default:
            return formatClaudeXml(repoInfo, branch, treeText, files);
    }
}
