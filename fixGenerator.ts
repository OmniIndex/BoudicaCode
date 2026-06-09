/**
 * Fix Generator
 * Generates fixes for build errors using Boudica AI
 */

import { ParsedError, ErrorType } from './errorParser';
import { BoudicaClient } from './boudicaClient';
import { ProjectScanner, FileInfo } from './projectScanner';
import { ModificationPlan, ModificationStep } from './modificationExecutor';
import { InsertionMode } from './codeInsertion';
import * as path from 'path';

export class FixGenerator {
    private client: BoudicaClient;
    private scanner: ProjectScanner;
    
    constructor(client: BoudicaClient, scanner: ProjectScanner) {
        this.client = client;
        this.scanner = scanner;
    }

    /**
     * Generate a modification plan to fix build errors
     * Returns plan and error message if failed
     */
    async generateFixPlan(errors: ParsedError[]): Promise<{plan: ModificationPlan | null, error?: string}> {
        console.log(`[FixGenerator] Generating fix plan for ${errors.length} errors`);
        
        if (errors.length === 0) {
            return {plan: null, error: 'No errors to fix'};
        }
        
        // Group errors by type for better fix strategies
        const byType = this.groupErrorsByType(errors);
        
        // Get project structure for context
        const projectStructure = await this.scanner.scanProject();
        
        // Get affected files for attachment (not in prompt)
        const affectedFiles = await this.getAffectedFiles(errors, projectStructure);
        
        // Build fix prompt (WITHOUT file content embedded)
        const fixPrompt = await this.buildFixPrompt(errors, byType, projectStructure, false);
        
        // Build file attachment with FULL file content
        let fileContent = '';
        let fileName = 'affected_files.txt';
        
        const filesToInclude = affectedFiles.slice(0, 2); // Max 2 files
        if (filesToInclude.length > 0) {
            fileContent = filesToInclude.map(file => {
                return `=== ${file.relativePath} ===\n${file.content}\n\n`;
            }).join('\n');
            fileName = `fix_context_${filesToInclude[0].relativePath.replace(/[\/\\]/g, '_')}`;
            console.log(`[FixGenerator] Attaching ${filesToInclude.length} file(s) as ${fileName} (${fileContent.length} chars)`);
        }
        
        try {
            console.log('[FixGenerator] Sending fix request to Boudica...');
            console.log('[FixGenerator] Prompt length:', fixPrompt.length, 'chars');
            console.log('[FixGenerator] Attachment length:', fileContent.length, 'chars');
            
            const response = await this.client.chat({
                message: fixPrompt,
                file_content: fileContent.length > 0 ? fileContent : undefined,
                file_name: fileContent.length > 0 ? fileName : undefined,
                session_id: 'fix-' + Date.now(),
                temperature: 0.3, // Lower temperature for more precise fixes
                max_tokens: 32000,
                skipClean: true   // Don't let cleanResponse strip STEP lines
            });
            
            if (response.error) {
                const errorMsg = `Boudica API error: ${response.error}`;
                console.error('[FixGenerator]', errorMsg);
                
                // Try simple fixes as fallback
                console.log('[FixGenerator] Attempting fallback simple fixes...');
                const simplePlan = this.createSimpleFallbackPlan(errors);
                if (simplePlan.steps.length > 0) {
                    console.log(`[FixGenerator] Generated ${simplePlan.steps.length} simple fix steps`);
                    return {plan: simplePlan};
                }
                
                return {plan: null, error: errorMsg};
            }
            
            if (!response.response) {
                const errorMsg = 'Received empty response from Boudica';
                console.error('[FixGenerator]', errorMsg);
                
                // Try simple fixes as fallback
                const simplePlan = this.createSimpleFallbackPlan(errors);
                if (simplePlan.steps.length > 0) {
                    return {plan: simplePlan};
                }
                
                return {plan: null, error: errorMsg};
            }
            
            // Parse the fix plan
            console.log('[FixGenerator] Parsing fix plan from response...');
            console.log('[FixGenerator] Response text length:', response.response.length);
            console.log('[FixGenerator] Response preview:', response.response.substring(0, 500));
            let plan = this.parseFixPlan(response.response, errors, projectStructure);
            
            if (plan.steps.length === 0) {
                // Try to reformat natural language response into STEP format
                console.log('[FixGenerator] No steps parsed, trying to reformat response...');
                const reformatted = await this.reformatToSteps(response.response);
                
                if (reformatted) {
                    console.log('[FixGenerator] Reformatted response:', reformatted);
                    plan = this.parseFixPlan(reformatted, errors, projectStructure);
                }
                
                if (plan.steps.length === 0) {
                    const errorMsg = 'Could not parse any fix steps from AI response';
                    console.error('[FixGenerator]', errorMsg);
                    console.log('[FixGenerator] Full response was:', response.response);
                    
                    // Show first 1000 chars in error for debugging
                    const preview = response.response.substring(0, 1000);
                    return {plan: null, error: `${errorMsg}. Response preview: ${preview}`};
                }
            }
            
            console.log(`[FixGenerator] Successfully generated plan with ${plan.steps.length} steps`);
            return {plan};
            
        } catch (error) {
            const errorMsg = `Exception during fix generation: ${error instanceof Error ? error.message : String(error)}`;
            console.error('[FixGenerator]', errorMsg, error);
            
            // Try simple fixes as fallback
            try {
                const simplePlan = this.createSimpleFallbackPlan(errors);
                if (simplePlan.steps.length > 0) {
                    return {plan: simplePlan};
                }
            } catch (fallbackError) {
                console.error('[FixGenerator] Fallback also failed:', fallbackError);
            }
            
            return {plan: null, error: errorMsg};
        }
    }

