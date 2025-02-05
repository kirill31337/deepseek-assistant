import * as vscode from 'vscode';
import * as path from 'path';
import axios, { AxiosError } from 'axios';
import { marked } from 'marked';
import { sanitizeMarkdownText } from './utils/textSanitizer';
import hljs from 'highlight.js';
const MAX_HISTORY_LENGTH = 200;


const debounce = (fn: Function, delay: number) => { 
    let timeout: NodeJS.Timeout; 
    return (...args: any[]) => { 
        clearTimeout(timeout); 
        timeout = setTimeout(() => fn(...args), delay); 
    }; 
};


const delayedFileUpdate = debounce((webview: vscode.Webview) => {
    sendFileUpdates(webview);
}, 500);

function sendFileUpdates(webview: vscode.Webview) {
    const filesToShow = [
        ...(currentFileContext ? [normalizePath(currentFileContext)] : []),
        ...projectFiles.map(f => normalizePath(f))
            .filter(f => f !== normalizePath(currentFileContext || ''))
    ];
    webview.postMessage({
        command: 'updateFiles',
        files: filesToShow
    });
}
function normalizePath(filePath: string): string {
    return path.normalize(filePath).replace(/\\/g, '/');
}

interface DeepSeekMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface DeepSeekRequest {
    model: string;
    messages: DeepSeekMessage[];
    max_tokens?: number;
    stream?: boolean;
}

let conversationHistory: DeepSeekMessage[] = [];
let currentStream: AbortController | undefined;
let currentAssistantContent = '';
let projectFiles: string[] = [];
let currentFileContext: string | undefined;
let panel: vscode.WebviewPanel | undefined;
let savedState: ExtensionState = {
    isReasoningExpanded: false,
    conversationHistory: [],
    projectFiles: [],
    currentFileContext: undefined,
    chatHeight: 0,
    inputHeight: 0
};
async function updateSystemContext() {
    if (currentFileContext) {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(currentFileContext));
        } catch {
            currentFileContext = undefined;
        }
    }

    const codeContext = await buildCodeContext(currentFileContext, projectFiles);

    conversationHistory = [
        {
            role: 'system',
            content: `You are an expert programming assistant. Follow these rules:
            1. Provide concise, professional answers
            2. Always format code blocks with syntax highlighting
            3. Always answer in language of user
            4. Current code context:\n${codeContext}`
        },
        ...conversationHistory.filter(m => m.role !== 'system')
    ];
}

async function buildCodeContext(currentFile: string | undefined, projectFiles: string[]): Promise<string> {
    let codeContext = '';
    
    if (currentFile) {
        try {
            const normalizedCurrent = normalizePath(currentFile);
            const doc = await vscode.workspace.openTextDocument(normalizedCurrent);
            codeContext += `Current File: ${normalizedCurrent}\n\`\`\`${doc.languageId}\n${doc.getText()}\n\`\`\`\n\n`;
        } catch (error) {
            console.error('Error reading current file:', error);
        }
    }

    for (const filePath of projectFiles.filter(f => normalizePath(f) !== normalizePath(currentFile || ''))) {
        try {
            const normalizedPath = normalizePath(filePath);
            const doc = await vscode.workspace.openTextDocument(normalizedPath);
            codeContext += `Project File: ${normalizedPath}\n\`\`\`${doc.languageId}\n${sanitizeMarkdownText(doc.getText())}\n\`\`\`\n\n`;
        } catch (error) {
            console.error('Error reading project file:', error);
        }
    }

    return codeContext;
}




function getOrCreatePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
    if (panel) {
        return panel;
    }
    return createWebviewPanel(context);
}

function createWebviewPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
    
    panel = vscode.window.createWebviewPanel(
        'deepseekChat',
        'DeepSeek Assistant Pro',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [context.extensionUri]
        }
    );

    panel.webview.html = getWebviewContentForView(context, panel.webview);
    delayedFileUpdate(panel.webview);
    panel.webview.onDidReceiveMessage(async message => {
        switch (message.command) {
            case 'sendMessage':
                if (panel) {
                    await handleUserMessage(message.text, panel.webview, context);
                }
                break;
            case 'clearHistory':
                conversationHistory = [];
                projectFiles = [];
                await updateSystemContext();
                if (panel) {
                    panel.webview.postMessage({ command: 'clearHistory' });
                    delayedFileUpdate(panel.webview);
                }
                break;
            case 'addFiles':
                if (panel) {
                    await handleAddFiles(panel.webview, context);
                }
                break;
            case 'abortRequest':
                currentStream?.abort();
                currentStream = undefined;
                break;
            case 'removeFile':
                projectFiles = projectFiles.filter(f => f !== message.file);
                if (currentFileContext === message.file) {
                    currentFileContext = undefined;
                }
                await updateSystemContext();
                if (panel) {
                    delayedFileUpdate(panel.webview);
                }
                await saveState(context);
                break;
            case 'saveState':
                if (message.chatHeight !== undefined) savedState.chatHeight = message.chatHeight;
                if (message.inputHeight !== undefined) savedState.inputHeight = message.inputHeight;
                if (message.isReasoningExpanded !== undefined) {
                    savedState.isReasoningExpanded = message.isReasoningExpanded;
                }
                savedState.conversationHistory = conversationHistory;
                savedState.projectFiles = projectFiles;
                savedState.currentFileContext = currentFileContext;
                await context.workspaceState.update('chatState', savedState);
                break;
            case 'copyToClipboard':
                await vscode.env.clipboard.writeText(message.text);
                break;
        }
    });

    panel.onDidDispose(() => {
        panel = undefined;
        conversationHistory = [];
        projectFiles = [];
    });

    return panel;
}

