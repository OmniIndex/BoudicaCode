/**
 * Project Creation Module
 * Handles creating new projects with Boudica AI assistance
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BoudicaClient } from './boudicaClient';

export interface ProjectTemplate {
    name: string;
    description: string;
    language: string;
    framework?: string;
}

const PROJECT_TEMPLATES: ProjectTemplate[] = [
    { name: 'Node.js Backend', description: 'Express.js REST API server', language: 'JavaScript', framework: 'Express' },
    { name: 'React Frontend', description: 'React with TypeScript', language: 'TypeScript', framework: 'React' },
    { name: 'Python Flask API', description: 'Flask REST API', language: 'Python', framework: 'Flask' },
    { name: 'Python Django', description: 'Django web application', language: 'Python', framework: 'Django' },
    { name: 'C++ Project', description: 'C++ with CMake', language: 'C++', framework: 'CMake' },
    { name: 'Rust CLI', description: 'Rust command-line application', language: 'Rust', framework: 'Cargo' },
    { name: 'Go Microservice', description: 'Go HTTP microservice', language: 'Go', framework: 'net/http' },
    { name: 'Custom Project', description: 'Describe your own project', language: 'Custom', framework: undefined }
];

export async function createProject(client: BoudicaClient): Promise<void> {
    try {
        // Step 1: Select project template
        const templateItems = PROJECT_TEMPLATES.map(t => ({
            label: t.name,
            description: t.description,
            detail: `${t.language}${t.framework ? ' - ' + t.framework : ''}`,
            template: t
        }));

        const selectedTemplate = await vscode.window.showQuickPick(templateItems, {
            placeHolder: 'Select a project template',
            title: 'BoudiCode: Create New Project'
        });

        if (!selectedTemplate) {
            return;
        }

        // Step 2: Get project name
        const projectName = await vscode.window.showInputBox({
            prompt: 'Enter project name',
            placeHolder: 'my-awesome-project',
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Project name cannot be empty';
                }
                if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
                    return 'Project name can only contain letters, numbers, hyphens, and underscores';
                }
                return null;
            }
        });

        if (!projectName) {
            return;
        }

        // Step 3: Get project description (for custom projects or additional context)
        let projectDescription = '';
        if (selectedTemplate.template.name === 'Custom Project') {
            const desc = await vscode.window.showInputBox({
                prompt: 'Describe your project in detail',
                placeHolder: 'A web application for managing tasks with user authentication...',
                validateInput: (value) => {
                    if (!value || value.trim().length < 10) {
                        return 'Please provide a detailed description (at least 10 characters)';
                    }
                    return null;
                }
            });
            if (!desc) {
                return;
            }
            projectDescription = desc;
        } else {
            const desc = await vscode.window.showInputBox({
                prompt: 'Additional project details (optional)',
                placeHolder: 'e.g., Include authentication, database integration, etc.'
            });
            projectDescription = desc || '';
        }

        // Step 4: Select target directory
        const folderUri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Project Location',
            title: 'Choose where to create the project'
        });

        if (!folderUri || folderUri.length === 0) {
            return;
        }

        const projectPath = path.join(folderUri[0].fsPath, projectName);

        // Check if directory already exists
        if (fs.existsSync(projectPath)) {
            const overwrite = await vscode.window.showWarningMessage(
                `Directory "${projectName}" already exists. Overwrite?`,
                'Yes', 'No'
            );
            if (overwrite !== 'Yes') {
                return;
            }
        }

        // Create project directory
        fs.mkdirSync(projectPath, { recursive: true });

        // Step 5: Generate project structure with Boudica
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Creating ${projectName} project...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Generating project structure...' });

            // Build prompt for Boudica
            const prompt = buildProjectPrompt(
                selectedTemplate.template,
                projectName,
                projectDescription
            );

            // Request project structure from Boudica
            const response = await client.chat({
                message: prompt,
                session_id: `project-creation-${Date.now()}`,
                max_tokens: 32000,
                temperature: 0.7,
                use_rag: true,
                forCodeGeneration: true
            });

            if (response.error) {
                throw new Error(response.error);
            }

            if (!response.response) {
                throw new Error('No response from Boudica');
            }

            // Parse and create project files
            progress.report({ message: 'Creating project files...' });
            await createProjectFiles(projectPath, response.response, selectedTemplate.template);

            // Initialize project with appropriate tools
            progress.report({ message: 'Initializing project structure...' });
            await initializeProject(projectPath, selectedTemplate.template);

            progress.report({ message: 'Project created successfully!' });
        });

        // Open the new project
        const openProject = await vscode.window.showInformationMessage(
            `Project "${projectName}" created successfully!`,
            'Open Project', 'Open in New Window'
        );

        if (openProject === 'Open Project') {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath), false);
        } else if (openProject === 'Open in New Window') {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath), true);
        }

    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create project: ${error.message}`);
        console.error('Project creation error:', error);
    }
}

function buildProjectPrompt(template: ProjectTemplate, projectName: string, description: string): string {
    let prompt = `Create a complete project structure for a ${template.name} project named "${projectName}".

Language: ${template.language}`;

    if (template.framework) {
        prompt += `\nFramework: ${template.framework}`;
    }

    if (description) {
        prompt += `\n\nProject Description:\n${description}`;
    }

    prompt += `\n\nGenerate a complete project structure including:
1. All necessary configuration files (package.json, requirements.txt, CMakeLists.txt, etc.)
2. Directory structure with appropriate folders
3. Main entry point file with basic implementation
4. README.md with setup instructions
5. .gitignore file appropriate for ${template.language}
6. Any other essential boilerplate files

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

**OUTPUT REQUIREMENT:**
- Generate executable source code only inside markdown code blocks
- Use proper ${template.language} syntax and idioms
- No documentation pages, tutorials, or feature overviews

Make sure the project follows best practices for ${template.language}${template.framework ? ' and ' + template.framework : ''}.`;

    return prompt;
}

async function createProjectFiles(projectPath: string, boudicaResponse: string, template: ProjectTemplate): Promise<void> {
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
        // Try to parse based on common patterns in AI responses
        const altPattern = /(?:Create|File:|###)\s*`?([a-zA-Z0-9_\-./]+\.[a-z]+)`?[:\n]+(?:```[\w]*\n)?([\s\S]*?)(?:```|(?=\n(?:Create|File:|###)))/gi;
        while ((match = altPattern.exec(boudicaResponse)) !== null) {
            const filePath = match[1].trim();
            const content = match[2].trim();
            if (content.length > 0) {
                files.push({ path: filePath, content });
            }
        }
    }

    // Create each file
    for (const file of files) {
        const fullPath = path.join(projectPath, file.path);
        const dir = path.dirname(fullPath);
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Write file
        fs.writeFileSync(fullPath, file.content, 'utf8');
        console.log(`Created: ${file.path}`);
    }

    // Create basic README if none was generated
    const readmePath = path.join(projectPath, 'README.md');
    if (!fs.existsSync(readmePath)) {
        const basicReadme = `# ${path.basename(projectPath)}

A ${template.name} project.

## Getting Started

This project was generated by BoudiCode AI Assistant.

### Prerequisites

- ${template.language} runtime/compiler

### Installation

\`\`\`bash
# Add installation instructions here
\`\`\`

### Usage

\`\`\`bash
# Add usage instructions here
\`\`\`

## License

MIT
`;
        fs.writeFileSync(readmePath, basicReadme, 'utf8');
    }

    console.log(`Project created with ${files.length} files`);
}

/**
 * Initialize project with language/framework-specific setup
 */
