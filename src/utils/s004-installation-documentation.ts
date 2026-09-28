import * as fs from 'fs';
import * as path from 'path';
import {
  CriterionAgentReviewResult,
  EvaluationStatus,
  S004DeterministicClassification,
  S004DocumentationCandidate,
  S004DocumentationSignal,
  S004InstallationDocumentationResult,
  S004SignalGroup
} from '../types';
import { isWithinRepo, realPath, relativePosixPath } from './repo-files';
import { truncateToByteBudget } from './redaction';
import { evidenceStrengthRank } from './evidence-strength';

const ROOT_DOC_NAMES = ['README.md', 'README.MD', 'readme.md'];
const CONVENTIONAL_DOC_NAMES = ['INSTALL.md', 'INSTALLATION.md', 'DEPLOYMENT.md', 'RUNNING.md'];
const CONVENTIONAL_DOC_DIRS = ['docs', 'doc', 'deployment'];
const MAX_DOC_FILES = 40;
export const MAX_DOC_BYTES = 96 * 1024;
const MAX_LINK_DEPTH = 2;
const EXCERPT_RADIUS = 2;
const MAX_HEADING_INSTRUCTION_DISTANCE = 12;
const MAX_LINE_INSTRUCTION_DISTANCE = 4;
const COMMAND_PATTERNS = [
  /\bdocker\s+(?:compose(?:\s+(?:(?:-f|--file|-p|--project-name|--profile)\s+\S+))*\s+(?:up|down|build|pull|push|run|start|stop|restart|logs|ps)(?=\s|$)|(?:build|run|pull|push|start|stop|restart|exec|logs|inspect)(?=\s|$))/i,
  /\bcurl\s+(?:-[A-Za-z]|https?:\/\/)/i,
  /\bmvn\s+(?:(?:clean|compile|test|package|verify|install|deploy|spring-boot:run)\b|[\w.-]+:[\w.-]+\b)/i,
  /(?:\bgradle|\.\/gradlew)\s+(?:build|assemble|check|test|clean|bootRun|tasks|[\w.-]+:[\w.-]+)\b/i,
  /\bnpm\s+(?:install|ci|run\s+\S+|test|start|exec|publish|pack)\b/i,
  /\byarn\s+(?:install|run\s+\S+|test|start|build|add|remove|workspace\s+\S+\s+(?:run\s+\S+|test|build)|workspaces\s+(?:foreach|focus|list|info))\b/i,
  /\bpnpm\s+(?:install|run\s+\S+|test|start|build|add|remove|exec|deploy)\b/i,
  /\bkubectl\s+(?:apply|create|delete|get|describe|logs|exec|run|set|rollout|scale|wait|port-forward|config)\b/i,
  /\bhelm\s+(?:install|upgrade|uninstall|template|repo|dependency|lint|package|pull|push|list|status|test)\b/i,
  /\bjava\s+(?:-[^\s]|[^\s]+\.jar\b)/i
];
const INSTRUCTION_PATTERN = /\b(set|export|configure|create|post|enable|deploy|install|start|run|execute|use)\b/i;
const ENVIRONMENT_VARIABLE_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|(?:^|[\s`])(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/;
const CONCRETE_TARGET_PATTERN = /--[\w-]+|\bhttps?:\/\/|\b[^\s]+\.(?:ya?ml|json|properties|jar)\b|\b(?:ModuleDescriptor|Okapi|tenant)\b/i;

interface QueuedDoc {
  absolutePath: string;
  source: S004DocumentationCandidate['source'];
  depth: number;
}

interface SignalRule {
  group: S004SignalGroup;
  label: string;
  pattern: RegExp;
  strength: S004DocumentationSignal['strength'];
}

const SIGNAL_RULES: SignalRule[] = [
  { group: 'install_deploy_run', label: 'Installation or deployment guidance', pattern: /\b(install|installation|deploy|deployment|running|run locally|start the module|enable the module)\b/i, strength: 'strong' },
  { group: 'docker_runtime', label: 'Docker or runtime dependency guidance', pattern: /\b(docker|docker compose|compose\.ya?ml|container|kafka|postgres|elasticsearch|opensearch|runtime dependenc)/i, strength: 'strong' },
  { group: 'env_configuration', label: 'Environment or configuration guidance', pattern: /\b(environment variable|env var|configuration|configure|settings|system property|yaml|properties)\b/i, strength: 'candidate' },
  { group: 'okapi_tenant_enablement', label: 'Okapi, tenant, or module enablement guidance', pattern: /\b(okapi|tenant|tenant init|enable module|module descriptor|_tenant)\b/i, strength: 'strong' },
  { group: 'stripes_setup', label: 'Stripes frontend setup guidance', pattern: /\b(stripes|yarn start|ui module|platform-complete)\b/i, strength: 'strong' },
  { group: 'build_test', label: 'Developer build instructions', pattern: /\b(compile|package|assemble|mvn\s+(clean\s+)?(install|package)|gradle(w)?\s+(build|assemble)|npm\s+run\s+build|yarn\s+build|pnpm\s+build)\b/i, strength: 'candidate' },
  { group: 'external_reference', label: 'External documentation reference', pattern: /https?:\/\/[^\s)]+/i, strength: 'candidate' }
];

export function analyzeS004Documentation(repoPath: string): S004InstallationDocumentationResult {
  const warnings: string[] = [];
  const candidates = discoverDocumentationCandidates(repoPath, warnings);
  const classification = classifyS004Documentation(candidates, warnings);

  return {
    candidates,
    classification,
    warnings
  };
}

export function classifyS004Documentation(
  candidates: S004DocumentationCandidate[],
  warnings: string[] = []
): S004DeterministicClassification {
  const allSignals = candidates.flatMap(candidate => candidate.signals);
  const strongOperationalSignals = allSignals.filter(signal => signal.strength === 'strong');
  const filesConsidered = candidates.map(candidate => candidate.path);

  const hasCandidateEvidence = allSignals.length > 0;
  const hasRunOrDeploy = strongOperationalSignals.some(signal => signal.group === 'install_deploy_run');
  const hasOkapiInstall = strongOperationalSignals.some(signal => signal.group === 'okapi_tenant_enablement');
  const hasRuntimeOrDocker = strongOperationalSignals.some(signal => signal.group === 'docker_runtime');
  const hasContext = allSignals.some(signal =>
    signal.group === 'env_configuration' ||
    signal.group === 'okapi_tenant_enablement' ||
    signal.group === 'stripes_setup' ||
    signal.group === 'docker_runtime'
  );

  if ((hasRunOrDeploy || hasOkapiInstall) && hasActionableExcerpt(strongOperationalSignals)) {
    return {
      status: EvaluationStatus.MANUAL,
      reason: 'Repository documentation includes strong installation, deployment, running, or Okapi enablement evidence, but S004 requires reviewer judgment.',
      strongestSignals: strongestSignals(allSignals),
      filesConsidered,
      warnings
    };
  }

  if ((hasRunOrDeploy || hasRuntimeOrDocker) && hasContext && strongOperationalSignals.length >= 2) {
    return {
      status: EvaluationStatus.MANUAL,
      reason: 'Repository documentation has distributed operational evidence with runtime, configuration, tenant, Okapi, Docker, or Stripes context, but S004 requires reviewer judgment.',
      strongestSignals: strongestSignals(allSignals),
      filesConsidered,
      warnings
    };
  }

  if (hasCandidateEvidence) {
    return {
      status: EvaluationStatus.MANUAL,
      reason: 'Candidate installation or operational documentation exists, but deterministic evidence is too thin to decide adequacy.',
      strongestSignals: strongestSignals(allSignals),
      filesConsidered,
      warnings
    };
  }

  return {
    status: EvaluationStatus.FAIL,
    reason: 'No plausible developer build, run, runtime, enablement, or configuration documentation was found.',
    strongestSignals: [],
    filesConsidered,
    warnings
  };
}

export function formatS004Evidence(
  result: S004InstallationDocumentationResult,
  agentReview?: CriterionAgentReviewResult
): { evidence: string; details: string } {
  const classification = result.classification;
  const evidence = `S004 ${classification.status}: ${classification.reason}`;
  const lines: Array<string | undefined> = [
    'Documentation files considered:',
    ...(classification.filesConsidered.length ? classification.filesConsidered.map(file => `  - ${file}`) : ['  - none']),
    '',
    'Strongest signals:',
    ...(classification.strongestSignals.length
      ? classification.strongestSignals.map(signal => `  - ${signal.path}${signal.line ? `:${signal.line}` : ''} [${signal.group}] ${signal.label}: ${signal.excerpt}`)
      : ['  - none']),
    ...(classification.warnings.length ? ['', 'Warnings:', ...classification.warnings.map(warning => `  - ${warning}`)] : [])
  ];

  if (agentReview) {
    const unavailableReason = !agentReview.available
      ? agentReview.errors.join('; ') || 'agent review was unavailable'
      : undefined;
    lines.push(
      '',
      'Agent review:',
      unavailableReason ? `  - Not available: ${unavailableReason}` : undefined,
      agentReview.recommendation ? `  - Advisory recommendation: ${agentReview.recommendation}` : undefined,
      agentReview.confidence ? `  - Confidence: ${agentReview.confidence}` : undefined,
      agentReview.summary ? `  - Summary: ${agentReview.summary}` : undefined,
      agentReview.rationale ? `  - Rationale: ${agentReview.rationale}` : undefined,
      agentReview.metadata ? `  - Adapter: ${agentReview.metadata.adapter}` : undefined,
      agentReview.metadata?.modelLabel ? `  - Model label: ${agentReview.metadata.modelLabel}` : undefined,
      agentReview.available && agentReview.errors.length ? `  - Errors: ${agentReview.errors.join('; ')}` : undefined
    );
  } else if (classification.status === EvaluationStatus.MANUAL) {
    lines.push('', 'Agent review:', `  - Not applied: ${result.agentReviewUnavailableReason ?? 'agent review is disabled or unconfigured'}`);
  }

  return {
    evidence,
    details: lines.filter((line): line is string => line !== undefined).join('\n')
  };
}

function discoverDocumentationCandidates(repoPath: string, warnings: string[]): S004DocumentationCandidate[] {
  const queue: QueuedDoc[] = [];
  const seen = new Set<string>();
  const candidates: S004DocumentationCandidate[] = [];

  for (const name of ROOT_DOC_NAMES) {
    enqueueIfFile(queue, path.join(repoPath, name), 'root-readme', 0);
  }
  for (const name of CONVENTIONAL_DOC_NAMES) {
    enqueueIfFile(queue, path.join(repoPath, name), 'conventional-doc', 0);
  }
  for (const directory of CONVENTIONAL_DOC_DIRS) {
    const absoluteDir = path.join(repoPath, directory);
    if (!fs.existsSync(absoluteDir)) {
      continue;
    }
    collectMarkdownFiles(absoluteDir, repoPath, queue, warnings);
  }

  while (queue.length && candidates.length < MAX_DOC_FILES) {
    const next = queue.shift()!;
    const real = realPath(next.absolutePath);
    const realKey = real?.toLowerCase();
    if (!realKey || seen.has(realKey)) {
      continue;
    }
    seen.add(realKey);

    if (!isWithinRepo(repoPath, next.absolutePath)) {
      warnings.push(`Skipped documentation path outside repository: ${next.absolutePath}`);
      continue;
    }

    const stats = fs.statSync(next.absolutePath);
    const relativePath = relativePosixPath(repoPath, next.absolutePath);
    const content = readBounded(next.absolutePath, warnings, relativePath);
    const signals = extractSignals(relativePath, content);
    candidates.push({
      path: relativePath,
      source: next.source,
      sizeBytes: Math.min(stats.size, MAX_DOC_BYTES),
      signals
    });

    if (next.depth < MAX_LINK_DEPTH) {
      for (const linkedPath of extractMarkdownLinks(content)) {
        const absoluteLinkedPath = path.resolve(path.dirname(next.absolutePath), linkedPath);
        if (!isWithinRepo(repoPath, absoluteLinkedPath)) {
          warnings.push(`Skipped repo-local documentation link outside repository: ${linkedPath}`);
          continue;
        }
        enqueueIfFile(queue, absoluteLinkedPath, 'linked-doc', next.depth + 1);
      }
    }
  }

  if (queue.length) {
    warnings.push(`Skipped ${queue.length} documentation files after reaching scan limit ${MAX_DOC_FILES}`);
  }

  return candidates;
}

function extractSignals(relativePath: string, content: string): S004DocumentationSignal[] {
  const lines = content.split(/\r?\n/);
  const fencedLines = markdownFenceMap(lines);
  const bestByGroup = new Map<S004SignalGroup, S004DocumentationSignal>();

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const rule of SIGNAL_RULES) {
      if (!rule.pattern.test(line)) {
        continue;
      }
      if (rule.group === 'install_deploy_run' && isDevelopmentInstallLine(line)) {
        continue;
      }
      const strength = contextualSignalStrength(lines, fencedLines, index, rule.strength);
      const evidenceIndex = strength === 'strong' ? concreteInstructionIndex(lines, fencedLines, index) : index;
      const signal = {
        group: rule.group,
        label: rule.label,
        path: relativePath,
        line: evidenceIndex + 1,
        excerpt: excerptAround(lines, evidenceIndex),
        strength
      };
      if (signal.strength === 'insufficient') {
        continue;
      }
      const previous = bestByGroup.get(rule.group);
      if (!previous || evidenceStrengthRank(signal.strength) < evidenceStrengthRank(previous.strength)) {
        bestByGroup.set(rule.group, signal);
      }
    }
  }

  return [...bestByGroup.values()];
}

function contextualSignalStrength(
  lines: string[],
  fencedLines: boolean[],
  index: number,
  configured: S004DocumentationSignal['strength']
): S004DocumentationSignal['strength'] {
  const line = lines[index].trim();
  if (isTableOfContentsLine(line) || /\b(error|failed|failure|cannot|unable to|troubleshoot)/i.test(line)) {
    return 'insufficient';
  }
  const context = localInstructionBlock(lines, fencedLines, index);
  if (isConcreteInstruction(context)) {
    return configured === 'candidate' ? 'candidate' : 'strong';
  }
  return configured === 'strong' ? 'candidate' : configured;
}

function localInstructionBlock(lines: string[], fencedLines: boolean[], index: number): string {
  const block = [lines[index]];
  const distance = instructionBlockDistance(lines[index], fencedLines[index]);
  for (let next = index + 1; next < lines.length && next <= index + distance; next++) {
    if (startsNewInstructionSection(lines[index], fencedLines[index], lines[next], fencedLines[next])) {
      break;
    }
    block.push(lines[next]);
  }
  return block.join('\n');
}

function concreteInstructionIndex(lines: string[], fencedLines: boolean[], index: number): number {
  const distance = instructionBlockDistance(lines[index], fencedLines[index]);
  for (let candidate = index; candidate < lines.length && candidate <= index + distance; candidate++) {
    if (candidate > index && startsNewInstructionSection(lines[index], fencedLines[index], lines[candidate], fencedLines[candidate])) {
      break;
    }
    if (isConcreteInstruction(lines[candidate])) {
      return candidate;
    }
  }
  return index;
}

function instructionBlockDistance(anchor: string, fenced: boolean): number {
  return !fenced && /^\s*#{1,6}\s+/.test(anchor)
    ? MAX_HEADING_INSTRUCTION_DISTANCE
    : MAX_LINE_INSTRUCTION_DISTANCE;
}

function startsNewInstructionSection(
  anchor: string,
  anchorFenced: boolean,
  candidate: string,
  candidateFenced: boolean
): boolean {
  if (candidateFenced) {
    return false;
  }
  const candidateLevel = candidate.match(/^\s*(#{1,6})\s+/)?.[1].length;
  if (!candidateLevel) {
    return false;
  }
  const anchorLevel = anchorFenced ? undefined : anchor.match(/^\s*(#{1,6})\s+/)?.[1].length;
  return anchorLevel === undefined || candidateLevel <= anchorLevel;
}

function markdownFenceMap(lines: string[]): boolean[] {
  const fencedLines: boolean[] = [];
  let marker: '`' | '~' | undefined;
  let markerLength = 0;

  for (const line of lines) {
    fencedLines.push(marker !== undefined);
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (!fence) {
      continue;
    }
    const candidateMarker = fence[1][0] as '`' | '~';
    if (marker === undefined) {
      marker = candidateMarker;
      markerLength = fence[1].length;
    } else if (candidateMarker === marker && fence[1].length >= markerLength) {
      marker = undefined;
      markerLength = 0;
    }
  }

  return fencedLines;
}

function isConcreteInstruction(value: string): boolean {
  return value.split(/\r?\n/).some(line =>
    COMMAND_PATTERNS.some(pattern => pattern.test(line))
      || (INSTRUCTION_PATTERN.test(line)
        && (ENVIRONMENT_VARIABLE_PATTERN.test(line) || CONCRETE_TARGET_PATTERN.test(line)))
  );
}

function isTableOfContentsLine(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+)?\[[^\]]+\]\(#[^)]+\)\s*$/i.test(line);
}

