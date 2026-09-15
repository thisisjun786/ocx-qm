import {readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';

// Discover source files so newly added modules cannot escape the syntax gate.
let count = 0;
for (const directory of ['src', 'public', 'scripts', 'tests']) {
  for (const file of readdirSync(directory, {recursive: true})) {
    if (!/\.(?:mjs|js)$/.test(file)) continue;
    execFileSync(process.execPath, ['--check', join(directory, file)], {stdio: 'inherit'});
    count++;
  }
}
console.log(`Syntax checked ${count} JavaScript modules`);
