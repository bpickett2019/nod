import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { loadSkills } from '@earendil-works/pi-coding-agent';
import type { SkillLibrary } from '../../ports/agent.ts';

function checkedPath(base: string, file: string) {
  const path = realpathSync(resolve(base, file));
  if (!path.startsWith(base + sep) || !path.endsWith('.md'))
    throw new Error('The skill file must be a Markdown file inside its skill directory.');
  if (!statSync(path).isFile()) throw new Error('The skill file must be a regular file.');
  return path;
}

function loadDirectory(directory: string, excluded: readonly string[], guidesOnly = false) {
  const root = realpathSync(directory);
  const skillPaths = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !excluded.includes(entry.name) &&
        (!guidesOnly || existsSync(resolve(root, entry.name, 'SKILL.md'))),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => checkedPath(resolve(root, entry.name), 'SKILL.md'));
  const { skills, diagnostics } = loadSkills({
    cwd: root,
    agentDir: root,
    skillPaths,
    includeDefaults: false,
  });
  if (
    diagnostics.length ||
    skills.length !== skillPaths.length ||
    skills.some((skill) => skill.name !== basename(skill.baseDir))
  )
    throw new Error(`The skill metadata in ${directory} is invalid.`);
  return skills
    .filter((skill) => !skill.disableModelInvocation)
    .map(({ name, description, baseDir }) => ({ name, description, base: baseDir, root }));
}

export function createSkillLibrary(
  directory: string,
  excluded: readonly string[] = [],
  organization?: string,
): SkillLibrary {
  const root = realpathSync(directory);
  const enabled = [
    ...loadDirectory(root, excluded),
    ...(organization ? loadDirectory(organization, [], true) : []),
  ];
  const names = enabled.map((skill) => skill.name);
  if (new Set(names).size !== names.length || names.some((name) => excluded.includes(name)))
    throw new Error('Organization skills must not reuse the name of a built-in guide.');
  const byName = new Map(enabled.map((skill) => [skill.name, skill]));
  return {
    core: excluded,
    catalog: enabled.map(({ name, description }) => ({ name, description: description.trim() })),
    read(name: string, file = 'SKILL.md') {
      const skill =
        byName.get(name) ??
        (excluded.includes(name) ? { base: resolve(root, name), root } : undefined);
      if (!skill || !skill.base.startsWith(skill.root + sep))
        throw new Error('Select a skill from the skill library.');
      return { name, file, content: readFileSync(checkedPath(skill.base, file), 'utf8').trim() };
    },
  };
}
