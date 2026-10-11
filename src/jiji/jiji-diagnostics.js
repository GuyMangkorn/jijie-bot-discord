const STAGES = new Set([
  'access', 'reference', 'memory_read', 'gemini', 'google_search', 'tool',
  'discord_send', 'memory_write', 'unknown',
]);
const CATEGORIES = new Set([
  'access_denied', 'access_unavailable', 'blocked_response', 'cancelled',
  'departure_read_failed', 'discord_send_failed', 'empty_response', 'http',
  'invalid_answer', 'invalid_input', 'invalid_tool_call', 'malformed_response',
  'member_fetch_failed', 'memory_failed', 'missing_key', 'network',
  'output_too_long', 'request_budget', 'search_failed', 'tool_budget',
  'tool_failed', 'unknown',
]);
const REASONS = new Set([
  ...CATEGORIES,
  'search_text_invalid', 'search_metadata_missing', 'search_queries_invalid',
  'search_sources_invalid', 'search_source_limit', 'search_suggestions_invalid',
  'search_url_invalid', 'search_unavailable', 'provider_timeout', 'turn_timeout',
  'forgotten', 'channel_removed', 'disabled', 'shutdown', 'invalidated', 'http',
]);
const EVENTS = new Set(['jiji_turn_failed', 'jiji_turn_cancelled']);
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const MAX_INTEGER = 2 ** 31 - 1;

function isObject(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function ownData(object, key) {
  if (!isObject(object)) return { present: false, value: undefined };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, 'value')
      ? { present: true, value: descriptor.value }
      : { present: false, value: undefined };
  } catch {
    return { present: false, value: undefined };
  }
}

function known(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : 'unknown';
}

function validStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function readPart(source, key) {
  const property = ownData(source, key);
  return property.present ? property.value : undefined;
}

export function readJijiDiagnostic(error) {
  const category = known(readPart(error, 'category'), CATEGORIES);
  const nestedProperty = ownData(error, 'diagnostic');
  const nested = nestedProperty.present ? nestedProperty.value : undefined;
  const stageProperty = ownData(nested, 'stage');
  const reasonProperty = ownData(nested, 'reason');
  const statusProperty = ownData(nested, 'status');
  const topStage = ownData(error, 'stage');
  const topReason = ownData(error, 'reason');
  const topStatus = ownData(error, 'status');
  const stage = stageProperty.present ? stageProperty.value : topStage.value;
  const reason = reasonProperty.present ? reasonProperty.value : topReason.value;
  const status = statusProperty.present ? statusProperty.value : topStatus.value;
  return {
    category,
    ...(stage === undefined ? {} : { stage: known(stage, STAGES) }),
    ...(reason === undefined ? {} : { reason: known(reason, REASONS) }),
    ...(validStatus(status) === undefined ? {} : { status: validStatus(status) }),
  };
}

function boundedInteger(value, maximum) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.floor(value))) : 0;
}

function timestamp(now) {
  try {
    const value = now();
    if (Number.isFinite(value)) return new Date(value).toISOString();
  } catch { /* Use the process clock if the injected clock fails. */ }
  return new Date().toISOString();
}

export function createJijiDiagnostics({ write = line => process.stderr.write(line), now = Date.now } = {}) {
  return {
    record(fields) {
      try {
        const eventValue = readPart(fields, 'event');
        const traceValue = readPart(fields, 'traceId');
        const stageValue = readPart(fields, 'stage');
        const categoryValue = readPart(fields, 'category');
        const statusValue = readPart(fields, 'status');
        const reasonValue = readPart(fields, 'reason');
        const record = {
          event: EVENTS.has(eventValue) ? eventValue : 'jiji_turn_failed',
          timestamp: timestamp(now),
          ...(typeof traceValue === 'string' && UUID.test(traceValue) ? { traceId: traceValue } : {}),
          stage: known(stageValue, STAGES),
          category: known(categoryValue, CATEGORIES),
          ...(validStatus(statusValue) === undefined ? {} : { httpStatus: validStatus(statusValue) }),
          ...(reasonValue === undefined ? {} : { reason: known(reasonValue, REASONS) }),
          durationMs: boundedInteger(readPart(fields, 'durationMs'), MAX_INTEGER),
          requestCount: boundedInteger(readPart(fields, 'requestCount'), 3),
          toolCount: boundedInteger(readPart(fields, 'toolCount'), 4),
        };
        write(`${JSON.stringify(record)}\n`);
      } catch { /* Diagnostics must never interrupt a conversation. */ }
    },
  };
}
