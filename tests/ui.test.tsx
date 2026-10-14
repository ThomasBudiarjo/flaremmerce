// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith('/api/orders'))).toBe(true);
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
  async function renderAdmin(path: string, handler: Handler, options: { role?: string; signedIn?: boolean } = {}) {
    calls = [];
    let signedIn = options.signedIn ?? true;
    history.replaceState(null, '', path);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/config') return Response.json({ devLoginEnabled: true, googleEnabled: false });
      if (url === '/api/setup') return Response.json({ initialized: true });
      if (url === '/api/auth/development-login') { signedIn = true; return Response.json({ ok: true }); }
      if (url.startsWith('/api/auth/get-session')) return Response.json(signedIn ? { user: { id: 'admin' } } : null);
      if (url === '/api/admin/me') return Response.json(me(options.role));
      if (url.startsWith('/api/admin/summary')) return Response.json(summaryBody);
      const response = await handler(url, init);
      if (response) return response;
      throw new Error(`Unexpected ${method} ${url}`);
    }));
    await act(async () => root.render(<AdminApp />));
  }
  const text = () => document.body.textContent ?? '';
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
