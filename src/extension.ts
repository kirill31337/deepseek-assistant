import * as vscode from 'vscode';
import axios, { AxiosError } from 'axios';
import { marked } from 'marked';
import { sanitizeMarkdownText, applySyntaxHighlight } from './utils/textSanitizer';
import hljs from 'highlight.js';

interface DeepSeekResponse {
    choices: {
        message: {
            content: string;
            reasoning_content?: string;
        };
    }[];
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

export function activate(context: vscode.ExtensionContext) {
    let panel: vscode.WebviewPanel | undefined;
    let conversationHistory: DeepSeekMessage[] = [];
    let currentStream: AbortController | undefined;
    let currentAssistantContent = '';
    let projectFiles: string[] = [];

    const registerCommand = vscode.commands.registerCommand(
        'deepseek-assistant.openChat',
        async () => {
            if (!panel) {
                panel = createWebviewPanel(context);
                await updateSystemContext();
            }
            panel.reveal(vscode.ViewColumn.Beside);
        }
    );

    context.subscriptions.push(registerCommand);

    async function updateSystemContext() {
        const editor = vscode.window.activeTextEditor;
        let codeContext = '';

        if (editor) {
            const doc = editor.document;
            codeContext += `Current File: ${doc.fileName}\nLanguage: ${doc.languageId}\n\`\`\`${doc.languageId}\n${doc.getText()}\n\`\`\`\n\n`;
        }

        if (projectFiles.length > 0) {
            codeContext += "Project Files Context:\n";
            for (const filePath of projectFiles) {
                try {
                    const uri = vscode.Uri.file(filePath);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const lang = doc.languageId;
                    const content = sanitizeMarkdownText(doc.getText());
                    codeContext += `File: ${filePath}\n\`\`\`${lang}\n${content}\n\`\`\`\n\n`;
                } catch (error) {
                    console.error(`Error reading file ${filePath}:`, error);
                }
            }
        }

        conversationHistory = conversationHistory.filter(m => m.role !== 'system');
        conversationHistory.unshift({
            role: 'system',
            content: `You are an expert programming assistant. Follow these rules:
            1. Provide concise, professional answers
            2. Always format code blocks with syntax highlighting
            3. Always answer in language of user
            4. Current code context:\n${codeContext}`
        });
    }

    function createWebviewPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
        let panel: vscode.WebviewPanel | undefined;
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

        panel.webview.html = getWebviewContent(context, panel.webview);

        panel.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'sendMessage':
                    if (panel) {
                      await handleUserMessage(message.text, panel.webview);
                    }
                    break;
                case 'clearHistory':
                    conversationHistory = [];
                    projectFiles = [];
                    await updateSystemContext();
                    if (panel) {
                      panel.webview.postMessage({ command: 'clearChat' });
                    }
                    break;
                case 'addFiles':
                    if (panel) {
                      await handleAddFiles(panel.webview);
                    }
                    break;
                case 'abortRequest':
                    currentStream?.abort();
                    currentStream = undefined;
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

    async function handleAddFiles(webview: vscode.Webview) {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Add to Context',
            filters: { 'Code Files': ['*'] }
        });

