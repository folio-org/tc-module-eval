import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

export const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args]).toString().trim();

/** A committed fixture repository; the clone directory name is a timestamp, as in real runs. */
export function repository(files: Record<string, string | Buffer>): string {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'backend-')), '1761234567890');
  temporaryDirectories.push(path.dirname(root));
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  for (const [relativePath, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}

export function pom(artifactId: string, body = ''): string {
  return `<project><modelVersion>4.0.0</modelVersion><groupId>org.folio</groupId><artifactId>${artifactId}</artifactId>${body}</project>`;
}

export function dependency(artifactId: string, groupId = 'org.folio'): string {
  return `<dependency><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId><version>1.0.0</version></dependency>`;
}

export const restVerticleBuild = '<build><plugins><plugin><artifactId>maven-shade-plugin</artifactId><configuration><transformers><transformer>'
  + '<manifestEntries><Main-Class>org.folio.rest.RestLauncher</Main-Class><Main-Verticle>org.folio.rest.RestVerticle</Main-Verticle>'
  + '</manifestEntries></transformer></transformers></configuration></plugin></plugins></build>';
