/**
 * Error Parser
 * Parses compiler and linker errors from build output
 */

import * as path from 'path';

export enum ErrorType {
    SYNTAX = 'syntax',
    UNDEFINED_REFERENCE = 'undefined_reference',
    UNDECLARED_IDENTIFIER = 'undeclared_identifier',
    MISSING_INCLUDE = 'missing_include',
    TYPE_MISMATCH = 'type_mismatch',
    NO_MATCHING_FUNCTION = 'no_matching_function',
    LINKER_ERROR = 'linker_error',
    CMAKE_ERROR = 'cmake_error',
    NPM_ERROR = 'npm_error',
    UNKNOWN = 'unknown'
}

export interface ParsedError {
    type: ErrorType;
    file?: string;
    line?: number;
    column?: number;
    message: string;
    rawMessage: string;
    symbol?: string;          // Undefined symbol, undeclared variable
    suggestedInclude?: string; // Suggested header file
    functionSignature?: string; // For function signature mismatches
}

export class ErrorParser {
    
    /**
     * Parse build output and extract errors
     */
    parseOutput(buildOutput: string): ParsedError[] {
        const errors: ParsedError[] = [];
        const lines = buildOutput.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Parse GCC/Clang error format: file:line:column: error: message
            const gccMatch = line.match(/^(.+?):(\d+):(\d+):\s*(error|fatal error):\s*(.+)$/);
            if (gccMatch) {
                const error = this.parseGccError(gccMatch, line, lines, i);
                if (error) {
                    errors.push(error);
                }
                continue;
            }
            
            // Parse linker error: undefined reference to 'symbol'
            const linkerMatch = line.match(/undefined reference to [`']([^'`]+)['`]/);
            if (linkerMatch) {
                errors.push({
                    type: ErrorType.UNDEFINED_REFERENCE,
                    message: `Undefined reference to '${linkerMatch[1]}'`,
                    rawMessage: line,
                    symbol: linkerMatch[1]
                });
                continue;
            }
            
            // Parse CMake error
            if (line.includes('CMake Error')) {
                errors.push({
                    type: ErrorType.CMAKE_ERROR,
                    message: line.replace(/^.*CMake Error[^:]*:\s*/, ''),
                    rawMessage: line
                });
                continue;
            }
            
            // Parse npm/TypeScript error
            const npmMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)$/);
            if (npmMatch) {
                errors.push({
                    type: ErrorType.NPM_ERROR,
                    file: npmMatch[1],
                    line: parseInt(npmMatch[2]),
                    column: parseInt(npmMatch[3]),
                    message: npmMatch[4],
                    rawMessage: line
                });
                continue;
            }

            // Parse Python traceback: "  File "path.py", line N, in function"
            const pyFileMatch = line.match(/^\s+File "(.+?)", line (\d+)/);
            if (pyFileMatch && i + 1 < lines.length) {
                // The actual error follows the traceback — look ahead for it
                const errorLine = lines.slice(i + 1).find(l => /^\w+Error:|^SyntaxError:|^IndentationError:|^NameError:|^TypeError:|^AttributeError:|^ImportError:|^ModuleNotFoundError:/.test(l));
                errors.push({
                    type: ErrorType.SYNTAX,
                    file: path.basename(pyFileMatch[1]),
                    line: parseInt(pyFileMatch[2]),
                    message: errorLine ? errorLine.trim() : lines[i + 1]?.trim() || 'Python error',
                    rawMessage: line
                });
                continue;
            }

            // Parse Rust error: "error[E0XXX]: message" followed by " --> file:line:col"
            const rustErrMatch = line.match(/^error(?:\[E\d+\])?: (.+)$/);
            if (rustErrMatch) {
                const nextLine = lines[i + 1] || '';
                const locMatch = nextLine.match(/\s+-->\s+(.+?):(\d+):(\d+)/);
                errors.push({
                    type: ErrorType.SYNTAX,
                    file: locMatch ? path.basename(locMatch[1]) : undefined,
                    line: locMatch ? parseInt(locMatch[2]) : undefined,
                    column: locMatch ? parseInt(locMatch[3]) : undefined,
                    message: rustErrMatch[1].trim(),
                    rawMessage: line
                });
                continue;
            }

