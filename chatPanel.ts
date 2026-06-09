/**
 * Chat Panel - Interactive conversation interface with Boudica
 * Displayed in VS Code sidebar
 */

import * as vscode from 'vscode';
import { BoudicaClient, ChatRequest } from './boudicaClient';
import { SessionManager } from './sessionManager';
import * as path from 'path';
import * as fs from 'fs';
import { getStatusBarManager } from './statusBarManager';
import { isPlanningRequest, generatePlan, executePlan, ExecutionPlan, isModificationRequest } from './planExecutor';
import { ProjectScanner } from './projectScanner';
import { generateModificationPlan, executeModificationPlan } from './modificationExecutor';
import { BuildRunner } from './buildRunner';
import { ErrorParser, ParsedError } from './errorParser';
import { FixGenerator } from './fixGenerator';
import { CodeSearch } from './codeSearch';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'boudicodeChat';
    private static readonly MAX_HISTORY = 100;
    private view?: vscode.WebviewView;
    private client: BoudicaClient;
    private sessionId: string;
    private sessionManager: SessionManager;
    private conversationHistory: Array<{role: 'user' | 'assistant', content: string}> = [];
    private isCreatingFiles: boolean = false;
    private pendingCompletionMessage?: string;
    private pendingMessages: string[] = [];
    private projectScanner: ProjectScanner;
    private pendingFixes: Map<string, { fixPlan: any, errors: ParsedError[] }> = new Map();

    constructor(
        private readonly extensionUri: vscode.Uri,
        client: BoudicaClient,
        sessionManager: SessionManager
    ) {
        this.client = client;
        this.sessionId = `vscode-${Date.now()}`;
        this.sessionManager = sessionManager;
        this.projectScanner = new ProjectScanner();
    }

    /**
     * Send a message programmatically (called from external sources like native chat participant
     * or the buildAndFix command). Queues if the webview is not yet visible.
     */
    public async sendMessage(message: string): Promise<void> {
        if (!this.view) {
            // Queue for when the view becomes ready
            this.pendingMessages.push(message);
            console.log('[ChatPanel] View not ready, queued message:', message);
            return;
        }

        // Send message to webview to display in UI
        this.view.webview.postMessage({
            command: 'addMessage',
            role: 'user',
            content: message + '\n\n\ud83d\udce8 *Received from native chat*'
        });

        // Process the message through normal flow
        await this.handleSendMessage(message);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        console.log('BoudiCode: resolveWebviewView called!');
        this.view = webviewView;
        console.log('BoudiCode: Setting webview options...');

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        console.log('BoudiCode: Generating HTML content...');

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);
        console.log('BoudiCode: HTML content set, setting up message handler...');

        // Listen for webview disposal (when user closes the panel)
        webviewView.onDidDispose(() => {
            console.log('[Extension] Webview disposed');
            if (this.isCreatingFiles) {
                vscode.window.showInformationMessage(
                    '⏳ BoudiCode: File creation continues in background. Check status bar for progress.',
                    'Show Status'
                ).then(choice => {
                    if (choice === 'Show Status') {
                        vscode.commands.executeCommand('workbench.action.focusStatusBar');
                    }
                });
            }
        });

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'webviewReady':
                    // Restore conversation history when webview signals it's ready
                    console.log('[Extension] Webview ready, restoring history');
                    this.restoreConversationHistory();

                    // Show pending completion message if exists
                    if (this.pendingCompletionMessage) {
                        console.log('[Extension] Showing pending completion message');
                        this.view?.webview.postMessage({
                            command: 'addMessage',
                            role: 'assistant',
                            content: this.pendingCompletionMessage
                        });
                        this.conversationHistory.push({
                            role: 'assistant',
                            content: this.pendingCompletionMessage
                        });
                        this.pendingCompletionMessage = undefined;
                    }

                    // Process any queued messages
                    if (this.pendingMessages.length > 0) {
                        const queued = this.pendingMessages.splice(0);
                        for (const msg of queued) {
                            await this.handleSendMessage(msg);
                        }
                    }
                    break;
                case 'sendMessage':
                    await this.handleSendMessage(message.text);
                    break;
                case 'clearChat':
                    await this.handleClearChat();
                    break;
                case 'exportChat':
                    await this.handleExportChat();
                    break;
                case 'includeFile':
                    await this.handleIncludeFile();
                    break;
                case 'applyFix':
                    await this.applyFix(message.fileName);
                    break;
                case 'skipFix':
                    this.skipFix(message.fileName);
                    break;
                case 'applyAllFixes':
                    await this.applyAllFixes();
                    break;
            }
        });
    }

    /**
     * Parse response and automatically save code blocks as files
     * Returns summary message if files were saved, or null to show full response
     */
    private async handleCodeResponse(responseText: string, userPrompt?: string): Promise<string | null> {
        console.log('[Extension] handleCodeResponse called, response length:', responseText.length);
        console.log('[Extension] Response preview:', responseText.substring(0, 200));
        
        // Match code blocks with language and optional filename
        // Use a restrictive pattern for filename to avoid capturing first line of code
        const codeBlockRegex = /```(\w+)\s*([a-zA-Z0-9_\-\.]*)\s*\n([\s\S]*?)```/g;
        let match;
        const codeBlocks: Array<{ language: string; filename: string; code: string }> = [];

        // Try to extract filename from user's prompt (e.g., "create hello.py file")
        let promptFilename: string | undefined;
        if (userPrompt) {
            console.log('[Extension] Extracting filename from prompt:', userPrompt);
            
            // First priority: "called/named" patterns - most explicit
            let filenameMatch = userPrompt.match(/(?:called|named)\s+([a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+)/i);
            
            if (filenameMatch) {
                console.log('[Extension] Found "called/named" match:', filenameMatch[1]);
                const filename = filenameMatch[1];
                // Exclude URLs - check for domain extensions AND url context
                const isUrl = /\.(com|ca|org|net|io|co|uk|de|fr|jp|cn|edu|gov)$/i.test(filename) ||
                              userPrompt.toLowerCase().includes(`https://${filename}`) ||
                              userPrompt.toLowerCase().includes(`http://${filename}`);
                console.log('[Extension] Is URL?', isUrl, 'for', filename);
                if (!isUrl) {
                    promptFilename = filename;
                }
            }
            
            if (!promptFilename) {
                // Second priority: "create/write/make filename" patterns (avoid URLs)
                filenameMatch = userPrompt.match(/(?:create|write|make|generate)\s+(?:a\s+|an\s+|the\s+)?(?:file\s+|script\s+|code\s+|app\s+)?(?:called\s+|named\s+)?([a-zA-Z0-9_\-]+\.(js|ts|py|java|cpp|c|h|json|xml|html|css|txt|md|sh|yaml|yml))/i);
                if (filenameMatch) {
                    console.log('[Extension] Found direct match:', filenameMatch[1]);
                    promptFilename = filenameMatch[1];
                }
            }
            
            console.log('[Extension] Final extracted filename:', promptFilename || 'none');
        }

        while ((match = codeBlockRegex.exec(responseText)) !== null) {
            const language = match[1];
            let filename = match[2].trim();
            let code = match[3];
            
            console.log('[Extension] Found code block - Language:', language, 'Filename from block:', filename || 'none');

            // If no filename in code block header, check first line of code for comment
            if (!filename) {
                const firstLineMatch = code.match(/^[\s]*(?:\/\/|#|\/\*)\s*([^\s]+\.\w+)/);
                if (firstLineMatch) {
                    filename = firstLineMatch[1];
                    console.log('[Extension] Found filename in comment:', filename);
                }
            }

            // If still no filename, use the one from user's prompt
            if (!filename && promptFilename) {
                filename = promptFilename;
                console.log('[Extension] Using filename from prompt:', filename);
            }

            // Only process blocks with filenames
            if (filename && filename.includes('.')) {
                console.log('[Extension] Adding code block to save:', filename);
                codeBlocks.push({ language, filename, code: code.trim() });
            } else {
                console.log('[Extension] Skipping code block (no filename)');
            }
        }

        console.log('[Extension] Total code blocks found:', codeBlocks.length);

        // If no code blocks found, return null to show full response
        if (codeBlocks.length === 0) {
            console.log('[Extension] No code blocks to save, showing full response');
            return null;
        }

        // Save and open each code block
        const savedFiles: string[] = [];
        for (const block of codeBlocks) {
            const saved = await this.saveAndOpenCodeFile(block.filename, block.code);
            if (saved) {
                savedFiles.push(block.filename);
            }
        }

        // Return summary message if files were saved
        if (savedFiles.length > 0) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const workspacePath = workspaceFolders && workspaceFolders.length > 0 
                ? workspaceFolders[0].uri.fsPath 
                : 'workspace';
            
            const fileList = savedFiles.map(f => `📄 **${f}**`).join('\n');
            return `✅ **Files created and opened:**\n${fileList}\n\n📁 Location: ${workspacePath}`;
        }

        return null;
    }

    /**
     * Save code to a file and open it in the editor.
     * Returns true if file was saved, false if skipped.
     */
    private async saveAndOpenCodeFile(filename: string, code: string): Promise<boolean> {
        let targetFilename = filename; // Declare at function scope for error handling
        
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
                return false;
            }

            const workspaceRoot = workspaceFolders[0].uri;
            
            // Check if src/ folder exists and if this is a source file
            const srcFolderPath = vscode.Uri.joinPath(workspaceRoot, 'src');
            
            try {
                const srcStat = await vscode.workspace.fs.stat(srcFolderPath);
                if (srcStat.type === vscode.FileType.Directory) {
                    // Check if this is a source file (not config/readme/etc)
                    const ext = path.extname(filename).toLowerCase();
                    const sourceExtensions = ['.cpp', '.c', '.hpp', '.h', '.js', '.ts', '.tsx', '.jsx', 
                                             '.py', '.java', '.rs', '.go', '.cs', '.php', '.rb', '.swift'];
                    
                    if (sourceExtensions.includes(ext)) {
                        // Save to src/ folder
                        targetFilename = path.join('src', path.basename(filename));
                        console.log('[Extension] Detected src/ folder, saving to:', targetFilename);
                    }
                }
            } catch {
                // src/ folder doesn't exist, use root
            }
            
            const filePath = vscode.Uri.joinPath(workspaceRoot, targetFilename);

            // Check if file exists and ask user
            let shouldSave = true;
            try {
                await vscode.workspace.fs.stat(filePath);
                const choice = await vscode.window.showWarningMessage(
                    `File ${targetFilename} already exists. Overwrite?`,
                    'Yes', 'No'
                );
                shouldSave = choice === 'Yes';
            } catch {
                // File doesn't exist, proceed with save
            }

            if (shouldSave) {
                // Write file
                const encoder = new TextEncoder();
                await vscode.workspace.fs.writeFile(filePath, encoder.encode(code));

                // Open in editor
                const document = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(document, {
                    preview: false,
                    viewColumn: vscode.ViewColumn.One
                });

                return true;
            }
            return false;
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to save ${targetFilename}: ${error.message}`);
            return false;
        }
    }

    private async handleSendMessage(userMessage: string) {
        const statusBarManager = getStatusBarManager();
        
        console.log('[Extension] handleSendMessage called with:', userMessage);
        if (!userMessage.trim() || !this.view) {
            console.log('[Extension] Empty message or no view, returning');
            return;
        }

        // Add user message to history (cap at MAX_HISTORY)
        this.conversationHistory.push({
            role: 'user',
            content: userMessage
        });
        if (this.conversationHistory.length > ChatViewProvider.MAX_HISTORY) {
            this.conversationHistory = this.conversationHistory.slice(-ChatViewProvider.MAX_HISTORY);
        }

        // Get active file content as context FIRST
        const fileContext = await this.getActiveFileContext();
        let fileName: string | undefined;
        console.log('[Extension] File context length:', fileContext ? fileContext.length : 'none');
        
        // Show file context info to user
        let contextInfo = '';
        if (fileContext) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                fileName = path.basename(editor.document.fileName);
                const lineCount = editor.document.lineCount;
                const charCount = editor.document.getText().length;
                contextInfo = `\n\n📎 *Including file: ${fileName} (${lineCount} lines, ${charCount} chars)*`;
                console.log('[Extension] File context preview:', fileContext.substring(0, 200));
            }
        } else {
            contextInfo = '\n\n📝 *No file context (no active editor)*';
        }

        // Show user message with context info in chat
        this.view.webview.postMessage({
            command: 'addMessage',
            role: 'user',
            content: userMessage + contextInfo
        });

        // Show typing indicator
        this.view.webview.postMessage({
            command: 'setTyping',
            typing: true
        });

        // Check if this is a build request
        if (this.isBuildRequest(userMessage)) {
            await this.handleBuildAndFix(userMessage);
            return;
        }

        // Check if this is a session search request
        if (SessionManager.isSessionSearchRequest(userMessage)) {
            await this.handleSessionSearch(userMessage);
            return;
        }

        // Check if this is a batch directory analysis request
        if (this.isDirectoryAnalysisRequest(userMessage)) {
            await this.handleDirectoryAnalysis(userMessage);
            return;
        }

        // Check if this is a planning request (project creation)
        if (isPlanningRequest(userMessage)) {
            await this.handlePlanningMode(userMessage, fileContext, fileName);
            return;
        }

        // Check if this is a modification request (existing project)
        if (isModificationRequest(userMessage)) {
            await this.handleModificationMode(userMessage);
            return;
        }

        try {
            console.log('[Extension] Regular chat mode - checking project structure...');
            // For regular chat, try to enhance context with project structure
            // If project is too large (>100 files), scanner will skip and show warning
            let enhancedMessage = userMessage;
            
            const projectStructure = await this.projectScanner.scanProject();
            console.log('[Extension] Project scan result. Files:', projectStructure.totalFiles);
            
            // Only add project context if we have actual file data (not skipped due to size)
            if (projectStructure.sourceFiles.length > 0 || projectStructure.headerFiles.length > 0) {
                const projectOverview = `\n\n[Context: Working in project with ${projectStructure.totalFiles} files: ${[...projectStructure.sourceFiles, ...projectStructure.headerFiles].map(f => f.relativePath).join(', ')}]`;
                enhancedMessage = userMessage + projectOverview;
                console.log('[Extension] Enhanced message with project context');
            }
            
            console.log('[Extension] Preparing chat request...');
            // Send to Boudica with file attachment if context available
            const request: ChatRequest = {
                message: enhancedMessage,
                session_id: this.sessionId,
                // If we have file context, attach it properly as multipart/form-data
                ...(fileContext && fileName && {
                    file_content: fileContext,
                    file_name: fileName
                })
            };
            console.log('[Extension] Sending request. File:', fileName || 'none');
            console.log('[Extension] Calling client.chatStream()...');

            // Stream the response so the user gets incremental feedback
            const streamMsgId = 'stream-' + Date.now();
            this.view.webview.postMessage({ command: 'startStreamMessage', id: streamMsgId });

            const response = await this.client.chatStream(
                request,
                (chunk) => {
                    this.view?.webview.postMessage({ command: 'appendStreamChunk', id: streamMsgId, text: chunk });
                }
            );

            this.view.webview.postMessage({ command: 'endStreamMessage', id: streamMsgId, tokensPerSecond: response.tokens_per_second });
            console.log('[Extension] Stream complete:', response.error ? 'ERROR' : 'SUCCESS');

            // Hide typing indicator
            this.view.webview.postMessage({
                command: 'setTyping',
                typing: false
            });

            // Clear status bar operation
            statusBarManager.clearOperation();

            if (response.error) {
                statusBarManager.showError('Request failed');
                this.view.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: `Error: ${response.error}`
                });
            } else if (response.response) {
                const finalText = response.response;

                // Check if response contains code that should be saved as a file
                const summaryMessage = await this.handleCodeResponse(finalText, userMessage);

                // Add assistant response to history (cap at MAX_HISTORY)
                this.conversationHistory.push({
                    role: 'assistant',
                    content: finalText
                });
                if (this.conversationHistory.length > ChatViewProvider.MAX_HISTORY) {
                    this.conversationHistory = this.conversationHistory.slice(-ChatViewProvider.MAX_HISTORY);
                }

                // Log interaction to session
                this.sessionManager.logInteraction('sidebar', userMessage, finalText, fileName ? [fileName] : []);

                // If files were saved, show summary message as additional message
                if (summaryMessage) {
                    this.view.webview.postMessage({
                        command: 'addMessage',
                        role: 'assistant',
                        content: summaryMessage
                    });
                }
            }
        } catch (error: any) {

            statusBarManager.showError('Request failed');
            
            this.view.webview.postMessage({
                command: 'setTyping',
                typing: false
            });
            this.view.webview.postMessage({
                command: 'addMessage',
                role: 'error',
                content: `Failed to send message: ${error.message}`
            });
        }
    }

    /**
     * Handle batch directory analysis - analyze multiple files in a directory
     */
    private async handleDirectoryAnalysis(userMessage: string) {
        const statusBarManager = getStatusBarManager();
        
        try {
            // Extract directory path from message
            // Try multiple patterns in order of specificity:
            
            // Pattern 1: Explicit keywords "folder", "directory", "path"
            let pathMatch = userMessage.match(/(?:folder|directory|path)\s+([\S]+)/i);
            
            // Pattern 2: Absolute paths (starts with / or ~)
            if (!pathMatch) {
                pathMatch = userMessage.match(/(\/[\w\/\-\.]+|~\/[\w\/\-\.]+)/);
            }
            
            // Pattern 3: "in" or "from" followed by a path-like string
            if (!pathMatch) {
                pathMatch = userMessage.match(/(?:in|from)\s+([\w\/\-\.~]+)/i);
            }
            
            if (!pathMatch) {
                this.view?.webview.postMessage({
                    command: 'setTyping',
                    typing: false
                });
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: '❌ Could not find directory path in your message.\n\nPlease include a path like:\n- `/home/user/project/src`\n- `~/Documents/code`\n- `folder /path/to/dir`'
                });
                return;
            }
            
            const dirPath = pathMatch[1];
            
            // Extract file extension if specified (e.g., ".cu extension", "*.cpp files", "file extension of .cu")
            const extMatch = userMessage.match(/\.(\w+)\s+(?:extension|files?)/i) || 
                            userMessage.match(/\*\.(\w+)/) ||
                            userMessage.match(/(?:extension|type)\s+(?:of\s+)?\.(\w+)/i);
            const fileExt = extMatch ? extMatch[1] : '*';
            
            // Convert to absolute path if needed
            let absolutePath = dirPath;
            if (!path.isAbsolute(dirPath)) {
                if (dirPath.startsWith('~')) {
                    absolutePath = dirPath.replace('~', process.env.HOME || process.env.USERPROFILE || '');
                } else {
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (workspaceFolder) {
                        absolutePath = path.join(workspaceFolder.uri.fsPath, dirPath);
                    }
                }
            }
            
            // Check if directory exists
            if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
                this.view?.webview.postMessage({
                    command: 'setTyping',
                    typing: false
                });
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: `❌ Directory not found: \`${absolutePath}\`\n\nPlease check the path and try again.`
                });
                return;
            }

            // Security: only allow reading within the workspace or sub-paths explicitly provided
            // (the user typed the path, but we still gate to prevent accidental access to /etc etc.)
            const workspaceFolder2 = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder2) {
                const resolvedAbs = path.resolve(absolutePath);
                const resolvedWs = path.resolve(workspaceFolder2.uri.fsPath);
                if (!resolvedAbs.startsWith(resolvedWs + path.sep) && resolvedAbs !== resolvedWs) {
                    const confirm = await vscode.window.showWarningMessage(
                        `Directory "${absolutePath}" is outside the current workspace. Proceed?`,
                        'Yes', 'No'
                    );
                    if (confirm !== 'Yes') {
                        this.view?.webview.postMessage({ command: 'setTyping', typing: false });
                        return;
                    }
                }
            }
            
            // Find matching files
            const pattern = fileExt === '*' ? '**/*' : `**/*.${fileExt}`;
            const uri = vscode.Uri.file(absolutePath);
            const relativePattern = new vscode.RelativePattern(uri, pattern);
            
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: `🔍 **Scanning directory...**\n\nSearching for ${fileExt === '*' ? 'all files' : `*.${fileExt} files`} in:\n\`${absolutePath}\``
            });
            
            const files = await vscode.workspace.findFiles(relativePattern, '**/node_modules/**', 100);
            
            if (files.length === 0) {
                this.view?.webview.postMessage({
                    command: 'setTyping',
                    typing: false
                });
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: `📭 No ${fileExt === '*' ? 'files' : `*.${fileExt} files`} found in \`${absolutePath}\``
                });
                return;
            }
            
            // Limit to first 50 files to avoid overwhelming the context
            const filesToAnalyze = files.slice(0, 50);
            if (files.length > 50) {
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: `⚠️ Found ${files.length} files, analyzing first 50 to avoid context overflow.`
                });
            }
            
            // Read file contents
            const fileContents: Array<{name: string, content: string, path: string}> = [];
            let totalSize = 0;
            const maxTotalSize = 500000; // 500KB limit
            
            for (const fileUri of filesToAnalyze) {
                try {
                    const content = fs.readFileSync(fileUri.fsPath, 'utf-8');
                    const fileName = path.basename(fileUri.fsPath);
                    const relativePath = path.relative(absolutePath, fileUri.fsPath);
                    
                    // Check size limit
                    if (totalSize + content.length > maxTotalSize) {
                        this.view?.webview.postMessage({
                            command: 'addMessage',
                            role: 'assistant',
                            content: `⚠️ Reached 500KB context limit after ${fileContents.length} files. Analyzing those only.`
                        });
                        break;
                    }
                    
                    fileContents.push({
                        name: fileName,
                        content: content,
                        path: relativePath
                    });
                    totalSize += content.length;
                } catch (err) {
                    console.log(`[Extension] Failed to read ${fileUri.fsPath}:`, err);
                }
            }
            
            if (fileContents.length === 0) {
                this.view?.webview.postMessage({
                    command: 'setTyping',
                    typing: false
                });
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: '❌ Failed to read any files. Please check file permissions.'
                });
                return;
            }
            
            // Show what we're analyzing
            const fileList = fileContents.map(f => f.path).slice(0, 10).join(', ');
            const moreFiles = fileContents.length > 10 ? ` and ${fileContents.length - 10} more` : '';
            
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: `📊 **Analyzing ${fileContents.length} files** (${Math.round(totalSize / 1024)}KB total):\n\n${fileList}${moreFiles}\n\n*Sending to Boudica...*`
            });
            
            statusBarManager.showOperation('Analyzing', `${fileContents.length} files`);
            
            // Combine files into analysis prompt
            const combinedContent = fileContents.map(f => {
                return `// File: ${f.path}\n${f.content}\n\n`;
            }).join('\n' + '='.repeat(80) + '\n\n');
            
            const analysisPrompt = `${userMessage}\n\nI've attached ${fileContents.length} files from ${absolutePath} for your analysis.`;
            
            // Send to Boudica
            const request: ChatRequest = {
                message: analysisPrompt,
                session_id: this.sessionId,
                file_content: combinedContent,
                file_name: `batch_analysis_${fileContents.length}_files.txt`
            };
            
            const response = await this.client.chat(request);
            
            // Hide typing indicator
            this.view?.webview.postMessage({
                command: 'setTyping',
                typing: false
            });
            
            statusBarManager.clearOperation();
            
            if (response.error) {
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: `❌ Error analyzing files: ${response.error}`
                });
                this.conversationHistory.push({
                    role: 'assistant',
                    content: `Error: ${response.error}`
                });
            } else {
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: response.response || 'Analysis complete (no response)'
                });
                this.conversationHistory.push({
                    role: 'assistant',
                    content: response.response || 'Analysis complete'
                });
            }
        } catch (error: any) {
            console.error('[Extension] Directory analysis error:', error);
            this.view?.webview.postMessage({
                command: 'setTyping',
                typing: false
            });
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'error',
                content: `❌ Failed to analyze directory: ${error.message}`
            });
            statusBarManager.clearOperation();
        }
    }

    private async handlePlanningMode(userMessage: string, fileContext?: string, fileName?: string) {
        const statusBarManager = getStatusBarManager();
        
        try {
            // Get workspace folder
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                this.view?.webview.postMessage({
                    command: 'setTyping',
                    typing: false
                });
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: 'Please open a workspace folder first to create a project.'
                });
                return;
            }
            
            const workspaceRoot = workspaceFolder.uri.fsPath;
            
            // Generate plan
            const plan = await generatePlan(this.client, userMessage, workspaceRoot);
            
            if (!plan || plan.steps.length === 0) {
                this.view?.webview.postMessage({
                    command: 'setTyping',
                    typing: false
                });
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: 'Failed to generate a plan. Please try rephrasing your request.'
                });
                return;
            }
            
            // Show plan to user
            const planMessage = this.formatPlan(plan);
            this.view?.webview.postMessage({
                command: 'setTyping',
                typing: false
            });
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: `🎯 **I have planned this ${plan.projectType} application and will now start to create it:**\n\n${planMessage}\n\n⏳ *Creating files...*`
            });
            
            // Mark file creation as in progress
            this.isCreatingFiles = true;
            
            // Execute plan with progress updates
            const result = await executePlan(
                this.client,
                plan,
                userMessage,
                workspaceRoot,
                (step, total, message) => {
                    // Update status bar with progress
                    statusBarManager.showOperation('Creating', `${message} (${step}/${total})`);
                    
                    // Send progress update to chat UI
                    this.view?.webview.postMessage({
                        command: 'addMessage',
                        role: 'assistant',
                        content: `⏳ ${message} (${step}/${total})`
                    });
                },
                fileContext,  // Pass reference file content (e.g., slm_cgi_client.cpp)
                fileName      // Pass reference file name
            );
            
            // Mark file creation as complete
            this.isCreatingFiles = false;
            
            // Show completion message
            if (result.success && result.filesCreated.length > 0) {
                const fileList = result.filesCreated.map(f => `  • ${f}`).join('\n');
                const completionMessage = `✅ **Project created successfully!**\n\nCreated ${result.filesCreated.length} files:\n${fileList}\n\n🚀 Your project is ready to build!`;
                
                if (this.view) {
                    // Webview is open - show message immediately
                    this.view.webview.postMessage({
                        command: 'addMessage',
                        role: 'assistant',
                        content: completionMessage
                    });
                    
                    // Add to history
                    this.conversationHistory.push({
                        role: 'assistant',
                        content: `Created project with ${result.filesCreated.length} files: ${result.filesCreated.join(', ')}`
                    });
                } else {
                    // Webview is closed - store for later display
                    console.log('[Extension] Webview closed, storing completion message');
                    this.pendingCompletionMessage = completionMessage;
                    this.conversationHistory.push({
                        role: 'assistant',
                        content: `Created project with ${result.filesCreated.length} files: ${result.filesCreated.join(', ')}`
                    });
                }
                
                vscode.window.showInformationMessage(`✅ Created ${result.filesCreated.length} files successfully!`);
            } else {
                const errorMessage = `⚠️ Project creation completed with issues. Created ${result.filesCreated.length} files.`;
                
                if (this.view) {
                    this.view.webview.postMessage({
                        command: 'addMessage',
                        role: 'error',
                        content: errorMessage
                    });
                } else {
                    this.pendingCompletionMessage = errorMessage;
                }
                
                vscode.window.showWarningMessage(`⚠️ Project creation completed with ${result.filesCreated.length} files.`);
            }
            
        } catch (error: any) {
            // Mark file creation as complete (even on error)
            this.isCreatingFiles = false;
            
            statusBarManager.showError('Planning failed');
            
            const errorMessage = `Failed to create project: ${error.message}`;
            
            if (this.view) {
                this.view.webview.postMessage({
                    command: 'setTyping',
                    typing: false
                });
                this.view.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: errorMessage
                });
            } else {
                this.pendingCompletionMessage = `⚠️ ${errorMessage}`;
            }
            
            vscode.window.showErrorMessage(`BoudiCode: ${errorMessage}`);
        }
    }
    
    private formatPlan(plan: ExecutionPlan): string {
        const steps: string[] = [];
        const groupedSteps = new Map<number, string[]>();
        
        // Group by step number
        for (const step of plan.steps) {
            if (!groupedSteps.has(step.stepNumber)) {
                groupedSteps.set(step.stepNumber, []);
            }
            groupedSteps.get(step.stepNumber)!.push(step.fileName);
        }
        
        // Format steps
        for (const [stepNum, files] of groupedSteps) {
            const step = plan.steps.find(s => s.stepNumber === stepNum);
            if (step) {
                const fileList = files.map(f => `\`${f}\``).join(' and ');
                steps.push(`${stepNum}. Create ${fileList} – ${step.description}`);
            }
        }
        
        return steps.join('\n');
    }

    private async handleModificationMode(userMessage: string) {
        const statusBarManager = getStatusBarManager();
        
        try {
            // Get workspace folder
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                this.view?.webview.postMessage({
                    command: 'setTyping',
                    typing: false
                });
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: 'Please open a workspace folder first.'
                });
                return;
            }
            
            const workspaceRoot = workspaceFolder.uri.fsPath;
            
            // STEP 1: Search for relevant code locations
            console.log('[ChatPanel] Starting intelligent code search...');
            statusBarManager.showOperation('Searching', 'Finding relevant code...');
            
            const codeSearch = new CodeSearch();
            const searchContext = await codeSearch.searchForContext(userMessage);
            
            console.log(`[ChatPanel] Search complete: ${searchContext.results.length} files found`);
            
            // Show search results to user
            if (searchContext.results.length > 0) {
                const searchSummary = CodeSearch.formatResultsSummary(searchContext);
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: searchSummary
                });
            } else {
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: '🔍 No existing code found for these keywords. I\'ll create new files as needed.'
                });
            }
            
            // STEP 2: Generate modification plan with search context
            statusBarManager.showOperation('Planning', 'Generating modification plan...');
            
            const plan = await generateModificationPlan(
                this.client, 
                userMessage, 
                this.projectScanner, 
                workspaceRoot,
                searchContext  // Pass search context
            );
            
            if (!plan || plan.steps.length === 0) {
                // Fallback to regular chat mode
                this.view?.webview.postMessage({
                    command: 'setTyping',
                    typing: false
                });
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: 'I couldn\'t generate a modification plan. Let me try to help in regular mode...'
                });
                
                // Continue with regular chat
                const request: ChatRequest = {
                    message: userMessage,
                    session_id: this.sessionId
                };
                
                const response = await this.client.chat(request);
                
                if (response.response) {
                    this.conversationHistory.push({
                        role: 'assistant',
                        content: response.response
                    });
                    this.view?.webview.postMessage({
                        command: 'addMessage',
                        role: 'assistant',
                        content: response.response
                    });
                }
                
                return;
            }
            
            // Show plan to user
            const planMessage = this.formatModificationPlan(plan);
            this.view?.webview.postMessage({
                command: 'setTyping',
                typing: false
            });
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: `🔧 **I will make these modifications:**\n\n${planMessage}\n\n⏳ *Modifying files...*`
            });
            
            // Mark file creation as in progress
            this.isCreatingFiles = true;
            
            // Execute modification plan with progress updates
            const result = await executeModificationPlan(
                this.client,
                plan,
                this.projectScanner,
                userMessage,
                workspaceRoot,
                (step, total, message) => {
                    // Update status bar with progress
                    statusBarManager.showOperation('Modifying', `${message} (${step}/${total})`);
                    
                    // Send progress update to chat UI
                    this.view?.webview.postMessage({
                        command: 'addMessage',
                        role: 'assistant',
                        content: `⏳ ${message} (${step}/${total})`
                    });
                }
            );
            
            // Mark file operations as complete
            this.isCreatingFiles = false;
            
            // Show completion message
            const totalChanges = result.filesModified.length + result.filesCreated.length;
            if (result.success && totalChanges > 0) {
                let completionMessage = `✅ **Modifications complete!**\n\n`;
                
                if (result.filesModified.length > 0) {
                    completionMessage += `Modified ${result.filesModified.length} file(s):\n`;
                    completionMessage += result.filesModified.map(f => `  • ${f}`).join('\n') + '\n';
                }
                
                if (result.filesCreated.length > 0) {
                    completionMessage += `\nCreated ${result.filesCreated.length} new file(s):\n`;
                    completionMessage += result.filesCreated.map(f => `  • ${f}`).join('\n');
                }
                
                completionMessage += `\n\n🚀 Your project has been updated!`;
                
                if (this.view) {
                    this.view.webview.postMessage({
                        command: 'addMessage',
                        role: 'assistant',
                        content: completionMessage
                    });
                    
                    this.conversationHistory.push({
                        role: 'assistant',
                        content: `Modified ${result.filesModified.length} files, created ${result.filesCreated.length} files`
                    });
                } else {
                    this.pendingCompletionMessage = completionMessage;
                    this.conversationHistory.push({
                        role: 'assistant',
                        content: `Modified ${result.filesModified.length} files, created ${result.filesCreated.length} files`
                    });
                }
                
                vscode.window.showInformationMessage(`✅ Modified ${totalChanges} file(s) successfully!`);
            } else {
                const errorMessage = `⚠️ Modification completed with issues. Changed ${totalChanges} file(s).`;
                
                if (this.view) {
                    this.view.webview.postMessage({
                        command: 'addMessage',
                        role: 'error',
                        content: errorMessage
                    });
                } else {
                    this.pendingCompletionMessage = errorMessage;
                }
                
                vscode.window.showWarningMessage(`⚠️ Modification completed with ${totalChanges} file(s).`);
            }
            
        } catch (error: any) {
            this.isCreatingFiles = false;
            
            statusBarManager.showError('Modification failed');
            
            const errorMessage = `Failed to modify project: ${error.message}`;
            
            if (this.view) {
                this.view.webview.postMessage({
                    command: 'setTyping',
                    typing: false
                });
                this.view.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: errorMessage
                });
            } else {
                this.pendingCompletionMessage = `⚠️ ${errorMessage}`;
            }
            
            vscode.window.showErrorMessage(`BoudiCode: ${errorMessage}`);
        }
    }
    
    private formatModificationPlan(plan: any): string {
        const steps: string[] = [];
        
        for (const step of plan.steps) {
            const actionIcon = step.action === 'modify' ? '✏️' : step.action === 'create' ? '➕' : '❌';
            const location = step.targetLocation ? ` at ${step.targetLocation}` : '';
            steps.push(`${actionIcon} ${step.action.toUpperCase()} \`${step.fileName}\`${location} – ${step.description}`);
        }
        
        return steps.join('\n');
    }

    /**
     * Group errors by file for file-by-file processing
     */
    private groupErrorsByFile(errors: ParsedError[]): Map<string, ParsedError[]> {
        const errorsByFile = new Map<string, ParsedError[]>();
        
        for (const error of errors) {
            const file = error.file || 'unknown';
            if (!errorsByFile.has(file)) {
                errorsByFile.set(file, []);
            }
            errorsByFile.get(file)!.push(error);
        }
        
        console.log(`[ChatPanel] Grouped ${errors.length} errors into ${errorsByFile.size} file(s):`);
        errorsByFile.forEach((errs, file) => {
            console.log(`[ChatPanel]   ${file}: ${errs.length} error(s)`);
        });
        
        return errorsByFile;
    }

    /**
     * Fix errors one file at a time to avoid timeouts
     */
    private async fixErrorsByFile(errorsByFile: Map<string, ParsedError[]>, errorSummary: string): Promise<void> {
        const statusBarManager = getStatusBarManager();
        const files = Array.from(errorsByFile.keys()).filter(f => f !== 'unknown');
        const totalFiles = files.length;
        
        this.view?.webview.postMessage({
            command: 'addMessage',
            role: 'assistant',
            content: `🔧 **File-by-file error fixing**\n\nProcessing ${totalFiles} file(s) with errors...\n`
        });
        
        const fixGenerator = new FixGenerator(this.client, this.projectScanner);
        let fixedFiles = 0;
        let totalChanges = 0;
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const errors = errorsByFile.get(file)!;
            const fileNum = i + 1;
            
            console.log(`[ChatPanel] Processing file ${fileNum}/${totalFiles}: ${file} with ${errors.length} errors`);
            console.log(`[ChatPanel] Error files in this batch:`, errors.map(e => e.file).filter((v, i, a) => a.indexOf(v) === i));
            
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: `\n📁 **[${fileNum}/${totalFiles}] ${file}** (${errors.length} error${errors.length > 1 ? 's' : ''})\n\n🤔 Generating fixes...`
            });
            
            statusBarManager.showOperation('Fixing', `${file} (${fileNum}/${totalFiles})`);
            
            // Generate fix plan for this file only
            const fixResult = await fixGenerator.generateFixPlan(errors);
            
            if (!fixResult.plan || fixResult.plan.steps.length === 0) {
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: `⚠️ Could not generate fixes for ${file}\n`
                });
                continue;
            }
            
            const fixPlan = fixResult.plan;
            
            // Show preview with approval buttons
            const previewContent = this.formatFixPreview(fixPlan, file, errors.length);
            this.view?.webview.postMessage({
                command: 'showFixPreview',
                file: file,
                fileNum: fileNum,
                totalFiles: totalFiles,
                fixPlan: fixPlan,
                previewContent: previewContent,
                errorCount: errors.length
            });
            
            // Store pending fix for this file
            this.pendingFixes.set(file, { fixPlan, errors });
            
            // Wait for user approval (will be handled by webview message handler)
            // For now, continue to next file to show all previews
        }
        
        // Show summary after all previews
        this.view?.webview.postMessage({
            command: 'addMessage',
            role: 'assistant',
            content: `\n📋 **Generated ${files.length} fix plan(s)**\n\nReview and approve each fix above to apply changes.`
        });
        
        statusBarManager.showOperation('Building', 'Rebuilding project...');
        
        // Rebuild after all fixes
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const buildRunner = new BuildRunner(workspaceRoot);
        const rebuildResult = await buildRunner.runBuild();
        
        if (rebuildResult.success) {
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: '✅ **Build successful!**'
            });
            statusBarManager.showSuccess('Build successful');
        } else {
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: `⚠️ **Build still failing**\n\nRemaining errors may require manual review.`
            });
            statusBarManager.showError('Build failed');
        }
        
        statusBarManager.clearOperation();
    }

    /**
     * Format fix plan as readable preview
     */
    private formatFixPreview(fixPlan: any, fileName: string, errorCount: number): string {
        let preview = `**Proposed Fixes for ${fileName}** (${errorCount} error${errorCount > 1 ? 's' : ''}):\n\n`;
        preview += '```\n';
        preview += '─'.repeat(60) + '\n';
        
        for (let i = 0; i < fixPlan.steps.length; i++) {
            const step = fixPlan.steps[i];
            const actionIcon = step.action === 'modify' ? '✏️' : step.action === 'create' ? '➕' : '❌';
            
            preview += `\nSTEP ${i + 1}: ${actionIcon} ${step.action.toUpperCase()} ${step.fileName}\n`;
            
            if (step.targetLocation) {
                preview += `  Location: ${step.targetLocation}\n`;
            }
            
            if (step.description) {
                preview += `  Change: ${step.description}\n`;
            }
            
            if (step.content && step.content.length < 200) {
                preview += `  Code:\n    ${step.content.split('\n').join('\n    ')}\n`;
            }
        }
        
        preview += '\n' + '─'.repeat(60) + '\n';
        preview += '```\n';
        
        return preview;
    }

    /**
     * Apply approved fix for a specific file
     */
    private async applyFix(fileName: string): Promise<void> {
        const pending = this.pendingFixes.get(fileName);
        if (!pending) {
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'error',
                content: `⚠️ No pending fix found for ${fileName}`
            });
            return;
        }

        const { fixPlan } = pending;
        const statusBarManager = getStatusBarManager();
        
        this.view?.webview.postMessage({
            command: 'addMessage',
            role: 'assistant',
            content: `⚙️ Applying fixes to ${fileName}...`
        });
        
        statusBarManager.showOperation('Applying', `Fixing ${fileName}`);
        
        try {
            const result = await executeModificationPlan(
                this.client,
                fixPlan,
                this.projectScanner,
                `Fix errors in ${fileName}`,
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
                () => {}
            );
            
            const fileChanges = result.filesModified.length + result.filesCreated.length;
            if (result.success && fileChanges > 0) {
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: `✅ Applied ${fileChanges} change(s) to ${fileName}`
                });
                this.pendingFixes.delete(fileName);
            } else {
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: `⚠️ Failed to apply changes to ${fileName}`
                });
            }
        } catch (error) {
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'error',
                content: `❌ Error applying fixes: ${error instanceof Error ? error.message : String(error)}`
            });
        } finally {
            statusBarManager.clearOperation();
        }
    }

    /**
     * Skip fix for a specific file
     */
    private skipFix(fileName: string): void {
        this.pendingFixes.delete(fileName);
        this.view?.webview.postMessage({
            command: 'addMessage',
            role: 'assistant',
            content: `⏭️ Skipped fixes for ${fileName}`
        });
    }

    /**
     * Apply all pending fixes and rebuild
     */
    private async applyAllFixes(): Promise<void> {
        const files = Array.from(this.pendingFixes.keys());
        if (files.length === 0) {
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: `⚠️ No pending fixes to apply`
            });
            return;
        }

        this.view?.webview.postMessage({
            command: 'addMessage',
            role: 'assistant',
            content: `⚙️ Applying all ${files.length} fix plan(s)...`
        });

        let appliedCount = 0;
        for (const file of files) {
            await this.applyFix(file);
            if (!this.pendingFixes.has(file)) {
                appliedCount++;
            }
        }

        this.view?.webview.postMessage({
            command: 'addMessage',
            role: 'assistant',
            content: `\n✅ Applied ${appliedCount}/${files.length} fix plan(s)\n\n🔨 **Rebuilding...**`
        });

        // Rebuild after all fixes
        const statusBarManager = getStatusBarManager();
        statusBarManager.showOperation('Building', 'Rebuilding project...');
        
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const buildRunner = new BuildRunner(workspaceRoot);
        const rebuildResult = await buildRunner.runBuild();
        
        if (rebuildResult.success) {
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: '✅ **Build successful!**'
            });
            statusBarManager.showSuccess('Build successful');
        } else {
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: `⚠️ **Build still failing**\n\nRemaining errors may require manual review.`
            });
            statusBarManager.showError('Build failed');
        }
        
        statusBarManager.clearOperation();
    }

    /**
     * Handle session search in sidebar
     */
    private async handleSessionSearch(userMessage: string) {
        try {
            const scope = SessionManager.getSearchScope(userMessage);
            const query = SessionManager.extractSearchQuery(userMessage);
            
            let resultsText = '🔍 **Session History Search**\n\n';
            
            let results;
            if (scope === 'today') {
                const todayDate = this.sessionManager.getTodayDate();
                const interactions = this.sessionManager.getSessionByDate(todayDate);
                results = interactions.map((interaction, index) => ({
                    date: todayDate,
                    index: index + 1,
                    interaction,
                    score: 10
                }));
                resultsText += `📅 Searching today's session (${todayDate})\n\n`;
            } else if (scope === 'yesterday') {
                const yesterdayDate = this.sessionManager.getYesterdayDate();
                const interactions = this.sessionManager.getSessionByDate(yesterdayDate);
                results = interactions.map((interaction, index) => ({
                    date: yesterdayDate,
                    index: index + 1,
                    interaction,
                    score: 10
                }));
                resultsText += `📅 Searching yesterday's session (${yesterdayDate})\n\n`;
            } else {
                // Search all (last 10 days)
                results = this.sessionManager.searchSessions(query, 10);
                resultsText += `📅 Searching last 10 days for: "${query}"\n\n`;
            }
            
            if (results.length === 0) {
                resultsText += '❌ **No results found**\n\n';
                resultsText += 'Try a different search term or check a different day.\n';
            } else {
                resultsText += `✅ **Found ${results.length} interaction${results.length > 1 ? 's' : ''}**\n\n`;
                resultsText += '---\n\n';
                
                // Display results (limit to 20)
                for (let i = 0; i < Math.min(results.length, 20); i++) {
                    const result = results[i];
                    const time = new Date(result.interaction.timestamp).toLocaleTimeString();
                    const sourceIcon = result.interaction.source === 'native' ? '💬' : '📋';
                    
                    resultsText += `### ${i + 1}. ${sourceIcon} ${result.date} at ${time}\n\n`;
                    
                    // Show user prompt (truncated)
                    const userPrompt = result.interaction.user.length > 150 
                        ? result.interaction.user.substring(0, 150) + '...'
                        : result.interaction.user;
                    resultsText += `**You asked:** ${userPrompt}\n\n`;
                    
                    // Show response (truncated)
                    const assistantResponse = result.interaction.assistant.length > 300
                        ? result.interaction.assistant.substring(0, 300) + '...'
                        : result.interaction.assistant;
                    resultsText += `**Boudica:** ${assistantResponse}\n\n`;
                    
                    // Show files if any
                    if (result.interaction.files.length > 0) {
                        resultsText += `📎 Files: ${result.interaction.files.join(', ')}\n\n`;
                    }
                    
                    resultsText += '---\n\n';
                }
                
                if (results.length > 20) {
                    resultsText += `\n_Showing first 20 of ${results.length} results_\n`;
                }
            }
            
            // Send to webview
            this.view?.webview.postMessage({
                command: 'setTyping',
                typing: false
            });
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: resultsText
            });
            
        } catch (error: any) {
            this.view?.webview.postMessage({
                command: 'setTyping',
                typing: false
            });
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'error',
                content: `Session search error: ${error.message}`
            });
        }
    }

    /**
     * Detect if user is requesting a build
     */
    private isBuildRequest(userMessage: string): boolean {
        const lowerMessage = userMessage.toLowerCase();
        
        const buildKeywords = [
            'build the project',
            'build this project',
            'build and fix',
            'compile the project',
            'compile this',
            'run the build',
            'fix build errors',
            'fix the build',
            'build it'
        ];
        
        return buildKeywords.some(keyword => lowerMessage.includes(keyword));
    }

    /**
     * Check if user is requesting batch analysis of files in a directory
     */
    private isDirectoryAnalysisRequest(userMessage: string): boolean {
        const lowerMessage = userMessage.toLowerCase();
        
        // Pattern 1: Action verbs + "files in/from" + path/folder/directory
        // Examples: "analyze files in /path", "look at files in folder X", "check files from directory Y"
        const actionPatterns = [
            /(analyze|scan|check|review|look at|examine|inspect|show|list).*files.*(in|from|at)/i,
            /(analyze|scan|check|review|examine|inspect).*(?:folder|directory|path)/i
        ];
        
        // Pattern 2: Absolute path mentioned (likely analyzing specific directory)
        // Examples: "files in /home/user/...", "analyze ~/Documents/..."
        const hasAbsolutePath = /(?:^|\s)(\/[\w\/\-\.]+|~\/[\w\/\-\.]+)/.test(userMessage);
        
        // Pattern 3: File extension mentioned (likely filtering specific types)
        // Examples: ".cu extension", "*.cpp files", ".py files"
        const hasFileExtension = /\.(cu|cpp|c|h|hpp|py|js|ts|java|rs|go|md|txt|json|yaml|yml)\s*(extension|files?)/i.test(userMessage);
        
        // Match if: (action + files pattern) OR (absolute path + extension)
        const matchesActionPattern = actionPatterns.some(pattern => pattern.test(userMessage));
        const matchesPathExtension = hasAbsolutePath && hasFileExtension;
        
        return matchesActionPattern || matchesPathExtension;
    }

    /**
     * Handle build-and-fix workflow
     */
    private async handleBuildAndFix(userMessage: string) {
        const statusBarManager = getStatusBarManager();
        
        try {
            // Get workspace folder
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                this.view?.webview.postMessage({
                    command: 'setTyping',
                    typing: false
                });
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: 'Please open a workspace folder first.'
                });
                return;
            }
            
            const workspaceRoot = workspaceFolder.uri.fsPath;
            
            // Show initial message
            this.view?.webview.postMessage({
                command: 'setTyping',
                typing: false
            });
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: '🔨 **Building project...**\n\nDetecting build system and running build...'
            });
            
            // Run the build
            const buildRunner = new BuildRunner(workspaceRoot);
            const buildResult = await buildRunner.runBuild();
            
            if (buildResult.success) {
                // Build succeeded!
                const successMessage = `✅ **Build successful!**\n\nCompleted in ${buildResult.duration}ms using ${buildResult.buildSystem}.`;
                
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: successMessage
                });
                
                this.conversationHistory.push({
                    role: 'assistant',
                    content: 'Build completed successfully'
                });
                
                vscode.window.showInformationMessage('✅ Build successful!');
                return;
            }
            
            // Build failed - parse errors
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: `❌ **Build failed** (${buildResult.buildSystem})\n\n🔍 Analyzing errors...`
            });

            const errorParser = new ErrorParser();
            const parsedErrors = errorParser.parseOutput(buildResult.output);

            if (parsedErrors.length === 0) {
                // No parseable errors — show whatever the build runner captured
                const rawText = buildResult.output.trim() || buildResult.errors.join('\n');
                const fallbackMessage = rawText
                    ? `❌ **Build failed** but I couldn't parse specific error lines.\n\n\`\`\`\n${rawText.substring(0, 2000)}\n\`\`\``
                    : `❌ **Build failed** with no output. Check that the build tool is installed and accessible.`;

                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: fallbackMessage
                });

                return;
            }
            
            // Show error summary
            const errorSummary = errorParser.summarizeErrors(parsedErrors);
            const errorDetails = parsedErrors.slice(0, 10).map(e => errorParser.formatError(e)).join('\n\n');
            
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: `📋 **Error Analysis:**\n\n${errorSummary}\n\n**Details:**\n${errorDetails}`
            });
            
            // Group errors by file
            const errorsByFile = this.groupErrorsByFile(parsedErrors);
            const fileCount = Object.keys(errorsByFile).length;
            
            // If multiple files have errors, use file-by-file approach
            if (fileCount > 1) {
                await this.fixErrorsByFile(errorsByFile, errorSummary);
                return;
            }
            
            // Single file or no file info - use original bulk approach
            // Generate fixes
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: '🤔 **Generating fixes...**'
            });
            
            const fixGenerator = new FixGenerator(this.client, this.projectScanner);
            const fixResult = await fixGenerator.generateFixPlan(parsedErrors);
            
            if (!fixResult.plan || fixResult.plan.steps.length === 0) {
                let errorMsg = '⚠️ **Could not generate an automatic fix plan.**\n\n';
                
                if (fixResult.error) {
                    errorMsg += `**Reason:** ${fixResult.error}\n\n`;
                }
                
                errorMsg += '**Suggestions:**\n';
                errorMsg += '• Check that Boudica API is accessible and authenticated\n';
                errorMsg += '• Review the errors above and try fixing obvious issues manually\n';
                errorMsg += '• For complex errors, ask specific questions about individual errors\n';
                errorMsg += '• Some errors may require understanding project architecture';
                
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: errorMsg
                });
                return;
            }
            
            const fixPlan = fixResult.plan;
            
            // Show fix plan
            const fixPlanMessage = this.formatModificationPlan(fixPlan);
            this.view?.webview.postMessage({
                command: 'addMessage',
                role: 'assistant',
                content: `🔧 **Fix Plan:**\n\n${fixPlanMessage}\n\n⏳ *Applying fixes...*`
            });
            
            // Mark as in progress
            this.isCreatingFiles = true;
            
            // Execute fixes
            const result = await executeModificationPlan(
                this.client,
                fixPlan,
                this.projectScanner,
                `Fix build errors: ${errorSummary}`,
                workspaceRoot,
                (step, total, message) => {
                    statusBarManager.showOperation('Fixing', `${message} (${step}/${total})`);
                }
            );
            
            this.isCreatingFiles = false;
            
            // Show fix results
            const totalChanges = result.filesModified.length + result.filesCreated.length;
            if (result.success && totalChanges > 0) {
                let resultMessage = `✅ **Applied ${totalChanges} fix(es)**\n\n`;
                
                if (result.filesModified.length > 0) {
                    resultMessage += `Modified: ${result.filesModified.join(', ')}\n`;
                }
                if (result.filesCreated.length > 0) {
                    resultMessage += `Created: ${result.filesCreated.join(', ')}\n`;
                }
                
                resultMessage += '\n🔨 **Rebuilding...**';
                
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'assistant',
                    content: resultMessage
                });
                
                // Rebuild
                const rebuildResult = await buildRunner.runBuild();
                
                if (rebuildResult.success) {
                    const successMessage = `✅ **Rebuild successful!**\n\nAll errors fixed! Build completed in ${rebuildResult.duration}ms.`;
                    
                    this.view?.webview.postMessage({
                        command: 'addMessage',
                        role: 'assistant',
                        content: successMessage
                    });
                    
                    this.conversationHistory.push({
                        role: 'assistant',
                        content: `Fixed ${parsedErrors.length} build errors and rebuilt successfully`
                    });
                    
                    vscode.window.showInformationMessage('✅ Build fixed and rebuilt successfully!');
                } else {
                    // Still has errors
                    const remainingErrors = errorParser.parseOutput(rebuildResult.output);
                    const remainingMessage = `⚠️ **Rebuild completed with ${remainingErrors.length} remaining error(s)**\n\nSome errors may require manual fixes.`;
                    
                    this.view?.webview.postMessage({
                        command: 'addMessage',
                        role: 'assistant',
                        content: remainingMessage
                    });
                    
                    vscode.window.showWarningMessage(`⚠️ ${remainingErrors.length} errors remaining after fixes`);
                }
            } else {
                this.view?.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: '⚠️ Failed to apply fixes. You may need to fix these errors manually.'
                });
            }
            
        } catch (error: any) {
            this.isCreatingFiles = false;
            
            statusBarManager.showError('Build failed');
            
            const errorMessage = `Failed to build project: ${error.message}`;
            
            if (this.view) {
                this.view.webview.postMessage({
                    command: 'setTyping',
                    typing: false
                });
                this.view.webview.postMessage({
                    command: 'addMessage',
                    role: 'error',
                    content: errorMessage
                });
            }
            
            vscode.window.showErrorMessage(`BoudiCode: ${errorMessage}`);
        }
    }

    /**
     * Restore conversation history when webview is reopened
     */
    private restoreConversationHistory() {
        if (!this.view) {
            console.log('[Extension] Cannot restore - no view');
            return;
        }
        
        if (this.conversationHistory.length === 0) {
            console.log('[Extension] No conversation history to restore');
            return;
        }

        console.log('[Extension] Restoring', this.conversationHistory.length, 'messages from conversation history');
        
        // Send all messages to recreate the conversation
        for (let i = 0; i < this.conversationHistory.length; i++) {
            const msg = this.conversationHistory[i];
            console.log(`[Extension] Restoring message ${i+1}/${this.conversationHistory.length}: ${msg.role}, content length: ${msg.content.length}`);
            this.view.webview.postMessage({
                command: 'addMessage',
                role: msg.role,
                content: msg.content
            });
        }
        
        console.log('[Extension] Finished restoring conversation history');
    }

    private async handleClearChat() {
        if (!this.view) return;
        
        this.conversationHistory = [];
        this.sessionId = `vscode-${Date.now()}`;
        this.view.webview.postMessage({
            command: 'clearMessages'
        });
        vscode.window.showInformationMessage('Chat cleared');
    }

    private async handleExportChat() {
        if (this.conversationHistory.length === 0) {
            vscode.window.showInformationMessage('No messages to export');
            return;
        }

        const content = this.conversationHistory.map(msg => {
            const role = msg.role === 'user' ? 'You' : 'Boudica';
            return `**${role}:**\n${msg.content}\n`;
        }).join('\n---\n\n');

        const doc = await vscode.workspace.openTextDocument({
            content: content,
            language: 'markdown'
        });

        await vscode.window.showTextDocument(doc);
    }

    private async handleIncludeFile() {
        if (!this.view) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No file is currently open');
            return;
        }

        const document = editor.document;
        const fileName = path.basename(document.fileName);
        const lineCount = document.lineCount;

        this.view.webview.postMessage({
            command: 'showFileIncluded',
            fileName: fileName,
            lineCount: lineCount
        });
    }

    private async getActiveFileContext(): Promise<string | undefined> {
        const editor = vscode.window.activeTextEditor;
        console.log('[Extension] getActiveFileContext - editor:', editor ? 'found' : 'not found');
        if (!editor) {
            return undefined;
        }

        const document = editor.document;
        const fileName = path.basename(document.fileName);
        const fullPath = document.fileName;
        const languageId = document.languageId;
        console.log('[Extension] Active file:', fileName, 'Language:', languageId);

        // Get full file content
        const fileContent = document.getText();
        console.log('[Extension] File content length:', fileContent.length);

        // Limit size to avoid overwhelming the context (max 50KB)
        const maxSize = 50000;
        const truncated = fileContent.length > maxSize;
        const content = truncated ? fileContent.substring(0, maxSize) + '\n\n... (truncated)' : fileContent;

        const contextString = `File: ${fileName}\nPath: ${fullPath}\nLanguage: ${languageId}\nLines: ${document.lineCount}\n\n\`\`\`${languageId}\n${content}\n\`\`\``;
        console.log('[Extension] Prepared context length:', contextString.length);
        return contextString;
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const nonce = this.getNonce();
        
        // Get logo URI for webview
        const logoUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'resources', 'logoanimated.svg')
        );
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src 'nonce-${nonce}' 'unsafe-hashes' 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>BoudiCode Chat</title>
    <style nonce="${nonce}">
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        #header {
            padding: 12px 16px;
            background-color: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        #header h2 {
            font-size: 14px;
            font-weight: 600;
        }

        #header-actions {
            display: flex;
            gap: 8px;
        }

        .icon-button {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
        }

        .icon-button:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        #messages {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .message {
            display: flex;
            flex-direction: column;
            gap: 6px;
            animation: fadeIn 0.2s ease-in;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message-header {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            font-weight: 600;
            opacity: 0.9;
        }

        .message.user .message-header {
            color: var(--vscode-textLink-foreground);
        }

        .message.assistant .message-header {
            color: var(--vscode-editorInfo-foreground);
        }

        .message.error .message-header {
            color: var(--vscode-errorForeground);
        }

        .message-content {
            padding: 10px 12px;
            border-radius: 6px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-wrap: break-word;
        }

        .message.user .message-content {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            font-size: 13px;
        }

        .message.assistant .message-content {
            background-color: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            font-family: var(--vscode-editor-font-family);
        }

        .message.error .message-content {
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            color: var(--vscode-errorForeground);
        }

        .message-meta {
            font-size: 11px;
            opacity: 0.6;
            margin-top: 4px;
        }

        #typing-indicator {
            display: none;
            padding: 8px 12px;
            font-size: 12px;
            opacity: 0.7;
            font-style: italic;
        }

        #typing-indicator.active {
            display: block;
        }

        #input-container {
            padding: 12px 16px;
            background-color: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: center;
            gap: 8px;
        }

        #input-wrapper {
            display: flex;
            gap: 8px;
            width: 90%;
            max-width: 900px;
        }

        #message-input {
            flex: 1;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 2px solid var(--vscode-input-border);
            padding: 8px 12px;
            border-radius: 4px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            resize: vertical;
            min-height: 60px;
            max-height: 200px;
            transition: border-color 0.3s ease;
        }

        #message-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }

        #message-input.waiting {
            border-color: #FFD700;
            animation: goldPulse 2s ease-in-out infinite;
        }

        @keyframes goldPulse {
            0%, 100% {
                border-color: #FFD700;
                box-shadow: 0 0 5px rgba(255, 215, 0, 0.5);
            }
            50% {
                border-color: #FFA500;
                box-shadow: 0 0 15px rgba(255, 215, 0, 0.8);
            }
        }

        #send-button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 600;
            font-size: 13px;
        }

        #send-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        #send-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        #welcome {
            text-align: center;
            padding: 40px 20px;
            opacity: 0.8;
        }

        #welcome-logo {
            width: 120px;
            height: 120px;
            margin: 0 auto 20px auto;
            display: block;
        }

        #welcome h3 {
            font-size: 16px;
            margin-bottom: 12px;
        }

        #welcome p {
            font-size: 13px;
            line-height: 1.6;
        }Chat</h2>
        <div id="header-actions">
            <button class="icon-button" id="include-file-button" title="Include active file as context">📎 Include File</button>
            <button class="icon-button" id="export-button" title="Export conversation">📄</button>
            <button class="icon-button" id="clear-button" title="Clear conversation">🗑️</button>
        </div>
    </div>
    
    <div id="file-context-info" style="display: none; padding: 8px 16px; background: var(--vscode-inputValidation-infoBackground); border-bottom: 1px solid var(--vscode-inputValidation-infoBorder); font-size: 11px;">
        <span id="file-context-text"></spanadding: 2px 6px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
        }

        pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            margin: 8px 0;
        }

        pre code {
            padding: 0;
            background: none;
        }

        #file-context-info {
            display: none;
            padding: 8px 16px;
            background: var(--vscode-inputValidation-infoBackground);
            border-bottom: 1px solid var(--vscode-inputValidation-infoBorder);
            font-size: 11px;
        }
    </style>
