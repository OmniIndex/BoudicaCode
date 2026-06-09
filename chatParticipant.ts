/**
 * Chat Participant - Native VS Code Chat Integration
 * Provides @boudica participant for VS Code's built-in Chat panel
 */

import * as vscode from 'vscode';
import { BoudicaClient, ChatRequest } from './boudicaClient';
import { SessionManager } from './sessionManager';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

interface ChatContext {
    fileReferences: Array<{ uri: vscode.Uri; content: string }>;
    prompt: string;
    externalFiles?: string[];  // Files outside workspace
}

/**
 * Check if a file path is within any workspace folder
 */
function isPathInWorkspace(filePath: string): boolean {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        // No workspace open - treat all files as external
        return false;
    }
    
    // Normalize path for comparison
    const normalizedPath = filePath.replace(/\\/g, '/');
    
    return folders.some(folder => {
        const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
        return normalizedPath.startsWith(folderPath);
    });
}

/**
 * Register @boudica chat participant
 */
export function registerChatParticipant(
    context: vscode.ExtensionContext,
    client: BoudicaClient,
    sessionManager: SessionManager
): vscode.Disposable {
    
    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<void> => {
        
        // Parse request to understand intent
        const requestContext = await parseRequest(request, chatContext);
        
        // Track response for session logging
        let responseText = '';
        const startTime = Date.now();
        
        try {
            // Check for session search first
            if (SessionManager.isSessionSearchRequest(request.prompt)) {
                responseText = await handleSessionSearch(request, stream, sessionManager);
                return;
            }
            
            // Check for file creation BEFORE project creation (more specific)
            // This prevents false positives like "create ... applicationCreator.ts" from triggering project mode
            if (isFileCreationRequest(request.prompt)) {
                responseText = await handleFileCreation(request, requestContext, stream, client, token);
            }
            // Check for project creation - hand off to sidebar
            else if (isProjectCreationRequest(request.prompt)) {
                await handleProjectCreationHandoff(request, stream);
                responseText = 'Project creation handed off to sidebar';
                return;
            }
            // Determine request type and route accordingly
            // Check directory analysis BEFORE file analysis (more specific)
            else if (isDirectoryAnalysisRequest(request.prompt)) {
                responseText = await handleDirectoryAnalysis(request, requestContext, stream, client, token);
            } else if (isFileAnalysisRequest(request.prompt)) {
                responseText = await handleFileAnalysis(request, requestContext, stream, client, token);
            } else if (isCodeCreationRequest(request.prompt)) {
                responseText = await handleCodeCreation(request, requestContext, stream, client, token);
            } else if (isCodeUpdateRequest(request.prompt)) {
                responseText = await handleCodeUpdate(request, requestContext, stream, client, token);
            } else {
                // General chat/explanation
                responseText = await handleGeneralChat(request, requestContext, stream, client, token);
            }
        } catch (error: any) {
            stream.markdown(`\n\n❌ **Error**: ${error.message}\n`);
            console.error('[ChatParticipant] Error:', error);
            responseText = `Error: ${error.message}`;
        } finally {
            // Log interaction to session (unless it was a session search)
            if (!SessionManager.isSessionSearchRequest(request.prompt)) {
                const fileNames = requestContext.fileReferences.map(ref => path.basename(ref.uri.fsPath));
                sessionManager.logInteraction('native', request.prompt, responseText, fileNames);
                
                const elapsedTime = Date.now() - startTime;
                console.log(`[ChatParticipant] Logged session interaction (${elapsedTime}ms)`);
            }
        }
    };

    const participant = vscode.chat.createChatParticipant('boudica', handler);
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'boudica-icon.png');
    
    context.subscriptions.push(participant);
    
    return participant;
}

/**
 * Parse request and extract context (file references, etc.)
 */
