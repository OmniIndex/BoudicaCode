/**
 * Plan Executor
 * Handles multi-step project creation with planning phase
 * and modification of existing projects
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BoudicaClient, ChatRequest } from './boudicaClient';
import { getStatusBarManager } from './statusBarManager';
import { ProjectScanner, FileInfo } from './projectScanner';
import { CodeInserter, InsertionMode, InsertionTarget } from './codeInsertion';

export interface PlanStep {
    stepNumber: number;
    fileName: string;
    description: string;
    fileType: 'header' | 'source' | 'config' | 'other';
}

export interface ExecutionPlan {
    steps: PlanStep[];
    projectType: string;
    buildSystem?: 'cmake' | 'makefile' | 'npm' | 'cargo' | 'go';
}

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

/**
 * Detect if a prompt is requesting project creation
 */
export function isPlanningRequest(prompt: string): boolean {
    const lowerPrompt = prompt.toLowerCase();
    
    // Keywords that indicate planning mode
    const planKeywords = [
        'create a', 'create an',
        'i want to create',
        'i need to create',
        'build a', 'build an',
        'make a', 'make an',
        'develop a', 'develop an',
        'i want an application',
        'i need an application'
    ];
    
    // Must be long enough to be a real request
    if (prompt.length < 30) {
        return false;
    }
    
    // Check for planning keywords
    return planKeywords.some(keyword => lowerPrompt.includes(keyword));
}

/**
 * Detect if a prompt is requesting modification to existing project
 */
export function isModificationRequest(prompt: string): boolean {
    const lowerPrompt = prompt.toLowerCase();
    
    // Keywords that indicate modification mode
    const modKeywords = [
        'add ', 'modify ', 'update ', 'change ',
        'enhance ', 'improve ', 'extend ',
        'integrate ', 'refactor ', 'fix ',
        'implement ', 'insert ', 'include '
    ];
    
    // Require minimum length
    if (prompt.length < 20) {
        return false;
    }
    
    // Check for modification keywords
    return modKeywords.some(keyword => lowerPrompt.includes(keyword));
}

/**
 * Generate a plan by asking Boudica for steps only
 */
export async function generatePlan(
    client: BoudicaClient,
    userPrompt: string,
    workspaceRoot: string
): Promise<ExecutionPlan | null> {
    const statusBarManager = getStatusBarManager();
    
    try {
        statusBarManager.showOperation('Planning', 'Generating project plan...');
        
        // Create planning prompt
        const planningPrompt = `${userPrompt}

DO NOT write any code. Output ONLY the numbered steps required to build this project.

CRITICAL DESIGN PRINCIPLES:
- Keep architecture MINIMAL - avoid creating separate modules for every feature
- Follow patterns from any referenced source code closely
- Use simple, direct implementations rather than over-engineered class hierarchies
- Group related functionality into single modules rather than splitting into many pieces
- Numbered lists in the user prompt describe FEATURES/ACTIONS, not separate modules

For each step, output:
- Step number
- Target filename with extension in backticks
- Brief description of what it does

Example format:
1. Create \`main.cpp\` – Entry point with CLI parsing and main logic
2. Create \`http_client.hpp\` and \`http_client.cpp\` – HTTP communication (only if needed)
3. Create \`CMakeLists.txt\` – Build configuration

Output complete numbered list of source code to generate.`;

        const response = await client.chat({
            message: planningPrompt,
            session_id: 'plan-' + Date.now(),
            temperature: 0.7,
            max_tokens: 1500
        });

        statusBarManager.clearOperation();

        if (response.error || !response.response) {
            return null;
        }

        // Parse the plan
        const plan = parsePlan(response.response);
        
        return plan;
    } catch (error: any) {
        statusBarManager.showError('Planning failed');
        console.error('Plan generation error:', error);
        return null;
    }
}

/**
 * Parse Boudica's response into an execution plan
 */
