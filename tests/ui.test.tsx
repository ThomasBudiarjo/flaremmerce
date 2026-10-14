// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReviewDetail } from '../apps/admin/src/ReviewDetail';
import { CatalogEditor, CampaignList, OrderSnapshot } from '../apps/admin/src/AdminWorkflows';
import { AdminApp } from '../apps/admin/src/main';
import { OperationalStatus } from '../apps/admin/src/OperationalStatus';
import OrderStatus from '../apps/storefront/src/components/OrderStatus';

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

it('labels operational samples as lower bounds and removes them on refresh denial', async () => {
  const api = vi.fn().mockResolvedValueOnce({ now: 100000, sections: { payments: { items: [{ id: 'payment-fixture', status: 'unknown', attempts: 8, createdAt: 0, ageMs: 100000 }], hasMore: true, atLeast: 21 } } })
    .mockRejectedValueOnce(new Error('Admin role revoked'));
  await act(async () => root.render(<OperationalStatus api={api} />));
  expect(document.body.textContent).toContain('1 ditampilkan; setidaknya 21 belum selesai');
  expect(document.body.textContent).toContain('payment-fixture');
  await click('Perbarui status');
  expect(document.body.textContent).not.toContain('payment-fixture');
  expect(document.body.textContent).toContain('Status tidak tersedia');
});

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

const adminProduct = (price = 100, reserved = 0) => ({ id: 'p', name: 'Produk', slug: 'produk', description: 'Deskripsi', variants: [{ id: 'v', sku: 'SKU', name: 'Varian', price, weight: 10, mode: 'stock', active: true, onHand: 10, reserved, available: 10 - reserved }] });
async function editField(name: string, value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit(form: HTMLFormElement) {
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

it('reconciles a confirmed variant write after its editor has closed', async () => {
  const write = deferred<any>();
  let product = adminProduct();
  const api = async () => { await write.promise; product = adminProduct(200); };
  const render = (open: boolean) => <><p>Catalogue price: {product.variants[0].price}</p>{open && <CatalogEditor product={product} api={api} onSaved={async () => { root.render(render(false)); }} />}</>;
  await act(async () => root.render(render(true)));
  await editField('price', '200');
  await submit(document.querySelectorAll('form')[1]);
  await act(async () => root.render(render(false)));
  await act(async () => write.resolve({ updated: true }));
  expect(document.body.textContent).toContain('Catalogue price: 200');
});

it('preserves variant drafts and the pending-save lock across counter refreshes', async () => {
  const write = deferred<any>();
  const api = vi.fn(() => write.promise);
  const render = (reserved: number) => <CatalogEditor product={adminProduct(100, reserved)} api={api} onSaved={async () => {}} />;
  await act(async () => root.render(render(0)));
  await editField('price', '250');
  await act(async () => root.render(render(1)));
  expect(document.querySelector<HTMLInputElement>('[name="price"]')!.value).toBe('250');
  await submit(document.querySelectorAll('form')[1]);
  await act(async () => root.render(render(2)));
  const form = document.querySelectorAll('form')[1];
  expect(form.querySelector('fieldset')!.disabled).toBe(true);
  await submit(form);
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => write.resolve({ updated: true }));
  expect(form.textContent).toContain('Perubahan tersimpan.');
});

const campaign = (reserved = 0) => ({ id: 'c', productName: 'Produk', sku: 'SKU', startsAt: 1800000001234, endsAt: 1800086405678, shipFrom: '2027-02-01', shipTo: '2027-02-10', quota: 10, active: true, reserved, sold: 0 });
it('ships only edited campaign config, preserving seconds and concurrent deactivation', async () => {
  let server = campaign();
  const api = vi.fn(async (_path: string, body?: any) => {
    if (body) { server = { ...server, ...body }; return { updated: true }; }
    return { campaigns: [server], nextCursor: null };
  });
  await act(async () => root.render(<CampaignList api={api} revision={0} />));
  await editField('shipTo', '2027-02-15');
  server = { ...server, active: false };
  await submit(document.querySelector('form')!);
  expect(server.active).toBe(false);
  expect(server.startsAt).toBe(1800000001234);
  expect(server.endsAt).toBe(1800086405678);
  expect(server.shipTo).toBe('2027-02-15');
});

it('keeps campaign drafts and save locks during revision refresh and acknowledges only its edit', async () => {
  const write = deferred<any>();
  let reserved = 0;
  const api = vi.fn(async (_path: string, body?: any) => body ? write.promise : { campaigns: [campaign(reserved)], nextCursor: null });
  await act(async () => root.render(<CampaignList api={api} revision={0} />));
  await editField('shipTo', '2027-02-15');
  await submit(document.querySelector('form')!);
  reserved = 2;
  await act(async () => root.render(<CampaignList api={api} revision={1} />));
  expect(document.querySelector<HTMLInputElement>('[name="shipTo"]')!.value).toBe('2027-02-15');
  expect(document.querySelector('form fieldset')!.hasAttribute('disabled')).toBe(true);
  await submit(document.querySelector('form')!);
  expect(api.mock.calls.filter(([, body]) => body).length).toBe(1);
  await act(async () => write.resolve({ updated: true }));
  expect(document.querySelector('form')!.textContent).toContain('Perubahan tersimpan.');
});

it('clears protected order snapshot immediately on reload and keeps it cleared after denial', async () => {
  const reload = deferred<any>();
  const api = vi.fn().mockResolvedValueOnce({ order: { id: 'o', createdAt: 1, items: [], timeline: [], contact: { email: 'protected@example.com' }, shipping: {}, address: {} } }).mockImplementationOnce(() => reload.promise);
  await act(async () => root.render(<OrderSnapshot id="o" api={api} onLoading={() => {}} onLoaded={() => {}} />));
  expect(document.body.textContent).toContain('protected@example.com');
  await click('Perbarui detail');
  expect(document.body.textContent).not.toContain('protected@example.com');
  await act(async () => reload.reject(new Error('403 forbidden')));
  expect(document.body.textContent).not.toContain('protected@example.com');
  expect(document.body.textContent).toContain('403 forbidden');
});

async function renderAdmin(tab: string, handler: (url: string, init: RequestInit) => Promise<Response>) {
  history.replaceState(null, '', `/admin/#${tab}`);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/config') return Response.json({ devLoginEnabled: true });
    if (url === '/api/setup') return Response.json({ initialized: true });
    if (url.startsWith('/api/auth/get-session')) return Response.json({ user: { id: 'admin', name: 'Admin', email: 'admin@example.com' } });
    return handler(url, init);
  }));
  await act(async () => root.render(<AdminApp />));
}
async function clickContaining(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(text))!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}

