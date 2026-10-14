import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** Shown after a 409 compare-and-swap conflict; reloading adopts the server's current entity. */
export function ConflictBanner({ onReload }: { onReload: () => void }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>Data sudah diubah orang lain</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        Perubahanmu tidak disimpan agar tidak menimpa perubahan terbaru. Muat data terbaru, lalu ulangi suntingan.
        <Button variant="outline" size="sm" onClick={onReload}>
          Muat data terbaru
        </Button>
      </AlertDescription>
    </Alert>
  );
}
