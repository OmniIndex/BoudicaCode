/**
 * Boudica API Client
 * Handles communication with Boudica CGI endpoints
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as vscode from 'vscode';
import FormData = require('form-data');
import * as fs from 'fs';
import { reportStatus } from './statusReporter';

export interface BoudicaConfig {
    apiEndpoint: string;
    apiKey?: string;
    userId?: string;
    useRag?: boolean;
    temperature?: number;
    maxTokens?: number;
}

export interface ChatRequest {
    message: string;
    session_id?: string;
    user_id?: string;
    temperature?: number;
    max_tokens?: number;
    use_rag?: boolean;
    stream?: boolean;
    file_content?: string;  // File content to send as document_0
    file_name?: string;     // File name to send as filename_0
    lora_adapter?: string;
    request_domain?: string;
    forCodeGeneration?: boolean;  // Add code generation directives to prompt
    skipClean?: boolean;          // Skip cleanResponse (use for structured responses like fix plans)
    rawMessage?: boolean;         // Bypass prepareMessage entirely — send `message` verbatim
}

export interface ChatResponse {
    response?: string;
    error?: string;
    tokens_per_second?: number;
    session_id?: string;
}

export interface GenerateRequest {
    prompt: string;
    temperature?: number;
    max_tokens?: number;
}

export interface HealthResponse {
    status: string;
    models?: string[];
    uptime?: number;
}

export class BoudicaClient {
    private client: AxiosInstance;
    private config: BoudicaConfig;

    constructor(config: BoudicaConfig) {
        this.config = config;
        console.log('BoudicaClient: Initializing with endpoint:', config.apiEndpoint);
        this.client = axios.create({
            baseURL: config.apiEndpoint,
            timeout: 300000, // 5 minutes for code generation with large file attachments
            headers: {
                'Content-Type': 'application/json',
            }
        });

        // Add API key as Bearer token if provided (Boudica expects Authorization: Bearer)
        if (config.apiKey) {
            console.log('BoudicaClient: API Key configured (length:', config.apiKey.length, ')');
            this.client.defaults.headers.common['Authorization'] = `Bearer ${config.apiKey}`;
        } else {
            console.log('BoudicaClient: No API Key configured');
        }
    }

    /**
     * Prepend directives to control Boudica's output format
     * EXACT format that works in web UI
     */
    private prepareMessage(message: string, forCodeGeneration: boolean = false, rawMessage: boolean = false): string {
        if (rawMessage) {
            return message;
        }
        if (forCodeGeneration) {
            return `FORMAT: EXECUTABLE_SOURCE_CODE

CRITICAL: Output pure executable source code only.
- Write code that runs directly when saved to a file
- Use only valid language syntax (no markup, no tags, no styling)
- Include necessary imports/headers exactly as: #include <header>
- Code blocks in triple backticks are acceptable if content is runnable

No Memory\n${message}`;
        } else {
            return `No Memory\n${message}`;
        }
    }

    /**
     * Remove warning boilerplate and HTML formatting from Boudica responses
     * CRITICAL: Preserve C++ #include <header> statements
     */
    private cleanResponse(response: string): string {
        // Remove the warning boilerplate
        const boilerplate = /We try hard to provide only accurate responses[\s\S]*?Your feedback helps the system to improve!/gi;
        let cleaned = response.replace(boilerplate, '').trim();
        
        // Remove markdown code fences at the start (```cpp, ```javascript, etc.)
        cleaned = cleaned.replace(/^```[\w]*\s*\n/gm, '');
        
        // Remove closing markdown code fence and ONLY the trailing boilerplate/disclaimer after it.
        // Use the LAST occurrence of a closing fence so multi-block responses are preserved.
        // Strategy: find last \n``` boundary; only strip if remainder looks like a footer/disclaimer.
        const lastFenceIdx = cleaned.lastIndexOf('\n```');
        if (lastFenceIdx !== -1) {
            const afterFence = cleaned.slice(lastFenceIdx + 4); // text after the closing fence
            // Strip only if nothing meaningful follows (empty, ---, or boilerplate)
            if (afterFence.trim().length === 0 ||
                /^\s*---/.test(afterFence) ||
                /created with boudica/i.test(afterFence) ||
                /your feedback helps/i.test(afterFence)) {
                cleaned = cleaned.slice(0, lastFenceIdx);
            }
        }
        
        // Remove HTML comments (<!-- comment -->)
        cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');
        
        // Remove Doxygen-style boilerplate ONLY if it looks like AI-generated scaffolding
        // (starts at column 0 and only contains @-tags / brief text, no real code)
        // We do NOT strip /** ... */ that are part of real source code.
        cleaned = cleaned.replace(/^\s*\/\*\*\s*\n(?:\s*\*\s*@[a-z]+[^\n]*\n)*\s*\*\//gm, '');
        
        // Remove HTML/XML style tags and their content (often used for code display styling)
        cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, '');
        cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, '');
        
        // CRITICAL: Protect C++ #include statements FIRST before removing HTML tags
        // Replace #include <header> with a placeholder to prevent angle bracket removal
        const includeProtector: Map<string, string> = new Map();
        let protectorIndex = 0;
        cleaned = cleaned.replace(/#include\s*<([^>]+)>/g, (match, header) => {
            const placeholder = `___INCLUDE_PROTECTED_${protectorIndex}___`;
            includeProtector.set(placeholder, `#include <${header}>`);
            protectorIndex++;
            return placeholder;
        });
        
        // NOW remove HTML wrapper tags (after includes are protected)
        cleaned = cleaned.replace(/<\/?(?:html|body|head|div|span|pre|code|p|br|hr|h1|h2|h3|h4|h5|h6|ul|li|ol|table|tr|td|th|thead|tbody|footer|header)(?:\s[^>]*)?>/gi, '');
        
        // Remove any remaining HTML tags (catch-all)
        cleaned = cleaned.replace(/<[^>]+>/g, '');
        
        // Restore protected #include statements
        includeProtector.forEach((original, placeholder) => {
            cleaned = cleaned.replace(placeholder, original);
        });
        
        // Remove HTML character entities
        cleaned = cleaned.replace(/&nbsp;/g, ' ');
        cleaned = cleaned.replace(/&lt;/g, '<');
        cleaned = cleaned.replace(/&gt;/g, '>');
        cleaned = cleaned.replace(/&amp;/g, '&');
        cleaned = cleaned.replace(/&quot;/g, '"');
        cleaned = cleaned.replace(/&#39;/g, "'");
        
        // Clean up excessive whitespace
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
        
        // Remove standalone HTML-like titles/headers at the start
        // Matches: "Color Output Header", "Boudica Torc - CGI Client Header", etc.
        cleaned = cleaned.replace(/^[A-Z][A-Za-z\s\-\.]+Header\s*\n+/gmi, '');
        cleaned = cleaned.replace(/^[A-Z][A-Za-z\s\-\.]+\s*\n+(?=(?:#|\/\/|\/\*|cmake|package|{|\[))/gm, '');
        
        // Remove "Created with Boudica Torc" footer and trailing separators
        cleaned = cleaned.replace(/\s*Created with Boudica Torc\.?\s*/gi, '');
        cleaned = cleaned.replace(/\s*---\s*$/g, '');
        
        // Remove chat/conversational artifacts that shouldn't be in code
        cleaned = cleaned.replace(/\*\(Response truncated:.*?\)\*/gi, '');
        cleaned = cleaned.replace(/\(Response truncated:.*?\)/gi, '');
        cleaned = cleaned.replace(/\*\*Response truncated\*\*.*$/gmi, '');
        
        return cleaned.trim();
    }

    /**
     * Send a chat message to Boudica
     * If file_content is provided, sends as multipart/form-data with file attachment
     */
    async chat(request: ChatRequest): Promise<ChatResponse> {
        try {
            console.log('BoudicaClient: Sending chat request to:', this.config.apiEndpoint);
            console.log('BoudicaClient: API Key configured:', this.config.apiKey ? 'Yes' : 'No');
            
            // Prepend "No Memory" to disable inference memory (and code directives if requested)
            const preparedMessage = this.prepareMessage(request.message, request.forCodeGeneration || false, request.rawMessage || false);
            
            // Code generation uses server context limit: 32k
            const effectiveMaxTokens = request.max_tokens ?? 
                                      (this.config.maxTokens ?? 32000);
            
            // If file content provided, send as FormData with file attachment
            if (request.file_content && request.file_name) {
                console.log('BoudicaClient: Sending with file attachment:', request.file_name);
                const formData = new FormData();
                formData.append('message', preparedMessage);
                formData.append('session_id', request.session_id || 'vscode-extension');
                formData.append('user_id', request.user_id || this.config.userId || 'vscode-user');
                formData.append('temperature', String(request.temperature ?? this.config.temperature ?? 0.8));
                formData.append('max_tokens', String(effectiveMaxTokens));
                // CRITICAL: use_rag must be TRUE to disable list-guard (12-item truncation)
                // List-guard only triggers when rag_context.empty() - inference_server.cpp line 16093
                formData.append('use_rag', String(request.use_rag ?? this.config.useRag ?? true));
                formData.append('stream', String(request.stream ?? false));
                
                // Add file as document_0 (matches HTML interface pattern)
                const fileBuffer = Buffer.from(request.file_content, 'utf-8');
                formData.append('document_0', fileBuffer, {
                    filename: request.file_name,
                    contentType: 'text/plain'
                });
                formData.append('filename_0', request.file_name);
                formData.append('document_count', '1');

                if (request.lora_adapter) {
                    formData.append('lora_adapter', request.lora_adapter);
                }
                if (request.request_domain) {
                    formData.append('request_domain', request.request_domain);
                }

                const response: AxiosResponse<ChatResponse> = await this.client.post('/chat', formData, {
                    headers: {
                        ...formData.getHeaders(),
                        ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
                    }
                });
                
                // DEBUG: Log response before cleaning
                if (response.data.response && request.forCodeGeneration) {
                    console.log('[DEBUG] Response from server (FormData) - length:', response.data.response.length, 'chars');
                }
                
                // CRITICAL: Do NOT clean code generation responses - cleanResponse destroys code!
                // For code generation or structured responses (fix plans), return raw response from server
                if (request.forCodeGeneration || request.skipClean) {
                    return response.data;
                }
                
                // Clean response before returning (only for non-code chat)
                if (response.data.response) {
                    const originalLength = response.data.response.length;
                    response.data.response = this.cleanResponse(response.data.response);
                    
                    // DEBUG: Log if cleanResponse changed the length
                    if (originalLength !== response.data.response.length) {
                        console.log('[DEBUG] cleanResponse changed length (FormData):', originalLength, '→', response.data.response.length);
                    }
                }
                return response.data;
            } else {
                // Regular JSON request without files
                const payload = {
                    message: preparedMessage,
                    session_id: request.session_id || 'vscode-extension',
                    user_id: request.user_id || this.config.userId || 'vscode-user',
                    temperature: request.temperature ?? this.config.temperature ?? 0.8,
                    max_tokens: effectiveMaxTokens,
                    // CRITICAL: use_rag must be TRUE to disable list-guard (12-item truncation)
                    // List-guard only triggers when rag_context.empty() - inference_server.cpp line 16093
                    use_rag: request.use_rag ?? this.config.useRag ?? true,
                    stream: request.stream ?? false,
                    ...(request.lora_adapter && { lora_adapter: request.lora_adapter }),
                    ...(request.request_domain && { request_domain: request.request_domain })
                };

                // DEBUG: Log actual payload parameters for code generation
                if (request.forCodeGeneration) {
                    console.log('[DEBUG] Payload:', {
                        temperature: payload.temperature,
                        max_tokens: payload.max_tokens,
                        use_rag: payload.use_rag,
                        message_length: payload.message.length
                    });
                }

                const response: AxiosResponse<ChatResponse> = await this.client.post('/chat', payload);
                
                // DEBUG: Log response before cleaning
                if (response.data.response && request.forCodeGeneration) {
                    console.log('[DEBUG] Response from server - length:', response.data.response.length, 'chars');
                }
                
                // CRITICAL: Do NOT clean code generation responses - cleanResponse destroys code!
                // For code generation or structured responses (fix plans), return raw response from server
                if (request.forCodeGeneration || request.skipClean) {
                    return response.data;
                }
                
                // Clean response before returning (only for non-code chat)
                if (response.data.response) {
                    const originalLength = response.data.response.length;
                    response.data.response = this.cleanResponse(response.data.response);
                    
                    // DEBUG: Log if cleanResponse changed the length
                    if (originalLength !== response.data.response.length) {
                        console.log('[DEBUG] cleanResponse changed length:', originalLength, '→', response.data.response.length);
                    }
                }
                return response.data;
            }
        } catch (error: any) {
            console.error('BoudicaClient: Chat error:', error.message);
            console.error('BoudicaClient: Error code:', error.code);
            console.error('BoudicaClient: Full URL attempted:', this.client.defaults.baseURL);
            if (error.response) {
                console.error('BoudicaClient: Response status:', error.response.status);
                console.error('BoudicaClient: Response data:', error.response.data);
            }
            return {
                error: error.response?.data?.error || error.message || 'Failed to communicate with Boudica'
            };
        }
    }

    /**
     * Send a chat message with one or more file attachments via multipart/form-data.
     *
     * Each attachment may be either:
     *   • a path on disk (`path` set), which is streamed from the filesystem, or
     *   • in-memory content (`content` set as string or Buffer), which is uploaded
     *     directly without touching disk. Use this for content that has already
     *     been read + redacted (e.g. project source with secrets stripped).
     *
     * The server (`slm_cgi_handlers.cpp` → `parse_multipart`) keys files by the
     * `filename="..."` attribute on each part — the form field name itself
     * (`document_0`, `document_1`, …) is informational only. The server then
     * runs `TextExtractor::extract_from_file` on each upload and concatenates the
     * result into `document_context` as:
     *     Reference material from <filename>:
     *
     *     <contents>
     *
     * NOTE: The server sanitises filenames to `[A-Za-z0-9._\- ]` before saving
     * to `/tmp/boudica_uploads/`, so any `/` in a path will be stripped. Callers
     * that need to preserve a relative path should encode separators (e.g. `__`
     * for `/`) into the supplied `filename`.
     */
    async chatWithFiles(
        request: ChatRequest,
        files: Array<{ filename: string; path?: string; content?: string | Buffer }>
    ): Promise<ChatResponse> {
        try {
            // Prepend "No Memory" to disable inference memory (and code directives if requested)
            const preparedMessage = this.prepareMessage(request.message, request.forCodeGeneration || false, request.rawMessage || false);

            const formData = new FormData();

            // Add text fields (mirror the regular `chat()` JSON payload shape)
            formData.append('message', preparedMessage);
            formData.append('session_id', request.session_id || 'vscode-extension');
            formData.append('user_id', request.user_id || this.config.userId || 'vscode-user');
            formData.append('temperature', String(request.temperature ?? this.config.temperature ?? 0.8));
            formData.append('max_tokens', String(request.max_tokens ?? this.config.maxTokens ?? 32000));
            // CRITICAL: use_rag must be TRUE to disable list-guard (12-item truncation)
            formData.append('use_rag', String(request.use_rag ?? this.config.useRag ?? true));
            formData.append('stream', String(request.stream ?? false));

            if (request.lora_adapter) {
                formData.append('lora_adapter', request.lora_adapter);
            }
            if (request.request_domain) {
                formData.append('request_domain', request.request_domain);
            }

            // Add attachments. Use indexed field names to match the
            // `document_N` / `filename_N` convention used by the single-file
            // `chat()` path and the browser UI, even though the server only
            // looks at the `filename=` attribute.
            let attachedCount = 0;
            files.forEach((file, idx) => {
                let payload: Buffer | NodeJS.ReadableStream | undefined;

                if (file.content !== undefined) {
                    payload = Buffer.isBuffer(file.content)
                        ? file.content
                        : Buffer.from(file.content, 'utf-8');
                } else if (file.path && fs.existsSync(file.path)) {
                    payload = fs.createReadStream(file.path);
                } else {
                    console.warn('[BoudicaClient] chatWithFiles: skipping file (no content or readable path):', file.filename);
                    return;
                }

                formData.append(`document_${idx}`, payload, {
                    filename: file.filename,
                    contentType: 'text/plain'
                });
                formData.append(`filename_${idx}`, file.filename);
                attachedCount++;
            });
            formData.append('document_count', String(attachedCount));

            console.log(`[BoudicaClient] chatWithFiles: posting ${attachedCount} attachment(s), message length ${preparedMessage.length}`);
            reportStatus(`chatWithFiles: posting ${attachedCount} attachment(s), message length ${preparedMessage.length}`);

            const response: AxiosResponse<ChatResponse> = await this.client.post('/chat', formData, {
                headers: {
                    ...formData.getHeaders(),
                    ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            // Honour the same skipClean/forCodeGeneration semantics as `chat()`
            if (request.forCodeGeneration || request.skipClean) {
                return response.data;
            }
            if (response.data.response) {
                response.data.response = this.cleanResponse(response.data.response);
            }
            return response.data;
        } catch (error: any) {
            console.error('Boudica chat with files error:', error?.message || error);
            if (error?.response) {
                console.error('  status:', error.response.status, 'data:', error.response.data);
            }
            return {
                error: error?.response?.data?.error || error?.message || 'Failed to upload files to Boudica'
            };
        }
    }

    /**
     * Stream a chat response from Boudica, calling onChunk for each received token.
     * The server must support SSE (stream: true). Falls back to regular chat if the
     * server returns a non-streaming response or streaming is unsupported.
     */
    async chatStream(
        request: ChatRequest,
        onChunk: (text: string) => void,
        signal?: AbortSignal
    ): Promise<ChatResponse> {
        const preparedMessage = this.prepareMessage(request.message, request.forCodeGeneration || false, request.rawMessage || false);
        const effectiveMaxTokens = request.max_tokens ??
            (this.config.maxTokens ?? 32000);

        const payload = {
            message: preparedMessage,
            session_id: request.session_id || 'vscode-extension',
            user_id: request.user_id || this.config.userId || 'vscode-user',
            temperature: request.temperature ?? this.config.temperature ?? 0.8,
            max_tokens: effectiveMaxTokens,
            use_rag: request.use_rag ?? this.config.useRag ?? true,
            stream: true,
            ...(request.lora_adapter && { lora_adapter: request.lora_adapter }),
            ...(request.request_domain && { request_domain: request.request_domain })
        };

        try {
            const axiosConfig: any = { responseType: 'stream' };
            if (signal) {
                axiosConfig.signal = signal;
            }

            const response = await this.client.post('/chat', payload, axiosConfig);
            const stream = response.data as NodeJS.ReadableStream;

            let fullText = '';
            let sessionId = '';
            let tokensPerSecond: number | undefined;
            let buffer = '';

            return new Promise((resolve, reject) => {
                stream.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString('utf8');
                    // SSE lines are separated by double-newline: 'data: {...}\n\n'
                    const parts = buffer.split('\n\n');
                    buffer = parts.pop() ?? '';
                    for (const part of parts) {
                        const line = part.replace(/^data:\s*/m, '').trim();
                        if (!line || line === '[DONE]') { continue; }
                        try {
                            const parsed = JSON.parse(line);
                            const token: string = parsed.token ?? parsed.text ?? parsed.response ?? '';
                            if (token) { fullText += token; onChunk(token); }
                            if (parsed.session_id) { sessionId = parsed.session_id; }
                            if (parsed.tokens_per_second) { tokensPerSecond = parsed.tokens_per_second; }
                        } catch {
                            // Non-JSON chunk — treat as raw text
                            if (line.length > 0) { fullText += line; onChunk(line); }
                        }
                    }
                });

                stream.on('end', () => {
                    if (buffer.trim() && buffer.trim() !== '[DONE]') {
                        try {
                            const parsed = JSON.parse(buffer.replace(/^data:\s*/m, '').trim());
                            const token: string = parsed.token ?? parsed.text ?? parsed.response ?? '';
                            if (token) { fullText += token; onChunk(token); }
                        } catch { /* ignore partial buffer */ }
                    }
                    const shouldClean = !request.forCodeGeneration && !request.skipClean;
                    resolve({
                        response: shouldClean ? this.cleanResponse(fullText) : fullText,
                        session_id: sessionId || undefined,
                        tokens_per_second: tokensPerSecond
                    });
                });

                stream.on('error', (err: Error) => {
                    if (fullText.length > 0) {
                        const shouldClean = !request.forCodeGeneration && !request.skipClean;
                        resolve({ response: shouldClean ? this.cleanResponse(fullText) : fullText, session_id: sessionId || undefined });
                    } else {
                        reject(err);
                    }
                });
            });
        } catch (error: any) {
            if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
                return { error: 'Request cancelled' };
            }
            // Fall back to non-streaming
            console.warn('[BoudicaClient] Streaming failed, falling back to regular chat:', error.message);
            return this.chat({ ...request, stream: false });
        }
    }

    /**
     * Generate text without session context
     */
    async generate(request: GenerateRequest): Promise<ChatResponse> {
        try {
            // Prepend "No Memory" to disable inference memory
            const preparedMessage = this.prepareMessage(request.prompt, false);
            
            const payload = {
                prompt: preparedMessage,
                temperature: request.temperature ?? this.config.temperature ?? 0.8,
                max_tokens: request.max_tokens ?? this.config.maxTokens ?? 32000
            };

            const response: AxiosResponse<ChatResponse> = await this.client.post('/generate', payload);
            
            // Clean response before returning
            if (response.data.response) {
                response.data.response = this.cleanResponse(response.data.response);
            }
            return response.data;
        } catch (error: any) {
            console.error('Boudica generate error:', error);
            return {
                error: error.response?.data?.error || error.message || 'Failed to generate text'
            };
        }
    }

    /**
     * Check Boudica health status
     */
    async health(): Promise<HealthResponse> {
        try {
            const response: AxiosResponse<HealthResponse> = await this.client.get('/health');
            return response.data;
        } catch (error: any) {
            console.error('Boudica health check error:', error);
            return {
                status: 'error',
                error: error.message
            } as any;
        }
    }

    /**
     * List available models
     */
    async listModels(): Promise<string[]> {
        try {
            const response: AxiosResponse<{ models: string[] }> = await this.client.get('/models');
            return response.data.models || [];
        } catch (error: any) {
            console.error('Boudica list models error:', error);
            return [];
        }
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<BoudicaConfig>) {
        this.config = { ...this.config, ...config };
        
        if (config.apiEndpoint) {
            this.client.defaults.baseURL = config.apiEndpoint;
        }
        
        if (config.apiKey !== undefined) {
            if (config.apiKey) {
                this.client.defaults.headers.common['Authorization'] = `Bearer ${config.apiKey}`;
            } else {
                delete this.client.defaults.headers.common['Authorization'];
            }
        }
    }
}

/**
 * Get Boudica client instance from VSCode configuration
 */
export function getBoudicaClient(): BoudicaClient {
    const config = vscode.workspace.getConfiguration('boudicode');
    
    return new BoudicaClient({
        apiEndpoint: config.get('apiEndpoint', 'http://localhost/api/boudica'),
        apiKey: config.get('apiKey', ''),
        userId: config.get('userId', ''),
        useRag: config.get('useRag', true),
        temperature: config.get('temperature', 0.8),
        maxTokens: config.get('maxTokens', 32000)
    });
}
