// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReviewDetail } from '../apps/admin/src/ReviewDetail';
import OrderStatus from '../apps/storefront/src/components/OrderStatus';

let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  sessionStorage.clear();
  history.replaceState(null, '', '/order');
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent === text)!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function draft(text: string) {
  await act(async () => {
    const input = document.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const evidence = (note = '') => ({ item: { note, version: 0, status: 'open', reason: 'unknown_reference', createdAt: 1 }, order: null, attempt: null, triggeringEvent: null, events: [], history: [] });

it.each(['resolve', 'reject'] as const)('preserves reopened review evidence and draft when an old load %ss', async (completion) => {
  const old = deferred<any>();
  const api = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(evidence());
  await act(async () => root.render(<ReviewDetail id="case" api={api} refresh={async () => {}} />));
  await click('Bukti & tindakan');
  await click('Tutup');
  await click('Bukti & tindakan');
  await draft('Draft baru');
  await act(async () => { if (completion === 'resolve') old.resolve(evidence('Catatan lama')); else old.reject(new Error('Error lama')); });
  expect(document.querySelector('textarea')!.value).toBe('Draft baru');
  expect(document.body.textContent).not.toContain('Error lama');
});

it('does not reload a reopened editor when an earlier save completes', async () => {
  const save = deferred<any>();
  const api = vi.fn((_path, _body, method) => method === 'PATCH' ? save.promise : Promise.resolve(evidence()));
  await act(async () => root.render(<ReviewDetail id="case" api={api} refresh={async () => {}} />));
  await click('Bukti & tindakan'); await draft('Simpan lama'); await click('Simpan catatan');
  await click('Tutup'); await click('Bukti & tindakan'); await draft('Draft baru');
  await act(async () => save.resolve({ updated: true }));
  expect(document.querySelector('textarea')!.value).toBe('Draft baru');
});

const summary = (reference: string) => ({ reference, status: 'pending_payment', total: 1000, createdAt: 1, fulfillment: 'unfulfilled', currency: 'IDR' });
const page = (ownerId: string, refs: string[], nextCursor: string | null = null) => Response.json({ ownerId, orders: refs.map(summary), nextCursor });
const detail = (access: any) => Response.json({ access, order: { ...summary('A-order'), items: [], timeline: [] } });
async function focus() { await act(async () => window.dispatchEvent(new Event('focus'))); }

it('retries page one after a failed focus refresh instead of appending the next page', async () => {
  let failed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('?cursor')) return page('A', ['Wrong-next-page']);
    if (failed) return page('A', ['New-order', 'A-order']);
    failed = true;
    return page('A', ['A-order'], 'next');
  }));
  await act(async () => root.render(<OrderStatus />));
  vi.mocked(fetch).mockRejectedValueOnce(new Error('Network down'));
  await focus(); await click('Coba lagi');
  expect(document.body.textContent).toContain('New-order');
  expect(document.body.textContent).not.toContain('Wrong-next-page');
});

it.each([['account','B'], ['guest','B'], ['account',null], ['guest',null]] as const)('handles %s detail when owner becomes %s', async (type, nextOwner) => {
  let owner: string | null = 'A';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('/api/orders/') ? detail({ type, ownerId: 'A' }) : owner ? page(owner, [owner + '-order']) : Response.json({}, { status: 401 })));
  await act(async () => root.render(<OrderStatus />));
  await click('A-order');
  expect(document.querySelector('[aria-label="Detail pesanan"]')).toBeTruthy();
  owner = nextOwner; await focus();
  expect(!!document.querySelector('[aria-label="Detail pesanan"]')).toBe(type === 'guest');
});

it('rejects delayed account detail after logout', async () => {
  const old = deferred<Response>();
  let loggedOut = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('/api/orders/') ? old.promise : loggedOut ? Response.json({}, { status: 401 }) : page('A', ['A-order'])));
  await act(async () => root.render(<OrderStatus />));
  await click('A-order');
  loggedOut = true; await focus();
  await act(async () => old.resolve(detail({ type: 'account', ownerId: 'A' })));
  expect(document.querySelector('[aria-label="Detail pesanan"]')).toBeNull();
  expect(document.body.textContent).toContain('Masuk dengan Google');
});

it('does not mistake an invalid nonempty token for verified guest access', async () => {
  let loggedOut = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('/api/orders/') ? detail({ type: 'account', ownerId: 'A' }) : loggedOut ? Response.json({}, { status: 401 }) : page('A', ['A-order'])));
  await act(async () => root.render(<OrderStatus />));
  await act(async () => {
    for (const [id, value] of [['reference','A-order'], ['token','invalid-token']]) {
      const input = document.getElementById(id)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(document.querySelector('[aria-label="Detail pesanan"]')).toBeTruthy();
  loggedOut = true; await focus();
  expect(document.querySelector('[aria-label="Detail pesanan"]')).toBeNull();
});