async function parseRequest(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext
): Promise<ChatContext> {
    const fileReferences: Array<{ uri: vscode.Uri; content: string }> = [];
    const externalFiles: string[] = [];
    
    // Get configuration setting for external files
    const config = vscode.workspace.getConfiguration('boudicode');
    const allowExternalFiles = config.get<boolean>('allowExternalFiles', true);
    
    console.log('[ChatParticipant] parseRequest called');
    console.log('[ChatParticipant] request.references count:', request.references.length);
    console.log('[ChatParticipant] references:', JSON.stringify(request.references.map(r => ({ id: r.id, type: typeof r.value })), null, 2));
    
    // Extract file references from request (VS Code provides these from #file: syntax)
    for (const ref of request.references) {
        console.log('[ChatParticipant] Processing reference:', ref.id);
        
        // Try both 'vscode.file' and just 'file' as the ID
        if ((ref.id === 'vscode.file' || ref.id === 'file') && ref.value) {
            console.log('[ChatParticipant] Found file reference, value type:', typeof ref.value);
            
            // Handle both URI objects and plain objects with uri property
            let uri: vscode.Uri | undefined;
            if (ref.value instanceof vscode.Uri) {
                uri = ref.value;
            } else if (typeof ref.value === 'object' && 'uri' in ref.value) {
                uri = (ref.value as { uri: vscode.Uri }).uri;
            } else if (typeof ref.value === 'object' && '$mid' in ref.value) {
                // VS Code URI object serialized
                uri = vscode.Uri.from(ref.value as any);
            }
            
            if (!uri) {
                console.warn('[ChatParticipant] Could not extract URI from reference:', ref);
                continue;
            }
            
            console.log('[ChatParticipant] Extracted URI:', uri.fsPath);
            
            // Check workspace boundary
            if (!isPathInWorkspace(uri.fsPath)) {
                externalFiles.push(uri.fsPath);
                if (!allowExternalFiles) {
                    console.warn(`[ChatParticipant] Blocked external file (setting disabled): ${uri.fsPath}`);
                    continue;  // Skip this file
                }
            }
            
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                fileReferences.push({
                    uri,
                    content: Buffer.from(content).toString('utf-8')
                });
            } catch (err) {
                console.error(`[ChatParticipant] Failed to read ${uri.fsPath}:`, err);
            }
        }
    }
    
    // Also extract file paths mentioned in natural language prompt
    // Patterns: "in the file /path/to/file", "analyze /path/to/file.cpp", etc.
    // Made flexible to handle typos and various phrasings
    const filePathPatterns = [
        // Absolute paths with any preceding context (handles typos like "teh file")
        /(\/[\w\/\.\-_]+\.(?:cpp|c|h|hpp|cc|cxx|py|js|ts|tsx|jsx|cu|java|rs|go|md|txt|json|yaml|yml|sh|php|rb|swift|kt))/gi,
        // Home directory paths with any preceding context
        /(~\/[\w\/\.\-_]+\.(?:cpp|c|h|hpp|cc|cxx|py|js|ts|tsx|jsx|cu|java|rs|go|md|txt|json|yaml|yml|sh|php|rb|swift|kt))/gi,
        // Relative workspace paths (content/folder/file.ext)
        /(?:^|\s|file:?\s+)([\w][\w\/\.\-_]*\/[\w\/\.\-_]+\.(?:cpp|c|h|hpp|cc|cxx|py|js|ts|tsx|jsx|cu|java|rs|go|md|txt|json|yaml|yml|sh|php|rb|swift|kt))/gi
    ];
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const seenPaths = new Set<string>();
    
    for (const pattern of filePathPatterns) {
        let match;
        while ((match = pattern.exec(request.prompt)) !== null) {
            let filePath = match[1];
            
            console.log('[ChatParticipant] Matched file path from prompt:', filePath);
            
            // Expand ~ to home directory
            if (filePath.startsWith('~')) {
                filePath = filePath.replace(/^~/, os.homedir());
            }
            // Resolve relative paths to workspace
            else if (!filePath.startsWith('/') && workspaceFolder) {
                filePath = path.join(workspaceFolder.uri.fsPath, filePath);
                console.log('[ChatParticipant] Resolved to workspace path:', filePath);
            }
            
            // Skip if already processed
            if (seenPaths.has(filePath)) continue;
            seenPaths.add(filePath);
            
            // Check workspace boundary
            if (!isPathInWorkspace(filePath)) {
                externalFiles.push(filePath);
                if (!allowExternalFiles) {
                    console.warn(`[ChatParticipant] Blocked external file (setting disabled): ${filePath}`);
                    continue;  // Skip this file
                }
            }
            
            try {
                const uri = vscode.Uri.file(filePath);
                const content = await vscode.workspace.fs.readFile(uri);
                fileReferences.push({
                    uri,
                    content: Buffer.from(content).toString('utf-8')
                });
                console.log(`[ChatParticipant] Extracted file from prompt: ${filePath}`);
            } catch (err) {
                console.error(`[ChatParticipant] Failed to read file from prompt ${filePath}:`, err);
            }
        }
    }
    
    return {
        fileReferences,
        prompt: request.prompt,
        externalFiles: externalFiles.length > 0 ? externalFiles : undefined
    };
}

/**
 * Check if request is asking for file analysis
 */
function isFileAnalysisRequest(prompt: string): boolean {
    const lowerPrompt = prompt.toLowerCase();
    return /analyze|review|check|inspect|examine|explain|security|memory|leak|bug|issue|problem/.test(lowerPrompt);
}

/**
 * Check if request is asking for directory analysis
 */
function isDirectoryAnalysisRequest(prompt: string): boolean {
    const lowerPrompt = prompt.toLowerCase();
    
    // CRITICAL CHECK: If prompt mentions a specific file path AS THE SUBJECT (ends with extension),
    // this might be FILE analysis, not directory analysis. But SKIP this check if prompt
    // also mentions "save to" or "write to" (indicating the file is output, not input).
    // Pattern: "/path/to/file.ext" or "~/path/to/file.ext" (NOT ending with /)
    const hasOutputFile = /(save|write|export|output|create).*(?:to|as|in)\s+[\w\/\-\.]+\.(md|txt|json|html|css|yaml|yml)/i.test(prompt);
    
    if (!hasOutputFile) {
        const specificFilePattern = /(\/[\w\/\-\.]+\.(?:cpp|c|h|hpp|cc|cxx|py|js|ts|tsx|jsx|cu|java|rs|go|md|txt|json|yaml|yml|sh|php|rb|swift|kt))(?:\s|$|,|\.|;)/i;
        if (specificFilePattern.test(prompt)) {
            console.log('[ChatParticipant] Detected specific file path - NOT directory analysis');
            return false;
        }
    }
    
    // Pattern 1: Action verbs + folder/directory/files
    // Examples: "look in folder", "analyze files in /path", "check directory"
    const actionPatterns = [
        /(analyze|scan|check|review|look|look at|look in|examine|inspect|show|list|find|search).*(?:folder|directory|path)/i,
        /(analyze|scan|check|review|look at|examine|inspect|find).*files.*(in|from|at)/i,
        // NEW: Match "files in [path]" or "using files in" without requiring action verbs
        /files?\s+(in|from|at)\s+(the\s+)?(folder|directory|path)/i,
        /(using|with|use)\s+.*files?\s+(in|from)/i
    ];
    
    // Pattern 2: Path mentioned (absolute OR relative with folder indicators)
    // Examples: "files in /home/user/...", "look in ~/Documents/...", "files in content/boudicode/src"
    const hasPath = /(?:^|\s)(\/[\w\/\-\.]+|~\/[\w\/\-\.]+|[\w\/\-\.]+\/[\w\/\-\.]+)/.test(prompt);
    
    // Pattern 3: File extension mentioned (likely filtering specific types)
    // Examples: ".cu extension", "*.cpp files", ".py files"
    const hasFileExtension = /\.(cu|cpp|c|h|hpp|py|js|ts|java|rs|go|md|txt|json|yaml|yml)\s*(extension|files?)/i.test(prompt);
    
    return actionPatterns.some(pattern => pattern.test(prompt)) || 
           (hasPath && /files?|folder|directory/.test(lowerPrompt)) ||
           hasFileExtension;
}

