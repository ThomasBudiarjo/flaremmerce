import { useState } from "react";
import { UserPlus } from "lucide-react";
import { del, HttpError, post } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useRoute } from "@/lib/router";
import { dateWIB, roleLabel } from "@/lib/format";
import type { AdminUser, Role } from "@/lib/types";
import { useMutation } from "@/hooks/use-mutation";
import { useResource } from "@/hooks/use-resource";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, LoadError, TextField } from "@/components/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { TableCell, TableRow } from "@/components/ui/table";

const roleHelp: Record<Role, string> = {
  owner: "Semua area, termasuk tim & akses.",
  ops: "Pesanan, pelanggan, review, blocklist, operasional.",
  catalog: "Produk, kategori, inventori, pre-order.",
};

// The server words last-owner refusals in English; operators see them in Indonesian.
function explain(error: HttpError) {
  if (/last owner/i.test(error.message)) return "Owner terakhir tidak dapat diturunkan atau dicabut. Tambahkan owner lain terlebih dahulu.";
  if (/installation owner/i.test(error.message)) return "Pemilik instalasi tidak dapat dicabut.";
  if (/Verified Google/i.test(error.message)) return "Pengguna harus login dengan akun Google terverifikasi dan tidak diblokir.";
  return error.message;
}

function RoleSelect({ admin, onChanged }: { admin: AdminUser; onChanged: (role: Role) => void }) {
  const [message, setMessage] = useState("");
  const change = useMutation((role: Role) => post("/api/admin/roles", { userId: admin.userId, role }).then(() => role), {
    key: `role:${admin.userId}`,
    success: (role) => `Peran ${admin.name} menjadi ${roleLabel[role]}.`,
    onSuccess: (role) => {
      setMessage("");
      onChanged(role);
    },
    onError: (error) => setMessage(explain(error)),
  });
  return (
    <div className="grid gap-1">
      <NativeSelect aria-label={`Peran ${admin.name}`} value={admin.role} disabled={change.pending} onChange={(e) => void change.mutate(e.target.value as Role)}>
        {(Object.keys(roleLabel) as Role[]).map((role) => (
          <NativeSelectOption key={role} value={role}>
            {roleLabel[role]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {message && (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}

export function SettingsTeamPage() {
  const { me } = useSession();
  const { route } = useRoute();
  const resource = useResource<{ admins: AdminUser[] }>("/api/admin/roles");
  const [userId, setUserId] = useState(route.query.get("userId") ?? "");
  const [role, setRole] = useState<Role>("ops");
  const [grantError, setGrantError] = useState("");
  const admins = resource.data?.admins ?? [];
  const grant = useMutation(() => post<{ changed: boolean }>("/api/admin/roles", { userId: userId.trim(), role }), {
    key: "role-grant",
    success: (result) => (result.changed ? "Akses admin diberikan." : "Tidak ada perubahan."),
    onSuccess: () => {
      setUserId("");
      setGrantError("");
      void resource.reload({ keep: true });
    },
    onError: (error) => setGrantError(explain(error)),
  });
  const revoke = useMutation((target: AdminUser) => del(`/api/admin/roles/${encodeURIComponent(target.userId)}`), {
    key: "role-revoke",
    success: "Akses admin dicabut.",
    onSuccess: () => void resource.reload({ keep: true }),
    onError: () => void resource.reload({ keep: true }),
  });
  const setRoleOf = (target: string, next: Role) => resource.setData((data) => (data ? { admins: data.admins.map((a) => (a.userId === target ? { ...a, role: next } : a)) } : data));
  const owners = admins.filter((a) => a.role === "owner").length;

  return (
    <>
      <PageHeader title="Tim & akses" description="Atur siapa yang dapat masuk ke admin dan area yang bisa mereka kelola." />
      <Card>
        <CardHeader>
          <CardTitle>Beri akses admin</CardTitle>
          <CardDescription>
            Pengguna harus sudah login sekali dengan Google terverifikasi. Salin ID pengguna dari halaman Pelanggan (menu aksi → Beri akses admin).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void grant.mutate(undefined);
            }}
          >
            <TextField label="ID pengguna" required maxLength={128} value={userId} onChange={(e) => setUserId(e.target.value)} />
            <Field label="Peran">
              {(id) => (
                <NativeSelect id={id} className="w-full" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {(Object.keys(roleLabel) as Role[]).map((r) => (
                    <NativeSelectOption key={r} value={r}>
                      {roleLabel[r]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Button disabled={grant.pending || !userId.trim()}>
              <UserPlus />
              Beri akses
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">{roleHelp[role]}</p>
          {grantError && (
            <Alert variant="destructive" role="alert" className="mt-3">
              <AlertDescription>{grantError}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
      {resource.error && <LoadError message={resource.error} onRetry={() => void resource.reload()} />}
      {owners === 1 && <p className="text-sm text-muted-foreground">Hanya ada satu owner. Owner terakhir tidak dapat diturunkan atau dicabut.</p>}
      <DataTable loading={resource.loading && !resource.data} columns={[{ head: "Admin" }, { head: "Peran" }, { head: "Sejak" }, { head: <span className="sr-only">Aksi</span> }]} empty={{ title: "Belum ada admin" }}>
        {admins.map((admin) => {
          const self = admin.userId === me.user.id;
          const locked = admin.installationOwner || (admin.role === "owner" && owners <= 1);
          return (
            <TableRow key={admin.userId}>
              <TableCell className="whitespace-normal">
                <div className="font-medium">
                  {admin.name}
                  {self && <span className="text-muted-foreground"> (kamu)</span>}
                </div>
                <div className="text-xs break-all text-muted-foreground">{admin.email}</div>
                {admin.installationOwner && <Badge variant="outline">Pemilik instalasi</Badge>}
              </TableCell>
              <TableCell>
                <RoleSelect admin={admin} onChanged={(next) => setRoleOf(admin.userId, next)} />
              </TableCell>
              <TableCell className="whitespace-nowrap">{dateWIB(admin.createdAt)}</TableCell>
              <TableCell className="text-right">
                <ConfirmDialog
                  trigger={
                    <Button variant="ghost" size="sm" disabled={locked || revoke.pending} title={locked ? "Owner terakhir atau pemilik instalasi tidak dapat dicabut" : undefined}>
                      Cabut akses
                    </Button>
                  }
                  title={`Cabut akses admin ${admin.name}?`}
                  description={self ? "Kamu akan kehilangan akses admin setelah ini." : "Pengguna tetap bisa berbelanja sebagai pelanggan."}
                  confirmLabel="Cabut akses"
                  onConfirm={() => void revoke.mutate(admin)}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </DataTable>
    </>
  );
}
