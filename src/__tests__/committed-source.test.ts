import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { readCommittedSource } from '../utils/committed-source';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function repository(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's010-source-'));
  temporaryDirectories.push(root);
  execFileSync('git', ['init', '-q', root]);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
  return root;
}

describe('committed source reader', () => {
  it('reads immutable HEAD content and ignores dirty and untracked files', async () => {
    const root = repository({ 'src/App.java': 'committed\n' });
    fs.writeFileSync(path.join(root, 'src/App.java'), 'dirty\n');
    fs.writeFileSync(path.join(root, 'generated-after-commit.txt'), 'untracked\n');

    const snapshot = await readCommittedSource(root, { include: () => true });

    expect(snapshot.complete).toBe(true);
    expect(snapshot.files).toEqual([
      expect.objectContaining({ path: 'src/App.java', content: 'committed\n' })
    ]);
  });

  it('sorts paths and excludes committed symlinks and binary blobs', async () => {
    const root = repository({
      'z.txt': 'last',
      'a.txt': 'first',
      'image.bin': Buffer.from([0, 1, 2, 3])
    });
    fs.symlinkSync('a.txt', path.join(root, 'link.txt'));
    execFileSync('git', ['-C', root, 'add', 'link.txt']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'link']);

    const snapshot = await readCommittedSource(root, { include: () => true });

    expect(snapshot.files.map(file => file.path)).toEqual(['a.txt', 'z.txt']);
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'binary', path: 'image.bin' }),
      expect.objectContaining({ code: 'unsafe-entry', path: 'link.txt' })
    ]));
  });

  it('applies deterministic file and total-byte limits', async () => {
    const root = repository({
      'a.txt': '1234',
      'b.txt': '5678',
      'c.txt': '9012'
    });

    const snapshot = await readCommittedSource(root, {
      include: () => true,
      maxFiles: 2,
      maxTotalBytes: 6
    });

    expect(snapshot.complete).toBe(false);
    expect(snapshot.files.map(file => file.path)).toEqual(['a.txt']);
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'total-size', material: true }),
      expect.objectContaining({ code: 'file-limit', material: true })
    ]));
  });

  it('returns a redacted material diagnostic for a non-Git directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 's010-not-git-token=secret-'));
    temporaryDirectories.push(root);

    const snapshot = await readCommittedSource(root, { include: () => true });

    expect(snapshot.complete).toBe(false);
    expect(snapshot.files).toEqual([]);
    expect(snapshot.diagnostics[0]).toMatchObject({ code: 'git-error', material: true });
    expect(JSON.stringify(snapshot)).not.toContain('token=secret');
  });
});
