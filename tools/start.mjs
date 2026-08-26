// Launches Electron with a clean environment.
//
// VS Code (and some other editor terminals) export ELECTRON_RUN_AS_NODE=1, which
// makes the Electron binary behave as plain Node: require('electron') then returns
// the binary path instead of the API object and the app dies on startup. Strip it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// The electron package exports the path to its binary when loaded from Node.
const electronBin = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [root, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
