import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Session interaction entry
 */
export interface SessionInteraction {
    timestamp: string;
    source: 'native' | 'sidebar';
    user: string;
    assistant: string;
    files: string[];
}

/**
 * Daily session file structure
 */
interface SessionFile {
    date: string;
    interactions: SessionInteraction[];
}

/**
 * Manages daily session storage with 10-day retention
 */
export class SessionManager {
    private sessionsDir: string;
    private currentDate: string;
    private currentSession: SessionFile | null = null;

    constructor(private context: vscode.ExtensionContext) {
        // Store in extension's global storage
        this.sessionsDir = path.join(context.globalStorageUri.fsPath, 'sessions');
        this.currentDate = this.getDateString(new Date());
        this.ensureSessionsDirectory();
        this.cleanupOldSessions();
    }

    /**
     * Ensure sessions directory exists
     */
    private ensureSessionsDirectory(): void {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    /**
     * Get date string in YYYY-MM-DD format
     */
    private getDateString(date: Date): string {
        return date.toISOString().split('T')[0];
    }

    /**
     * Get session file path for a specific date
     */
    private getSessionPath(dateString: string): string {
        return path.join(this.sessionsDir, `session-${dateString}.json`);
    }

    /**
     * Load session file for a specific date
     */
    private loadSession(dateString: string): SessionFile | null {
        const sessionPath = this.getSessionPath(dateString);
        
        if (!fs.existsSync(sessionPath)) {
            return null;
        }

        try {
            const data = fs.readFileSync(sessionPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error(`[SessionManager] Error loading session ${dateString}:`, error);
            return null;
        }
    }

    /**
     * Save session file
     */
    private saveSession(session: SessionFile): void {
        const sessionPath = this.getSessionPath(session.date);
        
        try {
            fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
        } catch (error) {
            console.error(`[SessionManager] Error saving session ${session.date}:`, error);
        }
    }

    /**
     * Get or create today's session
     */
    private getTodaySession(): SessionFile {
        const today = this.getDateString(new Date());
        
        // Check if date changed
        if (today !== this.currentDate) {
            this.currentDate = today;
            this.currentSession = null;
        }

        // Load from cache if available
        if (this.currentSession && this.currentSession.date === today) {
            return this.currentSession;
        }

        // Try to load from disk
        let session = this.loadSession(today);
        
        // Create new if doesn't exist
        if (!session) {
            session = {
                date: today,
                interactions: []
            };
        }

        this.currentSession = session;
        return session;
    }

    /**
     * Log an interaction to today's session
     */
    public logInteraction(
        source: 'native' | 'sidebar',
        userPrompt: string,
        assistantResponse: string,
        files: string[] = []
    ): void {
        const session = this.getTodaySession();
        
        session.interactions.push({
            timestamp: new Date().toISOString(),
            source,
            user: userPrompt,
            assistant: assistantResponse,
            files
        });

        this.saveSession(session);
    }

    /**
     * Search sessions for a query
     * Returns interactions matching the query with session date and index
     */
    public searchSessions(
        query: string,
        daysBack: number = 10
    ): Array<{ date: string; index: number; interaction: SessionInteraction; score: number }> {
        const results: Array<{ date: string; index: number; interaction: SessionInteraction; score: number }> = [];
        const today = new Date();
        const lowerQuery = query.toLowerCase();

        // Search through last N days
        for (let i = 0; i < daysBack; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateString = this.getDateString(date);
            
            const session = this.loadSession(dateString);
            if (!session) continue;

            // Search each interaction
            session.interactions.forEach((interaction, index) => {
                const userLower = interaction.user.toLowerCase();
                const assistantLower = interaction.assistant.toLowerCase();
                
                // Calculate relevance score
                let score = 0;
                if (userLower.includes(lowerQuery)) score += 10;
                if (assistantLower.includes(lowerQuery)) score += 5;
                
                // Bonus for exact phrase match
                if (userLower.includes(lowerQuery) || assistantLower.includes(lowerQuery)) {
                    score += 5;
                }

                // Bonus for recent interactions
                score += (daysBack - i);

                if (score > 0) {
                    results.push({
                        date: dateString,
                        index: index + 1, // 1-indexed for display
                        interaction,
                        score
                    });
                }
            });
        }

        // Sort by score (highest first)
        results.sort((a, b) => b.score - a.score);
        
        return results;
    }

    /**
     * Get all interactions from a specific date
     */
    public getSessionByDate(dateString: string): SessionInteraction[] {
        const session = this.loadSession(dateString);
        return session ? session.interactions : [];
    }

    /**
     * Get yesterday's date string
     */
    public getYesterdayDate(): string {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        return this.getDateString(yesterday);
    }

    /**
     * Get today's date string
     */
    public getTodayDate(): string {
        return this.getDateString(new Date());
    }

    /**
     * Clean up sessions older than 10 days
     */
    private cleanupOldSessions(): void {
        try {
            const files = fs.readdirSync(this.sessionsDir);
            const today = new Date();
            const cutoffDate = new Date(today);
            cutoffDate.setDate(cutoffDate.getDate() - 10);
            const cutoffString = this.getDateString(cutoffDate);

            files.forEach(file => {
                if (file.startsWith('session-') && file.endsWith('.json')) {
                    const dateString = file.replace('session-', '').replace('.json', '');
                    
                    // Delete if older than 10 days
                    if (dateString < cutoffString) {
                        const filePath = path.join(this.sessionsDir, file);
                        fs.unlinkSync(filePath);
                        console.log(`[SessionManager] Cleaned up old session: ${dateString}`);
                    }
                }
            });
        } catch (error) {
            console.error('[SessionManager] Error during cleanup:', error);
        }
    }

    /**
     * Check if a prompt is requesting session search
     */
    public static isSessionSearchRequest(prompt: string): boolean {
        const lower = prompt.toLowerCase();
        return /(find|search|look|show|what did we).*(?:in |from |about )?(?:session|today|yesterday|last week|discussed|talked about)/.test(lower) ||
               /(?:session|today|yesterday).*(?:find|search|show)/.test(lower);
    }

    /**
     * Detect which session(s) to search
     */
    public static getSearchScope(prompt: string): 'today' | 'yesterday' | 'all' {
        const lower = prompt.toLowerCase();
        if (/today|today's/.test(lower)) return 'today';
        if (/yesterday|yesterday's/.test(lower)) return 'yesterday';
        return 'all';
    }

    /**
     * Extract search query from prompt
     */
    public static extractSearchQuery(prompt: string): string {
        // Remove common search phrases to get the actual query
        let query = prompt.toLowerCase();
        query = query.replace(/(find|search|look|show|what did we).*(?:in |from |about )?(?:session|today|yesterday|discussed|talked about)/gi, '');
        query = query.replace(/(?:session|today|yesterday).*(?:find|search|show)/gi, '');
        query = query.trim();
        
        // If empty, use original prompt
        if (query.length === 0) {
            query = prompt;
        }
        
        return query;
    }
}