it('acknowledges product creation even when catalogue reload fails; retry is read-only', async () => {
  let created = false, posts = 0;
  await renderAdmin('products', async (_url, init) => {
    if (init.method === 'POST') { created = true; posts++; return Response.json({ id: 'p' }, { status: 201 }); }
    if (created) return Response.json({ error: 'Catalogue down' }, { status: 503 });
    return Response.json({ products: [], nextCursor: null });
  });
  await clickContaining('Tambah produk');
  await submit(document.querySelector('[role="dialog"] form')!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).toContain('Produk tersimpan.');
  expect(document.body.textContent).toContain('Catalogue down');
  await clickContaining('Muat ulang');
  expect(posts).toBe(1);
});

it('does not repeat an acknowledged milestone after its only snapshot reload fails', async () => {
  let writes = 0, detailReads = 0;
  const order = { id: 'o', reference: 'ORDER', status: 'paid', fulfillment: 'unfulfilled', total: 100, currency: 'IDR', createdAt: 1, items: [], timeline: [], contact: {}, address: {}, shipping: {} };
  await renderAdmin('orders', async (url, init) => {
    if (init.method === 'POST') { writes++; return Response.json({ updated: true }); }
    if (url === '/api/admin/orders/o') {
      detailReads++;
      return writes ? Response.json({ error: 'Detail down' }, { status: 503 }) : Response.json({ order });
    }
    return Response.json({ orders: [order], nextCursor: null });
  });
  await clickContaining('Detail');
  const form = Array.from(document.querySelectorAll('form')).find((form) => form.textContent?.includes('Tambahkan timeline'))!;
  await submit(form);
  expect(document.body.textContent).toContain('Detail down');
  expect(Array.from(document.querySelectorAll('form')).find((form) => form.textContent?.includes('Tambahkan timeline'))!.closest('[hidden]')).toBeTruthy();
  expect(detailReads).toBe(2);
  await click('Perbarui detail');
  expect(writes).toBe(1);
});

