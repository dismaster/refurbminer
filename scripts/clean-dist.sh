#!/bin/bash

# Cross-platform directory cleanup script
# Alternative to rimraf for environments where it's not available

DIST_DIR="dist"

if [ -d "$DIST_DIR" ]; then
    echo "🧹 Cleaning dist directory..."
    rm -rf "$DIST_DIR"
    echo "✅ Successfully cleaned directory: $DIST_DIR"
else
    echo "Directory '$DIST_DIR' does not exist, skipping cleanup."
fi