/**
 * Check if request is asking for project creation (multi-file)
 */
function isProjectCreationRequest(prompt: string): boolean {
    const lowerPrompt = prompt.toLowerCase();
    // Matches: "create a project", "build an application", "generate a CLI tool with multiple files"
    return /(create|generate|make|build|scaffold|setup).*(?:project|app|application|program|tool|system)/.test(lowerPrompt) ||
           /(create|generate|write).*(?:multiple files?|several files?|full .* implementation)/.test(lowerPrompt) ||
           /(?:project|app|application).*(?:with|using|include).*(?:cmake|makefile|build system|package\.json)/.test(lowerPrompt);
}

/**
 * Check if request is asking to create new code
 */
function isCodeCreationRequest(prompt: string): boolean {
    const lowerPrompt = prompt.toLowerCase();
    return /(create|generate|write|make|build).*(?:file|function|class|method|code)/.test(lowerPrompt) &&
           !/(?:project|app|application|multiple|several)/.test(lowerPrompt);
}

/**
 * Check if request is asking to update existing code
 */
function isCodeUpdateRequest(prompt: string): boolean {
    const lowerPrompt = prompt.toLowerCase();
    return /(update|modify|change|fix|refactor|improve|add|remove)/.test(lowerPrompt);
}

/**
 * Check if request is asking to create and save a file
 */
function isFileCreationRequest(prompt: string): boolean {
    const lowerPrompt = prompt.toLowerCase();
    // Matches: "save to", "save this file to", "write to", "create [file] and save"
    return /(save|write).*(?:to|in|as).*\.(?:md|txt|json|cpp|py|js|ts|html|css)/.test(lowerPrompt) ||
           /create.*(?:file|markdown|document).*(?:save|to|as)/.test(lowerPrompt) ||
           /(?:save|write|export).*file.*to/.test(lowerPrompt);
}

/**
 * Extract target file path from prompt
 */
function extractTargetFilePath(prompt: string): string | null {
    // Pattern 1: "save to path/file.ext" or "save this file to path/file.ext"
    const saveToPattern = /(?:save|write|export).*(?:to|as|in)\s+([\/\w\-\.~]+\.(?:md|txt|json|cpp|py|js|ts|html|css|yaml|yml|sh))/i;
    const match1 = prompt.match(saveToPattern);
    if (match1) {
        return match1[1];
    }
    
    // Pattern 2: "create path/file.ext" 
    const createPattern = /(?:create|generate)\s+([\/\w\-\.~]+\.(?:md|txt|json|cpp|py|js|ts|html|css|yaml|yml|sh))/i;
    const match2 = prompt.match(createPattern);
    if (match2) {
        return match2[1];
    }
    
    return null;
}

/**
 * Handle session search requests
 */
async function handleSessionSearch(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    sessionManager: SessionManager
): Promise<string> {
    
    const scope = SessionManager.getSearchScope(request.prompt);
    const query = SessionManager.extractSearchQuery(request.prompt);
    
    stream.markdown('🔍 **Searching session history**\n\n');
    
    let results;
    if (scope === 'today') {
        const todayDate = sessionManager.getTodayDate();
        const interactions = sessionManager.getSessionByDate(todayDate);
        results = interactions.map((interaction, index) => ({
            date: todayDate,
            index: index + 1,
            interaction,
            score: 10
        }));
        stream.markdown(`📅 Searching today's session (${todayDate})\n\n`);
    } else if (scope === 'yesterday') {
        const yesterdayDate = sessionManager.getYesterdayDate();
        const interactions = sessionManager.getSessionByDate(yesterdayDate);
        results = interactions.map((interaction, index) => ({
            date: yesterdayDate,
            index: index + 1,
            interaction,
            score: 10
        }));
        stream.markdown(`📅 Searching yesterday's session (${yesterdayDate})\n\n`);
    } else {
        // Search all (last 10 days)
        results = sessionManager.searchSessions(query, 10);
        stream.markdown(`📅 Searching last 10 days for: "${query}"\n\n`);
    }
    
    if (results.length === 0) {
        stream.markdown('❌ **No results found**\n\n');
        stream.markdown('Try a different search term or check a different day.\n');
        return 'No session results found';
    }
    
    stream.markdown(`✅ **Found ${results.length} interaction${results.length > 1 ? 's' : ''}**\n\n`);
    stream.markdown('---\n\n');
    
    // Display results
    for (let i = 0; i < Math.min(results.length, 20); i++) {
        const result = results[i];
        const time = new Date(result.interaction.timestamp).toLocaleTimeString();
        const sourceIcon = result.interaction.source === 'native' ? '💬' : '📋';
        
        stream.markdown(`### ${i + 1}. ${sourceIcon} ${result.date} at ${time}\n\n`);
        
        // Show user prompt (truncated if too long)
        const userPrompt = result.interaction.user.length > 150 
            ? result.interaction.user.substring(0, 150) + '...'
            : result.interaction.user;
        stream.markdown(`**You asked:** ${userPrompt}\n\n`);
        
        // Show response (truncated if too long)
        const assistantResponse = result.interaction.assistant.length > 300
            ? result.interaction.assistant.substring(0, 300) + '...'
            : result.interaction.assistant;
        stream.markdown(`**Boudica:** ${assistantResponse}\n\n`);
        
        // Show files if any
        if (result.interaction.files.length > 0) {
            stream.markdown(`📎 Files: ${result.interaction.files.join(', ')}\n\n`);
        }
        
        stream.markdown('---\n\n');
    }
    
    if (results.length > 20) {
        stream.markdown(`\n_Showing first 20 of ${results.length} results_\n`);
    }
    
    return `Found ${results.length} session interactions`;
}