    /**
     * Create a simple fallback plan for common errors
     */
    private createSimpleFallbackPlan(errors: ParsedError[]): ModificationPlan {
        const simpleFixes = this.generateSimpleFixes(errors);
        const affectedFiles = new Set<string>();
        const newFiles = new Set<string>();
        
        for (const step of simpleFixes) {
            if (step.action === 'modify') {
                affectedFiles.add(step.fileName);
            } else if (step.action === 'create') {
                newFiles.add(step.fileName);
            }
        }
        
        return {
            steps: simpleFixes,
            affectedFiles: Array.from(affectedFiles),
            newFiles: Array.from(newFiles)
        };
    }

    /**
     * Reformat natural language response into STEP format
     */
    private async reformatToSteps(naturalResponse: string): Promise<string | null> {
        console.log('[FixGenerator] Asking Boudica to reformat response...');
        
        const reformatPrompt = `You provided this fix explanation:

${naturalResponse}

Please reformat your answer using this EXACT format:

STEP N: ACTION FILENAME at LOCATION - DESCRIPTION

Where:
- ACTION is: modify, create, or delete
- FILENAME is the file to change
- LOCATION is: line_NUMBER, end_of_file, beginning, or a function name
- DESCRIPTION is what to change

Examples:
STEP 1: modify CMakeLists.txt at end_of_file - Add set(CMAKE_CXX_STANDARD 11)
STEP 2: modify word_analyzer.hpp at line_23 - Change -- comment to // comment
STEP 3: modify word_analyzer.cpp at line_34 - Change -- comment to // comment

Provide ONLY the STEP lines, nothing else.`;

        try {
            const response = await this.client.chat({
                message: reformatPrompt,
                session_id: 'reformat-' + Date.now(),
                temperature: 0.1, // Very low for exact formatting
                max_tokens: 32000,
                skipClean: true   // Don't let cleanResponse strip STEP lines
            });
            
            if (response.error || !response.response) {
                console.error('[FixGenerator] Failed to reformat response');
                return null;
            }
            
            return response.response;
            
        } catch (error) {
            console.error('[FixGenerator] Error reformatting:', error);
            return null;
        }
    }

    /**
     * Build a detailed prompt for Boudica to generate fixes
     * @param includeFileContent - If false, omits file content (for use with file attachments)
     */
    /** Detect primary language from error file extensions */
    private detectLanguage(errors: ParsedError[]): string {
        const extCounts: Record<string, number> = {};
        for (const e of errors) {
            if (e.file) {
                const ext = path.extname(e.file).toLowerCase();
                extCounts[ext] = (extCounts[ext] || 0) + 1;
            }
        }
        const dominant = Object.entries(extCounts).sort((a, b) => b[1] - a[1])[0];
        if (!dominant) { return 'unknown'; }
        const extMap: Record<string, string> = {
            '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java',
            '.cs': 'C#', '.kt': 'Kotlin', '.rb': 'Ruby', '.swift': 'Swift',
            '.ts': 'TypeScript', '.js': 'JavaScript', '.cpp': 'C++',
            '.c': 'C', '.cc': 'C++', '.cxx': 'C++'
        };
        return extMap[dominant[0]] || dominant[0].replace('.', '').toUpperCase();
    }