            // Parse Go error: "./file.go:line:col: message"
            const goMatch = line.match(/^(\.\/[^\s:]+\.go):(\d+):(\d+):\s+(.+)$/);
            if (goMatch) {
                errors.push({
                    type: ErrorType.SYNTAX,
                    file: path.basename(goMatch[1]),
                    line: parseInt(goMatch[2]),
                    column: parseInt(goMatch[3]),
                    message: goMatch[4].trim(),
                    rawMessage: line
                });
                continue;
            }
        }
        
        console.log(`[ErrorParser] Parsed ${errors.length} errors from build output`);
        return errors;
    }

    /**
     * Parse a GCC/Clang format error
     */
    private parseGccError(match: RegExpMatchArray, line: string, allLines: string[], lineIndex: number): ParsedError | null {
        const file = match[1];
        const lineNum = parseInt(match[2]);
        const column = parseInt(match[3]);
        const message = match[5].trim();
        
        // Determine error type and extract details
        const errorType = this.classifyError(message);
        const symbol = this.extractSymbol(message);
        const suggestedInclude = this.suggestInclude(message, symbol);
        
        // Check for additional context in following lines (notes, suggestions)
        let fullMessage = message;
        for (let i = lineIndex + 1; i < Math.min(lineIndex + 5, allLines.length); i++) {
            const nextLine = allLines[i];
            if (nextLine.match(/^\s+(note|suggestion):/)) {
                fullMessage += '\n' + nextLine.trim();
            } else if (!nextLine.trim()) {
                break;
            }
        }
        
        return {
            type: errorType,
            file: path.basename(file),
            line: lineNum,
            column,
            message: fullMessage,
            rawMessage: line,
            symbol,
            suggestedInclude
        };
    }

    /**
     * Classify error based on message content
     */
    private classifyError(message: string): ErrorType {
        const lowerMessage = message.toLowerCase();
        
        if (lowerMessage.includes('was not declared') || lowerMessage.includes('not declared in this scope')) {
            return ErrorType.UNDECLARED_IDENTIFIER;
        }
        
        if (lowerMessage.includes('no such file or directory') && lowerMessage.includes('#include')) {
            return ErrorType.MISSING_INCLUDE;
        }
        
        if (lowerMessage.includes('no matching function') || lowerMessage.includes('no match for call')) {
            return ErrorType.NO_MATCHING_FUNCTION;
        }
        
        if (lowerMessage.includes('type mismatch') || lowerMessage.includes('cannot convert')) {
            return ErrorType.TYPE_MISMATCH;
        }
        
        if (lowerMessage.includes('expected') && (lowerMessage.includes(';') || lowerMessage.includes('before'))) {
            return ErrorType.SYNTAX;
        }
        
        return ErrorType.UNKNOWN;
    }

    /**
     * Extract symbol name from error message
     */
    private extractSymbol(message: string): string | undefined {
        // Pattern: 'SymbolName' was not declared
        let match = message.match(/['`]([^'`]+)['`]\s+was not declared/);
        if (match) {
            return match[1];
        }
        
        // Pattern: identifier 'SymbolName' is undefined
        match = message.match(/identifier\s+['`]([^'`]+)['`]/);
        if (match) {
            return match[1];
        }
        
        // Pattern: use of undeclared identifier 'SymbolName'
        match = message.match(/undeclared identifier\s+['`]([^'`]+)['`]/);
        if (match) {
            return match[1];
        }
        
        // Pattern: no matching function for call to 'functionName'
        match = message.match(/no matching function for call to\s+['`]([^'`(]+)/);
        if (match) {
            return match[1];
        }
        
        return undefined;
    }

    /**
     * Suggest include file based on error message and symbol
     */
    private suggestInclude(message: string, symbol?: string): string | undefined {
        if (!symbol) {
            return undefined;
        }
        
        // Common C++ standard library symbols
        const stdIncludes: { [key: string]: string } = {
            'std::cout': '<iostream>',
            'std::cin': '<iostream>',
            'std::endl': '<iostream>',
            'std::string': '<string>',
            'std::vector': '<vector>',
            'std::map': '<map>',
            'std::set': '<set>',
            'std::unordered_map': '<unordered_map>',
            'std::shared_ptr': '<memory>',
            'std::unique_ptr': '<memory>',
            'std::make_shared': '<memory>',
            'std::thread': '<thread>',
            'std::mutex': '<mutex>',
            'std::ifstream': '<fstream>',
            'std::ofstream': '<fstream>',
            'std::cerr': '<iostream>',
            'std::exception': '<exception>',
            'std::runtime_error': '<stdexcept>',
            'std::logic_error': '<stdexcept>'
        };
        
        if (symbol in stdIncludes) {
            return stdIncludes[symbol];
        }
        
        // If symbol starts with std::, likely needs a header
        if (symbol.startsWith('std::')) {
            const containerName = symbol.split('::')[1].split('<')[0];
            return `<${containerName}>`;
        }
        
        // Check if error message contains include suggestion
        const includeMatch = message.match(/did you mean to include\s+[<"]([^>"]+)[>"]/);
        if (includeMatch) {
            return includeMatch[1];
        }
        
        return undefined;
    }

    /**
     * Group errors by file for better organization
     */
    groupErrorsByFile(errors: ParsedError[]): Map<string, ParsedError[]> {
        const grouped = new Map<string, ParsedError[]>();
        
        for (const error of errors) {
            const file = error.file || 'unknown';
            if (!grouped.has(file)) {
                grouped.set(file, []);
            }
            grouped.get(file)!.push(error);
        }
        
        return grouped;
    }

    /**
     * Get human-readable summary of errors
     */
    summarizeErrors(errors: ParsedError[]): string {
        if (errors.length === 0) {
            return 'No errors found';
        }
        
        const byType = new Map<ErrorType, number>();
        const byFile = new Map<string, number>();
        
        for (const error of errors) {
            byType.set(error.type, (byType.get(error.type) || 0) + 1);
            if (error.file) {
                byFile.set(error.file, (byFile.get(error.file) || 0) + 1);
            }
        }
        
        let summary = `Found ${errors.length} error(s):\n\n`;
        
        // Error types
        summary += '**By Type:**\n';
        for (const [type, count] of byType) {
            summary += `  • ${this.getErrorTypeName(type)}: ${count}\n`;
        }
        
        // By file
        if (byFile.size > 0) {
            summary += '\n**By File:**\n';
            for (const [file, count] of byFile) {
                summary += `  • ${file}: ${count}\n`;
            }
        }
        
        return summary;
    }

    /**
     * Get human-readable error type name
     */
    private getErrorTypeName(type: ErrorType): string {
        const names: { [key in ErrorType]: string } = {
            [ErrorType.SYNTAX]: 'Syntax Errors',
            [ErrorType.UNDEFINED_REFERENCE]: 'Undefined References',
            [ErrorType.UNDECLARED_IDENTIFIER]: 'Undeclared Identifiers',
            [ErrorType.MISSING_INCLUDE]: 'Missing Includes',
            [ErrorType.TYPE_MISMATCH]: 'Type Mismatches',
            [ErrorType.NO_MATCHING_FUNCTION]: 'No Matching Function',
            [ErrorType.LINKER_ERROR]: 'Linker Errors',
            [ErrorType.CMAKE_ERROR]: 'CMake Errors',
            [ErrorType.NPM_ERROR]: 'NPM/TypeScript Errors',
            [ErrorType.UNKNOWN]: 'Other Errors'
        };
        
        return names[type];
    }

    /**
     * Format error for display
     */
    formatError(error: ParsedError): string {
        let formatted = '';
        
        if (error.file) {
            formatted += `**${error.file}`;
            if (error.line) {
                formatted += `:${error.line}`;
                if (error.column) {
                    formatted += `:${error.column}`;
                }
            }
            formatted += '**\n';
        }
        
        formatted += `${this.getErrorTypeIcon(error.type)} ${error.message}`;
        
        if (error.suggestedInclude) {
            formatted += `\n  💡 Suggested fix: Add \`#include ${error.suggestedInclude}\``;
        }
        
        return formatted;
    }

    /**
     * Get icon for error type
     */
    private getErrorTypeIcon(type: ErrorType): string {
        const icons: { [key in ErrorType]: string } = {
            [ErrorType.SYNTAX]: '📝',
            [ErrorType.UNDEFINED_REFERENCE]: '🔗',
            [ErrorType.UNDECLARED_IDENTIFIER]: '❓',
            [ErrorType.MISSING_INCLUDE]: '📦',
            [ErrorType.TYPE_MISMATCH]: '🔄',
            [ErrorType.NO_MATCHING_FUNCTION]: '🎯',
            [ErrorType.LINKER_ERROR]: '🔗',
            [ErrorType.CMAKE_ERROR]: '⚙️',
            [ErrorType.NPM_ERROR]: '📦',
            [ErrorType.UNKNOWN]: '❌'
        };
        
        return icons[type];
    }
}