/**
 * Handle project creation by handing off to sidebar
 */
async function handleProjectCreationHandoff(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream
): Promise<void> {
    
    stream.markdown('🔄 **Multi-file project creation detected**\n\n');
    stream.markdown('This requires the BoudiCode sidebar for:\n');
    stream.markdown('- File-by-file progress tracking\n');
    stream.markdown('- Build system generation\n');
    stream.markdown('- Incremental validation\n\n');
    
    stream.markdown('Opening BoudiCode sidebar...\n\n');
    
    try {
        // Focus the sidebar
        await vscode.commands.executeCommand('boudicodeChat.focus');
        
        // Small delay to ensure sidebar is ready
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Send prompt to sidebar
        await vscode.commands.executeCommand('boudicode.sendPromptToSidebar', request.prompt);
        
        stream.markdown('✅ **Project creation started in sidebar**\n\n');
        stream.markdown('Watch the BoudiCode panel for progress updates.\n');
        
        // Offer to show sidebar if it's not visible
        stream.button({
            command: 'boudicodeChat.focus',
            title: '👁️ Show Sidebar',
            arguments: []
        });
        
    } catch (error: any) {
        stream.markdown(`⚠️ **Could not open sidebar**: ${error.message}\n\n`);
        stream.markdown('Please click the BoudiCode icon in the Activity Bar and try again.\n');
    }
}

/**
 * Handle file analysis requests
 */
async function handleFileAnalysis(
    request: vscode.ChatRequest,
    context: ChatContext,
    stream: vscode.ChatResponseStream,
    client: BoudicaClient,
    token: vscode.CancellationToken
): Promise<string> {
    
    if (context.fileReferences.length === 0) {
        stream.markdown('⚠️ **No files referenced**\n\nUse `#file:path` to attach files for analysis.\n\nExample: `@boudica #file:main.cpp analyze for memory leaks`\n');
        return 'No files referenced';
    }
    
    stream.markdown(`🔍 **Analyzing ${context.fileReferences.length} file(s)...**\n\n`);
    
    // Show warning if external files are being accessed
    if (context.externalFiles && context.externalFiles.length > 0) {
        stream.markdown('⚠️ **External files detected** (outside workspace):\n\n');
        context.externalFiles.forEach(file => {
            const fileName = path.basename(file);
            stream.markdown(`- \`${fileName}\` (${file})\n`);
        });
        stream.markdown('\n_To disable external file access, set `boudicode.allowExternalFiles` to `false` in settings._\n\n');
    }
    
    // Combine all file contents
    const combinedContent = context.fileReferences.map(ref => {
        const fileName = path.basename(ref.uri.fsPath);
        return `// File: ${fileName}\n${ref.content}\n`;
    }).join('\n' + '='.repeat(80) + '\n\n');
    
    const fileName = context.fileReferences.length === 1 
        ? path.basename(context.fileReferences[0].uri.fsPath)
        : `${context.fileReferences.length}_files.txt`;
    
    // Send to Boudica
    const chatRequest: ChatRequest = {
        message: request.prompt,
        session_id: 'vscode-chat-participant',
        file_content: combinedContent,
        file_name: fileName
    };
    
    const response = await client.chat(chatRequest);
    
    if (response.error) {
        stream.markdown(`❌ **Error**: ${response.error}\n`);
        return `Error: ${response.error}`;
    } else {
        // Stream response (simulate streaming by chunking)
        await streamMarkdown(stream, response.response || 'Analysis complete', token);
        
        if (response.tokens_per_second) {
            stream.markdown(`\n\n_Processing speed: ${response.tokens_per_second.toFixed(0)} tokens/sec_\n`);
        }
        
        return response.response || 'Analysis complete';
    }
}

/**
 * Extract multiple folder paths from prompt for reference/target comparison
 */
function extractMultipleFolderPaths(prompt: string): { reference?: string; target?: string } | null {
    // Pattern 1: "reference source is in X ... folder Y"
    const referencePattern = /(?:reference|ref|base).*?(?:in|from)\s+(?:the\s+)?(folder|directory|path)\s+([\w][\w\/\-\.]*)/i;
    const targetPattern = /(?:folder|directory|path)\s+([\w][\w\/\-\.]+)(?!.*(?:reference|ref|base))/i;
    
    const refMatch = prompt.match(referencePattern);
    
    // Find all folder mentions
    const allFolderMatches = prompt.matchAll(/(?:folder|directory|path)\s+([\w][\w\/\-\.]+)/gi);
    const folderPaths = Array.from(allFolderMatches).map(m => m[1]);
    
    if (folderPaths.length >= 2) {
        return {
            reference: refMatch ? refMatch[2] : folderPaths[0],
            target: folderPaths[folderPaths.length - 1]
        };
    }
    
    return null;
}

/**
 * Handle directory analysis requests
 */
