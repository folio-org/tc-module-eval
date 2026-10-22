import { promises as fs } from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import { CriterionResult, EvaluationStatus } from '../types';
import { isWithinRepo, realPath } from './repo-files';

// Top-level LICENSE, LICENCE or COPYING files in any case, with or without a suffix (LICENSE.md, LICENSE-2.0.txt).
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying)([-._].*)?$/i;
const NO_LICENSE_FILE_ROW = 'License file: none (looked for top-level LICENSE, LICENCE and COPYING files in any case, with any extension)';
// A license file must name its license in these first non-empty lines; later text may be appended third-party notices.
const LICENSE_HEADER_LINES = 10;
const APACHE_2_TITLE = /apache license,?\s*(?:version\s*2\.0|v?2\.0)|\bapache-2\.0\b/i;
const OTHER_LICENSE_TITLE = /\bMIT License\b|\bGeneral Public License\b|\bBSD(?:[- ]\d-Clause)? License\b|\bMozilla Public License\b|\bEclipse Public License\b|\bISC License\b|\bCreative Commons\b|\bThe Unlicense\b|SPDX-License-Identifier:\s*(?!Apache-2\.0\b)\S/i;
const MAX_FIRST_LINE_LENGTH = 120;
const MAX_ERROR_LENGTH = 200;

export interface LicenseFileFinding {
  name: string;
  isApache2: boolean;
  firstLine: string;
  // Why the file was not read; set for links that resolve outside the repository or nowhere.
  notRead?: string;
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
    for (const name of names) {
      const file = await readRepoFile(repoPath, name);
      if (file.status === 'missing') continue;
      if (file.status === 'not_read') {
        findings.push({ name, isApache2: false, firstLine: '', notRead: file.reason });
        continue;
      }
      const content = file.content;
      const firstLine = content.split('\n').map(line => line.trim()).find(Boolean) ?? '';
      findings.push({ name, isApache2: this.isApache2License(content), firstLine: bound(firstLine, MAX_FIRST_LINE_LENGTH) });
    }
    return findings;
  }

  static async checkMavenLicense(repoPath: string): Promise<BuildFileFinding> {
    const file = await readRepoFile(repoPath, 'pom.xml');
    if (file.status !== 'read') {
      return { file: 'pom.xml', ...file };
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
        ? [parent.groupId?.[0], parent.artifactId?.[0], parent.version?.[0]].filter(Boolean).join(':') || 'unnamed parent'
        : undefined;
      return { file: 'pom.xml', status: 'no_license', parent: parentId };
    }

    return {
      file: 'pom.xml',
      status: 'declared',
      licenses: licenses.map(license => declaredLicense(textOf(license?.name), textOf(license?.url)))
    };
  }

  static async checkPackageJsonLicense(repoPath: string): Promise<BuildFileFinding> {
    const file = await readRepoFile(repoPath, 'package.json');
    if (file.status !== 'read') {
      return { file: 'package.json', ...file };
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
    if (typeof license === 'string' && license.trim()) {
      // SPDX expression such as "Apache-2.0" or "(MIT OR Apache-2.0)"; each named license counts.
      license.replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+/i).map(part => part.trim()).filter(Boolean)
        .forEach(part => licenses.push(declaredLicense(part, '')));
    } else if (license && typeof license === 'object') {
      licenses.push(declaredLicense(textOf(license.type), textOf(license.url)));
    }
    if (Array.isArray(legacyLicenses)) {
      legacyLicenses.forEach(entry => licenses.push(declaredLicense(textOf(entry?.type), textOf(entry?.url))));
    }

    return licenses.length
      ? { file: 'package.json', status: 'declared', licenses }
      : { file: 'package.json', status: 'no_license' };
  }

  /**
   * True when the top of a license file names the Apache License 2.0 (its title and version, or an
   * Apache-2.0 SPDX id) before any other license. Mentions further down, such as notices for bundled
   * third-party code, do not count.
   */
  static isApache2License(content: string): boolean {
    const header = content.split('\n').map(line => line.trim()).filter(Boolean).slice(0, LICENSE_HEADER_LINES).join(' ');
    const apache = header.search(APACHE_2_TITLE);
    const other = header.search(OTHER_LICENSE_TITLE);
    return apache >= 0 && (other < 0 || apache < other);
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
    const details = files.map(file => file.notRead
      ? `License file: ${file.name} (not read: ${file.notRead})`
      : file.isApache2
        ? `License file: ${file.name} (Apache License 2.0)`
        : `License file: ${file.name} (not Apache 2.0; starts with "${file.firstLine || '(empty file)'}")`
    ).join('\n');
    const apache = files.filter(file => file.isApache2).map(file => file.name);
    const other = files.filter(file => !file.isApache2 && !file.notRead).map(file => file.name);
    const unread = files.filter(file => file.notRead).map(file => file.name);

    // An unread file could hold any license, so the result cannot be decided automatically.
    if (unread.length) {
      return {
        criterionId,
        status: EvaluationStatus.MANUAL,
        evidence: `The license ${unread.length === 1 ? 'file' : 'files'} ${joinNames(unread)} ${unread.length === 1 ? 'was' : 'were'} not read because ${unread.length === 1 ? 'it links' : 'they link'} outside the repository or to a missing file. A reviewer must check the license; replace ${unread.length === 1 ? 'the link' : 'the links'} with a top-level LICENSE file containing the Apache License 2.0 text.`,
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

function declaredLicense(name: string, url: string): DeclaredLicense {
  return { name: name || url || '(no name given)', url: url || undefined, isApache2: LicenseUtils.isApache2LicenseDeclaration(name, url) };
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

type RepoFile = { status: 'read'; content: string } | { status: 'missing' } | { status: 'not_read'; reason: string };

// The evaluated repository is untrusted: never follow a link out of it, or its target's text could reach the report.
async function readRepoFile(repoPath: string, name: string): Promise<RepoFile> {
  const filePath = path.join(repoPath, name);
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    throw error;
  }
  if (!realPath(filePath)) return { status: 'not_read', reason: 'it is a broken link' };
  if (!isWithinRepo(repoPath, filePath)) return { status: 'not_read', reason: 'it links outside the repository' };
  if (!(await fs.stat(filePath)).isFile()) return { status: 'missing' };
  return { status: 'read', content: await fs.readFile(filePath, 'utf-8') };
}

function textOf(value: unknown): string {
  const item = Array.isArray(value) ? value[0] : value;
  return typeof item === 'string' ? item.trim() : '';
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function errorText(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
  return bound(message, MAX_ERROR_LENGTH);
}

function bound(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
