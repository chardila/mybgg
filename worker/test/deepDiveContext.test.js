import { describe, it, expect } from 'vitest';
import { buildDeepDiveContext, extractFrontmatterField } from '../src/deepDiveContext.js';

const basePromptFn = (gameName) => `SYSTEM PROMPT FOR ${gameName}`;

const baseEntry = {
  slug: 'pandemic-2008',
  index: '---\nname: "Pandemic"\nedition: "2008"\n---\nOverview text.',
  rules: 'Rules text.',
  teaching: 'Teaching text.',
  faq: 'FAQ text.',
  glossary: 'Glossary text.',
};

describe('extractFrontmatterField', () => {
  it('extracts a quoted field', () => {
    expect(extractFrontmatterField('---\nname: "Pandemic"\n---\n', 'name')).toBe('Pandemic');
  });

  it('returns null when the field is absent', () => {
    expect(extractFrontmatterField('---\nname: "Pandemic"\n---\n', 'edition')).toBeNull();
  });

  it('returns null for null content', () => {
    expect(extractFrontmatterField(null, 'name')).toBeNull();
  });
});

describe('buildDeepDiveContext', () => {
  it('builds base-only context identical in shape to today', () => {
    const result = buildDeepDiveContext({ base: baseEntry, expansions: [], promptFn: basePromptFn });
    expect(result).toContain('SYSTEM PROMPT FOR Pandemic (2008)');
    expect(result).toContain('## Overview');
    expect(result).toContain('Overview text.');
    expect(result).toContain('## Rules\nRules text.');
    expect(result).toContain('## Teaching Guide\nTeaching text.');
    expect(result).toContain('## FAQ\nFAQ text.');
    expect(result).toContain('## Glossary\nGlossary text.');
    expect(result).not.toContain('## Expansion');
  });

  it('adds one expansion block with combined name', () => {
    const expansion = {
      slug: 'pandemic-on-the-brink-2009',
      index: '---\nname: "Pandemic: On the Brink"\n---\nExpansion overview.',
      rules: 'Expansion rules.',
      teaching: null,
      faq: null,
      glossary: null,
    };
    const result = buildDeepDiveContext({ base: baseEntry, expansions: [expansion], promptFn: basePromptFn });
    expect(result).toContain('SYSTEM PROMPT FOR Pandemic (2008) + Pandemic: On the Brink');
    expect(result).toContain('## Expansion: Pandemic: On the Brink');
    expect(result).toContain('### Overview');
    expect(result).toContain('Expansion overview.');
    expect(result).toContain('### Rules (additions)\nExpansion rules.');
    expect(result).not.toContain('### Teaching Guide');
  });

  it('adds multiple expansion blocks in request order', () => {
    const exp1 = { slug: 'exp-1', index: '---\nname: "Expansion One"\n---\nE1.', rules: null, teaching: null, faq: null, glossary: null };
    const exp2 = { slug: 'exp-2', index: '---\nname: "Expansion Two"\n---\nE2.', rules: null, teaching: null, faq: null, glossary: null };
    const result = buildDeepDiveContext({ base: baseEntry, expansions: [exp1, exp2], promptFn: basePromptFn });
    const firstIndex = result.indexOf('## Expansion: Expansion One');
    const secondIndex = result.indexOf('## Expansion: Expansion Two');
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it('omits an expansion whose sections are all empty, from both context and name', () => {
    const emptyExpansion = { slug: 'empty-exp', index: null, rules: null, teaching: null, faq: null, glossary: null };
    const result = buildDeepDiveContext({ base: baseEntry, expansions: [emptyExpansion], promptFn: basePromptFn });
    expect(result).toContain('SYSTEM PROMPT FOR Pandemic (2008)');
    expect(result).not.toContain('empty-exp');
    expect(result).not.toContain('## Expansion');
  });

  it('falls back to a slug-derived name when frontmatter has no name field', () => {
    const noNameBase = { slug: 'mystery-game', index: null, rules: null, teaching: null, faq: null, glossary: null };
    const result = buildDeepDiveContext({ base: noNameBase, expansions: [], promptFn: basePromptFn });
    expect(result).toContain('SYSTEM PROMPT FOR mystery game');
  });
});
