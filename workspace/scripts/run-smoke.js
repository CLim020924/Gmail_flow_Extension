const { spawn } = require('node:child_process');
const path = require('node:path');

const electronPath = require('electron');
const workspaceRoot = path.resolve(__dirname, '..');
const child = spawn(electronPath, [workspaceRoot, '--smoke-test'], {
  cwd: workspaceRoot,
  env: { ...process.env, CMOE_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});

let output = '';
const forward = (stream, target) => stream.on('data', (chunk) => {
  const text = chunk.toString();
  output += text;
  target.write(text);
});
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

child.on('error', (error) => {
  console.error('Workspace smoke launcher failed:', error);
  process.exitCode = 1;
});

child.on('close', (code) => {
  const passed = output.includes('Workspace smoke test passed.');
  const failed = output.includes('Workspace smoke test failed:');
  if (!passed || failed || code !== 0) {
    if (!failed) console.error(`Workspace smoke test did not report success (exit ${code ?? 'unknown'}).`);
    process.exitCode = 1;
  }
});
