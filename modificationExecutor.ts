/**
 * Modification Executor
 * Handles intelligent modification of existing multi-file projects
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BoudicaClient } from './boudicaClient';
import { ProjectScanner, FileInfo } from './projectScanner';
import { CodeInserter, InsertionMode, InsertionTarget } from './codeInsertion';
import { getStatusBarManager } from './statusBarManager';
import { SearchContext, CodeSearch } from './codeSearch';

export interface ModificationStep {
    stepNumber: number;
    action: 'modify' | 'create' | 'delete';
    fileName: string;
    description: string;
    insertionMode?: InsertionMode;
    targetLocation?: string; // function name, class name, or line number
}

export interface ModificationPlan {
    steps: ModificationStep[];
    affectedFiles: string[];
    newFiles: string[];
}

export interface BackupInfo {
    originalPath: string;
    backupPath: string;
    timestamp: Date;
    size: number;
}

/**
 * Resolve the directory where backups for a given file should be stored.
 * Uses .boudicode/backups/<relativePathToFile>/ inside the workspace root
 * (or the configurable boudicode.backupDirectory setting).
 * Falls back to alongside the file if no workspace is open.
 */
function resolveBackupDir(filePath: string): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const config = vscode.workspace.getConfiguration('boudicode');
    const customDir = config.get<string>('backupDirectory', '');

    if (customDir && path.isAbsolute(customDir)) {
        return customDir;
    }

    if (workspaceRoot) {
        const baseDir = customDir
            ? path.join(workspaceRoot, customDir)
            : path.join(workspaceRoot, '.boudicode', 'backups');
        const rel = path.relative(workspaceRoot, filePath);
        // Guard against paths escaping the workspace
        const normalised = path.normalize(rel);
        if (!normalised.startsWith('..')) {
            return path.join(baseDir, path.dirname(normalised));
        }
    }

    // Fallback: same directory as the file
    return path.dirname(filePath);
}

/**
 * Validate that a path sits inside an allowed root directory.
 * Throws if the resolved absolute path escapes the root.
 */
function assertPathInside(filePath: string, allowedRoot: string, label: string): void {
    const resolved = path.resolve(filePath);
    const resolvedRoot = path.resolve(allowedRoot);
    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
        throw new Error(`Security: ${label} path '${resolved}' is outside allowed root '${resolvedRoot}'`);
    }
}

/**
 * Create a timestamped backup of a file before modification.
 * Backups are stored in .boudicode/backups/<relPath>/ inside the workspace
 * (configurable via boudicode.backupDirectory).
 */
export async function createBackup(filePath: string): Promise<string> {
    try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        // Path traversal protection: file must be inside the workspace (if one is open)
        if (workspaceRoot) {
            assertPathInside(filePath, workspaceRoot, 'Source');
        }

        const now = new Date();
        const timestamp = now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0') + '.' +
            String(now.getHours()).padStart(2, '0') + '-' +
            String(now.getMinutes()).padStart(2, '0') + '-' +
            String(now.getSeconds()).padStart(2, '0');

        const backupDir = resolveBackupDir(filePath);
        await fs.promises.mkdir(backupDir, { recursive: true });

        const backupPath = path.join(backupDir, path.basename(filePath) + '.' + timestamp);

        const content = await fs.promises.readFile(filePath, 'utf8');
        await fs.promises.writeFile(backupPath, content, 'utf8');

        console.log('[ModificationExecutor] Created backup: ' + backupPath);
        return backupPath;

    } catch (error) {
        console.error('[ModificationExecutor] Failed to create backup:', error);
        throw new Error('Failed to create backup: ' + error);
    }
}

/**
 * List all backups for a given file.
 * Searches both the dedicated .boudicode/backups directory and (legacy) the file's own directory.
 * Returns array of backup paths sorted by timestamp (newest first).
 */
