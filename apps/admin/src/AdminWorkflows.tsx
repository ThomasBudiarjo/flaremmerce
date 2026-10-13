import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

type API = (path: string, body?: unknown, method?: string) => Promise<any>;
const time = (n: number) =>
  n == null
    ? "—"
    : new Date(n).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
const localWib = (n: number) =>
  new Date(n + 7 * 3600000).toISOString().slice(0, 16);
function Field({
  label,
  ...props
}: React.ComponentProps<typeof Input> & { label: string }) {
  const id = React.useId();
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} required {...props} />
    </div>
  );
}
// Every mounted dialog body owns its requests. Unmount/selection changes invalidate completions.
function useLifetime() {
  const epoch = useRef(0);
  useEffect(() => {
    ++epoch.current;
    return () => {
      ++epoch.current;
    };
  }, []);
  return epoch;
}
function Facts({ value }: { value: Record<string, any> | null }) {
  return (
    <dl className="grid gap-2 text-sm">
      {Object.entries(value || {}).map(([key, val]) => (
        <div key={key}>
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="whitespace-pre-wrap break-words">
            {val !== null && typeof val === "object" ? (
              <Facts value={val} />
            ) : (
              String(val ?? "—")
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function OrderSnapshot({
  id,
  api,
  onLoaded,
  onLoading,
  revision = 0,
}: {
  id: string;
  revision?: number;
  api: API;
  onLoaded: (order: any) => void;
  onLoading: () => void;
}) {
  const [data, setData] = useState<any>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useLifetime();
  async function load() {
    const version = ++epoch.current;
    setBusy(true);
    setError("");
    setData(undefined);
    onLoading();
    try {
      const result = await api(`/api/admin/orders/${encodeURIComponent(id)}`);
      if (epoch.current === version) {
        setData(result);
        onLoaded(result.order);
      }
    } catch (e) {
      if (epoch.current === version) setError((e as Error).message);
    } finally {
      if (epoch.current === version) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      ++epoch.current;
    };
  }, [id, revision]);
  return (
    <section className="grid gap-4">
      <Button variant="outline" disabled={busy} onClick={load}>
        {busy ? "Memuat…" : "Perbarui detail"}
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {data && (
        <>
          <p className="text-sm">
            Dibuat {time(data.order.createdAt)} WIB · {data.order.currency}{" "}
            {data.order.total} · {data.order.status} / {data.order.fulfillment}
          </p>
          <h2 className="font-medium">Item dibeli (snapshot tetap)</h2>
          {data.order.items.map((item: any, i: number) => (
            <div
              key={item.id || i}
              className="grid gap-2 rounded-md border p-3"
            >
              <p className="font-medium">
                {item.productName} · {item.name}
              </p>
              <p className="text-sm">
                SKU dibeli: {item.sku} · Jumlah: {item.quantity} · Harga satuan:{" "}
                {data.order.currency} {item.price}
              </p>
              <p className="text-sm text-muted-foreground">
                {item.mode === "preorder" ? "Pre-order" : "Ready stock"} ·{" "}
                {item.weight} g
              </p>
              {item.campaign && (
                <p className="text-sm">
                  Estimasi saat dibeli: {item.campaign.shipFrom} –{" "}
                  {item.campaign.shipTo} (bukan jaminan, tidak mengikuti
                  perubahan campaign).
                </p>
              )}
            </div>
          ))}
          <div className="grid gap-4 sm:grid-cols-2">
            <section>
              <h2 className="font-medium">Kontak</h2>
              <Facts value={data.order.contact} />
            </section>
            <section>
              <h2 className="font-medium">Alamat</h2>
              <Facts value={data.order.address} />
            </section>
          </div>
          <h2 className="font-medium">Layanan pengiriman dibeli</h2>
          <Facts value={data.order.shipping} />
          <h2 className="font-medium">Pembayaran</h2>
          {data.payment ? (
            <Facts
              value={{
                status: data.payment.status,
                checks: data.payment.checks,
                nextCheck: time(data.payment.nextCheck),
                createdAt: time(data.payment.createdAt),
              }}
            />
          ) : (
            <p>Belum ada percobaan pembayaran.</p>
          )}
          <h2 className="font-medium">Timeline & resi</h2>
          {!data.order.timeline.length && <p>Belum ada milestone.</p>}
          {data.order.timeline.map((event: any, i: number) => (
            <div key={event.id || i} className="rounded-md border p-3">
              <p className="text-sm font-medium">
                {event.kind} · {time(event.createdAt)} WIB
              </p>
              <Facts value={event.details} />
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function SaveForm({
  api,
  path,
  method = "PATCH",
  build,
  children,
  onSaved,
  editableDefaults,
}: {
  api: API;
  path: string;
  method?: string;
  build: (f: FormData) => unknown;
  children: React.ReactNode;
  onSaved: () => Promise<void>;
  editableDefaults?: Record<string, unknown>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const epoch = useLifetime();
  const lock = useRef(false);
  const baseline = useRef<Record<string, FormDataEntryValue>>({});
  const defaults = useRef<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!formRef.current || lock.current) return;
    // Adopt refreshed defaults only for clean fields; other editors' drafts survive.
    formRef.current.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input[name], textarea[name], select[name]").forEach((field) => {
      const next = editableDefaults && field.name in editableDefaults
        ? String(editableDefaults[field.name] ?? "")
        : field instanceof HTMLSelectElement
        ? Array.from(field.options).find((option) => option.defaultSelected)?.value ?? field.value
        : field.defaultValue;
      if (!(field.name in baseline.current)) baseline.current[field.name] = field.value;
      else if (defaults.current[field.name] !== next &&
        (field.value === baseline.current[field.name] || field.value === next)) {
        field.value = next;
        baseline.current[field.name] = next;
      }
      defaults.current[field.name] = next;
    });
  });
  return (
    <form
      ref={formRef}
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (lock.current) return;
        lock.current = true;
        const form = e.currentTarget;
        const version = epoch.current;
        setBusy(true);
        setError("");
        setSaved(false);
        try {
          const submitted = new FormData(form);
          const values: Record<string, FormDataEntryValue> = {};
          submitted.forEach((value, name) => { values[name] = value; });
          const body = build(submitted) as Record<string, unknown>;
          const changes = method === "PATCH"
            ? Object.fromEntries(Object.entries(body).filter(([name]) => values[name] !== baseline.current[name]))
            : body;
          if (method === "PATCH" && Object.keys(changes).length === 0) {
            setSaved(true);
            return;
          }
          await api(path, changes, method);
          if (version === epoch.current) {
            baseline.current = values;
            setSaved(true);
            if (method === "POST") form.reset();
          }
          // A confirmed write must reconcile shared data even after its form closes.
          try { await onSaved(); } catch (e) {
            if (version === epoch.current) setError(`Perubahan tersimpan; pemuatan ulang gagal: ${(e as Error).message}. Gunakan perbarui untuk mencoba membaca lagi.`);
          }
        } catch (e) {
          if (version === epoch.current) setError((e as Error).message);
        } finally {
          if (version === epoch.current) {
            lock.current = false;
            setBusy(false);
          }
        }
      }}
    >
      <fieldset disabled={busy} className="grid gap-4">
        {children}
        <Button className="justify-self-start">
          {busy ? "Menyimpan…" : "Simpan"}
        </Button>
      </fieldset>
      {saved && <p role="status">Perubahan tersimpan.</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
const textFields = (f: FormData, names: string[]) =>
  Object.fromEntries(names.map((name) => [name, String(f.get(name) ?? "")]));
function VariantFields({
  variant,
  adding = false,
}: {
  variant?: any;
  adding?: boolean;
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="SKU"
          name="sku"
          defaultValue={variant?.sku}
          maxLength={100}
        />
        <Field
          label="Nama varian"
          name="name"
          defaultValue={variant?.name}
          maxLength={200}
        />
        <Field
          label="Harga (IDR)"
          name="price"
          type="number"
          min={0}
          step={1}
          defaultValue={variant?.price}
        />
        <Field
          label="Berat (g)"
          name="weight"
          type="number"
          min={1}
          step={1}
          defaultValue={variant?.weight}
        />
        <Label className="grid gap-2">
          Mode
          <NativeSelect name="mode" defaultValue={variant?.mode || "stock"}>
            <NativeSelectOption value="stock">Ready stock</NativeSelectOption>
            <NativeSelectOption value="preorder">Pre-order</NativeSelectOption>
          </NativeSelect>
        </Label>
        {adding ? (
          <Field
            label="Stok awal (dicatat dalam ledger)"
            name="stock"
            type="number"
            min={0}
            step={1}
            defaultValue={0}
          />
        ) : (
          <Label className="grid gap-2">
            Status varian
            <NativeSelect
              name="active"
              defaultValue={variant?.active ? "true" : "false"}
            >
              <NativeSelectOption value="true">Aktif</NativeSelectOption>
              <NativeSelectOption value="false">Nonaktif</NativeSelectOption>
            </NativeSelect>
          </Label>
        )}
      </div>
      {!adding && (
        <p className="text-sm text-muted-foreground">
          Fisik {variant.onHand} · Reservasi {variant.reserved} · Tersedia{" "}
          {variant.available ?? "tanpa batas"}. Perubahan stok hanya melalui
          ledger inventori.
        </p>
      )}
    </>
  );
}
export function CatalogEditor({
  product,
  api,
  onSaved,
}: {
  product: any;
  api: API;
  onSaved: () => Promise<void>;
}) {
  const variantBody = (f: FormData, adding: boolean) => ({
    ...textFields(f, ["sku", "name", "mode"]),
    price: Number(f.get("price")),
    weight: Number(f.get("weight")),
    ...(adding
      ? { stock: Number(f.get("stock")) }
      : { active: f.get("active") === "true" }),
  });
  return (
    <section className="grid gap-6">
      <h2 className="font-medium">Informasi produk</h2>
      <SaveForm
        key={product.id}
        api={api}
        editableDefaults={product}
        path={`/api/admin/products/${encodeURIComponent(product.id)}`}
        build={(f) => textFields(f, ["name", "slug", "description"])}
        onSaved={onSaved}
      >
        <Field
          label="Nama produk"
          name="name"
          defaultValue={product.name}
          maxLength={200}
        />
        <Field
          label="Slug"
          name="slug"
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          defaultValue={product.slug}
          maxLength={100}
        />
        <Label className="grid gap-2">
          Deskripsi
          <Textarea
            name="description"
            defaultValue={product.description}
            maxLength={10000}
          />
        </Label>
      </SaveForm>
      {product.variants.map((v: any) => (
        <section key={v.id} className="grid gap-3 rounded-md border p-4">
          <h3 className="font-medium">{v.sku}</h3>
          <SaveForm
            key={v.id}
            api={api}
            editableDefaults={v}
            path={`/api/admin/variants/${encodeURIComponent(v.id)}`}
            build={(f) => variantBody(f, false)}
            onSaved={onSaved}
          >
            <VariantFields variant={v} />
          </SaveForm>
        </section>
      ))}
      <h2 className="font-medium">Tambah varian</h2>
      <SaveForm
        api={api}
        path={`/api/admin/products/${encodeURIComponent(product.id)}/variants`}
        method="POST"
        build={(f) => variantBody(f, true)}
        onSaved={onSaved}
      >
        <VariantFields adding />
      </SaveForm>
    </section>
  );
}

export function InventoryLedger({
  variantId,
  api,
  revision,
}: {
  variantId: string;
  api: API;
  revision: number;
}) {
  const [data, setData] = useState<any>();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const epoch = useLifetime();
  async function load(more = false) {
    const version = ++epoch.current;
    setBusy(true);
    setError("");
    const query = new URLSearchParams({ variantId });
    if (more && data?.nextCursor) {
      query.set("before", String(data.nextCursor.before));
      query.set("beforeId", data.nextCursor.beforeId);
    }
    try {
      const result = await api(`/api/admin/inventory?${query}`);
      if (version === epoch.current)
        setData(
          more
            ? {
                ...result,
                movements: [
                  ...data.movements,
                  ...result.movements.filter(
                    (m: any) =>
                      !data.movements.some((old: any) => old.id === m.id),
                  ),
                ],
              }
            : result,
        );
    } catch (e) {
      if (version === epoch.current) setError((e as Error).message);
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    setData(undefined);
    if (variantId) void load();
    return () => {
      ++epoch.current;
    };
  }, [variantId, revision]);
  if (!variantId)
    return (
      <p className="text-sm text-muted-foreground">
        Pilih varian untuk melihat saldo dan ledger.
      </p>
    );
  return (
    <section className="grid gap-4">
      <h2 className="font-medium">Saldo & ledger</h2>
      <Button variant="outline" disabled={busy} onClick={() => load()}>
        Perbarui saldo
      </Button>
      {busy && <p role="status">Memuat…</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {data && (
        <>
          <p>
            Fisik: {data.inventory.onHand} · Reservasi:{" "}
            {data.inventory.reserved} · Tersedia: {data.inventory.available}
          </p>
          {!data.movements.length && <p>Belum ada pergerakan stok.</p>}
          {data.movements.map((m: any) => (
            <div key={m.id} className="rounded-md border p-3 text-sm">
              <p>
                {m.delta > 0 ? "+" : ""}
                {m.delta} · {m.reason}
              </p>
              <p className="break-all text-muted-foreground">
                {time(m.createdAt)} WIB · {m.actor} · Pesanan {m.orderId || "—"}
              </p>
            </div>
          ))}
          {data.nextCursor && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => load(true)}
            >
              Muat lebih banyak
            </Button>
          )}
        </>
      )}
    </section>
  );
}

export function CampaignList({
  api,
  revision,
}: {
  api: API;
  revision: number;
}) {
  const [data, setData] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const epoch = useLifetime();
  const mounted = useRef(false);
  const latestData = useRef(data);
  latestData.current = data;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  async function load(more = false) {
    if (!mounted.current) return;
    const version = ++epoch.current;
    setBusy(true);
    setError("");
    const query =
      more && data.nextCursor
        ? `?${new URLSearchParams({ before: String(data.nextCursor.before), beforeId: data.nextCursor.beforeId })}`
        : "";
    try {
      let result = await api(`/api/admin/campaigns${query}`);
      const retainedIds = latestData.current?.campaigns.map((c: any) => c.id) ?? [];
      while (!more && result.nextCursor && retainedIds.some((id: string) => !result.campaigns.some((c: any) => c.id === id))) {
        if (version !== epoch.current) return;
        const cursor = result.nextCursor;
        const next = await api(`/api/admin/campaigns?${new URLSearchParams({ before: String(cursor.before), beforeId: cursor.beforeId })}`);
        result = { ...next, campaigns: [...result.campaigns, ...next.campaigns] };
      }
      if (version === epoch.current)
        setData(
          more
            ? {
                ...result,
                campaigns: [
                  ...data.campaigns,
                  ...result.campaigns.filter(
                    (c: any) =>
                      !data.campaigns.some((old: any) => old.id === c.id),
                  ),
                ],
              }
            : result,
        );
    } catch (e) {
      if (version === epoch.current) setError((e as Error).message);
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      ++epoch.current;
    };
  }, [revision]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Semua alokasi campaign</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <p className="text-sm text-muted-foreground">
          Perubahan hanya mengatur janji untuk pesanan berikutnya. Snapshot item
          dan estimasi pada pesanan yang sudah dibuat tidak berubah. Semua waktu
          pemesanan dalam WIB. Hanya kolom yang diubah dikirim. Perubahan bersamaan
          pada kolom yang sama masih dapat saling menimpa (API belum mendukung CAS).
        </p>
        <Button variant="outline" disabled={busy} onClick={() => load()}>
          Perbarui campaign
        </Button>
        {busy && <p role="status">Memuat…</p>}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {data && !data.campaigns.length && <p>Belum ada campaign.</p>}
        {data?.campaigns.map((c: any) => (
          <section key={c.id} className="grid gap-4 rounded-md border p-4">
            <h2 className="font-medium">
              {c.productName} · {c.sku}
            </h2>
            <p className="text-sm">
              {!c.active
                ? "Nonaktif"
                : Date.now() < c.startsAt
                  ? "Mendatang"
                  : Date.now() >= c.endsAt
                    ? "Berakhir"
                    : "Sedang berlangsung"}{" "}
              · Reservasi {c.reserved} · Terjual {c.sold} · Kuota{" "}
              {c.quota ?? "tanpa batas"}
            </p>
            <SaveForm
              key={c.id}
              api={api}
              editableDefaults={{ ...c, startsAt: localWib(c.startsAt), endsAt: localWib(c.endsAt) }}
              path={`/api/admin/campaigns/${encodeURIComponent(c.id)}`}
              onSaved={() => load()}
              build={(f) => ({
                startsAt: new Date(
                  String(f.get("startsAt")) + "+07:00",
                ).getTime(),
                endsAt: new Date(String(f.get("endsAt")) + "+07:00").getTime(),
                ...textFields(f, ["shipFrom", "shipTo"]),
                quota: f.get("quota") === "" ? null : Number(f.get("quota")),
                active: f.get("active") === "true",
              })}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Mulai pemesanan (WIB)"
                  name="startsAt"
                  type="datetime-local"
                  defaultValue={localWib(c.startsAt)}
                />
                <Field
                  label="Akhir pemesanan (WIB)"
                  name="endsAt"
                  type="datetime-local"
                  defaultValue={localWib(c.endsAt)}
                />
                <Field
                  label="Estimasi kirim dari"
                  name="shipFrom"
                  type="date"
                  defaultValue={c.shipFrom}
                />
                <Field
                  label="Estimasi kirim sampai"
                  name="shipTo"
                  type="date"
                  defaultValue={c.shipTo}
                />
                <Field
                  label="Kuota (kosong = tanpa batas)"
                  name="quota"
                  type="number"
                  min={0}
                  step={1}
                  required={false}
                  defaultValue={c.quota ?? ""}
                />
                <Label className="grid gap-2">
                  Status campaign
                  <NativeSelect
                    name="active"
                    defaultValue={c.active ? "true" : "false"}
                  >
                    <NativeSelectOption value="true">
                      Aktif / aktifkan kembali
                    </NativeSelectOption>
                    <NativeSelectOption value="false">
                      Nonaktif / nonaktifkan
                    </NativeSelectOption>
                  </NativeSelect>
                </Label>
              </div>
            </SaveForm>
          </section>
        ))}
        {data?.nextCursor && (
          <Button variant="outline" disabled={busy} onClick={() => load(true)}>
            Muat lebih banyak
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