async function handleDirectoryAnalysis(
    request: vscode.ChatRequest,
    context: ChatContext,
    stream: vscode.ChatResponseStream,
    client: BoudicaClient,
    token: vscode.CancellationToken
): Promise<string> {
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    
    // Check for multi-folder analysis first
    const multipleFolders = extractMultipleFolderPaths(request.prompt);
    
    if (multipleFolders && multipleFolders.reference && multipleFolders.target) {
        console.log('[DirectoryAnalysis] Multi-folder analysis detected');
        console.log('[DirectoryAnalysis] Reference:', multipleFolders.reference);
        console.log('[DirectoryAnalysis] Target:', multipleFolders.target);
        
        stream.markdown(`📚 **Multi-folder analysis**\n\n`);
        
        // Resolve both paths
        const resolvePath = (p: string) => {
            if (p.startsWith('/') || p.startsWith('~')) {
                return p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p;
            }
            return workspaceFolder ? path.join(workspaceFolder.uri.fsPath, p) : p;
        };
        
        const refPath = resolvePath(multipleFolders.reference);
        const targetPath = resolvePath(multipleFolders.target);
        
        stream.markdown(`🔹 **Reference**: \`${refPath}\`\n`);
        stream.markdown(`🔸 **Target**: \`${targetPath}\`\n\n`);
        
        // Read both directories
        const readDirectory = async (dirPath: string, label: string) => {
            try {
                const uri = vscode.Uri.file(dirPath);
                const pattern = new vscode.RelativePattern(uri, '**/*');
                const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 50);
                
                if (files.length === 0) {
                    stream.markdown(`⚠️ No files found in ${label}: \`${dirPath}\`\n\n`);
                    return '';
                }
                
                stream.markdown(`📂 ${label}: Found ${files.length} file(s)\n`);
                
                const fileContents: string[] = [];
                let totalSize = 0;
                const maxSize = 250000; // 250KB per directory
                
                for (const fileUri of files) {
                    try {
                        const content = fs.readFileSync(fileUri.fsPath, 'utf-8');
                        const relativePath = path.relative(dirPath, fileUri.fsPath);
                        
                        if (totalSize + content.length > maxSize) {
                            stream.markdown(`⚠️ Size limit reached for ${label}\n`);
                            break;
                        }
                        
                        fileContents.push(`// File: ${relativePath}\n${content}\n`);
                        totalSize += content.length;
                    } catch (err) {
                        console.error(`Failed to read ${fileUri.fsPath}:`, err);
                    }
                }
                
                return `\n${'='.repeat(80)}\n${label.toUpperCase()} FILES (${dirPath})\n${'='.repeat(80)}\n\n` + 
                       fileContents.join('\n' + '-'.repeat(80) + '\n\n');
            } catch (error: any) {
                stream.markdown(`❌ Error reading ${label}: ${error.message}\n`);
                return '';
            }
        };
        
        const referenceContent = await readDirectory(refPath, 'Reference');
        const targetContent = await readDirectory(targetPath, 'Target');
        
        if (!referenceContent && !targetContent) {
            stream.markdown('\n❌ **No files found in either directory**\n');
            return 'No files found';
        }
        
        stream.markdown('\n🤖 **Analyzing...**\n\n');
        
        // Send to Boudica with clear context
        const combinedContent = referenceContent + '\n\n' + targetContent;
        const enhancedPrompt = `${request.prompt}\n\nCONTEXT: You have been provided with TWO sets of source code:\n1. REFERENCE files from ${refPath} - use these as the correct implementation pattern\n2. TARGET files from ${targetPath} - analyze these against the reference\n\nPlease compare the target files against the reference and provide detailed analysis.`;
        
        const chatRequest: ChatRequest = {
            message: enhancedPrompt,
            session_id: 'vscode-chat-participant',
            file_content: combinedContent,
            file_name: 'multi_folder_analysis.txt'
        };
        
        const response = await client.chat(chatRequest);
        
        if (response.error) {
            stream.markdown(`❌ **Error**: ${response.error}\n`);
            return `Error: ${response.error}`;
        } else {
            await streamMarkdown(stream, response.response || 'Analysis complete', token);
            return response.response || 'Analysis complete';
        }
    }
    
    // Single folder analysis (existing logic)
    // Extract directory path and extension from prompt
    // Match relative paths FIRST (more specific), then absolute paths
    // CRITICAL: Require "folder|directory|path" keyword to avoid matching random words like "code in the prompt"
    const relativePathMatch = request.prompt.match(/(?:in|from|at)\s+(?:the\s+)?(folder|directory|path)\s+([\w][\w\/\-\.]*)/i);
    // Absolute paths must start at word boundary or after whitespace (avoid matching internal slashes)
    const absolutePathMatch = request.prompt.match(/(?:^|\s)(\/[\w\/\-\.]+|~\/[\w\/\-\.]+)/);
    
    const pathMatch = relativePathMatch ? [relativePathMatch[0], relativePathMatch[2]] : absolutePathMatch;
    const extMatch = request.prompt.match(/\.(\w+)\s*(?:files?|extension)/i);
    
    if (!pathMatch) {
        stream.markdown('⚠️ **No directory path found**\n\nPlease include a path: `@boudica analyze files in folder src/components`\n');
        return 'No directory path found';
    }
    
    let dirPath = pathMatch[1];
    
    // If relative path, resolve to workspace
    if (!dirPath.startsWith('/') && !dirPath.startsWith('~')) {
        if (workspaceFolder) {
            dirPath = path.join(workspaceFolder.uri.fsPath, dirPath);
        }
    } else if (dirPath.startsWith('~')) {
        dirPath = dirPath.replace(/^~/, os.homedir());
    }
    
    const fileExt = extMatch ? extMatch[1] : '*';
    
    stream.markdown(`🔍 **Scanning directory**: \`${dirPath}\`\n\n`);
    
    // Find files
    const pattern = fileExt === '*' ? '**/*' : `**/*.${fileExt}`;
    const uri = vscode.Uri.file(dirPath);
    const relativePattern = new vscode.RelativePattern(uri, pattern);
    
    const files = await vscode.workspace.findFiles(relativePattern, '**/node_modules/**', 50);
    
    if (files.length === 0) {
        stream.markdown(`📭 No files found matching pattern \`${pattern}\`\n`);
        return 'No files found';
    }
    
    stream.markdown(`📊 Found ${files.length} file(s), analyzing...\n\n`);
    
    // Read file contents
    const fileContents: string[] = [];
    let totalSize = 0;
    const maxSize = 500000; // 500KB limit
    
    console.log('[DirectoryAnalysis] Reading', files.length, 'files from', dirPath);
    
    for (const fileUri of files) {
        try {
            const content = fs.readFileSync(fileUri.fsPath, 'utf-8');
            const relativePath = path.relative(dirPath, fileUri.fsPath);
            
            if (totalSize + content.length > maxSize) {
                stream.markdown(`⚠️ Size limit reached (500KB), analyzing first ${fileContents.length} files\n\n`);
                break;
            }
            
            fileContents.push(`// File: ${relativePath}\n${content}\n`);
            totalSize += content.length;
        } catch (err) {
            console.error(`Failed to read ${fileUri.fsPath}:`, err);
        }
    }
    
    console.log('[DirectoryAnalysis] Read', fileContents.length, 'files, total size:', totalSize, 'bytes');
    
    const combinedContent = fileContents.join('\n' + '='.repeat(80) + '\n\n');
    
    console.log('[DirectoryAnalysis] Combined content size:', Buffer.byteLength(combinedContent, 'utf8'), 'bytes');
    
    // Send to Boudica
    const chatRequest: ChatRequest = {
        message: `${request.prompt}\n\nAttached ${fileContents.length} files from ${dirPath}`,
        session_id: 'vscode-chat-participant',
        file_content: combinedContent,
        file_name: `batch_${fileContents.length}_files.txt`
    };
    
    console.log('[DirectoryAnalysis] Sending request with file_content:', !!chatRequest.file_content, 'length:', chatRequest.file_content?.length || 0);
    
    const response = await client.chat(chatRequest);
    
    if (response.error) {
        stream.markdown(`❌ **Error**: ${response.error}\n`);
        return `Error: ${response.error}`;
    } else {
        await streamMarkdown(stream, response.response || 'Analysis complete', token);
        return response.response || 'Analysis complete';
    }
}

