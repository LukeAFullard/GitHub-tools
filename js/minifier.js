/**
 * Lightweight Client-Side Code Minifier & Whitespace Compressor for LLM Context
 */

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
                state = 'line_comment';
                i += 2;
                continue;
            } else if (char === '/' && next === '*') {
                state = 'block_comment';
                i += 2;
                continue;
            } else if (char === '/') {
                // Determine if slash is start of RegExp literal or division operator
                const prevTrimmed = output.trimEnd();
                const lastChar = prevTrimmed[prevTrimmed.length - 1];
                const keywordRegex = /\b(?:return|case|typeof|throw|delete|void|in|of|instanceof|new|yield|await)$/;
                const isRegexp = !lastChar || '=(:[{},;!&|?+*^%~<>'.includes(lastChar) || keywordRegex.test(prevTrimmed);

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
                output += '\n';
            }
            i++;
        } else if (state === 'block_comment') {
            if (char === '*' && next === '/') {
                state = 'normal';
                i += 2;
                continue;
            }
            if (char === '\n') {
                output += '\n';
            }
            i++;
        }
    }
    return output;
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
            if (char === '#' && (i === 0 || code[i - 1] !== '\\')) {
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
                output += '\n';
            }
            i++;
        }
    }
    return output;
}

export function minifyCode(content, filename = '', mode = 'none') {
    if (!content || mode === 'none') return content;

    let lines = content.split(/\r?\n/).map(line => line.trimEnd());

    if (mode === 'basic' || mode === 'aggressive') {
        lines = lines.filter((line, index, arr) => {
            const isEmpty = line.trim().length === 0;
            if (!isEmpty) return true;
            if (mode === 'aggressive') return false;
            const prevIsEmpty = index > 0 && arr[index - 1].trim().length === 0;
            return !prevIsEmpty;
        });
    }

    let result = lines.join('\n').trim();

    if (mode === 'aggressive') {
        const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
        if (['js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'c', 'cpp', 'h', 'java', 'go', 'rs', 'swift', 'php'].includes(ext)) {
            result = stripJsComments(result);
        } else if (['py', 'sh', 'bash', 'yaml', 'yml', 'rb'].includes(ext)) {
            result = stripHashComments(result);
        } else if (['html', 'xml', 'svg'].includes(ext)) {
            result = result.replace(/<!--[\s\S]*?-->/g, '');
        }
        result = result.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0).join('\n');
    }

    return result;
}