async function handleAddFiles(webview: vscode.Webview, context: vscode.ExtensionContext) {
    const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Add to Context'
    });

    if (uris?.length) {
        const newFiles = uris
            .map(uri => normalizePath(uri.fsPath))
            .filter(f => 
                f !== normalizePath(currentFileContext || '') && 
                !projectFiles.some(pf => normalizePath(pf) === f)
            );
            
        projectFiles.push(...newFiles);
        await updateSystemContext();
        delayedFileUpdate(webview);
    }
}

async function handleStreamingRequest(request: DeepSeekRequest, webview: vscode.Webview, context: vscode.ExtensionContext) {
    request.model = "deepseek-reasoner";
    let buffer = '';
    let timeoutId: NodeJS.Timeout | undefined;
    let dataReceived = false;
    try {
        const config = vscode.workspace.getConfiguration('deepseekAssistant');
        timeoutId = setTimeout(() => {
            if (!dataReceived) {
                currentStream?.abort();
                webview.postMessage({ command: 'endLoading' });
                vscode.window.showErrorMessage('Request timed out. Please try again.');
            }
        }, 20000);
        const response = await axios.post(
            config.get('endpoint', 'https://api.deepseek.com/v1/chat/completions'),
            request,
            {
                responseType: 'stream',
                headers: {
                    Authorization: `Bearer ${config.get('apiKey')}`,
                    'Content-Type': 'application/json'
                },
                signal: currentStream?.signal
            }
        );

        response.data.on('data', (chunk: Buffer) => {
            try {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                const parseStreamData = (data: string) => {
                    try {
                        return JSON.parse(data);
                    } catch (e) {
                        webview.postMessage({ command: 'endLoading' });
                        console.error('Stream processing error:', e);
                    }
                };
                for (let i = 0; i < lines.length - 1; i++) {
                    const line = lines[i].trim();
                    if (line === 'data: [DONE]') {
                        webview.postMessage({ command: 'endLoading' });
                        continue;
                    }
                    
                    if (line.startsWith('data: ')) {
                        clearTimeout(timeoutId);
                        const data = parseStreamData(line.slice(6));
                        if (!data) continue;
                        const contentChunk = data.choices[0]?.delta?.content || '';
                        const reasoningChunk = data.choices[0]?.delta?.reasoning_content || '';
                        
                        if (contentChunk || reasoningChunk) {
                            currentAssistantContent += contentChunk;
                            webview.postMessage({
                                command: 'streamResponse',
                                text: contentChunk,
                                reasoning: reasoningChunk,
                                isFinal: false
                            });
                        }
                    }
                }
                buffer = lines[lines.length - 1];
            } catch (e) {
                webview.postMessage({ command: 'endLoading' }); 
                console.error('Stream processing error:', e);
            }
        });

        response.data.on('end', () => {
            clearTimeout(timeoutId);
            webview.postMessage({
                command: 'streamResponse',
                text: '',
                reasoning: '',
                isFinal: true
            });
            setTimeout(async () => {
                conversationHistory.push({ 
                    role: 'assistant', 
                    content: currentAssistantContent 
                });
                await saveState(context);
            }, 500);
        });

        response.data.on('error', (error: Error) => {
            console.error('Stream error:', error);
            webview.postMessage({ command: 'endLoading' }); 
            handleError(error);
        });

    } catch (error) {
        clearTimeout(timeoutId);
        if (!axios.isCancel(error)) {
            webview.postMessage({ command: 'endLoading' });
            handleError(error);
        }
    }
}

function handleError(error: unknown) {
    if (axios.isAxiosError(error)) {
        let message = error.response?.data?.error?.message || error.message;
        if (error.config?.headers?.Authorization) {
            message = message.replace(error.config.headers.Authorization, '***');
        }
        vscode.window.showErrorMessage(`DeepSeek API Error: ${message}`);
    } else if (error instanceof Error) {
        vscode.window.showErrorMessage(`Extension Error: ${error.message}`);
    } else {
        vscode.window.showErrorMessage('Unknown error occurred');
    }
}

async function saveState(context: vscode.ExtensionContext) {
    if (conversationHistory.length > MAX_HISTORY_LENGTH) {
        conversationHistory = [
            conversationHistory[0], 
            ...conversationHistory.slice(-MAX_HISTORY_LENGTH + 1)
        ];
    }
    
    savedState = {
        conversationHistory,
        projectFiles: projectFiles.slice(-50),
        currentFileContext,
        isReasoningExpanded: savedState.isReasoningExpanded,
        chatHeight: savedState.chatHeight,
        inputHeight: savedState.inputHeight
    };

    await context.workspaceState.update('chatState', savedState);
}

