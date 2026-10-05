const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const hardhat = require.resolve('hardhat/internal/cli/cli');

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'arbitrage-test-runners-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const tests = path.join(directory, 'test');
  mkdirSync(path.join(tests, 'nested'), { recursive: true });
  const config = path.join(directory, 'hardhat.config.cjs');
  writeFileSync(config, `
    const config = require(${JSON.stringify(path.join(root, 'hardhat.config.js'))});
    module.exports = {
      ...config,
      defaultNetwork: 'hardhat',
      networks: { hardhat: { chainId: 1337 } },
      paths: { root: ${JSON.stringify(directory)}, tests: ${JSON.stringify(tests)} },
      gasReporter: { enabled: false },
      mocha: { timeout: 10000 }
    };
  `);
  const nodeFile = path.join(tests, 'nested', 'failure.node.test.js');
  writeFileSync(nodeFile, `
    require('node:test')('intentional Node failure', () => {
      require('node:assert/strict').fail('NODE_FAILURE_SENTINEL');
    });
  `);
  return { directory, tests, config, nodeFile };
}

function run(args, cwd) {
  const env = { ...process.env, ENABLE_MAINNET_FORK: 'false', REPORT_GAS: 'false' };
  // These subprocesses must run as independent CLIs, not Node test workers.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd, env, timeout: 30000 }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) return reject(error);
      resolve({ code: error ? error.code : 0, output: stdout + stderr });
    });
  });
}

function hardhatArgs(config, ...files) {
  return [hardhat, '--config', config, 'test', '--no-compile', ...files];
}

test('Hardhat discovers nested Mocha tests without importing Node tests', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.tests, 'passing.test.js'), `
    describe('Mocha test file', () => it('passes', () => {}));
  `);
  writeFileSync(path.join(f.tests, 'nested', 'passing.spec.js'), `
    describe('nested Mocha spec', () => it('passes', () => {}));
  `);
  const result = await run(hardhatArgs(f.config), root);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /2 passing/);
  assert.doesNotMatch(result.output, /NODE_FAILURE_SENTINEL|intentional Node failure/);
});

test('Hardhat rejects an explicitly selected Node test with the correct command', async t => {
  const f = fixture(t);
  const result = await run(hardhatArgs(f.config, f.nodeFile), root);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /npm run test:core or node --test/);
  assert.doesNotMatch(result.output, /NODE_FAILURE_SENTINEL/);
});

test('a failing Mocha test makes the Hardhat CLI exit non-zero', async t => {
  const f = fixture(t);
  const mochaFile = path.join(f.tests, 'failure.test.js');
  writeFileSync(mochaFile, `
    describe('intentional Mocha failure', () => it('fails', () => {
      throw new Error('MOCHA_FAILURE_SENTINEL');
    }));
  `);
  const result = await run(hardhatArgs(f.config, mochaFile), root);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /MOCHA_FAILURE_SENTINEL/);
});

test('a failing Node test makes the Node test runner exit non-zero', async t => {
  const f = fixture(t);
  const result = await run(['--test', f.nodeFile], f.directory);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /NODE_FAILURE_SENTINEL/);
});
