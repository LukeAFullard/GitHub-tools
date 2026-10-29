/**
 * Lightweight Client-Side Code Minifier & Whitespace Compressor for LLM Context
 */

function handleNormalNewline(output) {
    const lastNL = output.lastIndexOf('\n');
    const currentLine = output.slice(lastNL + 1);
    if (currentLine.trim().length === 0) {
        return output.slice(0, lastNL + 1);
    }
    return output.trimEnd() + '\n';
}

function stripJsComments(code, ext = '') {
    let output = '';
    let i = 0;
    const len = code.length;
    let state = 'normal';
    const isCss = ['css', 'scss', 'less'].includes(ext);
    const isRust = ext === 'rs';
    const templateStack = [];

    while (i < len) {
        const char = code[i];
        const next = code[i + 1];

        if (state === 'normal') {
            if (!isCss && char === '/' && next === '/') {
                const prevTrimmed = output.trimEnd();
                if (/(?:https?|ftp|file):$/i.test(prevTrimmed)) {
                    output += char;
                    i++;
                    continue;
                }
                state = 'line_comment';
                i += 2;
                continue;
            } else if (char === '/' && next === '*') {
                state = 'block_comment';
                i += 2;
                continue;
            } else if (char === '/') {
                const prevTrimmed = output.trimEnd();
                const lastChar = prevTrimmed[prevTrimmed.length - 1];
                const keywordRegex = /\b(?:return|case|typeof|throw|delete|void|in|of|instanceof|new|yield|await)$/;
                const isUrl = /(?:https?|ftp|file):$/i.test(prevTrimmed);
                const isRegexp = !isCss && !isUrl && lastChar !== '<' && (!lastChar || '=(:[{},;!&|?+*^%~'.includes(lastChar) || keywordRegex.test(prevTrimmed));

                if (isRegexp) {
                    state = 'regex';
                    output += char;
                    i++;
                } else {
                    output += char;
                    i++;
                }
            } else if (char === "'") {
                if (isRust) {
                    const remainder = code.slice(i);
                    const lifetimeMatch = remainder.match(/^'([a-zA-Z_][a-zA-Z0-9_]*)/);
                    if (lifetimeMatch) {
                        const name = lifetimeMatch[1];
                        const after = code[i + 1 + name.length];
                        if (after !== "'") {
                            output += char;
                            i++;
                            continue;
                        }
                    }
                }
                state = 'single_string';
                output += char;
                i++;
            } else if (char === '"') {
                state = 'double_string';
                output += char;
                i++;
            } else if (char === '`') {
                state = 'template_string';
                output += char;
                i++;
            } else if (char === '{' && templateStack.length > 0) {
                templateStack[templateStack.length - 1].braceDepth++;
                output += char;
                i++;
            } else if (char === '}' && templateStack.length > 0) {
                const top = templateStack[templateStack.length - 1];
                top.braceDepth--;
                if (top.braceDepth === 0) {
                    templateStack.pop();
                    state = top.returnState;
                }
                output += char;
                i++;
            } else if (char === '\n') {
                output = handleNormalNewline(output);
                i++;
            } else {
                output += char;
                i++;
            }
        } else if (state === 'regex') {
            if (char === '\n') {
                state = 'normal';
                output += char;
                i++;
                continue;
            }
            output += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    output += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === '[') {
                state = 'regex_class';
            } else if (char === '/') {
                state = 'normal';
            }
            i++;
        } else if (state === 'regex_class') {
            if (char === '\n') {
                state = 'normal';
                output += char;
                i++;
                continue;
            }
            output += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    output += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === ']') {
                state = 'regex';
            }
            i++;
        } else if (state === 'single_string') {
            output += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    output += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === "'") {
                state = 'normal';
            } else if (char === '\n') {
                state = 'normal';
                output = handleNormalNewline(output);
            }
            i++;
        } else if (state === 'double_string') {
            output += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    output += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === '"') {
                state = 'normal';
            } else if (char === '\n') {
                state = 'normal';
                output = handleNormalNewline(output);
            }
            i++;
        } else if (state === 'template_string') {
            if (char === '\\') {
                output += char;
                if (i + 1 < len) {
                    output += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === '`') {
                output += char;
                state = 'normal';
            } else if (char === '$' && next === '{') {
                output += '${';
                i += 2;
                templateStack.push({ returnState: 'template_string', braceDepth: 1 });
                state = 'normal';
                continue;
            } else {
                output += char;
            }
            i++;
        } else if (state === 'line_comment') {
            if (char === '\n') {
                state = 'normal';
                output = handleNormalNewline(output);
            }
            i++;
        } else if (state === 'block_comment') {
            if (char === '*' && next === '/') {
                state = 'normal';
                i += 2;
                const prevChar = output[output.length - 1];
                const nextChar = code[i];
                if (prevChar && nextChar && /[a-zA-Z0-9_$]/.test(prevChar) && /[a-zA-Z0-9_$]/.test(nextChar)) {
                    output += ' ';
                }
                continue;
            }
            if (char === '\n') {
                output = handleNormalNewline(output);
            }
            i++;
        }
    }
    const lastNL = output.lastIndexOf('\n');
    if (output.slice(lastNL + 1).trim().length === 0) {
        output = output.slice(0, lastNL + 1);
    }
    return output.trim();
}

