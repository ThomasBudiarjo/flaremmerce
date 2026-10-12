import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';

try {
  const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://127.0.0.1:8787/api/catalog' },
    requests: { type: 'string', default: '100' }, concurrency: { type: 'string', default: '5' },
    'timeout-ms': { type: 'string', default: '5000' },
  } });
  const bounded = (name, max) => {
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be 1..${max}`);
    return n;
  };
  const requests = bounded('requests', 10000), concurrency = bounded('concurrency', 50), timeout = bounded('timeout-ms', 30000);
  const url = new URL(values.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['/api/catalog', '/catalog', '/'].includes(url.pathname)) {
    throw new Error('Only read-only public /api/catalog, /catalog or / without query/credentials is allowed');
  }
  const latencies = [], statuses = {};
  let next = 0, errors = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
    while (next++ < requests) {
      const began = performance.now();
      try {
        const response = await fetch(url, { method: 'GET', redirect: 'manual',
          signal: AbortSignal.timeout(timeout) });
        await response.arrayBuffer();
        statuses[response.status] = (statuses[response.status] || 0) + 1;
        if (!response.ok) errors++;
      } catch { errors++; statuses.networkError = (statuses.networkError || 0) + 1; }
      latencies.push(performance.now() - began);
    }
  }));
  latencies.sort((a, b) => a - b);
  const percentile = (p) => Number(latencies[Math.ceil(p * latencies.length) - 1].toFixed(2));
  console.log(JSON.stringify({ url: url.href, requests, concurrency, statuses, errors,
    errorRate: errors / requests, p50Ms: percentile(.5), p95Ms: percentile(.95),
    elapsedMs: Number((performance.now() - start).toFixed(2)),
    scope: 'HTTP wall time only; cloud CPU, D1 rows and quotas are not measured' }, null, 2));
  if (errors) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
