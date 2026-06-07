/**
 * Build Runner
 * Detects and executes build systems (CMake, Make, npm, cargo, go)
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getStatusBarManager } from './statusBarManager';

export enum BuildSystem {
    CMAKE = 'cmake',
    MAKE = 'make',
    NPM = 'npm',
    CARGO = 'cargo',
    GO = 'go',
    UNKNOWN = 'unknown'
}

export interface BuildResult {
    success: boolean;
    buildSystem: BuildSystem;
    output: string;
    errors: string[];
    exitCode?: number;
    duration: number;
}

export interface BuildConfig {
    system: BuildSystem;
    buildDir?: string;
    buildCommand: string;
    workingDirectory: string;
}

export interface RunConfig {
    executable: string;
    workingDirectory: string;
    args?: string[];
}

export class BuildRunner {
    private workspaceRoot: string;
    private terminal: vscode.Terminal | null = null;
    
    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    /**
     * Detect the build system used in the project
     */
    async detectBuildSystem(): Promise<BuildConfig | undefined> {
        console.log('[BuildRunner] Detecting build system...');
        
        // Check for CMakeLists.txt (CMake)
        const cmakeFile = path.join(this.workspaceRoot, 'CMakeLists.txt');
        if (fs.existsSync(cmakeFile)) {
            console.log('[BuildRunner] Detected CMake project');
            
            // Check if build directory exists
            const buildDir = path.join(this.workspaceRoot, 'build');
            const hasBuildDir = fs.existsSync(buildDir);
            
            return {
                system: BuildSystem.CMAKE,
                buildDir: hasBuildDir ? buildDir : undefined,
                buildCommand: hasBuildDir 
                    ? `cd build && cmake .. && make -j$(nproc)`
                    : `mkdir -p build && cd build && cmake .. && make -j$(nproc)`,
                workingDirectory: this.workspaceRoot
            };
        }
        
        // Check for Makefile (Make)
        const makeFile = path.join(this.workspaceRoot, 'Makefile');
        if (fs.existsSync(makeFile)) {
            console.log('[BuildRunner] Detected Make project');
            return {
                system: BuildSystem.MAKE,
                buildCommand: `make -j$(nproc)`,
                workingDirectory: this.workspaceRoot
            };
        }
        
        // Check for package.json (npm)
        const packageJson = path.join(this.workspaceRoot, 'package.json');
        if (fs.existsSync(packageJson)) {
            console.log('[BuildRunner] Detected npm project');
            
            // Read package.json to find build script
            try {
                const packageData = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
                const hasBuildScript = packageData.scripts && packageData.scripts.build;
                
                return {
                    system: BuildSystem.NPM,
                    buildCommand: hasBuildScript ? `npm run build` : `npm install`,
                    workingDirectory: this.workspaceRoot
                };
            } catch (error) {
                console.error('[BuildRunner] Error reading package.json:', error);
            }
        }
        
        // Check for Cargo.toml (Rust)
        const cargoFile = path.join(this.workspaceRoot, 'Cargo.toml');
        if (fs.existsSync(cargoFile)) {
            console.log('[BuildRunner] Detected Cargo project');
            return {
                system: BuildSystem.CARGO,
                buildCommand: `cargo build`,
                workingDirectory: this.workspaceRoot
            };
        }
        
        // Check for go.mod (Go)
        const goMod = path.join(this.workspaceRoot, 'go.mod');
        if (fs.existsSync(goMod)) {
            console.log('[BuildRunner] Detected Go project');
            return {
                system: BuildSystem.GO,
                buildCommand: `go build`,
                workingDirectory: this.workspaceRoot
            };
        }
        
        console.log('[BuildRunner] No build system detected');
        return undefined;
    }

    /**
     * Run the build and capture output
     */
    async runBuild(config?: BuildConfig): Promise<BuildResult> {
        const statusBarManager = getStatusBarManager();
        const startTime = Date.now();
        
        try {
            // Detect build system if not provided
            if (!config) {
                config = await this.detectBuildSystem();
                if (!config) {
                    return {
                        success: false,
                        buildSystem: BuildSystem.UNKNOWN,
                        output: '',
                        errors: ['No build system detected. Please add CMakeLists.txt, Makefile, package.json, Cargo.toml, or go.mod.'],
                        duration: 0
                    };
                }
            }
            
            statusBarManager.showOperation('Building', `${config.system} project...`);
            console.log(`[BuildRunner] Running: ${config.buildCommand}`);
            
            // Execute build command
            const result = await this.executeBuildCommand(config);
            
            const duration = Date.now() - startTime;
            statusBarManager.clearOperation();
            
            if (result.success) {
                statusBarManager.showSuccess(`Build successful (${duration}ms)`, 3000);
            } else {
                statusBarManager.showError('Build failed');
            }
            
            return {
                ...result,
                buildSystem: config.system,
                duration
            };
            
        } catch (error: any) {
            const duration = Date.now() - startTime;
            statusBarManager.showError('Build failed');
            
            return {
                success: false,
                buildSystem: config?.system || BuildSystem.UNKNOWN,
                output: '',
                errors: [error.message || 'Unknown build error'],
                duration
            };
        }
    }

    /**
     * Execute build command and capture output
     */
    private async executeBuildCommand(config: BuildConfig): Promise<{ success: boolean; output: string; errors: string[]; exitCode?: number }> {
        return new Promise((resolve) => {
            const { exec } = require('child_process');
            
            console.log(`[BuildRunner] Executing in ${config.workingDirectory}: ${config.buildCommand}`);
            
            const process = exec(
                config.buildCommand,
                {
                    cwd: config.workingDirectory,
                    maxBuffer: 10 * 1024 * 1024, // 10MB buffer
                    shell: '/bin/bash'
                },
                (error: any, stdout: string, stderr: string) => {
                    const output = stdout + '\n' + stderr;
                    const success = !error || error.code === 0;
                    
                    console.log(`[BuildRunner] Build ${success ? 'succeeded' : 'failed'}`);
                    console.log(`[BuildRunner] Output length: ${output.length} chars`);
                    
                    if (!success) {
                        console.log('[BuildRunner] First 500 chars of error output:', output.substring(0, 500));
                    }
                    
                    resolve({
                        success,
                        output,
                        errors: success ? [] : [output],
                        exitCode: error?.code
                    });
                }
            );
        });
    }

    /**
     * Run build in integrated terminal (visible to user)
     */
    async runBuildInTerminal(config?: BuildConfig): Promise<void> {
        if (!config) {
            config = await this.detectBuildSystem();
            if (!config) {
                vscode.window.showErrorMessage('No build system detected');
                return;
            }
        }
        
        // Create or reuse terminal
        if (!this.terminal || this.terminal.exitStatus !== undefined) {
            this.terminal = vscode.window.createTerminal('BoudiCode Build');
        }
        
        this.terminal.show();
        this.terminal.sendText(`cd "${config.workingDirectory}"`);
        this.terminal.sendText(config.buildCommand);
    }

    /**
     * Clean build artifacts
     */
    async cleanBuild(config?: BuildConfig): Promise<void> {
        if (!config) {
            config = await this.detectBuildSystem();
            if (!config) {
                return;
            }
        }
        
        let cleanCommand: string;
        
        switch (config.system) {
            case BuildSystem.CMAKE:
                cleanCommand = config.buildDir 
                    ? `rm -rf ${config.buildDir}/*`
                    : `rm -rf build/*`;
                break;
            case BuildSystem.MAKE:
                cleanCommand = `make clean`;
                break;
            case BuildSystem.NPM:
                cleanCommand = `rm -rf node_modules dist build out`;
                break;
            case BuildSystem.CARGO:
                cleanCommand = `cargo clean`;
                break;
            case BuildSystem.GO:
                cleanCommand = `go clean`;
                break;
            default:
                return;
        }
        
        const { exec } = require('child_process');
        exec(cleanCommand, { cwd: config.workingDirectory });
        
        vscode.window.showInformationMessage(`Cleaned ${config.system} build artifacts`);
    }

    /**
     * Get build status (check if project has been built)
     */
    async getBuildStatus(config?: BuildConfig): Promise<{ built: boolean; buildDir?: string }> {
        if (!config) {
            config = await this.detectBuildSystem();
            if (!config) {
                return { built: false };
            }
        }
        
        let checkPath: string;
        
        switch (config.system) {
            case BuildSystem.CMAKE:
                checkPath = config.buildDir || path.join(this.workspaceRoot, 'build');
                const cmakeCache = path.join(checkPath, 'CMakeCache.txt');
                return {
                    built: fs.existsSync(cmakeCache),
                    buildDir: checkPath
                };
                
            case BuildSystem.MAKE:
                // Check for any .o files
                const hasObjectFiles = fs.readdirSync(this.workspaceRoot)
                    .some(file => file.endsWith('.o'));
                return { built: hasObjectFiles };
                
            case BuildSystem.NPM:
                const nodeModules = path.join(this.workspaceRoot, 'node_modules');
                return { built: fs.existsSync(nodeModules) };
                
            case BuildSystem.CARGO:
                const cargoTarget = path.join(this.workspaceRoot, 'target');
                return { built: fs.existsSync(cargoTarget) };
                
            case BuildSystem.GO:
                // Go builds don't leave artifacts by default
                return { built: false };
                
            default:
                return { built: false };
        }
    }

    /**
     * Detect the executable to run after build
     */
    async detectExecutable(config?: BuildConfig): Promise<RunConfig | undefined> {
        if (!config) {
            config = await this.detectBuildSystem();
            if (!config) {
                return undefined;
            }
        }
        
        console.log('[BuildRunner] Detecting executable for ' + config.system);
        
        switch (config.system) {
            case BuildSystem.CMAKE: {
                // Look for executables in build directory
                const buildDir = config.buildDir || path.join(this.workspaceRoot, 'build');
                
                if (!fs.existsSync(buildDir)) {
                    console.log('[BuildRunner] Build directory does not exist');
                    return undefined;
                }
                
                // Find executable files (no extension, executable bit set)
                const files = fs.readdirSync(buildDir);
                const executables = files.filter(file => {
                    const filePath = path.join(buildDir, file);
                    try {
                        const stats = fs.statSync(filePath);
                        return stats.isFile() && !file.includes('.') && (stats.mode & 0o111) !== 0;
                    } catch {
                        return false;
                    }
                });
                
                if (executables.length === 0) {
                    console.log('[BuildRunner] No executables found in build directory');
                    return undefined;
                }
                
                // Use first executable found
                const executable = executables[0];
                console.log('[BuildRunner] Found executable: ' + executable);
                
                return {
                    executable: './' + executable,
                    workingDirectory: buildDir
                };
            }
            
            case BuildSystem.MAKE: {
                // Try to find Makefile target or executable in current directory
                const files = fs.readdirSync(this.workspaceRoot);
                const executables = files.filter(file => {
                    const filePath = path.join(this.workspaceRoot, file);
                    try {
                        const stats = fs.statSync(filePath);
                        return stats.isFile() && !file.includes('.') && (stats.mode & 0o111) !== 0;
                    } catch {
                        return false;
                    }
                });
                
                if (executables.length > 0) {
                    return {
                        executable: './' + executables[0],
                        workingDirectory: this.workspaceRoot
                    };
                }
                
                // Check for common executable names
                const commonNames = ['a.out', 'main', 'app', path.basename(this.workspaceRoot)];
                for (const name of commonNames) {
                    const exePath = path.join(this.workspaceRoot, name);
                    if (fs.existsSync(exePath)) {
                        return {
                            executable: './' + name,
                            workingDirectory: this.workspaceRoot
                        };
                    }
                }
                
                return undefined;
            }
            
            case BuildSystem.NPM: {
                // Check for start script in package.json
                try {
                    const packageJson = path.join(this.workspaceRoot, 'package.json');
                    const packageData = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
                    
                    if (packageData.scripts && packageData.scripts.start) {
                        return {
                            executable: 'npm',
                            workingDirectory: this.workspaceRoot,
                            args: ['start']
                        };
                    }
                    
                    // Check for main entry point
                    if (packageData.main) {
                        return {
                            executable: 'node',
                            workingDirectory: this.workspaceRoot,
                            args: [packageData.main]
                        };
                    }
                } catch (error) {
                    console.error('[BuildRunner] Error reading package.json:', error);
                }
                
                return undefined;
            }
            
            case BuildSystem.CARGO: {
                // Cargo run handles execution
                return {
                    executable: 'cargo',
                    workingDirectory: this.workspaceRoot,
                    args: ['run']
                };
            }
            
            case BuildSystem.GO: {
                // Look for built binary (same name as directory)
                const binaryName = path.basename(this.workspaceRoot);
                const binaryPath = path.join(this.workspaceRoot, binaryName);
                
                if (fs.existsSync(binaryPath)) {
                    return {
                        executable: './' + binaryName,
                        workingDirectory: this.workspaceRoot
                    };
                }
                
                // Or use 'go run .'
                return {
                    executable: 'go',
                    workingDirectory: this.workspaceRoot,
                    args: ['run', '.']
                };
            }
            
            default:
                return undefined;
        }
    }

    /**
     * Run the built executable in terminal
     */
    async runExecutable(runConfig?: RunConfig): Promise<void> {
        if (!runConfig) {
            runConfig = await this.detectExecutable();
            if (!runConfig) {
                vscode.window.showErrorMessage('No executable found. Build the project first.');
                return;
            }
        }
        
        // Create or reuse terminal
        if (!this.terminal || this.terminal.exitStatus !== undefined) {
            this.terminal = vscode.window.createTerminal('BoudiCode Run');
        }
        
        this.terminal.show();
        this.terminal.sendText('cd "' + runConfig.workingDirectory + '"');
        
        // Build command with arguments
        let command = runConfig.executable;
        if (runConfig.args && runConfig.args.length > 0) {
            command += ' ' + runConfig.args.join(' ');
        }
        
        console.log('[BuildRunner] Running: ' + command);
        this.terminal.sendText(command);
    }

    /**
     * Build and run in one step
     */
    async buildAndRun(): Promise<void> {
        const statusBarManager = getStatusBarManager();
        
        try {
            // Detect build system
            const config = await this.detectBuildSystem();
            if (!config) {
                vscode.window.showErrorMessage('No build system detected');
                return;
            }
            
            statusBarManager.showOperation('Building', config.system + ' project...');
            
            // Run build
            const buildResult = await this.runBuild(config);
            
            if (!buildResult.success) {
                vscode.window.showErrorMessage('Build failed. Check terminal output.');
                statusBarManager.showError('Build failed');
                
                // Show terminal with error output
                const terminal = vscode.window.createTerminal('Build Output');
                terminal.show();
                terminal.sendText('echo "Build failed:"');
                terminal.sendText('echo "' + buildResult.errors[0]?.substring(0, 500).replace(/"/g, '\\"') + '"');
                
                return;
            }
            
            statusBarManager.showSuccess('Build successful');
            
            // Detect executable
            const runConfig = await this.detectExecutable(config);
            if (!runConfig) {
                vscode.window.showWarningMessage('Build succeeded but no executable found to run');
                statusBarManager.clearOperation();
                return;
            }
            
            // Show success and run
            vscode.window.showInformationMessage('Build successful. Running executable...');
            statusBarManager.showOperation('Running', runConfig.executable);
            
            // Run executable
            await this.runExecutable(runConfig);
            
            statusBarManager.clearOperation();
            
        } catch (error: any) {
            console.error('[BuildRunner] Build and run error:', error);
            vscode.window.showErrorMessage('Build and run failed: ' + error.message);
            statusBarManager.showError('Build and run failed');
        }
    }

    /**
     * Dispose terminal if created
     */
    dispose(): void {
        if (this.terminal) {
            this.terminal.dispose();
            this.terminal = null;
        }
    }
}
