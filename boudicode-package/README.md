# BoudiCode - AI-Powered Development Assistant

BoudiCode is a VS Code extension that integrates the Boudica AI system directly into your development workflow, providing intelligent code analysis, generation, augmentation, and **multi-file project management** with automatic build-fix capabilities.

## Key Features

✨ **Multi-File Project Awareness** - Understands entire codebase context and relationships  
🔨 **Build and Fix Workflow** - Automatically fixes compilation errors  
💾 **Automatic Backups** - Every change backed up with revert capability  
🎯 **Precise Code Insertion** - 9 intelligent insertion modes  
🤖 **Interactive AI Chat** - Natural conversation with file context  
🔍 **Code Analysis** - Security, performance, and quality scanning  
🏗️ **Project Creation** - Full scaffolding for multiple languages  
📦 **Application Generation** - APIs, models, services, and components  

## Features

### 🤖 Interactive Chat Interface
- **Sidebar chat panel** for natural conversation with Boudica
- **Automatic file context** inclusion from active editor
- **Code blocks automatically saved** to workspace with filenames
- **Smart filename detection** from prompts ("create main.js")
- Gold pulsing border animation while waiting for responses
- 90% width centered input with 3-row textarea

**✨ Intelligent Plan Mode (NEW!):**
When you request project creation (e.g., "Create a C++ application that downloads a web page and finds repeated words"), BoudiCode automatically:
1. 🎯 **Generates a plan** - Lists all files needed with descriptions
2. 💬 **Shows the plan** to you with message: "I have planned this application and will now start to create it"
3. 🔨 **Creates files step-by-step** - Generates each file individually with proper context
4. 🏗️ **Builds configuration** - Creates CMakeLists.txt, Makefile, package.json, etc.
5. ✅ **Reports completion** - Shows all created files

**Triggers**: "create a", "I want to create", "build an", "develop a" + project description (30+ chars)

### 🔍 Code Analysis with Inline Decorations & Problems Panel
- **Security Audit**: SQL injection, XSS, authentication issues, hardcoded secrets
- **Memory Leak Detection**: Unclosed resources, circular references, memory growth
- **Code Quality Review**: Code smells, complexity, maintainability issues
- **Performance Analysis**: N+1 queries, inefficient algorithms, blocking calls
- **Complete Analysis**: All-in-one comprehensive scan

**Visual Feedback:**
- ❌ **Red wavy underline** for critical/high severity errors
- ⚠️ **Orange wavy underline** for medium severity warnings
- ℹ️ **Blue underline** for informational issues
- 💡 **Green dashed border** for suggestions
- **Gutter icons** for quick severity identification
- **Hover tooltips** with detailed explanations and fix recommendations
- **Overview ruler** markers for easy navigation

**Problems Panel Integration:**
- Issues automatically appear in VS Code's native **Problems panel** (`Ctrl+Shift+M`)
- **Grouped by file** for easy navigation
- **Click to jump** to the exact line with the issue
- **Severity indicators**: Error, Warning, Information, Hint
- **Recommendations** shown as related information
- Use `boudicode.clearDecorations` to clear all issues

**Code Actions / Quick Fixes (💡 Lightbulb):**
When you click on an issue or place your cursor on a line with a problem, a **lightbulb icon** appears with these actions:
- 💡 **Apply Recommendation** - Shows the fix recommendation (copy to clipboard or open in chat)
- 🤖 **Get AI Fix Suggestion** - Generates specific code fixes using AI
- 📖 **Explain Issue** - Opens detailed explanation of why it's a problem and how to fix it
- 🚫 **Ignore This Issue** - Temporarily removes the diagnostic (reappears on next analysis)

Simply click the lightbulb or press `Ctrl+.` (or `Cmd+.` on Mac) to see available quick fixes!

### ✨ Multi-File Project Awareness (NEW!)
BoudiCode now understands your entire project context and maintains file relationships:

**Intelligent Project Scanning:**
- 📁 **Automatic discovery** of all source files, headers, configs, and build files
- 🔄 **Change detection** with 30-second caching and FileSystemWatcher invalidation
- 📊 **Project structure analysis** - understands dependencies, imports, and relationships
- ⚡ **Performance protection** - Projects with >100 files skip automatic scanning to maintain responsiveness
- 🎯 **Smart file search** - finds files by name, path, or relative path

