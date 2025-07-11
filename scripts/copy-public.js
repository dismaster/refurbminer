#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Recursively copy directory contents
 * @param {string} srcDir - Source directory
 * @param {string} destDir - Destination directory
 */
function copyDirectory(srcDir, destDir) {
  try {
    // Create destination directory if it doesn't exist
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
      console.log(`Created directory: ${destDir}`);
    }

    // Read all files/directories in source
    const items = fs.readdirSync(srcDir);
    
    for (const item of items) {
      const srcPath = path.join(srcDir, item);
      const destPath = path.join(destDir, item);
      
      const stats = fs.statSync(srcPath);
      
      if (stats.isDirectory()) {
        // Recursively copy subdirectories
        copyDirectory(srcPath, destPath);
      } else {
        // Copy files
        fs.copyFileSync(srcPath, destPath);
        console.log(`Copied: ${srcPath} -> ${destPath}`);
      }
    }
  } catch (error) {
    console.error(`Error copying directory: ${error.message}`);
    process.exit(1);
  }
}

// Main execution
const srcDir = path.join(__dirname, '..', 'src', 'public');
const destDir = path.join(__dirname, '..', 'dist', 'public');

console.log('🚀 Starting public files copy...');
console.log(`Source: ${srcDir}`);
console.log(`Destination: ${destDir}`);

// Check if source directory exists
if (!fs.existsSync(srcDir)) {
  console.error(`❌ Source directory does not exist: ${srcDir}`);
  process.exit(1);
}

// Perform the copy
copyDirectory(srcDir, destDir);
console.log('✅ Public files copied successfully!');
