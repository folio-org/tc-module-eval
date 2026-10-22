import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LicenseUtils } from '../utils/license-utils';
import { EvaluationStatus } from '../types';

const APACHE_LICENSE = `
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
`;
const MIT_LICENSE = 'MIT License\n\nCopyright (c) 2026 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n';

function pom(body: string): string {
  return `<project><modelVersion>4.0.0</modelVersion><artifactId>mod-example</artifactId>${body}</project>`;
}

function pomLicense(name: string, url = ''): string {
  return `<license><name>${name}</name>${url ? `<url>${url}</url>` : ''}</license>`;
}

describe('LicenseUtils.checkApache2License (S001)', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 's001-'));
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  function write(files: Record<string, string>): void {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(repoPath, name), content);
    }
  }

  const check = () => LicenseUtils.checkApache2License(repoPath, 'S001');

  describe('license files', () => {
    it('passes an Apache LICENSE file', async () => {
      write({ LICENSE: APACHE_LICENSE, 'pom.xml': pom('') });

      const result = await check();

      expect(result).toMatchObject({ criterionId: 'S001', status: EvaluationStatus.PASS });
      expect(result.evidence).toBe('The LICENSE file is the Apache License 2.0.');
      expect(result.details).toBe('License file: LICENSE (Apache License 2.0)');
    });

    it('passes an Apache LICENSE file that appends third-party notices under other licenses', async () => {
      write({ LICENSE: `${APACHE_LICENSE}\n${'   Apache terms...\n'.repeat(20)}\nThird-party notices:\n\nMIT License\nPermission is hereby granted\n` });

      expect((await check()).status).toBe(EvaluationStatus.PASS);
    });

    it('passes a license file identified by an Apache-2.0 SPDX id', async () => {
      write({ LICENSE: 'SPDX-License-Identifier: Apache-2.0\n\nCopyright (C) 2026 The Open Library Foundation\n' });

      expect((await check()).status).toBe(EvaluationStatus.PASS);
    });

    it('fails an MIT LICENSE that only mentions bundled Apache-2.0 code', async () => {
      write({ LICENSE: `${MIT_LICENSE}\nThis product bundles parts of Example, which is available under the Apache License, Version 2.0 (Apache-2.0).\n` });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toContain('The LICENSE file is not the Apache License 2.0.');
      expect(result.evidence).toContain('replace LICENSE with the Apache License 2.0 text');
      expect(result.details).toBe('License file: LICENSE (not Apache 2.0; starts with "MIT License")');
    });

    it('fails a LICENSE that starts with another Apache version and only mentions Apache-2.0 later', async () => {
      write({ LICENSE: 'The Apache Software License, Version 1.1\nThis distribution bundles a component under Apache-2.0.\n' });

      expect((await check()).status).toBe(EvaluationStatus.FAIL);
    });

    it('fails an untitled MIT LICENSE whose header mentions Apache-2.0 code', async () => {
      write({ LICENSE: 'Copyright (c) 2015 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nThis software bundles parts of Example under the Apache-2.0 license.\n' });

      expect((await check()).status).toBe(EvaluationStatus.FAIL);
    });

    it('passes a LICENSE with the standard Apache notice', async () => {
      write({ LICENSE: 'Copyright (C) 2026 The Open Library Foundation\n\nThis software is distributed under the terms of the Apache License, Version 2.0.\n' });

      expect((await check()).status).toBe(EvaluationStatus.PASS);
    });

    it('finds license files in any case and with suffixes', async () => {
      write({ 'license.md': APACHE_LICENSE, 'LICENSE-2.0.txt': APACHE_LICENSE });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.evidence).toBe('The license files (LICENSE-2.0.txt, license.md) are all the Apache License 2.0.');
    });

    it('ignores license notices and documentation whose names only start with LICENSE', async () => {
      write({ LICENSE: APACHE_LICENSE, 'LICENSE_LIST_MANAGEMENT.md': '# License List Management\n', 'LICENSE-THIRD-PARTY.txt': MIT_LICENSE });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.details).toBe('License file: LICENSE (Apache License 2.0)');
    });

    it('fails a COPYING file with another license and names it', async () => {
      write({ COPYING: 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n', 'package.json': '{"license": "Apache-2.0"}' });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toContain('The COPYING file is not the Apache License 2.0.');
    });

    it('needs manual review when license files disagree, listing every file', async () => {
      write({ LICENSE: MIT_LICENSE, 'LICENSE.md': APACHE_LICENSE });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('The top-level license files disagree: LICENSE.md is the Apache License 2.0, but LICENSE is not.');
      expect(result.details).toBe([
        'License file: LICENSE (not Apache 2.0; starts with "MIT License")',
        'License file: LICENSE.md (Apache License 2.0)'
      ].join('\n'));
    });
  });

  describe('pom.xml', () => {
    it('passes an Apache license declared in pom.xml', async () => {
      write({ 'pom.xml': pom(`<licenses>${pomLicense('Apache License, Version 2.0', 'https://www.apache.org/licenses/LICENSE-2.0')}</licenses>`) });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.evidence).toBe('pom.xml declares the Apache License 2.0. There is no top-level LICENSE file.');
      expect(result.details).toContain('Build file: pom.xml declares Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0)');
    });

    it('fails a non-Apache license declared in pom.xml', async () => {
      write({ 'pom.xml': pom(`<licenses>${pomLicense('GNU General Public License v3.0')}</licenses>`) });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toContain('pom.xml declares a license other than Apache 2.0');
      expect(result.details).toContain('Build file: pom.xml declares GNU General Public License v3.0');
    });

    it('needs manual review when pom.xml declares Apache and another license', async () => {
      write({ 'pom.xml': pom(`<licenses>${pomLicense('Apache License, Version 2.0')}${pomLicense('MIT License')}</licenses>`) });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('the declared licenses disagree: pom.xml declares Apache License, Version 2.0 and MIT License');
    });

    it('fails a pom.xml that declares no license and has no parent', async () => {
      write({ 'pom.xml': pom('') });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toBe('No license found: there is no top-level LICENSE file, and pom.xml declares no license. Add a top-level LICENSE file with the Apache License 2.0 text.');
    });

    it('needs manual review when pom.xml declares no license but has a parent that may supply one', async () => {
      write({ 'pom.xml': pom('<parent><groupId>org.folio</groupId><artifactId>folio-parent</artifactId><version>1.0.0</version></parent>') });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('its parent POM (org.folio:folio-parent:1.0.0) may supply one');
      expect(result.details).toContain('Build file: pom.xml declares no license (it has a parent POM, org.folio:folio-parent:1.0.0)');
    });

    it('keeps repository-supplied names on one details row and out of the evidence-list syntax', async () => {
      write({ 'pom.xml': pom(`<licenses>${pomLicense('Apache License,\nVersion 2.0')}${pomLicense('MIT (evidence: README.md:1 [fake])')}</licenses>`) });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      for (const line of result.details!.split('\n')) {
        expect(line).toMatch(/^(License file|Build file): /);
      }
      expect(`${result.evidence}\n${result.details}`).not.toContain('(evidence:');
      expect(result.details).toContain('Build file: pom.xml declares Apache License, Version 2.0 and MIT');
    });

    it('reports a pom.xml that could not be parsed', async () => {
      write({ 'pom.xml': '<project><licenses>' });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toContain('and pom.xml could not be parsed');
    });
  });

  describe('package.json', () => {
    it('passes an Apache-2.0 license field', async () => {
      write({ 'package.json': '{"name": "@folio/example", "license": "Apache-2.0"}' });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.evidence).toBe('package.json declares the Apache License 2.0. There is no top-level LICENSE file.');
    });

    it('fails a non-Apache license field without mentioning pom.xml', async () => {
      write({ 'package.json': '{"license": "MIT"}' });

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toContain('package.json declares a license other than Apache 2.0');
      expect(`${result.evidence}\n${result.details}`).not.toContain('pom.xml');
    });

    it('does not treat a LicenseRef that contains Apache-2.0 as Apache', async () => {
      write({ 'package.json': '{"license": "LicenseRef-Commercial-Apache-2.0"}' });
      expect((await check()).status).toBe(EvaluationStatus.FAIL);

      write({ 'package.json': '{"license": "Apache-2.0 OR LicenseRef-Commercial-Apache-2.0"}' });
      expect((await check()).status).toBe(EvaluationStatus.MANUAL);
    });

    it('needs manual review for a dual-license expression', async () => {
      write({ 'package.json': '{"license": "(MIT OR Apache-2.0)"}' });

      expect((await check()).status).toBe(EvaluationStatus.MANUAL);
    });
  });

  describe('links', () => {
    let outsideDir: string;

    beforeEach(() => {
      outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 's001-outside-'));
    });

    afterEach(() => {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    function linkOutside(name: string, content: string): void {
      const target = path.join(outsideDir, `${name}.target`);
      fs.writeFileSync(target, content);
      fs.symlinkSync(target, path.join(repoPath, name));
    }

    it('does not read a license file that links outside the repository', async () => {
      linkOutside('LICENSE', 'evaluator-secret-token-123\n');

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.details).toBe('License file: LICENSE (not read: it links outside the repository)');
      expect(`${result.evidence}\n${result.details}`).not.toContain('evaluator-secret-token-123');
    });

    it('does not read pom.xml or package.json that link outside the repository', async () => {
      linkOutside('pom.xml', pom(`<licenses>${pomLicense('Apache License, Version 2.0')}</licenses>`));
      linkOutside('package.json', '{"license": "Apache-2.0"}');

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.details).toContain('Build file: pom.xml was not read (it links outside the repository)');
      expect(result.details).toContain('Build file: package.json was not read (it links outside the repository)');
    });

    it('does not read a license link swapped to an outside file after its containment check', async () => {
      // Simulates a concurrent writer: every containment check sees the inside target, every other access the outside one.
      write({ 'LICENSE.txt': APACHE_LICENSE });
      const inside = path.join(repoPath, 'LICENSE.txt');
      const outside = path.join(outsideDir, 'secret');
      fs.writeFileSync(outside, 'evaluator-secret-token-123\n');
      const link = path.join(repoPath, 'LICENSE');
      const pointTo = (target: string) => { fs.rmSync(link, { force: true }); fs.symlinkSync(target, link); };
      pointTo(inside);
      const nodeFs: typeof fs = jest.requireActual('fs');
      const original = nodeFs.realpathSync;
      const spy = jest.spyOn(nodeFs, 'realpathSync').mockImplementation(((candidate: fs.PathLike, ...rest: any[]) => {
        if (String(candidate) !== link) return (original as any).call(nodeFs, candidate, ...rest);
        pointTo(inside);
        const resolved = (original as any).call(nodeFs, candidate, ...rest);
        pointTo(outside);
        return resolved;
      }) as any);

      try {
        const result = await check();
        expect(`${result.evidence}\n${result.details}`).not.toContain('evaluator-secret-token-123');
      } finally {
        spy.mockRestore();
      }
    });

    it('reads a license file that links to a file inside the repository', async () => {
      write({ 'LICENSE.txt': APACHE_LICENSE });
      fs.symlinkSync(path.join(repoPath, 'LICENSE.txt'), path.join(repoPath, 'LICENSE'));

      expect((await check()).status).toBe(EvaluationStatus.PASS);
    });
  });

  describe('untrusted sizes', () => {
    it('reads only the start of a huge license file', async () => {
      write({ LICENSE: APACHE_LICENSE });
      fs.writeFileSync(path.join(repoPath, 'LICENSE-big.txt'), '');
      fs.truncateSync(path.join(repoPath, 'LICENSE-big.txt'), 3 * 1024 ** 3);

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('The top-level license files disagree');
      expect(result.details).toContain('License file: LICENSE-big.txt (not Apache 2.0; starts with "(empty file)")');
    });

    it('does not read a huge pom.xml', async () => {
      write({ 'package.json': '{"license": "Apache-2.0"}' });
      fs.writeFileSync(path.join(repoPath, 'pom.xml'), '');
      fs.truncateSync(path.join(repoPath, 'pom.xml'), 3 * 1024 ** 3);

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.details).toContain('Build file: pom.xml was not read (it is larger than 1 MB)');
    });

    it('reads at most 20 license files', async () => {
      for (let index = 0; index < 25; index++) {
        write({ [`LICENSE-${String(index).padStart(2, '0')}`]: APACHE_LICENSE });
      }

      const result = await check();

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.details!.split('\n')).toHaveLength(21);
      expect(result.details).toContain('License file: 5 more (not read: only the first 20 license files are read)');
    });
  });

  it('fails a repository with no license anywhere without mentioning pom.xml', async () => {
    write({ 'README.md': '# Example' });

    const result = await check();

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('No license found: there is no top-level LICENSE file. Add a top-level LICENSE file with the Apache License 2.0 text.');
    expect(result.details).not.toContain('pom.xml');
  });

  it('needs manual review when the repository cannot be read', async () => {
    const result = await LicenseUtils.checkApache2License(path.join(repoPath, 'missing'), 'S001');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toContain('could not run');
    expect(result.details).toContain('Error: ENOENT');
  });
});