function parsePlan(planText: string): ExecutionPlan {
    const steps: PlanStep[] = [];
    const lines = planText.split('\n');
    
    let projectType = 'generic';
    let buildSystem: 'cmake' | 'makefile' | 'npm' | 'cargo' | 'go' | undefined;
    
    for (const line of lines) {
        // Match patterns like:
        // 1. Create `main.cpp` – Description
        // 2. Create `file.hpp` and `file.cpp` – Description
        const stepMatch = line.match(/^(\d+)\.\s*Create\s+`([^`]+)`(?:\s+and\s+`([^`]+)`)?\s*[–—-]\s*(.+)$/i);
        
        if (stepMatch) {
            const stepNumber = parseInt(stepMatch[1]);
            const fileName1 = stepMatch[2].trim();
            const fileName2 = stepMatch[3]?.trim();
            const description = stepMatch[4].trim();
            
            // Add first file
            steps.push({
                stepNumber,
                fileName: fileName1,
                description,
                fileType: getFileType(fileName1)
            });
            
            // Add second file if exists
            if (fileName2) {
                steps.push({
                    stepNumber,
                    fileName: fileName2,
                    description,
                    fileType: getFileType(fileName2)
                });
            }
            
            // Detect build system
            if (fileName1.toLowerCase().includes('cmake')) {
                buildSystem = 'cmake';
                projectType = 'cpp';
            } else if (fileName1.toLowerCase().includes('makefile')) {
                buildSystem = 'makefile';
                projectType = 'cpp';
            } else if (fileName1.toLowerCase().includes('package.json')) {
                buildSystem = 'npm';
                projectType = 'nodejs';
            } else if (fileName1.toLowerCase().includes('cargo.toml')) {
                buildSystem = 'cargo';
                projectType = 'rust';
            } else if (fileName1.toLowerCase().includes('go.mod')) {
                buildSystem = 'go';
                projectType = 'go';
            }
        }
    }
    
    // Detect project type from file extensions if not detected
    if (projectType === 'generic' && steps.length > 0) {
        const firstFile = steps[0].fileName.toLowerCase();
        if (firstFile.endsWith('.cpp') || firstFile.endsWith('.hpp') || firstFile.endsWith('.c') || firstFile.endsWith('.h')) {
            projectType = 'cpp';
        } else if (firstFile.endsWith('.ts') || firstFile.endsWith('.js')) {
            projectType = 'nodejs';
        } else if (firstFile.endsWith('.py')) {
            projectType = 'python';
        } else if (firstFile.endsWith('.rs')) {
            projectType = 'rust';
        } else if (firstFile.endsWith('.go')) {
            projectType = 'go';
        }
    }
    
    return {
        steps,
        projectType,
        buildSystem
    };
}

/**
 * Determine file type from extension
 */
function getFileType(fileName: string): 'header' | 'source' | 'config' | 'other' {
    const ext = path.extname(fileName).toLowerCase();
    
    if (['.hpp', '.h', '.hxx'].includes(ext)) {
        return 'header';
    } else if (['.cpp', '.c', '.cc', '.cxx', '.py', '.js', '.ts', '.rs', '.go', '.java'].includes(ext)) {
        return 'source';
    } else if (['CMakeLists.txt', 'Makefile', 'package.json', 'Cargo.toml', 'go.mod', 'requirements.txt'].includes(fileName)) {
        return 'config';
    }
    
    return 'other';
}

/**
 * Execute the plan step by step with incremental context
 * Strategy: For each module, only send what's needed for THAT file
 */
