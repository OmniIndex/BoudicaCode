/**
 * Status Reporter — streams progress messages from anywhere in the
 * extension to the active chat webview, so the user sees the same kind
 * of trace they would see in the developer console (but prefixed with
 * "Boudica" instead of the internal subsystem tags).
 *
 * Falls back to console-only output when no webview is attached.
 */

import * as vscode from 'vscode';

let statusWebview: vscode.Webview | undefined;

/**
 * Register / clear the webview that should receive status messages.
 * Called from ChatViewProvider.resolveWebviewView() and onDidDispose().
 */
export function setStatusWebview(view: vscode.Webview | undefined): void {
    statusWebview = view;
}

/**
 * Emit a status line. Always logged to the console (with a "[Boudica]"
 * prefix), and, when a webview is attached, also pushed to the chat UI
 * as a streaming status entry.
 */
export function reportStatus(message: string): void {
    const line = String(message);
    // Always keep the developer-console trace.
    console.log('[Boudica] ' + line);
    if (statusWebview) {
        try {
            statusWebview.postMessage({ command: 'addStatus', text: line });
        } catch {
            // Webview may have been disposed mid-flight; ignore.
        }
    }
}