it('reconciles a late price save into a reopened product without overwriting its new draft', async () => {
  const write = deferred<any>();
  let product = adminProduct();
  await renderAdmin('products', async (_url, init) => {
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body as string);
      if ('price' in body) await write.promise;
      product = { ...product, variants: [{ ...product.variants[0], ...body }] };
      return Response.json({ updated: true });
    }
    return Response.json({ products: [product], nextCursor: null });
  });
  await clickContaining('Detail');
  await editField('price', '250');
  await submit(document.querySelectorAll('[role="dialog"] form')[1] as HTMLFormElement);
  await clickContaining('Tutup');
  await clickContaining('Detail');
  await editField('weight', '20');
  await editField('price', '300');
  await act(async () => write.resolve({ updated: true }));
  expect(document.querySelector<HTMLInputElement>('[name="price"]')!.value).toBe('300');
  expect(document.querySelector<HTMLInputElement>('[name="weight"]')!.value).toBe('20');
  await editField('price', '100');
  await submit(document.querySelectorAll('[role="dialog"] form')[1] as HTMLFormElement);
  expect(product.variants[0].price).toBe(100);
  expect(product.variants[0].weight).toBe(20);
});

it.each(['variant', 'campaign'])('adopts a successful %s reload that returns the original value after saving', async (kind) => {
  let product = adminProduct(), server = campaign();
  const field = kind === 'variant' ? 'price' : 'quota';
  const original = kind === 'variant' ? 100 : 10;
  const render = (revision: number) => kind === 'variant'
    ? <CatalogEditor product={product} api={api} onSaved={async () => {
      product = adminProduct(original);
      root.render(render(1));
    }} />
    : <CampaignList api={api} revision={revision} />;
  const api = async (_path: string, body?: any) => {
    if (body) {
      if (kind === 'variant') product = adminProduct(body.price);
      else server = { ...server, ...body };
      // Another administrator restores the original value before our reload.
      if (kind === 'campaign') server = { ...server, quota: original };
      return { updated: true };
    }
    return { campaigns: [{ ...server }], nextCursor: null };
  };
  await act(async () => root.render(render(0)));
  await editField(field, '200');
  await submit(document.querySelectorAll('form')[kind === 'variant' ? 1 : 0]);
  expect(document.querySelector<HTMLInputElement>(`[name="${field}"]`)!.value).toBe(String(original));
});

it('keeps acknowledged values over a pre-confirmation snapshot when the post-save reload fails', async () => {
  const write = deferred<any>();
  let product = adminProduct();
  const api = async (_path: string, body: any) => {
    if (body.price === 200) await write.promise;
    product = { ...product, variants: [{ ...product.variants[0], ...body }] };
    return { updated: true };
  };
  const render = () => <CatalogEditor product={product} api={api} onSaved={async () => { throw new Error('Reload down'); }} />;
  await act(async () => root.render(render()));
  await editField('price', '200');
  const form = document.querySelectorAll('form')[1];
  await submit(form);
  product = adminProduct();
  await act(async () => root.render(render()));
  await act(async () => write.resolve({ updated: true }));
  expect(product.variants[0].price).toBe(200);
  expect(document.querySelector<HTMLInputElement>('[name="price"]')!.value).toBe('200');
  expect(form.textContent).toContain('Reload down');
  await editField('price', '100');
  await submit(form);
  expect(product.variants[0].price).toBe(100);
});

it('reconciles a deferred deactivation without undoing the acknowledged price when reload fails', async () => {
  const write = deferred<any>();
  let product = adminProduct();
  const api = async (_path: string, body: any) => {
    if ('price' in body) await write.promise;
    product = { ...product, variants: [{ ...product.variants[0], ...body }] };
    return { updated: true };
  };
  const render = () => <CatalogEditor product={product} api={api} onSaved={async () => { throw new Error('Reload down'); }} />;
  await act(async () => root.render(render()));
  await editField('price', '200');
  const form = document.querySelectorAll('form')[1];
  await submit(form);
  product = { ...adminProduct(), variants: [{ ...adminProduct().variants[0], active: false }] };
  await act(async () => root.render(render()));
  await act(async () => write.resolve({ updated: true }));
  const active = form.querySelector<HTMLSelectElement>('[name="active"]')!;
  expect(document.querySelector<HTMLInputElement>('[name="price"]')!.value).toBe('200');
  expect(active.value).toBe('false');
  await act(async () => { active.value = 'true'; active.dispatchEvent(new Event('change', { bubbles: true })); });
  await submit(form);
  expect(product.variants[0].active).toBe(true);
  expect(product.variants[0].price).toBe(200);
});

