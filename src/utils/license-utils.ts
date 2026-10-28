import { constants as fsConstants, promises as fs } from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import { CriterionResult, EvaluationStatus } from '../types';
import { isWithinRepo, realPath } from './repo-files';
import { reportText } from './report-text';
import { errorMessage } from './type-guards';

// Top-level LICENSE, LICENCE or COPYING files in any case, with an optional single suffix (LICENSE-2.0, LICENSE-MIT)
// and extension (LICENSE.md, LICENSE-2.0.txt). Multi-word names such as LICENSE-THIRD-PARTY.txt or
// LICENSE_LIST_MANAGEMENT.md are notices or documentation, not the module's license.
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)(?:[-_][a-z0-9]+(?:\.[0-9]+)*)?(?:\.[a-z0-9]+)?$/i;
const NO_LICENSE_FILE_ROW = 'License file: none (looked for top-level LICENSE, LICENCE and COPYING files in any case, with any extension)';
// A license file must name its license in these first non-empty lines; later text may be appended third-party notices.
const LICENSE_HEADER_LINES = 10;
// A header line (joined with the next one, for titles split over two lines) that names Apache 2.0 as the file's own license.
const APACHE_2_HEADER = /^(?:the\s+)?apache\s+(?:software\s+)?license,?\s*(?:version\s*)?v?2\.0\b|^SPDX-License-Identifier:\s*Apache-2\.0\s*$|^Apache-2\.0$|\b(?:licensed|distributed)\s+under\s+(?:the\s+terms\s+of\s+)?the\s+apache\s+license,?\s*(?:version\s*)?2\.0\b/i;
const OTHER_LICENSE_HEADER = /\bMIT License\b|Permission is hereby granted, free of charge|\bGeneral Public License\b|\bBSD(?:[- ]\d-Clause)? License\b|\bMozilla Public License\b|\bEclipse Public License\b|\bISC License\b|\bCreative Commons\b|\bThe Unlicense\b|\bapache\s+(?:software\s+)?license,?\s*(?:version\s*)?v?1\.\d|SPDX-License-Identifier:\s*(?!Apache-2\.0\s*$)\S/i;
const MAX_FIRST_LINE_LENGTH = 120;
const MAX_ERROR_LENGTH = 200;
// Bounds for untrusted repositories: only the start of a license file is needed to classify it.
const MAX_LICENSE_FILES = 20;
const MAX_LICENSE_FILE_BYTES = 64 * 1024;
const MAX_BUILD_FILE_BYTES = 1024 * 1024;

export interface LicenseFileFinding {
  name: string;
  isApache2: boolean;
  firstLine: string;
  notReadReason?: string;
}

export interface DeclaredLicense {
  name: string;
  url?: string;
  isApache2: boolean;
}

export type BuildFileFinding =
  | { file: 'pom.xml' | 'package.json'; status: 'missing' }
  | { file: 'pom.xml' | 'package.json'; status: 'unparseable'; error: string }
  | { file: 'pom.xml' | 'package.json'; status: 'not_read'; reason: string }
  | { file: 'pom.xml' | 'package.json'; status: 'no_license'; parent?: string }
  | { file: 'pom.xml' | 'package.json'; status: 'declared'; licenses: DeclaredLicense[] };

/**
 * S001: the module must use the Apache License 2.0. Top-level license files decide the result;
 * licenses declared in pom.xml or package.json are used only when there is no license file.
 */
export class LicenseUtils {
  static async checkApache2License(repoPath: string, criterionId: string): Promise<CriterionResult> {
    try {
      const files = await this.findLicenseFiles(repoPath);
      if (files.length) {
        return this.licenseFileResult(criterionId, files);
      }

      const buildFiles = [await this.checkMavenLicense(repoPath), await this.checkPackageJsonLicense(repoPath)]
        .filter(finding => finding.status !== 'missing');
      return this.buildFileResult(criterionId, buildFiles);
    } catch (error) {
      return this.createErrorResult(criterionId, error);
    }
  }

  static async findLicenseFiles(repoPath: string): Promise<LicenseFileFinding[]> {
    const entries = await fs.readdir(repoPath, { withFileTypes: true });
    const names = entries
      .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && LICENSE_FILE_PATTERN.test(entry.name))
      .map(entry => entry.name)
      .sort();

