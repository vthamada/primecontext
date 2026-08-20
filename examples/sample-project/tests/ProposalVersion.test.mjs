import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

test('ProposalService creates a stable immutable-version marker', async () => {
  const sourceUrl = new URL('../src/Proposal/ProposalService.ts', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: 'ProposalService.ts',
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, []);

  const encoded = Buffer.from(compiled.outputText, 'utf8').toString('base64');
  const { ProposalService } = await import(`data:text/javascript;base64,${encoded}`);
  const service = new ProposalService();

  assert.deepEqual(service.createVersion('proposal-001'), {
    id: 'proposal-001',
    immutable: true,
  });
});
