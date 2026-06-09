/**
 * BoudiCode Extension
 * Main entry point for the VSCode extension
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getBoudicaClient, BoudicaClient } from './boudicaClient';
import { createProject } from './projectCreator';
import { createApplication } from './applicationCreator';
import { augmentCode } from './codeAugmenter';
import { analyzeCode } from './codeAnalyzer';
import { ChatViewProvider } from './chatPanel';
import { SessionManager } from './sessionManager';
import { getDecorationManager, disposeDecorationManager } from './decorationManager';
import { getStatusBarManager, disposeStatusBarManager } from './statusBarManager';
import { 
    BoudicaCodeActionProvider,
    handleApplyRecommendation,
    handleGetAIFix,
    handleExplainIssue,
    handleIgnoreIssue
} from './codeActionProvider';
import { 
    listBackups, 
    restoreFromBackup, 
    cleanupOldBackups,
    BackupInfo
} from './modificationExecutor';

let boudicaClient: BoudicaClient;
let diagnosticCollection: vscode.DiagnosticCollection;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    try {
        // Create output channel for logging
        outputChannel = vscode.window.createOutputChannel('BoudiCode');
        context.subscriptions.push(outputChannel);
        
        outputChannel.appendLine('='.repeat(80));
        outputChannel.appendLine('BoudiCode Extension: Starting activation...');
        outputChannel.appendLine('='.repeat(80));
        console.log('BoudiCode extension: Starting activation...');

        // Initialize Boudica client
        boudicaClient = getBoudicaClient();
        outputChannel.appendLine('✓ Boudica client initialized');
        console.log('BoudiCode: Boudica client initialized');

    // Initialize status bar
    const statusBarManager = getStatusBarManager();

    // Create diagnostic collection for Problems panel
    diagnosticCollection = vscode.languages.createDiagnosticCollection('boudicode');
    context.subscriptions.push(diagnosticCollection);

    // Register code action provider for quick fixes
    const codeActionProvider = new BoudicaCodeActionProvider(diagnosticCollection, boudicaClient);
    const supportedLanguages = [
        'typescript', 'javascript', 'typescriptreact', 'javascriptreact',
        'python', 'cpp', 'c', 'go', 'rust', 'java', 'csharp', 'php', 'ruby', 'swift'
    ];
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            supportedLanguages,
            codeActionProvider,
            {
                providedCodeActionKinds: BoudicaCodeActionProvider.providedCodeActionKinds
            }
        )
    );

    // Initialize session manager for conversation memory
    outputChannel.appendLine('Initializing session manager...');
    const sessionManager = new SessionManager(context);
    outputChannel.appendLine('✓ Session manager initialized (10-day retention)');

    // Register chat view provider in sidebar
    outputChannel.appendLine('Registering sidebar chat view provider...');
    console.log('BoudiCode: Registering chat view provider...');
    const chatProvider = new ChatViewProvider(context.extensionUri, boudicaClient, sessionManager);
    console.log('BoudiCode: ChatViewProvider created, viewType:', ChatViewProvider.viewType);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider)
    );
    outputChannel.appendLine('✓ Sidebar chat view provider registered successfully');
    console.log('BoudiCode: Chat view provider registered successfully');

    // Register native chat participant (@boudica in VS Code Chat panel)
    outputChannel.appendLine('');
    outputChannel.appendLine('Attempting to register native chat participant @boudica...');
    console.log('BoudiCode: Registering native chat participant...');
    import('./chatParticipant').then(({ registerChatParticipant }) => {
        registerChatParticipant(context, boudicaClient, sessionManager);
        outputChannel.appendLine('✓ Native chat participant @boudica registered successfully');
        outputChannel.appendLine('  You can now use @boudica in VS Code Chat panel');
        console.log('BoudiCode: Native chat participant @boudica registered successfully');
    }).catch(error => {
        outputChannel.appendLine('');
        outputChannel.appendLine('⚠️  Failed to register native chat participant:');
        outputChannel.appendLine('   ' + String(error));
        outputChannel.appendLine('   Note: Chat Participant API may not be available in this VS Code version');
        outputChannel.appendLine('   You can still use the BoudiCode sidebar for all features');
        console.log('BoudiCode: Failed to register chat participant (VS Code may not support Chat API):', error);
    });

    // Test connection on activation
    testConnection();

    // Register commands
    const commands = [
        vscode.commands.registerCommand('boudicode.createProject', async () => {
            await createProject(boudicaClient);
        }),

        vscode.commands.registerCommand('boudicode.createApplication', async () => {
            await createApplication(boudicaClient);
        }),

        vscode.commands.registerCommand('boudicode.augmentCode', async (uri?: vscode.Uri) => {
            // If no URI provided, use active editor's document
            if (!uri && vscode.window.activeTextEditor) {
                uri = vscode.window.activeTextEditor.document.uri;
            }
            await augmentCode(boudicaClient, uri);
        }),

        vscode.commands.registerCommand('boudicode.analyzeCode', async (uri?: vscode.Uri) => {
            // If no URI provided, use active editor's document
            if (!uri && vscode.window.activeTextEditor) {
                uri = vscode.window.activeTextEditor.document.uri;
            }
            await analyzeCode(boudicaClient, diagnosticCollection, uri);
        }),

        vscode.commands.registerCommand('boudicode.openChat', () => {
            vscode.commands.executeCommand('boudicodeChat.focus');
        }),

        vscode.commands.registerCommand('boudicode.sendPromptToSidebar', async (prompt: string) => {
            // Send prompt to sidebar chat panel
            // The chatProvider should expose a method to receive external prompts
            if (chatProvider && typeof (chatProvider as any).sendMessage === 'function') {
                await (chatProvider as any).sendMessage(prompt);
            } else {
                console.error('[Extension] chatProvider.sendMessage not available');
                vscode.window.showWarningMessage('Please type your request in the BoudiCode sidebar');
            }
        }),

        vscode.commands.registerCommand('boudicode.clearDecorations', () => {
            const decorationManager = getDecorationManager();
            decorationManager.clearAllDecorations();
            diagnosticCollection.clear();
            vscode.window.showInformationMessage('Cleared all BoudiCode decorations and diagnostics');
        }),

        vscode.commands.registerCommand('boudicode.configure', async () => {
            await configureExtension();
        }),

        // Build commands
        vscode.commands.registerCommand('boudicode.buildProject', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('Please open a workspace folder first');
                return;
            }
            
            const { BuildRunner } = await import('./buildRunner');
            const buildRunner = new BuildRunner(workspaceFolder.uri.fsPath);
            await buildRunner.runBuildInTerminal();
        }),

        vscode.commands.registerCommand('boudicode.buildAndRun', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('Please open a workspace folder first');
                return;
            }
            
            const { BuildRunner } = await import('./buildRunner');
            const buildRunner = new BuildRunner(workspaceFolder.uri.fsPath);
            await buildRunner.buildAndRun();
        }),

        vscode.commands.registerCommand('boudicode.buildAndFix', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('Please open a workspace folder first');
                return;
            }

            // Open the sidebar chat panel first, then send the trigger message
            await vscode.commands.executeCommand('boudicodeChat.focus');
            // Give the webview time to initialise; sendMessage will queue if not ready yet
            await chatProvider.sendMessage('build and fix');
        }),

        vscode.commands.registerCommand('boudicode.cleanBuild', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('Please open a workspace folder first');
                return;
            }
            
            const { BuildRunner } = await import('./buildRunner');
            const buildRunner = new BuildRunner(workspaceFolder.uri.fsPath);
            await buildRunner.cleanBuild();
        }),

        vscode.commands.registerCommand('boudicode.revertFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('Please open a file to revert');
                return;
            }
            
            const filePath = editor.document.uri.fsPath;
            const backups = await listBackups(filePath);
            
            if (backups.length === 0) {
                vscode.window.showInformationMessage('No backups found for this file');
                return;
            }
            
            // Show quick pick with backup options
            const items = backups.map(backup => ({
                label: backup.timestamp.toLocaleString(),
                description: (backup.size / 1024).toFixed(2) + ' KB',
                detail: backup.backupPath,
                backup: backup
            }));
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a backup to restore',
                title: 'Revert File to Backup'
            });
            
            if (selected) {
                const confirm = await vscode.window.showWarningMessage(
                    'Restore from backup created at ' + selected.label + '? Current version will be backed up first.',
                    'Restore',
                    'Cancel'
                );
                
                if (confirm === 'Restore') {
                    const success = await restoreFromBackup(selected.backup.backupPath, filePath);
                    if (success) {
                        vscode.window.showInformationMessage('File restored from backup');
                        // Reload the document
                        await vscode.commands.executeCommand('workbench.action.files.revert');
                    } else {
                        vscode.window.showErrorMessage('Failed to restore from backup');
                    }
                }
            }
        }),

        vscode.commands.registerCommand('boudicode.listBackups', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('Please open a file to view backups');
                return;
            }
            
            const filePath = editor.document.uri.fsPath;
            const backups = await listBackups(filePath);
            
            if (backups.length === 0) {
                vscode.window.showInformationMessage('No backups found for this file');
                return;
            }
            
            // Reuse the extension's existing output channel (creating a new one each call leaks handles)
            outputChannel.clear();
            outputChannel.appendLine('Backups for: ' + filePath);
            outputChannel.appendLine('='.repeat(80));
            outputChannel.appendLine('');
            
            backups.forEach((backup, index) => {
                outputChannel.appendLine((index + 1) + '. ' + backup.timestamp.toLocaleString());
                outputChannel.appendLine('   Path: ' + backup.backupPath);
                outputChannel.appendLine('   Size: ' + (backup.size / 1024).toFixed(2) + ' KB');
                outputChannel.appendLine('');
            });
            
            outputChannel.show();
        }),

        vscode.commands.registerCommand('boudicode.cleanupBackups', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('Please open a file to cleanup backups');
                return;
            }
            
            const filePath = editor.document.uri.fsPath;
            const backups = await listBackups(filePath);
            
            if (backups.length === 0) {
                vscode.window.showInformationMessage('No backups found for this file');
                return;
            }
            
            const keepCountStr = await vscode.window.showInputBox({
                prompt: 'How many recent backups to keep?',
                value: '10',
                validateInput: (value) => {
                    const num = parseInt(value);
                    if (isNaN(num) || num < 1) {
                        return 'Please enter a valid number >= 1';
                    }
                    return null;
                }
            });
            
            if (keepCountStr) {
                const keepCount = parseInt(keepCountStr);
                const deleted = await cleanupOldBackups(filePath, keepCount);
                
                if (deleted > 0) {
                    vscode.window.showInformationMessage('Deleted ' + deleted + ' old backup(s), kept ' + keepCount + ' most recent');
                } else {
                    vscode.window.showInformationMessage('No backups to delete (total: ' + backups.length + ')');
                }
            }
        }),

        // Code action command handlers
        vscode.commands.registerCommand('boudicode.applyRecommendation', async (
            document: vscode.TextDocument,
            diagnostic: vscode.Diagnostic,
            recommendation: string
        ) => {
            await handleApplyRecommendation(document, diagnostic, recommendation);
        }),

        vscode.commands.registerCommand('boudicode.getAIFix', async (
            document: vscode.TextDocument,
            diagnostic: vscode.Diagnostic
        ) => {
            await handleGetAIFix(boudicaClient, document, diagnostic);
        }),

        vscode.commands.registerCommand('boudicode.explainIssue', async (
            document: vscode.TextDocument,
            diagnostic: vscode.Diagnostic
        ) => {
            await handleExplainIssue(boudicaClient, document, diagnostic);
        }),

        vscode.commands.registerCommand('boudicode.ignoreIssue', async (
            document: vscode.TextDocument,
            diagnostic: vscode.Diagnostic
        ) => {
            await handleIgnoreIssue(diagnosticCollection, document, diagnostic);
        }),

        // Chat participant helper commands
        vscode.commands.registerCommand('boudicode.saveGeneratedCode', async (generatedCode: string) => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('Please open a workspace folder first');
                return;
            }
            
            // Extract filename from code if present (e.g., "// File: main.cpp")
            const fileNameMatch = generatedCode.match(/^\/\/\s*File:\s*(\S+)/m);
            const suggestedName = fileNameMatch ? fileNameMatch[1] : 'generated_code.txt';
            
            const fileName = await vscode.window.showInputBox({
                prompt: 'Enter filename',
                value: suggestedName,
                placeHolder: 'example.cpp'
            });
            
            if (!fileName) return;
            
            const filePath = vscode.Uri.joinPath(workspaceFolder.uri, fileName);
            
            // Extract code from markdown blocks if present
            let cleanCode = generatedCode;
            const codeBlockMatch = generatedCode.match(/```(?:\w+)?\s*\n([\s\S]+?)\n```/);
            if (codeBlockMatch) {
                cleanCode = codeBlockMatch[1];
            }
            
            await vscode.workspace.fs.writeFile(filePath, Buffer.from(cleanCode, 'utf-8'));
            
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
            
            vscode.window.showInformationMessage(`✅ Saved: ${fileName}`);
        }),

        vscode.commands.registerCommand('boudicode.applyCodeUpdate', async (
            uri: vscode.Uri,
            updatedCode: string
        ) => {
            // Extract code from markdown blocks if present
            let cleanCode = updatedCode;
            const codeBlockMatch = updatedCode.match(/```(?:\w+)?\s*\n([\s\S]+?)\n```/);
            if (codeBlockMatch) {
                cleanCode = codeBlockMatch[1];
            }

            // Show a diff so the user can review changes before applying
            const originalDoc = await vscode.workspace.openTextDocument(uri);
            const updatedDoc = await vscode.workspace.openTextDocument({
                content: cleanCode,
                language: originalDoc.languageId
            });
            await vscode.commands.executeCommand(
                'vscode.diff',
                originalDoc.uri,
                updatedDoc.uri,
                `Review changes: ${path.basename(uri.fsPath)}`
            );

            const confirm = await vscode.window.showWarningMessage(
                `Apply changes to ${path.basename(uri.fsPath)}? (Current version will be backed up)`,
                'Apply',
                'Cancel'
            );

            if (confirm === 'Apply') {
                const { createBackup } = await import('./modificationExecutor');
                await createBackup(uri.fsPath);
                await vscode.workspace.fs.writeFile(uri, Buffer.from(cleanCode, 'utf-8'));
                vscode.window.showInformationMessage(`✅ Applied changes to ${path.basename(uri.fsPath)}`);
            }
        })
    ];

    // Add all commands to subscriptions
    commands.forEach(cmd => context.subscriptions.push(cmd));

    // Dispose projectScanner when extension deactivates
    context.subscriptions.push(chatProvider['projectScanner']);

    // Warn when multiple workspace folders are open (extension uses only the first)
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1) {
        outputChannel.appendLine('⚠️  Multiple workspace folders detected. BoudiCode operates on the first folder only.');
        vscode.window.showWarningMessage(
            'BoudiCode: Multiple workspace folders detected. Only the first folder will be used for project scanning and build operations.',
            'OK'
        );
    }

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('boudicode')) {
                boudicaClient = getBoudicaClient();
                vscode.window.showInformationMessage('BoudiCode configuration updated');
            }
        })
    );

    // Show welcome message
    showWelcomeMessage(context);

    outputChannel.appendLine('');
    outputChannel.appendLine('='.repeat(80));
    outputChannel.appendLine('✓ BoudiCode extension activated successfully!');
    outputChannel.appendLine('='.repeat(80));
    console.log('BoudiCode extension: Activation completed successfully!');
    } catch (error) {
        outputChannel.appendLine('');
        outputChannel.appendLine('='.repeat(80));
        outputChannel.appendLine('❌ BoudiCode extension: Activation FAILED');
        outputChannel.appendLine('='.repeat(80));
        outputChannel.appendLine(String(error));
        console.error('BoudiCode extension: Activation FAILED:', error);
        vscode.window.showErrorMessage(`BoudiCode failed to activate: ${error}`);
        throw error; // Re-throw to mark extension as failed
    }
}

export function deactivate() {
    console.log('BoudiCode extension is now deactivated');
    disposeDecorationManager();
    disposeStatusBarManager();
}

async function testConnection(): Promise<void> {
    const statusBarManager = getStatusBarManager();
    
    try {
        const connected = await statusBarManager.testConnection(async () => {
            return await boudicaClient.health();
        });
        
        if (connected) {
            console.log('Connected to Boudica successfully');
        } else {
            console.warn('Boudica connection issue');
        }
    } catch (error) {
        console.error('Failed to connect to Boudica:', error);
    }
}

async function configureExtension(): Promise<void> {
    const config = vscode.workspace.getConfiguration('boudicode');

    const action = await vscode.window.showQuickPick([
        {
            label: 'Set API Endpoint',
            description: 'Configure Boudica API endpoint URL',
            value: 'endpoint'
        },
        {
            label: 'Set API Key',
            description: 'Set authentication API key',
            value: 'apikey'
        },
        {
            label: 'Set User ID',
            description: 'Configure your user ID',
            value: 'userid'
        },
        {
            label: 'Toggle RAG',
            description: 'Enable/disable Retrieval-Augmented Generation',
            value: 'rag'
        },
        {
            label: 'Set Temperature',
            description: 'Adjust AI response creativity (0.0-2.0)',
            value: 'temperature'
        },
        {
            label: 'Set Max Tokens',
            description: 'Configure maximum response length',
            value: 'maxtokens'
        },
        {
            label: 'Test Connection',
            description: 'Test connection to Boudica',
            value: 'test'
        },
        {
            label: 'Open Settings',
            description: 'Open BoudiCode settings in VS Code',
            value: 'settings'
        }
    ], {
        placeHolder: 'Select configuration option',
        title: 'BoudiCode Configuration'
    });

    if (!action) {
        return;
    }

    switch (action.value) {
        case 'endpoint':
            const endpoint = await vscode.window.showInputBox({
                prompt: 'Enter Boudica API endpoint URL',
                value: config.get('apiEndpoint', 'http://localhost/api/boudica'),
                placeHolder: 'http://localhost/api/boudica'
            });
            if (endpoint) {
                try {
                    await config.update('apiEndpoint', endpoint, vscode.ConfigurationTarget.Workspace);
                    vscode.window.showInformationMessage(`API endpoint set to: ${endpoint}`);
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to save endpoint: ${error.message}`);
                }
            }
            break;

        case 'apikey':
            const apiKey = await vscode.window.showInputBox({
                prompt: 'Enter API key (leave empty if using SAML)',
                value: config.get('apiKey', ''),
                password: true
            });
            if (apiKey !== undefined) {
                try {
                    await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Workspace);
                    vscode.window.showInformationMessage('API key updated successfully');
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to save API key: ${error.message}`);
                }
            }
            break;

        case 'userid':
            const userId = await vscode.window.showInputBox({
                prompt: 'Enter your user ID',
                value: config.get('userId', ''),
                placeHolder: 'user@example.com'
            });
            if (userId !== undefined) {
                try {
                    await config.update('userId', userId, vscode.ConfigurationTarget.Workspace);
                    vscode.window.showInformationMessage(`User ID set to: ${userId}`);
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to save user ID: ${error.message}`);
                }
            }
            break;

        case 'rag':
            const currentRag = config.get('useRag', true);
            const newRag = await vscode.window.showQuickPick([
                { label: 'Enable RAG', value: true },
                { label: 'Disable RAG', value: false }
            ], {
                placeHolder: `Currently: ${currentRag ? 'Enabled' : 'Disabled'}`
            });
            if (newRag !== undefined) {
                await config.update('useRag', newRag.value, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`RAG ${newRag.value ? 'enabled' : 'disabled'}`);
            }
            break;

        case 'temperature':
            const temp = await vscode.window.showInputBox({
                prompt: 'Enter temperature (0.0-2.0, default 0.8)',
                value: String(config.get('temperature', 0.8)),
                validateInput: (value) => {
                    const num = parseFloat(value);
                    if (isNaN(num) || num < 0 || num > 2) {
                        return 'Temperature must be between 0.0 and 2.0';
                    }
                    return null;
                }
            });
            if (temp) {
                await config.update('temperature', parseFloat(temp), vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Temperature set to: ${temp}`);
            }
            break;

        case 'maxtokens':
            const tokens = await vscode.window.showInputBox({
                prompt: 'Enter max tokens (50-32000, default 2000)',
                value: String(config.get('maxTokens', 2000)),
                validateInput: (value) => {
                    const num = parseInt(value);
                    if (isNaN(num) || num < 50 || num > 32000) {
                        return 'Max tokens must be between 50 and 32000';
                    }
                    return null;
                }
            });
            if (tokens) {
                await config.update('maxTokens', parseInt(tokens), vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Max tokens set to: ${tokens}`);
            }
            break;

        case 'test':
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Testing Boudica connection...',
                cancellable: false
            }, async () => {
                const statusBarManager = getStatusBarManager();
                const connected = await statusBarManager.testConnection(async () => {
                    return await boudicaClient.health();
                });
                
                if (connected) {
                    vscode.window.showInformationMessage('✓ Connected to Boudica successfully!');
                } else {
                    vscode.window.showErrorMessage('Connection failed - check status bar for details');
                }
            });
            break;

        case 'settings':
            await vscode.commands.executeCommand('workbench.action.openSettings', 'boudicode');
            break;
    }
}

async function showWelcomeMessage(context: vscode.ExtensionContext): Promise<void> {
    // Check if this is the first activation
    const hasShownWelcome = context.globalState.get<boolean>('boudicode.hasShownWelcome', false);
    
    if (!hasShownWelcome) {
        const action = await vscode.window.showInformationMessage(
            'Welcome to BoudiCode! Your AI-powered development assistant.',
            'Configure', 'View Commands', 'Dismiss'
        );

        if (action === 'Configure') {
            await configureExtension();
        } else if (action === 'View Commands') {
            await vscode.commands.executeCommand('workbench.action.quickOpen', '>BoudiCode');
        }

        await context.globalState.update('boudicode.hasShownWelcome', true);
    }
}
