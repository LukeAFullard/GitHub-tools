/**
 * Lightweight Client-Side Code Minifier & Whitespace Compressor for LLM Context
 */

export function minifyCode(content, filename = '', mode = 'none') {
    if (!content || mode === 'none') return content;

    // Standardize line endings and trim trailing whitespace from lines
    let lines = content.split(/\r?\n/).map(line => line.trimEnd());

    if (mode === 'basic' || mode === 'aggressive') {
        // Filter out empty lines
        lines = lines.filter((line, index, arr) => {
            const isEmpty = line.trim().length === 0;
            if (!isEmpty) return true;
            if (mode === 'aggressive') return false; // remove all blank lines
            const prevIsEmpty = index > 0 && arr[index - 1].trim().length === 0;
            return !prevIsEmpty; // keep max 1 consecutive blank line
        });
    }

    let result = lines.join('\n').trim();

    if (mode === 'aggressive') {
        const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
        // Safe comment removal based on extension
        if (['js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'c', 'cpp', 'h', 'java', 'go', 'rs', 'swift', 'php'].includes(ext)) {
            result = result
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');
        } else if (['py', 'sh', 'bash', 'yaml', 'yml', 'rb'].includes(ext)) {
            result = result.replace(/(^|[^:"'\\])#(?!!).*$/gm, '$1');
        } else if (['html', 'xml', 'svg'].includes(ext)) {
            result = result.replace(/<!--[\s\S]*?-->/g, '');
        }
        // Clean up any empty lines created by comment removal
        result = result.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0).join('\n');
    }

    return result;
}
