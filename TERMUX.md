# RefurbMiner - Termux Installation Guide

This guide helps you install and run RefurbMiner on Termux (Android).

## Quick Start for Termux

### 1. Install RefurbMiner dependencies

```bash
# Install Node.js if not already installed
pkg install nodejs npm

# Clone and setup
cd ~
git clone <your-repo-url> refurbminer
cd refurbminer

# Install packages (this may show SWC warnings, but will fallback to TypeScript)
npm install
```

### 2. Build for Termux

```bash
# Standard build command (automatically detects Termux and chooses best method)
npm run build

# Or explicitly use Termux-specific build
npm run build:termux
```

### 3. Start the application

```bash
npm start
```

## Troubleshooting

### SWC Native Binding Errors

If you see errors like:
```
Error: Failed to load native binding
Cannot find module './swc.android-arm64.node'
```

**This is normal!** The application will automatically fallback to using the TypeScript compiler instead of SWC. You can safely ignore these warnings.

### Build Options

- `npm run build` - **Recommended**: Automatically detects your environment and chooses the best build method
- `npm run build:termux` - Specifically designed for Termux environments  
- `npm run build:tsc` - Uses TypeScript compiler (fallback for when SWC doesn't work)
- `npm run build:webpack` - Forces Webpack + SWC build (may fail on Termux)

### Environment Detection

The smart build system (now the default `npm run build`) automatically detects:
- Termux environment (checks for `$PREFIX` containing `com.termux`)
- Android environment (checks for `$ANDROID_ROOT`)
- SWC availability (falls back to TypeScript if SWC fails)

## Performance Notes

- TypeScript compilation is slower than SWC but more compatible
- The first build may take longer on mobile devices
- Subsequent builds should be faster due to caching

## Need Help?

If you encounter issues:
1. Try `npm run build` (the smart detection should handle most cases)
2. For Termux-specific issues, try `npm run build:termux` directly
3. Check that Node.js version is compatible (`node --version`)
4. Ensure you have enough storage space for node_modules
5. Try clearing npm cache: `npm cache clean --force`
