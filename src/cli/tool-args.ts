export function formatToolArgs(
  args: Record<string, unknown> | undefined,
  maxValueLength = 50,
): string {
  if (!args) {
    return '';
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const rendered = renderToolArgValue(value);
    if (rendered === undefined) {
      continue;
    }

    parts.push(`${key}=${truncate(rendered, maxValueLength)}`);
  }

  return parts.join(', ');
}

function renderToolArgValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    const rendered = JSON.stringify(value);
    if (typeof rendered === 'string') {
      return rendered;
    }
  } catch {
    // Fall back to String(value) below.
  }

  return String(value);
}

function truncate(value: string, maxValueLength: number): string {
  if (value.length <= maxValueLength) {
    return value;
  }

  return value.slice(0, Math.max(0, maxValueLength - 3)) + '...';
}