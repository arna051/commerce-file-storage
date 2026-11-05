import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const output = JSON.parse(
  execFileSync('npm', ['pack', '--ignore-scripts', '--json'], {
    cwd: root,
    encoding: 'utf8',
  }),
);
const tarball = resolve(root, output[0].filename);
const consumer = mkdtempSync(join(tmpdir(), 'commerce-file-storage-consumer-'));
try {
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', tarball], {
    cwd: consumer,
    stdio: 'inherit',
  });
  writeFileSync(
    join(consumer, 'esm.mjs'),
    "import { createFileStorage } from 'commerce-file-storage';\nimport { MemoryMetadataStore } from 'commerce-file-storage/testing';\nif (typeof createFileStorage !== 'function' || !MemoryMetadataStore) process.exit(1);\n",
  );
  writeFileSync(
    join(consumer, 'cjs.cjs'),
    "const { createFileStorage } = require('commerce-file-storage');\nconst { MemoryMetadataStore } = require('commerce-file-storage/testing');\nif (typeof createFileStorage !== 'function' || !MemoryMetadataStore) process.exit(1);\n",
  );
  execFileSync(process.execPath, ['esm.mjs'], { cwd: consumer, stdio: 'inherit' });
  execFileSync(process.execPath, ['cjs.cjs'], { cwd: consumer, stdio: 'inherit' });
  const installed = JSON.parse(
    readFileSync(join(consumer, 'node_modules/commerce-file-storage/package.json'), 'utf8'),
  );
  if (installed.name !== 'commerce-file-storage') throw new Error('Unexpected package installed');
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