/**
 * Handle code creation requests (single file)
 */
async function handleCodeCreation(
    request: vscode.ChatRequest,
    context: ChatContext,
    stream: vscode.ChatResponseStream,
    client: BoudicaClient,
    token: vscode.CancellationToken
): Promise<string> {
    
    stream.markdown('✨ **Creating code...**\n\n');
    
    // Include reference files if provided
    let combinedContext = '';
    if (context.fileReferences.length > 0) {
        combinedContext = context.fileReferences.map(ref => {
            const fileName = path.basename(ref.uri.fsPath);
            return `// Reference: ${fileName}\n${ref.content}\n`;
        }).join('\n' + '='.repeat(80) + '\n\n');
    }
    
    const chatRequest: ChatRequest = {
        message: request.prompt,
        session_id: 'vscode-chat-participant',
        forCodeGeneration: true,
        ...(combinedContext && {
            file_content: combinedContext,
            file_name: 'reference_code.txt'
        })
    };
    
    const response = await client.chat(chatRequest);
    
    if (response.error) {
        stream.markdown(`❌ **Error**: ${response.error}\n`);
        return `Error: ${response.error}`;
    } else {
        await streamMarkdown(stream, response.response || 'Code generated', token);
        
        // Offer to save as new file
        stream.button({
            command: 'boudicode.saveGeneratedCode',
            title: '💾 Save as File',
            arguments: [response.response]
        });
        
        return response.response || 'Code generated';
    }
}

/**
 * Handle code update requests
 */
async function handleCodeUpdate(
    request: vscode.ChatRequest,
    context: ChatContext,
    stream: vscode.ChatResponseStream,
    client: BoudicaClient,
    token: vscode.CancellationToken
): Promise<string> {
    
    if (context.fileReferences.length === 0) {
        stream.markdown('⚠️ **No files referenced**\n\nUse `#file:path` to attach files for modification.\n\nExample: `@boudica #file:main.cpp add error handling`\n');
        return 'No files referenced';
    }
    
    stream.markdown(`🔧 **Updating code...**\n\n`);
    
    // Show warning if external files are being accessed
    if (context.externalFiles && context.externalFiles.length > 0) {
        stream.markdown('⚠️ **External file** (outside workspace):\n\n');
        context.externalFiles.forEach(file => {
            const fileName = path.basename(file);
            stream.markdown(`- \`${fileName}\` (${file})\n`);
        });
        stream.markdown('\n_To disable external file access, set `boudicode.allowExternalFiles` to `false` in settings._\n\n');
    }
    
    // Use first file as primary target
    const targetFile = context.fileReferences[0];
    const fileName = path.basename(targetFile.uri.fsPath);
    
    const chatRequest: ChatRequest = {
        message: `Update ${fileName}: ${request.prompt}`,
        session_id: 'vscode-chat-participant',
        forCodeGeneration: true,
        file_content: targetFile.content,
        file_name: fileName
    };
    
    const response = await client.chat(chatRequest);
    
    if (response.error) {
        stream.markdown(`❌ **Error**: ${response.error}\n`);
        return `Error: ${response.error}`;
    } else {
        await streamMarkdown(stream, response.response || 'Code updated', token);
        
        // Offer to apply changes
        stream.button({
            command: 'boudicode.applyCodeUpdate',
            title: '✅ Apply Changes',
            arguments: [targetFile.uri, response.response]
        });
        
        return response.response || 'Code updated';
    }
}