it('keeps an opening boundary product and its draft when the refresh displaces it onto page two', async () => {
  const refresh = deferred<Response>();
  const products = Array.from({ length: 30 }, (_, i) => ({ ...adminProduct(), id: `p-${i}`, slug: `product-${i}`, name: i === 29 ? 'Boundary' : `Product ${i}` }));
  let reads = 0;
  await renderAdmin('products', async (url) => {
    if (url.includes('?')) return Response.json({ products: [products[29]], nextCursor: null });
    if (++reads > 1) return refresh.promise;
    return Response.json({ products, nextCursor: 'page-two' });
  });
  await clickContaining('Boundary');
  const dialog = document.querySelector('[role="dialog"]')!;
  await editField('price', '300');
  await act(async () => refresh.resolve(Response.json({ products: [{ ...adminProduct(), id: 'new', name: 'New product' }, ...products.slice(0, 29)], nextCursor: 'page-two' })));
  expect(dialog.isConnected).toBe(true);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Boundary');
  expect(document.querySelector<HTMLInputElement>('[name="price"]')!.value).toBe('300');
});

it('saves an intentional campaign revert after refreshed defaults preserve its dirty field', async () => {
  let server = campaign();
  const api = async (_path: string, body?: any) => {
    if (body) server = { ...server, ...body };
    return { campaigns: [server], nextCursor: null };
  };
  await act(async () => root.render(<CampaignList api={api} revision={0} />));
  await editField('quota', '30');
  server = { ...server, quota: 20 };
  await act(async () => root.render(<CampaignList api={api} revision={1} />));
  expect(document.querySelector<HTMLInputElement>('[name="quota"]')!.value).toBe('30');
  await editField('quota', '10');
  await submit(document.querySelector('form')!);
  expect(server.quota).toBe(10);
});

it.each(['inventory', 'campaign-create', 'campaign-edit'])('reconciles a committed %s after departure/return without clearing a newer draft', async (kind) => {
  const write = deferred<any>();
  let committed = false;
  const targetTab = kind === 'inventory' ? 'inventory' : 'campaigns';
  await renderAdmin(targetTab, async (url, init) => {
    if (init.method === 'POST' || init.method === 'PATCH') {
      await write.promise;
      committed = true;
      return Response.json({ updated: true });
    }
    if (url.startsWith('/api/admin/inventory')) return Response.json({ inventory: { onHand: committed ? 15 : 10, reserved: 0, available: committed ? 15 : 10 }, movements: [], nextCursor: null });
    return Response.json({ products: [adminProduct()], campaigns: kind === 'campaign-create' && !committed ? [] : [{ ...campaign(), quota: committed ? 20 : 10 }], nextCursor: null });
  });
  const selectVariant = async () => act(async () => {
    const field = document.querySelector<HTMLSelectElement>('[name="variantId"]')!;
    field.value = 'v'; field.dispatchEvent(new Event('change', { bubbles: true }));
  });
  if (kind === 'inventory') await selectVariant();
  if (kind === 'campaign-edit') await editField('quota', '20');
  const form = kind === 'campaign-create' ? document.querySelectorAll('form')[0] : document.querySelector('form')!;
  await submit(form);
  for (const tab of ['products', targetTab]) await act(async () => {
    history.replaceState(null, '', `/admin/#${tab}`); window.dispatchEvent(new Event('hashchange'));
  });
  if (kind === 'inventory') await selectVariant();
  const draftField = kind === 'inventory' ? 'reason' : 'shipTo';
  const draftValue = kind === 'inventory' ? 'New adjustment draft' : '2027-02-20';
  await editField(draftField, draftValue);
  const draftInput = document.querySelector<HTMLInputElement>(`[name="${draftField}"]`)!;
  await act(async () => write.resolve({ updated: true }));
  expect(document.body.textContent).toContain(kind === 'inventory' ? 'Fisik: 15' : 'Kuota 20');
  expect(draftInput.isConnected).toBe(true);
  expect(draftInput.value).toBe(draftValue);
});