export async function executePlan(
    client: BoudicaClient,
    plan: ExecutionPlan,
    originalPrompt: string,
    workspaceRoot: string,
    onProgress?: (step: number, total: number, message: string) => void,
    referenceFileContent?: string,
    referenceFileName?: string
): Promise<{ success: boolean; filesCreated: string[] }> {
    const statusBarManager = getStatusBarManager();
    const filesCreated: string[] = [];
    const headerPublicAPIs = new Map<string, string>(); // Track ONLY public API signatures
    
    try {
        // Create src/ directory for source files
        const srcDir = path.join(workspaceRoot, 'src');
        if (!fs.existsSync(srcDir)) {
            fs.mkdirSync(srcDir, { recursive: true });
            console.log('[PlanExecutor] Created src/ directory');
        }
        
        // Group files by module (header + cpp pairs)
        const modules: Array<{header: PlanStep, impl?: PlanStep}> = [];
        const mainFiles: PlanStep[] = [];
        const configFiles: PlanStep[] = [];
        
        // First pass: categorize files
        for (const step of plan.steps) {
            if (step.fileType === 'config') {
                configFiles.push(step);
            } else if (step.fileType === 'header') {
                modules.push({header: step});
            } else if (step.fileType === 'source') {
                const baseName = path.basename(step.fileName, path.extname(step.fileName));
                if (baseName.toLowerCase() === 'main') {
                    mainFiles.push(step);
                } else {
                    // Find matching header
                    const headerName = `${baseName}.hpp`;
                    const module = modules.find(m => m.header.fileName === headerName);
                    if (module) {
                        module.impl = step;
                    } else {
                        // Standalone cpp without header
                        modules.push({header: step as any, impl: undefined});
                    }
                }
            }
        }
        
        // Calculate actual steps: headers + impls that exist + main + config
        let actualSteps = 0;
        for (const module of modules) {
            actualSteps++; // header
            if (module.impl) actualSteps++; // impl (only if exists)
        }
        actualSteps += mainFiles.length + configFiles.length;
        
        const totalSteps = actualSteps;
        let currentStep = 0;
        
        console.log('[PlanExecutor] Generation plan: ' + modules.length + ' modules (' + 
                    modules.filter(m => m.impl).length + ' with impl), ' + 
                    mainFiles.length + ' main files, ' + configFiles.length + ' config files = ' + totalSteps + ' total steps');
        
        // Store full header content for sending to main.cpp (instead of user's reference file)
        const generatedHeaders = new Map<string, string>();
        
        // PHASE 1: Generate each module pair sequentially (header THEN implementation)
        // Each gets ONLY what it needs - no accumulated context
        for (const module of modules) {
            // Step 1: Generate header with minimal context
            currentStep++;
            const headerFileName = module.header.fileName;
            
            if (onProgress) {
                onProgress(currentStep, totalSteps, `Creating ${headerFileName}...`);
            }
            
            statusBarManager.showOperation('Creating', `${headerFileName} (${currentStep}/${totalSteps})`);
            
            const headerContent = await generateFileContent(
                client,
                headerFileName,
                module.header.description,
                originalPrompt,
                plan.projectType,
                undefined,  // No context for headers
                undefined,
                referenceFileContent,  // Send user's reference file to learn patterns
                referenceFileName
            );
            
            if (headerContent) {
                // Store FULL header content for main.cpp generation
                generatedHeaders.set(headerFileName, headerContent);
                
                // Extract ONLY public API (function declarations, class names)
                const publicAPI = extractPublicAPI(headerContent);
                headerPublicAPIs.set(headerFileName, publicAPI);
                
                // Save header file
                const headerPath = saveFile(workspaceRoot, headerFileName, headerContent);
                if (headerPath) {
                    filesCreated.push(headerPath);
                    // Open first file in editor
                    if (filesCreated.length === 1) {
                        const doc = await vscode.workspace.openTextDocument(path.join(workspaceRoot, headerPath));
                        await vscode.window.showTextDocument(doc);
                    }
                }
            }
            
            // Step 2: Generate implementation with ONLY its header's public API
            if (module.impl) {
                currentStep++;
                const implFileName = module.impl.fileName;
                
                if (onProgress) {
                    onProgress(currentStep, totalSteps, `Creating ${implFileName}...`);
                }
                
                statusBarManager.showOperation('Creating', `${implFileName} (${currentStep}/${totalSteps})`);
                
                const implContent = await generateFileContent(
                    client,
                    implFileName,
                    module.impl.description,
                    originalPrompt,
                    plan.projectType,
                    headerPublicAPIs.get(headerFileName),  // ONLY this header's API
                    undefined,  // No other modules
                    referenceFileContent,
                    referenceFileName
                );
                
                if (implContent) {
                    console.log(`[PlanExecutor] Saving ${implFileName} (${implContent.length} chars)`);
                    const implPath = saveFile(workspaceRoot, implFileName, implContent);
                    if (implPath) {
                        filesCreated.push(implPath);
                        console.log(`[PlanExecutor] Saved ${implFileName} to ${implPath}`);
                    } else {
                        console.error(`[PlanExecutor] Failed to save ${implFileName}`);
                    }
                }
            }
        }
        
        // PHASE 2: Generate main.cpp with GENERATED HEADERS as reference (not user's original file)
        for (const mainStep of mainFiles) {
            currentStep++;
            const mainFileName = mainStep.fileName;
            
            if (onProgress) {
                onProgress(currentStep, totalSteps, `Creating ${mainFileName}...`);
            }
            
            statusBarManager.showOperation('Creating', `${mainFileName} (${currentStep}/${totalSteps})`);
            
            // Combine all generated headers into one reference document for main.cpp
            let combinedHeaders = '';
            let headerFileNames: string[] = [];
            for (const [headerName, headerContent] of generatedHeaders) {
                combinedHeaders += `// === ${headerName} ===\n\n${headerContent}\n\n`;
                headerFileNames.push(headerName);
            }
            
            // For main.cpp: Send GENERATED HEADERS as reference, NOT the user's original file
            // This ensures main.cpp uses the APIs we just created, not the server-side patterns
            const mainContent = await generateFileContent(
                client,
                mainFileName,
                mainStep.description,
                originalPrompt,
                plan.projectType,
                undefined,
                headerPublicAPIs,  // Pass API map
                combinedHeaders || undefined,  // Send generated headers, not user's reference file
                headerFileNames.length > 0 ? headerFileNames.join(', ') : undefined  // List header names
            );
            
            if (mainContent) {
                const mainPath = saveFile(workspaceRoot, mainFileName, mainContent);
                if (mainPath) {
                    filesCreated.push(mainPath);
                }
            }
        }
        
        // PHASE 3: Generate config files with ONLY filename list
        for (const configStep of configFiles) {
            currentStep++;
            const configFileName = configStep.fileName;
            
            if (onProgress) {
                onProgress(currentStep, totalSteps, `Creating ${configFileName}...`);
            }
            
            statusBarManager.showOperation('Creating', `${configFileName} (${currentStep}/${totalSteps})`);
            
            const configContent = await generateConfigFile(
                client,
                configFileName,
                configStep.description,
                filesCreated,
                plan.projectType,
                plan.buildSystem
            );
            
            if (configContent) {
                const configPath = path.join(workspaceRoot, configFileName);
                fs.writeFileSync(configPath, configContent, 'utf-8');
                filesCreated.push(configFileName);
            }
        }
        
        statusBarManager.clearOperation();
        statusBarManager.showSuccess(`Created ${filesCreated.length} files`, 3000);
        
        return { success: true, filesCreated };
        
    } catch (error: any) {
        statusBarManager.showError('Execution failed');
        console.error('Plan execution error:', error);
        return { success: false, filesCreated };
    }
}

