import fs from 'fs';
import path from 'path';

describe('Provider-agnosticism of the test suite', () => {
  test('no test file depends on the name "relio"', () => {
    const testsDir = path.join(__dirname, '..', 'unit');
    const files = fs.readdirSync(testsDir)
      .filter(f => f.endsWith('.test.ts'))
      .filter(f => f !== 'no-relio-dependency.test.ts');
    const offenders = files.filter(f => {
      const content = fs.readFileSync(path.join(testsDir, f), 'utf-8');
      return content.includes('relio');
    });
    expect(offenders).toEqual([]);
  });
});