async function handleUserMessage(text: string, webview: vscode.Webview, context: vscode.ExtensionContext) {
    try {
        webview.postMessage({ command: 'startLoading' });
        const config = vscode.workspace.getConfiguration('deepseekAssistant');
        await updateSystemContext();
        if (conversationHistory.length > 0) {
            const lastMessage = conversationHistory[conversationHistory.length - 1];
            if (lastMessage.role === 'user') {
                conversationHistory.pop();
            }
        }
        conversationHistory.push({ role: 'user', content: text });

        const request: DeepSeekRequest = {
            model: "deepseek-reasoner",
            messages: conversationHistory,
            max_tokens: config.get('maxTokens', 2000),
            stream: true,
        };

        currentStream = new AbortController();
        currentAssistantContent = '';
        await handleStreamingRequest(request, webview, context);
    } catch (error) {
        handleError(error);
        webview.postMessage({ command: 'endLoading' });
    } finally {
        currentStream = undefined;
        await saveState(context);
    }
}

class DeepSeekViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    public getWebview(): vscode.Webview | undefined {
        return this._view?.webview;
    }
    private readonly context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.refreshWebviewState(webviewView.webview);
            }
        });
        this.updateFiles([
            ...(currentFileContext ? [currentFileContext] : []),
            ...projectFiles.filter(f => f !== currentFileContext)
        ]);
        webviewView.webview.html = getWebviewContentForView(this.context, webviewView.webview);
        webviewView.webview.postMessage({
            command: 'loadHistory',
            history: conversationHistory.filter(m => 
                m.role !== 'system' && 
                conversationHistory.findIndex(msg => 
                    msg.content === m.content
                ) === conversationHistory.indexOf(m)
            )
        });

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'openSettings':
                    vscode.commands.executeCommand('deepseek-assistant.openSettings');
                    break;
                case 'sendMessage':
                    await handleUserMessage(message.text, webviewView.webview, this.context);
                    break;
                case 'saveState':
                    savedState = {
                        ...savedState,
                        isReasoningExpanded: message.isReasoningExpanded,
                        chatHeight: message.chatHeight,
                        inputHeight: message.inputHeight
                    };
                    await this.context.workspaceState.update('chatState', savedState);
                    break;
                case 'clearHistory':
                    conversationHistory = [];
                    projectFiles = currentFileContext ? [currentFileContext] : [];
                    await updateSystemContext();
                    webviewView.webview.postMessage({ command: 'clearHistory' });
                    webviewView.webview.postMessage({ 
                        command: 'updateFiles',
                        files: projectFiles
                    });
                    await saveState(this.context);
                    break;
                case 'addFiles':
                    await handleAddFiles(webviewView.webview, this.context);
                    break;
                case 'abortRequest':
                    currentStream?.abort();
                    currentStream = undefined;
                    break;
                case 'removeFile':
                    const normalizedFileToRemove = normalizePath(message.file);
                    projectFiles = projectFiles.filter(f => normalizePath(f) !== normalizedFileToRemove);
                    if (currentFileContext && normalizePath(currentFileContext) === normalizedFileToRemove) {
                        currentFileContext = undefined;
                    }
                    await updateSystemContext();
                    if (this._view?.visible) {
                        this.refreshWebviewState(this._view.webview);
                    }
                    await saveState(this.context);
                    break;
                case 'copyToClipboard':
                    try {
                        await vscode.env.clipboard.writeText(message.text);
                        webviewView.webview.postMessage({
                            command: 'copySuccess'
                        });
                    } catch (err) {
                        console.error('Failed to copy to clipboard:', err);
                        webviewView.webview.postMessage({
                            command: 'copyError'
                        });
                    }
                    break;
        }
        });
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const initialFilePath = normalizePath(editor.document.uri.fsPath);
            currentFileContext = initialFilePath;
            const filesToShow = [
                currentFileContext,
                ...projectFiles.filter(f => f !== currentFileContext)
            ];
            this.updateFiles(filesToShow);
        }
    }

    public updateApiKey(apiKey: string) {
        if (this._view) {
            this._view.webview.postMessage({ command: 'updateApiKey', apiKey });
        }
    }

    public updateFiles(files: string[]) {
        if (this._view) {
            this._view.webview.postMessage({
                command: 'updateFiles',
                files: files
            });
        }
    }
    private refreshWebviewState(webview: vscode.Webview) {
        if (!webview) return;
    
        const filesToShow = [
            ...(currentFileContext ? [currentFileContext] : []),
            ...projectFiles.filter(f => f !== currentFileContext)
        ];
        delayedFileUpdate(this._view?.webview!);
        webview.postMessage({
            command: 'loadHistory',
            history: conversationHistory.filter(m => 
                m.role !== 'system' && 
                conversationHistory.findIndex(msg => 
                    msg.content === m.content
                ) === conversationHistory.indexOf(m)
            )
        });

        const config = vscode.workspace.getConfiguration('deepseekAssistant');
        webview.postMessage({
            command: 'updateApiKey',
            apiKey: config.get('apiKey', '')
        });
        webview.postMessage({
            command: 'restoreState',
            state: {
                isReasoningExpanded: savedState.isReasoningExpanded,
                chatHeight: savedState.chatHeight,
                inputHeight: savedState.inputHeight
            }
        });
    }
}