export async function listBackups(filePath: string): Promise<BackupInfo[]> {
    const backups: BackupInfo[] = [];
    const baseName = path.basename(filePath);
    const backupPattern = new RegExp('^' + baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\.\\d{4}-\\d{2}-\\d{2}\.\\d{2}-\\d{2}-\\d{2}$');

    async function scanDir(dir: string) {
        try {
            const files = await fs.promises.readdir(dir);
            for (const file of files) {
                if (!backupPattern.test(file)) { continue; }
                const bPath = path.join(dir, file);
                const stats = await fs.promises.stat(bPath);
                const m = file.match(/\.(\d{4})-(\d{2})-(\d{2})\.(\d{2})-(\d{2})-(\d{2})$/);
                if (m) {
                    backups.push({
                        originalPath: filePath,
                        backupPath: bPath,
                        timestamp: new Date(
                            parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]),
                            parseInt(m[4]), parseInt(m[5]), parseInt(m[6])
                        ),
                        size: stats.size
                    });
                }
            }
        } catch { /* directory may not exist */ }
    }

    // Search dedicated backup directory
    await scanDir(resolveBackupDir(filePath));

    // Also scan the file's own directory for legacy backups
    const legacyDir = path.dirname(filePath);
    if (legacyDir !== resolveBackupDir(filePath)) {
        await scanDir(legacyDir);
    }

    backups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return backups;
}

/**
 * Restore a file from a backup, with path traversal protection.
 */
export async function restoreFromBackup(backupPath: string, originalPath: string): Promise<boolean> {
    try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        // Validate both paths are inside workspace (if one is open)
        if (workspaceRoot) {
            const backupRoot = resolveBackupDir(originalPath);
            // backupPath must be in backup dir OR workspace (for legacy backups)
            const resolvedBackup = path.resolve(backupPath);
            const inBackupDir = resolvedBackup.startsWith(path.resolve(backupRoot));
            const inWorkspace = resolvedBackup.startsWith(path.resolve(workspaceRoot));
            if (!inBackupDir && !inWorkspace) {
                throw new Error(`Security: backup path '${resolvedBackup}' is outside allowed directories`);
            }
            assertPathInside(originalPath, workspaceRoot, 'Restore target');
        }

        if (!fs.existsSync(backupPath)) {
            throw new Error('Backup file not found: ' + backupPath);
        }

        // Create a backup of the current state before restoring
        if (fs.existsSync(originalPath)) {
            try { await createBackup(originalPath); } catch (e) {
                console.warn('[ModificationExecutor] Could not backup current state before restore:', e);
            }
        }

        const content = await fs.promises.readFile(backupPath, 'utf8');
        await fs.promises.writeFile(originalPath, content, 'utf8');

        console.log('[ModificationExecutor] Restored from backup: ' + backupPath);
        return true;

    } catch (error) {
        console.error('[ModificationExecutor] Failed to restore from backup:', error);
        return false;
    }
}

/**
 * Get the most recent backup for a file
 */
export async function getLatestBackup(filePath: string): Promise<BackupInfo | null> {
    const backups = await listBackups(filePath);
    return backups.length > 0 ? backups[0] : null;
}

/**
 * Delete old backups, keeping only the most recent N backups
 */
export async function cleanupOldBackups(filePath: string, keepCount: number = 10): Promise<number> {
    try {
        const backups = await listBackups(filePath);
        
        if (backups.length <= keepCount) {
            return 0;
        }
        
        // Delete old backups beyond keepCount
        const toDelete = backups.slice(keepCount);
        let deletedCount = 0;
        
        for (const backup of toDelete) {
            try {
                await fs.promises.unlink(backup.backupPath);
                deletedCount++;
                console.log('[ModificationExecutor] Deleted old backup: ' + backup.backupPath);
            } catch (error) {
                console.error('[ModificationExecutor] Failed to delete backup:', error);
            }
        }
        
        return deletedCount;
        
    } catch (error) {
        console.error('[ModificationExecutor] Failed to cleanup backups:', error);
        return 0;
    }
}

/**
 * Generate a modification plan based on user request and project structure
 */
