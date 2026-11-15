import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the PDF viewer chunk', () => {
  it('does not hold the PDF marker in its first 1024 bytes once built (the app would serve it as a PDF, not a script)', () => {
    const source = readFileSync(new URL('./PdfView.tsx', import.meta.url), 'utf8');
    const built = transformSync(source, { loader: 'tsx', minify: true, format: 'esm', jsx: 'automatic' }).code;
    expect(built.slice(0, 1024)).not.toContain('%PDF');
    expect(Buffer.from(built).subarray(0, 1024).includes('%PDF')).toBe(false);
  });
});
