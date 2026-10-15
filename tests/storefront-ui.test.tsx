// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Checkout from '../apps/storefront/src/components/Checkout';
import OrderStatus from '../apps/storefront/src/components/OrderStatus';
import ProductPicker from '../apps/storefront/src/components/ProductPicker';
import { money } from '../apps/storefront/src/lib/catalog';
import { readCart } from '../apps/storefront/src/lib/cart';

vi.mock('../apps/storefront/src/components/Turnstile', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return { default: ({ onToken, reset }: { onToken: (token: string) => void; reset: number }) => { useEffect(() => onToken(`turnstile-${reset}`), [reset]); return null; } };
});

let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<a href="/cart">Keranjang <span data-cart-count hidden></span></a><div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/cart');
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const buttons = () => [...document.querySelectorAll('button')];
async function click(text: string) {
  const button = buttons().find(b => b.textContent === text);
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
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
const badge = () => document.querySelector<HTMLElement>('[data-cart-count]')!;

describe('checkout steps', () => {
  const line = { variantId: 'a', quantity: 2, available: true, sku: 'SKU-A', name: 'Base', productName: 'Catan', productSlug: 'catan', price: 1000, lineTotal: 2000, mode: 'stock', stockLevel: 'in_stock', enough: true, maxPerOrder: 3, campaign: null };
  function server(checkout: (body: any) => Response, price = { value: 1000 }) {
    const calls: { path: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path: input, body });
      if (input === '/api/cart/preview') return Response.json({ lines: [{ ...line, price: price.value, lineTotal: price.value * 2 }], subtotal: price.value * 2, shipPromise: { shipFrom: null, shipTo: null }, problems: [] });
      if (input === '/api/config') return Response.json({ turnstileSiteKey: 'site-key' });
      if (input === '/api/account/addresses') return Response.json({}, { status: 401 });
      if (input === '/api/shipping/destinations') return Response.json({ destinations: [{ id: '42', label: 'MENTENG, JAKARTA PUSAT', postalCode: '10310' }] });
      if (input === '/api/shipping/quote') return Response.json({ quotes: [{ id: 'q1', service: 'jne:REG', amount: 100, expiresAt: Date.now() + 300000 }] });
      if (input === '/api/checkout') return checkout(body);
      throw new Error(`Unexpected ${input}`);
    }));
    return calls;
  }
  async function fill(phone = '081234567890') {
    localStorage.setItem('flaremmerce-cart', JSON.stringify([{ variantId: 'a', quantity: 2 }]));
    await act(async () => root.render(<Checkout />));
    await type('name', 'Budi'); await type('email', 'budi@example.com'); await type('phone', phone); await type('line', 'Jl. Mawar 1');
    await type('destination-search', 'menteng'); await click('Cari wilayah');
    await choose('destination', '42'); await click('Periksa ongkir'); await choose('shipping', 'q1');
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  }
  const submit = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const placed = (body: any) => Response.json({ order: { reference: 'FL-REF', status: 'pending_payment', total: body.expectedTotal, guestToken: 'secret', shipPromise: { shipFrom: null, shipTo: null } }, paymentState: 'pending', paymentUrl: 'https://sandbox.doku.com/pay' });

  it('renders numbered steps with the summary and payment controls in the aside', async () => {
    server(placed);
    await fill();
    const headings = [...document.querySelectorAll('.step-title')].map(h => h.textContent);
    expect(headings).toEqual(['1Kontak' + 'Lengkap', '2Alamat' + 'Lengkap', '3Pengiriman' + 'Lengkap', '4Ringkasan & Pembayaran']);
    const aside = document.querySelector('aside.checkout-summary')!;
    expect(aside.getAttribute('aria-labelledby')).toBe('step-summary');
    expect(aside.contains(submit())).toBe(true);
    expect(aside.contains(document.querySelector('input[type="checkbox"]'))).toBe(true);
    expect(aside.textContent).toContain('Catan — Base × 2');
    expect(aside.textContent).toContain(money(2100));
    for (const id of ['name', 'email', 'phone']) expect(document.getElementById(id)!.closest('section')!.getAttribute('aria-labelledby')).toBe('step-contact');
    for (const id of ['line', 'destination-search', 'destination']) expect(document.getElementById(id)!.closest('section')!.getAttribute('aria-labelledby')).toBe('step-address');
    expect(document.getElementById('shipping')!.closest('section')!.getAttribute('aria-labelledby')).toBe('step-shipping');
    expect(document.body.textContent).toContain('Maks. 3 per pesanan');
    expect(badge().textContent).toBe('2');
    expect(badge().hidden).toBe(false);
  });

  it('marks an invalid phone on its field, focuses it and sends nothing', async () => {
    const calls = server(placed);
    await fill('12345');
    await act(async () => submit().click());
    const phone = document.getElementById('phone') as HTMLInputElement;
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    expect(phone.getAttribute('aria-describedby')).toBe('phone-help phone-error');
    expect(document.getElementById('phone-error')!.textContent).toContain('Nomor HP tidak valid');
    expect(document.activeElement).toBe(phone);
    expect(calls.some(c => c.path === '/api/checkout')).toBe(false);
    await type('phone', '081234567890');
    expect(phone.hasAttribute('aria-invalid')).toBe(false);
    expect(document.getElementById('phone-error')).toBeNull();
  });

  it('still requires re-confirming a changed total before resending with a new key', async () => {
    const price = { value: 1000 };
    let first = true;
    const calls = server(body => {
      if (first) { first = false; price.value = 1500; return Response.json({ error: 'Total changed', details: { total: 3100 } }, { status: 409 }); }
      return placed(body);
    }, price);
    await fill();
    await act(async () => submit().click());
    expect(document.body.textContent).toContain(`Total berubah dari ${money(2100)} menjadi ${money(3100)}`);
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(submit().disabled).toBe(true);
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => submit().click());
    const bodies = calls.filter(c => c.path === '/api/checkout').map(c => c.body);
    expect(bodies.map(b => b.expectedTotal)).toEqual([2100, 3100]);
    expect(bodies[1].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
    expect(document.body.textContent).toContain('Referensi FL-REF');
    expect(document.body.textContent).toContain('Status: Menunggu pembayaran');
    expect(badge().hidden).toBe(true);
  });

  it('disables destination search, quotes and ordering when payments or shipping are not configured', async () => {
    for (const flags of [{ payments: false, shipping: true }, { payments: true, shipping: false }]) {
      const calls = server(placed);
      const original = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input: any, init?: any) => input === '/api/config' ? Response.json({ turnstileSiteKey: 'site-key', turnstile: true, ...flags }) : original(input, init));
      localStorage.setItem('flaremmerce-cart', JSON.stringify([{ variantId: 'a', quantity: 2 }]));
      await act(async () => root.render(<Checkout />));
      expect(document.querySelector('[role="alert"]')!.textContent).toContain('Checkout belum tersedia di lingkungan ini.');
      await type('destination-search', 'menteng');
      expect(buttons().find(b => b.textContent === 'Cari wilayah')!.disabled).toBe(true);
      expect(buttons().find(b => b.textContent === 'Periksa ongkir')!.disabled).toBe(true);
      expect(submit().disabled).toBe(true);
      expect(document.body.textContent).toContain('Catan');
      expect(calls.some(c => c.path.startsWith('/api/shipping') || c.path === '/api/checkout')).toBe(false);
      await act(async () => root.unmount());
      root = createRoot(document.getElementById('root')!);
    }
  });

  it('orders without a Turnstile token or widget when the server reports Turnstile off (staging)', async () => {
    const calls = server(placed);
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input: any, init?: any) => input === '/api/config' ? Response.json({ turnstileSiteKey: null, turnstile: false, payments: true, shipping: true }) : original(input, init));
    await fill();
    expect(document.body.textContent).not.toContain('Verifikasi checkout belum tersedia');
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    expect(calls.find(c => c.path === '/api/checkout')!.body.turnstileToken).toBe('');
    expect(document.body.textContent).toContain('Referensi FL-REF');
  });

  it('recovers a corrupt stored cart: bad entries dropped, duplicates merged, quantities clamped', async () => {
    localStorage.setItem('flaremmerce-cart', JSON.stringify([null, 'x', { variantId: 'a', quantity: 60 }, { variantId: 'a', quantity: 70 }, { variantId: 'b', quantity: 0 }, { variantId: 'c', quantity: 1.5 }, { quantity: 2 }, { variantId: 'd', quantity: 500 }]));
    expect(readCart()).toEqual([{ variantId: 'a', quantity: 100 }, { variantId: 'd', quantity: 100 }]);
    const calls = server(placed);
    await act(async () => root.render(<Checkout />));
    expect(calls.find(c => c.path === '/api/cart/preview')!.body).toEqual({ items: [{ variantId: 'a', quantity: 100 }, { variantId: 'd', quantity: 100 }] });
  });

  it('still lists stored lines with quantity and remove controls when the preview fails', async () => {
    localStorage.setItem('flaremmerce-cart', JSON.stringify([{ variantId: 'a', quantity: 2 }, { variantId: 'gone', quantity: 1 }]));
    const previews: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      if (input === '/api/cart/preview') {
        const body = JSON.parse(String(init.body));
        previews.push(body);
        if (body.items.length > 1) return Response.json({ error: 'Invalid cart' }, { status: 400 });
        return Response.json({ lines: [line], subtotal: 2000, shipPromise: { shipFrom: null, shipTo: null }, problems: [] });
      }
      if (input === '/api/config') return Response.json({ turnstileSiteKey: 'site-key' });
      return Response.json({}, { status: 401 });
    }));
    await act(async () => root.render(<Checkout />));
    expect(document.body.textContent).toContain('Ubah jumlah atau hapus barang di bawah');
    const rows = [...document.querySelectorAll('[aria-labelledby="cart-heading"] .line')];
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain('Barang di keranjang');
    expect(rows[1].querySelector<HTMLInputElement>('input')!.value).toBe('1');
    await act(async () => [...rows[1].querySelectorAll('button')].find(b => b.textContent === 'Hapus')!.click());
    expect(JSON.parse(localStorage.getItem('flaremmerce-cart')!)).toEqual([{ variantId: 'a', quantity: 2 }]);
    expect(previews.at(-1)).toEqual({ items: [{ variantId: 'a', quantity: 2 }] });
    expect(document.body.textContent).toContain('Catan');
    expect(document.body.textContent).not.toContain('Barang di keranjang');
  });

  it('shows an empty state when the cart is empty', async () => {
    server(placed);
    await act(async () => root.render(<Checkout />));
    expect(document.querySelector('.empty-state h2')!.textContent).toBe('Keranjang masih kosong');
    expect(document.querySelector<HTMLAnchorElement>('.empty-state a')!.getAttribute('href')).toBe('/catalog');
  });
});