export async function generateModificationPlan(
    client: BoudicaClient,
    userPrompt: string,
    scanner: ProjectScanner,
    workspaceRoot: string,
    searchContext?: SearchContext  // Optional search context from code search
): Promise<ModificationPlan | null> {
    const statusBarManager = getStatusBarManager();
    
    try {
        statusBarManager.showOperation('Analyzing', 'Scanning project structure...');
        
        // Scan the project to understand its structure (if not already provided via search)
        const projectStructure = await scanner.scanProject();
        
        if (projectStructure.totalFiles === 0) {
            statusBarManager.showError('No project files found');
            return null;
        }
        
        // Build context about the project (lighter weight if we have search results)
        const maxFiles = searchContext ? 5 : 15;  // Use fewer files if we have search results
        const projectContext = await scanner.buildProjectContext(maxFiles, 3000);
        
        statusBarManager.showOperation('Planning', 'Analyzing modifications needed...');
        
        // Build planning prompt with search context if available
        let planningPrompt = '';
        
        if (searchContext && searchContext.results.length > 0) {
            // Use search results as primary context
            const searchContextText = CodeSearch.formatContextForAI(searchContext);
            
            planningPrompt = `I have an existing project. I searched for relevant code and found:

${searchContextText}

Additional project info:
${projectContext}

User Request: ${userPrompt}

Based on the RELEVANT CODE CONTEXT above, provide a detailed modification plan. The search has already identified where related code exists, so use those files as your primary targets.

For each step, specify:
1. **Action**: modify, create, or delete
2. **File**: Which file to modify/create/delete (prefer files from the search results)
3. **Location**: Where to insert code (function name, class name, or "end of file")
4. **Description**: What changes to make

Format each step as:
STEP N: [ACTION] [FILENAME] at [LOCATION] - [DESCRIPTION]

Example:
STEP 1: modify downloader.cpp at add_logging_function - Add logging functionality to track downloads
STEP 2: create logger.hpp at end_of_file - Create logger header with log() function declaration
STEP 3: modify main.cpp at main_function - Add logger initialization in main()

Provide the complete modification plan.`;
        } else {
            // No search results - fall back to project-wide context
            planningPrompt = `I have an existing project with the following structure:

${projectContext}

User Request: ${userPrompt}

Analyze this request and provide a detailed modification plan. For each step, specify:

1. **Action**: modify, create, or delete
2. **File**: Which file to modify/create/delete (use exact filenames from the project structure above)
3. **Location**: Where to insert code (function name, class name, or "end of file")
4. **Description**: What changes to make

Format each step as:
STEP N: [ACTION] [FILENAME] at [LOCATION] - [DESCRIPTION]

Example:
STEP 1: modify downloader.cpp at add_logging_function - Add logging functionality to track downloads
STEP 2: create logger.hpp at end_of_file - Create logger header with log() function declaration
STEP 3: modify main.cpp at main_function - Add logger initialization in main()

Provide the complete modification plan. Think about:
- Which existing files need changes
- Whether new files are needed (headers, implementations)
- Dependencies between changes (do headers first, then implementations)
- Build system updates (CMakeLists.txt, package.json, etc.)`;
        }
        
        // Ask Boudica to generate a modification plan
        const response = await client.chat({
            message: planningPrompt,
            session_id: 'modplan-' + Date.now(),
            temperature: 0.7,
            max_tokens: 32000
        });

        statusBarManager.clearOperation();

        if (response.error || !response.response) {
            statusBarManager.showError('Planning failed');
            return null;
        }

        // Parse the modification plan
        const plan = parseModificationPlan(response.response, projectStructure);
        
        console.log(`[ModificationExecutor] Plan generated: ${plan.steps.length} steps`);
        console.log(`  Affecting ${plan.affectedFiles.length} files, creating ${plan.newFiles.length} new files`);
        
        return plan;
        
    } catch (error: any) {
        statusBarManager.showError('Planning failed');
        console.error('Modification plan generation error:', error);
        return null;
    }
}

/**
 * Parse Boudica's response into a modification plan
 */
