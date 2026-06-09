import * as vscode from 'vscode';
import * as path from 'path';
import { reportStatus } from './statusReporter';

export interface FileInfo {
    path: string;
    relativePath: string;
    language: string;
    extension: string;
    content: string;
    size: number;
    includes: string[];  // Header files this file includes
    functions: string[];  // Function/method names defined
    classes: string[];    // Class names defined
}

export interface ProjectStructure {
    sourceFiles: FileInfo[];
    headerFiles: FileInfo[];
    configFiles: FileInfo[];
    buildFiles: FileInfo[];
    totalFiles: number;
    lastScanTime: number;
}

export class ProjectScanner implements vscode.Disposable {
    private cache: ProjectStructure | null = null;
    private cacheTimeout = 30000; // 30 seconds
    private workspaceRoot: string | undefined;
    private watcher: vscode.FileSystemWatcher;

    constructor() {
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        // Watch for file changes to invalidate cache
        this.watcher = vscode.workspace.createFileSystemWatcher('**/*.{cpp,hpp,h,c,ts,js,py,rs,go,java,cs,json,cmake,txt}');
        this.watcher.onDidChange(() => this.invalidateCache());
        this.watcher.onDidCreate(() => this.invalidateCache());
        this.watcher.onDidDelete(() => this.invalidateCache());
    }

    dispose(): void {
        this.watcher.dispose();
    }

    private invalidateCache(): void {
        console.log('[ProjectScanner] Cache invalidated due to file change');
        this.cache = null;
    }

    /**
     * Scan the workspace and build a complete project structure
     */
    async scanProject(): Promise<ProjectStructure> {
        // Return cached result if still valid
        if (this.cache && (Date.now() - this.cache.lastScanTime) < this.cacheTimeout) {
            console.log('[ProjectScanner] Returning cached project structure');
            return this.cache;
        }

        console.log('[ProjectScanner] Scanning workspace...');
        reportStatus('Scanning workspace...');
        
        if (!this.workspaceRoot) {
            console.log('[ProjectScanner] No workspace root found');
            return this.createEmptyStructure();
        }

        const structure: ProjectStructure = {
            sourceFiles: [],
            headerFiles: [],
            configFiles: [],
            buildFiles: [],
            totalFiles: 0,
            lastScanTime: Date.now()
        };

        try {
            // Find all relevant files
            const patterns = {
                source: '**/*.{cpp,c,cc,cxx,ts,js,py,rs,java,cs,go,rb,swift,kt}',
                header: '**/*.{hpp,h,hxx}',
                config: '**/*.{json,conf,yaml,yml}',
                build: '**/CMakeLists.txt'
            };

            // Quick file count check to avoid scanning massive projects
            console.log('[ProjectScanner] Counting files...');
            reportStatus('Counting files...');
            const allSourceFiles = await vscode.workspace.findFiles(
                patterns.source,
                '**/node_modules/**'
            );
            const allHeaderFiles = await vscode.workspace.findFiles(
                patterns.header,
                '**/node_modules/**'
            );
            const totalFileCount = allSourceFiles.length + allHeaderFiles.length;
            
            console.log(`[ProjectScanner] Found ${totalFileCount} source/header files`);
            reportStatus(`Found ${totalFileCount} source/header files`);
            
            // If project has more than 100 files, skip detailed scanning
            const MAX_FILES_FOR_SCANNING = 100;
            if (totalFileCount > MAX_FILES_FOR_SCANNING) {
                console.log(`[ProjectScanner] Project too large (${totalFileCount} files > ${MAX_FILES_FOR_SCANNING}), skipping detailed scan`);
                vscode.window.showWarningMessage(
                    `BoudiCode: Project has ${totalFileCount} files. Project-wide scanning is only available for projects with ${MAX_FILES_FOR_SCANNING} or fewer files. Multi-file operations will use explicit file selection instead.`,
                    'OK'
                );
                // Return minimal structure with just file count
                return {
                    sourceFiles: [],
                    headerFiles: [],
                    configFiles: [],
                    buildFiles: [],
                    totalFiles: totalFileCount,
                    lastScanTime: Date.now()
                };
            }

            // Scan source files (only if under threshold)
            for (const fileUri of allSourceFiles) {
                const info = await this.analyzeFile(fileUri);
                if (info) {
                    structure.sourceFiles.push(info);
                }
            }

            // Scan header files
            for (const fileUri of allHeaderFiles) {
                const info = await this.analyzeFile(fileUri);
                if (info) {
                    structure.headerFiles.push(info);
                }
            }

            // Scan config files
            const configFiles = await vscode.workspace.findFiles(
                patterns.config,
                '**/node_modules/**'
            );
            for (const fileUri of configFiles) {
                const info = await this.analyzeFile(fileUri);
                if (info && info.size < 100000) { // Skip large config files
                    structure.configFiles.push(info);
                }
            }

            // Scan build files
            const buildFiles = await vscode.workspace.findFiles(patterns.build);
            for (const fileUri of buildFiles) {
                const info = await this.analyzeFile(fileUri);
                if (info) {
                    structure.buildFiles.push(info);
                }
            }

            structure.totalFiles = structure.sourceFiles.length + 
                                   structure.headerFiles.length + 
                                   structure.configFiles.length + 
                                   structure.buildFiles.length;

            console.log(`[ProjectScanner] Scan complete: ${structure.totalFiles} files found`);
            console.log(`  Source: ${structure.sourceFiles.length}, Headers: ${structure.headerFiles.length}`);
            console.log(`  Config: ${structure.configFiles.length}, Build: ${structure.buildFiles.length}`);
            reportStatus(`Scan complete: ${structure.totalFiles} files found`);
            reportStatus(`  Source: ${structure.sourceFiles.length}, Headers: ${structure.headerFiles.length}`);
            reportStatus(`  Config: ${structure.configFiles.length}, Build: ${structure.buildFiles.length}`);

            this.cache = structure;
            return structure;

        } catch (error) {
            console.error('[ProjectScanner] Error scanning project:', error);
            return this.createEmptyStructure();
        }
    }