it('releases an abandoned order operation but its completion cannot unlock the next tab operation', async () => {
  const oldWrite = deferred<any>(), newWrite = deferred<any>();
  const order = { id: 'o', reference: 'ORDER', status: 'paid', fulfillment: 'unfulfilled', total: 100, items: [], timeline: [], contact: {}, shipping: {}, address: {} };
  await renderAdmin('orders', async (url, init) => {
    if (init.method === 'POST') {
      await (url.includes('/orders/') ? oldWrite.promise : newWrite.promise);
      return Response.json({ updated: true });
    }
    if (url === '/api/admin/products') return Response.json({ products: [adminProduct()], nextCursor: null });
    if (url === '/api/admin/orders/o') return Response.json({ order });
    if (url.startsWith('/api/admin/inventory')) return Response.json({ inventory: { onHand: 10, reserved: 0, available: 10 }, movements: [], nextCursor: null });
    return Response.json({ orders: [order], nextCursor: null });
  });
  await clickContaining('Detail');
  await submit(Array.from(document.querySelectorAll('form')).find((form) => form.textContent?.includes('Tambahkan timeline'))!);
  await act(async () => {
    history.replaceState(null, '', '/admin/#inventory');
    window.dispatchEvent(new Event('hashchange'));
  });
  const form = document.querySelector('form')!;
  expect(form.querySelector('fieldset')!.disabled).toBe(false);
  await submit(form);
  await act(async () => oldWrite.resolve({ updated: true }));
  expect(form.querySelector('fieldset')!.disabled).toBe(true);
  await act(async () => newWrite.resolve({ updated: true }));
  expect(form.querySelector('fieldset')!.disabled).toBe(false);
});

it.each([false, true])('blocks the old order cursor after failed page-one refresh (identity change: %s)', async (changeIdentity) => {
  const order = { id: 'old', reference: 'OLD-ACCOUNT-ORDER', status: 'paid', fulfillment: 'unfulfilled', total: 100, contact: {} };
  await renderAdmin('orders', async () => Response.json({ orders: [order], nextCursor: { before: 1, beforeId: 'old' } }));
  expect(document.body.textContent).toContain('OLD-ACCOUNT-ORDER');
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (changeIdentity && String(url).startsWith('/api/auth/get-session')) return Response.json({ user: { id: 'other-admin', name: 'Other admin' } });
    if (String(url).startsWith('/api/admin/orders')) return Response.json({ error: 'Page one down' }, { status: 503 });
    return original(url, init);
  });
  await clickContaining('Perbarui');
  expect(document.body.textContent).toContain('Page one down');
  if (changeIdentity) expect(document.body.textContent).not.toContain('OLD-ACCOUNT-ORDER');
  expect(document.body.textContent).not.toContain('Muat pesanan berikutnya');
});