    const findings: LicenseFileFinding[] = [];
    for (const name of names.slice(0, MAX_LICENSE_FILES)) {
      const file = await readRepoFile(repoPath, name, MAX_LICENSE_FILE_BYTES);
      if (file.status === 'missing') continue;
      if (file.status === 'not_read') {
        findings.push({ name: display(name), isApache2: false, firstLine: '', notReadReason: file.reason });
        continue;
      }
      const content = file.content;
      const firstLine = display(content.split('\n').find(line => display(line)) ?? '');
      findings.push({ name: display(name), isApache2: this.isApache2License(content), firstLine: bound(firstLine, MAX_FIRST_LINE_LENGTH) });
    }
    if (names.length > MAX_LICENSE_FILES) {
      findings.push({
        name: `${names.length - MAX_LICENSE_FILES} more`,
        isApache2: false,
        firstLine: '',
        notReadReason: `only the first ${MAX_LICENSE_FILES} license files are read`
      });
    }
    return findings;
  }

  static async checkMavenLicense(repoPath: string): Promise<BuildFileFinding> {
    const file = await readRepoFile(repoPath, 'pom.xml', MAX_BUILD_FILE_BYTES);
    if (file.status !== 'read') {
      return { file: 'pom.xml', ...file };
    }
    if (file.truncated) {
      return { file: 'pom.xml', status: 'not_read', reason: 'it is larger than 1 MB' };
    }
    const content = file.content;

    let project: any;
    try {
      project = (await new xml2js.Parser().parseStringPromise(content))?.project;
    } catch (error) {
      return { file: 'pom.xml', status: 'unparseable', error: errorText(error) };
    }
    if (!project) {
      return { file: 'pom.xml', status: 'unparseable', error: 'no <project> element' };
    }

    const licenses: any[] = project.licenses?.[0]?.license ?? [];
    if (!licenses.length) {
      const parent = project.parent?.[0];
      const parentId = parent
        ? display([textOf(parent.groupId), textOf(parent.artifactId), textOf(parent.version)].filter(Boolean).join(':')) || 'unnamed parent'
        : undefined;
      return { file: 'pom.xml', status: 'no_license', parent: parentId };
    }

    return {
      file: 'pom.xml',
      status: 'declared',
      licenses: licenses.map(license => {
        const name = textOf(license?.name);
        const url = textOf(license?.url);
        return declaredLicense(name, url, this.isApache2LicenseDeclaration(name, url));
      })
    };
  }

  static async checkPackageJsonLicense(repoPath: string): Promise<BuildFileFinding> {
    const file = await readRepoFile(repoPath, 'package.json', MAX_BUILD_FILE_BYTES);
    if (file.status !== 'read') {
      return { file: 'package.json', ...file };
    }
    if (file.truncated) {
      return { file: 'package.json', status: 'not_read', reason: 'it is larger than 1 MB' };
    }
    const content = file.content;

    let packageJson: any;
    try {
      packageJson = JSON.parse(content);
    } catch (error) {
      return { file: 'package.json', status: 'unparseable', error: errorText(error) };
    }

    const licenses: DeclaredLicense[] = [];
    const { license, licenses: legacyLicenses } = packageJson ?? {};
    // package.json uses SPDX ids, so only the exact Apache-2.0 id counts (not e.g. LicenseRef-Commercial-Apache-2.0).
    const spdxLicense = (id: string, url: string) =>
      declaredLicense(id, url, /^apache-2\.0$/i.test(id) || /^https?:\/\/(?:www\.)?apache\.org\/licenses\/license-2\.0(?:\.txt|\.html)?$/i.test(url));
    if (typeof license === 'string' && license.trim()) {
      // SPDX expression such as "Apache-2.0" or "(MIT OR Apache-2.0)"; each named license counts.
      license.replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+/i).map(part => part.trim()).filter(Boolean)
        .forEach(part => licenses.push(spdxLicense(part, '')));
    } else if (license && typeof license === 'object') {
      licenses.push(spdxLicense(textOf(license.type), textOf(license.url)));
    }
    if (Array.isArray(legacyLicenses)) {
      legacyLicenses.forEach(entry => licenses.push(spdxLicense(textOf(entry?.type), textOf(entry?.url))));
    }

    return licenses.length
      ? { file: 'package.json', status: 'declared', licenses }
      : { file: 'package.json', status: 'no_license' };
  }

  /**
   * True when the top of a license file names the Apache License 2.0 as its own license (its title and
   * version, the standard "licensed under" notice, or an Apache-2.0 SPDX id) before any other license.
   * Other mentions of Apache-2.0, such as notices for bundled third-party code, do not count.
   */
  static isApache2License(content: string): boolean {
    const header: string[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) header.push(trimmed);
      if (header.length > LICENSE_HEADER_LINES) break;
    }
    for (let index = 0; index < Math.min(header.length, LICENSE_HEADER_LINES); index++) {
      if (APACHE_2_HEADER.test(header[index]) || APACHE_2_HEADER.test(`${header[index]} ${header[index + 1] ?? ''}`)) return true;
      if (OTHER_LICENSE_HEADER.test(header[index])) return false;
    }
    return false;
  }

  static isApache2LicenseDeclaration(name: string, url: string): boolean {
    const normalizedName = name.toLowerCase();
    const normalizedUrl = url.toLowerCase();

    return (
      normalizedName.includes('apache') && normalizedName.includes('2.0')
    ) || (
      normalizedUrl.includes('apache.org/licenses/license-2.0')
    ) || (
      normalizedName.includes('apache-2.0')
    );
  }

  private static licenseFileResult(criterionId: string, files: LicenseFileFinding[]): CriterionResult {
    const details = files.map(file => file.notReadReason
      ? `License file: ${file.name} (not read: ${file.notReadReason})`
      : file.isApache2
        ? `License file: ${file.name} (Apache License 2.0)`
        : `License file: ${file.name} (not Apache 2.0; starts with "${file.firstLine || '(empty file)'}")`
    ).join('\n');
    const apache = files.filter(file => file.isApache2).map(file => file.name);
    const other = files.filter(file => !file.isApache2 && !file.notReadReason).map(file => file.name);
    const unread = files.filter(file => file.notReadReason);

    // An unread file could hold any license, so the result cannot be decided automatically.
    if (unread.length) {
      const reasons = [...new Set(unread.map(file => file.notReadReason))].join('; ');
      return {
        criterionId,
        status: EvaluationStatus.MANUAL,
        evidence: `Some top-level license files were not read (${reasons}). A reviewer must check the license; a FOLIO module needs one top-level LICENSE file containing the Apache License 2.0 text.`,
        details
      };
    }

    if (!other.length) {
      return {
        criterionId,
        status: EvaluationStatus.PASS,
        evidence: apache.length === 1
          ? `The ${apache[0]} file is the Apache License 2.0.`
          : `The license files (${apache.join(', ')}) are all the Apache License 2.0.`,
        details
      };
    }

    if (!apache.length) {
      return {
        criterionId,
        status: EvaluationStatus.FAIL,
        evidence: other.length === 1
          ? `The ${other[0]} file is not the Apache License 2.0. FOLIO modules must use Apache 2.0; replace ${other[0]} with the Apache License 2.0 text.`
          : `The license files (${other.join(', ')}) are not the Apache License 2.0. FOLIO modules must use Apache 2.0; replace them with a single LICENSE file containing the Apache License 2.0 text.`,
        details
      };
    }

    return {
      criterionId,
      status: EvaluationStatus.MANUAL,
      evidence: `The top-level license files disagree: ${joinNames(apache)} ${apache.length === 1 ? 'is' : 'are'} the Apache License 2.0, but ${joinNames(other)} ${other.length === 1 ? 'is' : 'are'} not. A reviewer must decide which license applies; FOLIO modules must use Apache 2.0 only, so remove or replace the other ${other.length === 1 ? 'file' : 'files'}.`,
      details
    };
  }

  private static buildFileResult(criterionId: string, buildFiles: BuildFileFinding[]): CriterionResult {
    const details = [NO_LICENSE_FILE_ROW, ...buildFiles.map(finding => `Build file: ${describeBuildFile(finding)}`)].join('\n');
    const declared = buildFiles.flatMap(finding => finding.status === 'declared' ? [finding] : []);
    const licenses = declared.flatMap(finding => finding.licenses);

    if (licenses.length && licenses.every(license => license.isApache2)) {
      const sources = declared.map(finding => finding.file);
      return {
        criterionId,
        status: EvaluationStatus.PASS,
        evidence: `${joinNames(sources)} ${sources.length === 1 ? 'declares' : 'declare'} the Apache License 2.0. There is no top-level LICENSE file.`,
        details
      };
    }

    if (licenses.some(license => license.isApache2)) {
      return {
        criterionId,
        status: EvaluationStatus.MANUAL,
        evidence: `There is no top-level LICENSE file, and the declared licenses disagree: ${declared.map(describeBuildFile).join('; ')}. A reviewer must decide which license applies; FOLIO modules must use Apache 2.0 only.`,
        details
      };
    }

    if (licenses.length) {
      const sources = declared.map(finding => finding.file);
      return {
        criterionId,
        status: EvaluationStatus.FAIL,
        evidence: `There is no top-level LICENSE file, and ${joinNames(sources)} ${sources.length === 1 ? 'declares a license' : 'declare licenses'} other than Apache 2.0. Add a top-level LICENSE file with the Apache License 2.0 text and declare Apache 2.0 in ${joinNames(sources)}.`,
        details
      };
    }

    const inheritingPom = buildFiles.find(finding => finding.status === 'no_license' && finding.parent);
    if (inheritingPom && inheritingPom.status === 'no_license') {
      return {
        criterionId,
        status: EvaluationStatus.MANUAL,
        evidence: `There is no top-level LICENSE file, and pom.xml declares no license, but its parent POM (${inheritingPom.parent}) may supply one. Check the parent POM's license, and add a top-level LICENSE file with the Apache License 2.0 text.`,
        details
      };
    }

    const buildFileStates = buildFiles.map(describeBuildFile);
    return {
      criterionId,
      status: EvaluationStatus.FAIL,
      evidence: `No license found: there is no top-level LICENSE file${buildFileStates.map(state => `, and ${state}`).join('')}. Add a top-level LICENSE file with the Apache License 2.0 text.`,
      details
    };
  }

  private static createErrorResult(criterionId: string, error: unknown): CriterionResult {
    return {
      criterionId,
      status: EvaluationStatus.MANUAL,
      evidence: 'The license check could not run, so a reviewer must check the license by hand.',
      details: `Error: ${errorText(error)}\nWhat to check: the repository has a top-level LICENSE file with the Apache License 2.0 text`
    };
  }
}

