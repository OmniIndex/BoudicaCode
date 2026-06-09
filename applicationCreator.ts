/**
 * Application Creation Module
 * Handles creating new applications/modules within existing projects
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BoudicaClient } from './boudicaClient';

export interface ApplicationType {
    name: string;
    description: string;
    examples: string[];
}

const APPLICATION_TYPES: ApplicationType[] = [
    {
        name: 'REST API Endpoint',
        description: 'Create a new REST API endpoint with routes, controllers, and models',
        examples: ['User management API', 'Product catalog API', 'Authentication API']
    },
    {
        name: 'Database Model',
        description: 'Create database models/schemas with migrations',
        examples: ['User model', 'Product model', 'Order model']
    },
    {
        name: 'Service/Business Logic',
        description: 'Create a service layer for business logic',
        examples: ['Payment service', 'Email service', 'Notification service']
    },
    {
        name: 'UI Component',
        description: 'Create a reusable UI component',
        examples: ['Login form', 'Data table', 'Dashboard widget']
    },
    {
        name: 'CLI Command',
        description: 'Create a command-line interface command',
        examples: ['Database migration', 'User admin tool', 'Report generator']
    },
    {
        name: 'Test Suite',
        description: 'Create comprehensive tests for existing code',
        examples: ['Unit tests', 'Integration tests', 'E2E tests']
    },
    {
        name: 'Utility/Helper Module',
        description: 'Create utility functions and helpers',
        examples: ['Date formatter', 'Validation helpers', 'API client wrapper']
    },
    {
        name: 'Custom Application',
        description: 'Describe your own application component',
        examples: []
    }
];

export async function createApplication(client: BoudicaClient): Promise<void> {
    try {
        // Step 1: Ensure we have a workspace
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Please open a workspace first before creating an application.');
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

        // Step 2: Select application type
        const typeItems = APPLICATION_TYPES.map(t => ({
            label: t.name,
            description: t.description,
            detail: t.examples.length > 0 ? `Examples: ${t.examples.join(', ')}` : '',
            type: t
        }));

        const selectedType = await vscode.window.showQuickPick(typeItems, {
            placeHolder: 'Select application type',
            title: 'BoudiCode: Create Application'
        });

        if (!selectedType) {
            return;
        }

        // Step 3: Get application name
        const appName = await vscode.window.showInputBox({
            prompt: 'Enter application/module name',
            placeHolder: 'UserAuthService',
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Application name cannot be empty';
                }
                return null;
            }
        });

        if (!appName) {
            return;
        }

        // Step 4: Get detailed requirements
        const requirements = await vscode.window.showInputBox({
            prompt: 'Describe the application requirements in detail',
            placeHolder: 'e.g., User authentication with JWT tokens, password reset, email verification...',
            validateInput: (value) => {
                if (!value || value.trim().length < 10) {
                    return 'Please provide detailed requirements (at least 10 characters)';
                }
                return null;
            }
        });

        if (!requirements) {
            return;
        }

        // Step 5: Read existing project context
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Creating ${appName}...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Analyzing project structure...' });

            // Gather project context
            const projectContext = await gatherProjectContext(workspaceRoot);

            progress.report({ message: 'Generating application code...' });

            // Build prompt for Boudica
            const prompt = buildApplicationPrompt(
                selectedType.type,
                appName,
                requirements,
                projectContext
            );

            // Request application code from Boudica
            const response = await client.chat({
                message: prompt,
                session_id: `app-creation-${Date.now()}`,
                max_tokens: 32000,
                temperature: 0.7,
                use_rag: true
            });

            if (response.error) {
                throw new Error(response.error);
            }

            if (!response.response) {
                throw new Error('No response from Boudica');
            }

            // Parse and create application files
            progress.report({ message: 'Creating application files...' });
            const createdFiles = await createApplicationFiles(workspaceRoot, response.response, appName);

            progress.report({ message: 'Application created successfully!' });

            // Show success message with file list
            const fileList = createdFiles.map(f => path.relative(workspaceRoot, f)).join('\n- ');
            const openFirst = await vscode.window.showInformationMessage(
                `Application "${appName}" created successfully!\n\nCreated files:\n- ${fileList}`,
                'Open First File', 'OK'
            );

            if (openFirst === 'Open First File' && createdFiles.length > 0) {
                const doc = await vscode.workspace.openTextDocument(createdFiles[0]);
                await vscode.window.showTextDocument(doc);
            }
        });

    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create application: ${error.message}`);
        console.error('Application creation error:', error);
    }
}

async function gatherProjectContext(workspaceRoot: string): Promise<string> {
    let context = 'Project Structure:\n';

    try {
        // Read package.json or requirements.txt or CMakeLists.txt
        const configFiles = ['package.json', 'requirements.txt', 'CMakeLists.txt', 'Cargo.toml', 'go.mod', 'pom.xml'];
        
        for (const configFile of configFiles) {
            const configPath = path.join(workspaceRoot, configFile);
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf8');
                context += `\n${configFile}:\n${content.substring(0, 1000)}\n`;
            }
        }

        // List directory structure (top level and common folders)
        const topLevelFiles = fs.readdirSync(workspaceRoot);
        context += '\nTop-level directories and files:\n';
        context += topLevelFiles.map(f => '- ' + f).join('\n');

        // Check for common framework patterns
        const commonDirs = ['src', 'lib', 'app', 'controllers', 'models', 'services', 'components', 'views'];
        for (const dir of commonDirs) {
            const dirPath = path.join(workspaceRoot, dir);
            if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
                const files = fs.readdirSync(dirPath);
                context += `\n${dir}/ contents:\n`;
                context += files.map(f => '  - ' + f).join('\n');
            }
        }

    } catch (error) {
        console.error('Error gathering project context:', error);
        context += '\n(Unable to fully analyze project structure)';
    }

    return context;
}

function buildApplicationPrompt(
    type: ApplicationType,
    appName: string,
    requirements: string,
    projectContext: string
): string {
    const prompt = `Create a ${type.name} named "${appName}" for an existing project.

Requirements:
${requirements}

${projectContext}

Generate all necessary files for this ${type.name} including:
1. Main implementation file(s)
2. Associated test files
3. Any configuration or setup files needed
4. Integration points with the existing project
5. Documentation/comments explaining the code

Follow the project's existing structure and conventions. Make sure the code:
- Is production-ready and follows best practices
- Includes error handling
- Has appropriate logging
- Is well-documented
- Integrates seamlessly with the existing codebase

Format your response as a structured list where each file is clearly indicated with its path and content.
Use this format:

FILE: path/to/file.ext
\`\`\`language
file content here
\`\`\`

FILE: another/file.ext
\`\`\`language
content here
\`\`\`

Make the code production-ready with proper error handling, validation, and documentation.`;

    return prompt;
}

async function createApplicationFiles(workspaceRoot: string, boudicaResponse: string, appName: string): Promise<string[]> {
    // Parse Boudica's response to extract files
    const filePattern = /FILE:\s*(.+?)\n```(\w+)?\n([\s\S]*?)```/g;
    const files: { path: string; content: string }[] = [];
    
    let match;
    while ((match = filePattern.exec(boudicaResponse)) !== null) {
        const filePath = match[1].trim();
        const content = match[3];
        files.push({ path: filePath, content });
    }

    // If no files found with strict format, try alternative parsing
    if (files.length === 0) {
        const altPattern = /(?:Create|File:|###)\s*`?([a-zA-Z0-9_\-./]+\.[a-z]+)`?[:\n]+(?:```[\w]*\n)?([\s\S]*?)(?:```|(?=\n(?:Create|File:|###)))/gi;
        while ((match = altPattern.exec(boudicaResponse)) !== null) {
            const filePath = match[1].trim();
            const content = match[2].trim();
            if (content.length > 0) {
                files.push({ path: filePath, content });
            }
        }
    }

    const createdFiles: string[] = [];

    // Create each file
    for (const file of files) {
        const fullPath = path.join(workspaceRoot, file.path);
        const dir = path.dirname(fullPath);
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Check if file already exists
        if (fs.existsSync(fullPath)) {
            const overwrite = await vscode.window.showWarningMessage(
                `File "${file.path}" already exists. Overwrite?`,
                'Yes', 'No', 'Skip'
            );
            if (overwrite === 'No') {
                throw new Error('Operation cancelled by user');
            }
            if (overwrite === 'Skip') {
                continue;
            }
        }
        
        // Write file
        fs.writeFileSync(fullPath, file.content, 'utf8');
        createdFiles.push(fullPath);
        console.log(`Created: ${file.path}`);
    }

    return createdFiles;
}