/**
 * Handle file creation and save to filesystem
 */
async function handleFileCreation(
    request: vscode.ChatRequest,
    context: ChatContext,
    stream: vscode.ChatResponseStream,
    client: BoudicaClient,
    token: vscode.CancellationToken
): Promise<string> {
    
    // Extract target file path
    const targetPath = extractTargetFilePath(request.prompt);
    if (!targetPath) {
        stream.markdown('⚠️ **No target file path found**\n\nPlease specify where to save the file.\n\nExample: `@boudica analyze files and save to docs/analysis.md`\n');
        return 'No target file path';
    }
    
    // Resolve relative paths to workspace
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        stream.markdown('❌ **No workspace open**\n\nOpen a workspace folder to save files.\n');
        return 'No workspace';
    }
    
    // Convert relative paths to absolute
    const absolutePath = targetPath.startsWith('/') || targetPath.startsWith('~')
        ? targetPath.replace(/^~/, os.homedir())
        : path.join(workspaceFolder.uri.fsPath, targetPath);
    
    // Check workspace boundaries
    if (!isPathInWorkspace(absolutePath)) {
        const allowExternalFiles = vscode.workspace.getConfiguration('boudicode').get<boolean>('allowExternalFiles', true);
        
        if (!allowExternalFiles) {
            stream.markdown(`❌ **Blocked: External file write**\n\nPath \`${absolutePath}\` is outside your workspace.\n\n_To allow external file writes, set \`boudicode.allowExternalFiles\` to \`true\` in settings._\n`);
            return 'Blocked external file write';
        }
        
        stream.markdown(`⚠️ **Warning: Writing outside workspace**\n\nTarget file: \`${absolutePath}\`\n\n`);
    }
    
    stream.markdown(`📝 **Creating file**: \`${path.basename(absolutePath)}\`\n\n`);
    stream.markdown(`📂 **Location**: \`${absolutePath}\`\n\n`);
    
    console.log('[FileCreation] Starting file creation for:', absolutePath);
    console.log('[FileCreation] Prompt:', request.prompt);
    
    // Collect source content (directory analysis or file references)
    let sourceContent = '';
    if (context.fileReferences.length > 0) {
        console.log('[FileCreation] Using', context.fileReferences.length, 'attached files');
        // Use attached files
        sourceContent = context.fileReferences.map(ref => {
            const fileName = path.basename(ref.uri.fsPath);
            return `// File: ${fileName}\n${ref.content}\n`;
        }).join('\n' + '='.repeat(80) + '\n\n');
        
        stream.markdown(`📎 Analyzing ${context.fileReferences.length} file(s)...\n\n`);
    } else {
        console.log('[FileCreation] No file references attached');
        const isDirAnalysis = isDirectoryAnalysisRequest(request.prompt);
        console.log('[FileCreation] isDirectoryAnalysisRequest:', isDirAnalysis);
        
        if (isDirAnalysis) {
            // Extract SOURCE directory path from prompt (not the save destination)
            // Look for "files in folder X" or "source code files in X" patterns
            // CRITICAL: Require "folder|directory|path" keyword to avoid matching random words
            const relativePathMatch = request.prompt.match(/(?:files?|code|source).*?(?:in|from)\s+(?:the\s+)?(folder|directory|path)\s+([\w][\w\/\-\.]*)/i);
            const absolutePathMatch = request.prompt.match(/(?:files?|code|source).*?(?:in|from)\s+(?:^|\s)(\/[\w\/\-\.]+|~\/[\w\/\-\.]+)/i);
            
            console.log('[FileCreation] relativePathMatch:', relativePathMatch);
            console.log('[FileCreation] absolutePathMatch:', absolutePathMatch);
            
            const dirPathMatch = relativePathMatch ? [relativePathMatch[0], relativePathMatch[2]] : absolutePathMatch;
            if (dirPathMatch) {
                let dirPath = dirPathMatch[1];
                console.log('[FileCreation] Extracted dirPath:', dirPath);
                
                const absoluteDirPath = dirPath.startsWith('/') || dirPath.startsWith('~')
                    ? dirPath.replace(/^~/, os.homedir())
                    : path.join(workspaceFolder.uri.fsPath, dirPath);
                
                console.log('[FileCreation] Resolved absoluteDirPath:', absoluteDirPath);
                
                try {
                    const dirUri = vscode.Uri.file(absoluteDirPath);
                    const entries = await vscode.workspace.fs.readDirectory(dirUri);
                    
                    console.log('[FileCreation] Found', entries.length, 'entries in directory');
                    
                    stream.markdown(`📂 Scanning directory: \`${absoluteDirPath}\`\n\n`);
                    
                    // Read all files in directory
                    const fileReads = entries
                        .filter(([name, type]) => type === vscode.FileType.File && /\.(ts|js|cpp|py|h|hpp|md|txt|json)$/i.test(name))
                        .map(async ([name]) => {
                            const fileUri = vscode.Uri.joinPath(dirUri, name);
                            const content = await vscode.workspace.fs.readFile(fileUri);
                            return `// File: ${name}\n${Buffer.from(content).toString('utf8')}\n`;
                        });
                    
                    console.log('[FileCreation] Reading', fileReads.length, 'files');
                    
                    const fileContents = await Promise.all(fileReads);
                    sourceContent = fileContents.join('\n' + '='.repeat(80) + '\n\n');
                    
                    console.log('[FileCreation] Total source content size:', Buffer.byteLength(sourceContent, 'utf8'), 'bytes');
                    
                    stream.markdown(`✅ Found ${fileReads.length} files\n\n`);
                } catch (error: any) {
                    console.error('[FileCreation] Error reading directory:', error);
                    stream.markdown(`⚠️ Could not read directory: ${error.message}\n\n`);
                }
            } else {
                console.warn('[FileCreation] No directory path match found');
            }
        }
    }
    
    // Debug: Log if no source content was collected
    if (!sourceContent && isDirectoryAnalysisRequest(request.prompt)) {
        console.warn('[FileCreation] No source content collected despite directory analysis request');
        stream.markdown(`⚠️ **Warning**: No source files found or extracted from prompt. Generating without source context.\n\n`);
        console.warn('[ChatParticipant] File creation: No source content extracted, but directory analysis was requested');
    }
    
    // Generate content with Boudica
    stream.markdown('🤖 **Generating content...**\n\n');
    
    if (sourceContent) {
        const sourceSize = Buffer.byteLength(sourceContent, 'utf8');
        stream.markdown(`📊 Using ${sourceSize} bytes of source content\n\n`);
    }
    
    // CRITICAL: For file creation, ALWAYS use forCodeGeneration: true to bypass cleanResponse
    // cleanResponse is too aggressive and destroys markdown/text content (245 bytes → 41 bytes)
    // We want the raw generated content exactly as Boudica produces it
    const chatRequest: ChatRequest = {
        message: request.prompt + '\n\nIMPORTANT: Generate ONLY the file content, no disclaimers or explanations. Format as requested.',
        session_id: 'vscode-chat-participant',
        forCodeGeneration: true,  // Always true for file creation to prevent cleanResponse
        ...(sourceContent && {
            file_content: sourceContent,
            file_name: 'source_files.txt'
        })
    };
    
    console.log('[FileCreation] Sending request to Boudica...');
    console.log('[FileCreation] Message length:', chatRequest.message.length);
    console.log('[FileCreation] Has file_content:', !!chatRequest.file_content);
    console.log('[FileCreation] forCodeGeneration:', chatRequest.forCodeGeneration);
    
    const response = await client.chat(chatRequest);
    
    console.log('[FileCreation] Received response from Boudica');
    console.log('[FileCreation] Response error:', response.error);
    console.log('[FileCreation] Response length:', response.response?.length || 0);
    
    if (response.error) {
        console.error('[FileCreation] Boudica error:', response.error);
        stream.markdown(`❌ **Error**: ${response.error}\n`);
        return `Error: ${response.error}`;
    }
    
    const generatedContent = response.response || '';
    
    // Debug: Check if response is empty
    if (!generatedContent || generatedContent.trim().length === 0) {
        console.warn('[FileCreation] Empty response from Boudica');
        stream.markdown(`⚠️ **Warning**: Boudica returned empty content\n\n`);
        console.warn('[ChatParticipant] File creation: Empty response from Boudica');
    }
    
    // Save to filesystem
    try {
        const targetUri = vscode.Uri.file(absolutePath);
        const dirPath = path.dirname(absolutePath);
        
        // Create directory if it doesn't exist
        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));
        } catch (e) {
            // Directory might already exist, ignore
        }
        
        // Write file
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(generatedContent, 'utf8'));
        
        stream.markdown(`\n\n✅ **File created successfully!**\n\n`);
        stream.markdown(`📄 **Path**: [${path.basename(absolutePath)}](${targetUri.toString()})\n\n`);
        stream.markdown(`📊 **Size**: ${Buffer.byteLength(generatedContent, 'utf8')} bytes\n\n`);
        
        // Show preview (first 500 chars)
        const preview = generatedContent.substring(0, 500);
        stream.markdown('**Preview:**\n```\n' + preview + (generatedContent.length > 500 ? '\n...' : '') + '\n```\n');
        
        // Offer to open file
        stream.button({
            command: 'vscode.open',
            title: '📂 Open File',
            arguments: [targetUri]
        });
        
        return `File created: ${absolutePath}`;
    } catch (error: any) {
        stream.markdown(`\n\n❌ **Failed to save file**: ${error.message}\n`);
        return `Error saving file: ${error.message}`;
    }
}

