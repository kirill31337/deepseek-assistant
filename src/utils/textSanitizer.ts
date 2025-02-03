import hljs from 'highlight.js';

export function sanitizeMarkdownText(text: string): string {
    return text
        .replace(/(.)\x01+/g, '$1')
        .replace(/(```[\s\S]*?)(?=```|$)/g, (match, p1) => {
            const hasClosing = match.includes('```');
            return hasClosing ? match : p1 + '```';
        });
}


