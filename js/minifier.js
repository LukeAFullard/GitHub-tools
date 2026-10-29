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

function stripJsComments(code) {
    let output = '';
    let i = 0;
    const len = code.length;
    let state = 'normal';

    while (i < len) {
        const char = code[i];
        const next = code[i + 1];

        if (state === 'normal') {
            if (char === '/' && next === '/') {
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
                const isRegexp = !isUrl && (!lastChar || '=(:[{},;!&|?+*^%~<>'.includes(lastChar) || keywordRegex.test(prevTrimmed));

                if (isRegexp) {
                    state = 'regex';
                    output += char;
                    i++;
                } else {
                    output += char;
                    i++;
                }
            } else if (char === "'") {
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
            }
            i++;
        } else if (state === 'template_string') {
            output += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    output += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === '`') {
                state = 'normal';
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

function stripHashComments(code) {
    let output = '';
    let i = 0;
    const len = code.length;
    let state = 'normal';

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
            if (char === '#' && (i === 0 || /\s/.test(code[i - 1])) && (i === 0 || code[i - 1] !== '\\')) {
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

export function minifyCode(content, filename = '', mode = 'none') {
    if (!content || mode === 'none') return content;

    if (mode === 'basic') {
        return content.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    if (mode === 'aggressive') {
        const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
        let result = content.replace(/\r\n/g, '\n');

        if (['js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'c', 'cpp', 'h', 'java', 'go', 'rs', 'swift', 'php'].includes(ext)) {
            result = stripJsComments(result);
        } else if (['py', 'sh', 'bash', 'yaml', 'yml', 'rb'].includes(ext)) {
            result = stripHashComments(result);
        } else if (['html', 'xml', 'svg'].includes(ext)) {
            result = result.replace(/<!--[\s\S]*?-->/g, '');
            result = result.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0).join('\n');
        } else {
            result = result.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0).join('\n');
        }
        return result.trim();
    }

    return content;
}