/**
 * Generate content for a specific file
 */
async function generateFileContent(
    client: BoudicaClient,
    fileName: string,
    description: string,
    originalPrompt: string,
    projectType: string,
    correspondingHeaderSignatures?: string,
    allHeaderSummaries?: Map<string, string>,
    referenceFileContent?: string,
    referenceFileName?: string
): Promise<string | null> {
    try {
        // Detect if this is a .cpp file with corresponding .hpp
        const baseName = path.basename(fileName, path.extname(fileName));
        const ext = path.extname(fileName).toLowerCase();
        const isImplementationFile = ['.cpp', '.c', '.cc', '.cxx'].includes(ext);
        const isHeaderFile = ['.hpp', '.h', '.hxx'].includes(ext);
        const isMainFile = baseName.toLowerCase() === 'main';
        const headerFileName = `${baseName}.hpp`;
        
        let headerRequirement = '';
        let moduleInstructions = '';
        
        // Special instructions for header files to prevent inline definitions
        if (isHeaderFile && !isMainFile) {
            headerRequirement = `\n\n**CRITICAL HEADER FILE RULES:**
This is a C++ header file (.hpp). You MUST follow proper header/implementation separation:

**DO:**
- Declare classes, functions, and methods
- Use header guards (#ifndef, #define, #endif)
- Include necessary system headers (#include <string>, <vector>, <map>, etc.)
- For external library types: #include their headers, do NOT forward-declare

**DO NOT:**
- Define method bodies inside the class (no inline implementations)
- Put function implementations in this file (except small inline functions)
- Forward-declare external library types (CURL, json, etc.) - include their headers instead
- Example of what NOT to do:
  \`\`\`cpp
  struct CURL;  // ❌ WRONG - external library type, use #include <curl/curl.h>
  class MyClass {
  public:
      void MyMethod() { /* code here */ }  // ❌ WRONG - no body in header
  };
  \`\`\`

**CORRECT FORMAT:**
\`\`\`cpp
#include <curl/curl.h>  // ✓ Include external library headers
class MyClass {
public:
    void MyMethod();  // ✓ Declaration only
};
\`\`\`

The .cpp file will contain all implementations. Keep this header file as declarations only.`;
        } else if (isImplementationFile && !isMainFile && correspondingHeaderSignatures) {
            // For .cpp files: Use COMPACT signatures only
            headerRequirement = `\n\n**CRITICAL IMPLEMENTATION FILE RULES:**
Your header ${headerFileName} declares:
\`\`\`cpp
${correspondingHeaderSignatures}
\`\`\`

**You MUST:**
1. Start with: #include "${headerFileName}"
2. Include ALL necessary standard library headers for functions you use:
   - std::string, std::map, std::vector → #include <string>, <map>, <vector>
   - std::replace, std::find, std::sort → #include <algorithm>
   - std::unique_ptr, std::shared_ptr → #include <memory>
   - std::cout, std::cerr → #include <iostream>
   - std::stringstream → #include <sstream>
3. Implement ALL functions/methods declared in the header
4. Use the EXACT signatures: ClassName::MethodName(...)
5. Use the EXACT member variable names shown above (e.g., if header has "impl_", use "impl_", NOT "http_client_" or any other name)
6. Do NOT invent new member variables - only use what's declared in the header
7. Do NOT redefine anything - only provide implementations for declarations

**If the header already has inline definitions** (method bodies in class):
- DO NOT reimplement those methods here
- This file can be minimal or empty if everything is inline
- Only implement methods that are declared but not defined`;
        } else if (isImplementationFile && !isMainFile) {
            // Fallback if no header found
            headerRequirement = `\n\n**CRITICAL IMPLEMENTATION FILE RULES:**
This ${fileName} file MUST:
1. Start with: #include "${headerFileName}"
2. Include ALL necessary standard library headers for functions you use:
   - std::replace, std::find, std::sort → #include <algorithm>
   - std::unique_ptr, std::make_unique → #include <memory>
   - std::cout, std::cerr → #include <iostream>
   - std::stringstream → #include <sstream>
3. Implement all functions/methods declared in ${headerFileName}
4. Use proper C++ syntax: ClassName::MethodName(...) { /* implementation */ }
5. Use ONLY member variables declared in the header - do NOT invent new ones
6. Do NOT redefine methods that are already defined inline in the header
7. If header has inline definitions, this file may be minimal or empty`;
        } else if (isMainFile && allHeaderSummaries && allHeaderSummaries.size > 0) {
            // For main.cpp: Show ACTUAL PUBLIC API so it knows what methods exist
            const moduleList: string[] = [];
            for (const [headerName, summary] of allHeaderSummaries) {
                if (!headerName.toLowerCase().includes('main')) {
                    // Show actual public methods (not just class names)
                    // Limit to first 10 lines to avoid context explosion
                    const apiLines = summary.split('\n').filter(line => line.trim()).slice(0, 10);
                    if (apiLines.length > 0) {
                        moduleList.push(`\n#include "${headerName}" provides:\n\`\`\`cpp\n${apiLines.join('\n')}\n\`\`\``);
                    }
                }
            }
            if (moduleList.length > 0) {
                const firstHeader = Array.from(allHeaderSummaries.keys()).find(k => !k.toLowerCase().includes('main'));
                moduleInstructions = `\n\n**Available Modules - ONLY these methods exist**:${moduleList.join('\n')}\n\nYou MUST:\n1. Include these headers (e.g., #include "${firstHeader}")\n2. ONLY call methods shown above - they are the COMPLETE public API\n3. Do NOT call methods that aren't listed (e.g., if no GetUserId() above, don't call it)\n4. Do NOT invent methods - if you need functionality not listed, implement it in main()\n5. Check the declarations carefully - these are ALL the available methods`;
            }
        }
        
        // Detect if reference file is server-side code
        let referenceGuidance = '';
        if (referenceFileContent && referenceFileName && !isMainFile) {
            const isServerCode = referenceFileContent.includes('PATH_INFO') ||
                                referenceFileContent.includes('REQUEST_METHOD') ||
                                referenceFileContent.includes('handle_chat') ||
                                referenceFileContent.includes('handle_generate') ||
                                (referenceFileContent.includes('main()') && referenceFileContent.includes('getenv'));
            
            if (isServerCode) {
                referenceGuidance = `\n\n**REFERENCE FILE CONTEXT (${referenceFileName}):**
This reference shows SERVER-SIDE implementation. You are creating a CLIENT that CALLS this server.

**DO NOT:**
- Copy server routing logic (PATH_INFO, REQUEST_METHOD, handle_* functions)
- Create separate methods for every endpoint you see in the server code
- Replicate the server's architecture

**INSTEAD:**
- Create 1-2 SIMPLE HTTP methods: one for POST (e.g., SendChat, Post), optionally one for GET
- These methods take endpoint path and JSON body as parameters
- Study what JSON parameters the server RECEIVES (message, user_id, temperature, max_tokens, etc.)
- Let the calling code construct different prompts - your job is just HTTP transport
- Example: A single Post("/chat", json_body) method that can handle ANY chat request

**Server Analysis:**
If server shows \`if (path == "/chat")\` → your client needs Post() method that can send to "/chat"
If server parses JSON with "message", "user_id" → your client's Post() accepts those in JSON body

**Keep it minimal** - One or two generic HTTP methods, not specialized CreateCode(), EditCode(), etc.`;
            }
        }
        
        const prompt = `I am creating a ${projectType} project: ${originalPrompt}

Now generate ONLY the code for this specific file:
**File**: ${fileName}
**Purpose**: ${description}${headerRequirement}${moduleInstructions}${referenceGuidance}

**CRITICAL - Read the original request above carefully:**
- Understand WHAT the user is building (client? server? library? tool?)
- If the prompt says "connecting to", "calls", "uses" an API → you are building a CLIENT
- If the prompt says "implements", "serves", "handles" requests → you are building a SERVER
- Any reference files are for patterns/style/examples only - DO NOT copy their architecture blindly
- Your code must fulfill the USER'S request, not replicate the reference file's purpose

Requirements:
- Write complete, production-ready code
- Include all necessary system headers/imports
- Add helpful comments
- Follow best practices for ${projectType}
- Make it compatible with other files in this project

**OUTPUT REQUIREMENT:**
- Generate the COMPLETE file from start to finish
- Do NOT truncate or summarize
- Do NOT add "Response truncated" messages
- Generate executable source code only`;
// COMMENTED OUT - causes model to output garbage or confuse languages:
// - No documentation, no tutorials, no feature lists
// - Code that compiles and runs when saved to ${fileName}
// - Use language-appropriate syntax and idioms

        console.log(`[DEBUG] Prompt for ${fileName} - length: ${prompt.length} characters`);
        console.log(`[DEBUG] Requesting max_tokens: (auto-set to 32000 by boudicaClient)`);

        // DEBUG: Save the prompt being sent (will have FORMAT block prepended by boudicaClient)
        if (fileName.endsWith('.hpp') || fileName.endsWith('.h')) {
            const promptDebugPath = path.join('/tmp', `prompt_sent_${fileName}.txt`);
            try {
                fs.writeFileSync(promptDebugPath, prompt, 'utf-8');
                console.log(`[DEBUG] Prompt saved to: ${promptDebugPath}`);
            } catch (err) {
                console.error(`[DEBUG] Failed to save prompt: ${err}`);
            }
        }

        const response = await client.chat({
            message: prompt,
            session_id: 'create-' + Date.now(),
            temperature: 0.8,  // Match web UI default
            // Let boudicaClient set max_tokens automatically (32000 for code generation)
            forCodeGeneration: true,
            // CRITICAL: Send reference file to populate document_context and disable list-guard
            // The list-guard at inference_server.cpp:16093 only triggers when:
            // !external_db_context_ready && rag_context.empty() && document_context.empty()
            // Adding a file makes document_context non-empty, bypassing the 12-item truncation
            // Also provides the model with actual implementation to reference (e.g., slm_cgi_client.cpp)
            file_content: referenceFileContent || "// Code generation context\n",
            file_name: referenceFileName || "context.txt"
        });

        if (response.error || !response.response) {
            return null;
        }

        // DEBUG: Save raw response for first file to inspect model output
        // This captures EXACTLY what the model returned before any processing
        if (fileName.endsWith('.hpp') || fileName.endsWith('.h')) {
            const debugPath = path.join('/tmp', `raw_model_response_${fileName}.txt`);
            const debugContent = `=== RAW MODEL RESPONSE FOR ${fileName} ===
=== Timestamp: ${new Date().toISOString()} ===
=== Response Length: ${response.response.length} characters ===
=== Has Error: ${response.error || 'none'} ===

${response.response}

=== END RAW RESPONSE ===`;
            
            try {
                fs.writeFileSync(debugPath, debugContent, 'utf-8');
                console.log(`[DEBUG] Raw model response saved to: ${debugPath}`);
                console.log(`[DEBUG] Response length: ${response.response.length} characters`);
            } catch (err) {
                console.error(`[DEBUG] Failed to save raw response: ${err}`);
            }
        }

        // Extract code from response - handle multiple formats
        let extractedCode = extractCodeFromResponse(response.response);
        
        // DEBUG: Save extracted code for first file to compare with raw
        if (fileName.endsWith('.hpp') || fileName.endsWith('.h')) {
            const debugPath = path.join('/tmp', `extracted_code_${fileName}.txt`);
            const debugContent = `=== EXTRACTED CODE FOR ${fileName} ===
=== Timestamp: ${new Date().toISOString()} ===
=== Extracted Length: ${extractedCode.length} characters ===
=== Original Length: ${response.response.length} characters ===

${extractedCode}

=== END EXTRACTED CODE ===`;
            
            try {
                fs.writeFileSync(debugPath, debugContent, 'utf-8');
                console.log(`[DEBUG] Extracted code saved to: ${debugPath}`);
                console.log(`[DEBUG] Extracted length: ${extractedCode.length} characters`);
            } catch (err) {
                console.error(`[DEBUG] Failed to save extracted code: ${err}`);
            }
        }
        
        return extractedCode;
        
    } catch (error) {
        console.error(`Error generating ${fileName}:`, error);
        return null;
    }
}

