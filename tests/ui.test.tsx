// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { AdminApp } from '../apps/admin/src/main';
import OrderStatus from '../apps/storefront/src/components/OrderStatus';
import Checkout from '../apps/storefront/src/components/Checkout';
import { money } from '../apps/storefront/src/lib/catalog';

// Turnstile is a third-party widget; the double issues a fresh token whenever the checkout resets it.
vi.mock('../apps/storefront/src/components/Turnstile', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return { default: ({ onToken, reset }: { onToken: (token: string) => void; reset: number }) => { useEffect(() => onToken(`turnstile-${reset}`), [reset]); return null; } };
});

let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  sessionStorage.clear();
  history.replaceState(null, '', '/order');
});
afterEach(async () => { await act(async () => { toast.dismiss(); root.unmount(); }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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
const summary = (reference: string) => ({ reference, status: 'pending_payment', total: 1000, createdAt: 1, fulfillment: 'unfulfilled', currency: 'IDR' });
const page = (ownerId: string, refs: string[], nextCursor: string | null = null) => Response.json({ ownerId, orders: refs.map(summary), nextCursor });
const detail = (access: any) => Response.json({ access, order: { ...summary('A-order'), items: [], timeline: [] } });
async function focus() { await act(async () => window.dispatchEvent(new Event('focus'))); }
it.each([
  ['pending_payment', 'pending', 'https://sandbox.doku.com/existing-attempt', true],
  ['paid', 'succeeded', 'https://sandbox.doku.com/existing-attempt', false],
  ['paid', 'pending', 'https://sandbox.doku.com/existing-attempt', false],
  ['completed', 'pending', 'https://sandbox.doku.com/existing-attempt', false],
  ['pending_payment', 'unknown', 'https://sandbox.doku.com/existing-attempt', false],
  ['pending_payment', 'pending', 'javascript:alert(1)', false],
  ['pending_payment', 'pending', null, false],
  ['pending_payment', 'pending', undefined, false],
] as const)('resumes only a confirmed pending attempt (%s / %s)', async (status, paymentState, paymentUrl, visible) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('/api/orders/')
    ? Response.json({ access: { type: 'account', ownerId: 'A' }, order: { ...summary('A-order'), status, items: [], timeline: [] }, paymentState, paymentUrl })
    : page('A', ['A-order'])));
  await act(async () => root.render(<OrderStatus />));
  await click('A-order');
  const link = document.querySelector<HTMLAnchorElement>('[aria-label="Detail pesanan"] a');
  expect(!!link).toBe(visible);
  if (visible) {
    expect(link!.href).toBe(paymentUrl);
    expect(link!.rel).toBe('noreferrer');
    expect(document.body.textContent).toContain('Lanjutkan pembayaran yang sama');
  }
});

it('resumes guest payment without placing another order', async () => {
  sessionStorage.setItem('flaremmerce-order-access', JSON.stringify({ reference: 'guest-order', token: 'private-fixture' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('/api/orders/')
    ? Response.json({ access: { type: 'guest' }, order: { ...summary('guest-order'), items: [], timeline: [] }, paymentState: 'pending', paymentUrl: 'https://sandbox.doku.com/same-attempt' })
    : Response.json({}, { status: 401 })));
  await act(async () => root.render(<OrderStatus />));
  expect(document.querySelector<HTMLAnchorElement>('[aria-label="Detail pesanan"] a')?.href).toBe('https://sandbox.doku.com/same-attempt');
  expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith('/api/orders') || url === '/api/config')).toBe(true);
});

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