describe('product picker', () => {
  const product = (maxPerOrder: number | null) => ({ id: 'p', slug: 'catan', name: 'Catan', description: '', variants: [
    { id: 'v1', sku: 'A', name: 'Base', price: 1000, weight: 1, stockLevel: 'low' as const, maxPerOrder, mode: 'stock' as const },
    { id: 'v2', sku: 'B', name: 'Deluxe', price: 2000, weight: 1, stockLevel: 'in_stock' as const, maxPerOrder: null, mode: 'preorder' as const,
      campaign: { id: 'c', startsAt: '2027-01-01', endsAt: '2027-01-20', shipFrom: '2027-02-01', shipTo: '2027-02-20' } },
  ] });

  it('shows the per-order limit, disables over-limit quantities and updates the header count', async () => {
    localStorage.setItem('flaremmerce-cart', JSON.stringify([{ variantId: 'other', quantity: 1 }]));
    await act(async () => root.render(<ProductPicker product={product(2)} />));
    expect(badge().textContent).toBe('1');
    expect(document.getElementById('quantity-help')!.textContent).toBe('Maksimal 2 per pesanan.');
    expect(document.getElementById('quantity')!.getAttribute('aria-describedby')).toBe('quantity-help');
    expect(document.body.textContent).toContain('Stok terbatas');
    await type('quantity', '3');
    expect((document.getElementById('quantity') as HTMLInputElement).value).toBe('2');
    await click('Tambah ke keranjang');
    expect(document.body.textContent).toContain('Ditambahkan ke keranjang.');
    expect(badge().textContent).toBe('3');
    expect(badge().closest('a')!.getAttribute('aria-label')).toBe('Keranjang, 3 barang');
  });

  it('clamps a repeated add to the line limit instead of storing a cart the server refuses', async () => {
    await act(async () => root.render(<ProductPicker product={product(null)} />));
    await type('quantity', '500');
    expect((document.getElementById('quantity') as HTMLInputElement).value).toBe('100');
    await type('quantity', '60');
    await click('Tambah ke keranjang');
    await click('Tambah ke keranjang');
    expect(document.body.textContent).toContain('Ditambahkan 40 unit; keranjang kini berisi jumlah maksimal 100.');
    expect(JSON.parse(localStorage.getItem('flaremmerce-cart')!)).toEqual([{ variantId: 'v1', quantity: 100 }]);
    await click('Tambah ke keranjang');
    expect(document.body.textContent).toContain('Keranjang sudah berisi 100 unit, jumlah maksimal untuk varian ini.');
    expect(badge().textContent).toBe('100');
  });

  it('keeps a typed quantity within the per-order limit when switching variants', async () => {
    await act(async () => root.render(<ProductPicker product={{ ...product(null), variants: [product(null).variants[1], product(2).variants[0]] }} />));
    await type('quantity', '7');
    await act(async () => buttons().find(b => b.textContent?.startsWith('Base'))!.click());
    expect((document.getElementById('quantity') as HTMLInputElement).value).toBe('2');
    await click('Tambah ke keranjang');
    expect(JSON.parse(localStorage.getItem('flaremmerce-cart')!)).toEqual([{ variantId: 'v1', quantity: 2 }]);
  });

  it('shows the pre-order ship window for the selected variant', async () => {
    await act(async () => root.render(<ProductPicker product={product(null)} />));
    await act(async () => buttons().find(b => b.textContent?.startsWith('Deluxe'))!.click());
    expect(buttons().find(b => b.textContent?.startsWith('Deluxe'))!.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.availability-note')!.textContent).toContain('Pre-order · estimasi kirim');
    expect(document.querySelector('.price')!.textContent).toContain(money(2000));
  });
});

describe('order status stepper', () => {
  const respond = (status: string, fulfillment: string, extra: Record<string, unknown> = {}) => {
    sessionStorage.setItem('flaremmerce-order-access', JSON.stringify({ reference: 'FL-1', token: 't' }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/orders/FL-1'
      ? Response.json({ access: { type: 'guest' }, paymentState: 'succeeded', order: { reference: 'FL-1', status, fulfillment, total: 1100, createdAt: 1, items: [], timeline: [], tracking: null, ...extra } })
      : Response.json({}, { status: 401 })));
  };
  const states = () => [...document.querySelectorAll('.stepper li')].map(li => [li.textContent!.replace(/\s*\(selesai\)/, '').replace(/^[✓\d]/, ''), li.getAttribute('data-state'), li.getAttribute('aria-current')]);

  it.each([
    ['pending_payment', 'unfulfilled', 0],
    ['paid', 'unfulfilled', 1],
    ['paid', 'preparing', 2],
    ['paid', 'shipped', 3],
  ] as const)('marks the current step for %s / %s', async (status, fulfillment, current) => {
    respond(status, fulfillment);
    await act(async () => root.render(<OrderStatus />));
    const rows = states();
    expect(rows.map(r => r[0])).toEqual(['Menunggu pembayaran', 'Dibayar', 'Diproses', 'Dikirim', 'Selesai']);
    rows.forEach(([, state, aria], n) => {
      expect(state).toBe(n < current ? 'done' : n === current ? 'current' : 'todo');
      expect(aria).toBe(n === current ? 'step' : null);
    });
  });

  it('marks every step done for completed orders and shows the tracking card', async () => {
    respond('completed', 'delivered', { tracking: { number: 'AWB-9', courierName: 'JNE', url: 'https://www.jne.co.id/t' } });
    await act(async () => root.render(<OrderStatus />));
    expect(states().every(([, state]) => state === 'done')).toBe(true);
    const card = document.querySelector('.tracking-card')!;
    expect(card.textContent).toContain('AWB-9');
    expect(card.querySelector('a')!.rel).toBe('noreferrer noopener');
  });

  it('shows a single cancelled state', async () => {
    respond('cancelled', 'unfulfilled');
    await act(async () => root.render(<OrderStatus />));
    expect(states()).toEqual([['×Dibatalkan', 'cancelled', 'step']]);
  });
});