it.each(['variant', 'campaign'])('adopts external deactivation and sends intentional %s reactivation', async (kind) => {
  let product = adminProduct(), server = campaign();
  const api = vi.fn(async (_path: string, body?: any) => {
    if (body) return { updated: true };
    return { campaigns: [server], nextCursor: null };
  });
  const render = (revision: number) => kind === 'variant'
    ? <CatalogEditor product={product} api={api} onSaved={async () => {}} />
    : <CampaignList api={api} revision={revision} />;
  await act(async () => root.render(render(0)));
  product.variants[0].active = false; server = { ...server, active: false };
  await act(async () => root.render(render(1)));
  const select = document.querySelector<HTMLSelectElement>('[name="active"]')!;
  expect(select.value).toBe('false');
  await act(async () => { select.value = 'true'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await submit(select.closest('form')!);
  expect(api.mock.calls.find(([, body]) => body)?.[1]).toEqual({ active: true });
});

it('retains a boundary campaign draft when a new row displaces it during refresh', async () => {
  let inserted = false;
  const boundary = { ...campaign(), id: 'boundary' };
  const api = vi.fn(async (path: string) => path.includes('?')
    ? { campaigns: [boundary], nextCursor: null }
    : { campaigns: inserted ? [{ ...campaign(), id: 'new' }] : [boundary], nextCursor: inserted ? { before: 1, beforeId: 'new' } : null });
  await act(async () => root.render(<CampaignList api={api} revision={0} />));
  await editField('shipTo', '2027-02-15');
  inserted = true;
  await act(async () => root.render(<CampaignList api={api} revision={1} />));
  expect(document.querySelectorAll('form').length).toBe(2);
  expect(document.querySelectorAll<HTMLInputElement>('[name="shipTo"]')[1].value).toBe('2027-02-15');
});

it.each(['PATCH', 'POST'])('reconciles a committed variant %s after tab departure and return', async (method) => {
  const write = deferred<any>();
  let product = adminProduct();
  await renderAdmin('products', async (_url, init) => {
    if (init.method === method) {
      await write.promise;
      if (method === 'PATCH') product = { ...product, variants: [{ ...product.variants[0], mode: 'preorder', active: false }] };
      else product = { ...product, variants: [...product.variants, { ...product.variants[0], id: 'new', sku: 'NEW' }] };
      return Response.json({ updated: true });
    }
    return Response.json({ products: [product], campaigns: [], nextCursor: null });
  });
  await clickContaining('Detail');
  const form = document.querySelectorAll('[role="dialog"] form')[method === 'PATCH' ? 1 : 2] as HTMLFormElement;
  if (method === 'PATCH') await act(async () => {
    form.querySelector<HTMLSelectElement>('[name="mode"]')!.value = 'preorder';
    form.querySelector<HTMLSelectElement>('[name="active"]')!.value = 'false';
  });
  await submit(form);
  for (const tab of ['campaigns', 'products']) await act(async () => {
    history.replaceState(null, '', `/admin/#${tab}`); window.dispatchEvent(new Event('hashchange'));
  });
  await clickContaining('Detail');
  await editField('weight', '20');
  await act(async () => write.resolve({ updated: true }));
  expect(document.querySelector<HTMLInputElement>('[name="weight"]')!.value).toBe('20');
  if (method === 'PATCH') {
    expect(document.querySelector<HTMLSelectElement>('[name="mode"]')!.value).toBe('preorder');
    expect(document.querySelector<HTMLSelectElement>('[name="active"]')!.value).toBe('false');
  } else expect(document.querySelectorAll('[role="dialog"] form').length).toBe(5);
});

it('refreshes the reopened same order after a committed milestone without losing its new draft or lock', async () => {
  const oldWrite = deferred<any>(), newWrite = deferred<any>();
  let writes = 0, reads = 0, committed = false;
  const order = { id: 'o', reference: 'ORDER', status: 'paid', fulfillment: 'unfulfilled', total: 100, currency: 'IDR', createdAt: 1, items: [], timeline: [], contact: {}, address: {}, shipping: {} };
  await renderAdmin('orders', async (url, init) => {
    if (init.method === 'POST') {
      const current = ++writes;
      await (current === 1 ? oldWrite.promise : newWrite.promise);
      committed = true;
      return Response.json({ updated: true });
    }
    if (url === '/api/admin/orders/o') {
      reads++;
      return Response.json({ order: { ...order, timeline: committed ? [{ id: 'event', kind: 'production', createdAt: 1, details: { note: 'Committed old milestone' } }] : [] } });
    }
    return Response.json({ orders: [order], nextCursor: null });
  });
  const timelineForm = () => Array.from(document.querySelectorAll('form')).find((form) => form.textContent?.includes('Tambahkan timeline'))!;
  await clickContaining('Detail'); await submit(timelineForm());
  await clickContaining('Tutup'); await clickContaining('Detail');
  const form = timelineForm();
  form.querySelector<HTMLInputElement>('[name="note"]')!.value = 'New draft';
  await submit(form);
  await act(async () => oldWrite.resolve({ updated: true }));
  expect(reads).toBe(3);
  expect(document.body.textContent).toContain('Committed old milestone');
  expect(form.querySelector<HTMLInputElement>('[name="note"]')!.value).toBe('New draft');
  expect(form.querySelector('fieldset')!.disabled).toBe(true);
  await submit(form); expect(writes).toBe(2);
  await act(async () => newWrite.resolve({ updated: true }));
  expect(form.querySelector('fieldset')!.disabled).toBe(false);
});

it('rejects an old session variant write reconciliation after identity changes', async () => {
  const write = deferred<any>();
  let reads = 0;
  await renderAdmin('products', async (_url, init) => {
    if (init.method === 'PATCH') { await write.promise; return Response.json({ updated: true }); }
    reads++;
    return Response.json({ products: [adminProduct()], orders: [], nextCursor: null });
  });
  await clickContaining('Detail'); await editField('price', '200');
  await submit(document.querySelectorAll('[role="dialog"] form')[1] as HTMLFormElement);
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => String(url).startsWith('/api/auth/get-session')
    ? Response.json({ user: { id: 'other-admin', name: 'Other admin' } }) : original(url, init));
  await act(async () => {
    history.replaceState(null, '', '/admin/#orders'); window.dispatchEvent(new Event('hashchange'));
  });
  const before = reads;
  await act(async () => write.resolve({ updated: true }));
  expect(reads).toBe(before);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
