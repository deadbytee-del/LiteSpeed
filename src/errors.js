export class ProxyError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Map low-level fetch failures to stable, user-facing errors. */
export function classifyFetchError(err) {
  if (err instanceof ProxyError) return err;
  const name = err && err.name;
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  if (name === 'TimeoutError') return new ProxyError(504, 'upstream_timeout', 'The upstream server took too long to respond.');
  if (name === 'AbortError') return new ProxyError(499, 'client_closed', 'The request was cancelled.');
  if (err && err.cause && err.cause.message === 'bad port') return new ProxyError(400, 'blocked_port', 'That port is blocked for safety by the fetch standard.');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new ProxyError(502, 'dns_failure', 'The host name could not be resolved.');
  if (code === 'ECONNREFUSED') return new ProxyError(502, 'connection_refused', 'The upstream server refused the connection.');
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return new ProxyError(502, 'connection_reset', 'The connection to the upstream server was reset.');
  if (/CERT|SSL|TLS/i.test(String(code))) return new ProxyError(502, 'tls_error', 'The upstream server presented an invalid TLS certificate.');
  return new ProxyError(502, 'upstream_unreachable', 'Could not reach the upstream server.');
}