    /**
     * Analyze a single file and extract metadata
     */
    private async analyzeFile(fileUri: vscode.Uri): Promise<FileInfo | null> {
        try {
            // Use workspace.fs.readFile instead of openTextDocument to avoid polluting the document cache
            const rawBytes = await vscode.workspace.fs.readFile(fileUri);
            const content = Buffer.from(rawBytes).toString('utf8');
            const fileName = path.basename(fileUri.fsPath);
            const ext = path.extname(fileUri.fsPath);
            const relativePath = this.workspaceRoot 
                ? path.relative(this.workspaceRoot, fileUri.fsPath)
                : fileUri.fsPath;

            // Derive language from extension
            const extToLang: Record<string, string> = {
                '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
                '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.cs': 'csharp',
                '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c': 'c', '.h': 'c', '.hpp': 'cpp',
                '.kt': 'kotlin', '.rb': 'ruby', '.swift': 'swift', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml'
            };
            const language = extToLang[ext.toLowerCase()] || ext.replace('.', '') || 'plaintext';

            const info: FileInfo = {
                path: fileUri.fsPath,
                relativePath,
                language,
                extension: ext,
                content,
                size: content.length,
                includes: this.extractIncludes(content),
                functions: this.extractFunctions(content, language),
                classes: this.extractClasses(content, language)
            };

            return info;
        } catch (error) {
            console.error(`[ProjectScanner] Error analyzing file ${fileUri.fsPath}:`, error);
            return null;
        }
    }

    /**
     * Extract #include directives from C/C++ files
     */
    private extractIncludes(content: string): string[] {
        const includes: string[] = [];
        const includeRegex = /#include\s+[<"]([^>"]+)[>"]/g;
        let match;
        while ((match = includeRegex.exec(content)) !== null) {
            includes.push(match[1]);
        }
        return includes;
    }

    /**
     * Extract function names from content
     */
    private extractFunctions(content: string, language: string): string[] {
        const functions: string[] = [];
        
        if (language === 'cpp' || language === 'c') {
            // Match C/C++ function definitions (simplified)
            const funcRegex = /(?:^|\n)\s*(?:[\w:<>*&\s]+)\s+(\w+)\s*\([^)]*\)\s*(?:{|;)/g;
            let match;
            while ((match = funcRegex.exec(content)) !== null) {
                const funcName = match[1];
                // Filter out common keywords
                if (!['if', 'while', 'for', 'switch', 'catch'].includes(funcName)) {
                    functions.push(funcName);
                }
            }
        } else if (language === 'typescript' || language === 'javascript') {
            // Match TS/JS function definitions
            const funcRegex = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|(\w+)\s*\([^)]*\)\s*{)/g;
            let match;
            while ((match = funcRegex.exec(content)) !== null) {
                const funcName = match[1] || match[2] || match[3];
                if (funcName) {
                    functions.push(funcName);
                }
            }
        }
        
