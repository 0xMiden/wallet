// CI-only: enumerate the source files Jest's own V8 reporter should instrument.
const fs = require('node:fs');
const path = require('node:path');
const Runtime = require('jest-runtime').default;
const { shouldInstrument } = require('@jest/transform');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!config.globalConfig || !Array.isArray(config.configs) || config.configs.length !== 1) throw new Error('Expected one Jest project');
const global = config.globalConfig;
const project = config.configs[0];
if (global.coverageProvider !== 'v8' || !Array.isArray(global.collectCoverageFrom) || global.collectCoverageFrom.length === 0) throw new Error('Original V8 collection configuration required');
(async () => {
  fs.mkdirSync(project.cacheDirectory, { recursive: true });
  const map = await Runtime.createHasteMap(project, { maxWorkers: 2, resetCache: !project.cache, watch: false, watchman: global.watchman, workerThreads: global.workerThreads });
  const { hasteFS } = await map.build();
  const options = { collectCoverage: true, collectCoverageFrom: global.collectCoverageFrom, globalRootDir: global.rootDir };
  const files = [...hasteFS.matchFilesWithGlob(global.collectCoverageFrom, global.rootDir)]
    .filter(file => shouldInstrument(file, options, project))
    .map(file => {
      const relative = path.relative(global.rootDir, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Coverage file outside source root');
      return relative.split(path.sep).join('/');
    }).sort();
  if (!files.length || new Set(files).size !== files.length) throw new Error('Empty or duplicated denominator');
  process.stdout.write(`${JSON.stringify({ files })}\n`);
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