</head>
<body>
    <div id="header">
        <h2>💬 Chat</h2>
        <div id="header-actions">
            <button class="icon-button" id="include-file-button" title="Include active file as context">📎</button>
            <button class="icon-button" id="export-button" title="Export conversation">📄</button>
            <button class="icon-button" id="clear-button" title="Clear conversation">🗑️</button>
        </div>
    </div>
    
    <div id="file-context-info">
        <span id="file-context-text"></span>
    </div>

    <div id="messages">
        <div id="welcome">
            <img id="welcome-logo" src="${logoUri}" alt="Boudica Logo" />
            <h3>Welcome to BoudiCode Chat</h3>
            <p>Ask me anything about your code, request features, or discuss your development needs.<br>
            I can see your workspace context and help with coding tasks.</p>
        </div>
    </div>

    <div id="typing-indicator">Boudica is thinking...</div>

    <div id="input-container">
        <div id="input-wrapper">
            <textarea id="message-input" placeholder="Type your message..." rows="3"></textarea>
            <button id="send-button">Send</button>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const logoUri = '${logoUri}';
        const messagesDiv = document.getElementById('messages');
        const includeFileButton = document.getElementById('include-file-button');
        const fileContextInfo = document.getElementById('file-context-info');
        const fileContextText = document.getElementById('file-context-text');
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-button');
        const typingIndicator = document.getElementById('typing-indicator');
        const clearButton = document.getElementById('clear-button');
        const exportButton = document.getElementById('export-button');
        const welcome = document.getElementById('welcome');
        const inputWrapper = document.getElementById('input-wrapper');

        // Debug: Check if elements exist
        console.log('[Webview] Elements initialized:');
        console.log('  messageInput:', messageInput);
        console.log('  sendButton:', sendButton);
        console.log('  inputWrapper:', inputWrapper);
        if (inputWrapper) {
            const styles = window.getComputedStyle(inputWrapper);
            console.log('  inputWrapper width:', styles.width);
            console.log('  inputWrapper display:', styles.display);
        }

        // Handle sending messages
        function sendMessage() {
            console.log('sendMessage called');
            const text = messageInput.value.trim();
            console.log('Message text:', text);
            if (!text) {
                console.log('No text, returning');
                return;
            }

            console.log('Posting message to extension');
            vscode.postMessage({
                command: 'sendMessage',
                text: text
            });

            messageInput.value = '';
            messageInput.style.height = 'auto';
            sendButton.disabled = true;
        }

        console.log('Setting up event listeners');
        console.log('sendButton:', sendButton);
        console.log('messageInput:', messageInput);
        
        sendButton.addEventListener('click', () => {
            console.log('Send button clicked!');
            sendMessage();
        });

        messageInput.addEventListener('keydown', (e) => {
            console.log('Key pressed:', e.key);
            if (e.key === 'Enter' && !e.shiftKey) {
                console.log('Enter key pressed, sending message');
                e.preventDefault();
                sendMessage();
            }
        });

        messageInput.addEventListener('input', () => {
            sendButton.disabled = !messageInput.value.trim();
            
            // Auto-resize textarea (respects min-height of 60px)
            messageInput.style.height = 'auto';
            const newHeight = Math.max(60, Math.min(messageInput.scrollHeight, 200));
            messageInput.style.height = newHeight + 'px';
        });

        clearButton.addEventListener('click', () => {
            if (confirm('Clear all messages?')) {
                vscode.postMessage({ command: 'clearChat' });
            }
        });

        exportButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'exportChat' });
        });

        includeFileButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'includeFile' });
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.command) {
                case 'addMessage':
                    addMessage(message.role, message.content, message.tokensPerSecond);
                    break;
                case 'startStreamMessage':
                    startStreamMessage(message.id);
                    break;
                case 'appendStreamChunk':
                    appendStreamChunk(message.id, message.text);
                    break;
                case 'endStreamMessage':
                    endStreamMessage(message.id, message.tokensPerSecond);
                    break;
                case 'setTyping':
                    console.log('[Webview] setTyping called, typing:', message.typing);
                    typingIndicator.classList.toggle('active', message.typing);
                    messageInput.classList.toggle('waiting', message.typing);
                    messageInput.disabled = message.typing;
                    sendButton.disabled = message.typing;
                    console.log('[Webview] messageInput classes:', messageInput.className);
                    console.log('[Webview] messageInput disabled:', messageInput.disabled);
                    break;
                case 'clearMessages':
                    messagesDiv.innerHTML = '<div id="welcome"><img id="welcome-logo" src="' + logoUri + '" alt="Boudica Logo" /><h3>Welcome to BoudiCode Chat</h3><p>Ask me anything about your code, request features, or discuss your development needs.<br>I can see your workspace context and help with coding tasks.</p></div>';
                    break;
                case 'showFileIncluded':
                    fileContextText.textContent = '📎 Including: ' + message.fileName + ' (' + message.lineCount + ' lines)';
                    fileContextInfo.style.display = 'block';
                    setTimeout(() => {
                        fileContextInfo.style.display = 'none';
                    }, 3000);
                    break;
                case 'showFixPreview':
                    addMessage('assistant', message.previewContent);
                    addFixButtons(message.file, message.fileNum, message.totalFiles);
                    break;
            }
        });

        // Streaming helpers
        const streamingMessages = {};

        function startStreamMessage(id) {
            const welcomeEl = document.getElementById('welcome');
            if (welcomeEl) { welcomeEl.remove(); }

            const messageDiv = document.createElement('div');
            messageDiv.className = 'message assistant';
            messageDiv.id = 'stream-' + id;

            const header = document.createElement('div');
            header.className = 'message-header';
            header.textContent = '🤖 Boudica';

            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            contentDiv.id = 'stream-content-' + id;
            contentDiv.textContent = '';

            messageDiv.appendChild(header);
            messageDiv.appendChild(contentDiv);
            messagesDiv.appendChild(messageDiv);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
            streamingMessages[id] = contentDiv;
        }

        function appendStreamChunk(id, text) {
            const contentDiv = streamingMessages[id];
            if (contentDiv) {
                contentDiv.textContent += text;
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }
        }

        function endStreamMessage(id, tokensPerSecond) {
            const contentDiv = streamingMessages[id];
            if (contentDiv) {
                const messageDiv = document.getElementById('stream-' + id);
                if (tokensPerSecond && messageDiv) {
                    const meta = document.createElement('div');
                    meta.className = 'message-meta';
                    meta.textContent = '⚡ ' + tokensPerSecond.toFixed(1) + ' tokens/sec';
                    messageDiv.appendChild(meta);
                }
                delete streamingMessages[id];
            }
            sendButton.disabled = false;
        }

        function addMessage(role, content, tokensPerSecond) {
            // Remove welcome message if present
            const welcomeEl = document.getElementById('welcome');
            if (welcomeEl) {
                welcomeEl.remove();
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ' + role;

            const header = document.createElement('div');
            header.className = 'message-header';
            const icon = role === 'user' ? '👤' : role === 'assistant' ? '🤖' : '⚠️';
            const name = role === 'user' ? 'You' : role === 'assistant' ? 'Boudica' : 'Error';
            header.textContent = icon + ' ' + name;

            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            contentDiv.textContent = content;

            messageDiv.appendChild(header);
            messageDiv.appendChild(contentDiv);

            if (tokensPerSecond) {
                const meta = document.createElement('div');
                meta.className = 'message-meta';
                meta.textContent = '⚡ ' + tokensPerSecond.toFixed(1) + ' tokens/sec';
                messageDiv.appendChild(meta);
            }

            messagesDiv.appendChild(messageDiv);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;

            // Re-enable send button
            sendButton.disabled = false;
        }

        function addFixButtons(fileName, fileNum, totalFiles) {
            const buttonsDiv = document.createElement('div');
            buttonsDiv.className = 'fix-buttons';
            buttonsDiv.style.display = 'flex';
            buttonsDiv.style.gap = '8px';
            buttonsDiv.style.marginTop = '12px';
            buttonsDiv.style.padding = '8px';
            buttonsDiv.style.borderTop = '1px solid var(--vscode-panel-border)';

            const approveBtn = document.createElement('button');
            approveBtn.textContent = '✅ Apply Fix';
            approveBtn.className = 'fix-button approve';
            approveBtn.style.flex = '1';
            approveBtn.style.padding = '8px 16px';
            approveBtn.style.backgroundColor = 'var(--vscode-button-background)';
            approveBtn.style.color = 'var(--vscode-button-foreground)';
            approveBtn.style.border = 'none';
            approveBtn.style.borderRadius = '4px';
            approveBtn.style.cursor = 'pointer';
            approveBtn.onclick = () => {
                vscode.postMessage({ command: 'applyFix', fileName: fileName });
                buttonsDiv.remove();
            };

            const skipBtn = document.createElement('button');
            skipBtn.textContent = '⏭️ Skip';
            skipBtn.className = 'fix-button skip';
            skipBtn.style.flex = '1';
            skipBtn.style.padding = '8px 16px';
            skipBtn.style.backgroundColor = 'var(--vscode-button-secondaryBackground)';
            skipBtn.style.color = 'var(--vscode-button-secondaryForeground)';
            skipBtn.style.border = 'none';
            skipBtn.style.borderRadius = '4px';
            skipBtn.style.cursor = 'pointer';
            skipBtn.onclick = () => {
                vscode.postMessage({ command: 'skipFix', fileName: fileName });
                buttonsDiv.remove();
            };

            buttonsDiv.appendChild(approveBtn);
            buttonsDiv.appendChild(skipBtn);

            // Add "Apply All" button only after last file
            if (fileNum === totalFiles) {
                const applyAllBtn = document.createElement('button');
                applyAllBtn.textContent = '⚡ Apply All & Rebuild';
                applyAllBtn.className = 'fix-button apply-all';
                applyAllBtn.style.flex = '1';
                applyAllBtn.style.padding = '8px 16px';
                applyAllBtn.style.backgroundColor = '#007ACC';
                applyAllBtn.style.color = 'white';
                applyAllBtn.style.border = 'none';
                applyAllBtn.style.borderRadius = '4px';
                applyAllBtn.style.cursor = 'pointer';
                applyAllBtn.style.fontWeight = 'bold';
                applyAllBtn.onclick = () => {
                    vscode.postMessage({ command: 'applyAllFixes' });
                    // Remove all fix button groups
                    document.querySelectorAll('.fix-buttons').forEach(el => el.remove());
                };
                buttonsDiv.appendChild(applyAllBtn);
            }

            messagesDiv.appendChild(buttonsDiv);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }

        // Focus input on load
        messageInput.focus();
        
        // Signal that webview is ready to receive messages
        vscode.postMessage({ command: 'webviewReady' });
    </script>
</body>
</html>`;
    }
}