function strongestSignals(signals: S004DocumentationSignal[]): S004DocumentationSignal[] {
  return [...signals]
    .sort((left, right) => evidenceStrengthRank(left.strength) - evidenceStrengthRank(right.strength))
    .slice(0, 6);
}

function hasActionableExcerpt(signals: S004DocumentationSignal[]): boolean {
  return signals.some(signal => /\b(okapi|curl|docker|java|npm|yarn|pnpm|mvn|gradle|helm|kubectl|enable|install|deploy|run|configure|tenant)\b/i.test(signal.excerpt));
}

function isDevelopmentInstallLine(line: string): boolean {
  return /\b(mvn\s+(clean\s+)?install|npm\s+install|yarn\s+install|pnpm\s+install)\b/i.test(line);
}

function collectMarkdownFiles(directory: string, repoPath: string, queue: QueuedDoc[], warnings: string[]): void {
  for (const entry of fs.readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    const stats = fs.lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      warnings.push(`Skipped symlinked documentation path: ${relativePosixPath(repoPath, absolutePath)}`);
      continue;
    }
    if (stats.isDirectory()) {
      collectMarkdownFiles(absolutePath, repoPath, queue, warnings);
      continue;
    }
    if (/\.mdx?$/i.test(entry)) {
      enqueueIfFile(queue, absolutePath, 'conventional-doc', 0);
    }
  }
}

function enqueueIfFile(queue: QueuedDoc[], absolutePath: string, source: QueuedDoc['source'], depth: number): void {
  try {
    if (fs.statSync(absolutePath).isFile()) {
      queue.push({ absolutePath, source, depth });
    }
  } catch {
    // Missing conventional files are expected.
  }
}

function readBounded(absolutePath: string, warnings: string[], relativePath: string): string {
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.length <= MAX_DOC_BYTES) {
    return buffer.toString('utf-8');
  }
  warnings.push(`Truncated large documentation file ${relativePath} to ${MAX_DOC_BYTES} bytes`);
  return buffer.subarray(0, MAX_DOC_BYTES).toString('utf-8');
}

function extractMarkdownLinks(content: string): string[] {
  const links: string[] = [];
  const pattern = /\[[^\]]+\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const target = match[1].split('#')[0].trim();
    if (!target || /^https?:\/\//i.test(target) || !/\.mdx?$/i.test(target)) {
      continue;
    }
    links.push(target);
  }
  return links;
}

function excerptAround(lines: string[], index: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(lines.length, index + EXCERPT_RADIUS + 1);
  return truncateToByteBudget(lines.slice(start, end).join(' ').replace(/\s+/g, ' ').trim(), 700);
}
