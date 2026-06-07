/**
 * Code Search - Intelligent file and content discovery
 * Helps find relevant code locations before modifications
 */

import * as vscode from 'vscode';
import * as path from 'path';

export interface SearchResult {
    file: string;
    relativePath: string;
    matches: SearchMatch[];
    score: number;
}

export interface SearchMatch {
    line: number;
    text: string;
    context: string;  // Surrounding lines for context
}

export interface SearchContext {
    results: SearchResult[];
    totalMatches: number;
    searchTerms: string[];
    fileContents: Map<string, string>;  // Full content of top matches
}

export class CodeSearch {
    private workspaceRoot: string | undefined;
    private readonly MAX_RESULTS = 10;
    private readonly MAX_FILES_TO_READ = 5;

    constructor() {
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    /**
     * Perform intelligent search to find relevant code locations
     * Combines filename search and content search
     */
    async searchForContext(userRequest: string): Promise<SearchContext> {
        console.log('[CodeSearch] Searching for context:', userRequest);
        
        if (!this.workspaceRoot) {
            console.log('[CodeSearch] No workspace root');
            return this.createEmptyContext();
        }

        // Extract keywords from user request
        const keywords = this.extractKeywords(userRequest);
        console.log('[CodeSearch] Extracted keywords:', keywords);

        // Search by filename first (fast)
        const filenameResults = await this.searchFilesByName(keywords);
        console.log('[CodeSearch] Found', filenameResults.length, 'files by name');

        // Search by content (slower but more thorough)
        const contentResults = await this.searchFilesByContent(keywords);
        console.log('[CodeSearch] Found', contentResults.length, 'content matches');

        // Merge and rank results
        const allResults = this.mergeAndRankResults(filenameResults, contentResults);
        console.log('[CodeSearch] Total ranked results:', allResults.length);

        // Read top N files completely for context
        const fileContents = await this.readTopFiles(allResults);

        return {
            results: allResults.slice(0, this.MAX_RESULTS),
            totalMatches: allResults.length,
            searchTerms: keywords,
            fileContents
        };
    }

    /**
     * Extract meaningful keywords from user request
     * Filters out common words, focuses on technical terms
     */
    private extractKeywords(request: string): string[] {
        // Remove common words
        const stopWords = new Set([
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
            'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'be', 'been',
            'add', 'create', 'make', 'implement', 'write', 'build', 'need', 'want',
            'should', 'could', 'would', 'can', 'will', 'does', 'do', 'did',
            'this', 'that', 'these', 'those', 'it', 'its', 'my', 'our', 'your',
            'project', 'code', 'file', 'function', 'system'
        ]);

        // Extract words, filter stop words, keep technical terms
        const words = request
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !stopWords.has(w));

        // Remove duplicates
        return [...new Set(words)];
    }

    /**
     * Search for files matching keywords in filename
     */
    private async searchFilesByName(keywords: string[]): Promise<SearchResult[]> {
        if (keywords.length === 0) {
            return [];
        }

        const results: SearchResult[] = [];

        try {
            // Search for source files
            const patterns = [
                '**/*.{cpp,c,cc,cxx,h,hpp,hxx}',
                '**/*.{ts,js,tsx,jsx}',
                '**/*.{py,java,rs,go,cs}'
            ];

            for (const pattern of patterns) {
                const files = await vscode.workspace.findFiles(
                    pattern,
                    '**/node_modules/**'
                );

                for (const file of files) {
                    const filename = path.basename(file.fsPath).toLowerCase();
                    const relativePath = vscode.workspace.asRelativePath(file.fsPath);
                    
                    // Score based on keyword matches in filename
                    let score = 0;
                    for (const keyword of keywords) {
                        if (filename.includes(keyword)) {
                            score += 10;  // High score for filename match
                        }
                        if (relativePath.toLowerCase().includes(keyword)) {
                            score += 5;   // Medium score for path match
                        }
                    }

                    if (score > 0) {
                        results.push({
                            file: file.fsPath,
                            relativePath,
                            matches: [],  // Filename matches don't have line matches
                            score
                        });
                    }
                }
            }
        } catch (error) {
            console.error('[CodeSearch] Error searching files by name:', error);
        }

        return results;
    }

