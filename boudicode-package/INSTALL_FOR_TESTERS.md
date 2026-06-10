# BoudiCode - Installation for Testers

## Quick Install (Recommended)

### Using the .vsix File

1. Download `boudicode-1.0.0.vsix`
2. Install using command line:
   ```bash
   code --install-extension boudicode-1.0.0.vsix
   ```
   
   **OR** in VS Code:
   - Press `Ctrl+Shift+X` (Extensions)
   - Click `...` (Views and More Actions) at top
   - Select "Install from VSIX..."
   - Choose `boudicode-1.0.0.vsix`

3. Restart VS Code
4. You should see "BoudiCode" in your extensions list

### Alternative: Using Package Files

If you received the `.tar.gz` or `.zip` package instead:

1. Extract the package:
   ```bash
   tar -xzf boudicode-1.0.0-tester.tar.gz     # Linux/Mac
   # OR
   unzip boudicode-1.0.0-tester.zip           # Windows
   ```

2. Copy to VS Code extensions directory:
   
   **Linux/Mac:**
   ```bash
   cp -r boudicode-package ~/.vscode/extensions/omniindex.boudicode-1.0.0/
   ```
   
   **Windows:**
   ```powershell
   xcopy boudicode-package %USERPROFILE%\.vscode\extensions\omniindex.boudicode-1.0.0\ /E /I
   ```

3. Restart VS Code

### Package Contents

The package contains:
```
boudicode-package/
├── out/              # Compiled JavaScript (required)
├── resources/        # Icons and assets
├── package.json      # Extension manifest (required)
├── README.md         # Documentation
├── .vscodeignore     # Build exclusions
└── INSTALL_FOR_TESTERS.md  # This file
```

**Do NOT include:**
- `node_modules/` (too large, not needed)
- `src/` (TypeScript source, not needed for running)
- `.git/` (version control)

### Verification

After installation:
1. Open VS Code
2. Press `Ctrl+Shift+X` (Extensions)
3. Search for "BoudiCode"
4. You should see it installed
5. Open Command Palette (`Ctrl+Shift+P`)
6. Type "BoudiCode" - you should see all commands

### Configuration

1. Open Settings (`Ctrl+,`)
2. Search for "BoudiCode"
3. Set API Endpoint: `https://boudi.ca/api/boudica` (or your server)
4. (Optional) Set API Key if required
5. Run **BoudiCode: Configure Connection** to test

### Uninstall

```bash
code --uninstall-extension omniindex.boudicode
```

Or through VS Code Extensions panel → Right-click → Uninstall

## Support

For issues, contact: support@omniindex.io
