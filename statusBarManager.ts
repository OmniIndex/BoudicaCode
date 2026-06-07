/**
 * Status Bar Manager
 * Manages status bar items for connection status and operation feedback
 */

import * as vscode from 'vscode';

export class StatusBarManager {
    private connectionStatusItem: vscode.StatusBarItem;
    private operationStatusItem: vscode.StatusBarItem;
    private quickAccessItem: vscode.StatusBarItem;
    private isConnected: boolean = false;
    private currentOperation: string | null = null;

    constructor() {
        // Connection status (left side)
        this.connectionStatusItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.connectionStatusItem.command = 'boudicode.configure';
        
        // Operation status (left side)
        this.operationStatusItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            99
        );
        
        // Quick access (right side)
        this.quickAccessItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.quickAccessItem.text = '$(comment-discussion) BoudiCode';
        this.quickAccessItem.tooltip = 'Open BoudiCode Chat';
        this.quickAccessItem.command = 'boudicode.openChat';
        
        this.updateConnectionStatus(false);
        this.quickAccessItem.show();
    }

    /**
     * Update connection status
     */
    updateConnectionStatus(connected: boolean, message?: string) {
        this.isConnected = connected;
        
        if (connected) {
            this.connectionStatusItem.text = '$(check) Boudica Connected';
            this.connectionStatusItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
            this.connectionStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            this.connectionStatusItem.tooltip = message || 'Connected to Boudica API - Click to configure';
        } else {
            this.connectionStatusItem.text = '$(warning) Boudica Disconnected';
            this.connectionStatusItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
            this.connectionStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            this.connectionStatusItem.tooltip = message || 'Not connected to Boudica API - Click to configure';
        }
        
        this.connectionStatusItem.show();
    }

    /**
     * Show operation in progress
     */
    showOperation(operation: string, detail?: string) {
        this.currentOperation = operation;
        
        let icon = '$(sync~spin)';
        let text = operation;
        
        switch (operation.toLowerCase()) {
            case 'analyzing':
                icon = '$(search~spin)';
                break;
            case 'generating':
            case 'augmenting':
                icon = '$(sparkle~spin)';
                break;
            case 'creating':
                icon = '$(file-add~spin)';
                break;
            case 'thinking':
                icon = '$(loading~spin)';
                break;
        }
        
        this.operationStatusItem.text = `${icon} ${text}`;
        if (detail) {
            this.operationStatusItem.tooltip = detail;
        }
        this.operationStatusItem.show();
    }

    /**
     * Clear operation status
     */
    clearOperation() {
        this.currentOperation = null;
        this.operationStatusItem.hide();
    }

    /**
     * Show success message briefly
     */
    showSuccess(message: string, duration: number = 3000) {
        const previousText = this.operationStatusItem.text;
        const previousTooltip = this.operationStatusItem.tooltip;
        
        this.operationStatusItem.text = `$(check) ${message}`;
        this.operationStatusItem.tooltip = message;
        this.operationStatusItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
        this.operationStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        this.operationStatusItem.show();
        
        setTimeout(() => {
            if (this.currentOperation) {
                this.operationStatusItem.text = previousText;
                this.operationStatusItem.tooltip = previousTooltip;
            } else {
                this.clearOperation();
            }
            this.operationStatusItem.color = undefined;
            this.operationStatusItem.backgroundColor = undefined;
        }, duration);
    }

    /**
     * Show error message briefly
     */
    showError(message: string, duration: number = 5000) {
        const previousText = this.operationStatusItem.text;
        const previousTooltip = this.operationStatusItem.tooltip;
        
        this.operationStatusItem.text = `$(error) ${message}`;
        this.operationStatusItem.tooltip = message;
        this.operationStatusItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
        this.operationStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.operationStatusItem.show();
        
        setTimeout(() => {
            if (this.currentOperation) {
                this.operationStatusItem.text = previousText;
                this.operationStatusItem.tooltip = previousTooltip;
            } else {
                this.clearOperation();
            }
            this.operationStatusItem.color = undefined;
            this.operationStatusItem.backgroundColor = undefined;
        }, duration);
    }

    /**
     * Test connection and update status
     */
    async testConnection(healthCheckFn: () => Promise<{ status: string; error?: string }>): Promise<boolean> {
        this.showOperation('Testing', 'Testing connection to Boudica...');
        
        try {
            const health = await healthCheckFn();
            const connected = health.status === 'ok' || health.status === 'healthy';
            
            if (connected) {
                this.updateConnectionStatus(true, 'Connected to Boudica API');
                this.showSuccess('Connected', 2000);
            } else {
                this.updateConnectionStatus(false, health.error || 'Connection failed');
                this.showError('Connection failed', 3000);
            }
            
            return connected;
        } catch (error: any) {
            this.updateConnectionStatus(false, `Error: ${error.message}`);
            this.showError('Connection error', 3000);
            return false;
        } finally {
            setTimeout(() => this.clearOperation(), 2000);
        }
    }

    /**
     * Dispose all status bar items
     */
    dispose() {
        this.connectionStatusItem.dispose();
        this.operationStatusItem.dispose();
        this.quickAccessItem.dispose();
    }
}

// Singleton instance
let statusBarManager: StatusBarManager | undefined;

export function getStatusBarManager(): StatusBarManager {
    if (!statusBarManager) {
        statusBarManager = new StatusBarManager();
    }
    return statusBarManager;
}

export function disposeStatusBarManager() {
    if (statusBarManager) {
        statusBarManager.dispose();
        statusBarManager = undefined;
    }
}