    /**
     * Search for keywords in file contents
     * Uses simple grep-like search by reading files
     */
    private async searchFilesByContent(keywords: string[]): Promise<SearchResult[]> {
        if (keywords.length === 0) {
            return [];
        }

        const results: SearchResult[] = [];
        const fileMatches = new Map<string, SearchMatch[]>();

        try {
            // Get all source files
            const patterns = [
                '**/*.{cpp,c,cc,cxx,h,hpp,hxx}',
                '**/*.{ts,js,tsx,jsx}',
                '**/*.{py,java,rs,go,cs}'
            ];

            for (const pattern of patterns) {
                const files = await vscode.workspace.findFiles(
                    pattern,
                    '**/node_modules/**',
                    100  // Limit to 100 files for performance
                );

                // Search each file for keywords
                for (const fileUri of files) {
                    try {
                        const document = await vscode.workspace.openTextDocument(fileUri);
                        const content = document.getText();
                        const lines = content.split('\n');
                        
                        // Skip files larger than 100KB
                        if (content.length > 100000) {
                            continue;
                        }

                        const matches: SearchMatch[] = [];

                        // Search for each keyword in content
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            const lowerLine = line.toLowerCase();

                            for (const keyword of keywords) {
                                if (lowerLine.includes(keyword.toLowerCase())) {
                                    // Get context (line before and after)
                                    const contextStart = Math.max(0, i - 1);
                                    const contextEnd = Math.min(lines.length - 1, i + 1);
                                    const contextLines = lines.slice(contextStart, contextEnd + 1);

                                    matches.push({
                                        line: i + 1,  // 1-indexed
                                        text: line.trim(),
                                        context: contextLines.join('\n')
                                    });

                                    // Only keep first few matches per keyword per file
                                    if (matches.length >= 5) {
                                        break;
                                    }
                                }
                            }

                            if (matches.length >= 5) {
                                break;
                            }
                        }

                        if (matches.length > 0) {
                            const filePath = fileUri.fsPath;
                            if (!fileMatches.has(filePath)) {
                                fileMatches.set(filePath, []);
                            }
                            fileMatches.get(filePath)!.push(...matches);
                        }

                    } catch (error) {
                        // Skip files that can't be read
                        continue;
                    }
                }
            }

            // Convert map to results array with scores
            for (const [filePath, matches] of fileMatches) {
                const relativePath = vscode.workspace.asRelativePath(filePath);
                
                // Score based on number of matches
                const score = matches.length * 3;  // Medium score per content match

                results.push({
                    file: filePath,
                    relativePath,
                    matches: matches.slice(0, 5),  // Keep top 5 matches per file
                    score
                });
            }

        } catch (error) {
            console.error('[CodeSearch] Error searching files by content:', error);
        }

        return results;
    }

    /**
     * Merge filename and content results, sort by score
     */
    private mergeAndRankResults(
        filenameResults: SearchResult[],
        contentResults: SearchResult[]
    ): SearchResult[] {
        const mergedMap = new Map<string, SearchResult>();

        // Add filename results
        for (const result of filenameResults) {
            mergedMap.set(result.file, result);
        }

        // Add or merge content results
        for (const result of contentResults) {
            const existing = mergedMap.get(result.file);
            if (existing) {
                // Merge: combine scores and matches
                existing.score += result.score;
                existing.matches.push(...result.matches);
            } else {
                mergedMap.set(result.file, result);
            }
        }

        // Sort by score (highest first)
        return Array.from(mergedMap.values())
            .sort((a, b) => b.score - a.score);
    }

    /**
     * Read full content of top N files for context
     */
    private async readTopFiles(results: SearchResult[]): Promise<Map<string, string>> {
        const fileContents = new Map<string, string>();
        const topFiles = results.slice(0, this.MAX_FILES_TO_READ);

        for (const result of topFiles) {
            try {
                const document = await vscode.workspace.openTextDocument(result.file);
                const content = document.getText();
                
                // Only include reasonably sized files (< 100KB)
                if (content.length < 100000) {
                    fileContents.set(result.relativePath, content);
                    console.log(`[CodeSearch] Read file: ${result.relativePath} (${content.length} bytes)`);
                } else {
                    console.log(`[CodeSearch] Skipped large file: ${result.relativePath} (${content.length} bytes)`);
                }
            } catch (error) {
                console.error(`[CodeSearch] Error reading file ${result.file}:`, error);
            }
        }

        return fileContents;
    }

    /**
     * Create empty context when no results found
     */
    private createEmptyContext(): SearchContext {
        return {
            results: [],
            totalMatches: 0,
            searchTerms: [],
            fileContents: new Map()
        };
    }

    /**
     * Format search results for display to user
     */
    static formatResultsSummary(context: SearchContext): string {
        if (context.results.length === 0) {
            return '🔍 No relevant files found in project.';
        }

        const lines = [
            `🔍 **Found ${context.results.length} relevant files:**\n`
        ];

        for (const result of context.results.slice(0, 5)) {
            lines.push(`- **${result.relativePath}** (score: ${result.score})`);
            
            if (result.matches.length > 0) {
                const firstMatch = result.matches[0];
                lines.push(`  - Line ${firstMatch.line}: \`${firstMatch.text.trim()}\``);
            }
        }

        if (context.results.length > 5) {
            lines.push(`\n... and ${context.results.length - 5} more files`);
        }

        return lines.join('\n');
    }

    /**
     * Format search context for sending to Boudica
     */
    static formatContextForAI(context: SearchContext): string {
        const lines = [
            '[RELEVANT CODE CONTEXT]',
            `Search terms: ${context.searchTerms.join(', ')}`,
            `Files analyzed: ${context.fileContents.size}`,
            ''
        ];

        // Add file contents
        for (const [filepath, content] of context.fileContents) {
            lines.push(`--- FILE: ${filepath} ---`);
            lines.push(content);
            lines.push('');
        }

        // Add match locations from other files
        for (const result of context.results.slice(context.fileContents.size, 10)) {
            if (result.matches.length > 0) {
                lines.push(`--- MATCHES IN: ${result.relativePath} ---`);
                for (const match of result.matches.slice(0, 3)) {
                    lines.push(`Line ${match.line}: ${match.text.trim()}`);
                }
                lines.push('');
            }
        }

        return lines.join('\n');
    }
}