// Names and URLs come from the untrusted repository; display() keeps them to one report row.
function declaredLicense(name: string, url: string, isApache2: boolean): DeclaredLicense {
  return { name: display(name || url) || '(no name given)', url: display(url) || undefined, isApache2 };
}

function describeBuildFile(finding: BuildFileFinding): string {
  switch (finding.status) {
    case 'missing':
      return `${finding.file} not found`;
    case 'unparseable':
      return `${finding.file} could not be parsed (${finding.error})`;
    case 'not_read':
      return `${finding.file} was not read (${finding.reason})`;
    case 'no_license':
      if (finding.file === 'package.json') return 'package.json has no license field';
      return finding.parent
        ? `pom.xml declares no license (it has a parent POM, ${finding.parent})`
        : 'pom.xml declares no license';
    case 'declared':
      return `${finding.file} declares ${joinNames(finding.licenses.map(license =>
        license.url && license.url !== license.name ? `${license.name} (${license.url})` : license.name
      ))}`;
  }
}

type RepoFile =
  | { status: 'read'; content: string; truncated: boolean }
  | { status: 'missing' }
  | { status: 'not_read'; reason: string };

// The evaluated repository is untrusted: never follow a link out of it, or its target's text could reach the
// report, and never read more than maxBytes. The opened file itself is checked, so a link swapped after the
// containment check cannot redirect the read.
async function readRepoFile(repoPath: string, name: string, maxBytes: number): Promise<RepoFile> {
  const filePath = path.join(repoPath, name);
  let handle: fs.FileHandle;
  try {
    // O_NONBLOCK keeps a FIFO from blocking the open; it does not affect regular files.
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return await fs.lstat(filePath).then(() => true, () => false)
        ? { status: 'not_read', reason: 'it is a broken link' }
        : { status: 'missing' };
    }
    if (code === 'ELOOP') return { status: 'not_read', reason: 'it is a broken link' };
    throw error;
  }

  try {
    const opened = await handle.stat();
    const resolved = realPath(filePath);
    const current = resolved ? await fs.stat(resolved).catch(() => undefined) : undefined;
    if (!resolved || !current || current.dev !== opened.dev || current.ino !== opened.ino || !isWithinRepo(repoPath, resolved)) {
      return { status: 'not_read', reason: 'it links outside the repository' };
    }
    if (!opened.isFile()) return { status: 'missing' };

    const buffer = Buffer.alloc(Math.min(maxBytes, opened.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { status: 'read', content: buffer.subarray(0, bytesRead).toString('utf-8'), truncated: opened.size > maxBytes };
  } finally {
    await handle.close();
  }
}

// Collapses whitespace in repository-supplied text; reportText keeps it to one row and out of report syntax.
function display(text: string): string {
  return reportText(text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim());
}

function textOf(value: unknown): string {
  const item = Array.isArray(value) ? value[0] : value;
  return typeof item === 'string' ? item.trim() : '';
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function errorText(error: unknown): string {
  const message = errorMessage(error).split('\n')[0];
  return bound(display(message), MAX_ERROR_LENGTH);
}

function bound(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