function parseModificationPlan(planText: string, projectStructure: any): ModificationPlan {
    const steps: ModificationStep[] = [];
    const affectedFiles = new Set<string>();
    const newFiles = new Set<string>();
    const lines = planText.split('\n');
    
    for (const line of lines) {
        // Match: STEP N: [ACTION] [FILENAME] at [LOCATION] - [DESCRIPTION]
        const stepMatch = line.match(/STEP\s+(\d+):\s*(modify|create|delete)\s+([^\s]+)\s+(?:at\s+([^\s-]+))?\s*-\s*(.+)/i);
        
        if (stepMatch) {
            const stepNumber = parseInt(stepMatch[1]);
            const action = stepMatch[2].toLowerCase() as 'modify' | 'create' | 'delete';
            const fileName = stepMatch[3].trim();
            const location = stepMatch[4]?.trim();
            const description = stepMatch[5].trim();
            
            let insertionMode: InsertionMode | undefined;
            
            // Determine insertion mode from location
            if (location) {
                if (location.toLowerCase().includes('function') || location.includes('()')) {
                    insertionMode = InsertionMode.AFTER_FUNCTION;
                } else if (location.toLowerCase().includes('class')) {
                    insertionMode = InsertionMode.INSIDE_CLASS;
                } else if (location.toLowerCase().includes('end')) {
                    insertionMode = InsertionMode.APPEND;
                } else if (location.toLowerCase().includes('beginning') || location.toLowerCase().includes('start')) {
                    insertionMode = InsertionMode.PREPEND;
                } else {
                    insertionMode = InsertionMode.APPEND; // default
                }
            }
            
            steps.push({
                stepNumber,
                action,
                fileName,
                description,
                insertionMode,
                targetLocation: location
            });
            
            if (action === 'modify') {
                affectedFiles.add(fileName);
            } else if (action === 'create') {
                newFiles.add(fileName);
            }
        }
    }
    
    return {
        steps,
        affectedFiles: Array.from(affectedFiles),
        newFiles: Array.from(newFiles)
    };
}

/**
 * Execute a modification plan
 */
export async function executeModificationPlan(
    client: BoudicaClient,
    plan: ModificationPlan,
    scanner: ProjectScanner,
    userPrompt: string,
    workspaceRoot: string,
    onProgress?: (step: number, total: number, message: string) => void
): Promise<{ success: boolean; filesModified: string[]; filesCreated: string[] }> {
    const statusBarManager = getStatusBarManager();
    const inserter = new CodeInserter();
    const filesModified: string[] = [];
    const filesCreated: string[] = [];
    
    try {
        const totalSteps = plan.steps.length;
        let currentStep = 0;
        
        console.log(`[ModificationExecutor] Executing ${totalSteps} steps`);
        
        // Get project structure for context
        const projectStructure = await scanner.scanProject();
        
        for (const step of plan.steps) {
            currentStep++;
            
            if (onProgress) {
                onProgress(currentStep, totalSteps, `${step.action} ${step.fileName}...`);
            }
            
            statusBarManager.showOperation(
                step.action === 'create' ? 'Creating' : 'Modifying',
                `${step.fileName} (${currentStep}/${totalSteps})`
            );
            
            if (step.action === 'create') {
                // Create new file
                const success = await createNewFileInProject(
                    client,
                    step.fileName,
                    step.description,
                    userPrompt,
                    workspaceRoot,
                    projectStructure
                );
                
                if (success) {
                    filesCreated.push(step.fileName);
                }
                
            } else if (step.action === 'modify') {
                // Modify existing file
                const success = await modifyExistingFile(
                    client,
                    step.fileName,
                    step.description,
                    step.insertionMode || InsertionMode.APPEND,
                    step.targetLocation,
                    userPrompt,
                    workspaceRoot,
                    projectStructure,
                    inserter
                );
                
                if (success) {
                    filesModified.push(step.fileName);
                }
                
            } else if (step.action === 'delete') {
                // Delete file (with confirmation)
                const filePath = path.join(workspaceRoot, step.fileName);
                if (fs.existsSync(filePath)) {
                    const answer = await vscode.window.showWarningMessage(
                        `Delete ${step.fileName}?`,
                        { modal: true },
                        'Yes', 'No'
                    );
                    
                    if (answer === 'Yes') {
                        await fs.promises.unlink(filePath);
                        filesModified.push(step.fileName);
                    }
                }
            }
        }
        
        statusBarManager.clearOperation();
        statusBarManager.showSuccess(
            `Modified ${filesModified.length} files, created ${filesCreated.length} files`,
            5000
        );
        
        // Invalidate scanner cache after modifications
        await scanner.scanProject();
        
        return { success: true, filesModified, filesCreated };
        
    } catch (error: any) {
        statusBarManager.showError('Modification failed');
        console.error('Modification execution error:', error);
        return { success: false, filesModified, filesCreated };
    }
}

/**
 * Extract simple code directly from description if it's a straightforward insertion
 * Returns null if AI generation is needed
 */