    /** Return language-specific example STEP lines */
    private buildExamplesForLanguage(lang: string, errors: ParsedError[]): string {
        const exampleFile = errors.find(e => e.file)?.file || '';
        switch (lang) {
            case 'Python':
                return [
                    `STEP 1: modify ${exampleFile || 'main.py'} at line_1 - Fix SyntaxError by adding missing colon after def/if/for/class`,
                    `STEP 2: modify ${exampleFile || 'utils.py'} at line_5 - Fix IndentationError by correcting indentation to 4 spaces`,
                    `STEP 3: modify requirements.txt at end_of_file - Add missing_module==1.0.0`
                ].join('\n');
            case 'Rust':
                return [
                    `STEP 1: modify ${exampleFile || 'main.rs'} at line_10 - Fix borrow error by adding .clone()`,
                    `STEP 2: modify Cargo.toml at end_of_file - Add missing dependency serde = "1"`
                ].join('\n');
            case 'Go':
                return [
                    `STEP 1: modify ${exampleFile || 'main.go'} at line_5 - Fix import by adding "fmt" to import block`,
                    `STEP 2: modify ${exampleFile || 'main.go'} at line_12 - Fix type assertion to use comma-ok pattern`
                ].join('\n');
            case 'TypeScript':
            case 'JavaScript':
                return [
                    `STEP 1: modify ${exampleFile || 'index.ts'} at line_3 - Add missing type annotation`,
                    `STEP 2: modify package.json at end_of_file - Add missing dependency`
                ].join('\n');
            default: // C++, C, Java, etc.
                return [
                    `STEP 1: modify CMakeLists.txt at end_of_file - Add set(CMAKE_CXX_STANDARD 11)`,
                    `STEP 2: modify ${exampleFile || 'main.cpp'} at beginning - Add #include <algorithm>`,
                    `STEP 3: modify ${exampleFile || 'main.cpp'} at line_34 - Fix syntax error`
                ].join('\n');
        }
    }

