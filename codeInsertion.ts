import * as vscode from 'vscode';

export enum InsertionMode {
    APPEND = 'append',              // Add to end of file
    PREPEND = 'prepend',            // Add to beginning of file
    BEFORE_FUNCTION = 'before_function',  // Insert before a specific function
    AFTER_FUNCTION = 'after_function',    // Insert after a specific function
    REPLACE_FUNCTION = 'replace_function', // Replace a specific function
    INSIDE_CLASS = 'inside_class',        // Insert inside a class definition
    BEFORE_LINE = 'before_line',          // Insert before specific line number
    AFTER_LINE = 'after_line',            // Insert after specific line number
    OVERWRITE = 'overwrite'              // Replace entire file (existing behavior)
}

export interface InsertionTarget {
    mode: InsertionMode;
    functionName?: string;    // For function-based insertions
    className?: string;       // For class-based insertions
    lineNumber?: number;      // For line-based insertions
    searchPattern?: string;   // Alternative: regex pattern to find insertion point
}

export interface ModificationResult {
    success: boolean;
    filePath: string;
    insertedAt?: { line: number; character: number };
    error?: string;
}

export class CodeInserter {
    
    /**
     * Insert code into a file at a specific location
     */
    async insertCode(
        filePath: string,
        code: string,
        target: InsertionTarget
    ): Promise<ModificationResult> {
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const edit = new vscode.WorkspaceEdit();
            
            let position: vscode.Position | undefined;
            
            switch (target.mode) {
                case InsertionMode.APPEND:
                    position = document.lineAt(document.lineCount - 1).range.end;
                    edit.insert(uri, position, '\n' + code);
                    break;
                    
                case InsertionMode.PREPEND:
                    position = new vscode.Position(0, 0);
                    edit.insert(uri, position, code + '\n');
                    break;
                    
                case InsertionMode.BEFORE_FUNCTION:
                    if (!target.functionName) {
                        return { success: false, filePath, error: 'Function name required' };
                    }
                    const beforePos = await this.findFunctionPosition(document, target.functionName, 'before');
                    if (!beforePos) {
                        return { success: false, filePath, error: `Function ${target.functionName} not found` };
                    }
                    position = beforePos;
                    edit.insert(uri, position, code + '\n');
                    break;
                    
                case InsertionMode.AFTER_FUNCTION:
                    if (!target.functionName) {
                        return { success: false, filePath, error: 'Function name required' };
                    }
                    const afterPos = await this.findFunctionPosition(document, target.functionName, 'after');
                    if (!afterPos) {
                        return { success: false, filePath, error: `Function ${target.functionName} not found` };
                    }
                    position = afterPos;
                    edit.insert(uri, position, '\n' + code);
                    break;
                    
                case InsertionMode.REPLACE_FUNCTION:
                    if (!target.functionName) {
                        return { success: false, filePath, error: 'Function name required' };
                    }
                    const funcRange = await this.findFunctionRange(document, target.functionName);
                    if (!funcRange) {
                        return { success: false, filePath, error: `Function ${target.functionName} not found` };
                    }
                    position = funcRange.start;
                    edit.replace(uri, funcRange, code);
                    break;
                    
                case InsertionMode.INSIDE_CLASS:
                    if (!target.className) {
                        return { success: false, filePath, error: 'Class name required' };
                    }
                    const classPos = await this.findClassInsertionPoint(document, target.className);
                    if (!classPos) {
                        return { success: false, filePath, error: `Class ${target.className} not found` };
                    }
                    position = classPos;
                    edit.insert(uri, position, '\n' + code + '\n');
                    break;
                    
                case InsertionMode.BEFORE_LINE:
                    if (target.lineNumber === undefined) {
                        return { success: false, filePath, error: 'Line number required' };
                    }
                    position = new vscode.Position(Math.max(0, target.lineNumber - 1), 0);
                    edit.insert(uri, position, code + '\n');
                    break;
                    
                case InsertionMode.AFTER_LINE:
                    if (target.lineNumber === undefined) {
                        return { success: false, filePath, error: 'Line number required' };
                    }
                    position = document.lineAt(Math.min(target.lineNumber, document.lineCount - 1)).range.end;
                    edit.insert(uri, position, '\n' + code);
                    break;
                    
                case InsertionMode.OVERWRITE:
                    const fullRange = new vscode.Range(
                        new vscode.Position(0, 0),
                        document.lineAt(document.lineCount - 1).range.end
                    );
                    position = fullRange.start;
                    edit.replace(uri, fullRange, code);
                    break;
                    
                default:
                    return { success: false, filePath, error: 'Unknown insertion mode' };
            }
            
            const success = await vscode.workspace.applyEdit(edit);
            
            if (success) {
                await document.save();
                return { 
                    success: true, 
                    filePath,
                    insertedAt: position ? { line: position.line, character: position.character } : undefined
                };
            } else {
                return { success: false, filePath, error: 'Failed to apply edit' };
            }
            
        } catch (error) {
            return { 
                success: false, 
                filePath, 
                error: error instanceof Error ? error.message : 'Unknown error' 
            };
        }
    }

    /**
     * Find the position of a function (before or after)
     */
    private async findFunctionPosition(
        document: vscode.TextDocument,
        functionName: string,
        position: 'before' | 'after'
    ): Promise<vscode.Position | null> {
        const text = document.getText();
        
        // Match function definitions (simplified regex)
        const funcRegex = new RegExp(
            `(?:^|\\n)\\s*(?:[\\w:<>*&\\s]+)?\\s*${functionName}\\s*\\([^)]*\\)\\s*(?:{|;)`,
            'g'
        );
        
        const match = funcRegex.exec(text);
        if (!match) {
            return null;
        }
        
        const matchIndex = match.index;
        
        if (position === 'before') {
            // Find the start of the line
            let lineStart = text.lastIndexOf('\n', matchIndex);
            lineStart = lineStart === -1 ? 0 : lineStart;
            return document.positionAt(lineStart);
        } else {
            // Find the end of the function (closing brace)
            const funcStart = matchIndex + match[0].length;
            let braceCount = 1;
            let i = funcStart;
            
            // Skip if it's just a declaration (ends with ;)
            if (match[0].trim().endsWith(';')) {
                const lineEnd = text.indexOf('\n', matchIndex);
                return document.positionAt(lineEnd === -1 ? text.length : lineEnd);
            }
            
            // Find matching closing brace
            while (i < text.length && braceCount > 0) {
                if (text[i] === '{') braceCount++;
                if (text[i] === '}') braceCount--;
                i++;
            }
            
            return document.positionAt(i);
        }
    }

    /**
     * Find the range of a function (for replacement)
     */
    private async findFunctionRange(
        document: vscode.TextDocument,
        functionName: string
    ): Promise<vscode.Range | null> {
        const text = document.getText();
        
        const funcRegex = new RegExp(
            `(?:^|\\n)\\s*(?:[\\w:<>*&\\s]+)?\\s*${functionName}\\s*\\([^)]*\\)\\s*(?:{|;)`,
            'g'
        );
        
        const match = funcRegex.exec(text);
        if (!match) {
            return null;
        }
        
        const matchIndex = match.index;
        let lineStart = text.lastIndexOf('\n', matchIndex);
        lineStart = lineStart === -1 ? 0 : lineStart;
        
        const funcStart = matchIndex + match[0].length;
        
        // If declaration only (ends with ;)
        if (match[0].trim().endsWith(';')) {
            const lineEnd = text.indexOf('\n', matchIndex);
            return new vscode.Range(
                document.positionAt(lineStart),
                document.positionAt(lineEnd === -1 ? text.length : lineEnd)
            );
        }
        
        // Find matching closing brace
        let braceCount = 1;
        let i = funcStart;
        while (i < text.length && braceCount > 0) {
            if (text[i] === '{') braceCount++;
            if (text[i] === '}') braceCount--;
            i++;
        }
        
        return new vscode.Range(
            document.positionAt(lineStart),
            document.positionAt(i)
        );
    }

    /**
     * Find insertion point inside a class (before closing brace)
     */
    private async findClassInsertionPoint(
        document: vscode.TextDocument,
        className: string
    ): Promise<vscode.Position | null> {
        const text = document.getText();
        
        const classRegex = new RegExp(
            `(?:class|struct)\\s+${className}\\s*(?:[^{]*)?\\s*{`,
            'g'
        );
        
        const match = classRegex.exec(text);
        if (!match) {
            return null;
        }
        
        const classStart = match.index + match[0].length;
        let braceCount = 1;
        let i = classStart;
        
        // Find matching closing brace
        while (i < text.length && braceCount > 0) {
            if (text[i] === '{') braceCount++;
            if (text[i] === '}') braceCount--;
            i++;
        }
        
        // Insert before the closing brace
        const insertPos = i - 1;
        const position = document.positionAt(insertPos);
        
        // Find the start of the line containing the closing brace
        const line = document.lineAt(position.line);
        return new vscode.Position(position.line, line.firstNonWhitespaceCharacterIndex);
    }

    /**
     * Parse AI response to extract insertion instructions
     * Looks for special comments like:
     * // INSERT: AFTER_FUNCTION:myFunction
     * // INSERT: INSIDE_CLASS:MyClass
     */
    parseInsertionInstructions(aiResponse: string): { code: string; target: InsertionTarget } | null {
        const insertRegex = /\/\/\s*INSERT:\s*(\w+)(?::(\w+))?/i;
        const match = insertRegex.exec(aiResponse);
        
        if (!match) {
            return null;
        }
        
        const modeStr = match[1].toUpperCase();
        const targetName = match[2];
        
        // Remove the instruction comment from code
        const code = aiResponse.replace(insertRegex, '').trim();
        
        let mode: InsertionMode;
        let target: InsertionTarget;
        
        switch (modeStr) {
            case 'APPEND':
                mode = InsertionMode.APPEND;
                target = { mode };
                break;
            case 'BEFORE_FUNCTION':
                mode = InsertionMode.BEFORE_FUNCTION;
                target = { mode, functionName: targetName };
                break;
            case 'AFTER_FUNCTION':
                mode = InsertionMode.AFTER_FUNCTION;
                target = { mode, functionName: targetName };
                break;
            case 'REPLACE_FUNCTION':
                mode = InsertionMode.REPLACE_FUNCTION;
                target = { mode, functionName: targetName };
                break;
            case 'INSIDE_CLASS':
                mode = InsertionMode.INSIDE_CLASS;
                target = { mode, className: targetName };
                break;
            default:
                return null;
        }
        
        return { code, target };
    }
}