describe('admin SPA', () => {
  type Handler = (url: string, init: RequestInit) => Response | Promise<Response> | undefined;
  const me = (role = 'owner') => ({ user: { id: 'admin', name: 'Admin', email: 'admin@example.com' }, role, areas: role === 'owner' ? ['owner', 'ops', 'catalog'] : [role] });
  const summaryBody = { range: 'today', since: 0, now: 1, revenue: 0, paidOrders: 0, averageOrderValue: 0, pendingPayment: 0, toFulfill: 2, openReviews: 1, lowStock: 0 };
  let calls: { url: string; method: string; body: any }[] = [];
  async function renderAdmin(path: string, handler: Handler, options: { role?: string; signedIn?: boolean; config?: Record<string, unknown> } = {}) {
    calls = [];
    let signedIn = options.signedIn ?? true;
    history.replaceState(null, '', path);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/config') return Response.json(options.config ?? { devLoginEnabled: true, googleEnabled: false });
      if (url === '/api/setup') return Response.json({ initialized: true });
      if (url === '/api/auth/development-login') { signedIn = true; return Response.json({ ok: true }); }
      if (url === '/api/auth/staging-login') {
        if (JSON.parse(String(init.body)).secret !== 'correct-staging-passphrase') return Response.json({ message: 'Staging login rejected' }, { status: 403 });
        signedIn = true; return Response.json({ ok: true });
      }
      if (url.startsWith('/api/auth/get-session')) return Response.json(signedIn ? { user: { id: 'admin' } } : null);
      if (url === '/api/admin/me') return Response.json(me(options.role));
      if (url.startsWith('/api/admin/summary')) return Response.json(summaryBody);
      const response = await handler(url, init);
      if (response) return response;
      throw new Error(`Unexpected ${method} ${url}`);
    }));
    await act(async () => root.render(<AdminApp />));
  }
  // Intl puts a no-break space after "Rp"; compare money as plain text.
  const text = () => (document.body.textContent ?? '').replace(/\u00a0/g, ' ');
  const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement;
  async function press(label: string) {
    const target = button(label);
    expect(target, label).toBeTruthy();
    await act(async () => target.click());
  }
  async function type(element: Element, value: string) {
    await act(async () => {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
  }
  const labelled = (label: string) => {
    const element = [...document.querySelectorAll('label')].find(l => l.textContent?.trim().startsWith(label));
    return document.getElementById(element!.htmlFor) as HTMLInputElement;
  };
  const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

  const product = { id: 'p', slug: 'produk', name: 'Produk', description: 'Deskripsi', imageUrl: null, category: null, active: true, categoryId: null, version: 3,
    variants: [{ id: 'v', sku: 'SKU', name: 'Varian', price: 100, weight: 10, mode: 'stock', active: true, maxPerOrder: null, maxPerCustomer: null, lengthCm: null, widthCm: null, heightCm: null, lowStockThreshold: null, version: 4, onHand: 10, reserved: 1, available: 9 }] };
  const order = (patch: Record<string, unknown> = {}) => ({ order: { id: 'o1', reference: 'FL-1', status: 'paid', fulfillment: 'unfulfilled', total: 1100, currency: 'IDR', createdAt: 1, hold: false, openReviewReasons: [],
    contact: { name: 'Budi', email: 'budi@example.com', phone: '081234567890' }, address: { line: 'Jl. Mawar 1', city: 'JAKARTA' }, shipping: { service: 'jne:REG', amount: 100 }, tracking: null,
    items: [{ id: 'i1', variantId: 'v', campaignId: null, quantity: 1, price: 1000, sku: 'SKU', name: 'Varian', productName: 'Produk', mode: 'stock', weight: 10, billedWeight: 10 }], timeline: [], ...patch }, payment: null });

  it('signs in through dev login and deep-links /admin/orders/:id straight to the order detail', async () => {
    await renderAdmin('/admin/orders/o1', url => url === '/api/admin/orders/o1' ? Response.json(order()) : undefined, { signedIn: false });
    expect(text()).toContain('Masuk ke admin');
    await press('Masuk admin dev');
    expect(document.querySelector('h1')?.textContent).toBe('Pesanan FL-1');
    expect(document.activeElement?.id).toBe('page-title');
    expect(calls.filter(c => c.url === '/api/config')).toHaveLength(2);
  });

  it('signs in to staging with the passphrase, without Google, and flags the environment', async () => {
    const config = { environment: 'staging', devLoginEnabled: false, googleEnabled: false, stagingLogin: true, payments: false, shipping: true, turnstile: false };
    await renderAdmin('/admin', url => url.startsWith('/api/admin/orders') ? Response.json({ orders: [] }) : url === '/api/admin/operations' ? Response.json({ sections: {} }) : undefined, { signedIn: false, config });
    expect(text()).toContain('Masuk ke admin');
    expect(text()).toContain('passphrase staging');
    expect(button('Masuk dengan Google')).toBeUndefined();
    expect(button('Masuk admin dev')).toBeUndefined();
    await type(labelled('Passphrase staging'), 'wrong');
    await act(async () => button('Masuk staging').closest('form')!.requestSubmit());
    expect(text()).toContain('Staging login rejected');
    expect(text()).toContain('Masuk ke admin');
    await type(labelled('Passphrase staging'), 'correct-staging-passphrase');
    await act(async () => button('Masuk staging').closest('form')!.requestSubmit());
    expect(calls.filter(c => c.url === '/api/auth/staging-login').map(c => c.body)).toEqual([{ secret: 'wrong' }, { secret: 'correct-staging-passphrase' }]);
    expect(document.querySelector('h1')?.textContent).toBe('Beranda');
    expect([...document.querySelectorAll('header [data-slot="badge"]')].some(b => b.textContent === 'STAGING')).toBe(true);
    expect(text()).toContain('Staging: integrasi belum dikonfigurasi');
    expect(text()).toContain('Pembayaran DOKU, Login Google, Turnstile nonaktif di lingkungan ini.');
  });

  it('offers Google alongside staging login only when Google is configured, and no banner in production', async () => {
    await renderAdmin('/admin', () => undefined, { signedIn: false, config: { environment: 'staging', devLoginEnabled: false, googleEnabled: true, stagingLogin: true } });
    expect(button('Masuk dengan Google')).toBeTruthy();
    expect(button('Masuk staging')).toBeTruthy();
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('root')!);
    await renderAdmin('/admin', url => url.startsWith('/api/admin/orders') ? Response.json({ orders: [] }) : url === '/api/admin/operations' ? Response.json({ sections: {} }) : undefined, { config: { environment: 'production', devLoginEnabled: false, googleEnabled: true, payments: false, shipping: false } });
    expect(document.querySelector('h1')?.textContent).toBe('Beranda');
    expect(text()).not.toContain('STAGING');
    expect(text()).not.toContain('integrasi belum dikonfigurasi');
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('root')!);
    await renderAdmin('/admin', () => undefined, { signedIn: false, config: { environment: 'production', devLoginEnabled: false, googleEnabled: false, stagingLogin: false } });
    expect(button('Masuk staging')).toBeUndefined();
    expect(text()).toContain('Google sign-in belum dikonfigurasi');
  });

  it('routes with the history API, renders a 404 and never refetches config on navigation', async () => {
    await renderAdmin('/admin/nope', url => url.startsWith('/api/admin/products') ? Response.json({ products: [], nextCursor: null }) : url === '/api/admin/categories' ? Response.json({ categories: [] }) : undefined);
    expect(text()).toContain('Halaman tidak ditemukan');
    const before = calls.length;
    const link = [...document.querySelectorAll('nav a')].find(a => a.textContent === 'Produk') as HTMLAnchorElement;
    await act(async () => link.click());
    expect(location.pathname).toBe('/admin/products');
    expect(document.querySelector('h1')?.textContent).toBe('Produk');
    expect(calls.slice(before).some(c => c.url === '/api/config' || c.url === '/api/setup' || c.url === '/api/admin/me')).toBe(false);
  });

  it('hides navigation outside the role and blocks deep links into it', async () => {
    await renderAdmin('/admin/orders', url => (url === '/api/admin/categories' ? Response.json({ categories: [] }) : undefined), { role: 'catalog' });
    const nav = [...document.querySelectorAll('nav a')].map(a => a.textContent);
    expect(nav).toContain('Produk');
    expect(nav).not.toContain('Pesanan');
    expect(nav).not.toContain('Tim & akses');
    expect(text()).toContain('Halaman tidak tersedia untuk peranmu');
    expect(calls.some(c => c.url.startsWith('/api/admin/orders') || c.url.startsWith('/api/admin/summary'))).toBe(false);
  });

  it('maps order tabs and dates onto the API status/from filters', async () => {
    await renderAdmin('/admin/orders?status=to_fulfill', url => url.startsWith('/api/admin/orders?') ? Response.json({ orders: [], nextCursor: null }) : undefined);
    expect(calls.map(c => c.url)).toContain('/api/admin/orders?status=to_fulfill&limit=50');
    const shipped = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent === 'Dikirim')!;
    await act(async () => shipped.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    expect(location.search).toBe('?status=shipped');
    expect(calls.at(-1)!.url).toBe('/api/admin/orders?status=shipped&limit=50');
    await type(document.getElementById('orders-from')!, '2026-10-01');
    expect(calls.at(-1)!.url).toBe('/api/admin/orders?status=shipped&from=2026-10-01&limit=50');
  });

  it('offers only the next fulfillment step and blocks it while the order is held', async () => {
    let fulfillment = 'unfulfilled';
    await renderAdmin('/admin/orders/o1', (url, init) => {
      if (url === '/api/admin/orders/o1') return Response.json(order({ fulfillment }));
      if (url === '/api/admin/orders/o1/fulfillment' && init.method === 'PATCH') { fulfillment = 'processing'; return Response.json({ order: { id: 'o1', fulfillment, status: 'paid' } }); }
    });
    expect(button('Mulai proses')).toBeTruthy();
    expect(button('Tandai dikirim')).toBeUndefined();
    expect(button('Tandai terkirim')).toBeUndefined();
    await act(async () => button('Mulai proses').closest('form')!.requestSubmit());
    expect(calls.find(c => c.method === 'PATCH')!.body).toEqual({ status: 'processing' });
    expect(button('Tandai dikirim')).toBeTruthy();
    expect(button('Mulai proses')).toBeUndefined();
  });

  it('blocks fulfillment of a held order and links its open review', async () => {
    await renderAdmin('/admin/orders/o1', url => {
      if (url === '/api/admin/orders/o1') return Response.json(order({ hold: true, openReviewReasons: ['risk_velocity'] }));
      if (url.startsWith('/api/admin/review')) return Response.json({ items: [{ id: 'r1', orderId: 'o1', status: 'open', reason: 'risk_velocity' }], nextCursor: null });
    });
    expect(text()).toContain('Pengiriman ditahan');
    expect(button('Mulai proses').disabled).toBe(true);
    expect([...document.querySelectorAll('a')].some(a => a.getAttribute('href') === '/admin/reviews/r1')).toBe(true);
  });

  it('keeps the mutation lock after its dialog closes and reopens', async () => {
    const write = deferred<Response>();
    await renderAdmin('/admin/blocklist', (url, init) => {
      if (url === '/api/admin/blocklist' && init.method === 'POST') return write.promise;
      if (url.startsWith('/api/admin/blocklist?')) return Response.json({ items: [], nextCursor: null });
    });
    const fill = async () => {
      await type(labelled('Email'), 'spam@example.com');
      await type(labelled('Alasan'), 'Chargeback');
    };
    await press('Tambah'); await fill();
    await act(async () => (document.getElementById('blocklist-form') as HTMLFormElement).requestSubmit());
    await press('Batal');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await press('Tambah'); await fill();
    expect(button('Menyimpan…').disabled).toBe(true);
    await act(async () => (document.getElementById('blocklist-form') as HTMLFormElement).requestSubmit());
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
    await act(async () => write.resolve(Response.json({ created: true, entry: { id: 'b1', kind: 'email', reason: 'Chargeback', actor: 'admin', createdAt: 1 } }, { status: 201 })));
    expect(text()).toContain('Chargeback');
  });

  it('PATCHes only changed product and variant fields with their versions', async () => {
    await renderAdmin('/admin/products/p', (url, init) => {
      if (url === '/api/admin/categories') return Response.json({ categories: [] });
      if (url === '/api/admin/products/p' && init.method === 'PATCH') return Response.json({ updated: true, product: { ...product, name: 'Produk baru', version: 4 } });
      if (url === '/api/admin/variants/v' && init.method === 'PATCH') return Response.json({ updated: true, variant: { ...product.variants[0], price: 250, version: 5 } });
      if (url === '/api/admin/products/p') return Response.json({ product });
    });
    expect(text()).not.toContain('Perubahan belum disimpan');
    await type(labelled('Nama produk'), 'Produk baru');
    await type(document.querySelector('[aria-label="Harga SKU"]')!, '250');
    expect(text()).toContain('Perubahan belum disimpan');
    await act(async () => (document.getElementById('product-form') as HTMLFormElement).requestSubmit());
    const patches = calls.filter(c => c.method === 'PATCH');
    expect(patches).toEqual([
      { url: '/api/admin/products/p', method: 'PATCH', body: { name: 'Produk baru', version: 3 } },
      { url: '/api/admin/variants/v', method: 'PATCH', body: { price: 250, version: 4 } },
    ]);
    expect(text()).not.toContain('Perubahan belum disimpan');
    expect(document.querySelector('h1')?.textContent).toBe('Produk baru');
  });

  it('shows a CAS conflict and reloads the current entity instead of overwriting it', async () => {
    let server = product;
    await renderAdmin('/admin/products/p', (url, init) => {
      if (url === '/api/admin/categories') return Response.json({ categories: [] });
      if (url === '/api/admin/products/p' && init.method === 'PATCH') {
        server = { ...product, name: 'Diubah admin lain', version: 4 };
        return Response.json({ error: 'Data sudah diubah oleh admin lain; muat ulang sebelum menyimpan', details: { current: server } }, { status: 409 });
      }
      if (url === '/api/admin/products/p') return Response.json({ product: server });
    });
    await type(labelled('Nama produk'), 'Draft saya');
    await act(async () => (document.getElementById('product-form') as HTMLFormElement).requestSubmit());
    const banner = () => [...document.querySelectorAll('[role="alert"]')].find(a => a.textContent?.includes('Data sudah diubah orang lain'));
    expect(banner()).toBeTruthy();
    expect(button('Simpan').disabled).toBe(true);
    await press('Muat data terbaru');
    expect(labelled('Nama produk').value).toBe('Diubah admin lain');
    expect(banner()).toBeUndefined();
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });

  it('searches variants on the server for the pre-order picker, beyond any loaded page', async () => {
    await renderAdmin('/admin/preorders', url => {
      if (url.startsWith('/api/admin/campaigns')) return Response.json({ campaigns: [], nextCursor: null });
      if (url.startsWith('/api/admin/variants/search')) return Response.json({ variants: [{ id: 'po', sku: 'SKU-PO-99', name: 'Edisi', mode: 'preorder', price: 5000, active: true, productId: 'p9', productName: 'Produk jauh' }] });
    });
    await press('Campaign baru');
    await type(document.getElementById('campaign-variant')!, 'PO-99');
    await wait(260);
    expect(calls.map(c => c.url)).toContain('/api/admin/variants/search?q=PO-99&mode=preorder');
    await act(async () => (document.querySelector('[role="option"]') as HTMLButtonElement).click());
    expect(text()).toContain('Produk jauh · Edisi');
    expect(button('Ganti varian')).toBeTruthy();
  });

  const productRoutes: Handler = (url) => {
    if (url === '/api/admin/categories') return Response.json({ categories: [] });
    if (url === '/api/admin/products/p') return Response.json({ product });
    if (url.startsWith('/api/admin/products?')) return Response.json({ products: [product], nextCursor: null });
  };
  const sidebar = (label: string) => [...document.querySelectorAll('nav a')].find(a => a.textContent === label) as HTMLAnchorElement;
  async function inDialog(label: string) {
    const target = [...document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement;
    expect(target, label).toBeTruthy();
    await act(async () => target.click());
  }

  it('guards unsaved edits against sidebar links: stay keeps the draft, discard navigates', async () => {
    await renderAdmin('/admin/products/p', productRoutes);
    await type(labelled('Nama produk'), 'Draft saya');
    await act(async () => sidebar('Kategori').click());
    expect(text()).toContain('Buang perubahan?');
    expect(location.pathname).toBe('/admin/products/p');
    await press('Tetap di sini');
    expect(text()).not.toContain('Buang perubahan?');
    expect(labelled('Nama produk').value).toBe('Draft saya');
    await act(async () => sidebar('Kategori').click());
    await inDialog('Buang');
    expect(location.pathname).toBe('/admin/categories');
    expect(document.querySelector('h1')?.textContent).toBe('Kategori');
    // The guard left with the editor: later navigation is not prompted.
    await act(async () => sidebar('Produk').click());
    expect(location.pathname).toBe('/admin/products');
    expect(text()).not.toContain('Buang perubahan?');
  });

  it('restores the guarded URL when the browser goes back, then leaves on discard', async () => {
    await renderAdmin('/admin/products/p', productRoutes);
    await type(labelled('Nama produk'), 'Draft saya');
    // The browser has already moved when popstate fires.
    await act(async () => { history.pushState(null, '', '/admin/categories'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(location.pathname).toBe('/admin/products/p');
    expect(text()).toContain('Buang perubahan?');
    expect(document.querySelector('h1')?.textContent).toBe('Produk');
    await press('Tetap di sini');
    expect(labelled('Nama produk').value).toBe('Draft saya');
    await act(async () => { history.pushState(null, '', '/admin/categories'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await inDialog('Buang');
    await wait(30);
    expect(location.pathname).toBe('/admin/categories');
    expect(document.querySelector('h1')?.textContent).toBe('Kategori');
  });

  const keydown = (element: Element, key: string) => act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
  const listOrder = (id: string, patch: Record<string, unknown> = {}) => ({ ...order({ id, reference: `FL-${id}`, ...patch }).order });

  it('shows live variant results in global search, moves with the arrow keys and closes on Escape', async () => {
    await renderAdmin('/admin/orders/o1', url => {
      if (url === '/api/admin/orders/o1') return Response.json(order());
      if (url.startsWith('/api/admin/variants/search')) return Response.json({ variants: [
        { id: 'v1', sku: 'KAOS-M', name: 'M', mode: 'stock', price: 1000, active: true, productId: 'p1', productName: 'Kaos' },
        { id: 'v2', sku: 'KAOS-L', name: 'L', mode: 'stock', price: 1000, active: true, productId: 'p2', productName: 'Kaos' }] });
      if (url === '/api/admin/products/p2') return Response.json({ product: { ...product, id: 'p2' } });
      if (url === '/api/admin/categories') return Response.json({ categories: [] });
      if (url.startsWith('/api/admin/review')) return Response.json({ items: [], nextCursor: null });
    });
    const input = document.getElementById('global-search') as HTMLInputElement;
    expect(input.placeholder).toBe('Referensi lengkap, email, HP, atau SKU…');
    await type(input, 'KAOS');
    expect(calls.some(c => c.url.startsWith('/api/admin/variants/search'))).toBe(false);
    await wait(280);
    expect(calls.map(c => c.url)).toContain('/api/admin/variants/search?q=KAOS');
    const listbox = document.querySelector('[role="listbox"]')!;
    expect([...listbox.querySelectorAll('[role="group"]')].map(g => g.getAttribute('aria-label'))).toEqual(['Pesanan', 'Produk']);
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(input.disabled).toBe(false);
    await keydown(input, 'Escape');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await keydown(input, 'ArrowDown');
    await keydown(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(document.querySelectorAll('[role="option"]')[1].id);
    await act(async () => input.closest('form')!.requestSubmit());
    expect(location.pathname).toBe('/admin/products/p2');
    expect(input.value).toBe('');
  });

  it('looks up exact orders from global search on Enter and closes on an outside click', async () => {
    await renderAdmin('/admin', url => {
      if (url === '/api/admin/orders?q=budi%40example.com&limit=5') return Response.json({ orders: [listOrder('a'), listOrder('b')], nextCursor: null });
      if (url.startsWith('/api/admin/variants/search')) return Response.json({ variants: [] });
      if (url.startsWith('/api/admin/orders')) return Response.json({ orders: [], nextCursor: null });
      if (url === '/api/admin/operations') return Response.json({ sections: {} });
    });
    const input = document.getElementById('global-search') as HTMLInputElement;
    await type(input, 'budi@example.com');
    await act(async () => input.closest('form')!.requestSubmit());
    const options = [...document.querySelectorAll('[role="option"]')].map(o => o.textContent);
    expect(options[0]).toContain('FL-a');
    expect(options[2]).toBe('Lihat semua di daftar pesanan');
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('applies order date presets as WIB from/to filters and explains exact search when nothing matches', async () => {
    const { presetRange } = await import('../apps/admin/src/pages/orders');
    await renderAdmin('/admin/orders?q=FL-9', url => url.startsWith('/api/admin/orders?') ? Response.json({ orders: [], nextCursor: null }) : undefined);
    expect(text()).toContain('Pencarian harus referensi lengkap, email, atau nomor HP');
    await press('7 hari');
    const week = presetRange('7d');
    expect(Object.fromEntries(new URLSearchParams(location.search))).toEqual({ q: 'FL-9', from: week.from, to: week.to });
    expect(calls.at(-1)!.url).toBe(`/api/admin/orders?q=FL-9&from=${week.from}&to=${week.to}&limit=50`);
    expect(presetRange('month', '2026-10-15')).toEqual({ from: '2026-10-01', to: '2026-10-15' });
    expect(presetRange('30d', '2026-10-15')).toEqual({ from: '2026-09-16', to: '2026-10-15' });
    expect(presetRange('today', '2026-10-15')).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    // Tab counts come from the shell summary.
    const tab = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent?.startsWith('Perlu diproses'))!;
    expect(tab.textContent).toBe('Perlu diproses2');
  });

  it('bulk-processes selected orders one PATCH at a time, skipping held and already processed ones', async () => {
    let page = [listOrder('a'), listOrder('b', { hold: true, openReviewReasons: ['risk_velocity'] }), listOrder('c', { fulfillment: 'processing' }), listOrder('d')];
    await renderAdmin('/admin/orders?status=to_fulfill', (url, init) => {
      if (url.startsWith('/api/admin/orders?')) return Response.json({ orders: page, nextCursor: null });
      if (init.method === 'PATCH') return Response.json({ order: { fulfillment: 'processing', status: 'paid' } });
    });
    expect(text()).not.toContain('dipilih');
    await act(async () => (document.querySelector('[aria-label="Pilih semua baris"]') as HTMLButtonElement).click());
    expect(text()).toContain('4 dipilih');
    expect(text()).toContain('2 akan dilewati');
    const lists = calls.filter(c => c.url.startsWith('/api/admin/orders?')).length;
    const summaries = calls.filter(c => c.url.startsWith('/api/admin/summary')).length;
    page = [];
    await press('Mulai proses (4)');
    expect(calls.filter(c => c.method === 'PATCH').map(c => [c.url, c.body])).toEqual([
      ['/api/admin/orders/a/fulfillment', { status: 'processing' }],
      ['/api/admin/orders/d/fulfillment', { status: 'processing' }],
    ]);
    await wait(10);
    expect(text()).toContain('2 diproses, 2 dilewati (ditahan, sudah diproses)');
    expect(calls.filter(c => c.url.startsWith('/api/admin/orders?')).length).toBe(lists + 1);
    expect(calls.filter(c => c.url.startsWith('/api/admin/summary')).length).toBe(summaries + 1);
  });

  it('prints one packing slip page per selected order', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    await renderAdmin('/admin/orders?status=to_fulfill', url => {
      if (url.startsWith('/api/admin/orders?')) return Response.json({ orders: [listOrder('a'), listOrder('b'), listOrder('c')], nextCursor: null });
      const match = /^\/api\/admin\/orders\/(\w)$/.exec(url);
      if (match) return Response.json(order({ id: match[1], reference: `FL-${match[1]}` }));
    });
    await act(async () => (document.querySelector('[aria-label="Pilih FL-a"]') as HTMLButtonElement).click());
    await act(async () => (document.querySelector('[aria-label="Pilih FL-c"]') as HTMLButtonElement).click());
    await press('Cetak packing slip (2)');
    await wait(10);
    expect([...document.querySelectorAll('[data-print-view="packing"] [data-print-order]')].map(s => s.getAttribute('data-print-order'))).toEqual(['FL-a', 'FL-c']);
    expect(calls.filter(c => /^\/api\/admin\/orders\/\w$/.test(c.url)).map(c => c.url)).toEqual(['/api/admin/orders/a', '/api/admin/orders/c']);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('returns from an order to the filtered list and steps to the next order', async () => {
    await renderAdmin('/admin/orders?status=shipped&from=2026-10-01', url => {
      if (url.startsWith('/api/admin/orders?')) return Response.json({ orders: [listOrder('a'), listOrder('b')], nextCursor: null });
      const match = /^\/api\/admin\/orders\/(\w)$/.exec(url);
      if (match) return Response.json(order({ id: match[1], reference: `FL-${match[1]}` }));
      if (url.startsWith('/api/admin/review')) return Response.json({ items: [], nextCursor: null });
    });
    const link = [...document.querySelectorAll('a')].find(a => a.textContent === 'FL-a')!;
    await act(async () => link.click());
    expect(document.querySelector('h1')?.textContent).toBe('Pesanan FL-a');
    const anchor = (label: string) => [...document.querySelectorAll('a')].find(a => a.textContent?.trim() === label) as HTMLAnchorElement;
    expect(anchor('Pesanan').getAttribute('href')).toBe('/admin/orders?status=shipped&from=2026-10-01');
    expect(sidebar('Pesanan').getAttribute('href')).toBe('/admin/orders?status=shipped&from=2026-10-01');
    expect(text()).toContain('1 / 2');
    await act(async () => anchor('Berikutnya').click());
    expect(document.querySelector('h1')?.textContent).toBe('Pesanan FL-b');
    expect(button('Berikutnya').disabled).toBe(true);
    await act(async () => anchor('Pesanan').click());
    expect(location.search).toBe('?status=shipped&from=2026-10-01');
  });

  it('offers the next order after a fulfillment step, guards the draft and saves it with Ctrl+S', async () => {
    sessionStorage.setItem('admin:list:orders', JSON.stringify({ url: '/orders?status=to_fulfill', ids: ['o1', 'o2'] }));
    let fulfillment = 'processing';
    await renderAdmin('/admin/orders/o1', (url, init) => {
      if (url === '/api/admin/orders/o1') return Response.json(order({ fulfillment }));
      if (init.method === 'PATCH') { fulfillment = 'shipped'; return Response.json({ order: { id: 'o1', fulfillment, status: 'paid' } }); }
    });
    await type(labelled('Nomor resi'), 'RESI123');
    await act(async () => sidebar('Beranda').click());
    expect(text()).toContain('Nomor resi atau catatan pengiriman yang belum disimpan akan hilang.');
    await press('Tetap di sini');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(calls.find(c => c.method === 'PATCH')!.body).toEqual({ status: 'shipped', tracking: 'RESI123', courier: 'jne' });
    const next = [...document.querySelectorAll('a')].find(a => a.textContent === 'Lanjut ke pesanan berikutnya')!;
    expect(next.getAttribute('href')).toBe('/admin/orders/o2');
  });

  it('copies order details with one click and links WhatsApp with the normalized number', async () => {
    const writeText = vi.fn(async (_value: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderAdmin('/admin/orders/o1', url => url === '/api/admin/orders/o1' ? Response.json(order({ tracking: { number: 'RESI9', courier: 'jne', courierName: 'JNE', url: null } })) : undefined);
    for (const [name, value] of [['referensi', 'FL-1'], ['email', 'budi@example.com'], ['nomor HP', '081234567890'], ['nomor resi', 'RESI9'], ['alamat lengkap', 'Budi\n081234567890\nJl. Mawar 1\nJAKARTA']]) {
      await act(async () => (document.querySelector(`[aria-label="Salin ${name}"]`) as HTMLButtonElement).click());
      expect(writeText).toHaveBeenLastCalledWith(value);
    }
    await wait(10);
    expect(text()).toContain('Disalin');
    expect([...document.querySelectorAll('a')].find(a => a.textContent === 'WhatsApp')!.getAttribute('href')).toBe('https://wa.me/6281234567890');
    expect([...document.querySelectorAll('a')].find(a => a.textContent === 'Pesanan lain dari pembeli ini')!.getAttribute('href')).toBe('/admin/orders?q=budi%40example.com');
  });

  it('filters products by status on the server, searches live and shows the price range', async () => {
    const two = { ...product, variants: [product.variants[0], { ...product.variants[0], id: 'v2', sku: 'SKU-2', price: 25000 }] };
    await renderAdmin('/admin/products', url => {
      if (url === '/api/admin/categories') return Response.json({ categories: [] });
      if (url.startsWith('/api/admin/products?')) return Response.json({ products: [two], nextCursor: null });
    });
    expect(text()).toContain('Rp 100 – Rp 25.000');
    const archived = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent === 'Diarsipkan')!;
    await act(async () => archived.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    expect(calls.at(-1)!.url).toBe('/api/admin/products?status=archived&limit=30');
    const search = document.querySelector('[aria-label="Cari produk"]')!;
    await type(search, 'k');
    await wait(350);
    expect(calls.at(-1)!.url).toBe('/api/admin/products?status=archived&limit=30');
    expect(text()).toContain('Ketik minimal 2 karakter.');
    await type(search, 'kaos');
    await wait(150);
    expect(calls.some(c => c.url.includes('q=kaos'))).toBe(false);
    await wait(200);
    expect(calls.at(-1)!.url).toBe('/api/admin/products?q=kaos&status=archived&limit=30');
  });

  it('derives the slug from the name until edited and names the exact blockers in the save bar', async () => {
    await renderAdmin('/admin/products/new', url => (url === '/api/admin/categories' ? Response.json({ categories: [] }) : undefined));
    await type(labelled('Nama produk'), 'Kaos Polos Édisi');
    expect(labelled('Slug URL').value).toBe('kaos-polos-edisi');
    await type(labelled('Slug URL'), 'kaos');
    await type(labelled('Nama produk'), 'Kaos Polos Baru');
    expect(labelled('Slug URL').value).toBe('kaos');
    await type(document.querySelector('[aria-label="SKU varian 1"]')!, 'K-1');
    await type(document.querySelector('[aria-label="Harga varian 1"]')!, '150000');
    expect(text()).toContain('Rp 150.000');
    await act(async () => (document.querySelector('[aria-label="Duplikat varian 1"]') as HTMLButtonElement).click());
    const bar = () => document.querySelector('[aria-label="Belum bisa disimpan"]')?.textContent;
    expect(bar()).toContain('Isi SKU: varian 2');
    expect(bar()).toContain('Isi berat: varian 1, 2');
    expect((document.querySelector('[aria-label="Harga varian 2"]') as HTMLInputElement).value).toBe('150000');
    expect(button('Simpan').disabled).toBe(true);
    await act(async () => ([...document.querySelectorAll('[aria-label="Belum bisa disimpan"] button')].find(b => b.textContent?.startsWith('Isi berat')) as HTMLButtonElement).click());
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Berat varian 1');
    await type(document.querySelector('[aria-label="Harga varian 2"]')!, '99000');
    await act(async () => (document.querySelector('[aria-label="Terapkan harga varian 2 ke semua"]') as HTMLButtonElement).click());
    expect((document.querySelector('[aria-label="Harga varian 1"]') as HTMLInputElement).value).toBe('99000');
  });

  it('duplicates a product into the new-product editor without SKUs or stock', async () => {
    const source = { ...product, variants: [{ ...product.variants[0], maxPerOrder: 2, lengthCm: 10 }], categoryId: 'c1', category: { slug: 'kaos', name: 'Kaos' } };
    await renderAdmin('/admin/products/p', (url, init) => {
      if (url === '/api/admin/categories') return Response.json({ categories: [{ id: 'c1', slug: 'kaos', name: 'Kaos', position: 0, active: true, version: 0 }] });
      if (url === '/api/admin/products/p') return Response.json({ product: source });
      if (url === '/api/admin/products' && init.method === 'POST') return Response.json({ product: { ...source, id: 'p2' } }, { status: 201 });
      if (url === '/api/admin/products/p2') return Response.json({ product: { ...source, id: 'p2' } });
    });
    await press('Duplikat');
    expect(location.pathname + location.search).toBe('/admin/products/new?duplicate=p');
    expect(document.querySelector('h1')?.textContent).toBe('Duplikat produk');
    expect(labelled('Nama produk').value).toBe('Produk (salinan)');
    expect(labelled('Slug URL').value).toBe('produk-salinan');
    expect((document.querySelector('[aria-label="SKU varian 1"]') as HTMLInputElement).value).toBe('');
    expect((document.querySelector('[aria-label="Stok awal varian 1"]') as HTMLInputElement).value).toBe('0');
    expect((document.querySelector('[aria-label="Berat varian 1"]') as HTMLInputElement).value).toBe('10');
    // Editing the name of a copy keeps its slug.
    await type(labelled('Nama produk'), 'Produk kedua');
    expect(labelled('Slug URL').value).toBe('produk-salinan');
    await type(document.querySelector('[aria-label="SKU varian 1"]')!, 'SKU-COPY');
    await act(async () => (document.getElementById('product-form') as HTMLFormElement).requestSubmit());
    const body = calls.find(c => c.method === 'POST')!.body;
    expect(body).toEqual({ slug: 'produk-salinan', name: 'Produk kedua', description: 'Deskripsi', categoryId: 'c1', variants: [{ sku: 'SKU-COPY', name: 'Varian', price: 100, weight: 10, mode: 'stock', maxPerOrder: 2, maxPerCustomer: null, lengthCm: 10, widthCm: null, heightCm: null, lowStockThreshold: null, stock: 0 }] });
    expect(location.pathname).toBe('/admin/products/p2');
    expect(text()).not.toContain('Buang perubahan?');
  });

  it('converts a stock count (opname) into a ledger delta against fresh stock and previews it', async () => {
    await renderAdmin('/admin/inventory', (url, init) => {
      if (url.startsWith('/api/admin/products?')) return Response.json({ products: [product], nextCursor: null });
      if (url === '/api/admin/inventory?variantId=v&limit=1') return Response.json({ inventory: { variantId: 'v', onHand: 12, reserved: 3, available: 9 }, movements: [], nextCursor: null });
      if (url === '/api/admin/inventory' && init.method === 'POST') return Response.json({ inventory: { variantId: 'v', onHand: 15, reserved: 3 } });
    });
    await press('Sesuaikan SKU');
    expect(text()).toContain('Fisik 12 · Tersedia 9');
    await press('Set stok fisik (opname)');
    await type(labelled('Stok fisik hasil hitung'), '2');
    expect(text()).toContain('Stok fisik tidak boleh kurang dari 3 unit yang direservasi pesanan.');
    expect(button('Simpan penyesuaian').disabled).toBe(true);
    await type(labelled('Stok fisik hasil hitung'), '15');
    expect(text()).toContain('Fisik 12 → 15 · Tersedia 9 → 12');
    expect(text()).toContain('Selisih dicatat: +3');
    await press('Stok opname');
    expect(labelled('Alasan').value).toBe('Stok opname');
    await act(async () => (document.getElementById('adjust-form') as HTMLFormElement).requestSubmit());
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ variantId: 'v', delta: 3, reason: 'Stok opname' });
    expect(text()).toContain('15');
  });

  it('reorders categories with compare-and-swap PATCHes and blocks deleting one in use', async () => {
    const categories = [
      { id: 'a', slug: 'a', name: 'Alpha', position: 1, active: true, version: 2, productCount: 3 },
      { id: 'b', slug: 'b', name: 'Beta', position: 5, active: true, version: 7, productCount: 0 },
    ];
    await renderAdmin('/admin/categories', (url, init) => {
      if (url === '/api/admin/categories') return Response.json({ categories });
      const match = /^\/api\/admin\/categories\/(\w)$/.exec(url);
      if (match && init.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        const current = categories.find(c => c.id === match[1])!;
        return Response.json({ category: { ...current, productCount: undefined, position: body.position, version: current.version + 1 } });
      }
    });
    expect([...document.querySelectorAll('a')].find(a => a.textContent === 'Alpha')!.getAttribute('href')).toBe('/admin/products?category=a');
    expect(document.querySelector('[aria-label="Hapus Alpha"]')).toBeNull();
    expect(document.querySelector('[aria-label^="Alpha tidak dapat dihapus"]')).toBeTruthy();
    expect(document.querySelector('[aria-label="Hapus Beta"]')).toBeTruthy();
    await act(async () => (document.querySelector('[aria-label="Turunkan Alpha"]') as HTMLButtonElement).click());
    expect(calls.filter(c => c.method === 'PATCH').map(c => [c.url, c.body])).toEqual([
      ['/api/admin/categories/a', { position: 5, version: 2 }],
      ['/api/admin/categories/b', { position: 1, version: 7 }],
    ]);
    expect([...document.querySelectorAll('tbody a')].map(a => a.textContent)).toEqual(['Beta', 'Alpha']);
    const { moveChanges } = await import('../apps/admin/src/pages/categories');
    const tied = ['x', 'y', 'z'].map(id => ({ id, slug: id, name: id, position: 0, active: true, version: 0 }));
    expect(moveChanges(tied, 1, -1).map(c => [c.category.id, c.position])).toEqual([['x', 1], ['z', 2]]);
  });

  const customer = (id: string, patch: Record<string, unknown> = {}) => ({ id, name: `Nama ${id}`, email: `${id}@mail.id`, createdAt: 1, orders: 2, banned: false, admin: false, ...patch });

  it('searches customers on the server after a pause and links their orders', async () => {
    const writeText = vi.fn(async (_value: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderAdmin('/admin/customers', url => url.startsWith('/api/admin/customers?') ? Response.json({ customers: [customer('u1')], nextCursor: null }) : undefined);
    expect(calls.map(c => c.url)).toContain('/api/admin/customers?limit=50');
    expect([...document.querySelectorAll('a')].find(a => a.textContent === '2')!.getAttribute('href')).toBe('/admin/orders?q=u1%40mail.id');
    await act(async () => (document.querySelector('[aria-label="Salin ID pengguna Nama u1"]') as HTMLButtonElement).click());
    expect(writeText).toHaveBeenCalledWith('u1');
    await type(document.querySelector('[aria-label="Cari pelanggan"]')!, 'budi');
    await wait(150);
    expect(calls.some(c => c.url.includes('q=budi'))).toBe(false);
    await wait(200);
    expect(location.search).toBe('?q=budi');
    expect(calls.at(-1)!.url).toBe('/api/admin/customers?q=budi&limit=50');
  });

  it('filters reviews by status on the server and shows the open count on its tab', async () => {
    await renderAdmin('/admin/reviews', url => url.startsWith('/api/admin/review?') ? Response.json({ items: [{ id: 'r1', orderId: null, reason: 'risk_velocity', status: 'open', note: '', createdAt: Date.now() - 3 * 3_600_000, reference: null }], nextCursor: null }) : undefined);
    expect(calls.map(c => c.url)).toContain('/api/admin/review?status=open&limit=50');
    expect(text()).toContain('3 jam lalu');
    const tab = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent?.startsWith('Terbuka'))!;
    expect(tab.textContent).toBe('Terbuka1');
    const resolved = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent === 'Selesai')!;
    await act(async () => resolved.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    expect(calls.at(-1)!.url).toBe('/api/admin/review?status=resolved&limit=50');
  });

  it('inserts note templates, guards the note and offers the next open case after resolving', async () => {
    sessionStorage.setItem('admin:list:reviews', JSON.stringify({ url: '/reviews', ids: ['r1', 'r2'] }));
    let item = { id: 'r1', orderId: null, reason: 'risk_velocity', eventKey: null, createdAt: 1, status: 'open', note: '', version: 0, updatedAt: null, updatedBy: null, reference: null };
    await renderAdmin('/admin/reviews/r1', (url, init) => {
      if (url === '/api/admin/review/r1' && init.method === 'PATCH') { item = { ...item, status: 'resolved', note: JSON.parse(String(init.body)).note, version: 1 }; return Response.json({ updated: true, version: 1 }); }
      if (url === '/api/admin/review/r1') return Response.json({ item, order: null, attempt: null, triggeringEvent: null, events: [], history: [] });
    });
    await press('Dicek di dashboard DOKU');
    await press('Duplikat');
    expect(labelled('Catatan operator').value).toBe('Dicek di dashboard DOKU\nDuplikat');
    await act(async () => sidebar('Pesanan').click());
    expect(text()).toContain('Catatan review yang belum disimpan akan hilang.');
    await press('Tetap di sini');
    await press('Tandai selesai');
    expect(calls.find(c => c.method === 'PATCH')!.body).toEqual({ version: 0, status: 'resolved', note: 'Dicek di dashboard DOKU\nDuplikat' });
    const next = [...document.querySelectorAll('a')].find(a => a.textContent === 'Review berikutnya')!;
    expect(next.getAttribute('href')).toBe('/admin/reviews/r2');
  });

  it('grants admin access to a customer picked by email search', async () => {
    await renderAdmin('/admin/settings/team', (url, init) => {
      if (url === '/api/admin/roles' && init.method === 'POST') return Response.json({ ok: true, changed: true });
      if (url === '/api/admin/roles') return Response.json({ admins: [{ userId: 'admin', name: 'Admin', email: 'admin@example.com', role: 'owner', grantedBy: 'admin', createdAt: 1, installationOwner: true }] });
      if (url.startsWith('/api/admin/customers?')) return Response.json({ customers: [customer('staff', { admin: true }), customer('sari')], nextCursor: null });
    });
    expect(text()).not.toContain('Salin ID pengguna');
    expect(document.querySelector('label[for="grant-user"]')?.textContent).toBe('Pengguna');
    await type(document.getElementById('grant-user')!, 'mail.id');
    await wait(300);
    expect(calls.map(c => c.url)).toContain('/api/admin/customers?q=mail.id&limit=10');
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options[0].getAttribute('aria-disabled')).toBe('true');
    await act(async () => (options[0] as HTMLElement).click());
    expect(button('Beri akses').disabled).toBe(true);
    await act(async () => (options[1] as HTMLElement).click());
    expect(text()).toContain('sari@mail.id');
    await type(labelled('Peran'), 'catalog');
    await act(async () => button('Beri akses').closest('form')!.requestSubmit());
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ userId: 'sari', role: 'catalog' });
  });

  it('asks before an owner demotes themselves or another owner', async () => {
    await renderAdmin('/admin/settings/team', (url, init) => {
      if (url === '/api/admin/roles' && init.method === 'POST') return Response.json({ ok: true, changed: true });
      if (url === '/api/admin/roles') return Response.json({ admins: [
        { userId: 'admin', name: 'Admin', email: 'admin@example.com', role: 'owner', grantedBy: 'admin', createdAt: 1, installationOwner: false },
        { userId: 'o2', name: 'Owner Dua', email: 'o2@example.com', role: 'owner', grantedBy: 'admin', createdAt: 2, installationOwner: false },
        { userId: 's', name: 'Staf', email: 's@example.com', role: 'ops', grantedBy: 'admin', createdAt: 3, installationOwner: false }] });
    });
    await type(document.querySelector('[aria-label="Peran Staf"]')!, 'catalog');
    expect(calls.filter(c => c.method === 'POST').map(c => c.body)).toEqual([{ userId: 's', role: 'catalog' }]);
    await type(document.querySelector('[aria-label="Peran Owner Dua"]')!, 'ops');
    expect(text()).toContain('Turunkan Owner Dua dari owner?');
    await inDialog('Batal');
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...location, assign });
    await type(document.querySelector('[aria-label="Peran Admin"]')!, 'ops');
    expect(text()).toContain('Turunkan peranmu sendiri?');
    await inDialog('Turunkan peran');
    expect(calls.filter(c => c.method === 'POST').at(-1)!.body).toEqual({ userId: 'admin', role: 'ops' });
    expect(assign).toHaveBeenCalledWith('/admin/');
  });

  it('shows the normalized phone before blocking and filters loaded entries by kind', async () => {
    await renderAdmin('/admin/blocklist', url => url.startsWith('/api/admin/blocklist?') ? Response.json({ items: [
      { id: 'b1', kind: 'email', reason: 'Spam', actor: 'ops-1', createdAt: 1 }, { id: 'b2', kind: 'ip', reason: 'Bot', actor: 'ops-2', createdAt: 2 }], nextCursor: null }) : undefined);
    expect(text()).toContain('ops-1');
    const ip = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent === 'IP')!;
    await act(async () => ip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    expect(text()).not.toContain('Spam');
    expect(text()).toContain('Bot');
    const { phoneHint } = await import('../apps/admin/src/pages/blocklist');
    expect(phoneHint('0812-3456-789')).toBe('Disimpan sebagai +62812345678' + '9');
    expect(phoneHint('12345')).toContain('Bukan nomor HP Indonesia');
  });

  it('shows skeleton rows only on first load and keeps rows on screen, dimmed and inert, while filters refresh', async () => {
    const row = (id: string, reference: string) => ({ ...order().order, id, reference });
    const first = deferred<Response>();
    const shipped = deferred<Response>();
    await renderAdmin('/admin/orders', url => {
      if (!url.startsWith('/api/admin/orders?')) return undefined;
      if (url.includes('from=')) return Response.json({ error: 'Gagal memuat.' }, { status: 500 });
      return url.includes('status=shipped') ? shipped.promise : first.promise;
    });
    expect(document.querySelectorAll('tbody [data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(text()).not.toContain('Tidak ada pesanan');
    await act(async () => first.resolve(Response.json({ orders: [row('o1', 'FL-1')], nextCursor: { before: 1, beforeId: 'o1' } })));
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(button('Muat lebih banyak')).toBeTruthy();

    const tab = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent === 'Dikirim')!;
    await act(async () => tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    const body = document.querySelector('tbody')!;
    expect(text()).toContain('FL-1');
    expect(body.hasAttribute('inert')).toBe(true);
    expect(body.classList.contains('is-stale')).toBe(true);
    expect(document.querySelector('[aria-busy="true"] .loading-bar')).toBeTruthy();
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
    // The old cursor belongs to the previous filter; load-more waits for the new page.
    expect(button('Muat lebih banyak')).toBeUndefined();
    await act(async () => shipped.resolve(Response.json({ orders: [row('o2', 'FL-2')], nextCursor: null })));
    expect(text()).toContain('FL-2');
    expect(text()).not.toContain('FL-1');
    expect(document.querySelector('tbody')!.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('[aria-busy]')).toBeNull();

    // A failed refresh must not leave the previous filter's rows looking current.
    await type(document.getElementById('orders-from')!, '2026-10-01');
    expect(text()).not.toContain('FL-2');
    expect(text()).toContain('Gagal memuat.');
  });

  it('shows a detail skeleton while duplicating instead of a blank form that refills', async () => {
    const source = deferred<Response>();
    await renderAdmin('/admin/products/new?duplicate=p', url => {
      if (url === '/api/admin/categories') return Response.json({ categories: [] });
      if (url === '/api/admin/products/p') return source.promise;
    });
    expect(document.querySelector('h1')?.textContent).toBe('Duplikat produk');
    expect(document.querySelector('[role="status"][aria-label="Memuat produk sumber"]')).toBeTruthy();
    expect(document.getElementById('product-form')).toBeNull();
    await act(async () => source.resolve(Response.json({ product })));
    expect(document.querySelector('[aria-label="Memuat produk sumber"]')).toBeNull();
    expect(labelled('Nama produk').value).toBe('Produk (salinan)');
  });

  it('keeps dashboard figures on screen while another range loads', async () => {
    const week = deferred<Response>();
    await renderAdmin('/admin', url => {
      if (url.startsWith('/api/admin/orders')) return Response.json({ orders: [] });
      if (url === '/api/admin/operations') return Response.json({ sections: {} });
    });
    vi.mocked(fetch).mockImplementationOnce(async () => week.promise);
    const tab = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent === '7 hari')!;
    await act(async () => tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    const revenue = [...document.querySelectorAll('[data-slot="card-title"]')].find(t => t.closest('[data-slot="card"]')?.textContent?.startsWith('Penjualan'))!;
    expect(revenue.classList.contains('is-stale')).toBe(true);
    expect(revenue.querySelector('[data-slot="skeleton"]')).toBeNull();
    await act(async () => week.resolve(Response.json({ ...summaryBody, range: '7d', revenue: 5000 })));
    expect(revenue.classList.contains('is-stale')).toBe(false);
    expect(text()).toContain('Rp 5.000');
  });

  it('names the browser tab after the current page', async () => {
    await renderAdmin('/admin/products/p', productRoutes);
    expect(document.title).toBe('Produk · Admin Flaremmerce');
    await act(async () => sidebar('Kategori').click());
    expect(document.title).toBe('Kategori · Admin Flaremmerce');
  });
});

describe('admin helpers', () => {
  it('formats slugs, WhatsApp links, ranges and ages the way the server and operators expect', async () => {
    const format = await import('../apps/admin/src/lib/format');
    expect(format.slugify('  Kaos Polos — Édition #2!  ')).toBe('kaos-polos-edition-2');
    expect(format.slugify('---')).toBe('');
    expect(format.slugify('a'.repeat(99) + ' b')).toBe('a'.repeat(99));
    expect(format.whatsappLink('0812-3456-7890')).toBe('https://wa.me/6281234567890');
    expect(format.whatsappLink('+62 812 3456 7890')).toBe('https://wa.me/6281234567890');
    expect(format.whatsappLink('021 555 1234')).toBeNull();
    const wib = (s: string) => Date.parse(`${s}+07:00`);
    expect(format.rangeWIB(wib('2026-10-01T00:00:00'), wib('2026-10-15T12:00:00'))).toBe('1–15 Okt 2026 WIB');
    expect(format.rangeWIB(wib('2026-09-16T08:00:00'), wib('2026-10-15T08:00:00'))).toBe('16 Sep – 15 Okt 2026 WIB');
    expect(format.rangeWIB(wib('2026-10-15T00:00:00'), wib('2026-10-15T09:00:00'))).toBe('15 Okt 2026 WIB');
    expect(format.ago(30_000)).toBe('baru saja');
    expect(format.ago(3 * 3_600_000)).toBe('3 jam lalu');
    expect(format.shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('storefront checkout and order status', () => {
  const line = { variantId: 'a', quantity: 1, available: true, sku: 'SKU-A', name: 'Base', productName: 'Catan', productSlug: 'catan', price: 1000, lineTotal: 1000, mode: 'stock', stockLevel: 'in_stock', enough: true, maxPerOrder: null, maxPerCustomer: null, weight: 100, campaign: null };
  const previewBody = (price = 1000) => ({ lines: [{ ...line, price, lineTotal: price }], subtotal: price, weight: 100, shipPromise: { shipFrom: null, shipTo: null, policy: 'single-shipment-latest-item' }, problems: [] });
  type Handler = (body: any, init: RequestInit) => Response | Promise<Response>;
  function server(checkout: Handler, quote = () => ({ id: 'q1', service: 'jne:REG', amount: 100, expiresAt: Date.now() + 300000 }), price = { value: 1000 }) {
    const calls: { path: string; body: any; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path: input, body, init });
      if (input === '/api/cart/preview') return Response.json(previewBody(price.value));
      if (input === '/api/config') return Response.json({ turnstileSiteKey: 'site-key' });
      if (input === '/api/account/addresses') return Response.json({ error: 'Sign in required' }, { status: 401 });
      if (input === '/api/shipping/destinations') return Response.json({ destinations: [{ id: '42', label: 'MENTENG, JAKARTA PUSAT', city: 'JAKARTA PUSAT', postalCode: '10310' }] });
      if (input === '/api/shipping/quote') return Response.json({ quotes: [quote()] });
      if (input === '/api/checkout') return checkout(body, init);
      throw new Error(`Unexpected ${input}`);
    }));
    return calls;
  }
  async function type(id: string, value: string) {
    await act(async () => {
      const input = document.getElementById(id) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function choose(id: string, value: string) {
    await act(async () => {
      const select = document.getElementById(id) as HTMLSelectElement;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  const consent = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const submit = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const totalText = () => [...document.querySelectorAll('.line.row')].find(row => row.textContent!.startsWith('Total'))!.textContent;
  async function fillCheckout() {
    localStorage.setItem('flaremmerce-cart', JSON.stringify([{ variantId: 'a', quantity: 1 }]));
    await act(async () => root.render(<Checkout />));
    expect(totalText()).toContain('Pilih ongkir');
    await type('name', 'Budi'); await type('email', 'budi@example.com'); await type('phone', '081234567890'); await type('line', 'Jl. Mawar 1');
    await type('destination-search', 'menteng'); await click('Cari wilayah');
    await choose('destination', '42'); await click('Periksa ongkir'); await choose('shipping', 'q1');
    await act(async () => consent().click());
  }
  const checkouts = (calls: { path: string; body: any }[]) => calls.filter(c => c.path === '/api/checkout').map(c => c.body);
  const placed = (body: any, extra: Record<string, unknown> = {}) => Response.json({ order: { id: 'o1', reference: 'FL-REF', status: 'pending_payment', total: body.expectedTotal, guestToken: 'guest-secret', shipPromise: { shipFrom: '2027-02-01', shipTo: '2027-02-20', policy: 'single-shipment-latest-item' }, ...extra }, paymentState: 'pending', paymentUrl: 'https://sandbox.doku.com/pay' });

  it('asks to re-confirm a changed total and resends it with a fresh key, then shows the snapshotted ship promise', async () => {
    const price = { value: 1000 };
    let first = true;
    const calls = server(body => {
      if (first) { first = false; price.value = 1500; return Response.json({ error: 'Total changed; confirm authoritative total', details: { total: 1600 } }, { status: 409 }); }
      return placed(body);
    }, undefined, price);
    await fillCheckout();
    expect(totalText()).toContain(money(1100));
    await act(async () => submit().click());
    expect(document.body.textContent).toContain(`Total berubah dari ${money(1100)} menjadi ${money(1600)}`);
    expect(consent().checked).toBe(false);
    expect(submit().disabled).toBe(true);
    expect(totalText()).toContain(money(1600));
    await act(async () => consent().click());
    await act(async () => submit().click());
    const [refused, accepted] = checkouts(calls);
    expect(refused.expectedTotal).toBe(1100);
    expect(accepted.expectedTotal).toBe(1600);
    expect(accepted.idempotencyKey).not.toBe(refused.idempotencyKey);
    expect(accepted.turnstileToken).not.toBe(refused.turnstileToken);
    expect(document.body.textContent).toContain('Referensi FL-REF');
    expect(document.querySelector('[aria-label="Janji pengiriman"]')!.textContent).toContain('Estimasi kirim');
    expect(document.querySelector('[aria-label="Janji pengiriman"]')!.textContent).toContain('2027');
    let blob: Blob | undefined;
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn((value: Blob) => { blob = value; return 'blob:confirmation'; }), revokeObjectURL: vi.fn() }));
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await click('Simpan konfirmasi');
    expect(clicked).toHaveBeenCalled();
    const text = await blob!.text();
    expect(text).toContain('Referensi: FL-REF');
    expect(text).toContain('Token akses privat: guest-secret');
    expect(location.href).not.toContain('guest-secret');
  });

  it('keeps the idempotency key and frozen payload after ambiguous failures, and only renews it after a definite refusal', async () => {
    let attempt = 0;
    const calls = server(body => {
      attempt++;
      if (attempt === 1) throw new TypeError('Failed to fetch');
      if (attempt === 2) return Response.json({ error: 'Service temporarily unavailable' }, { status: 503 });
      if (attempt === 3) return Response.json({ error: 'Terlalu banyak pesanan belum dibayar' }, { status: 429 });
      return placed(body);
    });
    await fillCheckout();
    await act(async () => submit().click());
    expect(document.body.textContent).toContain('Hasil pesanan belum pasti');
    expect(document.querySelector<HTMLAnchorElement>('a[href="/order"]')!.textContent).toBe('Periksa status pesanan');
    for (const id of ['name', 'email', 'phone', 'line', 'destination', 'shipping']) expect((document.getElementById(id) as HTMLInputElement).disabled).toBe(true);
    expect(submit().textContent).toBe('Kirim ulang pesanan yang sama');
    await act(async () => submit().click());
    expect(submit().textContent).toBe('Kirim ulang pesanan yang sama');
    await act(async () => submit().click());
    expect(document.body.textContent).toContain('Terlalu banyak pesanan belum dibayar');
    expect((document.getElementById('name') as HTMLInputElement).disabled).toBe(false);
    await act(async () => submit().click());
    const bodies = checkouts(calls);
    expect(bodies).toHaveLength(4);
    const strip = ({ turnstileToken: _t, ...rest }: any) => rest;
    expect(strip(bodies[1])).toEqual(strip(bodies[0]));
    expect(strip(bodies[2])).toEqual(strip(bodies[0]));
    expect(bodies[3].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
    expect(document.body.textContent).toContain('Referensi FL-REF');
  });

  it('drops an expired quote, shows "Pilih ongkir" and keeps the quote while editing the street line', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      server(placed, () => ({ id: 'q1', service: 'jne:REG', amount: 100, expiresAt: Date.now() + 8000 }));
      await fillCheckout();
      await type('line', 'Jl. Melati 2, RT 3');
      expect((document.getElementById('shipping') as HTMLSelectElement).value).toBe('q1');
      expect(consent().checked).toBe(true);
      expect(totalText()).toContain(money(1100));
      await act(async () => { vi.advanceTimersByTime(10000); });
      expect((document.getElementById('shipping') as HTMLSelectElement).value).toBe('');
      expect(document.querySelector('#shipping option[value="q1"]')).toBeNull();
      expect(document.body.textContent).toContain('Ongkir kedaluwarsa');
      expect(totalText()).toContain('Pilih ongkir');
      expect(submit().disabled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('fills checkout from a saved address and saves a new one for signed-in customers', async () => {
    const saved = { id: 'addr-1', label: 'Rumah', name: 'Sari', phone: '+6281234567890', line: 'Jl. Kenanga 5', destination: '42', destinationLabel: 'MENTENG, JAKARTA PUSAT', city: 'JAKARTA PUSAT', postalCode: '10310' };
    const posted: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      if (input === '/api/cart/preview') return Response.json(previewBody());
      if (input === '/api/config') return Response.json({ turnstileSiteKey: 'site-key' });
      if (input === '/api/account/addresses' && init.method === 'POST') { posted.push(JSON.parse(String(init.body))); return Response.json({ address: { ...saved, id: 'addr-2', label: 'Kantor' } }); }
      if (input === '/api/account/addresses') return Response.json({ addresses: [saved], max: 5 });
      if (input === '/api/shipping/quote') return Response.json({ quotes: [{ id: 'q1', service: 'jne:REG', amount: 100, expiresAt: Date.now() + 300000 }] });
      throw new Error(`Unexpected ${input}`);
    }));
    localStorage.setItem('flaremmerce-cart', JSON.stringify([{ variantId: 'a', quantity: 1 }]));
    await act(async () => root.render(<Checkout />));
    expect(document.body.textContent).not.toContain('Checkout tamu');
    await choose('saved-address', 'addr-1');
    expect((document.getElementById('name') as HTMLInputElement).value).toBe('Sari');
    expect((document.getElementById('line') as HTMLInputElement).value).toBe('Jl. Kenanga 5');
    expect((document.getElementById('destination') as HTMLSelectElement).value).toBe('42');
    await click('Periksa ongkir');
    expect((document.getElementById('shipping') as HTMLSelectElement).disabled).toBe(false);
    await type('address-label', 'Kantor');
    await click('Simpan ke buku alamat');
    expect(posted).toEqual([{ label: 'Kantor', name: 'Sari', phone: '+6281234567890', line: 'Jl. Kenanga 5', destination: '42' }]);
    expect(document.body.textContent).toContain('Alamat disimpan ke buku alamat.');
  });

  const order = (status: string, extra: Record<string, unknown> = {}) => ({ access: { type: 'guest' }, paymentState: status === 'pending_payment' ? 'pending' : 'succeeded',
    order: { reference: 'FL-1', status, fulfillment: 'unfulfilled', total: 1100, currency: 'IDR', createdAt: 1, contact: { name: 'Budi', phone: '+62812' }, address: { line: 'Jl. 1', label: 'MENTENG' },
      shipping: { service: 'jne:REG', amount: 100 }, items: [{ id: 'i1', productName: 'Catan', name: 'Base', sku: 'SKU-A', quantity: 1, price: 1000 }], timeline: [], tracking: null, ...extra } });
  it.each([
    [409, 'Pembayaran sudah tercatat berhasil'],
    [503, 'Status pembayaran belum dapat dipastikan'],
    [200, 'Pesanan dibatalkan.'],
  ] as const)('lets a guest cancel an unpaid order after confirming (%s)', async (status, message) => {
    sessionStorage.setItem('flaremmerce-order-access', JSON.stringify({ reference: 'FL-1', token: 'private-token' }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let cancelled = false;
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/orders/FL-1/cancel') {
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['X-Order-Token']).toBe('private-token');
        if (status === 200) { cancelled = true; return Response.json({ order: { reference: 'FL-1', status: 'cancelled' }, cancelled: true }); }
        return Response.json({ error: 'x' }, { status });
      }
      if (url === '/api/orders/FL-1') return Response.json(order(cancelled ? 'cancelled' : 'pending_payment', { timeline: cancelled ? [{ kind: 'cancelled_by_customer', createdAt: 2, details: {} }] : [] }));
      return Response.json({}, { status: 401 });
    });
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(<OrderStatus />));
    confirmSpy.mockReturnValueOnce(false);
    await click('Batalkan pesanan');
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(false);
    await click('Batalkan pesanan');
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(message);
    if (status === 200) {
      expect(document.body.textContent).toContain('Dibatalkan oleh pembeli');
      expect([...document.querySelectorAll('button')].some(b => b.textContent === 'Batalkan pesanan')).toBe(false);
    }
  });

  it('prints a receipt for paid orders and links the courier tracking page', async () => {
    sessionStorage.setItem('flaremmerce-order-access', JSON.stringify({ reference: 'FL-1', token: 'private-token' }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/orders/FL-1'
      ? Response.json(order('paid', { fulfillment: 'shipped', tracking: { number: 'AWB-9', courier: 'jne', courierName: 'JNE', url: 'https://www.jne.co.id/tracking-package' }, timeline: [{ kind: 'auto_completed', createdAt: 3, details: {} }] }))
      : Response.json({}, { status: 401 })));
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    await act(async () => root.render(<OrderStatus />));
    const receipt = document.querySelector('[aria-label="Struk pembelian"]')!;
    expect(receipt.textContent).toContain('Catan — Base (SKU-A)');
    expect(receipt.textContent).toContain(money(1100));
    const link = document.querySelector<HTMLAnchorElement>('a[href="https://www.jne.co.id/tracking-package"]')!;
    expect(link.rel).toBe('noreferrer noopener');
    expect(document.body.textContent).toContain('AWB-9');
    expect(document.body.textContent).toContain('Selesai otomatis setelah pengiriman');
    await click('Cetak struk');
    expect(print).toHaveBeenCalled();
    expect([...document.querySelectorAll('button')].some(b => b.textContent === 'Batalkan pesanan')).toBe(false);
    expect([...document.querySelectorAll('button')].some(b => b.textContent === 'Simpan konfirmasi')).toBe(true);
  });
});
