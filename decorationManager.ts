/**
 * Decoration Manager
 * Handles inline decorations for showing AI analysis and suggestions in the editor
 */

import * as vscode from 'vscode';

export interface CodeDecoration {
    file: string;
    line: number;
    startChar?: number;
    endChar?: number;
    message: string;
    severity: 'info' | 'warning' | 'error' | 'suggestion';
    category?: string;
}

export class DecorationManager {
    private decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
    private activeDecorations: Map<string, vscode.TextEditorDecorationType[]> = new Map();

    constructor() {
        this.initializeDecorationTypes();
    }

    private initializeDecorationTypes() {
        // Error decoration (red wavy underline)
        this.decorationTypes.set('error', vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 0, 0, 0.1)',
            border: '1px solid rgba(255, 0, 0, 0.3)',
            borderRadius: '3px',
            textDecoration: 'underline wavy red',
            overviewRulerColor: 'red',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            gutterIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PGNpcmNsZSBjeD0iOCIgY3k9IjgiIHI9IjciIGZpbGw9IiNmNDQzMzYiLz48cGF0aCBkPSJNOCA0djVsMyAzIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMiIgZmlsbD0ibm9uZSIvPjwvc3ZnPg=='),
            gutterIconSize: 'contain'
        }));

        // Warning decoration (orange wavy underline)
        this.decorationTypes.set('warning', vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 165, 0, 0.1)',
            border: '1px solid rgba(255, 165, 0, 0.3)',
            borderRadius: '3px',
            textDecoration: 'underline wavy orange',
            overviewRulerColor: 'orange',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            gutterIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHBhdGggZD0iTTggMmw2IDEySDJ6IiBmaWxsPSIjZmY5ODAwIi8+PHBhdGggZD0iTTggNnYzIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMiIvPjxjaXJjbGUgY3g9IjgiIGN5PSIxMiIgcj0iMSIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg=='),
            gutterIconSize: 'contain'
        }));

        // Info decoration (blue underline)
        this.decorationTypes.set('info', vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(33, 150, 243, 0.1)',
            border: '1px solid rgba(33, 150, 243, 0.3)',
            borderRadius: '3px',
            textDecoration: 'underline blue',
            overviewRulerColor: 'blue',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            gutterIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PGNpcmNsZSBjeD0iOCIgY3k9IjgiIHI9IjciIGZpbGw9IiMyMTk2RjMiLz48cGF0aCBkPSJNOCA2djYiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIyIi8+PGNpcmNsZSBjeD0iOCIgY3k9IjQiIHI9IjEiIGZpbGw9IiNmZmYiLz48L3N2Zz4='),
            gutterIconSize: 'contain'
        }));

        // Suggestion decoration (green dashed border)
        this.decorationTypes.set('suggestion', vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(76, 175, 80, 0.1)',
            border: '1px dashed rgba(76, 175, 80, 0.5)',
            borderRadius: '3px',
            overviewRulerColor: 'green',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            gutterIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PGNpcmNsZSBjeD0iOCIgY3k9IjgiIHI9IjciIGZpbGw9IiM0Q0FGNTAiLz48cGF0aCBkPSJNNSA4bDIgMiA0LTQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIyIiBmaWxsPSJub25lIi8+PC9zdmc+'),
            gutterIconSize: 'contain'
        }));

        // Analyzing decoration (yellow highlight for code being analyzed)
        this.decorationTypes.set('analyzing', vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 235, 59, 0.15)',
            border: '1px solid rgba(255, 235, 59, 0.4)',
            borderRadius: '3px',
            overviewRulerColor: 'yellow',
            overviewRulerLane: vscode.OverviewRulerLane.Left
        }));
    }

    /**
     * Show that a range is being analyzed
     */
    showAnalyzing(editor: vscode.TextEditor, startLine: number, endLine: number) {
        const range = new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, Number.MAX_SAFE_INTEGER)
        );

        const decoration = this.decorationTypes.get('analyzing');
        if (decoration) {
            editor.setDecorations(decoration, [{ range }]);
            this.trackDecoration(editor.document.uri.fsPath, decoration);
        }
    }

    /**
     * Apply decorations for code issues
     */
    applyDecorations(decorations: CodeDecoration[]) {
        // Group decorations by file
        const byFile = new Map<string, CodeDecoration[]>();
        for (const dec of decorations) {
            if (!byFile.has(dec.file)) {
                byFile.set(dec.file, []);
            }
            byFile.get(dec.file)!.push(dec);
        }

        // Apply decorations to each file
        for (const [filePath, fileDecorations] of byFile.entries()) {
            // Find editor for this file
            const editor = vscode.window.visibleTextEditors.find(
                e => e.document.uri.fsPath === filePath
            );

            if (editor) {
                this.applyDecorationsToEditor(editor, fileDecorations);
            }
        }
    }

    private applyDecorationsToEditor(editor: vscode.TextEditor, decorations: CodeDecoration[]) {
        // Clear previous decorations for this file
        this.clearDecorations(editor.document.uri.fsPath);

        // Group by severity
        const bySeverity = new Map<string, vscode.DecorationOptions[]>();
        
        for (const dec of decorations) {
            if (!bySeverity.has(dec.severity)) {
                bySeverity.set(dec.severity, []);
            }

            // Convert to 0-based line index
            const lineIndex = Math.max(0, dec.line - 1);
            
            // Get the line text to determine range
            const line = editor.document.lineAt(lineIndex);
            const startChar = dec.startChar ?? 0;
            const endChar = dec.endChar ?? line.text.length;

            const range = new vscode.Range(
                new vscode.Position(lineIndex, startChar),
                new vscode.Position(lineIndex, endChar)
            );

            // Create hover message
            const hoverMessage = new vscode.MarkdownString();
            hoverMessage.isTrusted = true;
            hoverMessage.appendMarkdown(`**${this.getSeverityIcon(dec.severity)} ${dec.severity.toUpperCase()}**`);
            
            if (dec.category) {
                hoverMessage.appendMarkdown(` - ${dec.category}`);
            }
            hoverMessage.appendMarkdown(`\n\n${dec.message}`);

            const decorationOption: vscode.DecorationOptions = {
                range,
                hoverMessage
            };

            bySeverity.get(dec.severity)!.push(decorationOption);
        }

        // Apply decorations by severity
        for (const [severity, options] of bySeverity.entries()) {
            const decorationType = this.decorationTypes.get(severity);
            if (decorationType) {
                editor.setDecorations(decorationType, options);
                this.trackDecoration(editor.document.uri.fsPath, decorationType);
            }
        }
    }

    private getSeverityIcon(severity: string): string {
        switch (severity) {
            case 'error': return '❌';
            case 'warning': return '⚠️';
            case 'info': return 'ℹ️';
            case 'suggestion': return '💡';
            default: return '•';
        }
    }

    private trackDecoration(filePath: string, decoration: vscode.TextEditorDecorationType) {
        if (!this.activeDecorations.has(filePath)) {
            this.activeDecorations.set(filePath, []);
        }
        this.activeDecorations.get(filePath)!.push(decoration);
    }

    /**
     * Clear decorations for a specific file
     */
    clearDecorations(filePath: string) {
        const decorations = this.activeDecorations.get(filePath);
        if (decorations) {
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document.uri.fsPath === filePath) {
                    for (const decoration of decorations) {
                        editor.setDecorations(decoration, []);
                    }
                }
            }
            this.activeDecorations.delete(filePath);
        }
    }

    /**
     * Clear all decorations
     */
    clearAllDecorations() {
        for (const [filePath, _] of this.activeDecorations.entries()) {
            this.clearDecorations(filePath);
        }
    }

    /**
     * Dispose all decoration types
     */
    dispose() {
        this.clearAllDecorations();
        for (const [_, decoration] of this.decorationTypes.entries()) {
            decoration.dispose();
        }
        this.decorationTypes.clear();
    }
}

// Singleton instance
let decorationManager: DecorationManager | undefined;

export function getDecorationManager(): DecorationManager {
    if (!decorationManager) {
        decorationManager = new DecorationManager();
    }
    return decorationManager;
}

export function disposeDecorationManager() {
    if (decorationManager) {
        decorationManager.dispose();
        decorationManager = undefined;
    }
}
