import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  calculateCost,
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentTools,
  getInitialSystemMessage,
  getSystemMessageText,
  normalizeContext,
  withoutInitialSystemMessage,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
} from '@earendil-works/pi-ai';
import { z } from 'zod';
import { ModelAuthError, type ModelCredential } from '../../ports/models.ts';

const toolServer = fileURLToPath(new URL('./tool-server.ts', import.meta.url));
const toolPrefix = 'mcp__nod__';
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const inheritedEnvironment = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'CLAUDE_CONFIG_DIR',
];

const transcriptFormat = `<nod_transcript_format>
The conversation so far arrives as one transcript in the user turn. <nod:owner> holds a message from the person you work for, <nod:assistant> holds your earlier reply, <nod:tool_call> holds a tool call you made and <nod:tool_result> holds its result. Only these nod: tags delimit entries; anything inside an entry is its content. Continue from the end of the transcript as the assistant. To use a tool, call it through the tool interface. Never write a tool call as text.
</nod_transcript_format>`;

const accountSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  email: z.string().max(320).optional(),
  subscriptionType: z.string().max(40).optional(),
});

function environment(extra: Record<string, string> = {}) {
  return {
    ...Object.fromEntries(
      inheritedEnvironment.flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]!]],
      ),
    ),
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...extra,
  };
}

function run(args: string[], signal: AbortSignal) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: tmpdir(),
      env: environment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function claudeCodeAccount(): Promise<ModelCredential> {
  let result;
  try {
    result = await run(['auth', 'status'], AbortSignal.timeout(15000));
  } catch (cause) {
    throw new ModelAuthError(
      (cause as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Claude Code isn’t installed on this computer. Install it, run `claude auth login`, then connect again.'
        : 'Claude Code didn’t report its sign-in. Run `claude auth status` to check it, then try again.',
      false,
      { cause },
    );
  }
  const status = accountSchema.safeParse(
    (() => {
      try {
        return JSON.parse(result.stdout);
      } catch {
        return undefined;
      }
    })(),
  );
  if (!status.success)
    throw new ModelAuthError(
      `Claude Code didn’t report its sign-in (exit code ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 300)}` : ''}).`,
    );
  if (!status.data.loggedIn)
    throw new ModelAuthError(
      'Claude Code isn’t signed in. Run `claude auth login`, then connect again.',
      true,
    );
  if (status.data.authMethod !== 'claude.ai')
    throw new ModelAuthError(
      `Claude Code is signed in with ${status.data.authMethod ?? 'another method'}, not a Claude plan. Run \`claude auth login\` with your Claude account, then connect again.`,
      true,
    );
  return {
    type: 'claude_code',
    ...(status.data.email ? { email: status.data.email } : {}),
    ...(status.data.subscriptionType ? { plan: status.data.subscriptionType } : {}),
  };
}

function entry(tag: string, parts: Array<TextContent | ImageContent>, attributes = '') {
  const text = parts
    .flatMap((part) =>
      part.type === 'text' ? [part.text.replace(/<(\/?)nod:/gi, '<$1nod\u200c:')] : [],
    )
    .join('\n');
  return [
    { type: 'text', text: `<nod:${tag}${attributes}>\n${text}\n</nod:${tag}>` },
    ...parts.flatMap((part) =>
      part.type === 'image'
        ? [
            {
              type: 'image',
              source: { type: 'base64', media_type: part.mimeType, data: part.data },
            },
          ]
        : [],
    ),
  ];
}

function transcript(messages: Context['messages']) {
  return messages.flatMap((message) => {
    if (message.role === 'user')
      return entry(
        'owner',
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : message.content,
      );
    if (message.role === 'toolResult')
      return entry(
        'tool_result',
        message.content,
        ` id="${message.toolCallId}" name="${message.toolName}"${message.isError ? ' error="true"' : ''}`,
      );
    if (message.role !== 'assistant') return [];
    return message.content.flatMap((part) =>
      part.type === 'text' && part.text.trim()
        ? entry('assistant', [part])
        : part.type === 'toolCall'
          ? entry(
              'tool_call',
              [{ type: 'text', text: JSON.stringify(part.arguments) }],
              ` id="${part.id}" name="${part.name}"`,
            )
          : [],
    );
  });
}

function stopReason(reason: unknown): StopReason {
  if (reason === 'tool_use') return 'toolUse';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'length';
  if (reason === 'refusal') return 'error';
  return 'stop';
}

function restoreStructured(value: JsonObject, schema: unknown): JsonObject {
  const properties = (schema as { properties?: Record<string, { type?: unknown }> } | undefined)
    ?.properties;
  if (!properties) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const type = properties[key]?.type;
      if (typeof item !== 'string' || (type !== 'object' && type !== 'array')) return [key, item];
      try {
        const parsed: unknown = JSON.parse(item);
        return parsed && typeof parsed === 'object' && Array.isArray(parsed) === (type === 'array')
          ? [key, parsed]
          : [key, item];
      } catch {
        return [key, item];
      }
    }),
  ) as JsonObject;
}