let viewProvider: DeepSeekViewProvider;
export async function activate(context: vscode.ExtensionContext) {
    viewProvider = new DeepSeekViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'deepseek-assistant-view',
            viewProvider
        )
    );
    const savedState = context.workspaceState.get<ExtensionState>('chatState');
    if (savedState) {
        conversationHistory = savedState.conversationHistory;
        currentFileContext = savedState.currentFileContext;
        if (currentFileContext) {
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(currentFileContext));
            } catch {
                currentFileContext = undefined;
            }
        }
        projectFiles = savedState.projectFiles.map(f => normalizePath(f)).filter(async f => {
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(f));
                return true;
            } catch {
                return false;
            }
        });
        conversationHistory = savedState.conversationHistory.filter((msg, index, self) =>
            index === self.findIndex(m => 
                m.role === msg.role && 
                m.content === msg.content &&
                msg.content !== ''
            )
        );
        viewProvider.updateFiles([...projectFiles]);
        panel?.webview.postMessage({
            command: 'loadHistory',
            history: conversationHistory.filter(m => m.role !== 'system')
        });
        panel?.webview.postMessage({
            command: 'restoreState',
            state: {
                isReasoningExpanded: savedState.isReasoningExpanded,
                chatHeight: savedState.chatHeight,
                inputHeight: savedState.inputHeight
            }
        });
    }
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            const savedPath = normalizePath(doc.uri.fsPath);
            
            if (projectFiles.includes(savedPath) || savedPath === currentFileContext) {
                await updateSystemContext();
                sendFileUpdates(panel?.webview!);
            }
        })
    );
    
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(e => {
            if (e.active ) {
                if (panel) {
                    panel.webview.postMessage({
                        command: 'loadHistory',
                        history: conversationHistory.filter(m => m.role !== 'system')
                    });
                    
                }
            }
        })
    );
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async editor => {
            if (!editor) return;
            currentFileContext = normalizePath(editor.document.uri.fsPath);
            await updateSystemContext();
            const filesToShow = [
                currentFileContext,
                ...projectFiles.filter(f => f !== currentFileContext)
            ];
            viewProvider.updateFiles(filesToShow);
            await saveState(context); 
        })
    );

    const registerCommand = vscode.commands.registerCommand(
        'deepseek-assistant.openChat',
        async () => {
            const config = vscode.workspace.getConfiguration('deepseekAssistant');
            const apiKey = config.get('apiKey', '');
            const isValid = await isApiKeyValid(apiKey);
            if (!isValid) {
                vscode.window.showErrorMessage('Invalid DeepSeek API Key. Please update your settings.');
                return;
            }
            if (!panel) {
                panel = createWebviewPanel(context);
                await updateSystemContext();
            }
            panel.reveal(vscode.ViewColumn.Beside);
        }
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-assistant.addFiles', async () => {
            const webview = viewProvider.getWebview();
            if (webview) {
                await handleAddFiles(webview, context);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-assistant.clearHistory', async () => {
            const webview = viewProvider.getWebview();
            if (webview) {
                webview.postMessage({ command: 'clearHistory' });
                conversationHistory = [];
                projectFiles = currentFileContext ? [currentFileContext] : [];
                await updateSystemContext();
                await saveState(context);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-assistant.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'deepseekAssistant');
        })
    );
    
    context.subscriptions.push(registerCommand);
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async event => {
            if (event.affectsConfiguration('editor.tokenColorCustomizations') ||
                event.affectsConfiguration('workbench.colorCustomizations')) {
                if (panel) {
                    updateWebviewStyles(panel.webview);
                }
            }
            if (event.affectsConfiguration('deepseekAssistant.apiKey')) {
                const config = vscode.workspace.getConfiguration('deepseekAssistant');
                const apiKey = config.get('apiKey', '');
                const isValid = await isApiKeyValid(apiKey);
                if (isValid) {
                    viewProvider.updateApiKey(apiKey);
                } else {
                    vscode.window.showErrorMessage('Invalid DeepSeek API Key. Please update your settings.');
                }
            }
        })
    );

    if (panel) {
        updateWebviewStyles(panel.webview);
    }
}