        if (uris) {
            projectFiles.push(...uris.map(uri => uri.fsPath));
            await updateSystemContext();
            if (panel) {
                panel.webview.postMessage({
                    command: 'showStatus',
                    text: `Added ${uris.length} files to context`
                });
            }
        }
    }

    async function handleUserMessage(text: string, webview: vscode.Webview) {
        try {
            const config = vscode.workspace.getConfiguration('deepseekAssistant');
            conversationHistory.push({ role: 'user', content: text });

            const request: DeepSeekRequest = {
                model: config.get('model', 'deepseek-reasoner'),
                messages: conversationHistory,
                max_tokens: config.get('maxTokens', 2000),
                stream: config.get('streaming', true)
            };

            currentStream = new AbortController();
            currentAssistantContent = '';

            if (request.stream) {
                await handleStreamingRequest(request, webview);
            } else {
                await handleStandardRequest(request, webview);
            }
        } catch (error) {
            handleError(error);
        } finally {
            currentStream = undefined;
        }
    }

    async function handleStreamingRequest(request: DeepSeekRequest, webview: vscode.Webview) {
        let buffer = '';
        try {
            const config = vscode.workspace.getConfiguration('deepseekAssistant');
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
                    
                    for (let i = 0; i < lines.length - 1; i++) {
                        const line = lines[i].trim();
                        if (!line || line === 'data: [DONE]') continue;
                        
                        if (line.startsWith('data: ')) {
                            const data = JSON.parse(line.slice(6));
                            const contentChunk = data.choices[0]?.delta?.content || '';
                            const reasoningChunk = data.choices[0]?.delta?.reasoning_content || '';
                            
                            if (contentChunk || reasoningChunk) {
                                currentAssistantContent += contentChunk;
                                //console.log('Sending chunk:', { contentChunk, reasoningChunk }); // Debug log
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
                    console.error('Stream processing error:', e);
                }
            });

            response.data.on('end', () => {
                conversationHistory.push({ role: 'assistant', content: currentAssistantContent });
                webview.postMessage({
                    command: 'streamResponse',
                    text: '',
                    reasoning: '',
                    isFinal: true
                });
            });

            response.data.on('error', (error: Error) => {
                console.error('Stream error:', error);
                handleError(error);
            });

        } catch (error) {
            if (!axios.isCancel(error)) {
                handleError(error);
            }
        }
    }

    function handleError(error: unknown) {
        if (axios.isAxiosError(error)) {
            const message = error.response?.data?.error?.message || error.message;
            vscode.window.showErrorMessage(`DeepSeek API Error: ${message}`);
        } else if (error instanceof Error) {
            vscode.window.showErrorMessage(`Extension Error: ${error.message}`);
        } else {
            vscode.window.showErrorMessage('Unknown error occurred');
        }
    }

    async function handleStandardRequest(request: DeepSeekRequest, webview: vscode.Webview) {
        try {
            const config = vscode.workspace.getConfiguration('deepseekAssistant');
            const response = await axios.post<DeepSeekResponse>(
                config.get('endpoint', 'https://api.deepseek.com/v1/chat/completions'),
                request,
                {
                    headers: {
                        Authorization: `Bearer ${config.get('apiKey')}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const result = response.data.choices[0].message;
            conversationHistory.push({ role: 'assistant', content: result.content });
            
            webview.postMessage({
                command: 'receiveResponse',
                text: result.content,
                reasoning: result.reasoning_content
            });

        } catch (error) {
            handleError(error);
        }
    }
}

function getWebviewContent(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const stylesUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'styles.css')
    );
    
    const highlightJsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'highlight.min.js')
    );

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="${stylesUri}" rel="stylesheet">
            <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/highlight.min.js"></script>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/styles/github.min.css">
        </head>
        <body>
            <div class="toolbar">
                <button onclick="addFiles()">Add Files</button>
                <button onclick="clearHistory()" style="margin-left: auto">Clear</button>
            </div>
            
            <div id="chat"></div>
            <div class="input-container">
                <textarea id="input" placeholder="Type your message..."></textarea>
                <div id="reasoning-container" class="reasoning-panel">
                    <div class="reasoning-header">Chain of Thought</div>
                    <div id="reasoning-content"></div>
                </div>
                <div id="status"></div>
                <div>
                    <button onclick="sendMessage()">Send</button>
                    <button onclick="abortRequest()" id="abortBtn" style="display: none">Stop</button>
                </div>
            </div>

            <script src="${highlightJsUri}"></script>
            <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
            <script>
                const vscode = acquireVsCodeApi();
                const chat = document.getElementById('chat');
                const input = document.getElementById('input');
                let isStreaming = false;
                let currentAssistantMessage = null;
                let reasoningBuffer = '';
                let responseBuffer = '';

                marked.setOptions({
                    highlight: (code, lang) => {
                        if (lang && hljs.getLanguage(lang)) {
                            return hljs.highlight(code, { language: lang }).value;
                        }
                        return hljs.highlightAuto(code).value;
                    }
                });

                window.addEventListener('message', event => {
                    switch (event.data.command) {
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
                        case 'clearChat':
                            chat.innerHTML = '';
                            document.getElementById('reasoning-content').innerHTML = '';
                            break;
                    }
                });

                function handleStream(data) {
                    console.log('Received stream data:', data); // Debug log
                    
                    if (!isStreaming && data.text) {
                        isStreaming = true;
                        currentAssistantMessage = addMessage('assistant', '');
                        document.getElementById('abortBtn').style.display = 'inline-block';
                    }
                    
                    if (data.text) {
                        responseBuffer += data.text;
                        updateCurrentMessage(responseBuffer);
                    }

                    if (data.reasoning) {
                        reasoningBuffer += data.reasoning;
                        updateReasoningContent(reasoningBuffer);
                    }

                    if (data.isFinal) {
                        document.getElementById('abortBtn').style.display = 'none';
                        isStreaming = false;
                        responseBuffer = '';
                        reasoningBuffer = '';
                        currentAssistantMessage = null;
                        hljs.highlightAll();
                    }
                }

                function updateReasoningContent(content) {
                    const reasoningElement = document.getElementById('reasoning-content');
                    if (content && reasoningElement) {
                        reasoningElement.innerHTML = marked.parse(content);
                        hljs.highlightAll();
                        reasoningElement.scrollTop = reasoningElement.scrollHeight;
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
                            hljs.highlightAll();
                            chat.scrollTop = chat.scrollHeight;
                        }
                    }
                }

                function sendMessage() {
                    const text = input.value.trim();
                    if (text) {
                        reasoningBuffer = '';
                        document.getElementById('reasoning-content').innerHTML = '';
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

                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                    }
                });
            </script>
        </body>
        </html>
    `;
}