function extractSimpleCodeFromDescription(description: string, insertionMode: InsertionMode): string | null {
    const descLower = description.toLowerCase();
    
    // Pattern 1: "Add [exact code]" - but check for duplicates first
    // Example: "Add set(CMAKE_CXX_STANDARD 11)"
    const addMatch = description.match(/^(?:add|insert)\s+(.+)$/i);
    if (addMatch && insertionMode === InsertionMode.APPEND) {
        const code = addMatch[1].trim();
        // Simple one-liners that look like exact code
        if (code.length < 200 && !code.includes('\n')) {
            console.log(`[ModificationExecutor] Extracted simple add: ${code}`);
            // Signal that this needs content checking (will be handled by caller)
            return code;
        }
    }
    
    // Pattern 2: "Add #include <header>"
    const includeMatch = description.match(/add\s+#include\s*[<"]([^>"]+)[>"]/i);
    if (includeMatch) {
        const header = includeMatch[1];
        const includeStatement = includeMatch[0].match(/</) ? `#include <${header}>` : `#include "${header}"`;
        console.log(`[ModificationExecutor] Extracted include: ${includeStatement}`);
        return includeStatement;
    }
    
    // Pattern 3: "Replace [X] with [Y]" or "Change [X] to [Y]"
    // Example: "Replace -- comment with // comment"
    // For BEFORE_LINE insertions, we need to read the line first (handled separately)
    if ((descLower.includes('replace') || descLower.includes('change')) && 
        (descLower.includes('--') || descLower.includes('---')) &&
        (descLower.includes('//') || descLower.includes('comment'))) {
        // Signal that this needs special handling - read line, replace text
        return null; // Will be handled by reading the actual line
    }
    
    // Not a simple case - needs AI
    return null;
}

/**
 * Replace text in file content
 */
async function replaceInFileContent(
    filePath: string,
    oldText: string,
    newText: string
): Promise<boolean> {
    try {
        // Create backup before modification
        try {
            await createBackup(filePath);
        } catch (backupError) {
            console.error('[ModificationExecutor] Failed to create backup:', backupError);
            // Continue anyway for text replacement - it's low risk
        }
        
        const doc = await vscode.workspace.openTextDocument(filePath);
        const fullText = doc.getText();
        const index = fullText.indexOf(oldText);
        
        if (index === -1) {
            console.error(`[ModificationExecutor] Text not found in file: ${oldText}`);
            return false;
        }
        
        const startPos = doc.positionAt(index);
        const endPos = doc.positionAt(index + oldText.length);
        
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            vscode.Uri.file(filePath),
            new vscode.Range(startPos, endPos),
            newText
        );
        
        return await vscode.workspace.applyEdit(edit);
        
    } catch (error) {
        console.error('[ModificationExecutor] Error replacing text:', error);
        return false;
    }
}

/**
 * Handle line-based replacement operations (e.g., replacing -- with //)
 */
async function handleLineReplacement(
    filePath: string,
    description: string,
    lineNumber: number
): Promise<boolean> {
    try {
        const descLower = description.toLowerCase();
        
        // Check if this is a replace operation
        if (!descLower.includes('replace') && !descLower.includes('change')) {
            return false;
        }
        
        // Create backup before modification
        try {
            await createBackup(filePath);
        } catch (backupError) {
            console.error('[ModificationExecutor] Failed to create backup:', backupError);
            // Continue anyway for line replacement - it's low risk
        }
        
        // Read the file
        const doc = await vscode.workspace.openTextDocument(filePath);
        if (lineNumber < 1 || lineNumber > doc.lineCount) {
            console.error('[ModificationExecutor] Line ' + lineNumber + ' out of range (1-' + doc.lineCount + ')');
            return false;
        }
        
        const line = doc.lineAt(lineNumber - 1); // 0-indexed
        let newText = line.text;
        
        console.log('[ModificationExecutor] Original line ' + lineNumber + ': "' + newText + '"');
        
        // Pattern: Replace -- or --- with //
        if ((descLower.includes('--') || descLower.includes('---')) && 
            descLower.includes('//')) {
            
            const trimmed = newText.trim();
            
            // Replace entire line if it's just --- or --
            if (trimmed === '---' || trimmed === '--') {
                newText = newText.replace(trimmed, '//');
                console.log('[ModificationExecutor] Replacing --- or -- with //');
            }
            // Replace -- or --- within the line
            else if (newText.includes('---')) {
                newText = newText.replace(/---+/g, '//');
                console.log('[ModificationExecutor] Replacing --- with // in line');
            }
            else if (newText.includes('--')) {
                newText = newText.replace(/--+/g, '//');
                console.log('[ModificationExecutor] Replacing -- with // in line');
            }
        }
        
        // Apply the edit
        if (newText !== line.text) {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                vscode.Uri.file(filePath),
                line.range,
                newText
            );
            
            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                console.log('[ModificationExecutor] Successfully replaced line ' + lineNumber);
                console.log('[ModificationExecutor] New line ' + lineNumber + ': "' + newText + '"');
                return true;
            }
        } else {
            console.log('[ModificationExecutor] No changes needed for line ' + lineNumber);
            return true;
        }
        
        return false;
        
    } catch (error) {
        console.error('[ModificationExecutor] Error handling line replacement:', error);
        return false;
    }
}