**Smart Code Discovery (NEW!):**
When you request modifications like *"Add validation for user inputs"*, BoudiCode automatically:
1. 🔍 **Searches by filename** - Finds files with relevant names (e.g., "validator", "input", "user")
2. 🔎 **Searches by content** - Greps through code for related functions and patterns
3. 📊 **Ranks results** - Scores files based on relevance (filename matches weighted higher)
4. 📖 **Reads top matches** - Loads up to 5 most relevant files as context (max 100KB each)
5. 🎯 **Pinpoints locations** - Identifies exact functions, classes, and insertion points
6. 🤖 **AI-guided placement** - Boudica receives full context and suggests precise modifications

**Example workflow:**
- You: *"Add logging to the authentication system"*
- BoudiCode: 🔍 Searches → Finds `auth.cpp`, `login.hpp`, `user_manager.cpp`
- BoudiCode: 📖 Reads relevant files → Shows you: *"Found 3 relevant files: auth.cpp (score: 25), login.hpp (score: 15)..."*
- BoudiCode: 🤖 Asks Boudica with context → Generates plan: *"STEP 1: modify auth.cpp at authenticate_user_function..."*
- Result: Precise modifications in exactly the right places, even in large projects

**Multi-File Modifications:**
When you ask to add functionality, BoudiCode:
1. 🔍 **Scans entire project** to understand structure and patterns
2. 🧠 **Generates AI plan** showing which files need changes
3. 📝 **Modifies multiple files** with precise insertions
4. ✅ **Tracks changes** across all affected files
5. 🔗 **Maintains consistency** - keeps code style and patterns

**Example Request:**
```
Add user authentication with JWT tokens to this Express API
```
BoudiCode will:
- Modify routes to add authentication middleware
- Update controllers with auth logic
- Add new auth service file
- Update package.json with JWT dependencies
- Modify config files for secrets

### 🔨 Build and Fix Workflow (NEW!)
Automatically build projects and fix compilation errors:

**Supported Build Systems:**
- 🏗️ **CMake** - Detects CMakeLists.txt, runs cmake + make
- 📦 **Make** - Detects Makefile, runs make
- 📦 **npm** - Detects package.json, runs npm run build
- 🦀 **Cargo** - Detects Cargo.toml, runs cargo build
- 🐹 **Go** - Detects go.mod, runs go build

**Commands:**
- **BoudiCode: Build Project** - Runs appropriate build command
- **BoudiCode: Build and Fix Errors** - Builds, parses errors, generates fixes, applies them, rebuilds
- **BoudiCode: Clean Build Artifacts** - Cleans build directories

