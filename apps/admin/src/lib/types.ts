/** Shapes returned by the admin API (see src/commerce/admin.ts and src/integrations/users.ts). */
export type Role = "owner" | "ops" | "catalog";

export type Me = {
  user: { id: string; name: string; email: string };
  role: Role;
  areas: Role[];
};

export type Summary = {
  range: string;
  since: number;
  now: number;
  /** Gross sales (items + shipping) of orders paid in the range, by payment time. */
  revenue: number;
  itemsRevenue: number;
  shipping: number;
  paidOrders: number;
  averageOrderValue: number;
  pendingPayment: number;
  toFulfill: number;
  openReviews: number;
  lowStock: number;
};

export type OrderItem = {
  id: string;
  variantId: string;
  campaignId: string | null;
  quantity: number;
  price: number;
  sku: string;
  name: string;
  productName: string;
  mode: "stock" | "preorder";
  weight: number;
  billedWeight: number;
  campaign?: { id: string; shipFrom: string; shipTo: string };
};

export type OrderTimelineEvent = {
  kind: string;
  createdAt: number;
  details: Record<string, any>;
};

export type OrderSummary = {
  id: string;
  reference: string;
  status: string;
  fulfillment: string;
  total: number;
  currency: string;
  createdAt: number;
  /** Lists carry no contact or address PII: only the name and the shipping service. The audited detail read has the rest. */
  contact: { name?: string | null };
  shipping: { service?: string | null };
  hold: boolean;
  openReviewReasons: string[];
};

export type OrderDetail = Omit<OrderSummary, "contact" | "shipping"> & {
  contact: { name?: string; email?: string; phone?: string };
  address: Record<string, any>;
  shipping: { service?: string; amount?: number; weight?: number; shipFrom?: string | null; shipTo?: string | null };
  items: OrderItem[];
  timeline: OrderTimelineEvent[];
  tracking: { number: string; courier: string | null; courierName: string | null; url: string | null } | null;
};

export type PaymentAttempt = {
  status: string;
  checks: number;
  nextCheck: number | null;
  createdAt: number;
};

export type Variant = {
  id: string;
  productId?: string;
  sku: string;
  name: string;
  price: number;
  weight: number;
  mode: "stock" | "preorder";
  active: boolean;
  maxPerOrder: number | null;
  maxPerCustomer: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  lowStockThreshold: number | null;
  version: number;
  onHand: number;
  reserved: number;
  /** Null for a pre-order campaign without quota. */
  available: number | null;
  campaign?: {
    id: string;
    startsAt: number;
    endsAt: number;
    shipFrom: string;
    shipTo: string;
    quota: number | null;
    available: number | null;
    version: number;
  };
};

export type Product = {
  id: string;
  slug: string;
  name: string;
  description: string;
  imageUrl: string | null;
  category: { slug: string; name: string } | null;
  active: boolean;
  categoryId: string | null;
  version: number;
  variants: Variant[];
};

export type VariantSearchResult = {
  id: string;
  sku: string;
  name: string;
  mode: "stock" | "preorder";
  price: number;
  active: boolean;
  productId: string;
  productName: string;
};

export type LowStockRow = {
  variantId: string;
  sku: string;
  name: string;
  productId: string;
  productName: string;
  onHand: number;
  reserved: number;
  available: number;
  threshold: number;
};

export type InventoryMovement = {
  id: string;
  variantId: string;
  delta: number;
  reason: string;
  orderId: string | null;
  actor: string;
  createdAt: number;
};

export type Campaign = {
  id: string;
  variantId: string;
  sku: string;
  productId: string;
  productName: string;
  startsAt: number;
  endsAt: number;
  shipFrom: string;
  shipTo: string;
  quota: number | null;
  reserved: number;
  sold: number;
  active: boolean;
  version: number;
};

export type Category = {
  id: string;
  slug: string;
  name: string;
  position: number;
  active: boolean;
  version: number;
  /** Products in the category, archived included (admin list only). */
  productCount?: number;
};

export type Customer = {
  id: string;
  name: string;
  email: string;
  createdAt: number;
  orders: number;
  banned: boolean;
  admin: boolean;
};

export type ReviewItem = {
  id: string;
  orderId: string | null;
  reason: string;
  eventKey: string | null;
  createdAt: number;
  status: "open" | "resolved";
  note: string;
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
  reference: string | null;
};

export type BlocklistEntry = {
  id: string;
  kind: "email" | "phone" | "ip";
  reason: string;
  actor: string;
  createdAt: number;
};

export type AdminUser = {
  userId: string;
  name: string;
  email: string;
  role: Role;
  grantedBy: string;
  createdAt: number;
  installationOwner: boolean;
};

export type OperationsSnapshot = {
  now: number;
  sampleLimit: number;
  sections: Record<
    string,
    { items: { id: string; orderId?: string; reference?: string; status: string; attempts?: number; createdAt: number; ageMs: number }[]; hasMore: boolean; atLeast: number }
  >;
};