/**
 * Create a new file in the project
 */
async function createNewFileInProject(
    client: BoudicaClient,
    fileName: string,
    description: string,
    userPrompt: string,
    workspaceRoot: string,
    projectStructure: any
): Promise<boolean> {
    try {
        // Build context from related files
        const relatedContext = buildRelatedFileContext(fileName, projectStructure);
        
        const prompt = `I'm adding functionality to an existing project.

User Request: ${userPrompt}

Create a new file: **${fileName}**
Purpose: ${description}

${relatedContext}

Requirements:
- Write complete, production-ready code
- Make it compatible with the existing project structure
- Follow the same coding style as existing files
- Include all necessary headers/imports

**OUTPUT**: Return executable source code only.`;

        const response = await client.chat({
            message: prompt,
            session_id: 'create-mod-' + Date.now(),
            temperature: 0.7,
            max_tokens: 32000,
            forCodeGeneration: true
        });

        if (response.error || !response.response) {
            return false;
        }

        const code = extractCodeFromResponse(response.response);
        
        // Security: prevent AI-generated fileName from escaping workspace
        const normalizedFileName = path.normalize(fileName).replace(/^(\.\.\/|\.\.\\)+/, '');
        let savePath = normalizedFileName;
        const srcDir = path.join(workspaceRoot, 'src');
        if (fs.existsSync(srcDir) && (normalizedFileName.endsWith('.cpp') || normalizedFileName.endsWith('.hpp'))) {
            savePath = path.join('src', path.basename(normalizedFileName));
        }
        
        const filePath = path.join(workspaceRoot, savePath);
        // Final traversal check
        if (!path.resolve(filePath).startsWith(path.resolve(workspaceRoot) + path.sep)) {
            console.error(`[ModificationExecutor] Rejected path traversal attempt: ${filePath}`);
            return false;
        }
        const fileDir = path.dirname(filePath);
        
        if (!fs.existsSync(fileDir)) {
            fs.mkdirSync(fileDir, { recursive: true });
        }
        
        await fs.promises.writeFile(filePath, code, 'utf-8');
        
        // Open the file
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
        
        return true;
        
    } catch (error) {
        console.error(`Error creating ${fileName}:`, error);
        return false;
    }
}

/**
 * Modify an existing file
 */
