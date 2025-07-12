#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Recursively remove directory and all its contents
 * Cross-platform alternative to rimraf
 */
function removeDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    console.log(`Directory '${dirPath}' does not exist, skipping cleanup.`);
    return;
  }

  try {
    const files = fs.readdirSync(dirPath);
    
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isDirectory()) {
        // Recursively remove subdirectory
        removeDirectory(filePath);
      } else {
        // Remove file
        fs.unlinkSync(filePath);
      }
    }
    
    // Remove the empty directory
    fs.rmdirSync(dirPath);
    console.log(`✅ Successfully cleaned directory: ${dirPath}`);
  } catch (error) {
    console.error(`❌ Error cleaning directory '${dirPath}':`, error.message);
    process.exit(1);
  }
}

// Clean the dist directory
const distPath = path.join(__dirname, '..', 'dist');
removeDirectory(distPath);
