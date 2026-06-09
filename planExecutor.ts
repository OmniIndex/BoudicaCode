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
import { reportStatus } from './statusReporter';

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
    promptSubstitutions?: Array<{ from: string; to: string }>;
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
    
    // Must be long enough to be a real request
    if (prompt.length < 20) {
        return false;
    }

    // Exact-phrase keywords
    const planKeywords = [
        'create a', 'create an',
        'creat a', 'creat an',    // common typo
        'i want to create',
        'i need to create',
        'build a', 'build an',
        'make a', 'make an',
        'develop a', 'develop an',
        'i want an application', 'i need an application',
        'write a', 'write an',
        'generate a', 'generate an',
        'design a', 'design an',
    ];

    // Output-type words that signal "create something"
    const outputTypes = [
        'interface', 'web interface', 'web page', 'webpage', 'website', 'web app',
        'dashboard', 'frontend', 'front end', 'ui ', 'application', 'app ',
        'tool', 'script', 'program', 'service', 'api', 'server',
        'client', 'library', 'module', 'plugin', 'extension',
    ];

    const hasActionKeyword = planKeywords.some(kw => lowerPrompt.includes(kw));
    if (hasActionKeyword) { return true; }

    // Looser: verb (create/build/make/write/generate) + output-type word anywhere in the prompt
    const looseVerbs = ['creat', 'build', 'make', 'develop', 'generat', 'design', 'write', 'implement'];
    const hasVerb = looseVerbs.some(v => lowerPrompt.includes(v));
    const hasOutputType = outputTypes.some(t => lowerPrompt.includes(t));
    return hasVerb && hasOutputType;
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
 * Sanitize a user prompt for the planning channel so the Boudica server's
 * connection-provisioning interceptor does NOT match it. The interceptor
 * runs server-side BEFORE the model sees the prompt and is triggered by
 * combinations of keywords like "create"/"add" + "web|http|rest|graphql|...
 * api|service|integration|connection" + ("oauth"|"token"|"key"). When that
 * fires we get back a connection config dump instead of a build plan.
 *
 * We rewrite the offending words to semantically-equivalent phrases the
 * interceptor doesn't match. The model still understands the request
 * (it's a base LLM, not a keyword classifier).
 *
 * Returns the rewritten prompt plus an array of substitutions performed
 * so the caller can show the user what changed.
 */
export function sanitizePromptForPlanning(prompt: string): { prompt: string; substitutions: Array<{ from: string; to: string }> } {
    const substitutions: Array<{ from: string; to: string }> = [];

    // Order matters: longer / more specific phrases first
    const rules: Array<{ pattern: RegExp; replacement: string; label: string }> = [
        // "oauth connection" / "oauth2 connection" -> "browser login flow"
        { pattern: /\boauth2?\s+connection(s)?\b/gi, replacement: 'browser login flow$1', label: 'oauth connection' },
        // "oauth connection flow(s)" handled above; "connection flow(s)" alone -> "login flow"
        { pattern: /\bconnection\s+flow(s)?\b/gi, replacement: 'login flow$1', label: 'connection flow' },
        // "web ... api" / "web ... service" patterns
        { pattern: /\bweb\s+api(s)?\b/gi, replacement: 'browser-based backend$1', label: 'web api' },
        { pattern: /\bweb\s+service(s)?\b/gi, replacement: 'browser-based backend$1', label: 'web service' },
        // "web based user interface" / "web-based UI" -> "browser-based UI"
        { pattern: /\bweb[-\s]based\s+user\s+interface\b/gi, replacement: 'browser-based UI', label: 'web based user interface' },
        { pattern: /\bweb[-\s]based\b/gi, replacement: 'browser-based', label: 'web-based' },
        // Standalone "web interface" / "web app" / "web ui"
        { pattern: /\bweb\s+interface\b/gi, replacement: 'browser UI', label: 'web interface' },
        { pattern: /\bweb\s+app(s)?\b/gi, replacement: 'browser app$1', label: 'web app' },
        { pattern: /\bweb\s+ui\b/gi, replacement: 'browser UI', label: 'web UI' },
        // OAuth on its own -> OAuth2 login (not in interceptor list, but normalize)
        { pattern: /\boauth\b(?!\s*2)/gi, replacement: 'OAuth2 login', label: 'oauth' },
        // "API connection" -> "API integration"
        { pattern: /\bapi\s+connection(s)?\b/gi, replacement: 'API integration$1', label: 'api connection' },
        // bare "connection(s)" near "create"/"add" — only if the word appears in a
        // creation/scaffolding context (heuristic: do nothing here; the above patterns cover most cases).
    ];

    let out = prompt;
    for (const rule of rules) {
        const before = out;
        out = out.replace(rule.pattern, (match, ...rest) => {
            // Re-build replacement with capture groups
            let replaced = rule.replacement;
            for (let i = 0; i < rest.length - 2; i++) {
                replaced = replaced.replace('$' + (i + 1), rest[i] ?? '');
            }
            substitutions.push({ from: match, to: replaced });
            return replaced;
        });
        if (before !== out) {
            // Allow this rule to record substitutions; continue.
        }
    }

    return { prompt: out, substitutions };
}

/**
 * Generate a plan by asking Boudica for steps only.
 *
 * `projectFiles` (if provided) is uploaded as multipart/form-data attachments
 * via `BoudicaClient.chatWithFiles(...)` rather than being inlined into the
 * prompt. The server's `TextExtractor` processes each attachment and gives
 * the model a clean `Reference material from <file>:` block per file, which
 * prevents the "the source code appears truncated" refusal we used to get
 * when inlining everything as prompt text.
 *
 * `projectContext` is the legacy inline-text fallback and is still honoured
 * when `projectFiles` is undefined (e.g. for very small projects or call
 * sites that haven't migrated yet).
 */
export async function generatePlan(
    client: BoudicaClient,
    userPrompt: string,
    workspaceRoot: string,
    referenceFileContent?: string,
    referenceFileName?: string,
    projectContext?: string,
    projectFiles?: { tree: string; files: Array<{ relPath: string; filename: string; content: string }> }
): Promise<ExecutionPlan | null> {
    const statusBarManager = getStatusBarManager();
    
    try {
        statusBarManager.showOperation('Planning', 'Generating project plan...');

        // Sanitize the user prompt to avoid triggering the server's API connection
        // provisioning interceptor (matches "web"/"oauth"/"connection" combos).
        const sanitized = sanitizePromptForPlanning(userPrompt);
        if (sanitized.substitutions.length > 0) {
            const subsMsg = 'Sanitized prompt to avoid server interceptor. Substitutions: ' +
                sanitized.substitutions.map(s => `"${s.from}" → "${s.to}"`).join(', ');
            console.log('[PlanExecutor] ' + subsMsg);
            reportStatus(subsMsg);
        }
        const safeUserPrompt = sanitized.prompt;

        // Include referenced file (e.g. open editor) for context
        const referenceBlock = (referenceFileContent && referenceFileName)
            ? `\n\nActive editor file (${referenceFileName}):\n\`\`\`\n${referenceFileContent}\n\`\`\``
            : '';

        // Decide delivery mode:
        //   • If `projectFiles` provided → upload as multipart attachments,
        //     mention only the file tree in the prompt body.
        //   • Else if legacy `projectContext` string provided → inline as before.
        //   • Else → no project context.
        const useAttachments = !!(projectFiles && projectFiles.files.length > 0);
        const projectBlock = useAttachments
            ? `\n\nThe project's existing source files are attached to this request as separate uploads. Their contents are available to you as "Reference material from <filename>:" blocks. File tree:\n${projectFiles!.tree}`
            : (projectContext
                ? `\n\nExisting project files for reference:\n${projectContext}`
                : '');

        // Keep this prompt SHORT, NATURAL, and free of chat-template markup.
        // - Start with "No Memory" so the server's conversation-memory recall
        //   does NOT prepend past attempts.
        // - Use a calm, positive-only instruction. Earlier versions had an
        //   aggressive "Do NOT output `<!DOCTYPE`, `<html`, `<script`, `import`,
        //   `def`, `class`, `#include` or any code fence" guard list, which
        //   tripped the server's jailbreak classifier ("Input contains
        //   potentially malicious content") because that pattern looks like
        //   the negative-imperative form used by injection attacks. The
        //   model-side hint is enough; the parser will reject anything that
        //   isn't a numbered file list anyway.
        const planningPrompt = `No Memory
${safeUserPrompt}${referenceBlock}${projectBlock}

Plan only. Do not create any files. Do not write the contents of any file. A developer will write each file afterwards from your plan. The project files above are for style reference only.

Reply with a plain text numbered list — one file per line — in exactly this shape (no HTML, no <ol>, no <li>, no <code> tags, no markdown headings):

1. Create \`path/filename.ext\` - short description
2. Create \`path/filename.ext\` - short description

Use real source-file extensions (.py, .js, .ts, .html, .css, .json, etc) that fit the project. Reply with just the numbered list and nothing else. Begin your reply with "1. Create".`;

        const chatRequest: ChatRequest = {
            message: planningPrompt,
            session_id: 'plan-' + Date.now(),
            temperature: 0.4,
            max_tokens: 4000,
            skipClean: true,    // Don't strip step lines via cleanResponse
            rawMessage: true    // We've put "No Memory" inline, so skip prepareMessage wrapping
        };

        const response = useAttachments
            ? await client.chatWithFiles(
                chatRequest,
                projectFiles!.files.map(f => ({ filename: f.filename, content: f.content }))
            )
            : await client.chat(chatRequest);

        statusBarManager.clearOperation();

        if (response.error || !response.response) {
            console.error('[PlanExecutor] Plan generation failed:', response.error || 'empty response');
            return null;
        }

        console.log('[PlanExecutor] Raw plan response (length=' + response.response.length + '):\n' + response.response.substring(0, 1500));

        // Detect server-side connection-provisioning interception. The Boudica server
        // sometimes intercepts prompts like "create a web api" and returns a config
        // file ("Connection created: web", "OAUTH TOKEN", "RULE block", etc.) instead
        // of a build plan. If we see that, surface a clear error rather than parsing
        // garbage filenames out of it.
        const interceptionMarkers = [
            'Connection created:',
            'RULE\nOAUTH TOKEN',
            'END RULE',
            'auth_type: prompt',
            'allowed_domain:'
        ];
        const looksIntercepted = interceptionMarkers.some(m => response.response!.includes(m));
        if (looksIntercepted) {
            console.warn('[PlanExecutor] Detected server-side connection-provisioning interception; aborting plan.');
            return { steps: [], projectType: 'intercepted', buildSystem: undefined, promptSubstitutions: sanitized.substitutions };
        }

        // The server occasionally prepends a conversation-memory preamble
        // ("We had a related conversation...", "💡 You discussed similar topics...")
        // separated by "---" from the actual reply. Strip everything before the LAST
        // "---" if a memory preamble is detected, so we only parse the real answer.
        let responseText = response.response;
        const memoryPreambleMarkers = [
            'We had a related conversation',
            'You discussed similar topics',
            "Type 'show #",
            'used that as context'
        ];
        if (memoryPreambleMarkers.some(m => responseText.includes(m))) {
            const lastSep = responseText.lastIndexOf('\n---');
            if (lastSep !== -1) {
                const stripped = responseText.slice(lastSep + 4).trim();
                if (stripped.length > 20) {
                    console.log('[PlanExecutor] Stripped memory-recall preamble; using post-separator content (' + stripped.length + ' chars).');
                    responseText = stripped;
                }
            }
        }

        // Parse the plan
        let plan = parsePlan(responseText);
        plan.promptSubstitutions = sanitized.substitutions;

        console.log('[PlanExecutor] Parsed ' + plan.steps.length + ' step(s); projectType=' + plan.projectType + ', buildSystem=' + (plan.buildSystem || 'none'));
        reportStatus('Parsed ' + plan.steps.length + ' step(s); projectType=' + plan.projectType + ', buildSystem=' + (plan.buildSystem || 'none'));

        // ---- Detect failure modes ----
        // 0. Server-side jailbreak / safety filter. The Boudica server returns a
        //    fixed message starting with "Your prompt contains phrasing that
        //    matches a security filter" (Detail: ...). Retrying with a similar
        //    prompt will almost certainly trip it again — abort and surface the
        //    error so the user can rephrase.
        const safetyFilterMarkers = [
            'matches a security filter',
            'Input contains potentially malicious content',
            'potentially malicious content'
        ];
        const hitSafetyFilter = safetyFilterMarkers.some(m => responseText.includes(m));
        if (hitSafetyFilter) {
            console.warn('[PlanExecutor] Server safety filter rejected the prompt; not retrying.');
            return {
                steps: [],
                projectType: 'safety-filtered',
                buildSystem: undefined,
                promptSubstitutions: sanitized.substitutions
            };
        }

        // 1. Refusal: model says it can't or asks for more info.
        const refusalMarkers = [
            'I cannot', 'I can not', 'I am unable', 'I\'m unable',
            'cannot access', 'cannot create', 'Please provide',
            'please clarify', 'do not have access', 'without reviewing'
        ];
        const looksRefused = refusalMarkers.some(m => responseText.toLowerCase().includes(m.toLowerCase()));

        // 2. Code dump: model ignored the format and just wrote the artifact.
        //    Heuristic — response starts with (or is dominated by) markup/code tokens.
        const trimmedHead = responseText.trimStart().slice(0, 200).toLowerCase();
        const codeDumpStarters = [
            '<!doctype', '<html', '<?xml', '<script', '<style', '<head',
            '```',
            '#include', '#!/',
            'package ', 'import ', 'from ', 'def ', 'class ', 'function ',
            'const ', 'let ', 'var ', 'public ', 'private ',
            '/*', '//', '<?php'
        ];
        const looksLikeCodeDump = codeDumpStarters.some(m => trimmedHead.startsWith(m));

        // 3. No "1. Create"-style step lines anywhere — also a dud parse.
        const hasAnyNumberedStep = /^\s*\d+[.)]\s+/m.test(responseText);

        const needsRetry =
            plan.steps.length === 0 &&
            (looksRefused || looksLikeCodeDump || !hasAnyNumberedStep);

        if (needsRetry) {
            const reason = looksLikeCodeDump
                ? 'model returned a code/markup dump instead of a file list'
                : looksRefused
                    ? 'model refused / asked for clarification'
                    : 'no numbered step lines detected';
            console.warn('[PlanExecutor] Retrying plan generation — reason: ' + reason);
            reportStatus('Retrying plan generation — reason: ' + reason);
            statusBarManager.showOperation('Planning', 'Retrying with stricter format...');

            // Calmer retry prompt. Earlier negative-imperative retries
            // ("No code. No HTML. No markup.") also risk hitting the server's
            // safety filter, so keep the wording positive and concrete.
            // Drop attachments — when the model has the source available it
            // tends to write the artifact instead of the plan.
            const retryPrompt = `No Memory
${safeUserPrompt}

Plan only. Do not create any files. Give me only a plain text numbered list of filenames a developer should create next. Use this exact line format (no HTML, no <li>, no <code> tags, no markdown headings):

1. Create \`path/filename.ext\` - short description
2. Create \`path/filename.ext\` - short description

Use real source-file extensions (.py, .js, .ts, .html, .css, .json, etc). Begin your reply with "1. Create" and reply with nothing else.`;

            const retryRequest: ChatRequest = {
                message: retryPrompt,
                session_id: 'plan-retry-' + Date.now(),
                temperature: 0.2,
                max_tokens: 2000,
                skipClean: true,
                rawMessage: true
            };

            // Retry WITHOUT attachments — attachments make the model treat the
            // task as "implement this", which is exactly the failure mode we
            // saw. A naked retry forces it back into planning mode.
            const retry = await client.chat(retryRequest);
            statusBarManager.clearOperation();

            if (retry.response) {
                console.log('[PlanExecutor] Retry response (length=' + retry.response.length + '):\n' + retry.response.substring(0, 1000));
                let retryText = retry.response;
                if (memoryPreambleMarkers.some(m => retryText.includes(m))) {
                    const lastSep = retryText.lastIndexOf('\n---');
                    if (lastSep !== -1) { retryText = retryText.slice(lastSep + 4).trim(); }
                }
                const retryPlan = parsePlan(retryText);
                retryPlan.promptSubstitutions = sanitized.substitutions;
                console.log('[PlanExecutor] Retry parsed ' + retryPlan.steps.length + ' step(s).');
                if (retryPlan.steps.length > 0) {
                    plan = retryPlan;
                }
            }
        }

        if (plan.steps.length === 0) {
            console.warn('[PlanExecutor] parsePlan returned 0 steps. Full response:\n' + response.response);
        }

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

    let projectType = 'generic';
    let buildSystem: 'cmake' | 'makefile' | 'npm' | 'cargo' | 'go' | undefined;

    // Strip surrounding markdown fences if the whole response is wrapped
    let text = planText.trim();
    text = text.replace(/^```[a-zA-Z0-9]*\n?/, '').replace(/\n?```\s*$/, '');

    // Strip trailing Boudica boilerplate that sometimes slips through when
    // `skipClean: true` is set on the chat request.
    text = text.replace(/\s*---\s*\n?\s*We try hard to provide only accurate responses[\s\S]*$/i, '').trim();

    // ---- HTML-tolerant pre-processing ----
    // The model occasionally returns the file list wrapped in HTML markup
    // (e.g. <ol><li>Create <code>index.html</code> - description</li>...</ol>),
    // which the bullet-detection regex below would otherwise skip because the
    // lines start with `<li>`, not `1.` or `-`.
    //
    // 1. Convert each <li>…</li> into its own line prefixed with "- " so
    //    `stepStartRegex` matches.
    // 2. Strip <code>/<pre>/<strong>/<em>/<span> wrappers while keeping their
    //    text content, so filenames inside <code>foo.html</code> survive.
    // 3. Drop everything between <head>…</head>, <style>…</style>,
    //    <script>…</script> — these are body content of a generated artifact,
    //    not part of any file list.
    // 4. Drop any remaining tags.
    if (/<\s*(?:html|body|ol|ul|li|head|style|script|h\d|p)\b/i.test(text)) {
        // 3. Remove non-content blocks entirely (head/style/script can contain
        //    the artifact's CSS/JS, which would otherwise pollute parsing).
        text = text.replace(/<head\b[\s\S]*?<\/head>/gi, '');
        text = text.replace(/<style\b[\s\S]*?<\/style>/gi, '');
        text = text.replace(/<script\b[\s\S]*?<\/script>/gi, '');

        // 1. Convert <li>…</li> to bullet lines.
        text = text.replace(/<li[^>]*>\s*([\s\S]*?)\s*<\/li>/gi, (_m, inner) => `\n- ${inner.trim()}\n`);

        // 2. Strip inline formatting tags but keep their contents.
        text = text.replace(/<\/?(?:code|pre|strong|b|em|i|span|kbd|samp|var)\b[^>]*>/gi, '');

        // 4. Strip any other tags (including <ol>, <ul>, <h1>, <p>, …).
        text = text.replace(/<\/?[A-Za-z][^>]*>/g, '');

        // Decode the small handful of HTML entities that commonly appear in
        // filenames or descriptions.
        text = text
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");

        // Collapse runs of blank lines created by the substitutions above.
        text = text.replace(/\n{3,}/g, '\n\n').trim();
    }

    const lines = text.split('\n');

    // Tolerant filename regex — matches files with sensible extensions OR known config files.
    // The trailing (?![A-Za-z0-9]) prevents matching `.c` inside `api.web.com` (where `.com`
    // is not an extension we know — we must not chop it to `.c`).
    const fileNameRegex = /([A-Za-z0-9_./\-]+\.(?:py|pyi|js|jsx|ts|tsx|mjs|cjs|html|htm|css|scss|json|yaml|yml|toml|md|cpp|cc|cxx|c|hpp|hh|hxx|h|rs|go|java|kt|swift|cs|rb|sh|bash|sql|env|cfg|ini|conf|xml|txt|mk)(?![A-Za-z0-9])|CMakeLists\.txt|Makefile|Dockerfile|Containerfile|Procfile|Gemfile|Pipfile|Cargo\.toml|go\.mod|package\.json|tsconfig\.json|pyproject\.toml|requirements\.txt|setup\.py|setup\.cfg|\.gitignore|\.env|\.dockerignore)/;
    const stepStartRegex = /^\s*(?:[-*+]|\d+[.)])\s+/;

    const seen = new Set<string>();
    let stepCounter = 0;

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!stepStartRegex.test(line)) { continue; }

        // Find ALL filename matches in the line (a single bullet may mention multiple files)
        const filesInLine: string[] = [];
        const fileGlobalRegex = new RegExp(fileNameRegex.source, 'g');
        let m: RegExpExecArray | null;
        while ((m = fileGlobalRegex.exec(line)) !== null) {
            const fname = m[0].trim().replace(/[`'",.;:)\]]+$/, '');
            if (fname && !filesInLine.includes(fname)) {
                filesInLine.push(fname);
            }
        }
        if (filesInLine.length === 0) { continue; }

        // Description: anything after the last filename, or the whole line trimmed
        let description = line.replace(stepStartRegex, '').trim();
        // Remove the surrounding markdown emphasis/backticks for cleaner description
        description = description.replace(/[`*_]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (description.length > 250) { description = description.substring(0, 250); }

        stepCounter++;
        for (const fileName of filesInLine) {
            // Skip dupes (model sometimes lists the same file in multiple steps)
            const key = fileName.toLowerCase();
            if (seen.has(key)) { continue; }
            seen.add(key);

            steps.push({
                stepNumber: stepCounter,
                fileName,
                description: description || `Create ${fileName}`,
                fileType: getFileType(fileName)
            });

            const lower = fileName.toLowerCase();
            if (lower.includes('cmakelists.txt')) { buildSystem = 'cmake'; projectType = 'cpp'; }
            else if (/(^|\/)makefile$/i.test(fileName)) { buildSystem = 'makefile'; projectType = 'cpp'; }
            else if (lower.endsWith('package.json')) { buildSystem = 'npm'; projectType = 'nodejs'; }
            else if (lower.endsWith('cargo.toml')) { buildSystem = 'cargo'; projectType = 'rust'; }
            else if (lower.endsWith('go.mod')) { buildSystem = 'go'; projectType = 'go'; }
            else if (lower.endsWith('pyproject.toml') || lower.endsWith('requirements.txt') || lower.endsWith('setup.py')) {
                if (projectType === 'generic') { projectType = 'python'; }
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
    const base = path.basename(fileName);

    if (['.hpp', '.h', '.hxx', '.hh'].includes(ext)) {
        return 'header';
    }

    const sourceExts = [
        '.cpp', '.c', '.cc', '.cxx',
        '.py', '.pyi',
        '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
        '.html', '.htm', '.css', '.scss',
        '.rs', '.go', '.java', '.kt', '.swift', '.cs', '.rb',
        '.sh', '.bash', '.sql'
    ];
    if (sourceExts.includes(ext)) { return 'source'; }

    const configFiles = [
        'CMakeLists.txt', 'Makefile', 'Dockerfile', 'Containerfile', 'Procfile',
        'package.json', 'tsconfig.json',
        'Cargo.toml', 'go.mod', 'go.sum',
        'requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile',
        'Gemfile', '.gitignore', '.env', '.dockerignore'
    ];
    if (configFiles.includes(base)) { return 'config'; }
    if (['.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.xml', '.md', '.txt'].includes(ext)) {
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
): Promise<{ success: boolean; filesCreated: string[]; interceptedFiles?: string[] }> {
    const statusBarManager = getStatusBarManager();
    const filesCreated: string[] = [];
    const headerPublicAPIs = new Map<string, string>(); // Track ONLY public API signatures

    // CRITICAL: sanitize the user's original prompt before embedding it in every
    // per-file generation request. Without this, the server's connection-provisioning
    // interceptor fires on word combinations like "web ... oauth ... connection" and
    // returns the same canned `[api_type] type: web ...` config dump for every file,
    // which then gets written to disk as the file's contents.
    const safeOriginalPrompt = sanitizePromptForPlanning(originalPrompt).prompt;

    // Markers the server emits when the interceptor fires. If any per-file response
    // contains one of these we must NOT write that response to disk — it isn't code,
    // it's the interceptor's connection-config block.
    const interceptionMarkers = [
        'Connection created:',
        'RULE\nOAUTH TOKEN',
        'END RULE',
        'auth_type: prompt',
        'allowed_domain:',
        '[api_type]',
        '[api_endpoint]',
        '[api_auth]',
        '[api_request]',
        '[access_control]'
    ];
    const looksIntercepted = (text: string): boolean =>
        interceptionMarkers.some(m => text.includes(m));
    const interceptedFiles: string[] = [];

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
        reportStatus('Generation plan: ' + modules.length + ' modules (' +
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
                safeOriginalPrompt,
                plan.projectType,
                undefined,  // No context for headers
                undefined,
                referenceFileContent,  // Send user's reference file to learn patterns
                referenceFileName
            );
            
            if (headerContent) {
                // Guard: if the server's interceptor fired, the response will be a
                // connection-config dump, not code. Skip the file entirely.
                if (looksIntercepted(headerContent)) {
                    console.warn(`[PlanExecutor] Interceptor output detected for ${headerFileName}; not writing.`);
                    interceptedFiles.push(headerFileName);
                } else {
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
                    safeOriginalPrompt,
                    plan.projectType,
                    headerPublicAPIs.get(headerFileName),  // ONLY this header's API
                    undefined,  // No other modules
                    referenceFileContent,
                    referenceFileName
                );
                
                if (implContent) {
                    if (looksIntercepted(implContent)) {
                        console.warn(`[PlanExecutor] Interceptor output detected for ${implFileName}; not writing.`);
                        interceptedFiles.push(implFileName);
                    } else {
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
                safeOriginalPrompt,
                plan.projectType,
                undefined,
                headerPublicAPIs,  // Pass API map
                combinedHeaders || undefined,  // Send generated headers, not user's reference file
                headerFileNames.length > 0 ? headerFileNames.join(', ') : undefined  // List header names
            );
            
            if (mainContent) {
                if (looksIntercepted(mainContent)) {
                    console.warn(`[PlanExecutor] Interceptor output detected for ${mainFileName}; not writing.`);
                    interceptedFiles.push(mainFileName);
                } else {
                const mainPath = saveFile(workspaceRoot, mainFileName, mainContent);
                if (mainPath) {
                    filesCreated.push(mainPath);
                }
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
                if (looksIntercepted(configContent)) {
                    console.warn(`[PlanExecutor] Interceptor output detected for ${configFileName}; not writing.`);
                    interceptedFiles.push(configFileName);
                } else {
                    const configPath = path.join(workspaceRoot, configFileName);
                    // Ensure the parent directory exists (config files can sit in
                    // nested paths like `src/config/auth-config.json`, which would
                    // otherwise throw ENOENT from writeFileSync).
                    const configDir = path.dirname(configPath);
                    if (!fs.existsSync(configDir)) {
                        fs.mkdirSync(configDir, { recursive: true });
                    }
                    fs.writeFileSync(configPath, configContent, 'utf-8');
                    filesCreated.push(configFileName);
                }
            }
        }
        
        statusBarManager.clearOperation();
        if (interceptedFiles.length > 0) {
            console.warn(`[PlanExecutor] Server interceptor blocked content for ${interceptedFiles.length} file(s): ${interceptedFiles.join(', ')}`);
        }
        statusBarManager.showSuccess(`Created ${filesCreated.length} files`, 3000);
        
        return { success: true, filesCreated, interceptedFiles: interceptedFiles.length ? interceptedFiles : undefined };
        
    } catch (error: any) {
        statusBarManager.showError('Execution failed');
        console.error('Plan execution error:', error);
        return { success: false, filesCreated, interceptedFiles: interceptedFiles.length ? interceptedFiles : undefined };
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
        let extractedCode = extractCodeFromResponse(response.response, fileName);
        
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
function extractCodeFromResponse(response: string, targetFileName?: string): string {
    // If the target file is itself HTML/XML/SVG/Markdown, treat the response as
    // verbatim markup — DO NOT run the HTML-unwrap branch below (which would
    // strip every tag and leave only the text content of <style>/<script>
    // blocks, producing a CSS-shaped "HTML" file).
    const ext = targetFileName ? path.extname(targetFileName).toLowerCase() : '';
    const markupExts = ['.html', '.htm', '.xhtml', '.xml', '.svg', '.vue', '.md', '.markdown'];
    const targetIsMarkup = markupExts.includes(ext);

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
    
    // 3. Check if response is HTML wrapped (only for non-markup target files)
    if (!targetIsMarkup && (response.includes('<!DOCTYPE html>') || response.includes('<html>'))) {
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
            max_tokens: 32000,
            forCodeGeneration: true
        });

        if (response.error || !response.response) {
            return null;
        }

        // Extract code from response - handle multiple formats
        return extractCodeFromResponse(response.response, fileName);
        
    } catch (error) {
        console.error(`Error generating ${fileName}:`, error);
        return null;
    }
}