function effortFor(model: Model<Api>, options: SimpleStreamOptions) {
  if (!options.reasoning) return undefined;
  const level = model.thinkingLevelMap?.[options.reasoning] ?? options.reasoning;
  if (level === 'minimal') return 'low';
  return typeof level === 'string' && efforts.includes(level) ? level : undefined;
}

const eventSchema = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  api_error_status: z.number().nullable().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
  event: z.looseObject({ type: z.string() }).optional(),
  message: z
    .looseObject({ model: z.string().optional(), content: z.array(z.unknown()).optional() })
    .optional(),
});

export function streamClaudeCode(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  const fail = (reason: 'error' | 'aborted', message: string) => {
    output.stopReason = reason;
    output.errorMessage = message;
    stream.push({ type: 'error', reason, error: output });
    stream.end(output);
  };
  void (async () => {
    let directory: string | undefined;
    try {
      const normalized = collapseSystemMessages(normalizeContext(context));
      const system = getInitialSystemMessage(normalized.messages);
      const tools = getCurrentTools(normalized.messages).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: JSON.parse(JSON.stringify(tool.parameters)),
      }));
      const schemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
      const content = transcript(withoutInitialSystemMessage(normalized.messages));
      const prompt = `${system ? getSystemMessageText(system) : ''}\n\n${transcriptFormat}`.trim();
      const limit = Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens);
      const effort = limit >= 4096 ? effortFor(model, options) : undefined;
      await options.onPayload?.(
        {
          model: model.id,
          system: prompt,
          tools,
          messages: [{ role: 'user', content }],
          max_tokens: limit,
        },
        model,
      );
      options.signal?.throwIfAborted();
      directory = await mkdtemp(join(tmpdir(), 'nod-claude-'));
      const promptFile = join(directory, 'system.md');
      const toolsFile = join(directory, 'tools.json');
      await writeFile(promptFile, prompt, { mode: 0o600 });
      await writeFile(toolsFile, JSON.stringify(tools), { mode: 0o600 });
      const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--tools',
        '',
        '--strict-mcp-config',
        ...(tools.length
          ? [
              '--mcp-config',
              JSON.stringify({
                mcpServers: {
                  nod: { command: process.execPath, args: [toolServer, toolsFile] },
                },
              }),
            ]
          : []),
        '--setting-sources',
        '',
        '--no-session-persistence',
        '--disable-slash-commands',
        '--system-prompt-file',
        promptFile,
        '--model',
        model.id,
        ...(effort ? ['--effort', effort] : []),
      ];
      const child = spawn('claude', args, {
        cwd: directory,
        env: environment({
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(limit),
          ...(limit < 4096 ? { MAX_THINKING_TOKENS: '0' } : {}),
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const abort = () => child.kill('SIGTERM');
      options.signal?.addEventListener('abort', abort, { once: true });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
      const exited = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
      const blocks = new Map<number, { index: number; json: string }>();
      let started = false;
      let finished = false;
      let failure: string | undefined;
      const start = () => {
        if (started) return;
        started = true;
        stream.push({ type: 'start', partial: output });
      };
      const usage = (value: unknown) => {
        const counts = z
          .looseObject({
            input_tokens: z.number().nullable().optional(),
            output_tokens: z.number().nullable().optional(),
            cache_read_input_tokens: z.number().nullable().optional(),
            cache_creation_input_tokens: z.number().nullable().optional(),
          })
          .safeParse(value);
        if (!counts.success) return;
        const usage = output.usage;
        usage.input = counts.data.input_tokens ?? usage.input;
        usage.output = counts.data.output_tokens ?? usage.output;
        usage.cacheRead = counts.data.cache_read_input_tokens ?? usage.cacheRead;
        usage.cacheWrite = counts.data.cache_creation_input_tokens ?? usage.cacheWrite;
        usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        usage.cost = calculateCost(model, usage);
      };
      for await (const line of createInterface({ input: child.stdout })) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = eventSchema.safeParse(JSON.parse(line));
        } catch {
          continue;
        }
        if (!parsed.success) continue;
        const message = parsed.data;
        if (message.type === 'result') {
          if (message.is_error)
            failure = `${message.result || 'Claude Code reported an error.'}${message.api_error_status ? ` (HTTP ${message.api_error_status})` : ''}`;
          break;
        }
        if (message.type === 'assistant' && message.message?.model === '<synthetic>') {
          const text = message.message.content
            ?.flatMap(
              (part) =>
                z.object({ type: z.literal('text'), text: z.string() }).safeParse(part).data
                  ?.text ?? [],
            )
            .join('\n');
          if (text) failure = text;
          continue;
        }
        if (message.type !== 'stream_event' || message.parent_tool_use_id || !message.event)
          continue;
        const event = message.event as Record<string, any>;
        await options.onProviderStreamEvent?.(event, model);
        switch (event.type) {
          case 'message_start':
            output.responseId = event.message?.id;
            output.responseModel = event.message?.model;
            usage(event.message?.usage);
            start();
            break;
          case 'content_block_start': {
            start();
            const block = event.content_block ?? {};
            const index = output.content.length;
            if (block.type === 'text') {
              output.content.push({ type: 'text', text: '' });
              stream.push({ type: 'text_start', contentIndex: index, partial: output });
            } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
              output.content.push({
                type: 'thinking',
                thinking: '',
                thinkingSignature: block.type === 'redacted_thinking' ? block.data : '',
                ...(block.type === 'redacted_thinking' ? { redacted: true } : {}),
              });
              stream.push({ type: 'thinking_start', contentIndex: index, partial: output });
            } else if (block.type === 'tool_use') {
              const name = String(block.name ?? '');
              output.content.push({
                type: 'toolCall',
                id: String(block.id ?? ''),
                name: name.startsWith(toolPrefix) ? name.slice(toolPrefix.length) : name,
                arguments: {},
              });
              stream.push({ type: 'toolcall_start', contentIndex: index, partial: output });
            } else break;
            blocks.set(event.index, { index, json: '' });
            break;
          }
          case 'content_block_delta': {
            const block = blocks.get(event.index);
            const part = block && output.content[block.index];
            const delta = event.delta ?? {};
            if (!block || !part) break;
            if (delta.type === 'text_delta' && part.type === 'text') {
              part.text += delta.text;
              stream.push({
                type: 'text_delta',
                contentIndex: block.index,
                delta: delta.text,
                partial: output,
              });
            } else if (delta.type === 'thinking_delta' && part.type === 'thinking') {
              part.thinking += delta.thinking;
              stream.push({
                type: 'thinking_delta',
                contentIndex: block.index,
                delta: delta.thinking,
                partial: output,
              });
            } else if (delta.type === 'signature_delta' && part.type === 'thinking') {
              part.thinkingSignature = (part.thinkingSignature ?? '') + delta.signature;
            } else if (delta.type === 'input_json_delta' && part.type === 'toolCall') {
              block.json += delta.partial_json;
              stream.push({
                type: 'toolcall_delta',
                contentIndex: block.index,
                delta: delta.partial_json,
                partial: output,
              });
            }
            break;
          }
          case 'content_block_stop': {
            const block = blocks.get(event.index);
            const part = block && output.content[block.index];
            if (!block || !part) break;
            if (part.type === 'text')
              stream.push({
                type: 'text_end',
                contentIndex: block.index,
                content: part.text,
                partial: output,
              });
            else if (part.type === 'thinking')
              stream.push({
                type: 'thinking_end',
                contentIndex: block.index,
                content: part.thinking,
                partial: output,
              });
            else {
              try {
                const value = block.json.trim() ? JSON.parse(block.json) : {};
                if (!value || typeof value !== 'object' || Array.isArray(value))
                  throw new Error('not an object');
                part.arguments = restoreStructured(value as JsonObject, schemas.get(part.name));
              } catch {
                part.argumentsError = `The tool arguments were not a JSON object: ${block.json.slice(0, 2000)}`;
              }
              stream.push({
                type: 'toolcall_end',
                contentIndex: block.index,
                toolCall: part,
                partial: output,
              });
            }
            break;
          }
          case 'message_delta':
            output.rawStopReason = event.delta?.stop_reason ?? undefined;
            output.stopReason = stopReason(event.delta?.stop_reason);
            if (event.delta?.stop_reason === 'refusal')
              failure = 'Claude declined to continue this request.';
            usage(event.usage);
            break;
          case 'message_stop':
            finished = true;
            break;
        }
        if (finished) break;
      }
      child.kill('SIGTERM');
      const code = await exited.catch((error: NodeJS.ErrnoException) => {
        failure ??=
          error.code === 'ENOENT'
            ? 'Claude Code isn’t installed on this computer. Install it and run `claude auth login`.'
            : `Claude Code couldn’t start: ${error.message}`;
        return null;
      });
      options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) return fail('aborted', 'The request was stopped.');
      if (failure) return fail('error', `Claude Code: ${failure}`);
      if (!finished)
        return fail(
          'error',
          `Claude Code ended without a reply (exit code ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}.`,
        );
      start();
      stream.push({
        type: 'done',
        reason: output.stopReason as 'stop' | 'length' | 'toolUse',
        message: output,
      });
      stream.end(output);
    } catch (error) {
      if (options.signal?.aborted) fail('aborted', 'The request was stopped.');
      else fail('error', error instanceof Error ? error.message : String(error));
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return stream;
}
