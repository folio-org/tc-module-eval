import { reportPath, reportText } from '../utils/report-text';

describe('report text helpers', () => {
  it.each([
    ['line breaks of every kind', 'a\nb\r\nc\rd\u2028e\u0085f', 'a ↵ b ↵ c ↵ d ↵ e ↵ f'],
    ['other control characters', 'bell\u0007 nul\u0000', 'bell\\u0007 nul\\u0000'],
    ['the evidence-list syntax', 'note (evidence: README.md:1 [docs])', 'note [evidence: README.md:1 [docs])'],
    ['a whole value reading like the overflow marker', '... 12 more', '… 12 more'],
    ['ordinary text', 'Tabs\tand "quotes" stay; ... 3 more inside a sentence too', 'Tabs\tand "quotes" stay; ... 3 more inside a sentence too']
  ])('keeps %s inside one report row', (_case, value, expected) => {
    expect(reportText(value)).toBe(expected);
  });

  it('percent-encodes every path character a row lead or tag could be built from', () => {
    expect(reportPath('src/main/java/Foo_Bar-1.2.java')).toBe('src/main/java/Foo_Bar-1.2.java');
    expect(reportPath('README.md:900 [schema] x.md')).toBe('README.md%3A900%20%5Bschema%5D%20x.md');
    expect(reportPath('100%\nÜ.md')).toBe('100%25%0A%C3%9C.md');
    expect(decodeURIComponent(reportPath('docs/a b(1)%.md'))).toBe('docs/a b(1)%.md');
  });
});