/**
 * Extract actual code from various response formats (markdown, HTML, plain text)
 */
function extractCodeFromResponse(response: string): string {
    // 1. Try markdown code block first (flexible matching)
    // Matches: ```cpp\ncode\n``` or ```\ncode\n``` with optional whitespace
    const codeBlockMatch = response.match(/```(?:\w+)?[\s\r\n]+([\s\S]+?)[\s\r\n]+```/);
    if (codeBlockMatch) {
        return cleanModelDisclaimer(codeBlockMatch[1].trim());
    }
    
    // 2. Try without the closing fence (in case model forgot to close)
    const openFenceMatch = response.match(/```(?:\w+)?[\s\r\n]+([\s\S]+)$/);
    if (openFenceMatch) {
        return cleanModelDisclaimer(openFenceMatch[1].trim());
    }
    
    // 3. Check if response is HTML wrapped
    if (response.includes('<!DOCTYPE html>') || response.includes('<html>')) {
        // Extract from <pre> or <code> tags
        let code = response;
        
        // Remove everything before <pre> and after </pre>
        const preMatch = code.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
        if (preMatch) {
            code = preMatch[1];
        }
        
        // Remove <code> tags if present
        code = code.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '$1');
        
        // Remove all HTML tags (including span with classes)
        code = code.replace(/<[^>]+>/g, '');
        
        // Decode HTML entities
        code = code.replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&amp;/g, '&')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'")
                   .replace(/&nbsp;/g, ' ');
        
        return cleanModelDisclaimer(code.trim());
    }
    
    // 4. Plain text - return as is
    return cleanModelDisclaimer(response.trim());
}

/**
 * Remove model disclaimers that sometimes appear at end of responses
 */
function cleanModelDisclaimer(content: string): string {
    // Common disclaimer patterns that should be removed
    const disclaimerPatterns = [
        /---+\s*\n\s*We try hard to provide[\s\S]*$/i,
        /---+\s*We try hard to provide[\s\S]*$/i,
        /\n\s*---+\s*\n\s*We try hard[\s\S]*$/i,
        /We try hard to provide only accurate responses[\s\S]*give it a low star rating[\s\S]*$/i,
        /\*\*Disclaimer[\s\S]*?\*\*/i,
        /Note: This response[\s\S]*verify[\s\S]*$/i
    ];
    
    let cleaned = content;
    for (const pattern of disclaimerPatterns) {
        cleaned = cleaned.replace(pattern, '');
    }
    
    // Trim any trailing whitespace/newlines left after removal
    return cleaned.trimEnd();
}

/**
 * Helper to save file to workspace (handles src/ directory)
 */
function saveFile(workspaceRoot: string, fileName: string, content: string): string | null {
    try {
        // Save source files (.cpp, .hpp, .h, .c, .py, .js, .ts, etc.) to src/
        // Save config files (CMakeLists.txt, Makefile, etc.) to root
        const ext = path.extname(fileName).toLowerCase();
        const isSourceFile = ['.cpp', '.hpp', '.h', '.c', '.cc', '.cxx', '.py', '.js', '.ts', '.rs', '.go', '.java'].includes(ext);
        
        let savePath = fileName;
        if (isSourceFile) {
            const srcDir = path.join(workspaceRoot, 'src');
            if (!fs.existsSync(srcDir)) {
                fs.mkdirSync(srcDir, { recursive: true });
            }
            savePath = path.join('src', path.basename(fileName));
        }
        
        const filePath = path.join(workspaceRoot, savePath);
        const fileDir = path.dirname(filePath);
        if (!fs.existsSync(fileDir)) {
            fs.mkdirSync(fileDir, { recursive: true });
        }
        
        fs.writeFileSync(filePath, content, 'utf-8');
        return savePath;
    } catch (error) {
        console.error(`Error saving ${fileName}:`, error);
        return null;
    }
}

/**
 * Extract ONLY public API from header: class names + public function declarations
 * Much more aggressive than extractHeaderSignatures - only what main.cpp needs
 */
function extractPublicAPI(headerContent: string): string {
    const lines = headerContent.split('\n');
    const publicItems: string[] = [];
    const privateMemberVars: string[] = [];
    let inClass = false;
    let inPublicSection = true; // Start assuming public
    let className = '';
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Skip comments
        if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
            continue;
        }
        
        // Class/struct declaration
        if (line.match(/^(class|struct)\s+(\w+)/)) {
            const match = line.match(/^(class|struct)\s+(\w+)/);
            if (match) {
                className = match[2];
                publicItems.push(`class ${className};`);
                inClass = true;
                inPublicSection = match[1] === 'struct'; // struct is public by default
            }
            continue;
        }
        
        // Track public/private sections
        if (line.startsWith('public:')) {
            inPublicSection = true;
            continue;
        }
        if (line.startsWith('private:') || line.startsWith('protected:')) {
            inPublicSection = false;
            continue;
        }
        
        // End of class
        if (line.startsWith('};') && inClass) {
            inClass = false;
            inPublicSection = true;
            continue;
        }
        
        // Collect public function declarations
        if (inPublicSection && line.includes('(') && line.endsWith(';')) {
            // Remove leading/trailing whitespace, keep only the signature
            publicItems.push(line);
        }
        
        // CRITICAL: Also collect private member variables (for .cpp to use correct names)
        if (!inPublicSection && inClass && line.endsWith(';') && !line.includes('(')) {
            // This looks like a member variable (ends with ; but no function call)
            // Examples: "std::string base_url_;", "HTTPClientImpl* impl_;"
            privateMemberVars.push(line);
        }
    }
    
    // Return public API PLUS private member variable names (so .cpp uses correct names)
    let result = publicItems.join('\n');
    if (privateMemberVars.length > 0) {
        result += '\n\n// PRIVATE MEMBER VARIABLES (use these exact names):\n';
        result += privateMemberVars.join('\n');
    }
    return result;
}

/**
 * Extract compact function signatures from header content
 * Removes comments, implementation details, only keeps declarations
 */
function extractHeaderSignatures(headerContent: string): string {
    const lines = headerContent.split('\n');
    const signatures: string[] = [];
    let inComment = false;
    let braceDepth = 0;
    
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        
        // Skip multi-line comments
        if (line.includes('/*')) {
            inComment = true;
        }
        if (inComment) {
            if (line.includes('*/')) {
                inComment = false;
            }
            continue;
        }
        
        // Skip single-line comments
        if (line.startsWith('//')) {
            continue;
        }
        
        // Skip preprocessor directives except includes
        if (line.startsWith('#') && !line.startsWith('#include')) {
            continue;
        }
        
        // Track braces to detect inline implementations
        braceDepth += (line.match(/{/g) || []).length;
        braceDepth -= (line.match(/}/g) || []).length;
        
        // Collect function declarations, class declarations
        if (braceDepth === 0 || (braceDepth === 1 && line.includes('class '))) {
            // Keep function declarations (ending with ;)
            if (line.includes('(') && (line.endsWith(';') || line.includes(') {'))) {
                signatures.push(line.replace(/ \{.*$/, ';')); // Remove inline implementation
            }
            // Keep class/struct declarations
            else if (line.match(/^(class|struct|enum)\s+\w+/)) {
                signatures.push(line);
            }
        }
    }
    
    return signatures.join('\n');
}

/**
 * Generate build configuration file
 */
async function generateConfigFile(
    client: BoudicaClient,
    fileName: string,
    description: string,
    existingFiles: string[],
    projectType: string,
    buildSystem?: string
): Promise<string | null> {
    try {
        const fileList = existingFiles.join(', ');
        
        const prompt = `Generate a ${fileName} file for a ${projectType} project.

**Purpose**: ${description}
**Build System**: ${buildSystem || 'standard'}
**Project Files**: ${fileList}

Requirements:
- Include all project files: ${fileList}
- Configure necessary dependencies (e.g., libcurl for C++, axios for Node.js)
- Set appropriate compiler flags and standards
- Make it ready to build immediately

**OUTPUT REQUIREMENT:**
- Generate executable configuration file content only
- Output valid ${fileName} syntax
- No explanatory text outside the config file`;

        const response = await client.chat({
            message: prompt,
            session_id: 'config-' + Date.now(),
            temperature: 0.5,
            max_tokens: 1500,
            forCodeGeneration: true
        });

        if (response.error || !response.response) {
            return null;
        }

        // Extract code from response - handle multiple formats
        return extractCodeFromResponse(response.response);
        
    } catch (error) {
        console.error(`Error generating ${fileName}:`, error);
        return null;
    }
}