**Error Detection & Auto-Fix:**
Parses 11 types of errors:
- ❌ Undeclared identifiers
- 📦 Missing includes/imports
- 🔧 Undefined references
- 🎯 Type mismatches
- ⚠️ C++11/14/17 feature detection
- 💻 Syntax errors
- 🔨 Linker errors
- 📝 Comment syntax (-- vs //)
- And more...

**Fix Generation:**
- 🤖 **AI-powered** - Asks Boudica to generate precise fixes
- 📐 **Rule-based** - Detects common patterns (missing includes, wrong std version)
- ✏️ **Smart application** - Adds includes, updates CMakeLists.txt, fixes syntax
- 🔄 **Automatic rebuild** - Verifies fixes work

**Duplicate Detection:**
- Checks for existing content before appending
- Compares CMAKE_CXX_STANDARD values (skips if sufficient)
- Prevents redundant modifications

### 💾 Automatic Backup & Restore System (NEW!)
Every file modification is automatically backed up for safety:

**Automatic Backups:**
- 🕐 **Timestamped format** - `filename.ext.YYYY-MM-DD.HH-mm-ss`
- ✅ **Before every change** - Created automatically, no user action needed
- 🛡️ **Safety first** - Modifications abort if backup fails (critical changes)
- 📁 **Same directory** - Backups stored next to original files

**Restore Commands:**
- **BoudiCode: Revert File to Backup** - Shows list of all backups, restores selected version
- **BoudiCode: List File Backups** - View all backups with timestamps and sizes
- **BoudiCode: Cleanup Old Backups** - Keep N most recent, delete older ones

**Backup Features:**
- 📅 Sorted by timestamp (newest first)
- 💿 Shows file sizes
- 🔒 Double-safety - Creates backup of current state before restoring
- 🧹 Configurable retention - Keep 10 most recent by default

**Example Backup Names:**
```
main.cpp.2026-06-05.14-30-15
main.cpp.2026-06-05.14-25-08
main.cpp.2026-06-05.13-45-22
```

### 🎯 Precise Code Insertion (NEW!)
9 intelligent insertion modes for exact code placement:

**Insertion Modes:**
1. **BEFORE_FUNCTION** - Insert code before a specific function
2. **AFTER_FUNCTION** - Insert code after a function
3. **INSIDE_FUNCTION** - Insert code inside a function body
4. **BEFORE_CLASS** - Insert before a class definition
5. **INSIDE_CLASS** - Insert as class member
6. **BEFORE_LINE** - Insert before specific line number
7. **AFTER_LINE** - Insert after specific line number
8. **REPLACE** - Replace existing code
9. **APPEND** - Add to end of file

**Smart Insertion:**
- 🎯 **Context-aware** - Understands function names, class names, line numbers
- 📐 **Preserves formatting** - Maintains indentation and style
- ✅ **Validates syntax** - Ensures code is valid before insertion
- 🔍 **Finds targets** - Locates functions, classes, or lines automatically

### ✨ Code Augmentation
- Add new features to existing codebases with AI assistance
- Improve code quality with automated suggestions
- Generate comprehensive test suites
- Add documentation (JSDoc, docstrings, README sections)
- Custom code modifications based on natural language requests
- Files sent via multipart/form-data for accurate context
- **Multi-file modifications** with intelligent planning

### 🏗️ Project Creation with Full Scaffolding
Pre-configured templates with automatic initialization:

**Node.js/TypeScript:**
- Creates `package.json` with scripts and dependencies
- Runs `npm install` automatically
- Initializes `tsconfig.json` for TypeScript
- Includes Express dependencies for backend projects

**C++:**
- Generates `CMakeLists.txt` (C++17, warnings enabled)
- Creates `src/main.cpp` with basic structure
- Sets up `include/` and `build/` directories
- Runs `cmake .. && make` automatically

**Python:**
- Creates `requirements.txt` with Flask/Django dependencies
- Sets up virtual environment (`python3 -m venv venv`)
- Activates venv and installs packages

**Rust:** Runs `cargo init` for full project structure  
**Go:** Runs `go mod init` for module initialization

### 📦 Application Creation
- Generate REST API endpoints with routes, controllers, models
- Create database models with migrations
- Build service/business logic layers
- Create reusable UI components
- Generate CLI commands
- Create utility/helper modules
- Comprehensive test suite generation

All operations include context from existing workspace files for seamless integration.

## Installation

### Prerequisites
- Visual Studio Code 1.85.0 or higher
- Access to a Boudica inference server
- Node.js 18+ (for development)

### From Source

1. Clone or copy the extension to your machine:
```bash
cd /path/to/boudicode
```

2. Install dependencies:
```bash
npm install
```

3. Compile the TypeScript code:
```bash
npm run compile
```

4. Install the extension:
   - Press `F5` in VS Code to launch Extension Development Host, or
   - Package and install:
     ```bash
     npm install -g @vscode/vsce
     vsce package
     code --install-extension boudicode-1.0.0.vsix
     ```

## Configuration

Access settings via **File > Preferences > Settings** and search for "BoudiCode", or use the command **BoudiCode: Configure Connection**.

### Available Commands

Access via Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

**Project & Code Generation:**
- `BoudiCode: Create New Project` - Generate complete project with scaffolding
- `BoudiCode: Create Application` - Create API, model, service, or component
- `BoudiCode: Augment Code in Workspace` - Add features to existing project
- `BoudiCode: Open Chat` - Open interactive chat panel

**Code Analysis:**
- `BoudiCode: Analyze Code for Issues` - Security, quality, performance analysis
- `BoudiCode: Clear Decorations` - Remove all visual issue markers

**Build & Fix:**
- `BoudiCode: Build Project` - Run appropriate build command
- `BoudiCode: Build and Run` - Build project and execute the program
- `BoudiCode: Build and Fix Errors` - Auto-fix compilation errors
- `BoudiCode: Clean Build Artifacts` - Clean build directories

**Backup & Restore:**
- `BoudiCode: Revert File to Backup` - Restore file to previous version
- `BoudiCode: List File Backups` - View all backups with timestamps
- `BoudiCode: Cleanup Old Backups` - Delete old backup files

**Configuration:**
- `BoudiCode: Configure Connection` - Set API endpoint and credentials

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `boudicode.apiEndpoint` | Boudica API endpoint URL | `http://localhost/api/boudica` |
| `boudicode.apiKey` | API key for authentication (optional with SAML) | `""` |
| `boudicode.userId` | User ID for session management | `""` |
| `boudicode.useRag` | Enable RAG for enhanced responses | `true` |
| `boudicode.temperature` | AI creativity (0.0-2.0) | `0.8` |
| `boudicode.maxTokens` | Maximum response length | `2000` |

### Quick Setup

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **BoudiCode: Configure Connection**
3. Select **Set API Endpoint** and enter your Boudica server URL
4. (Optional) Set API Key if not using SAML authentication
5. Run **Test Connection** to verify

## Usage

### Creating a New Project

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **BoudiCode: Create New Project**
3. Select a project template
4. Enter project name and details
5. Choose destination folder
6. BoudiCode generates the complete project structure

**Or use Plan Mode in Chat:**
1. Open the BoudiCode chat panel (click icon in activity bar or run **BoudiCode: Open Chat**)
2. Type your project request naturally, e.g.:
   ```
   Create a C++ application that downloads a web page using libcurl,
   parses the HTML content, and displays all repeated words
   ```
3. BoudiCode will:
   - Generate a plan showing all files needed
   - Create each file step-by-step
   - Set up build configuration automatically
   - Show progress in real-time

### Creating an Application

1. Open a workspace
2. Open Command Palette
3. Run **BoudiCode: Create Application**
4. Select application type (API, Model, Service, etc.)
5. Enter name and requirements
6. BoudiCode analyzes your project and generates appropriate code

### Augmenting Code

1. Right-click on a folder in Explorer
2. Select **BoudiCode: Augment Code in Workspace**
3. Choose augmentation type (Add Feature, Add Tests, etc.)
4. Describe your requirements
5. Review and apply changes

### Analyzing Code

1. Right-click on a folder in Explorer or open a file
2. Select **BoudiCode: Analyze Code for Issues**
3. Select analysis type:
   - Full Security Audit
   - Memory Leak Detection
   - Code Quality Review
   - Performance Analysis
   - Complete Analysis
4. View results in:
   - **Problems panel** (`View > Problems` or `Ctrl+Shift+M`) - native VS Code diagnostics
   - **Inline decorations** - colored underlines and gutter icons in the editor
   - **Output channel** - detailed analysis report
5. Click on any issue in the Problems panel to jump to the code
6. Hover over decorations to see recommendations
7. Run **BoudiCode: Clear Decorations** to remove all issues when done

### Building and Fixing Projects (NEW!)

**Build Project:**
1. Open a project with build configuration (CMakeLists.txt, Makefile, package.json, etc.)
2. Run **BoudiCode: Build Project** (Ctrl+Shift+P)
3. View build output in terminal
4. Check for errors in Problems panel

**Build and Run (NEW!):**
1. Run **BoudiCode: Build and Run**
2. BoudiCode will:
   - 🔨 Detect build system (CMake, Make, npm, Cargo, Go)
   - 🏗️ Build the project
   - 🔍 Find the executable
   - ▶️ Run it in terminal
3. For different project types:
   - **C++ (CMake)**: Builds and runs executable from `build/` directory
   - **C++ (Make)**: Builds and runs executable (main, app, or project name)
   - **Node.js**: Runs `npm start` or `node main-file.js`
   - **Rust**: Runs `cargo run`
   - **Go**: Runs `go run .` or built binary
4. Terminal stays open so you can see output and interact with program

**Auto-Fix Build Errors:**
1. Run **BoudiCode: Build and Fix Errors**
2. BoudiCode will:
   - 🔨 Run the build
   - 📋 Parse compiler/linker errors
   - 🤖 Generate fixes using AI or rules
   - ✅ Apply fixes to files (with automatic backups)
   - 🔄 Rebuild to verify
3. Review applied fixes in chat panel
4. If issues persist, fixes are shown for manual review

**Example Fix Types:**
- Missing `#include <iostream>` → Automatically added to top of file
- C++11 features but CMakeLists.txt has C++03 → Updates CMAKE_CXX_STANDARD
- SQL-style `--` comments in C++ → Replaced with `//`
- Undeclared function → Suggests include or shows implementation

### Reverting Changes (NEW!)

**Restore from Backup:**
1. Open the file you want to revert
2. Run **BoudiCode: Revert File to Backup**
3. Select a backup from the list (shows timestamp and size)
4. Confirm restoration
5. File is restored (current version backed up first)

**View Backup History:**
1. Open any file
2. Run **BoudiCode: List File Backups**
3. View all backups in output channel with timestamps

**Cleanup Old Backups:**
1. Open any file
2. Run **BoudiCode: Cleanup Old Backups**
3. Enter how many recent backups to keep (default: 10)
4. Older backups are automatically deleted

**Backup Features:**
- Backups created before EVERY modification
- Format: `filename.ext.2026-06-05.14-30-15`
- Located in same directory as original
- Restoration creates backup of current state first

### Multi-File Modifications (NEW!)

**Via Chat Interface:**
1. Open BoudiCode chat panel
2. Describe functionality to add, e.g.:
   ```
   Add user authentication with JWT tokens
   ```
3. BoudiCode analyzes your project and generates a plan
4. Reviews which files need changes
5. Modifies multiple files with precise insertions
6. Creates backups before each change
7. Reports completion with list of modified files

**Via Command:**
1. Run **BoudiCode: Augment Code in Workspace**
2. Describe the enhancement
3. BoudiCode scans project and plans modifications
4. Review and approve changes
5. Files are modified with automatic backups

## Real-World Usage Examples

### Example 1: Add Authentication to Express API

**Scenario**: You have an Express API and want to add JWT authentication.

**Steps:**
1. Open BoudiCode chat
2. Type: "Add JWT authentication to all routes"
3. BoudiCode will:
   - Create `middleware/auth.js` with JWT verification
   - Modify `routes/*.js` to add middleware
   - Update `package.json` with jsonwebtoken dependency
   - Create `.env.example` for JWT_SECRET
   - Update `app.js` to import middleware
4. All files backed up before changes
5. Run `npm install` to get new dependencies

### Example 2: Fix C++ Compilation Errors

**Scenario**: Your C++ project fails to compile with multiple errors.

**Steps:**
1. Run **BoudiCode: Build and Fix Errors**
2. BoudiCode detects CMake build system
3. Runs `cmake .. && make` in build directory
4. Parses errors:
   - Missing `#include <algorithm>` for `std::find_if_not`
   - CMAKE_CXX_STANDARD is 03, but code uses C++11
   - SQL-style `--` comments instead of `//`
5. Automatically applies fixes:
   - Adds missing includes
   - Updates CMAKE_CXX_STANDARD to 11
   - Replaces `--` with `//`
6. Rebuilds automatically
7. Shows success or remaining errors

### Example 3: Build and Run C++ Application (NEW!)

**Scenario**: You've written a C++ program and want to quickly build and test it.

**Steps:**
1. Run **BoudiCode: Build and Run**
2. BoudiCode detects CMake build system
3. Runs build in `build/` directory
4. Build succeeds in 3.2 seconds
5. Detects executable: `WebScraper`
6. Opens terminal and runs: `./WebScraper`
7. You see your program output immediately
8. Terminal stays open for interaction

**For different project types:**
- **Node.js API**: Runs `npm start` → Server starts on port 3000
- **Rust CLI**: Runs `cargo run` → Compiles in release mode and executes
- **Go service**: Runs `go run .` → Builds and runs main package
- **Python script**: Runs `python main.py` (if configured in package.json)

### Example 4: Add Unit Tests to Existing Code

**Scenario**: You have a utility module without tests.

**Steps:**
1. Open `utils/validator.js`
2. Open BoudiCode chat
3. Type: "Create comprehensive unit tests for this file"
4. BoudiCode:
   - Creates `tests/validator.test.js`
   - Adds test cases for all functions
   - Updates `package.json` with Jest dependencies
   - Creates `jest.config.js`
5. Run `npm test` to verify

### Example 5: Revert Bad Changes

**Scenario**: You tried a modification that broke your code.

**Steps:**
1. Open the broken file
2. Run **BoudiCode: Revert File to Backup**
3. See list of backups:
   ```
   6/5/2026, 2:30:15 PM - 5.23 KB
   6/5/2026, 2:15:08 PM - 5.18 KB
   6/5/2026, 1:45:22 PM - 4.95 KB
   ```
4. Select the version before your change
5. File restored (current version backed up first)

### Example 6: Analyze Security Issues

**Scenario**: Check project for security vulnerabilities.

**Steps:**
1. Right-click project folder
2. Select **BoudiCode: Analyze Code for Issues**
3. Choose "Full Security Audit"
4. View results in Problems panel:
   - SQL injection risk in `db/queries.js:45`
   - Hardcoded API key in `config.js:12`
   - XSS vulnerability in `routes/user.js:78`
5. Click lightbulb for AI fix suggestions
6. Apply recommended fixes

## API Endpoints

BoudiCode communicates with the following Boudica CGI endpoints:

- `/chat` - Main chat interface with file upload support
- `/generate` - Text generation without session context
- `/health` - Health check and status
- `/models` - List available models

## Architecture

```
BoudiCode Extension
├── extension.ts              # Main entry point & command registration
├── boudicaClient.ts          # API client for Boudica CGI
├── projectCreator.ts         # Project generation logic
├── applicationCreator.ts     # Application/module creation
├── codeAugmenter.ts          # Code augmentation features
├── codeAnalyzer.ts           # Security and quality analysis
├── projectScanner.ts         # Multi-file project scanning & change detection
├── modificationExecutor.ts   # AI-driven code modifications & backup system
├── codeInsertion.ts          # Precise code insertion (9 modes)
├── buildRunner.ts            # Build system detection & execution
├── errorParser.ts            # Compiler error parsing (11 types)
├── fixGenerator.ts           # AI & rule-based fix generation
├── chatPanel.ts              # Interactive chat with file context
├── planExecutor.ts           # Multi-step plan execution
├── decorationManager.ts      # Visual decorations for issues
├── statusBarManager.ts       # Status bar integration
└── codeActionProvider.ts     # Quick fixes & lightbulb actions
```

## Development

### Building

```bash
npm install
npm run compile
```

### Running in Development

Press `F5` in VS Code to launch the Extension Development Host.

### Testing

The extension can be tested against your local or remote Boudica instance. Ensure the `apiEndpoint` is configured correctly.

### Packaging

```bash
npm run vscode:prepublish
vsce package
```

## Troubleshooting

### Connection Errors

**Problem**: "Failed to connect to Boudica"

**Solutions**:
- Verify `apiEndpoint` is correct
- Check if Boudica server is running
- Test with: `curl http://your-server/api/boudica/health`
- Check firewall/network settings

### Authentication Errors

**Problem**: 401 Unauthorized

**Solutions**:
- Set `apiKey` in settings if required
- Configure `userId` if using SAML
- Check Apache/CGI authentication setup

### Large File Issues

**Problem**: Timeout or memory errors with large codebases

**Solutions**:
- Analyze specific folders instead of entire workspace
- Increase `maxTokens` for longer responses
- The extension automatically limits file sizes and counts
- Use project scanner cache (30-second timeout)
- Run build-fix on specific subdirectories

### Build Failures

**Problem**: Build system not detected or build fails

**Solutions**:
- Verify build files exist (CMakeLists.txt, Makefile, package.json, etc.)
- Check build tools are installed (cmake, make, npm, cargo, go)
- View build output in terminal for specific errors
- Try **BoudiCode: Clean Build Artifacts** first
- Ensure dependencies are installed (npm install, etc.)

### Backup Issues

**Problem**: Too many backup files accumulating

**Solutions**:
- Run **BoudiCode: Cleanup Old Backups** regularly
- Set retention to 5-10 most recent backups
- Backups are in same directory as originals
- Safe to manually delete old `.YYYY-MM-DD.HH-mm-ss` files

### No Issues Found

**Problem**: Code analyzer finds no issues in obviously problematic code

**Solutions**:
- Try different analysis types (security, memory, quality)
- Check if files are being scanned (see output in console)
- Verify file extensions are supported

## Security Considerations

- API keys are stored in VS Code's settings (encrypted on disk)
- Never commit `.vscode/settings.json` with API keys to version control
- Use SAML authentication when possible for enterprise deployments
- All communication uses HTTPS in production deployments

## Supported Languages

- TypeScript/JavaScript (.ts, .tsx, .js, .jsx)
- Python (.py)
- C/C++ (.c, .cpp, .h, .hpp)
- Go (.go)
- Rust (.rs)
- Java (.java)
- C# (.cs)
- PHP (.php)
- Ruby (.rb)
- Swift (.swift)
- Kotlin (.kt)
- Scala (.scala)

## Requirements

### Runtime
- Visual Studio Code 1.85.0+
- Network access to Boudica server

### Development
- Node.js 18+
- TypeScript 5.3+

## Known Limitations

- Maximum file size for analysis: 500KB per file
- Maximum files in single analysis: 30 files
- **Project-wide scanning limited to 100 files**: Projects with more than 100 source/header files will skip automatic project scanning. Multi-file operations will require explicit file selection for large projects.
- Context window limitations apply based on Boudica model configuration
- File parsing assumes UTF-8 encoding
- Build system detection requires standard file names (CMakeLists.txt, Makefile, etc.)
- Backup files stored in same directory as originals (manual cleanup recommended periodically)
- Some C++ template errors may be too complex for automatic fixing
- Automatic fixes require manual review for critical production code

## Contributing

This extension is part of the Boudica SLM project. For contributions and bug reports, contact the Boudica development team.

## License

Copyright 2026 OmniIndex Inc. All rights reserved.

## Credits

Developed by OmniIndex Inc. as part of the Boudica Sovereign Language Model platform.

## Changelog

### Version 1.0.0 (2026-06-05)

Comprehensive feature release:

**Core Features:**
- Project creation with multiple templates
- Application/module generation
- Code augmentation capabilities
- Comprehensive security and quality analysis
- Integration with Boudica CGI endpoints
- Support for 12+ programming languages
- Visual diagnostics in VS Code Problems panel

**Multi-File Project Support:**
- Intelligent project scanning with change detection
- Multi-file modification planning and execution
- Dependency tracking and relationship analysis
- 30-second caching with FileSystemWatcher invalidation

**Build & Fix Workflow:**
- 5 build system support (CMake, Make, npm, Cargo, Go)
- 11 error type detection and parsing
- AI-powered and rule-based fix generation
- Automatic fix application and rebuild verification
- Duplicate detection for config files

**Backup & Restore System:**
- Automatic timestamped backups before all modifications
- Revert to any previous version with UI
- Backup listing and cleanup commands
- Double-safety restore (backs up current before restoring)

**Code Insertion:**
- 9 precise insertion modes
- Context-aware placement (functions, classes, lines)
- Indentation and formatting preservation
- Smart duplicate detection

## Support

For support and questions:
- Check the Boudica documentation
- Review server logs at `/var/log/apache2/error.log` (CGI issues)
- Check extension console output (Help > Toggle Developer Tools)
- Contact: support@omniindex.io

---

**Powered by Boudica AI** - Sovereign, Secure, Intelligent Code Assistance
