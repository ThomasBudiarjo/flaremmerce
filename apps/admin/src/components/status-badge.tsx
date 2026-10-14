import { Badge } from "@/components/ui/badge";
import { label, orderStatus, fulfillmentStatus, paymentStatus, reviewStatus } from "@/lib/format";

type Tone = "default" | "secondary" | "destructive" | "outline";

function toneFor(value: string): Tone {
  if (["paid", "delivered", "succeeded", "resolved", "completed"].includes(value)) return "default";
  if (["pending_payment", "unfulfilled", "pending", "created", "open", "unknown"].includes(value)) return "secondary";
  if (["cancelled", "failed", "expired"].includes(value)) return "destructive";
  return "outline";
}

export function StatusBadge({ value, map }: { value: string | null | undefined; map?: Record<string, string> }) {
  if (!value) return <Badge variant="outline">—</Badge>;
  return <Badge variant={toneFor(value)}>{label(map ?? orderStatus, value)}</Badge>;
}

export const OrderStatusBadge = ({ value }: { value: string }) => <StatusBadge value={value} map={orderStatus} />;
export const FulfillmentBadge = ({ value }: { value: string }) => <StatusBadge value={value} map={fulfillmentStatus} />;
export const PaymentBadge = ({ value }: { value: string }) => <StatusBadge value={value} map={paymentStatus} />;
export const ReviewStatusBadge = ({ value }: { value: string }) => <StatusBadge value={value} map={reviewStatus} />;
