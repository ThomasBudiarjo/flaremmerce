import React, { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/loading";

/**
 * Primary photo upload with the original detached-upload semantics: the object is stored
 * first and only becomes the product image when the surrounding form save binds its URL.
 */
export function PhotoUpload({
  productId,
  onImage,
  onPending,
  disabled,
}: {
  productId?: string;
  onImage: (url: string) => void;
  onPending: (blocked: boolean) => void;
  disabled?: boolean;
}) {
  const generation = useRef(0);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = React.useId();
  useEffect(() => {
    onImage("");
    onPending(false);
    return () => {
      generation.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  async function select(file?: File) {
    const version = ++generation.current;
    onImage("");
    setError("");
    setPreview("");
    setUploading(false);
    onPending(!!file);
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024 || !file.size) {
      setError("Pilih JPEG, PNG, atau WebP, maksimal 5 MiB.");
      return;
    }
    setPreview(URL.createObjectURL(file));
    setUploading(true);
    try {
      const response = await fetch(`/api/admin/media${productId ? `?productId=${encodeURIComponent(productId)}` : ""}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const data = await response.json();
      if (!response.ok || typeof data.url !== "string") throw new Error(data.error || "Unggah foto gagal.");
      if (version !== generation.current) return;
      onImage(data.url);
      onPending(false);
    } catch (e) {
      if (version === generation.current) setError((e as Error).message);
    } finally {
      if (version === generation.current) setUploading(false);
    }
  }
  return (
    <div className="grid gap-3">
      <div
        data-dragging={dragging || undefined}
        className="grid gap-2 rounded-lg border border-dashed p-3 transition-colors data-dragging:border-primary data-dragging:bg-muted"
        onDragOver={(e) => {
          if (disabled || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled) return;
          if (input.current) input.current.value = "";
          void select(e.dataTransfer.files[0]);
        }}
      >
        <Label htmlFor={id}>Unggah foto utama (JPEG, PNG, WebP; maksimal 5 MiB)</Label>
        <p className="text-xs text-muted-foreground">Tarik foto ke sini atau pilih file.</p>
        <Input
          ref={input}
          id={id}
          name="photo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={disabled}
          onChange={(e) => select(e.target.files?.[0])}
        />
      </div>
      {preview && <img src={preview} alt="Pratinjau foto pilihan" className="h-40 w-full rounded-md object-contain" />}
      {uploading && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Spinner />
          Mengunggah foto…
        </p>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">Foto menjadi utama setelah perubahan disimpan.</p>
      <Button
        type="button"
        variant="outline"
        className="justify-self-start"
        disabled={disabled}
        onClick={() => {
          if (input.current) input.current.value = "";
          select();
        }}
      >
        Batalkan pilihan foto
      </Button>
    </div>
  );
}
