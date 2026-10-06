/**
 * Supply chain (docs/security-review.md SR-10): every GitHub Action is pinned to a full commit SHA with
 * its version in a comment ("uses: owner/repo@<40 hex> # vX.Y.Z"), and Dependabot keeps them current.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, '.github', 'workflows');
const workflows = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n));

describe('GitHub Actions pins', () => {
  it('pins every action to a commit SHA with a version comment', () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const name of workflows) {
      const lines = readFileSync(path.join(dir, name), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = /^\s*(?:-\s+)?uses:\s+(\S+)(.*)$/.exec(line);
        if (!m) return;
        const target = m[1]!;
        if (target.startsWith('./')) return; // local action
        expect(target, `${name}:${i + 1}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        expect(m[2]!.trim(), `${name}:${i + 1} needs "# vX.Y.Z"`).toMatch(/^# v\d+(\.\d+){0,2}$/);
      });
    }
  });

  it('Dependabot updates the pinned actions', () => {
    expect(readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8')).toMatch(/package-ecosystem: github-actions/);
  });
});
