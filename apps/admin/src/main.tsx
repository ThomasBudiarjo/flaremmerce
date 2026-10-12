import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
const navigation = [
  ["orders", "Pesanan"],
  ["products", "Produk"],
  ["inventory", "Inventori"],
  ["campaigns", "Pre-order"],
  ["review", "Manual review"],
] as const;
function currentTab() {
  const value = window.location.hash.slice(1);
  return navigation.some(([id]) => id === value) ? value : "orders";
}
function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    orders: (
      <>
        <path d="M8 3H5v18h14V3h-3M9 3h6v4H9zM8 12h8M8 16h5" />
      </>
    ),
    products: (
      <>
        <path d="m3 3 8 0 10 10-8 8L3 11z" />
        <circle cx="7" cy="7" r="1" />
      </>
    ),
    inventory: (
      <>
        <path d="m3 7 9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10M7 5l10 4" />
      </>
    ),
    campaigns: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M7 3v4M17 3v4M3 11h18M8 15h3M14 15h2" />
      </>
    ),
    review: (
      <>
        <path d="m12 3 9 4v6c0 5-9 9-9 9S3 18 3 13V7zM12 8v5M12 17h.01" />
      </>
    ),
    external: <path d="M14 3h7v7M21 3l-10 10M10 3H3v18h18v-7" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    plus: <path d="M12 5v14M5 12h14" />,
  };
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
const statusLabels: Record<string, string> = {
  pending_payment: "Menunggu pembayaran",
  paid: "Terbayar",
  completed: "Selesai",
  cancelled: "Dibatalkan",
  unfulfilled: "Belum diproses",
  processing: "Diproses",
  shipped: "Dikirim",
  delivered: "Diterima",
};
async function api(path: string, body?: unknown, method?: string) {
  const res = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      data.error?.message ||
        data.message ||
        (typeof data.error === "string"
          ? data.error
          : "Permintaan gagal. Periksa izin akun dan konfigurasi layanan."),
    );
  return data;
}
const money = (n: number) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(n);
function Field({
  name,
  label,
  type = "text",
  required = true,
  ...props
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  [key: string]: unknown;
}) {
  return (
    <label>
      {label}
      <input name={name} type={type} required={required} {...props} />
    </label>
  );
}
function App() {
  const [tab, setTab] = useState(currentTab);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [initialized, setInitialized] = useState<boolean>();
  const [orders, setOrders] = useState<any[]>([]);
  const [review, setReview] = useState<any[]>([]);
  const [catalogue, setCatalogue] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [variants, setVariants] = useState([
    {
      sku: "",
      name: "Default",
      price: "",
      weight: "",
      stock: "0",
      mode: "stock",
    },
  ]);
  useEffect(() => {
    const navigate = () => {
      setTab(currentTab());
      setMessage("");
      setSidebarOpen(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", navigate);
    return () => {
      window.removeEventListener("hashchange", navigate);
    };
  }, []);
  useEffect(() => {
    if (!sidebarOpen) return;
    // Move focus after the drawer's 200ms visibility/slide transition.
    const focusTimer = window.setTimeout(() => {
      document
        .querySelector<HTMLAnchorElement>('aside nav [aria-current="page"]')
        ?.focus();
    }, 220);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSidebarOpen(false);
        document.querySelector<HTMLButtonElement>(".menu-toggle")?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", escape);
    };
  }, [sidebarOpen]);
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const setup = await api("/api/setup");
      setInitialized(setup.initialized);
      if (setup.initialized) {
        const data = await api(
          tab === "products"
            ? "/api/admin/products"
            : tab === "review"
              ? "/api/admin/review"
              : "/api/admin/orders",
        );
        if (tab === "products") setCatalogue(data.products);
        else if (tab === "review") setReview(data.items);
        else setOrders(data.orders);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
  }, [tab]);
  useEffect(() => {
    api("/api/config")
      .then((c) => setGoogleEnabled(c.googleEnabled))
      .catch(() => {});
  }, []);
  async function login() {
    setError("");
    try {
      const data = await api("/api/auth/sign-in/social", {
        provider: "google",
        callbackURL: location.origin + "/admin/",
      });
      if (!data.url) throw new Error("Google sign-in belum tersedia.");
      location.assign(data.url);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function mutate(
    e: React.FormEvent<HTMLFormElement>,
    path: string,
    build: (f: FormData) => unknown,
    method = "POST",
  ) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    const form = e.currentTarget;
    try {
      const result = await api(path, build(new FormData(form)), method);
      form.reset();
      setMessage(
        result.product
          ? `Produk tersimpan. ID: ${result.product.id}. Varian: ${result.product.variants.map((v: any) => `${v.sku}: ${v.id}`).join(", ")}`
          : "Perubahan tersimpan di server.",
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const fields = (f: FormData, names: string[]) =>
    Object.fromEntries(names.map((n) => [n, f.get(n)]));
  return (
    <div className="app">
      {sidebarOpen && (
        <button
          className="nav-backdrop"
          aria-label="Tutup navigasi"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside id="admin-sidebar" data-open={sidebarOpen}>
        <a className="logo" href="/">
          <span className="brand-mark">f</span> flaremmerce
        </a>
        <div className="store-label">
          <span className="store-avatar">F</span>
          <div>
            Flaremmerce<small>Administrasi toko</small>
          </div>
          <span className="store-dot" />
        </div>
        <p className="nav-label">Kelola toko</p>
        <nav aria-label="Navigasi admin">
          {navigation.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => {
                setTab(id);
                setMessage("");
                setSidebarOpen(false);
              }}
            >
              <Icon name={id} />
              <span>{label}</span>
              {tab === id && <span className="active-dot" />}
            </a>
          ))}
        </nav>
        <div className="sidefoot">
          <a href="/">
            <Icon name="external" /> Lihat toko
          </a>
          <small>Flaremmerce · Operasional</small>
        </div>
      </aside>
      <main>
        <div className="topbar">
          <button
            className="menu-toggle"
            aria-label="Buka navigasi"
            aria-expanded={sidebarOpen}
            aria-controls="admin-sidebar"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Icon name="menu" />
          </button>
          <div className="breadcrumb">
            Toko <Icon name="chevron" />
            <strong>{navigation.find(([id]) => id === tab)?.[1]}</strong>
          </div>
          <button
            className="login-button"
            disabled={!googleEnabled}
            onClick={login}
          >
            Masuk dengan Google
          </button>
        </div>
        <div className="page-content" key={tab}>
          <header className="page-header">
            <div>
              <h1>
                {
                  (
                    {
                      orders: "Pesanan",
                      products: "Produk",
                      inventory: "Inventori",
                      campaigns: "Campaign pre-order",
                      review: "Manual review",
                    } as Record<string, string>
                  )[tab]
                }
              </h1>
            </div>
          </header>
          <p className="subtitle">
            {
              {
                orders: "Pantau pembayaran dan kelola pengiriman pesanan.",
                products:
                  "Kelola katalog, varian SKU, dan ketersediaan produk.",
                inventory:
                  "Catat setiap perubahan stok dengan alasan yang jelas.",
                campaigns: "Atur periode pemesanan, kuota, dan estimasi kirim.",
                review:
                  "Tinjau pembayaran yang membutuhkan pemeriksaan operator.",
              }[tab]
            }
          </p>
          {!googleEnabled && (
            <div className="notice">
              Google sign-in belum dikonfigurasi. Tidak ada akun atau password
              admin default.
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          {loading && (
            <p className="loading" role="status">
              <span className="spinner" /> Memuat data server…
            </p>
          )}
          {initialized === false ? (
            <section className="panel narrow">
              <span className="tag">FIRST RUN</span>
              <h2>Siapkan toko pertamamu.</h2>
              <p>
                Masuk dengan identitas Google terverifikasi, lalu masukkan
                bootstrap secret milik deployment. Akun Google biasa tidak
                otomatis menjadi admin.
              </p>
              <form
                onSubmit={(e) =>
                  mutate(e, "/api/setup", (f) => ({
                    secret: f.get("bootstrapSecret"),
                  }))
                }
              >
                <Field
                  name="bootstrapSecret"
                  label="Bootstrap secret"
                  type="password"
                  autoComplete="off"
                />
                <button disabled={busy}>Aktifkan admin pertama</button>
              </form>
              <p>
                Setup ditutup oleh server setelah berhasil. Tidak ada pemulihan
                publik yang dijanjikan.
              </p>
            </section>
          ) : (
            initialized && (
              <>
                {tab === "orders" && (
                  <>
                    <div className="stats">
                      <div>
                        <small>Pesanan dimuat</small>
                        <strong>{orders.length}</strong>
                      </div>
                      <div>
                        <small>Menunggu pembayaran</small>
                        <strong>
                          {
                            orders.filter((o) => o.status === "pending_payment")
                              .length
                          }
                        </strong>
                      </div>
                      <div>
                        <small>Pembayaran terkonfirmasi</small>
                        <strong>
                          {orders.filter((o) => o.status === "paid").length}
                        </strong>
                      </div>
                    </div>
                    <section className="panel">
                      <div className="row">
                        <h2>Daftar pesanan</h2>
                        <button
                          className="secondary"
                          onClick={refresh}
                          disabled={loading}
                        >
                          Perbarui
                        </button>
                      </div>
                      {!!orders.length && (
                        <div className="order-columns">
                          <span>Referensi / pelanggan</span>
                          <span>Pembayaran</span>
                          <span>Pengiriman</span>
                          <span>Total</span>
                          <span />
                        </div>
                      )}
                      {!orders.length ? (
                        <p>Belum ada pesanan untuk ditampilkan.</p>
                      ) : (
                        orders.map((o) => (
                          <details className="order order-detail" key={o.id}>
                            <summary className="order-summary">
                              <div>
                                <strong>{o.reference}</strong>
                                <small>{o.contact?.name || "Guest"}</small>
                              </div>
                              <span className="status-cell">
                                <span
                                  className="status-badge"
                                  data-status={o.status}
                                >
                                  {statusLabels[o.status] || o.status}
                                </span>
                              </span>
                              <span className="fulfillment-cell">
                                {statusLabels[o.fulfillment] ||
                                  "Belum diproses"}
                              </span>
                              <strong className="order-total">
                                {money(o.total)}
                              </strong>
                              <Icon name="chevron" />
                            </summary>
                            <div className="order-body">
                              <h3>Pengiriman</h3>
                              <form
                                className="fulfillment"
                                onSubmit={(e) =>
                                  mutate(
                                    e,
                                    "/api/admin/orders/" +
                                      encodeURIComponent(o.id) +
                                      "/fulfillment",
                                    (f) => ({
                                      status: f.get("status"),
                                      ...(f.get("tracking")
                                        ? { tracking: f.get("tracking") }
                                        : {}),
                                      ...(f.get("note")
                                        ? { note: f.get("note") }
                                        : {}),
                                    }),
                                    "PATCH",
                                  )
                                }
                              >
                                <label>
                                  Ubah status pengiriman
                                  <select
                                    key={o.fulfillment}
                                    name="status"
                                    defaultValue={
                                      o.fulfillment === "processing"
                                        ? "shipped"
                                        : o.fulfillment === "shipped" ||
                                            o.fulfillment === "delivered"
                                          ? "delivered"
                                          : "processing"
                                    }
                                  >
                                    <option value="processing">
                                      Sedang dipersiapkan
                                    </option>
                                    <option value="shipped">Dikirim</option>
                                    <option value="delivered">Diterima</option>
                                  </select>
                                </label>
                                <Field
                                  name="tracking"
                                  label="Nomor resi"
                                  required={false}
                                />
                                <Field
                                  name="note"
                                  label="Catatan timeline"
                                  required={false}
                                />
                                <button disabled={busy || o.status !== "paid"}>
                                  Simpan fulfillment
                                </button>
                              </form>
                              <h3>Timeline persiapan</h3>
                              <form
                                className="milestone"
                                onSubmit={(e) =>
                                  mutate(
                                    e,
                                    `/api/admin/orders/${o.id}/timeline`,
                                    (f) => ({
                                      ...fields(f, ["kind", "note"]),
                                      ...(f.get("estimatedDate")
                                        ? {
                                            estimatedDate:
                                              f.get("estimatedDate"),
                                          }
                                        : {}),
                                    }),
                                  )
                                }
                              >
                                <label>
                                  Milestone persiapan
                                  <select name="kind">
                                    <option value="preparing">Persiapan</option>
                                    <option value="production">Produksi</option>
                                    <option value="ready_to_ship">
                                      Siap kirim
                                    </option>
                                  </select>
                                </label>
                                <Field name="note" label="Catatan milestone" />
                                <Field
                                  name="estimatedDate"
                                  label="Estimasi tanggal (opsional, bukan jaminan)"
                                  type="date"
                                  required={false}
                                />
                                <button disabled={busy || o.status !== "paid"}>
                                  Tambahkan timeline
                                </button>
                              </form>
                              <small>
                                Pembayaran pending tidak boleh memicu
                                pengiriman.
                              </small>
                            </div>
                          </details>
                        ))
                      )}
                    </section>
                  </>
                )}
                {tab === "products" && (
                  <section className="panel">
                    <h2>
                      Katalog produk{" "}
                      <span className="count-badge">{catalogue.length}</span>
                    </h2>
                    {catalogue.map((p) => (
                      <article className="order product-row" key={p.id}>
                        <div>
                          <div className="product-heading">
                            <Icon name="products" />
                            <strong>{p.name}</strong>
                            <span className="tag">
                              {p.active ? "Aktif" : "Arsip"}
                            </span>
                          </div>
                          <details className="product-metadata">
                            <summary>
                              {p.variants.length} varian · Detail SKU{" "}
                              <Icon name="chevron" />
                            </summary>
                            <p>
                              ID produk: <code>{p.id}</code>
                            </p>
                            {p.variants.map((v: any) => (
                              <p key={v.id}>
                                {v.sku} · {money(v.price)} ·{" "}
                                {v.mode === "preorder"
                                  ? "Pre-order"
                                  : "Ready stock"}
                                <br />
                                ID varian: <code>{v.id}</code>
                              </p>
                            ))}
                          </details>
                        </div>
                        <form
                          onSubmit={(e) =>
                            mutate(
                              e,
                              `/api/admin/products/${p.id}`,
                              () => ({ active: !p.active }),
                              "PATCH",
                            )
                          }
                        >
                          <button className="secondary" disabled={busy}>
                            {p.active ? "Arsipkan" : "Aktifkan kembali"}
                          </button>
                        </form>
                      </article>
                    ))}
                    <details className="create-product">
                      <summary>
                        <Icon name="plus" /> Tambah produk baru{" "}
                        <Icon name="chevron" />
                      </summary>
                      <form
                        onSubmit={(e) =>
                          mutate(e, "/api/admin/products", (f) => ({
                            ...fields(f, ["name", "slug", "description"]),
                            ...(f.get("imageUrl")
                              ? { imageUrl: f.get("imageUrl") }
                              : {}),
                            variants: variants.map((v) => ({
                              ...v,
                              price: Number(v.price),
                              weight: Number(v.weight),
                              stock: Number(v.stock),
                            })),
                          }))
                        }
                      >
                        <div className="two">
                          <Field name="name" label="Nama produk" />
                          <Field
                            name="slug"
                            label="Slug"
                            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                          />
                        </div>
                        <label>
                          Deskripsi
                          <textarea name="description" required rows={4} />
                        </label>
                        <Field
                          name="imageUrl"
                          label="URL media publik (opsional)"
                          type="url"
                          required={false}
                        />
                        <p>
                          Harga dalam rupiah bulat. Berat dalam gram sesuai
                          kontrak pengiriman server.
                        </p>
                        {variants.map((v, i) => (
                          <fieldset key={i}>
                            <legend>Varian {i + 1}</legend>
                            <div className="variant">
                              {(
                                [
                                  "sku",
                                  "name",
                                  "price",
                                  "weight",
                                  "stock",
                                ] as const
                              ).map((name, n) => (
                                <label key={name}>
                                  {
                                    [
                                      "SKU unik",
                                      "Nama varian",
                                      "Harga (IDR)",
                                      "Berat (g)",
                                      "Stok awal",
                                    ][n]
                                  }
                                  <input
                                    required
                                    value={v[name]}
                                    type={n > 1 ? "number" : "text"}
                                    min={name === "stock" ? 0 : 1}
                                    step="1"
                                    onChange={(e) =>
                                      setVariants(
                                        variants.map((v, j) =>
                                          j === i
                                            ? { ...v, [name]: e.target.value }
                                            : v,
                                        ),
                                      )
                                    }
                                  />
                                </label>
                              ))}
                            </div>
                            <label>
                              Mode penjualan
                              <select
                                value={v.mode}
                                onChange={(e) =>
                                  setVariants(
                                    variants.map((variant, j) =>
                                      j === i
                                        ? { ...variant, mode: e.target.value }
                                        : variant,
                                    ),
                                  )
                                }
                              >
                                <option value="stock">Ready stock</option>
                                <option value="preorder">
                                  Pre-order (campaign wajib)
                                </option>
                              </select>
                            </label>
                            {variants.length > 1 && (
                              <button
                                type="button"
                                onClick={() =>
                                  setVariants(
                                    variants.filter((_, j) => j !== i),
                                  )
                                }
                              >
                                Hapus varian
                              </button>
                            )}
                          </fieldset>
                        ))}
                        <div className="row">
                          <button
                            type="button"
                            onClick={() =>
                              setVariants([
                                ...variants,
                                {
                                  sku: "",
                                  name: "",
                                  price: "",
                                  weight: "",
                                  stock: "0",
                                  mode: "stock",
                                },
                              ])
                            }
                          >
                            + Tambah varian
                          </button>
                          <button disabled={busy}>Simpan produk</button>
                        </div>
                      </form>
                    </details>
                  </section>
                )}
                {tab === "inventory" && (
                  <section className="panel narrow">
                    <h2>Penyesuaian stok</h2>
                    <p>
                      Perubahan dicatat sebagai ledger dengan alasan. Nilai
                      negatif mengurangi stok fisik, bukan membatalkan
                      reservasi.
                    </p>
                    <form
                      onSubmit={(e) =>
                        mutate(e, "/api/admin/inventory", (f) => ({
                          variantId: f.get("variantId"),
                          delta: Number(f.get("delta")),
                          reason: f.get("reason"),
                        }))
                      }
                    >
                      <Field name="variantId" label="ID varian" />
                      <Field
                        name="delta"
                        label="Perubahan stok (+ / −)"
                        type="number"
                        step="1"
                      />
                      <Field name="reason" label="Alasan perubahan" />
                      <button disabled={busy}>Catat penyesuaian</button>
                    </form>
                  </section>
                )}
                {tab === "campaigns" && (
                  <section className="panel narrow">
                    <h2>Rentang pemesanan & estimasi</h2>
                    <p>
                      Rentang kirim adalah estimasi, bukan jaminan. Satu
                      pengiriman mengikuti item paling lambat. Campaign aktif
                      tidak boleh tumpang tindih.
                    </p>
                    <form
                      onSubmit={(e) =>
                        mutate(e, "/api/admin/campaigns", (f) => ({
                          variantId: f.get("variantId"),
                          startsAt: new Date(
                            String(f.get("startsAt")) + "+07:00",
                          ).getTime(),
                          endsAt: new Date(
                            String(f.get("endsAt")) + "+07:00",
                          ).getTime(),
                          shipFrom: f.get("shipFrom"),
                          shipTo: f.get("shipTo"),
                          quota:
                            f.get("quota") === ""
                              ? null
                              : Number(f.get("quota")),
                        }))
                      }
                    >
                      <Field name="variantId" label="ID varian" />
                      <div className="two">
                        <Field
                          name="startsAt"
                          label="Mulai pemesanan (WIB)"
                          type="datetime-local"
                        />
                        <Field
                          name="endsAt"
                          label="Akhir pemesanan (WIB)"
                          type="datetime-local"
                        />
                      </div>
                      <div className="two">
                        <Field
                          name="shipFrom"
                          label="Estimasi kirim dari"
                          type="date"
                        />
                        <Field
                          name="shipTo"
                          label="Estimasi kirim sampai"
                          type="date"
                        />
                      </div>
                      <Field
                        name="quota"
                        label="Kuota (kosong = tanpa batas)"
                        type="number"
                        required={false}
                        min="1"
                        step="1"
                      />
                      <button disabled={busy}>Simpan campaign</button>
                    </form>
                  </section>
                )}
                {tab === "review" && (
                  <section className="panel">
                    <div className="row">
                      <h2>Perlu pemeriksaan operator</h2>
                      <button disabled={loading} onClick={refresh}>
                        Perbarui
                      </button>
                    </div>
                    <p>
                      Hasil pembayaran ambigu, mismatch atau exception tidak
                      berarti gagal maupun berhasil. Periksa bukti authoritative
                      sebelum tindakan operasional.
                    </p>
                    {!review.length ? (
                      <div className="empty">
                        Tidak ada item review yang ditampilkan.
                      </div>
                    ) : (
                      review.map((item, i) => (
                        <article className="order" key={item.id || i}>
                          <strong>
                            {item.reference ||
                              item.orderReference ||
                              item.id ||
                              "Item review"}
                          </strong>
                          <p>
                            {item.reason ||
                              item.status ||
                              item.type ||
                              "Perlu pemeriksaan"}
                          </p>
                          {item.createdAt && (
                            <small>
                              {new Date(item.createdAt).toLocaleString(
                                "id-ID",
                                {
                                  timeZone: "Asia/Jakarta",
                                },
                              )}
                            </small>
                          )}
                        </article>
                      ))
                    )}
                  </section>
                )}
              </>
            )
          )}
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
