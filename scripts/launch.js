#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const mainPath = path.join(__dirname, '..', 'dist', 'main.js');

const isAndroid = process.platform === 'android';
const forceSafeRuntime =
  isAndroid &&
  process.env.REFURB_DISABLE_JITLESS !== '1' &&
  !process.execArgv.includes('--jitless');

if (forceSafeRuntime) {
  console.log(
    '[launcher] Android runtime detected. Starting with --jitless to mitigate V8 SIGTRAP crash risk.',
  );

  const child = spawn(process.execPath, ['--jitless', mainPath], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    console.error('[launcher] Failed to start child process:', error);
    process.exit(1);
  });
} else {
  require(mainPath);
}