function stripHashComments(code, ext = '') {
    let output = '';
    let i = 0;
    const len = code.length;
    let state = 'normal';
    const isShell = ['sh', 'bash'].includes(ext);

    if (code.startsWith('#!')) {
        const firstLineEnd = code.indexOf('\n');
        if (firstLineEnd === -1) return code;
        output += code.slice(0, firstLineEnd + 1);
        i = firstLineEnd + 1;
    }

    while (i < len) {
        const char = code[i];
        const next = code[i + 1];
        const next2 = code[i + 2];

        if (state === 'normal') {
            const isCommentStart = isShell
                ? (i === 0 || /[\s;&|()]/.test(code[i - 1]))
                : (i === 0 || code[i - 1] !== '\\');
            if (char === '#' && isCommentStart) {
                state = 'line_comment';
                i++;
                continue;
            } else if (char === "'" && next === "'" && next2 === "'") {
                state = 'triple_single';
                output += "'''";
                i += 3;
            } else if (char === '"' && next === '"' && next2 === '"') {
                state = 'triple_double';
                output += '"""';
                i += 3;
            } else if (char === "'") {
                state = 'single_string';
                output += char;
                i++;
            } else if (char === '"') {
                state = 'double_string';
                output += char;
                i++;
            } else if (char === '\n') {
                output = handleNormalNewline(output);
                i++;
            } else {
                output += char;
                i++;
            }
        } else if (state === 'single_string') {
            output += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    output += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === "'") {
                state = 'normal';
            } else if (char === '\n') {
                state = 'normal';
                output = handleNormalNewline(output);
            }
            i++;
        } else if (state === 'double_string') {
            output += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    output += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === '"') {
                state = 'normal';
            } else if (char === '\n') {
                state = 'normal';
                output = handleNormalNewline(output);
            }
            i++;
        } else if (state === 'triple_single') {
            output += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    output += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === "'" && next === "'" && next2 === "'") {
                output += "''";
                i += 2;
                state = 'normal';
            }
            i++;
        } else if (state === 'triple_double') {
            output += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    output += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === '"' && next === '"' && next2 === '"') {
                output += '""';
                i += 2;
                state = 'normal';
            }
            i++;
        } else if (state === 'line_comment') {
            if (char === '\n') {
                state = 'normal';
                output = handleNormalNewline(output);
            }
            i++;
        }
    }
    const lastNL = output.lastIndexOf('\n');
    if (output.slice(lastNL + 1).trim().length === 0) {
        output = output.slice(0, lastNL + 1);
    }
    return output.trim();
}

function minifyHtml(code) {
    const rawBlocks = [];
    const nonce = '___PRE_TEXTAREA_' + Math.random().toString(36).substring(2, 9) + '_';
    let preserved = code.replace(/<(pre|textarea|script|style)\b[\s\S]*?<\/\1>/gi, (match) => {
        rawBlocks.push(match);
        return `${nonce}${rawBlocks.length - 1}___`;
    });

    preserved = preserved.replace(/<!--[\s\S]*?-->/g, '');
    let lines = preserved.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0);
    let result = lines.join('\n');

    const re = new RegExp(`${nonce}(\\d+)___`, 'g');
    result = result.replace(re, (_, idx) => rawBlocks[parseInt(idx, 10)]);
    return result;
}

export function minifyCode(content, filename = '', mode = 'none') {
    if (!content || mode === 'none') return content;

    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    const textExts = ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'toml', 'ini', 'csv', 'log', 'env'];

    if (mode === 'basic' || textExts.includes(ext)) {
        return content.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd().replace(/^\n+/, '');
    }

    if (mode === 'aggressive') {
        let result = content.replace(/\r\n/g, '\n');

        if (['js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'c', 'cpp', 'h', 'java', 'go', 'rs', 'swift', 'php'].includes(ext)) {
            result = stripJsComments(result, ext);
        } else if (['py', 'sh', 'bash', 'rb'].includes(ext)) {
            result = stripHashComments(result, ext);
        } else if (['html', 'xml', 'svg'].includes(ext)) {
            result = minifyHtml(result);
        } else {
            result = result.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0).join('\n');
        }
        return result.trim();
    }

    return content;
}
