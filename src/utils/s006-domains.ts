import { S006DomainReview, S006ScanWarning } from '../types';
import { buildS006Warning, S006ScannedCandidateTextFile } from './s006-scanner';

const MAX_DOMAINS = 1000;
const MAX_DOMAIN_FILES = 4000;
const MAX_URL_LENGTH = 8192;

export function collectS006DomainReview(files: ReadonlyArray<S006ScannedCandidateTextFile>): {
  domainReview?: S006DomainReview;
  warnings: S006ScanWarning[];
} {
  const domains = new Map<string, S006DomainReview['domains'][number]>();
  const review: S006DomainReview = { emailCount: 0, urlCount: 0, omittedOccurrences: 0, domains: [] };
  let retainedFiles = 0;
  let omittedFiles = 0;
  let rejectedCandidates = 0;

  for (const file of files) {
    const fileCounts = new Map<string, { path: string; emailCount: number; urlCount: number }>();
    for (const { token, isUrl, end } of domainCandidates(file.text)) {
      if (file.truncated && end === file.text.length) {
        if (isUrl || token.includes('@')) rejectedCandidates++;
        continue;
      }
      let domain: string | undefined;
      if (isUrl) {
        if (token.length <= MAX_URL_LENGTH) {
          try {
            const url = new URL(token.replace(/[),.;!?]+$/, ''));
            const host = url.hostname.toLowerCase().replace(/\.$/, '');
            if (host.startsWith('[') || isDomain(host)) domain = host;
          } catch {
            domain = undefined;
          }
        }
        if (!domain) rejectedCandidates++;
      } else {
        if (file.text.startsWith('://', end)) {
          rejectedCandidates++;
          continue;
        }
        const at = token.indexOf('@');
        if (at < 1 || !token.slice(at + 1).includes('.')) continue;
        const local = token.slice(0, at);
        const host = token.slice(at + 1).replace(/\.$/, '').toLowerCase();
        if (local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') &&
          isDomain(host)) {
          domain = host;
        } else {
          rejectedCandidates++;
        }
      }
      if (!domain) continue;
      const kind = isUrl ? 'urlCount' : 'emailCount';
      review[kind]++;
      let group = domains.get(domain);
      if (!group) {
        if (domains.size >= MAX_DOMAINS) {
          review.omittedOccurrences++;
          continue;
        }
        group = { domain, emailCount: 0, urlCount: 0, fileCount: 0, files: [] };
        domains.set(domain, group);
      }
      group[kind]++;
      let counts = fileCounts.get(domain);
      if (!counts) {
        counts = { path: file.path, emailCount: 0, urlCount: 0 };
        fileCounts.set(domain, counts);
      }
      counts[kind]++;
    }
    for (const [domain, counts] of fileCounts) {
      const group = domains.get(domain)!;
      group.fileCount++;
      if (retainedFiles < MAX_DOMAIN_FILES) {
        group.files.push(counts);
        retainedFiles++;
      } else {
        omittedFiles++;
      }
    }
  }

  review.domains = [...domains.values()].sort((left, right) => left.domain.localeCompare(right.domain));
  const warnings: S006ScanWarning[] = [];
  if (review.omittedOccurrences || omittedFiles || rejectedCandidates) {
    warnings.push(buildS006Warning(
      'domain-review-limit',
      `Email and URL domain review retains at most ${MAX_DOMAINS} domains and ${MAX_DOMAIN_FILES} domain/file entries: ${review.omittedOccurrences} occurrences have unlisted domains, ${omittedFiles} file entries are unlisted, and ${rejectedCandidates} candidates could not be read (invalid, cut short, or a URL longer than ${MAX_URL_LENGTH} characters). Counts cover only the text the built-in scan read.`,
      true
    ));
  }
  return { ...(review.emailCount || review.urlCount ? { domainReview: review } : {}), warnings };
}

function* domainCandidates(text: string): Iterable<{ token: string; isUrl: boolean; end: number }> {
  const urls = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s<>"'`\\{}]+/gi;
  const ranges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = urls.exec(text)) !== null) {
    ranges.push({ start: match.index, end: urls.lastIndex });
    yield { token: match[0], isUrl: true, end: urls.lastIndex };
  }
  const emails = /[a-z0-9.!#$%&'*+/=?^_`{|}~@-]+/gi;
  let range = 0;
  while ((match = emails.exec(text)) !== null) {
    while (range < ranges.length && ranges[range].end <= match.index) range++;
    if (range < ranges.length && ranges[range].start < emails.lastIndex) continue;
    yield { token: match[0], isUrl: false, end: emails.lastIndex };
  }
}

function isDomain(host: string): boolean {
  return host.length > 0 && host.length <= 253 && host.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}
