export function sendJson(response, data, status = 200) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

export async function readJson(request, maxBytes = 100_000) {
  request.setEncoding('utf8');
  let body = '';
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > maxBytes) throw new Error('请求过大');
    body += chunk;
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new Error('JSON 格式无效');
  }
}

export function requiredText(value, maxLength = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error('文本为空或超过长度限制');
  }
  return value.trim();
}

export function integer(value, fallback, minimum, maximum) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error('数值超出允许范围');
  }
  return selected;
}

export function apiEndpoint(value) {
  const base = new URL(requiredText(value, 2048));
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !['https:', 'http:'].includes(base.protocol)
  ) {
    throw new Error('API 地址不合法');
  }
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    throw new Error('远程 API 必须使用 HTTPS');
  }
  return base.href.replace(/\/$/, '');
}