async function isApiKeyValid(apiKey: string): Promise<boolean> {
    try {
        const response = await axios.get(
            'https://api.deepseek.com/user/balance',
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.status === 200 && response.data.is_available === true;
    } catch (error) {
        return false;
    }
}

function generateSyntaxHighlightingCSS(): string {
    const tokenColors = vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations.textMateRules', []);
    const workbenchColors = vscode.workspace.getConfiguration('workbench').get('colorCustomizations', {});
    const editorConfig = vscode.workspace.getConfiguration('editor');
    const fontSize = editorConfig.get('fontSize', 14);
    
    let css = `
        pre code {
            font-family: var(--vscode-editor-font-family) !important;
            font-size: ${fontSize}px !important;
            line-height: 1.4 !important;
        }
        .hljs {
            background: var(--vscode-editor-background) !important;
            color: var(--vscode-editor-foreground) !important;
        }
        /* Базовые токены */
        .hljs-keyword { color: var(--vscode-symbolIcon-keywordForeground) !important; }
        .hljs-built_in { color: var(--vscode-symbolIcon-keywordForeground) !important; }
        .hljs-type { color: var(--vscode-symbolIcon-typeParameterForeground) !important; }
        .hljs-literal { color: var(--vscode-debugTokenExpression-boolean) !important; }
        .hljs-number { color: var(--vscode-debugTokenExpression-number) !important; }
        .hljs-string { color: var(--vscode-debugTokenExpression-string) !important; }
        .hljs-regexp { color: var(--vscode-debugTokenExpression-string) !important; }
        
        /* Комментарии и документация */
        .hljs-comment { color: var(--vscode-editorLineNumber-foreground) !important; }
        .hljs-doctag { color: var(--vscode-editorLineNumber-foreground) !important; }
        
        /* Функции и классы */
        .hljs-function { color: var(--vscode-symbolIcon-functionForeground) !important; }
        .hljs-class { color: var(--vscode-symbolIcon-classForeground) !important; }
        .hljs-title { color: var(--vscode-symbolIcon-functionForeground) !important; }
        .hljs-title.class_ { color: var(--vscode-symbolIcon-classForeground) !important; }
        .hljs-title.function_ { color: var(--vscode-symbolIcon-functionForeground) !important; }
        
        /* Переменные и параметры */
        .hljs-variable { color: var(--vscode-symbolIcon-variableForeground) !important; }
        .hljs-params { color: var(--vscode-symbolIcon-parameterForeground) !important; }
        .hljs-attr { color: var(--vscode-symbolIcon-propertyForeground) !important; }
        .hljs-property { color: var(--vscode-symbolIcon-propertyForeground) !important; }
        
        /* Операторы и пунктуация */
        .hljs-operator { color: var(--vscode-symbolIcon-operatorForeground) !important; }
        .hljs-punctuation { color: var(--vscode-editor-foreground) !important; }
        
        /* Импорты и модули */
        .hljs-meta { color: var(--vscode-symbolIcon-moduleForeground) !important; }
        .hljs-meta-keyword { color: var(--vscode-symbolIcon-keywordForeground) !important; }
        .hljs-meta-string { color: var(--vscode-debugTokenExpression-string) !important; }
        
        /* Специальные токены */
        .hljs-emphasis { font-style: italic !important; }
        .hljs-strong { font-weight: bold !important; }
        .hljs-link { color: var(--vscode-textLink-foreground) !important; }
        .hljs-quote { color: var(--vscode-editorLineNumber-foreground) !important; }
        .hljs-template-tag { color: var(--vscode-symbolIcon-snippetForeground) !important; }
        .hljs-template-variable { color: var(--vscode-symbolIcon-variableForeground) !important; }
        .hljs-addition { color: var(--vscode-gitDecoration-addedResourceForeground) !important; }
        .hljs-deletion { color: var(--vscode-gitDecoration-deletedResourceForeground) !important; }
    `;

    tokenColors.forEach((rule: any) => {
        if (rule.scope && rule.settings.foreground) {
            css += `
                .hljs-${rule.scope.replace(/\./g, '-')} {
                    color: ${rule.settings.foreground};
                }
            `;
        }
    });

    return css;
}

function updateWebviewStyles(webview: vscode.Webview) {
    const css = generateSyntaxHighlightingCSS();
    webview.postMessage({ 
        command: 'updateStyles', 
        styles: css 
    });
}

function getWebviewContentForView(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const stylesUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'styles.css')
    );

    const savedState = context.workspaceState.get<ExtensionState>('chatState');
    const isReasoningExpanded = savedState?.isReasoningExpanded || false;
    const chatHeight = savedState?.chatHeight || 400;
    const inputHeight = savedState?.inputHeight || 120;
    const syntaxHighlightingCSS = generateSyntaxHighlightingCSS();
    const config = vscode.workspace.getConfiguration('deepseekAssistant');
    const apiKey = config.get('apiKey', '');

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="${stylesUri}" rel="stylesheet">
            <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/highlight.min.js"></script>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/styles/github.min.css">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
            <style>
                ${syntaxHighlightingCSS}
            </style>
        </head>
        <body>
            <div id="context-files" class="context-files"></div>
            <div id="chat"></div>
            <div class="resizer" id="chatResizer"></div>
            <div class="input-container">
                <div class="textarea-wrapper">
                    <textarea id="input" placeholder="${apiKey ? 'Type your message...' : 'API key is not configured. Please set it in settings.'}" ${apiKey ? '' : 'disabled'}></textarea>
                    <span class="enter-label">Enter ↵</span>
                </div>
                <button class="toggle-button" onclick="toggleReasoning()">
                    Reasoning
                    <span class="arrow up">▲</span>
                </button>
                <div id="reasoning-panel" class="reasoning-panel hidden"></div>
            </div>

            <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
            <script>
                const vscode = acquireVsCodeApi();
                const chat = document.getElementById('chat');
                const input = document.getElementById('input');
                let isStreaming = false;
                let currentAssistantMessage = null;
                let reasoningBuffer = '';
                let responseBuffer = '';

                document.querySelector('.enter-label').addEventListener('click', () => {
                    sendMessage();
                });
                marked.setOptions({
                    highlight: (code, lang) => {
                        if (lang && hljs.getLanguage(lang)) {
                            return hljs.highlight(code, { language: lang }).value;
                        }
                    }
                });

                window.addEventListener('message', event => {
                    switch (event.data.command) {
                        case 'saveState':
                            savedState = {
                                ...savedState,
                                isReasoningExpanded: message.isReasoningExpanded,
                                chatHeight: message.chatHeight,
                                inputHeight: message.inputHeight
                            };
                            vscode.setState(savedState);
                            break;
                        case 'streamResponse':
                            handleStream(event.data);
                            break;
                        case 'receiveResponse':
                            updateReasoningContent(event.data.reasoning || '');
                            addMessage('assistant', event.data.text);
                            break;
                        case 'showStatus':
                            document.getElementById('status').textContent = event.data.text;
                            setTimeout(() => document.getElementById('status').textContent = '', 3000);
                            break;
                        case 'clearHistory':
                            chat.innerHTML = '';
                            document.getElementById('reasoning-content').innerHTML = '';
                            break;
                        case 'copyToClipboard':
                            navigator.clipboard.writeText(event.data.text)
                                .catch(err => console.error('Failed to copy:', err));
                            break;
                        case 'copySuccess':
                            const button = document.querySelector('.copy-button:hover');
                            if (button) {
                                button.textContent = 'Copied!';
                                button.classList.add('success');
                                setTimeout(() => {
                                    button.textContent = 'Copy';
                                    button.classList.remove('success');
                                }, 2000);
                            }
                            break;
                            
                        case 'copyError':
                            const errorButton = document.querySelector('.copy-button:hover');
                            if (errorButton) {
                                errorButton.textContent = 'Error';
                                setTimeout(() => {
                                    errorButton.textContent = 'Copy';
                                }, 2000);
                            }
                            break;
                        case 'updateFiles':
                            console.log('updateFiles 865:', 'YES');
                            contextFiles = event.data.files || [];
                            updateContextFiles();
                            break;
                        case 'updateApiKey':
                            apiKey = event.data.apiKey;
                            input.placeholder = 'Type your message...';
                            input.disabled = false;
                            break;
                        case 'loadHistory':
                            event.data.history.forEach(msg => {
                                if (msg.role !== 'system') {
                                    addMessage(msg.role, msg.content);
                                }
                            });
                            document.querySelectorAll('pre').forEach(pre => {
                                pre.style.position = 'relative';
                                if (!pre.querySelector('.copy-button')) {
                                    const button = document.createElement('button');
                                    button.className = 'copy-button';
                                    button.textContent = 'Copy';
                                    button.style.position = 'absolute';
                                    button.style.top = '8px';
                                    button.style.right = '8px';
                                    button.onclick = async (e) => {
                                        const code = pre.querySelector('code')?.innerText || '';
                                        try {
                                            await vscode.postMessage({ 
                                                command: 'copyToClipboard', 
                                                text: code 
                                            });
                                            button.textContent = 'Copied!';
                                            button.classList.add('success');
                                            setTimeout(() => {
                                                button.textContent = 'Copy';
                                                button.classList.remove('success');
                                            }, 2000);
                                        } catch (err) {
                                            console.error('Failed to copy code:', err);
                                            button.textContent = 'Error';
                                            setTimeout(() => {
                                                button.textContent = 'Copy';
                                            }, 2000);
                                        }
                                    };
                                    pre.insertBefore(button, pre.firstChild);
                                }
                            });
                            hljs.highlightAll();
                            break;
                        case 'startLoading':
                            input.disabled = true;
                            const loadingDiv = document.createElement('div');
                            loadingDiv.className = 'loading-dots';
                            loadingDiv.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
                            chat.appendChild(loadingDiv);
                            chat.scrollTop = chat.scrollHeight;
                            break;
                        case 'endLoading':
                            input.disabled = false;
                            const loadingElements = document.getElementsByClassName('loading-dots');
                            if (loadingElements.length > 0) {
                                loadingElements[0].remove();
                            }
                            break;
                        case 'updateStyles':
                            const styleElement = document.createElement('style');
                            styleElement.textContent = event.data.styles;
                            document.head.appendChild(styleElement);
                            break;
                    }
                });

                function handleStream(data) {
                    if (!isStreaming && data.text) {
                        isStreaming = true;
                        currentAssistantMessage = addMessage('assistant', '');
                    }
                    
                    if (data.text) {
                        responseBuffer += data.text;
                        updateCurrentMessage(responseBuffer);
                    }

                    if (data.reasoning) {
                        reasoningBuffer += data.reasoning;
                        updateReasoningContent(reasoningBuffer);
                        const reasoningPanel = document.getElementById('reasoning-panel');
                        if (reasoningPanel) {
                            reasoningPanel.scrollTo({
                                top: reasoningPanel.scrollHeight,
                                behavior: 'smooth'
                            });
                        }
                    }

                    if (data.isFinal) {
                        isStreaming = false;
                        responseBuffer = '';
                        reasoningBuffer = '';
                        currentAssistantMessage = null;
                        hljs.highlightAll();
                    }
                }

                function updateReasoningContent(content) {
                    const reasoningPanel = document.getElementById('reasoning-panel');
                    if (content && reasoningPanel) {
                        reasoningPanel.innerHTML = marked.parse(content);
                        hljs.highlightAll();
                    }
                }

                function addMessage(role, text) {
                    const div = document.createElement('div');
                    div.className = 'message ' + role + '-message';
                    div.innerHTML = 
                        '<div class="code-header">' +
                            '<span>' + role.charAt(0).toUpperCase() + role.slice(1) + '</span>' +
                            '<span>' + new Date().toLocaleTimeString() + '</span>' +
                        '</div>' +
                        '<div class="content">' + marked.parse(text) + '</div>';
                    
                    chat.appendChild(div);
                    chat.scrollTop = chat.scrollHeight;
                    return div;
                }

                function updateCurrentMessage(text) {
                    if (currentAssistantMessage) {
                        const contentDiv = currentAssistantMessage.querySelector('.content');
                        if (contentDiv) {
                            contentDiv.innerHTML = marked.parse(text);
                            
                            contentDiv.querySelectorAll('pre').forEach(pre => {
                                pre.style.position = 'relative';
                                if (!pre.querySelector('.copy-button')) {
                                    const button = document.createElement('button');
                                    button.className = 'copy-button';
                                    button.textContent = 'Copy';
                                    button.style.position = 'absolute';
                                    button.style.top = '8px';
                                    button.style.right = '8px';
                                    button.onclick = async (e) => {
                                    const code = pre.querySelector('code')?.innerText || '';
                                    try {
                                        await vscode.postMessage({ 
                                            command: 'copyToClipboard', 
                                            text: code 
                                        });
                                        button.textContent = 'Copied!';
                                        button.classList.add('success');
                                        setTimeout(() => {
                                            button.textContent = 'Copy';
                                            button.classList.remove('success');
                                        }, 2000);
                                    } catch (err) {
                                        console.error('Failed to copy code:', err);
                                        button.textContent = 'Error';
                                        setTimeout(() => {
                                            button.textContent = 'Copy';
                                        }, 2000);
                                    }
                                };
                                    pre.insertBefore(button, pre.firstChild);
                                }
                            });
                            
                            hljs.highlightAll();
                            chat.scrollTop = chat.scrollHeight;
                        }
                    }
                }

                function sendMessage() {
                    const text = input.value.trim();
                    if (text) {
                        reasoningBuffer = '';
                        document.getElementById('reasoning-panel').innerHTML = '';
                        addMessage('user', text);
                        vscode.postMessage({ command: 'sendMessage', text });
                        input.value = '';
                    }
                }

                function addFiles() {
                    vscode.postMessage({ command: 'addFiles' });
                }

                function clearHistory() {
                    vscode.postMessage({ command: 'clearHistory' });
                }

                function abortRequest() {
                    vscode.postMessage({ command: 'abortRequest' });
                }

                function toggleReasoning() {
                    const reasoningPanel = document.getElementById('reasoning-panel');
                    const arrow = document.querySelector('.toggle-button .arrow');
                    const isExpanded = reasoningPanel.classList.contains('hidden');
                    
                    if (isExpanded) {
                        reasoningPanel.classList.remove('hidden');
                        reasoningPanel.classList.add('visible');
                        arrow.classList.remove('up');
                        arrow.classList.add('down');
                    } else {
                        reasoningPanel.classList.remove('visible');
                        reasoningPanel.classList.add('hidden');
                        arrow.classList.remove('down');
                        arrow.classList.add('up');
                    }
                    
                    vscode.postMessage({ 
                        command: 'saveState',
                        isReasoningExpanded: isExpanded,
                        chatHeight: document.getElementById('chat').offsetHeight,
                        inputHeight: document.getElementById('input').offsetHeight
                    });
                }

                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                    }
                });

                let contextFiles = [];

                function updateContextFiles() {
                    console.log('updateFiles 1045:', 'YES');
                    const container = document.getElementById('context-files');
                    if (!container) {
                        console.warn('Context files container not found');
                        return;
                    }
                    container.innerHTML = '';

                    if (contextFiles.length === 0) {
                        return;
                    }

                    contextFiles.forEach((file, index) => {
                        const fileEl = document.createElement('div');
                        const fileSpan = document.createElement('span');
                        const removeSpan = document.createElement('span');

                        fileEl.className = 'context-file';
                        fileSpan.textContent = getFileName(file);
                        fileSpan.title = file;

                        removeSpan.className = 'remove';
                        removeSpan.textContent = '×';
                        removeSpan.onclick = () => removeFile(file);

  
                        if (index === 0) {
                            fileEl.classList.add('current-file');
                        }

                        fileEl.appendChild(fileSpan);
                        fileEl.appendChild(removeSpan);

                        container.appendChild(fileEl);
                    });
                }

                function getFileName(path) {
                    return path.split(/[\\/]/).pop() || path;
                }

                function removeFile(file) {
                    contextFiles = contextFiles.filter(f => f !== file);
                    updateContextFiles();
                    vscode.postMessage({ command: 'removeFile', file });
                }

                document.addEventListener('DOMContentLoaded', () => {
                    hljs.highlightAll();
                    const reasoningPanel = document.getElementById('reasoning-panel');
                    const arrow = document.querySelector('.toggle-button .arrow');
                    const state = vscode.getState();
                    if (${isReasoningExpanded}) {
                        reasoningPanel.classList.remove('hidden');
                        reasoningPanel.classList.add('visible');
                        arrow.classList.remove('up');
                        arrow.classList.add('down');
                    }

                    const chat = document.getElementById('chat');
                    const input = document.getElementById('input');
                    if (${savedState?.isReasoningExpanded || true}) {
                        reasoningPanel.classList.remove('hidden');
                        reasoningPanel.classList.add('visible');
                        arrow.classList.remove('up');
                        arrow.classList.add('down');
                    }

                    if (chat) {
                        chat.style.height = '${savedState?.chatHeight || 400}px';
                    }
                    if (input) {
                        input.style.height = '${savedState?.inputHeight || 120}px';
                    }
                });
                let startY = 0;
                let initialChatHeight = 0;

                function startResize(e) {
                    isResizing = true;
                    const chat = document.getElementById('chat');
                    const panel = document.getElementById('reasoning-panel');
                    const toggleButton = document.querySelector('.toggle-button');
                    const chatRect = chat.getBoundingClientRect();
                    document.body.style.userSelect = 'none';
                    
                    const reasoningOffset = panel && !panel.classList.contains('hidden') 
                        ? panel.offsetHeight 
                        : 0;
                    const offset = chatRect.top  + reasoningOffset + toggleButton.offsetHeight;
                    startY = e.clientY - offset;
                    initialChatHeight = chat.offsetHeight;
                    document.addEventListener('mousemove', resize);
                    document.addEventListener('mouseup', stopResize);
                    document.body.style.userSelect = 'none';
                }

                function resize(e) {
                    if (!isResizing) return;
                    
                    const delta = startY - e.clientY;
                    const containerHeight = document.body.offsetHeight;
                    const minHeight = 50;
                    
                    let newChatHeight = initialChatHeight - delta;

                    
                    // Ограничения
                    newChatHeight = Math.max(minHeight, newChatHeight);
                    newChatHeight = Math.min(newChatHeight, containerHeight - 150);

                    // Вычисляем высоту инпута динамически
                    const newInputHeight = containerHeight - newChatHeight - 40;
                    
                    chat.style.height = newChatHeight + 'px';
                    input.style.height = newInputHeight + 'px';
                    vscode.postMessage({ 
                    command: 'saveState',
                        chatHeight: newChatHeight,
                        inputHeight: newInputHeight
                    });
                }

                function stopResize() {
                    isResizing = false;
                    document.body.style.userSelect = ''; 
                    document.removeEventListener('mousemove', resize);
                    document.removeEventListener('mouseup', stopResize);
                    const chat = document.getElementById('chat');
                    const input = document.getElementById('input');
                    const reasoningPanel = document.getElementById('reasoning-panel');
                    chat.style.userSelect = 'text';
                    document.querySelectorAll('.message').forEach(msg => {
                        msg.style.userSelect = 'text';
                    });
                    vscode.postMessage({ 
                        command: 'saveState',
                        chatHeight: chat.offsetHeight,
                        inputHeight: input.offsetHeight,
                        isReasoningExpanded: !reasoningPanel.classList.contains('hidden')
                    });
                }
                
                document.getElementById('chatResizer').addEventListener('mouseenter', () => {
                    document.body.style.cursor = 'row-resize';
                });

                document.getElementById('chatResizer').addEventListener('mouseleave', () => {
                    document.body.style.cursor = 'auto';
                });

                document.getElementById('chatResizer').addEventListener('mousedown', startResize);
            </script>
        </body>
        </html>
    `;
}

interface ExtensionState {
    isReasoningExpanded: boolean;
    conversationHistory: DeepSeekMessage[];
    projectFiles: string[];
    currentFileContext?: string;
    chatHeight?: number;
    inputHeight?: number;
}