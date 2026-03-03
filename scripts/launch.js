#!/usr/bin/env node

const path = require('path');

const mainPath = path.join(__dirname, '..', 'dist', 'main.js');

// Direct launch - rely on watchdog restart loop for crash resilience
// (--jitless flag disabled WebAssembly, breaking Node.js HTTP stack)
require(mainPath);