import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
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
  const [tab, setTab] = useState("orders");
  const [initialized, setInitialized] = useState<boolean>();
  const [orders, setOrders] = useState<any[]>([]);
  const [review, setReview] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [variants, setVariants] = useState([
    { sku: "", name: "Default", price: "", weight: "", stock: "0" },
  ]);
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const setup = await api("/api/setup");
      setInitialized(setup.initialized);
      if (setup.initialized) {
        const data = await api(
          tab === "review" ? "/api/admin/review" : "/api/admin/orders",
        );
        if (tab === "review") setReview(data.items);
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
      await api(path, build(new FormData(form)), method);
      form.reset();
      setMessage("Perubahan tersimpan di server.");
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
      <aside>
        <a className="logo" href="/">
          flaremmerce <span>✳</span>
        </a>
        <p className="overline">STUDIO / OPERATIONS</p>
        <nav aria-label="Navigasi admin">
          {[
            ["orders", "Pesanan"],
            ["products", "Produk baru"],
            ["inventory", "Inventori"],
            ["campaigns", "Pre-order"],
            ["review", "Manual review"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => {
                setTab(id);
                setMessage("");
              }}
            >
              {label}
              <span>↗</span>
            </button>
          ))}
        </nav>
        <div className="sidefoot">
          Satu brand. Satu sumber data.
          <br />
          <a href="/catalog">Lihat storefront ↗</a>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="overline">FLAREMMERCE / ADMIN</p>
            <h1>
              {
                (
                  {
                    orders: "Pesanan",
                    products: "Tambah produk",
                    inventory: "Inventori",
                    campaigns: "Campaign pre-order",
                    review: "Manual review",
                  } as Record<string, string>
                )[tab]
              }
            </h1>
          </div>
          <button disabled={!googleEnabled} onClick={login}>
            Masuk dengan Google
          </button>
        </header>
        <p className="subtitle">
          Kelola dengan jelas. Semua perubahan diverifikasi dan diotorisasi oleh
          server.
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
        {loading && <p role="status">Memuat data server…</p>}
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
                  bootstrapSecret: f.get("bootstrapSecret"),
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
                      <button onClick={refresh} disabled={loading}>
                        Perbarui
                      </button>
                    </div>
                    {!orders.length ? (
                      <p>Belum ada pesanan untuk ditampilkan.</p>
                    ) : (
                      orders.map((o) => (
                        <article className="order" key={o.id}>
                          <div className="row">
                            <div>
                              <strong>{o.reference}</strong>
                              <p>
                                {o.contact?.name || o.customerName || ""} ·{" "}
                                {o.status}
                              </p>
                            </div>
                            <span className="tag">{money(o.total)}</span>
                          </div>
                          <p>
                            Fulfillment:{" "}
                            {o.fulfillmentStatus ||
                              o.fulfillment?.status ||
                              "Belum diproses"}
                          </p>
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
                              Status
                              <select
                                name="status"
                                defaultValue={
                                  o.fulfillmentStatus || "processing"
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
                            <button
                              disabled={
                                busy ||
                                !["paid", "completed"].includes(o.status)
                              }
                            >
                              Simpan fulfillment
                            </button>
                          </form>
                          <small>
                            Pembayaran pending tidak boleh memicu pengiriman.
                          </small>
                        </article>
                      ))
                    )}
                  </section>
                </>
              )}
              {tab === "products" && (
                <section className="panel">
                  <h2>Detail produk & SKU</h2>
                  <form
                    onSubmit={(e) =>
                      mutate(e, "/api/admin/products", (f) => ({
                        ...fields(f, [
                          "name",
                          "slug",
                          "description",
                          "imageUrl",
                        ]),
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
                      Harga dalam rupiah bulat. Berat dalam gram sesuai kontrak
                      pengiriman server.
                    </p>
                    {variants.map((v, i) => (
                      <fieldset key={i}>
                        <legend>Varian {i + 1}</legend>
                        <div className="variant">
                          {(
                            ["sku", "name", "price", "weight", "stock"] as const
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
                        {variants.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setVariants(variants.filter((_, j) => j !== i))
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
                            },
                          ])
                        }
                      >
                        + Tambah varian
                      </button>
                      <button disabled={busy}>Simpan produk</button>
                    </div>
                  </form>
                </section>
              )}
              {tab === "inventory" && (
                <section className="panel narrow">
                  <h2>Penyesuaian stok</h2>
                  <p>
                    Perubahan dicatat sebagai ledger dengan alasan. Nilai
                    negatif mengurangi stok fisik, bukan membatalkan reservasi.
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
                          f.get("quota") === "" ? null : Number(f.get("quota")),
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
                            {new Date(item.createdAt).toLocaleString("id-ID", {
                              timeZone: "Asia/Jakarta",
                            })}
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
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
