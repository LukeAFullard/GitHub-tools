/**
 * Output Schemas for LLM Context Packaging
 */

export function formatClaudeXml(repoInfo, branch, treeText, files) {
    let doc = `<documents>\n`;
    doc += `  <!-- Global Repository Context -->\n`;
    doc += `  <context>\n`;
    doc += `    <repository>${repoInfo.owner}/${repoInfo.repo}</repository>\n`;
    doc += `    <branch>${branch}</branch>\n`;
    doc += `    <structure>\n${treeText}    </structure>\n`;
    doc += `  </context>\n\n`;

    files.forEach((file, idx) => {
        doc += `  <document index="${idx + 1}">\n`;
        doc += `    <source>${file.path}</source>\n`;
        doc += `    <document_content>\n${file.content}\n    </document_content>\n`;
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
    let md = `# Repository: ${repoInfo.owner}/${repoInfo.repo}\nBranch: ${branch}\n\n`;
    md += `## Structure\n\`\`\`text\n${treeText}\`\`\`\n\n## Files\n\n`;
    for (const file of files) {
        const ext = file.path.includes('.') ? file.path.split('.').pop() : '';
        md += `### File: \`${file.path}\`\n\`\`\`${ext}\n${file.content}\n\`\`\`\n\n`;
    }
    return {
        text: md,
        ext: 'md',
        mime: 'text/markdown'
    };
}

export function formatGenericXml(repoInfo, branch, treeText, files) {
    let xml = `<repository name="${repoInfo.owner}/${repoInfo.repo}" branch="${branch}">\n`;
    xml += `<structure>\n${treeText}</structure>\n<files>\n`;
    for (const file of files) {
        xml += `<file path="${file.path}">\n<![CDATA[\n${file.content}\n]]>\n</file>\n`;
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
        return [buildContextOutput(format, repoInfo, branch, treeText, files)];
    }

    const chunks = [];
    let currentFiles = [];

    for (let i = 0; i < files.length; i++) {
        const candidateFiles = [...currentFiles, files[i]];
        const candidateOutput = buildContextOutput(format, repoInfo, branch, treeText, candidateFiles);
        const est = estimateTokensFn(candidateOutput.text);

        if (est > chunkTokenLimit && currentFiles.length > 0) {
            chunks.push(buildContextOutput(format, repoInfo, branch, treeText, currentFiles));
            currentFiles = [files[i]];
        } else {
            currentFiles.push(files[i]);
        }
    }

    if (currentFiles.length > 0) {
        chunks.push(buildContextOutput(format, repoInfo, branch, treeText, currentFiles));
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