    private async buildFixPrompt(
        errors: ParsedError[],
        byType: Map<ErrorType, ParsedError[]>,
        projectStructure: any,
        includeFileContent: boolean = true
    ): Promise<string> {
        const language = this.detectLanguage(errors);
        let prompt = `I have a **${language}** project that failed to build with the following errors:\n\n`;
        
        // Add error details
        prompt += `**Build Errors (${errors.length} total):**\n\n`;
        
        let errorCount = 0;
        for (const error of errors.slice(0, 15)) { // Limit to first 15 errors
            errorCount++;
            prompt += `${errorCount}. `;
            if (error.file) {
                prompt += `**${error.file}`;
                if (error.line) {
                    prompt += `:${error.line}`;
                }
                prompt += `** - `;
            }
            prompt += `${error.message}\n`;
            if (error.symbol) {
                prompt += `   Symbol: \`${error.symbol}\`\n`;
            }
            if (error.suggestedInclude) {
                prompt += `   Suggested: \`#include ${error.suggestedInclude}\`\n`;
            }
            prompt += '\n';
        }
        
        if (errors.length > 15) {
            prompt += `... and ${errors.length - 15} more errors\n\n`;
        }
        
        // Add project structure context
        prompt += `**Project Structure:**\n`;
        prompt += `Source files (${projectStructure.sourceFiles.length}):\n`;
        projectStructure.sourceFiles.forEach((f: FileInfo) => {
            prompt += `  - ${f.relativePath}\n`;
        });
        
        prompt += `\nHeader files (${projectStructure.headerFiles.length}):\n`;
        projectStructure.headerFiles.forEach((f: FileInfo) => {
            prompt += `  - ${f.relativePath}\n`;
        });
        
        // Add content of affected files (only if includeFileContent is true)
        if (includeFileContent) {
            const affectedFiles = await this.getAffectedFiles(errors, projectStructure);
            console.log(`[FixGenerator] Found ${affectedFiles.length} affected files to include in prompt`);
            
            // For file-by-file fixing: include ONLY the primary file + its header (max 2 files)
            // This prevents overwhelming Boudica with too much context
            const filesToInclude = affectedFiles.slice(0, 2); // HARD LIMIT: max 2 files
            
            if (filesToInclude.length > 0) {
                prompt += `\n**Content of Affected Files:**\n\n`;
                for (const file of filesToInclude) {
                    prompt += `--- ${file.relativePath} ---\n`;
                    // For error fixing, include more content (15000 chars max per file)
                    // This is critical for Boudica to understand the full context
                    const content = file.content.length > 15000 
                        ? file.content.substring(0, 15000) + '\n... (file continues, truncated at 15000 chars)'
                        : file.content;
                    prompt += `\`\`\`${file.language}\n${content}\n\`\`\`\n\n`;
                    console.log(`[FixGenerator] Including ${file.relativePath}: ${content.length} chars`);
                }
                
                if (affectedFiles.length > 2) {
                    prompt += `\n*(${affectedFiles.length - 2} more affected files not included - fixing one file at a time)*\n\n`;
                }
            } else {
                console.warn('[FixGenerator] WARNING: No file content available for context');
                prompt += `\n**NOTE:** File content not available. Using error messages only.\n\n`;
            }
        } else {
            // Files will be sent as attachments
            prompt += `\n**NOTE:** Affected file content is provided as an attached document.\n\n`;
        }
        
        // Add fix instructions
        prompt += `\n**CRITICAL: You must provide SPECIFIC, ACTIONABLE fixes with EXACT filenames.**\n\n`;
        prompt += `**This is a ${language} project. Use ${language} file extensions and syntax.**\n\n`;
        prompt += `**Required format (use this EXACT pattern):**\n`;
        prompt += `STEP N: ACTION FILENAME at LOCATION - DESCRIPTION\n\n`;
        prompt += `**Rules:**\n`;
        prompt += `- ACTION: modify, create, or delete\n`;
        prompt += `- FILENAME: EXACT file to change (must use correct language extension, e.g., .py for Python, .rs for Rust)\n`;
        prompt += `- LOCATION: line_NUMBER, end_of_file, beginning, or function_name\n`;
        prompt += `- DESCRIPTION: Exact change including code if needed\n\n`;
        prompt += `**Examples for ${language}:**\n`;
        prompt += this.buildExamplesForLanguage(language, errors) + '\n\n';
        prompt += `DO NOT invent filenames. Only use filenames that appear in the error messages or project structure above.\n`;
        prompt += `DO NOT give general advice. Provide SPECIFIC file modifications using the STEP format above.`;
        
        return prompt;
    }

    /**
     * Get files affected by errors
     * If projectStructure is empty, reads files directly from filesystem
     */
    private async getAffectedFiles(errors: ParsedError[], projectStructure: any): Promise<FileInfo[]> {
        const affectedFileNames = new Set<string>();

        for (const error of errors) {
            if (error.file) {
                affectedFileNames.add(error.file);
            }
        }

        const result: FileInfo[] = [];
        const addedFiles = new Set<string>();

        // First pass: try to match from the already-scanned project structure
        const allScanned = [
            ...projectStructure.sourceFiles,
            ...projectStructure.headerFiles
        ];

        for (const f of allScanned as FileInfo[]) {
            if (affectedFileNames.has(path.basename(f.path)) && !addedFiles.has(f.path)) {
                result.push(f);
                addedFiles.add(f.path);
                console.log(`[FixGenerator] ✓ Found in scanner: ${path.basename(f.path)} (${f.content.length} chars)`);
            }
        }

        // Second pass: for any file not found in the scanner, read directly from disk.
        // This handles languages (Python, Rust, Go, …) that ProjectScanner doesn't index.
        const notFound = Array.from(affectedFileNames).filter(
            name => !Array.from(addedFiles).some(p => path.basename(p) === name)
        );

        if (notFound.length > 0) {
            console.log('[FixGenerator] Reading missing files directly from filesystem:', notFound);
            const vscode = require('vscode');
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

            if (!workspaceRoot) {
                console.log('[FixGenerator] No workspace root found');
                return result;
            }

            const fs = require('fs');

            for (const fileName of notFound) {
                try {
                    console.log(`[FixGenerator] Searching for ${fileName}...`);
                    const files = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 5);

                    if (files.length > 0) {
                        const fileUri = files[0];
                        if (!addedFiles.has(fileUri.fsPath)) {
                            const rawBytes = await vscode.workspace.fs.readFile(fileUri);
                            const content = Buffer.from(rawBytes).toString('utf8');
                            const relativePath = path.relative(workspaceRoot, fileUri.fsPath);
                            const ext = path.extname(fileUri.fsPath);

                            result.push({
                                path: fileUri.fsPath,
                                relativePath,
                                language: ext.replace('.', ''),
                                extension: ext,
                                content,
                                size: content.length,
                                includes: [],
                                functions: [],
                                classes: []
                            });
                            addedFiles.add(fileUri.fsPath);
                            console.log(`[FixGenerator] ✓ Read from disk: ${fileName} (${content.length} chars)`);
                        }
                    } else {
                        console.log(`[FixGenerator] ✗ File not found in workspace: ${fileName}`);
                    }
                } catch (err) {
                    console.error(`[FixGenerator] Error reading ${fileName}:`, err);
                }
            }
        }

