#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Smart build script that detects the environment and chooses the appropriate build method
 */

function detectEnvironment() {
  // Check if running in Termux
  if (process.env.PREFIX && process.env.PREFIX.includes('com.termux')) {
    return 'termux';
  }
  
  // Check if we're on Android
  if (process.platform === 'android' || process.env.ANDROID_ROOT) {
    return 'android';
  }
  
  // Check if SWC is available and working
  try {
    require('@swc/core');
    return 'standard';
  } catch (error) {
    console.log('⚠️ SWC not available, falling back to TypeScript compiler');
    return 'fallback';
  }
}

function runBuild(environment) {
  console.log(`🔧 Detected environment: ${environment}`);
  
  try {
    switch (environment) {
      case 'termux':
        console.log('📱 Building for Termux environment...');
        execSync('npm run build:termux', { stdio: 'inherit' });
        break;
        
      case 'android':
      case 'fallback':
        console.log('🐧 Building with TypeScript compiler...');
        execSync('npm run build:tsc', { stdio: 'inherit' });
        break;
        
      case 'standard':
      default:
        console.log('🚀 Building with Webpack + SWC...');
        execSync('npm run build', { stdio: 'inherit' });
        break;
    }
    
    console.log('✅ Build completed successfully!');
    
  } catch (error) {
    console.error('❌ Build failed:', error.message);
    process.exit(1);
  }
}

function main() {
  const environment = detectEnvironment();
  runBuild(environment);
}

if (require.main === module) {
  main();
}

module.exports = { detectEnvironment, runBuild };