async function initializeProject(projectPath: string, template: ProjectTemplate): Promise<void> {
    const terminal = vscode.window.createTerminal({
        name: 'BoudiCode Setup',
        cwd: projectPath
    });

    terminal.show();

    switch (template.language.toLowerCase()) {
        case 'javascript':
        case 'typescript':
            // Node.js project initialization
            if (!fs.existsSync(path.join(projectPath, 'package.json'))) {
                // Create basic package.json
                const packageJson = {
                    name: path.basename(projectPath),
                    version: '1.0.0',
                    description: template.description,
                    main: 'index.js',
                    scripts: {
                        test: 'echo "Error: no test specified" && exit 1',
                        start: template.framework === 'Express' ? 'node server.js' : 'node index.js',
                        dev: template.framework === 'Express' ? 'nodemon server.js' : 'nodemon index.js'
                    },
                    keywords: [],
                    author: '',
                    license: 'MIT',
                    dependencies: template.framework === 'Express' ? { express: '^4.18.0' } : {},
                    devDependencies: template.language === 'TypeScript' ? {
                        typescript: '^5.0.0',
                        '@types/node': '^20.0.0',
                        'ts-node': '^10.0.0',
                        nodemon: '^3.0.0'
                    } : { nodemon: '^3.0.0' }
                };
                fs.writeFileSync(
                    path.join(projectPath, 'package.json'),
                    JSON.stringify(packageJson, null, 2),
                    'utf8'
                );
            }
            terminal.sendText('npm install');
            if (template.language === 'TypeScript' && !fs.existsSync(path.join(projectPath, 'tsconfig.json'))) {
                terminal.sendText('npx tsc --init');
            }
            break;

        case 'python':
            // Python project initialization
            if (!fs.existsSync(path.join(projectPath, 'requirements.txt'))) {
                let requirements = '';
                if (template.framework === 'Flask') {
                    requirements = 'Flask>=3.0.0\npython-dotenv>=1.0.0';
                } else if (template.framework === 'Django') {
                    requirements = 'Django>=4.2.0\ndjango-environ>=0.11.0';
                }
                fs.writeFileSync(path.join(projectPath, 'requirements.txt'), requirements, 'utf8');
            }
            terminal.sendText('python3 -m venv venv');
            terminal.sendText('source venv/bin/activate');
            terminal.sendText('pip install -r requirements.txt');
            break;

        case 'c++':
            // C++ project initialization
            if (!fs.existsSync(path.join(projectPath, 'CMakeLists.txt'))) {
                const cmakeContent = `cmake_minimum_required(VERSION 3.15)
project(${path.basename(projectPath)} VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Source files
set(SOURCES
    src/main.cpp
)

# Executable
add_executable(\${PROJECT_NAME} \${SOURCES})

# Include directories
target_include_directories(\${PROJECT_NAME} PRIVATE include)

# Compiler warnings
if(MSVC)
    target_compile_options(\${PROJECT_NAME} PRIVATE /W4)
else()
    target_compile_options(\${PROJECT_NAME} PRIVATE -Wall -Wextra -Wpedantic)
endif()
`;
                fs.writeFileSync(path.join(projectPath, 'CMakeLists.txt'), cmakeContent, 'utf8');
            }

            // Create basic main.cpp if it doesn't exist
            const srcDir = path.join(projectPath, 'src');
            if (!fs.existsSync(srcDir)) {
                fs.mkdirSync(srcDir, { recursive: true });
            }
            const mainCppPath = path.join(srcDir, 'main.cpp');
            if (!fs.existsSync(mainCppPath)) {
                const mainCppContent = `#include <iostream>

int main(int argc, char* argv[]) {
    std::cout << "Hello from ${path.basename(projectPath)}!" << std::endl;
    return 0;
}
`;
                fs.writeFileSync(mainCppPath, mainCppContent, 'utf8');
            }

            // Create include directory
            const includeDir = path.join(projectPath, 'include');
            if (!fs.existsSync(includeDir)) {
                fs.mkdirSync(includeDir, { recursive: true });
            }

            // Create build directory and run cmake
            const buildDir = path.join(projectPath, 'build');
            if (!fs.existsSync(buildDir)) {
                fs.mkdirSync(buildDir, { recursive: true });
            }
            terminal.sendText('cd build && cmake .. && make');
            break;

        case 'rust':
            // Rust project initialization
            terminal.sendText('cargo init --name ' + path.basename(projectPath));
            break;

        case 'go':
            // Go project initialization
            terminal.sendText('go mod init ' + path.basename(projectPath));
            break;

        default:
            // No specific initialization needed
            break;
    }

    vscode.window.showInformationMessage(`Project scaffolding complete! Check the terminal for setup progress.`);
}

