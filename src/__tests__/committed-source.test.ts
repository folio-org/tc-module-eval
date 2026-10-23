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

  it('classifies binary omissions before byte-budget failures and fails closed beyond the probe', async () => {
    const root = repository({
      'a.bin': Buffer.alloc(16 * 1024),
      'b.txt': 'valid source',
      'c.dat': Buffer.concat([Buffer.alloc(8192, 'x'), Buffer.from([0])])
    });
    const snapshot = await readCommittedSource(root, { maxFileBytes: 8192, maxTotalBytes: 12 });
    expect(snapshot.files.map(file => file.path)).toEqual(['b.txt']);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ code: 'binary', path: 'a.bin' }),
      expect.objectContaining({ code: 'file-size', path: 'c.dat' })
    ]);
    expect(snapshot.complete).toBe(false);
  });

  it('reads blobs that span many output chunks intact and probes over-budget blobs for binary content', async () => {
    const large = Array.from({ length: 20_000 }, (_, line) => `line ${line} ✓\n`).join('');
    const root = repository({
      'a.txt': large,
      'b.bin': Buffer.concat([Buffer.alloc(9000, 'x'), Buffer.from([0])]),
      'c.dat': Buffer.from([7, 0, 7]),
      'd.txt': 'after'
    });

    const snapshot = await readCommittedSource(root, { maxFileBytes: 1024 * 1024, maxTotalBytes: Buffer.byteLength(large) + 5 });

    expect(snapshot.files.map(file => [file.path, file.content])).toEqual([['a.txt', large], ['d.txt', 'after']]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ code: 'total-size', path: 'b.bin' }),
      expect.objectContaining({ code: 'binary', path: 'c.dat' })
    ]);
  });

  it('omits only the blob git cannot read and keeps reading the rest', async () => {
    const root = repository({ 'a.txt': 'first', 'b.txt': 'corrupt\n'.repeat(500), 'c.txt': 'third' });
    const oid = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD:b.txt']).toString().trim();
    const objectPath = path.join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
    const object = fs.readFileSync(objectPath);
    object[object.length - 1] ^= 0xff;
    fs.chmodSync(objectPath, 0o644);
    fs.writeFileSync(objectPath, object);

    const snapshot = await readCommittedSource(root, { include: () => true });

    expect(snapshot.files.map(file => [file.path, file.content])).toEqual([['a.txt', 'first'], ['c.txt', 'third']]);
    expect(snapshot.diagnostics).toEqual([expect.objectContaining({ code: 'git-error', path: 'b.txt' })]);
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
