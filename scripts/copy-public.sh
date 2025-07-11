#!/bin/bash

# Copy public files to dist folder
# This script is platform-independent and works on Linux, macOS, and Termux

echo "🚀 Starting public files copy..."

# Create destination directory if it doesn't exist
mkdir -p dist/public

# Copy all files from src/public to dist/public recursively
if [ -d "src/public" ]; then
    echo "📁 Copying files from src/public to dist/public..."
    cp -r src/public/* dist/public/
    echo "✅ Public files copied successfully!"
else
    echo "❌ Source directory src/public does not exist!"
    exit 1
fi

# List copied files for verification
echo "📋 Files in dist/public:"
ls -la dist/public/
