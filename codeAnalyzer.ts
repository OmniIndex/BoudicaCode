/**
 * Code Analysis Module
 * Analyzes code for security vulnerabilities, memory leaks, and other issues
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BoudicaClient } from './boudicaClient';
import { getDecorationManager, CodeDecoration } from './decorationManager';
import { getStatusBarManager } from './statusBarManager';

export interface CodeIssue {
    file: string;
    line?: number;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    category: string;
    description: string;
    recommendation?: string;
}

interface AnalysisResult {
    issues: CodeIssue[];
    summary: string;
    metrics?: {
        filesScanned: number;
        issuesFound: number;
        criticalIssues: number;
        securityIssues: number;
    };
}

const CODE_EXTENSIONS: { [key: string]: string } = {
    '.ts': 'typescript',
    '.js': 'javascript',
    '.tsx': 'typescriptreact',
    '.jsx': 'javascriptreact',
    '.py': 'python',
    '.cpp': 'cpp',
    '.c': 'c',
    '.h': 'cpp',
    '.hpp': 'cpp',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.cs': 'csharp',
    '.php': 'php',
    '.rb': 'ruby',
    '.swift': 'swift'
};

const IGNORE_PATTERNS = [
    'node_modules',
    '.git',
    '.vscode',
    'dist',
    'build',
    'out',
    'target',
    '__pycache__',
    '.pytest_cache',
    'venv',
    '.env',
    'coverage',
    'test',
    'tests',
    '__tests__'
];

export async function analyzeCode(client: BoudicaClient, diagnosticCollection: vscode.DiagnosticCollection, targetUri?: vscode.Uri): Promise<void> {
    try {
        // Step 1: Ensure we have a workspace
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Please open a workspace first.');
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const targetPath = targetUri?.fsPath || workspaceRoot;

        // Step 2: Select analysis type
        const analysisType = await vscode.window.showQuickPick([
            {
                label: 'Full Security Audit',
                description: 'Comprehensive security vulnerability scan',
                detail: 'SQL injection, XSS, authentication issues, etc.',
                value: 'security'
            },
            {
                label: 'Memory Leak Detection',
                description: 'Find memory leaks and resource management issues',
                detail: 'Unclosed resources, circular references, memory growth',
                value: 'memory'
            },
            {
                label: 'Code Quality Review',
                description: 'Check code quality and best practices',
                detail: 'Code smells, complexity, maintainability',
                value: 'quality'
            },
            {
                label: 'Performance Analysis',
                description: 'Identify performance bottlenecks',
                detail: 'Inefficient algorithms, N+1 queries, blocking calls',
                value: 'performance'
            },
            {
                label: 'Complete Analysis',
                description: 'All-in-one comprehensive code analysis',
                detail: 'Security, memory, quality, and performance',
                value: 'complete'
            }
        ], {
            placeHolder: 'Select analysis type',
            title: 'BoudiCode: Analyze Code'
        });

        if (!analysisType) {
            return;
        }

        // Step 3: Show analyzing decoration on active editor
        const decorationManager = getDecorationManager();
        const statusBarManager = getStatusBarManager();
        
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.fsPath.startsWith(workspaceRoot)) {
            const lineCount = activeEditor.document.lineCount;
            decorationManager.showAnalyzing(activeEditor, 0, lineCount - 1);
        }

        // Step 4: Run analysis
        statusBarManager.showOperation('Analyzing', `Running ${analysisType.label}...`);
        
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Analyzing code...',
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Scanning code files...' });

            const codeFiles = await scanCodeFiles(targetPath, workspaceRoot);
            
            if (codeFiles.length === 0) {
                throw new Error('No code files found to analyze');
            }

            progress.report({ message: `Analyzing ${codeFiles.length} files...` });

            // Build analysis context
            const codeContext = buildAnalysisContext(codeFiles);

            // Build analysis prompt (without file context in message)
            const analysisPrompt = buildAnalysisPrompt(analysisType.value, analysisType.label);

            progress.report({ message: 'Running AI-powered analysis...' });

            // Send to Boudica with files as multipart/form-data (same as chat interface)
            const response = await client.chat({
                message: analysisPrompt,
                session_id: `code-analysis-${Date.now()}`,
                max_tokens: 12000,
                temperature: 0.3, // Lower temperature for more consistent analysis
                use_rag: true,
                file_content: codeContext,
                file_name: 'workspace_code.txt'
            });

            if (response.error) {
                throw new Error(response.error);
            }

            if (!response.response) {
                throw new Error('No response from Boudica');
            }

            progress.report({ message: 'Processing results...' });

            // Parse results
            const analysisResult = parseAnalysisResults(response.response, codeFiles.length);
            
            return analysisResult;
        });

        // Step 5: Apply decorations to show issues inline
        if (result.issues.length > 0) {
            const decorations: CodeDecoration[] = result.issues.map(issue => ({
                file: path.join(workspaceRoot, issue.file),
                line: issue.line || 1,
                message: issue.description + (issue.recommendation ? `\n\n**Fix:** ${issue.recommendation}` : ''),
                severity: mapSeverityToDecoration(issue.severity),
                category: issue.category
            }));
            decorationManager.applyDecorations(decorations);
        }

        // Step 6: Update Problems panel with diagnostics
        updateProblemsPanel(diagnosticCollection, result, workspaceRoot);

        // Step 7: Display results
        await displayAnalysisResults(result, workspaceRoot);
        
        // Show success in status bar
        statusBarManager.showSuccess(`Analysis complete: ${result.issues.length} issues found`, 3000);

    } catch (error: any) {
        const statusBarManager = getStatusBarManager();
        statusBarManager.showError('Analysis failed');
        vscode.window.showErrorMessage(`Code analysis failed: ${error.message}`);
        console.error('Code analysis error:', error);
    }
}

function mapSeverityToDecoration(severity: string): 'info' | 'warning' | 'error' | 'suggestion' {
    switch (severity.toLowerCase()) {
        case 'critical':
        case 'high':
            return 'error';
        case 'medium':
            return 'warning';
        case 'low':
            return 'info';
        default:
            return 'suggestion';
    }
}

function mapSeverityToDiagnostic(severity: string): vscode.DiagnosticSeverity {
    switch (severity.toLowerCase()) {
        case 'critical':
        case 'high':
            return vscode.DiagnosticSeverity.Error;
        case 'medium':
            return vscode.DiagnosticSeverity.Warning;
        case 'low':
            return vscode.DiagnosticSeverity.Information;
        case 'info':
            return vscode.DiagnosticSeverity.Hint;
        default:
            return vscode.DiagnosticSeverity.Information;
    }
}

function updateProblemsPanel(
    diagnosticCollection: vscode.DiagnosticCollection,
    result: AnalysisResult,
    workspaceRoot: string
): void {
    // Clear existing diagnostics
    diagnosticCollection.clear();

    // Group issues by file
    const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();

    for (const issue of result.issues) {
        const filePath = path.isAbsolute(issue.file)
            ? issue.file
            : path.join(workspaceRoot, issue.file);
        
        // Create diagnostic
        const line = Math.max(0, (issue.line || 1) - 1); // VS Code uses 0-based line numbers
        const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
        
        const diagnostic = new vscode.Diagnostic(
            range,
            issue.description,
            mapSeverityToDiagnostic(issue.severity)
        );
        
        // Set diagnostic properties
        diagnostic.source = 'BoudiCode';
        diagnostic.code = issue.category;
        
        // Add recommendation as related information if available
        if (issue.recommendation) {
            diagnostic.relatedInformation = [
                new vscode.DiagnosticRelatedInformation(
                    new vscode.Location(vscode.Uri.file(filePath), range),
                    `Recommendation: ${issue.recommendation}`
                )
            ];
        }

        // Group by file
        if (!diagnosticsByFile.has(filePath)) {
            diagnosticsByFile.set(filePath, []);
        }
        diagnosticsByFile.get(filePath)!.push(diagnostic);
    }

    // Update diagnostic collection for each file
    for (const [filePath, diagnostics] of diagnosticsByFile) {
        diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
    }
}

async function scanCodeFiles(targetPath: string, workspaceRoot: string): Promise<Array<{path: string, relativePath: string, content: string, language: string}>> {
    const files: Array<{path: string, relativePath: string, content: string, language: string}> = [];
    
    async function scanDirectory(dirPath: string) {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            
            // Skip ignored patterns (but include test files for analysis)
            if (IGNORE_PATTERNS.filter(p => p !== 'test' && p !== 'tests' && p !== '__tests__')
                .some(pattern => entry.name.includes(pattern))) {
                continue;
            }
            
            if (entry.isDirectory()) {
                await scanDirectory(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (CODE_EXTENSIONS[ext]) {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        // Skip very large files
                        if (content.length < 500000) {
                            files.push({
                                path: fullPath,
                                relativePath: path.relative(workspaceRoot, fullPath),
                                content,
                                language: CODE_EXTENSIONS[ext]
                            });
                        }
                    } catch (error) {
                        console.warn(`Failed to read ${fullPath}:`, error);
                    }
                }
            }
        }
    }
    
    if (fs.statSync(targetPath).isDirectory()) {
        await scanDirectory(targetPath);
    } else {
        const ext = path.extname(targetPath).toLowerCase();
        if (CODE_EXTENSIONS[ext]) {
            const content = fs.readFileSync(targetPath, 'utf8');
            files.push({
                path: targetPath,
                relativePath: path.relative(workspaceRoot, targetPath),
                content,
                language: CODE_EXTENSIONS[ext]
            });
        }
    }
    
    return files;
}

function buildAnalysisContext(files: Array<{path: string, relativePath: string, content: string, language: string}>): string {
    let context = 'Code Files to Analyze:\n\n';
    
    // Include up to 30 files in context
    const maxFiles = 30;
    const filesToAnalyze = files.slice(0, maxFiles);
    
    for (const file of filesToAnalyze) {
        context += `FILE: ${file.relativePath}\n`;
        context += '```' + file.language + '\n';
        context += file.content.substring(0, 15000); // 15KB per file
        if (file.content.length > 15000) {
            context += '\n... (truncated)';
        }
        context += '\n```\n\n';
    }
    
    if (files.length > maxFiles) {
        context += `\n... and ${files.length - maxFiles} more files\n`;
    }
    
    return context;
}

function buildAnalysisPrompt(analysisType: string, analysisLabel: string): string {
    let specificGuidance = '';
    
    switch (analysisType) {
        case 'security':
            specificGuidance = `Focus on security vulnerabilities:
- SQL injection and database security
- Cross-site scripting (XSS)
- Cross-site request forgery (CSRF)
- Authentication and authorization flaws
- Insecure cryptography
- Sensitive data exposure
- XML external entity (XXE) attacks
- Insecure deserialization
- Command injection
- Path traversal
- Hardcoded credentials or secrets`;
            break;
            
        case 'memory':
            specificGuidance = `Focus on memory leaks and resource management:
- Unclosed file handles, database connections, network sockets
- Memory leaks from circular references
- Event listener leaks
- Large object retention
- Inefficient data structures causing memory growth
- Missing cleanup in destructors/finalizers
- Resource allocation without proper deallocation`;
            break;
            
        case 'quality':
            specificGuidance = `Focus on code quality issues:
- Code duplication
- Complex functions (high cyclomatic complexity)
- Long parameter lists
- God objects/classes
- Poor naming conventions
- Missing error handling
- Lack of input validation
- Missing documentation
- Inconsistent coding style`;
            break;
            
        case 'performance':
            specificGuidance = `Focus on performance issues:
- N+1 query problems
- Inefficient algorithms (O(n²) where O(n log n) possible)
- Unnecessary computations in loops
- Blocking synchronous calls
- Missing indexes or caching
- Large data transfers
- Redundant database queries
- Memory-intensive operations`;
            break;
            
        case 'complete':
            specificGuidance = `Perform a comprehensive analysis covering:
1. Security vulnerabilities
2. Memory leaks and resource management
3. Code quality and maintainability
4. Performance bottlenecks`;
            break;
    }
    
    return `You are an expert code security and quality analyst. Perform a thorough ${analysisLabel} on the attached code files.

${specificGuidance}

The code files have been attached for your analysis.

For each issue found, provide:
1. FILE: The file path
2. LINE: The line number (if applicable)
3. SEVERITY: critical | high | medium | low | info
4. CATEGORY: The issue category (e.g., "SQL Injection", "Memory Leak", "Code Smell")
5. DESCRIPTION: Clear description of the issue
6. RECOMMENDATION: How to fix it

Format your response like this:

ISSUE:
FILE: path/to/file.ext
LINE: 42
SEVERITY: critical
CATEGORY: SQL Injection
DESCRIPTION: User input is directly concatenated into SQL query without sanitization
RECOMMENDATION: Use parameterized queries or prepared statements

ISSUE:
FILE: path/to/another.ext
LINE: 156
SEVERITY: high
CATEGORY: Memory Leak
DESCRIPTION: Database connection is never closed in error path
RECOMMENDATION: Use try-finally or context managers to ensure cleanup

[Additional issues...]

SUMMARY:
Provide an executive summary of findings, including:
- Total issues found
- Breakdown by severity
- Most critical concerns
- Overall code health assessment

Be thorough and precise. Only report real issues, not false positives.`;
}

function parseAnalysisResults(responseText: string, filesScanned: number): AnalysisResult {
    const issues: CodeIssue[] = [];
    
    // Parse issues
    const issuePattern = /ISSUE:\s*\nFILE:\s*(.+?)\n(?:LINE:\s*(\d+)\n)?SEVERITY:\s*(critical|high|medium|low|info)\nCATEGORY:\s*(.+?)\nDESCRIPTION:\s*(.+?)(?:\nRECOMMENDATION:\s*(.+?))?(?=\n\nISSUE:|\n\nSUMMARY:|$)/gs;
    
    let match;
    while ((match = issuePattern.exec(responseText)) !== null) {
        issues.push({
            file: match[1].trim(),
            line: match[2] ? parseInt(match[2]) : undefined,
            severity: match[3] as any,
            category: match[4].trim(),
            description: match[5].trim(),
            recommendation: match[6]?.trim()
        });
    }
    
    // Extract summary
    const summaryMatch = /SUMMARY:\s*([\s\S]+?)$/i.exec(responseText);
    const summary = summaryMatch ? summaryMatch[1].trim() : 'Analysis complete. See issues above.';
    
    // Calculate metrics
    const criticalIssues = issues.filter(i => i.severity === 'critical').length;
    const securityIssues = issues.filter(i => 
        i.category.toLowerCase().includes('security') ||
        i.category.toLowerCase().includes('injection') ||
        i.category.toLowerCase().includes('xss') ||
        i.category.toLowerCase().includes('csrf')
    ).length;
    
    return {
        issues,
        summary,
        metrics: {
            filesScanned,
            issuesFound: issues.length,
            criticalIssues,
            securityIssues
        }
    };
}

async function displayAnalysisResults(result: AnalysisResult, workspaceRoot: string): Promise<void> {
    // Create a diagnostics collection
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('boudicode');
    
    // Group issues by file
    const issuesByFile = new Map<string, CodeIssue[]>();
    for (const issue of result.issues) {
        const fullPath = path.isAbsolute(issue.file) ? issue.file : path.join(workspaceRoot, issue.file);
        if (!issuesByFile.has(fullPath)) {
            issuesByFile.set(fullPath, []);
        }
        issuesByFile.get(fullPath)!.push(issue);
    }
    
    // Create diagnostics
    for (const [filePath, issues] of issuesByFile.entries()) {
        const diagnostics: vscode.Diagnostic[] = [];
        
        for (const issue of issues) {
            const line = (issue.line || 1) - 1; // Convert to 0-indexed
            const range = new vscode.Range(line, 0, line, 100);
            
            const diagnostic = new vscode.Diagnostic(
                range,
                `[${issue.category}] ${issue.description}${issue.recommendation ? '\nRecommendation: ' + issue.recommendation : ''}`,
                mapSeverity(issue.severity)
            );
            
            diagnostic.source = 'BoudiCode';
            diagnostics.push(diagnostic);
        }
        
        diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
    }
    
    // Create and show report document
    const reportContent = formatAnalysisReport(result);
    const doc = await vscode.workspace.openTextDocument({
        content: reportContent,
        language: 'markdown'
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    
    // Show summary notification
    const metrics = result.metrics!;
    const message = `Analysis complete: ${metrics.issuesFound} issues found in ${metrics.filesScanned} files` +
                   (metrics.criticalIssues > 0 ? ` (${metrics.criticalIssues} critical)` : '');
    
    if (metrics.criticalIssues > 0) {
        vscode.window.showWarningMessage(message, 'View Report');
    } else {
        vscode.window.showInformationMessage(message, 'View Report');
    }
}

function mapSeverity(severity: string): vscode.DiagnosticSeverity {
    switch (severity) {
        case 'critical':
        case 'high':
            return vscode.DiagnosticSeverity.Error;
        case 'medium':
            return vscode.DiagnosticSeverity.Warning;
        case 'low':
            return vscode.DiagnosticSeverity.Information;
        default:
            return vscode.DiagnosticSeverity.Hint;
    }
}

function formatAnalysisReport(result: AnalysisResult): string {
    const metrics = result.metrics!;
    
    let report = `# BoudiCode Analysis Report\n\n`;
    report += `**Generated:** ${new Date().toLocaleString()}\n\n`;
    report += `## Summary\n\n`;
    report += `- **Files Scanned:** ${metrics.filesScanned}\n`;
    report += `- **Issues Found:** ${metrics.issuesFound}\n`;
    report += `- **Critical Issues:** ${metrics.criticalIssues}\n`;
    report += `- **Security Issues:** ${metrics.securityIssues}\n\n`;
    
    report += `${result.summary}\n\n`;
    
    if (result.issues.length > 0) {
        report += `## Issues\n\n`;
        
        // Group by severity
        const severities = ['critical', 'high', 'medium', 'low', 'info'];
        
        for (const severity of severities) {
            const issuesOfSeverity = result.issues.filter(i => i.severity === severity);
            if (issuesOfSeverity.length === 0) continue;
            
            report += `### ${severity.toUpperCase()} (${issuesOfSeverity.length})\n\n`;
            
            for (const issue of issuesOfSeverity) {
                report += `#### ${issue.category}\n\n`;
                report += `**File:** \`${issue.file}\`${issue.line ? ` (Line ${issue.line})` : ''}\n\n`;
                report += `**Description:** ${issue.description}\n\n`;
                if (issue.recommendation) {
                    report += `**Recommendation:** ${issue.recommendation}\n\n`;
                }
                report += `---\n\n`;
            }
        }
    } else {
        report += `## No Issues Found\n\nGreat job! No significant issues were detected in the analyzed code.\n`;
    }
    
    return report;
}
