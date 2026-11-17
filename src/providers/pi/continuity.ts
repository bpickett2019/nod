import type { compact } from '@earendil-works/pi-coding-agent';
import { untrustedBlock } from '../../shared/untrusted.ts';

type Preparation = Parameters<typeof compact>[0];
type Summarized = Preparation['messagesToSummarize'][number];

const ownerOpen = '<owner_messages>';
const ownerClose = '</owner_messages>';
const ownerNote =
  'The owner’s own messages from the summarized conversation, newest first, quoted exactly. Older ones may be missing; use history_search for them.';
const linksSource = 'earlier links';
const ownerPattern = new RegExp(`\\n*${ownerOpen}[\\s\\S]*?${ownerClose}`, 'g');
const linksPattern =
  /\n*<untrusted_tool_result source="earlier links">[\s\S]*?<\/untrusted_tool_result>/g;
const messageLimit = 2_000;
const linkLimit = 30;

function text(message: Summarized) {
  if (!('content' in message)) return '';
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => (part && part.type === 'text' ? [part.text] : [])).join('\n');
}

function ownerText(message: Summarized) {
  if (message.role !== 'user') return undefined;
  for (const line of text(message).split('\n').reverse()) {
    if (!line.startsWith('{') || !line.includes('"currentInstruction"')) continue;
    try {
      const data = JSON.parse(line) as { mode?: unknown; currentInstruction?: unknown };
      if (data.mode === 'background' || typeof data.currentInstruction !== 'string') return;
      const value = data.currentInstruction.trim();
      if (!value) return;
      return value.length > messageLimit
        ? `${value.slice(0, messageLimit)} …[shortened; history_search has the full message]`
        : value;
    } catch {
      return;
    }
  }
}

function previousLines(summary: string, pattern: RegExp, prefix: string) {
  return [...summary.matchAll(pattern)].flatMap((match) =>
    match[0].split('\n').flatMap((line) => (line.startsWith(prefix) ? [line] : [])),
  );
}

function within(lines: string[], budget: number) {
  const kept: string[] = [];
  let used = 0;
  for (const line of new Set(lines)) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept;
}

export function continuityNotes(preparation: Preparation, contextWindow: number) {
  const previous = preparation.previousSummary ?? '';
  const summarized = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const owner = within(
    [
      ...[...summarized].reverse().flatMap((message) => {
        const value = ownerText(message);
        return value === undefined
          ? []
          : [
              `- ${new Date(message.timestamp).toISOString().slice(0, 16)}Z ${JSON.stringify(value).replace(/</g, '\\u003c')}`,
            ];
      }),
      ...previousLines(previous, ownerPattern, '- '),
    ],
    Math.min(24_000, Math.floor(contextWindow / 10)),
  );
  const links = within(
    [
      ...[...summarized].reverse().flatMap((message) =>
        message.role === 'assistant' || message.role === 'toolResult'
          ? [...text(message).matchAll(/https?:\/\/[^\s"'<>)\]}`]+/g)]
              .reverse()
              .flatMap(([raw]) => {
                try {
                  const url = new URL(raw);
                  return [`- ${url.origin}${url.pathname}`];
                } catch {
                  return [];
                }
              })
          : [],
      ),
      ...previousLines(previous, linksPattern, '- '),
    ].slice(0, linkLimit * 4),
    2_500,
  ).slice(0, linkLimit);
  return {
    previousSummary: preparation.previousSummary
      ?.replace(ownerPattern, '')
      .replace(linksPattern, '')
      .trim(),
    notes:
      (owner.length ? `\n\n${ownerOpen}\n${ownerNote}\n${owner.join('\n')}\n${ownerClose}` : '') +
      (links.length
        ? `\n\n${untrustedBlock(linksSource, `Addresses seen earlier, without query strings:\n${links.join('\n')}`)}`
        : ''),
  };
}