async function modifyExistingFile(
    client: BoudicaClient,
    fileName: string,
    description: string,
    insertionMode: InsertionMode,
    targetLocation: string | undefined,
    userPrompt: string,
    workspaceRoot: string,
    projectStructure: any,
    inserter: CodeInserter
): Promise<boolean> {
    try {
        // Find the file in all project file categories
        const allFiles = [
            ...projectStructure.sourceFiles,
            ...projectStructure.headerFiles,
            ...projectStructure.configFiles,
            ...projectStructure.buildFiles  // Include build files (CMakeLists.txt, etc.)
        ];
        
        console.log(`[ModificationExecutor] Searching for ${fileName} in ${allFiles.length} files`);
        
        const fileInfo = allFiles.find((f: FileInfo) => 
            f.relativePath === fileName || 
            path.basename(f.path) === fileName ||
            f.path.endsWith(fileName)
        );
        
        if (!fileInfo) {
            console.error(`[ModificationExecutor] File ${fileName} not found in project`);
            console.log(`[ModificationExecutor] Available files:`, allFiles.map(f => path.basename(f.path)).join(', '));
            return false;
        }
        
        console.log(`[ModificationExecutor] Found ${fileName} at ${fileInfo.path}`);
        
        // Create backup before any modification
        try {
            await createBackup(fileInfo.path);
        } catch (backupError) {
            console.error('[ModificationExecutor] Failed to create backup, aborting modification:', backupError);
            vscode.window.showErrorMessage('Failed to create backup for ' + fileName + '. Modification aborted for safety.');
            return false;
        }
        
        // Check if this is a simple text insertion that doesn't need AI
        const simpleCode = extractSimpleCodeFromDescription(description, insertionMode);
        let code: string;
        
        if (simpleCode) {
            console.log(`[ModificationExecutor] Using simple code extraction: ${simpleCode.substring(0, 100)}`);
            
            // Check for duplicate content before appending
            if (insertionMode === InsertionMode.APPEND && fileInfo.content.includes(simpleCode)) {
                console.log(`[ModificationExecutor] Code already exists in file, skipping: ${simpleCode}`);
                return true; // Already exists, treat as success
            }
            
            // Special handling for CMAKE_CXX_STANDARD - update existing or add new
            if (simpleCode.includes('CMAKE_CXX_STANDARD')) {
                const existingStandardMatch = fileInfo.content.match(/set\s*\(\s*CMAKE_CXX_STANDARD\s+(\d+)\s*\)/i);
                if (existingStandardMatch) {
                    const existingVersion = existingStandardMatch[1];
                    const newVersionMatch = simpleCode.match(/CMAKE_CXX_STANDARD\s+(\d+)/i);
                    const newVersion = newVersionMatch ? newVersionMatch[1] : '11';
                    
                    console.log(`[ModificationExecutor] CMAKE_CXX_STANDARD already set to ${existingVersion}, requested ${newVersion}`);
                    
                    // If existing is higher or equal, skip
                    if (parseInt(existingVersion) >= parseInt(newVersion)) {
                        console.log(`[ModificationExecutor] Existing C++ standard (${existingVersion}) is sufficient, skipping`);
                        return true;
                    }
                    
                    // Replace the existing line with new version
                    const replaceSuccess = await replaceInFileContent(
                        fileInfo.path,
                        existingStandardMatch[0],
                        `set(CMAKE_CXX_STANDARD ${newVersion})`
                    );
                    
                    if (replaceSuccess) {
                        console.log(`[ModificationExecutor] Updated CMAKE_CXX_STANDARD from ${existingVersion} to ${newVersion}`);
                        const doc = await vscode.workspace.openTextDocument(fileInfo.path);
                        await vscode.window.showTextDocument(doc);
                        return true;
                    }
                }
            }
            
            code = simpleCode;
        } else {
            // Build context for AI-generated code
            const relatedContext = buildRelatedFileContext(fileName, projectStructure);
            const currentFileContext = `\n**Current ${fileName} contents:**\n\`\`\`${fileInfo.language}\n${fileInfo.content.substring(0, 5000)}\n\`\`\`\n`;
            
            const prompt = `I'm modifying an existing project file.

User Request: ${userPrompt}

Modify: **${fileName}**
Task: ${description}
${targetLocation ? `Location: ${targetLocation}` : ''}

${currentFileContext}

${relatedContext}

Generate ONLY the code that needs to be ${insertionMode === InsertionMode.APPEND ? 'appended' : insertionMode === InsertionMode.REPLACE_FUNCTION ? 'replaced' : 'inserted'}.

${insertionMode === InsertionMode.REPLACE_FUNCTION && targetLocation ? 
`Replace the entire ${targetLocation} function with your new implementation.` : 
insertionMode === InsertionMode.AFTER_FUNCTION && targetLocation ?
`This code will be inserted after the ${targetLocation} function.` :
insertionMode === InsertionMode.INSIDE_CLASS && targetLocation ?
`This code will be inserted inside the ${targetLocation} class.` :
`This code will be appended to the file.`}

Do NOT include the entire file, only the new/modified code.
**OUTPUT**: Return executable source code only.`;

            const response = await client.chat({
                message: prompt,
                session_id: 'modify-' + Date.now(),
                temperature: 0.7,
                max_tokens: 32000,
                forCodeGeneration: true
            });

            if (response.error || !response.response) {
                return false;
            }

            code = extractCodeFromResponse(response.response);
        }
        
        // Determine insertion target
        const target: InsertionTarget = {
            mode: insertionMode
        };
        
        if (targetLocation) {
            // Parse target location based on insertion mode
            if (insertionMode === InsertionMode.AFTER_FUNCTION || insertionMode === InsertionMode.REPLACE_FUNCTION || insertionMode === InsertionMode.BEFORE_FUNCTION) {
                // Extract function name
                const funcMatch = targetLocation.match(/(\w+)/);
                if (funcMatch) {
                    target.functionName = funcMatch[1];
                }
            } else if (insertionMode === InsertionMode.INSIDE_CLASS) {
                // Extract class name
                const classMatch = targetLocation.match(/(\w+)/);
                if (classMatch) {
                    target.className = classMatch[1];
                }
            } else if (insertionMode === InsertionMode.BEFORE_LINE || insertionMode === InsertionMode.AFTER_LINE) {
                // Parse line number
                const lineNum = parseInt(targetLocation, 10);
                if (!isNaN(lineNum)) {
                    target.lineNumber = lineNum;
                    console.log(`[ModificationExecutor] Set line number target: ${lineNum}`);
                    
                    // Special handling for text replacements on specific lines
                    if (insertionMode === InsertionMode.BEFORE_LINE && !simpleCode) {
                        const replaceResult = await handleLineReplacement(
                            fileInfo.path,
                            description,
                            lineNum
                        );
                        
                        if (replaceResult) {
                            console.log(`[ModificationExecutor] Applied line replacement at line ${lineNum}`);
                            
                            // Open the file to show changes
                            const doc = await vscode.workspace.openTextDocument(fileInfo.path);
                            await vscode.window.showTextDocument(doc);
                            
                            return true;
                        }
                    }
                } else {
                    console.error(`[ModificationExecutor] Invalid line number: ${targetLocation}`);
                }
            }
        }
        
        // Apply the modification
        const result = await inserter.insertCode(fileInfo.path, code, target);
        
        if (result.success) {
            console.log(`[ModificationExecutor] Successfully modified ${fileName}`);
            
            // Open the file to show changes
            const doc = await vscode.workspace.openTextDocument(fileInfo.path);
            await vscode.window.showTextDocument(doc);
            
            return true;
        } else {
            console.error(`[ModificationExecutor] Failed to modify ${fileName}: ${result.error}`);
            return false;
        }
        
    } catch (error) {
        console.error(`Error modifying ${fileName}:`, error);
        return false;
    }
}