        return [...new Set(functions)]; // Remove duplicates
    }

    /**
     * Extract class names from content
     */
    private extractClasses(content: string, language: string): string[] {
        const classes: string[] = [];
        
        if (language === 'cpp' || language === 'c') {
            const classRegex = /(?:class|struct)\s+(\w+)/g;
            let match;
            while ((match = classRegex.exec(content)) !== null) {
                classes.push(match[1]);
            }
        } else if (language === 'typescript' || language === 'javascript') {
            const classRegex = /class\s+(\w+)/g;
            let match;
            while ((match = classRegex.exec(content)) !== null) {
                classes.push(match[1]);
            }
        }
        
        return [...new Set(classes)];
    }

    /**
     * Find files related to a given file (e.g., corresponding header for a .cpp file)
     */
    async findRelatedFiles(filePath: string): Promise<FileInfo[]> {
        const structure = await this.scanProject();
        const related: FileInfo[] = [];
        const baseName = path.basename(filePath, path.extname(filePath));
        
        // For a .cpp file, find its .hpp/.h
        if (filePath.endsWith('.cpp') || filePath.endsWith('.c')) {
            const header = structure.headerFiles.find(f => 
                path.basename(f.path, path.extname(f.path)) === baseName
            );
            if (header) {
                related.push(header);
            }
        }
        
        // For a .hpp file, find its .cpp
        if (filePath.endsWith('.hpp') || filePath.endsWith('.h')) {
            const source = structure.sourceFiles.find(f => 
                path.basename(f.path, path.extname(f.path)) === baseName
            );
            if (source) {
                related.push(source);
            }
        }
        
        return related;
    }

    /**
     * Find files that include a given header
     */
    async findFilesThatInclude(headerName: string): Promise<FileInfo[]> {
        const structure = await this.scanProject();
        const dependents: FileInfo[] = [];
        
        const allFiles = [
            ...structure.sourceFiles,
            ...structure.headerFiles
        ];
        
        for (const file of allFiles) {
            if (file.includes.some(inc => inc.includes(headerName))) {
                dependents.push(file);
            }
        }
        
        return dependents;
    }

    /**
     * Build a context string with relevant project files
     */
    async buildProjectContext(maxFiles: number = 10, maxSizePerFile: number = 5000): Promise<string> {
        const structure = await this.scanProject();
        let context = '=== PROJECT STRUCTURE ===\n\n';
        
        // Add project overview
        context += `Total Files: ${structure.totalFiles}\n`;
        context += `Source Files (${structure.sourceFiles.length}):\n`;
        structure.sourceFiles.forEach(f => {
            context += `  - ${f.relativePath} (${f.functions.length} functions, ${f.classes.length} classes)\n`;
        });
        
        context += `\nHeader Files (${structure.headerFiles.length}):\n`;
        structure.headerFiles.forEach(f => {
            context += `  - ${f.relativePath} (${f.functions.length} functions, ${f.classes.length} classes)\n`;
        });
        
        // Add key file contents (headers first, then important source files)
        context += '\n=== KEY FILE CONTENTS ===\n\n';
        
        const filesToInclude = [
            ...structure.headerFiles.slice(0, Math.floor(maxFiles / 2)),
            ...structure.sourceFiles.slice(0, Math.ceil(maxFiles / 2))
        ];
        
        for (const file of filesToInclude) {
            context += `--- ${file.relativePath} ---\n`;
            const content = file.size > maxSizePerFile 
                ? file.content.substring(0, maxSizePerFile) + '\n... (truncated)'
                : file.content;
            context += `\`\`\`${file.language}\n${content}\n\`\`\`\n\n`;
        }
        
        return context;
    }

    private createEmptyStructure(): ProjectStructure {
        return {
            sourceFiles: [],
            headerFiles: [],
            configFiles: [],
            buildFiles: [],
            totalFiles: 0,
            lastScanTime: Date.now()
        };
    }
}
