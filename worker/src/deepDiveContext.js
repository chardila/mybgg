export function extractFrontmatterField(content, key) {
  if (!content) return null;
  const match = content.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, 'm'));
  return match ? match[1].trim() : null;
}

function gameDisplayName(entry, includeEdition) {
  const name = extractFrontmatterField(entry.index, 'name');
  if (!name) return entry.slug.replace(/-/g, ' ');
  if (!includeEdition) return name;
  const edition = extractFrontmatterField(entry.index, 'edition');
  return edition ? `${name} (${edition})` : name;
}

function baseSections(entry) {
  return [
    entry.index && `## Overview\n${entry.index}`,
    entry.rules && `## Rules\n${entry.rules}`,
    entry.teaching && `## Teaching Guide\n${entry.teaching}`,
    entry.faq && `## FAQ\n${entry.faq}`,
    entry.glossary && `## Glossary\n${entry.glossary}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function expansionBody(entry) {
  return [
    entry.index && `### Overview\n${entry.index}`,
    entry.rules && `### Rules (additions)\n${entry.rules}`,
    entry.teaching && `### Teaching Guide\n${entry.teaching}`,
    entry.faq && `### FAQ\n${entry.faq}`,
    entry.glossary && `### Glossary\n${entry.glossary}`,
  ].filter(Boolean);
}

export function buildDeepDiveContext({ base, expansions, promptFn }) {
  const baseName = gameDisplayName(base, true);

  const included = expansions
    .map((entry) => ({
      name: gameDisplayName(entry, false),
      body: expansionBody(entry),
    }))
    .filter((e) => e.body.length > 0);

  const combinedName = [baseName, ...included.map((e) => e.name)].join(' + ');

  const blocks = [
    baseSections(base),
    ...included.map((e) => `## Expansion: ${e.name}\n${e.body.join('\n\n')}`),
  ].filter(Boolean);

  return `${promptFn(combinedName)}\n\n${blocks.join('\n\n')}`;
}