        console.log(`[FixGenerator] Total files for fix context: ${result.length}`);
        return result;
    }

    /**
     * Parse fix plan from Boudica response
     * Tries multiple parsing strategies for robustness
     */
    private parseFixPlan(
        response: string,
        errors: ParsedError[],
        projectStructure: any
    ): ModificationPlan {
        console.log('[FixGenerator] Parsing response (first 500 chars):', response.substring(0, 500));
        
        const steps: ModificationStep[] = [];
        const affectedFiles = new Set<string>();
        const newFiles = new Set<string>();
        const lines = response.split('\n');
        
        for (const line of lines) {
            // Strategy 1: Standard format with "at" and dash
            // STEP N: ACTION FILENAME at LOCATION - DESCRIPTION
            let stepMatch = line.match(/STEP\s+(\d+):\s*(modify|create|delete)\s+([^\s]+)\s+at\s+([^\s-]+)\s*-\s*(.+)/i);
            
            if (stepMatch) {
                console.log('[FixGenerator] Matched standard format:', line);
                this.addStep(steps, affectedFiles, newFiles, {
                    stepNumber: parseInt(stepMatch[1]),
                    action: stepMatch[2].toLowerCase() as 'modify' | 'create' | 'delete',
                    fileName: stepMatch[3].trim(),
                    location: stepMatch[4].trim(),
                    description: stepMatch[5].trim()
                });
                continue;
            }
            
            // Strategy 2: Without location (dash separator required)
            // STEP N: ACTION FILENAME - DESCRIPTION
            stepMatch = line.match(/STEP\s+(\d+):\s*(modify|create|delete)\s+([^\s-]+)\s*-\s*(.+)/i);
            
            if (stepMatch) {
                console.log('[FixGenerator] Matched simple format:', line);
                this.addStep(steps, affectedFiles, newFiles, {
                    stepNumber: parseInt(stepMatch[1]),
                    action: stepMatch[2].toLowerCase() as 'modify' | 'create' | 'delete',
                    fileName: stepMatch[3].trim(),
                    location: undefined,
                    description: stepMatch[4].trim()
                });
                continue;
            }
            
            // Strategy 3: Numbered list with action verb
            // 1. Modify main.cpp: Add include
            // 1) Create logger.cpp to implement...
            stepMatch = line.match(/^\s*(\d+)[.):]\s*(modify|create|delete|add|fix)\s+([^:\s]+)\s*[:-]?\s*(.+)/i);
            
            if (stepMatch) {
                console.log('[FixGenerator] Matched numbered format:', line);
                let action = stepMatch[2].toLowerCase();
                if (action === 'add' || action === 'fix') {
                    action = 'modify'; // Normalize to standard actions
                }
                this.addStep(steps, affectedFiles, newFiles, {
                    stepNumber: parseInt(stepMatch[1]),
                    action: action as 'modify' | 'create' | 'delete',
                    fileName: stepMatch[3].trim(),
                    location: undefined,
                    description: stepMatch[4].trim()
                });
                continue;
            }
            
            // Strategy 4: Natural language descriptions
            // "Fix the comment syntax in word_analyzer.hpp line 23"
            // "Add set(CMAKE_CXX_STANDARD 11) in CMakeLists.txt"
            // "Change -- comment to // comment in file.cpp line 34"
            stepMatch = line.match(/(fix|change|replace|add|ensure|update)\s+(?:the\s+)?(.+?)\s+in\s+([^\s]+?)(?:\s+line\s+(\d+))?[.;,]?\s*(?:\((.+?)\))?/i);
            
            if (stepMatch) {
                console.log('[FixGenerator] Matched natural language:', line);
                const verb = stepMatch[1].toLowerCase();
                const what = stepMatch[2].trim();
                const fileName = stepMatch[3].trim();
                const lineNum = stepMatch[4] ? parseInt(stepMatch[4]) : undefined;
                const extra = stepMatch[5];
                
                // Determine action from verb
                let action: 'modify' | 'create' = 'modify';
                if (verb === 'add' && !line.toLowerCase().includes('adding to')) {
                    // "Add X in file" might mean create if file doesn't exist
                    // For now, default to modify (add content to existing file)
                    action = 'modify';
                }
                
                // Build description
                let description = `${verb.charAt(0).toUpperCase() + verb.slice(1)} ${what}`;
                if (extra) {
                    description += ` (${extra})`;
                }
                
                // Determine location
                let location = lineNum ? `line_${lineNum}` : undefined;
                if (!location && (what.includes('#include') || what.includes('include'))) {
                    location = 'beginning';
                } else if (!location && (verb === 'add' || verb === 'ensure')) {
                    location = 'end_of_file';
                }
                
                this.addStep(steps, affectedFiles, newFiles, {
                    stepNumber: steps.length + 1,
                    action,
                    fileName,
                    location,
                    description
                });
                continue;
            }
        }
        
        // Strategy 5: Extract implicit fixes from explanatory text
        // "Enable C++11 in CMake" -> modify CMakeLists.txt
        // "Add -std=c++11 flag" -> modify CMakeLists.txt
        if (steps.length === 0) {
            console.log('[FixGenerator] No explicit steps, trying to extract implicit fixes...');
            const implicitSteps = this.extractImplicitFixes(response, errors);
            steps.push(...implicitSteps);
            
            for (const step of implicitSteps) {
                if (step.action === 'modify') {
                    affectedFiles.add(step.fileName);
                } else if (step.action === 'create') {
                    newFiles.add(step.fileName);
                }
            }
        }
        
        console.log(`[FixGenerator] Parsed ${steps.length} steps from response`);
        
        return {
            steps,
            affectedFiles: Array.from(affectedFiles),
            newFiles: Array.from(newFiles)
        };
    }

    /**
     * Extract implicit fixes from explanatory text
     */
    private extractImplicitFixes(response: string, errors: ParsedError[]): ModificationStep[] {
        const steps: ModificationStep[] = [];
        let stepNum = 1;
        const lowerResponse = response.toLowerCase();
        
        console.log(`[FixGenerator] Extracting implicit fixes from ${errors.length} errors`);
        
        // Check for C++11/C++14/C++17 standard issues
        // Look at both response and error messages
        let needsCppStandard = false;
        let standard = '11';
        
        // Check response text
        if (lowerResponse.includes('c++11') || lowerResponse.includes('c++14') || lowerResponse.includes('c++17')) {
            needsCppStandard = true;
            if (lowerResponse.includes('c++17')) standard = '17';
            else if (lowerResponse.includes('c++14')) standard = '14';
        }
        
        // Also check if errors mention C++11 features
        const cpp11Features = ['find_if_not', 'find_if', 'is_sorted_until', 'is_sorted', 'all_of', 'any_of', 'none_of'];
        for (const error of errors) {
            if (error.message) {
                for (const feature of cpp11Features) {
                    if (error.message.includes(feature)) {
                        needsCppStandard = true;
                        console.log(`[FixGenerator] Detected C++11 feature '${feature}' in error, will set C++ standard`);
                        break;
                    }
                }
            }
            if (needsCppStandard) break;
        }
        
        if (needsCppStandard) {
            console.log(`[FixGenerator] Will modify CMakeLists.txt to set C++${standard} standard`);
            steps.push({
                stepNumber: stepNum++,
                action: 'modify',
                fileName: 'CMakeLists.txt',
                description: `Add set(CMAKE_CXX_STANDARD ${standard})`,
                insertionMode: InsertionMode.APPEND,
                targetLocation: 'end_of_file'
            });
        }
        
        // Check for comment syntax issues (-- token errors)
        // Always check error objects first (most reliable)
        const filesWithCommentIssues = new Set<string>();
        console.log(`[FixGenerator] Checking ${errors.length} errors for -- token issues`);
        
        for (const error of errors) {
            if (error.message && error.message.includes('--')) {
                console.log(`[FixGenerator] Error with '--': file=${error.file}, line=${error.line}, message=${error.message.substring(0, 100)}`);
            }
            
            // Look for -- token errors (various quote styles)
            const msgLower = error.message?.toLowerCase() || '';
            const hasTokenError = 
                msgLower.includes("before '--' token") ||
                msgLower.includes("before -- token") ||
                msgLower.includes('token') && msgLower.includes('--');
            
            if (error.file && hasTokenError && error.line) {
                const fileName = path.basename(error.file); // Use basename only
                const key = `${fileName}:${error.line}`;
                
                if (!filesWithCommentIssues.has(key)) {
                    filesWithCommentIssues.add(key);
                    console.log(`[FixGenerator] ✓ Detected -- token error in ${fileName} line ${error.line}`);
                    steps.push({
                        stepNumber: stepNum++,
                        action: 'modify',
                        fileName: fileName,
                        description: 'Replace -- or --- with // comment',
                        insertionMode: InsertionMode.BEFORE_LINE,
                        targetLocation: error.line.toString()
                    });
                }
            }
        }
        
        // Check for missing includes based on symbols
        const includeMatch = response.match(/add\s+`?#include\s*[<"]([^>"]+)[>"]`?/gi);
        if (includeMatch) {
            for (const match of includeMatch) {
                const headerMatch = match.match(/#include\s*[<"]([^>"]+)[>"]/i);
                if (headerMatch) {
                    const header = headerMatch[1];
                    // Find which file needs this include
                    for (const error of errors) {
                        if (error.file && (error.type === ErrorType.UNDECLARED_IDENTIFIER || error.type === ErrorType.MISSING_INCLUDE)) {
                            console.log(`[FixGenerator] Detected missing include <${header}> for ${error.file}`);
                            steps.push({
                                stepNumber: stepNum++,
                                action: 'modify',
                                fileName: error.file,
                                description: `Add #include <${header}>`,
                                insertionMode: InsertionMode.PREPEND,
                                targetLocation: 'includes'
                            });
                            break; // Only add once per include
                        }
                    }
                }
            }
        }
        
        console.log(`[FixGenerator] Extracted ${steps.length} implicit fixes:`);
        steps.forEach(s => console.log(`  - ${s.action} ${s.fileName}: ${s.description}`));
        return steps;
    }

    /**
     * Add a parsed step to the plan
     */
    private addStep(
        steps: ModificationStep[],
        affectedFiles: Set<string>,
        newFiles: Set<string>,
        parsed: {
            stepNumber: number,
            action: 'modify' | 'create' | 'delete',
            fileName: string,
            location?: string,
            description: string
        }
    ) {
        // Validate filename - reject markdown artifacts and invalid names
        // Normalise leading ./ which the build runner sometimes emits
        const fileName = parsed.fileName.trim().replace(/^\.\//, '');
        
        // Reject if:
        // - Empty or just whitespace
        // - Contains markdown artifacts (```, ---, ***, ___)
        // - Contains only special characters
        // - Doesn't look like a real filename
        if (!fileName || 
            fileName === '```' || 
            fileName.startsWith('```') ||
            fileName === '---' ||
            fileName === '***' ||
            /^[^a-zA-Z0-9_]/.test(fileName) || // Starts with non-alphanumeric (allow _ prefix)
            fileName.length < 3) {
            console.log(`[FixGenerator] Rejected invalid filename: '${fileName}'`);
            return;
        }
        
        // Must have an extension or be a known config file
        const validExtensions = [
            '.cpp', '.hpp', '.h', '.c', '.cc', '.cxx',
            '.py', '.pyw',
            '.rs',
            '.go',
            '.java',
            '.cs',
            '.kt', '.kts',
            '.rb',
            '.swift',
            '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
            '.txt', '.cmake', '.json', '.xml', '.md', '.yaml', '.yml', '.toml',
            '.sh', '.bash', '.zsh', '.fish',
            '.html', '.css', '.scss',
            '.sql',
            '.r', '.R'
        ];
        const configFiles = ['CMakeLists.txt', 'Makefile', 'makefile', 'package.json', 'Cargo.toml', 'go.mod',
                             'pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile', 'poetry.lock',
                             'Dockerfile', '.env', 'pom.xml', 'build.gradle'];
        
        const hasValidExtension = validExtensions.some(ext => fileName.endsWith(ext));
        const isConfigFile = configFiles.includes(fileName);
        
        if (!hasValidExtension && !isConfigFile) {
            console.log(`[FixGenerator] Rejected file without valid extension: '${fileName}'`);
            return;
        }
        
        let insertionMode: InsertionMode | undefined;
        let targetLocation: string | undefined = parsed.location;
        
        // Determine insertion mode from location or description
        if (parsed.location) {
            const loc = parsed.location.toLowerCase();
            if (loc.includes('line_')) {
                const lineMatch = parsed.location.match(/line_(\d+)/i);
                if (lineMatch) {
                    insertionMode = InsertionMode.BEFORE_LINE;
                    targetLocation = lineMatch[1];
                }
            } else if (loc.includes('function') || parsed.location.includes('()')) {
                insertionMode = InsertionMode.AFTER_FUNCTION;
            } else if (loc.includes('class')) {
                insertionMode = InsertionMode.INSIDE_CLASS;
            } else if (loc.includes('end')) {
                insertionMode = InsertionMode.APPEND;
            } else if (loc.includes('beginning') || loc.includes('start')) {
                insertionMode = InsertionMode.PREPEND;
            }
        }
        
        // Check description for hints
        const desc = parsed.description.toLowerCase();
        if (desc.includes('add #include') || desc.includes('include <') || desc.includes('include "')) {
            insertionMode = InsertionMode.PREPEND;
            targetLocation = 'includes';
        } else if (desc.includes('implement') && desc.includes('function')) {
            insertionMode = InsertionMode.APPEND;
        }
        
        steps.push({
            stepNumber: parsed.stepNumber,
            action: parsed.action,
            fileName: fileName,
            description: parsed.description,
            insertionMode,
            targetLocation
        });
        
        console.log(`[FixGenerator] Added step ${parsed.stepNumber}: ${parsed.action} ${fileName}`);
        
        if (parsed.action === 'modify') {
            affectedFiles.add(fileName);
        } else if (parsed.action === 'create') {
            newFiles.add(fileName);
        }
    }

    /**
     * Generate simple fixes for common error types without AI
     */
    private generateSimpleFixes(errors: ParsedError[]): ModificationStep[] {
        const steps: ModificationStep[] = [];
        let stepNumber = 1;
        
        for (const error of errors) {
            // Missing include fix
            if (error.type === ErrorType.UNDECLARED_IDENTIFIER && error.suggestedInclude && error.file) {
                steps.push({
                    stepNumber: stepNumber++,
                    action: 'modify',
                    fileName: error.file,
                    description: `Add #include ${error.suggestedInclude}`,
                    insertionMode: InsertionMode.PREPEND,
                    targetLocation: 'includes'
                });
            }
            
            // Undefined reference - needs implementation
            if (error.type === ErrorType.UNDEFINED_REFERENCE && error.symbol) {
                // Determine which file needs the implementation
                const funcName = error.symbol.includes('::') 
                    ? error.symbol.split('::').pop()
                    : error.symbol;
                
                if (funcName) {
                    steps.push({
                        stepNumber: stepNumber++,
                        action: 'create',
                        fileName: `${funcName.toLowerCase()}.cpp`,
                        description: `Implement missing function ${error.symbol}`,
                        insertionMode: InsertionMode.APPEND
                    });
                }
            }
        }
        
        return steps;
    }

    /**
     * Group errors by type
     */
    private groupErrorsByType(errors: ParsedError[]): Map<ErrorType, ParsedError[]> {
        const grouped = new Map<ErrorType, ParsedError[]>();
        
        for (const error of errors) {
            if (!grouped.has(error.type)) {
                grouped.set(error.type, []);
            }
            grouped.get(error.type)!.push(error);
        }
        
        return grouped;
    }
}
