/**
 * Sanitizes GitHub Issue bodies and comments to maximize LLM signal-to-noise ratio.
 */
import { redactSecrets } from './secrets.js';

const BOT_LOGIN_REGEX = /\[bot\]$|^(?:dependabot|renovate|github-actions|codecov|stale|vercel|netlify|snyk-bot|sonarcloud|linear|changeset-bot)$/i;

const LOW_SIGNAL_COMMENT_REGEX = /^[\s*_~`>]*(\+1|👍|👎|👀|❤️|bump|same|same here|me too|i have this issue too|following|any update\??|any updates\??|any news\??|is this fixed\??|still happening|up|subscribing|cc @[a-z0-9_-]+)[\s!?.👍👎]*$/i;

const AUTHORITATIVE_ROLES = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function isBotUser(author, authorType) {
    if (authorType && authorType.toLowerCase() === 'bot') return true;
    if (!author) return false;
    return BOT_LOGIN_REGEX.test(author.trim());
}

export function isLowSignalComment(body) {
    if (!body) return true;
    const cleaned = body
        .replace(/^>.*$/gm, '')
        .trim();
    if (!cleaned) return true;
    if (cleaned.length <= 45 && LOW_SIGNAL_COMMENT_REGEX.test(cleaned)) {
        return true;
    }
    return false;
}

/**
 * Extracts cross-referenced issue/PR numbers (e.g., #42, GH-105) from text.
 */
export function extractIssueReferences(text, selfNumber = null) {
    if (!text) return [];
    const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
    const withoutCode = withoutComments.replace(/```[\s\S]*?```|`[^`\n]+`/g, '');
    const refs = new Set();
    const regex = /(?:^|[\s(])(?:#|GH-)(\d{1,6})\b/gi;
    let match;
    while ((match = regex.exec(withoutCode)) !== null) {
        const num = parseInt(match[1], 10);
        if (num > 0 && num !== selfNumber) {
            refs.add(num);
        }
    }
    return Array.from(refs).sort((a, b) => a - b);
}

/**
 * Cleans a single markdown body (issue description or comment) according to user options.
 */
export function sanitizeIssueText(rawText, options = {}, contextPath = 'issue') {
    if (!rawText) return '';
    let text = rawText.replace(/\r\n/g, '\n');

    const {
        stripTemplates = true,
        stripImages = true,
        maxLogLines = 40,
        isRedact = true
    } = options;

    // 1. Strip HTML comments (issue template instructions) and normalize <details>
    if (stripTemplates) {
        text = text.replace(/<!--[\s\S]*?-->/g, '');
        text = text.replace(/<\/?details\b[^>]*>/gi, '');
        text = text.replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, '**$1**\n');
    }

    // 2. Strip images, GitHub asset links, video tags, and inline Base64 data URIs
    if (stripImages) {
        text = text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+/g, '[IMAGE_BASE64_STRIPPED]');
        text = text.replace(/!\[([^\]]*)\]\((?:[^()\s]+|\([^()\s]*\))*\)/g, (_, alt) => {
            const cleanAlt = (alt || '').trim();
            return cleanAlt && cleanAlt.toLowerCase() !== 'image' ? `[Image: ${cleanAlt}]` : '[Image]';
        });
        text = text.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_, alt) => alt ? `[Image: ${alt}]` : '[Image]');
        text = text.replace(/<img\b[^>]*>/gi, '[Image]');
        text = text.replace(/<video\b[\s\S]*?<\/video>/gi, '[Video]');
        text = text.replace(/https:\/\/github\.com\/user-attachments\/assets\/[a-zA-Z0-9-]+/g, '[GitHub_Media_Attachment]');
    }

    // 3. Truncate massive fenced code blocks / stack traces / logs
    if (maxLogLines > 0) {
        const keepHalf = Math.max(5, Math.floor(maxLogLines / 2));
        text = text.replace(/^([ \t]*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1\2[ \t]*$/gm, (full, indent, fence, info, body) => {
            const lines = body.replace(/\n$/, '').split('\n');
            if (lines.length <= maxLogLines) return full;
            const head = lines.slice(0, keepHalf).join('\n');
            const tail = lines.slice(-keepHalf).join('\n');
            const omitted = lines.length - (keepHalf * 2);
            return `${indent}${fence}${info}\n${head}\n... [${omitted} lines of log/code truncated] ...\n${tail}\n${indent}${fence}`;
        });
    }

    // 4. Redact secrets using existing secrets.js engine
    if (isRedact) {
        text = redactSecrets(text, contextPath, options);
    }

    // 5. Collapse excessive blank lines
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
}

/**
 * Cleans and filters a full issue + its comments array.
 */
export function processIssueThread(issue, rawComments = [], options = {}) {
    const {
        commentScope = 'all', // 'all' | 'maintainers' | 'none'
        filterBots = true,
        filterNoise = true,
        isRedact = true,
        knownNumbers = null
    } = options;

    const title = isRedact ? redactSecrets(issue.title || '', `issue-${issue.number}-title`, options) : (issue.title || '');
    const labels = Array.isArray(issue.labels)
        ? issue.labels.map(lbl => isRedact ? redactSecrets(lbl, `issue-${issue.number}-label`, options) : lbl)
        : [];

    const cleanedBody = sanitizeIssueText(issue.body, options, `issue-${issue.number}-body`);
    const allRefs = new Set(extractIssueReferences(issue.body, issue.number));

    const keptComments = [];
    if (commentScope !== 'none' && Array.isArray(rawComments)) {
        for (const c of rawComments) {
            if (filterBots && isBotUser(c.author, c.authorType)) continue;

            if (commentScope === 'maintainers') {
                const isAuthor = c.author === issue.author;
                const isMaintainer = AUTHORITATIVE_ROLES.has(c.authorAssociation);
                if (!isAuthor && !isMaintainer) continue;
            }

            if (filterNoise && isLowSignalComment(c.body)) continue;

            const cleanedCommentBody = sanitizeIssueText(c.body, options, `issue-${issue.number}-comment-${c.id}`);
            if (!cleanedCommentBody) continue;

            for (const r of extractIssueReferences(c.body, issue.number)) {
                allRefs.add(r);
            }

            keptComments.push({
                author: c.author,
                role: c.authorAssociation || 'NONE',
                createdAt: c.createdAt,
                reactionsPlusOne: c.reactionsPlusOne || 0,
                body: cleanedCommentBody
            });
        }
    }

    let relatedList = Array.from(allRefs).sort((a, b) => a - b);
    if (knownNumbers && knownNumbers instanceof Set) {
        relatedList = relatedList.filter(n => knownNumbers.has(n));
    }

    return {
        ...issue,
        title,
        labels,
        cleanedBody,
        relatedIssues: relatedList,
        cleanedComments: keptComments
    };
}
