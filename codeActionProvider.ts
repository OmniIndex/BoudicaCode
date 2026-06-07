/**
 * Code Action Provider
 * Provides quick fixes and code actions for BoudiCode diagnostics
 */

import * as vscode from 'vscode';
import { BoudicaClient } from './boudicaClient';
import { getStatusBarManager } from './statusBarManager';

export class BoudicaCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    private diagnosticCollection: vscode.DiagnosticCollection;
    private client: BoudicaClient;

    constructor(diagnosticCollection: vscode.DiagnosticCollection, client: BoudicaClient) {
        this.diagnosticCollection = diagnosticCollection;
        this.client = client;
    }

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.CodeAction[] | undefined {
        // Filter for BoudiCode diagnostics only
        const boudicodeDiagnostics = context.diagnostics.filter(
            diagnostic => diagnostic.source === 'BoudiCode'
        );

        if (boudicodeDiagnostics.length === 0) {
            return undefined;
        }

        const codeActions: vscode.CodeAction[] = [];

        for (const diagnostic of boudicodeDiagnostics) {
            // Add quick fix if recommendation is available
            if (diagnostic.relatedInformation && diagnostic.relatedInformation.length > 0) {
                const recommendation = diagnostic.relatedInformation[0].message;
                
                // Create "Apply Recommendation" action
                const applyAction = this.createApplyRecommendationAction(
                    document,
                    diagnostic,
                    recommendation
                );
                codeActions.push(applyAction);
            }

            // Add "Get AI Fix Suggestion" action
            const aiFix = this.createGetAIFixAction(document, diagnostic);
            codeActions.push(aiFix);

            // Add "Explain Issue" action
            const explainAction = this.createExplainIssueAction(document, diagnostic);
            codeActions.push(explainAction);

            // Add "Ignore Issue" action
            const ignoreAction = this.createIgnoreIssueAction(document, diagnostic);
            codeActions.push(ignoreAction);
        }

        return codeActions;
    }

    private createApplyRecommendationAction(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
        recommendation: string
    ): vscode.CodeAction {
        const action = new vscode.CodeAction(
            '💡 Apply Recommendation',
            vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diagnostic];
        action.isPreferred = true; // This makes it the default action

        // Show the recommendation as information
        action.command = {
            command: 'boudicode.applyRecommendation',
            title: 'Apply Recommendation',
            arguments: [document, diagnostic, recommendation]
        };

        return action;
    }

    private createGetAIFixAction(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic
    ): vscode.CodeAction {
        const action = new vscode.CodeAction(
            '🤖 Get AI Fix Suggestion',
            vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diagnostic];

        action.command = {
            command: 'boudicode.getAIFix',
            title: 'Get AI Fix Suggestion',
            arguments: [document, diagnostic]
        };

        return action;
    }

    private createExplainIssueAction(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic
    ): vscode.CodeAction {
        const action = new vscode.CodeAction(
            '📖 Explain Issue',
            vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diagnostic];

        action.command = {
            command: 'boudicode.explainIssue',
            title: 'Explain Issue',
            arguments: [document, diagnostic]
        };

        return action;
    }

    private createIgnoreIssueAction(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic
    ): vscode.CodeAction {
        const action = new vscode.CodeAction(
            '🚫 Ignore This Issue',
            vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diagnostic];

        action.command = {
            command: 'boudicode.ignoreIssue',
            title: 'Ignore This Issue',
            arguments: [document, diagnostic]
        };

        return action;
    }
}

// Command handlers
export async function handleApplyRecommendation(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    recommendation: string
): Promise<void> {
    // Extract the actual recommendation text (remove "Recommendation: " prefix)
    const recommendationText = recommendation.replace(/^Recommendation:\s*/i, '');

    // Show the recommendation in a message with options
    const action = await vscode.window.showInformationMessage(
        `Recommendation: ${recommendationText}`,
        'Copy to Clipboard',
        'Open in Chat'
    );

    if (action === 'Copy to Clipboard') {
        await vscode.env.clipboard.writeText(recommendationText);
        vscode.window.showInformationMessage('Recommendation copied to clipboard');
    } else if (action === 'Open in Chat') {
        // Open chat panel with the recommendation context
        await vscode.commands.executeCommand('boudicode.openChat');
        vscode.window.showInformationMessage(
            'Open the chat panel to discuss this issue with Boudica'
        );
    }
}

