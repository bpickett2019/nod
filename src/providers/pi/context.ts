export function modelContext<
  T extends { provider: string; id: string; contextWindow: number; maxTokens: number },
>(model: T, companion?: Pick<T, 'contextWindow' | 'maxTokens'>) {
  const routed =
    model.provider === 'openrouter' && ['openrouter/free', 'openrouter/auto'].includes(model.id);
  const window = Math.min(
    model.contextWindow,
    companion?.contextWindow ?? Infinity,
    routed ? 8192 : Infinity,
  );
  const compact = window < 65_536;
  const maxTokens = Math.min(
    model.maxTokens,
    companion?.maxTokens ?? Infinity,
    Math.floor(window / (compact ? 4 : 2)),
  );
  const margin = Math.min(2048, Math.max(128, Math.floor(window / 16)));
  const trigger = compact
    ? Math.ceil(window / 2)
    : Math.min(160_000, window - 16_384, Math.floor((window - maxTokens - margin) * 0.75));
  return {
    model: { ...model, contextWindow: window, maxTokens },
    compact,
    margin,
    compaction: {
      enabled: true,
      reserveTokens: window - trigger,
      keepRecentTokens: compact ? Math.floor(window / 8) : Math.round(trigger / 3),
    },
    toolOutput: {
      maxBytes: Math.floor(window / 2),
      maxTokens: Math.floor(window / 8),
      previewCharacters: 1000,
    },
  };
}