/**
 * Build context from related files
 */
function buildRelatedFileContext(fileName: string, projectStructure: any): string {
    let context = '';
    
    // For .cpp files, include their headers
    if (fileName.endsWith('.cpp')) {
        const baseName = path.basename(fileName, '.cpp');
        const header = projectStructure.headerFiles.find((f: FileInfo) => 
            path.basename(f.path, path.extname(f.path)) === baseName
        );
        
        if (header) {
            context += `\n**Related header ${header.relativePath}:**\n\`\`\`cpp\n${header.content.substring(0, 3000)}\n\`\`\`\n`;
        }
    }
    
    // For .hpp files, show .cpp if exists
    if (fileName.endsWith('.hpp') || fileName.endsWith('.h')) {
        const baseName = path.basename(fileName, path.extname(fileName));
        const source = projectStructure.sourceFiles.find((f: FileInfo) => 
            path.basename(f.path, path.extname(f.path)) === baseName
        );
        
        if (source) {
            context += `\n**Related implementation ${source.relativePath}:**\n\`\`\`cpp\n${source.content.substring(0, 3000)}\n\`\`\`\n`;
        }
    }
    
    return context;
}

/**
 * Extract code from Boudica response (handles markdown, HTML, plain text)
 */
function extractCodeFromResponse(response: string): string {
    // 1. Try markdown code block first
    const codeBlockMatch = response.match(/```(?:\w+)?\n([\s\S]+?)\n```/);
    if (codeBlockMatch) {
        return codeBlockMatch[1].trim();
    }
    
    // 2. Check if response is HTML wrapped
    if (response.includes('<!DOCTYPE html>') || response.includes('<html>')) {
        let code = response;
        
        const preMatch = code.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
        if (preMatch) {
            code = preMatch[1];
        }
        
        code = code.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '$1');
        code = code.replace(/<[^>]+>/g, '');
        
        // Decode HTML entities
        code = code.replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&amp;/g, '&')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'")
                   .replace(/&nbsp;/g, ' ');
        
        return code.trim();
    }
    
    // 3. Plain text
    return response.trim();
}