export async function handleGetAIFix(
    client: BoudicaClient,
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
): Promise<void> {
    const statusBarManager = getStatusBarManager();
    
    try {
        statusBarManager.showOperation('Generating', 'Getting AI fix suggestion...');

        // Get the problematic code
        const line = diagnostic.range.start.line;
        const startLine = Math.max(0, line - 5);
        const endLine = Math.min(document.lineCount - 1, line + 5);
        const codeContext = document.getText(
            new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER)
        );

        // Build prompt for AI fix
        const prompt = `I have a code issue that needs fixing:

**Issue**: ${diagnostic.message}
**Category**: ${diagnostic.code}
**Severity**: ${diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 
                       diagnostic.severity === vscode.DiagnosticSeverity.Warning ? 'Warning' : 'Info'}

**Code Context**:
\`\`\`
${codeContext}
\`\`\`

Please provide a specific code fix for this issue. Show the corrected code.`;

        const response = await client.chat({
            message: prompt,
            session_id: 'quickfix-' + Date.now()
        });

        statusBarManager.clearOperation();

        if (response.error) {
            throw new Error(response.error);
        }

        if (response.response) {
            // Show the AI response in a new editor
            const fixDoc = await vscode.workspace.openTextDocument({
                content: response.response,
                language: 'markdown'
            });
            await vscode.window.showTextDocument(fixDoc, {
                viewColumn: vscode.ViewColumn.Beside,
                preview: false
            });

            statusBarManager.showSuccess('AI fix suggestion generated', 3000);
        }
    } catch (error: any) {
        statusBarManager.showError('Failed to get AI fix');
        vscode.window.showErrorMessage(`Failed to get AI fix: ${error.message}`);
    }
}

export async function handleExplainIssue(
    client: BoudicaClient,
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
): Promise<void> {
    const statusBarManager = getStatusBarManager();
    
    try {
        statusBarManager.showOperation('Thinking', 'Explaining issue...');

        // Get the problematic code
        const line = diagnostic.range.start.line;
        const startLine = Math.max(0, line - 3);
        const endLine = Math.min(document.lineCount - 1, line + 3);
        const codeContext = document.getText(
            new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER)
        );

        // Build prompt for explanation
        const prompt = `Please explain this code issue in detail:

**Issue**: ${diagnostic.message}
**Category**: ${diagnostic.code}

**Code Context**:
\`\`\`
${codeContext}
\`\`\`

Explain:
1. Why this is a problem
2. What could go wrong
3. How to fix it
4. Best practices to prevent it`;

        const response = await client.chat({
            message: prompt,
            session_id: 'explain-' + Date.now()
        });

        statusBarManager.clearOperation();

        if (response.error) {
            throw new Error(response.error);
        }

        if (response.response) {
            // Show explanation in an information message with markdown support
            const panel = vscode.window.createWebviewPanel(
                'boudicodeExplanation',
                'Issue Explanation',
                vscode.ViewColumn.Beside,
                {}
            );

            panel.webview.html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { 
                            font-family: var(--vscode-font-family);
                            padding: 20px;
                            line-height: 1.6;
                        }
                        h1, h2, h3 { color: var(--vscode-foreground); }
                        code { 
                            background: var(--vscode-textCodeBlock-background);
                            padding: 2px 6px;
                            border-radius: 3px;
                        }
                        pre {
                            background: var(--vscode-textCodeBlock-background);
                            padding: 12px;
                            border-radius: 5px;
                            overflow-x: auto;
                        }
                    </style>
                </head>
                <body>
                    <h1>Issue Explanation</h1>
                    <div>${response.response.replace(/\n/g, '<br>')}</div>
                </body>
                </html>
            `;

            statusBarManager.showSuccess('Explanation generated', 3000);
        }
    } catch (error: any) {
        statusBarManager.showError('Failed to explain issue');
        vscode.window.showErrorMessage(`Failed to explain issue: ${error.message}`);
    }
}

export async function handleIgnoreIssue(
    diagnosticCollection: vscode.DiagnosticCollection,
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
): Promise<void> {
    // Get current diagnostics for this file
    const uri = document.uri;
    const diagnostics = diagnosticCollection.get(uri);
    
    if (!diagnostics) {
        return;
    }

    // Filter out the diagnostic to ignore
    const filtered = diagnostics.filter(d => 
        d.range.start.line !== diagnostic.range.start.line ||
        d.message !== diagnostic.message
    );

    // Update the diagnostic collection
    diagnosticCollection.set(uri, filtered);

    vscode.window.showInformationMessage('Issue ignored (will reappear on next analysis)');
}