/**
 * Handle general chat/explanation requests
 */
async function handleGeneralChat(
    request: vscode.ChatRequest,
    context: ChatContext,
    stream: vscode.ChatResponseStream,
    client: BoudicaClient,
    token: vscode.CancellationToken
): Promise<string> {
    
    // Include file context if provided
    let combinedContext = '';
    if (context.fileReferences.length > 0) {
        combinedContext = context.fileReferences.map(ref => {
            const fileName = path.basename(ref.uri.fsPath);
            return `// File: ${fileName}\n${ref.content}\n`;
        }).join('\n' + '='.repeat(80) + '\n\n');
    }
    
    const chatRequest: ChatRequest = {
        message: request.prompt,
        session_id: 'vscode-chat-participant',
        ...(combinedContext && {
            file_content: combinedContext,
            file_name: 'context.txt'
        })
    };
    
    const response = await client.chat(chatRequest);
    
    if (response.error) {
        stream.markdown(`❌ **Error**: ${response.error}\n`);
        return `Error: ${response.error}`;
    } else {
        await streamMarkdown(stream, response.response || 'Response received', token);
        return response.response || 'Response received';
    }
}

/**
 * Simulate streaming by chunking markdown output
 * (Boudica doesn't support real streaming yet, so we fake it for better UX)
 */
async function streamMarkdown(
    stream: vscode.ChatResponseStream,
    content: string,
    token: vscode.CancellationToken
): Promise<void> {
    
    // Split into sentences for smoother streaming effect
    const sentences = content.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [content];
    
    for (const sentence of sentences) {
        if (token.isCancellationRequested) {
            break;
        }
        
        stream.markdown(sentence + ' ');
        
        // Small delay to simulate streaming (adjust for preference)
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}
