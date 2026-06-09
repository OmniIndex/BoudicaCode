/**
 * Code Augmentation Module
 * Reads workspace code and adds new functionality using Boudica AI
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BoudicaClient } from './boudicaClient';
import { getStatusBarManager } from './statusBarManager';

interface CodeFile {
    path: string;
    relativePath: string;
    content: string;
    language: string;
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
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.scala': 'scala'
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
    'coverage'
];

export async function augmentCode(client: BoudicaClient, targetUri?: vscode.Uri): Promise<void> {
    const statusBarManager = getStatusBarManager();
    
    try {
        // Step 1: Ensure we have a workspace
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Please open a workspace first.');
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const targetPath = targetUri?.fsPath || workspaceRoot;

        // Step 2: Get augmentation request from user
        const augmentationType = await vscode.window.showQuickPick([
            {
                label: 'Add Feature',
                description: 'Add a new feature to existing code',
                detail: 'e.g., Add authentication, Add logging, Add error handling'
            },
            {
                label: 'Improve Code',
                description: 'Enhance existing code quality',
                detail: 'e.g., Optimize performance, Add documentation, Refactor for clarity'
            },
            {
                label: 'Add Tests',
                description: 'Generate tests for existing code',
                detail: 'Unit tests, integration tests, E2E tests'
            },
            {
                label: 'Add Documentation',
                description: 'Generate comprehensive documentation',
                detail: 'JSDoc, docstrings, README sections'
            },
            {
                label: 'Custom Request',
                description: 'Describe your own augmentation',
                detail: 'Any custom code modification or addition'
            }
        ], {
            placeHolder: 'What would you like to add to your code?',
            title: 'BoudiCode: Augment Code'
        });

        if (!augmentationType) {
            return;
        }

        // Step 3: Get detailed requirements
        let prompt = '';
        if (augmentationType.label === 'Custom Request') {
            const input = await vscode.window.showInputBox({
                prompt: 'Describe what you want to add or modify',
                placeHolder: 'Add user authentication with JWT tokens...',
                validateInput: (value) => {
                    if (!value || value.trim().length < 10) {
                        return 'Please provide a detailed description (at least 10 characters)';
                    }
                    return null;
                }
            });
            if (!input) {
                return;
            }
            prompt = input;
        } else {
            const input = await vscode.window.showInputBox({
                prompt: `Describe the ${augmentationType.label.toLowerCase()} in detail`,
                placeHolder: augmentationType.detail,
                validateInput: (value) => {
                    if (!value || value.trim().length < 5) {
                        return 'Please provide more details (at least 5 characters)';
                    }
                    return null;
                }
            });
            if (!input) {
                return;
            }
            prompt = `${augmentationType.label}: ${input}`;
        }

        // Step 4: Scan and read code files
        statusBarManager.showOperation('Augmenting', `Adding ${augmentationType.label.toLowerCase()}...`);
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Augmenting code...',
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Reading workspace files...' });

            const codeFiles = await scanCodeFiles(targetPath, workspaceRoot);
            
            if (codeFiles.length === 0) {
                throw new Error('No code files found in the workspace');
            }

            progress.report({ message: `Analyzing ${codeFiles.length} files...` });

            // Prepare context with code files
            const codeContext = buildCodeContext(codeFiles);

            // Build augmentation prompt (detailed instructions for AI)
            const augmentationRequest = buildAugmentationPrompt(prompt, augmentationType.label);

            progress.report({ message: 'Generating augmented code...' });

            // Send to Boudica with files as multipart/form-data (same as chat interface)
            const response = await client.chat({
                message: augmentationRequest,
                session_id: `code-augmentation-${Date.now()}`,
                max_tokens: 32000,
                temperature: 0.7,
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

            progress.report({ message: 'Applying changes...' });

            // Parse and apply changes
            const modifiedFiles = await applyAugmentation(workspaceRoot, response.response);

            progress.report({ message: 'Code augmentation complete!' });

            // Show results
            if (modifiedFiles.length > 0) {
                const fileList = modifiedFiles.map(f => path.relative(workspaceRoot, f)).join('\n- ');
                const openFirst = await vscode.window.showInformationMessage(
                    `Code augmentation complete!\n\nModified/created files:\n- ${fileList}`,
                    'View Changes', 'OK'
                );

                if (openFirst === 'View Changes' && modifiedFiles.length > 0) {
                    const doc = await vscode.workspace.openTextDocument(modifiedFiles[0]);
                    await vscode.window.showTextDocument(doc);
                }
            } else {
                vscode.window.showInformationMessage('Code augmentation complete! Check the AI response for recommendations.');
            }
            
            // Show success in status bar
            statusBarManager.showSuccess(`Augmentation complete: ${modifiedFiles.length} files modified`, 3000);
        });

    } catch (error: any) {
        statusBarManager.showError('Augmentation failed');
        vscode.window.showErrorMessage(`Code augmentation failed: ${error.message}`);
        console.error('Code augmentation error:', error);
    }
}

async function scanCodeFiles(targetPath: string, workspaceRoot: string): Promise<CodeFile[]> {
    const files: CodeFile[] = [];
    
    async function scanDirectory(dirPath: string) {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            
            // Skip ignored patterns
            if (IGNORE_PATTERNS.some(pattern => entry.name.includes(pattern))) {
                continue;
            }
            
            if (entry.isDirectory()) {
                await scanDirectory(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (CODE_EXTENSIONS[ext]) {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        // Skip very large files (>500KB)
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
        // Single file
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

function buildCodeContext(files: CodeFile[]): string {
    let context = 'Existing Code Files:\n\n';
    
    // Limit total context size
    const maxFilesInContext = 20;
    const filesToInclude = files.slice(0, maxFilesInContext);
    
    for (const file of filesToInclude) {
        context += `FILE: ${file.relativePath}\n`;
        context += '```' + file.language + '\n';
        context += file.content.substring(0, 10000); // Limit each file to 10KB
        if (file.content.length > 10000) {
            context += '\n... (truncated)';
        }
        context += '\n```\n\n';
    }
    
    if (files.length > maxFilesInContext) {
        context += `\n... and ${files.length - maxFilesInContext} more files\n`;
    }
    
    return context;
}

function buildAugmentationPrompt(userRequest: string, augmentationType: string): string {
    return `You are an expert software engineer. I need you to augment the existing codebase based on the following request:

${userRequest}

Augmentation Type: ${augmentationType}

The code files have been attached for your analysis.

Please:
1. Analyze the existing code structure and patterns from the attached files
2. Generate the necessary changes, additions, or new files
3. Ensure the augmentation integrates seamlessly with existing code
4. Follow the project's coding conventions and style
5. Include proper error handling and documentation
6. Make the code production-ready

Provide your response in this format:

FILE: path/to/file.ext
\`\`\`language
complete file content with modifications
\`\`\`

For new files, create them. For existing files, provide the complete modified version.
Include explanatory comments about what was changed and why.

Make sure all code is:
- Production-ready
- Well-documented
- Follows best practices
- Integrates with existing code
- Includes error handling and validation`;
}

async function applyAugmentation(workspaceRoot: string, boudicaResponse: string): Promise<string[]> {
    // Parse response for files
    const filePattern = /FILE:\s*(.+?)\n```(\w+)?\n([\s\S]*?)```/g;
    const files: { path: string; content: string }[] = [];
    
    let match;
    while ((match = filePattern.exec(boudicaResponse)) !== null) {
        const filePath = match[1].trim();
        const content = match[3];
        files.push({ path: filePath, content });
    }
    
    const modifiedFiles: string[] = [];
    
    for (const file of files) {
        const fullPath = path.join(workspaceRoot, file.path);
        const dir = path.dirname(fullPath);
        
        // Create directory if needed
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        const fileExists = fs.existsSync(fullPath);
        
        // For existing files, ask for confirmation
        if (fileExists) {
            const action = await vscode.window.showWarningMessage(
                `File "${file.path}" will be modified. Continue?`,
                'Yes', 'Show Diff', 'Skip', 'Cancel'
            );
            
            if (action === 'Cancel') {
                throw new Error('Operation cancelled by user');
            }
            
            if (action === 'Skip') {
                continue;
            }
            
            if (action === 'Show Diff') {
                // Create a temp file with new content
                const tempPath = fullPath + '.boudica.tmp';
                fs.writeFileSync(tempPath, file.content, 'utf8');
                
                // Open diff view
                await vscode.commands.executeCommand('vscode.diff',
                    vscode.Uri.file(fullPath),
                    vscode.Uri.file(tempPath),
                    `${path.basename(file.path)} (Current ↔ Proposed)`
                );
                
                const apply = await vscode.window.showInformationMessage(
                    'Apply these changes?',
                    'Yes', 'No'
                );
                
                if (apply === 'Yes') {
                    fs.renameSync(tempPath, fullPath);
                    modifiedFiles.push(fullPath);
                } else {
                    fs.unlinkSync(tempPath);
                }
                continue;
            }
        }
        
        // Write the file
        fs.writeFileSync(fullPath, file.content, 'utf8');
        modifiedFiles.push(fullPath);
    }
    
    return modifiedFiles;
}
