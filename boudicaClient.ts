/**
 * Boudica API Client
 * Handles communication with Boudica CGI endpoints
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as vscode from 'vscode';
import FormData = require('form-data');
import * as fs from 'fs';

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
    private prepareMessage(message: string, forCodeGeneration: boolean = false): string {
        if (forCodeGeneration) {
            return `FORMAT: EXECUTABLE_SOURCE_CODE

CRITICAL: Output pure executable source code only.
- Write code that runs directly when saved to a file
- Use only valid language syntax (no markup, no tags, no styling)
- Include necessary imports/headers exactly as: #include <header>
- Code blocks in triple backticks are acceptable if content is runnable

No Memory ${message}`;
        } else {
            return `No Memory. No Rag ${message}`;
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
        
        // Remove closing markdown code fence and footer (```\n---\n[disclaimer])
        cleaned = cleaned.replace(/\n```\s*(?:\n---)?[\s\S]*$/g, '');
        
        // Remove HTML comments (<!-- comment -->)
        cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');
        
        // Remove Doxygen-style documentation comments (/** @brief ... */)
        // Match /** followed by anything including @tags, then */
        cleaned = cleaned.replace(/\/\*\*[\s\S]*?\*\//g, '');
        
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
            const preparedMessage = this.prepareMessage(request.message, request.forCodeGeneration || false);
            
            // Code generation uses server context limit: 32k
            const effectiveMaxTokens = request.max_tokens ?? 
                                      (request.forCodeGeneration ? 32000 : (this.config.maxTokens ?? 2000));
            
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
                // For code generation, return raw response from server
                if (request.forCodeGeneration) {
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
                // For code generation, return raw response from server
                if (request.forCodeGeneration) {
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
     * Send a chat message with file attachments
     */
    async chatWithFiles(request: ChatRequest, files: { path: string; filename: string }[]): Promise<ChatResponse> {
        try {
            // Prepend "No Memory" to disable inference memory (and code directives if requested)
            const preparedMessage = this.prepareMessage(request.message, request.forCodeGeneration || false);
            
            const formData = new FormData();
            
            // Add text fields
            formData.append('message', preparedMessage);
            formData.append('session_id', request.session_id || 'vscode-extension');
            formData.append('user_id', request.user_id || this.config.userId || 'vscode-user');
            formData.append('temperature', String(request.temperature ?? this.config.temperature ?? 0.8));
            formData.append('max_tokens', String(request.max_tokens ?? this.config.maxTokens ?? 2000));
            formData.append('use_rag', String(request.use_rag ?? this.config.useRag ?? true));
            formData.append('stream', String(request.stream ?? false));

            if (request.lora_adapter) {
                formData.append('lora_adapter', request.lora_adapter);
            }

            // Add files
            for (const file of files) {
                if (fs.existsSync(file.path)) {
                    formData.append('files', fs.createReadStream(file.path), {
                        filename: file.filename,
                        contentType: 'application/octet-stream'
                    });
                }
            }

            const response: AxiosResponse<ChatResponse> = await this.client.post('/chat', formData, {
                headers: {
                    ...formData.getHeaders(),
                    ...(this.config.apiKey && { 'X-API-Key': this.config.apiKey })
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            // Clean response before returning
            if (response.data.response) {
                response.data.response = this.cleanResponse(response.data.response);
            }
            return response.data;
        } catch (error: any) {
            console.error('Boudica chat with files error:', error);
            return {
                error: error.response?.data?.error || error.message || 'Failed to upload files to Boudica'
            };
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
                max_tokens: request.max_tokens ?? this.config.maxTokens ?? 2000
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
        
        if (config.apiKey) {
            this.client.defaults.headers.common['X-API-Key'] = config.apiKey;
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
        maxTokens: config.get('maxTokens', 2000)
    });
}
