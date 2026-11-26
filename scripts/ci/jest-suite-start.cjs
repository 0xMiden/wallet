const { relative } = require('node:path');

module.exports = class JestSuiteStart {
  onTestFileStart(test) {
    process.stderr.write(`Jest suite started: ${relative(process.cwd(), test.path)}\n`);
  }
};
