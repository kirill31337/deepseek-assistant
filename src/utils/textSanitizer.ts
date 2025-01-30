import hljs from 'highlight.js';

export function sanitizeMarkdownText(text: string): string {
    return text
        .replace(/(.)\x01+/g, '$1')
        .replace(/(```[\s\S]*?)(?=```|$)/g, (match, p1) => {
            const hasClosing = match.includes('```');
            return hasClosing ? match : p1 + '```';
        });
}

export function applySyntaxHighlight(element: HTMLElement) {
    element.querySelectorAll('pre code').forEach((block: Element) => {
        // Удаляем временные закрывающие теги
        const codeContent = block.textContent?.replace(/```$/, '') || '';
        block.textContent = codeContent;
        
        const language = block.className.match(/language-(\w+)/)?.[1];
        if (language && hljs.getLanguage(language)) {
            block.className = `language-${language}`;   
        }
        hljs.highlightElement(block as HTMLElement);
    });
}

