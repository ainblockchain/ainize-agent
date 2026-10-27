// CommonJS copies of the dependency-free subpath modules (teams, research) for CommonJS consumers (NestJS, jest).
import { readFileSync, writeFileSync } from 'node:fs';
for (const m of ['teams', 'research']) {
  let src = readFileSync(`dist/${m}/index.js`, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/m, '');
  src = src.replace(/^import \{([^}]+)\} from '(node:[a-z]+)';$/gm, (_, names, mod) => `const {${names.replace(/ as /g, ': ')}} = require('${mod}');`);
  const names = [...src.matchAll(/^export (?:async )?(?:function\*? ?|const |class )([A-Za-z0-9_]+)/gm)].map(x => x[1]);
  src = src.replace(/^export (async )?(function|const|class) /gm, '$1$2 ');
  if (/^(?:import|export) /m.test(src)) throw new Error(`${m}: unconverted ESM syntax`);
  writeFileSync(`dist/${m}/index.cjs`, `'use strict';\n${src}\nmodule.exports = { ${names.join(', ')} };\n`);
}
