import type { ArchitectureGraph } from "@/lib/types";
import { makeNode } from "@/lib/mock/makeNode";

const storefront = makeNode("storefront", { x: 260, y: 0 }, {
  label: "Storefront Page",
  kind: "frontend",
  filePath: "web/app/(shop)/page.tsx",
  description: "Product grid and cart drawer; calls the catalog and orders APIs.",
  language: "tsx",
  exports: ["default StorefrontPage"],
  imports: ["@/lib/client"],
  params: [{ name: "category", type: "string | undefined" }],
  keywords: ["storefront", "shop", "frontend", "ui", "cart", "page"],
  code: `import { api } from "@/lib/client";

type Product = { id: string; name: string; price: number };

export default async function StorefrontPage() {
  const products: Product[] = await api.get("/api/products");
  return (
    <ProductGrid>
      {products.map((p) => (
        <ProductCard key={p.id} name={p.name} price={p.price.toFixed(2)}
          onAdd={() => api.post("/api/orders", { productId: p.id, qty: 1 })} />
      ))}
    </ProductGrid>
  );
}`,
});

const catalogApi = makeNode("catalog-api", { x: 40, y: 170 }, {
  label: "GET /api/products",
  kind: "api",
  filePath: "web/app/api/products/route.ts",
  description: "Read-through cached product listing.",
  language: "ts",
  exports: ["GET"],
  imports: ["@/server/cache/catalog", "@/server/db/products"],
  params: [{ name: "category", type: "query string" }],
  keywords: ["catalog", "products", "listing", "route", "api"],
  code: `import { NextResponse } from "next/server";
import { catalogCache } from "@/server/cache/catalog";
import { productsRepo } from "@/server/db/products";

export async function GET() {
  const cached = await catalogCache.get();
  if (cached) return NextResponse.json(cached);

  const products = await productsRepo.listActive();
  await catalogCache.set(products);
  return NextResponse.json(products);
}`,
});

const ordersApi = makeNode("orders-api", { x: 480, y: 170 }, {
  label: "POST /api/orders",
  kind: "api",
  filePath: "web/app/api/orders/route.ts",
  description: "Validates the cart payload and delegates checkout to the order service.",
  language: "ts",
  exports: ["POST"],
  imports: ["@/server/orders/service", "zod"],
  params: [
    { name: "productId", type: "string" },
    { name: "qty", type: "number" },
  ],
  keywords: ["orders", "checkout", "route", "api", "post"],
  code: `import { NextResponse } from "next/server";
import { z } from "zod";
import { orderService } from "@/server/orders/service";

const Body = z.object({ productId: z.string(), qty: z.number().int().positive() });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const order = await orderService.placeOrder(parsed.data.productId, parsed.data.qty);
  return NextResponse.json(order, { status: 201 });
}`,
});

const orderService = makeNode("order-service", { x: 480, y: 340 }, {
  label: "Order Service",
  kind: "logic",
  filePath: "server/orders/service.ts",
  description: "Prices the order, charges the card, and persists the order atomically.",
  language: "ts",
  exports: ["orderService"],
  imports: ["@/server/db/products", "@/server/payments/stripe"],
  params: [
    { name: "productId", type: "string" },
    { name: "qty", type: "number" },
  ],
  keywords: ["order", "service", "checkout", "pricing", "total"],
  code: `import { productsRepo, ordersRepo } from "@/server/db/products";
import { payments } from "@/server/payments/stripe";

export const orderService = {
  async placeOrder(productId: string, qty: number) {
    const product = await productsRepo.byId(productId);
    if (!product) throw new Error(\`unknown product \${productId}\`);

    const total = product.price * qty; // dollars, float
    const charge = await payments.charge(total);
    return ordersRepo.insert({ productId, qty, total, chargeId: charge.id });
  },
};`,
});

const paymentAdapter = makeNode("payment-adapter", { x: 700, y: 520 }, {
  label: "Payment Gateway Adapter",
  kind: "logic",
  filePath: "server/payments/stripe.ts",
  description: "Thin Stripe wrapper converting dollar totals to PaymentIntents.",
  language: "ts",
  exports: ["payments"],
  imports: ["stripe"],
  params: [{ name: "amount", type: "number (USD)" }],
  keywords: ["payment", "stripe", "charge", "gateway"],
  code: `import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export const payments = {
  async charge(amountUsd: number) {
    return stripe.paymentIntents.create({
      amount: Math.round(amountUsd * 100),
      currency: "usd",
      confirm: true,
    });
  },
};`,
});

const ordersDb = makeNode("orders-db", { x: 260, y: 520 }, {
  label: "Orders & Products DB",
  kind: "data",
  filePath: "server/db/products.ts",
  description: "Postgres `products` and `orders` tables (Drizzle ORM).",
  language: "ts",
  exports: ["productsRepo", "ordersRepo"],
  imports: ["drizzle-orm"],
  params: [{ name: "price", type: "numeric(10,2)" }],
  keywords: ["database", "db", "schema", "postgres", "price", "products", "orders", "table"],
  code: `import { pgTable, text, numeric, integer } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import { db } from "./client";

export const products = pgTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  price: numeric("price", { precision: 10, scale: 2, mode: "number" }).notNull(),
});

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  qty: integer("qty").notNull(),
  total: numeric("total", { precision: 10, scale: 2, mode: "number" }).notNull(),
});

export const productsRepo = {
  byId: (id: string) => db.query.products.findFirst({ where: eq(products.id, id) }),
  listActive: () => db.select().from(products),
};`,
});

const catalogCache = makeNode("catalog-cache", { x: 40, y: 340 }, {
  label: "Catalog Cache (Redis)",
  kind: "data",
  filePath: "server/cache/catalog.ts",
  description: "Five-minute Redis snapshot of the active product list.",
  language: "ts",
  exports: ["catalogCache"],
  imports: ["ioredis"],
  params: [{ name: "ttlSeconds", type: "number", description: "300" }],
  keywords: ["redis", "cache", "catalog", "ttl"],
  code: `import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);
const KEY = "catalog:v1";
const TTL_SECONDS = 300;

export const catalogCache = {
  async get() {
    const raw = await redis.get(KEY);
    return raw ? JSON.parse(raw) : null;
  },
  async set(products: unknown) {
    await redis.set(KEY, JSON.stringify(products), "EX", TTL_SECONDS);
  },
};`,
});

export const ecommerceApi: ArchitectureGraph = {
  id: "ecommerce-api",
  name: "E-Commerce API",
  description: "Storefront with cached catalog, order placement and Stripe payments.",
  nodes: [storefront, catalogApi, ordersApi, orderService, paymentAdapter, ordersDb, catalogCache],
  edges: [
    { id: "e-sf-cat", source: "storefront", target: "catalog-api", relation: "calls", label: "GET products" },
    { id: "e-sf-ord", source: "storefront", target: "orders-api", relation: "calls", label: "POST order" },
    { id: "e-cat-cache", source: "catalog-api", target: "catalog-cache", relation: "reads", label: "read-through" },
    { id: "e-cat-db", source: "catalog-api", target: "orders-db", relation: "reads", label: "listActive()" },
    { id: "e-ord-svc", source: "orders-api", target: "order-service", relation: "calls", label: "placeOrder()" },
    { id: "e-svc-pay", source: "order-service", target: "payment-adapter", relation: "calls", label: "charge()" },
    { id: "e-svc-db", source: "order-service", target: "orders-db", relation: "writes", label: "insert order" },
  ],
  commits: [
    {
      hash: "0d1e2f3",
      message: "feat: product catalog with Postgres + storefront",
      author: "lee.w",
      date: "2026-01-12",
      phase: "Phase 1 · Catalog MVP",
      narrative: "A read-only shop: one table, one route, one page. Prices are stored as numeric dollars — a choice that shapes everything downstream.",
      addedNodeIds: ["orders-db", "catalog-api", "storefront"],
      modifiedNodeIds: [],
    },
    {
      hash: "5a6b7c8",
      message: "feat(orders): checkout flow with Stripe",
      author: "lee.w",
      date: "2026-02-03",
      phase: "Phase 2 · Checkout",
      narrative: "Orders arrive with a dedicated service layer and a Stripe adapter. The adapter multiplies dollars by 100 at the edge, so float arithmetic now leaks into money handling.",
      addedNodeIds: ["orders-api", "order-service", "payment-adapter"],
      modifiedNodeIds: ["orders-db", "storefront"],
    },
    {
      hash: "c9d0e1f",
      message: "perf(catalog): Redis read-through cache (DB CPU 70% → 15%)",
      author: "ana.r",
      date: "2026-04-28",
      phase: "Phase 3 · Caching",
      narrative: "A marketing launch saturated Postgres CPU. A five-minute Redis snapshot absorbs the listing traffic — at the price of stale prices for up to five minutes after an edit.",
      addedNodeIds: ["catalog-cache"],
      modifiedNodeIds: ["catalog-api"],
    },
  ],
  scenarios: [
    {
      id: "ecom-price-cents",
      title: "Store prices as integer cents",
      triggers: ["cents", "price.*(int|integer)", "float.*money", "money.*integer"],
      rootNodeId: "orders-db",
      summary:
        "Moving `price`/`total` from numeric dollars to integer cents removes float rounding from checkout, but every reader formats or multiplies the value. The cached catalog snapshot also holds the old shape and must be versioned.",
      extraImpacts: [
        { nodeId: "payment-adapter", reason: "Must stop multiplying by 100 — it would charge 100× the price." },
        { nodeId: "catalog-cache", reason: "Cached JSON still contains dollar floats; bump the cache key." },
      ],
      diffs: [
        {
          nodeId: "orders-db",
          rationale: "Integer cents columns; Drizzle returns plain numbers.",
          after: `import { pgTable, text, integer } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import { db } from "./client";

export const products = pgTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
});

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  qty: integer("qty").notNull(),
  totalCents: integer("total_cents").notNull(),
});

export const productsRepo = {
  byId: (id: string) => db.query.products.findFirst({ where: eq(products.id, id) }),
  listActive: () => db.select().from(products),
};`,
        },
        {
          nodeId: "order-service",
          rationale: "Integer arithmetic end to end.",
          after: `import { productsRepo, ordersRepo } from "@/server/db/products";
import { payments } from "@/server/payments/stripe";

export const orderService = {
  async placeOrder(productId: string, qty: number) {
    const product = await productsRepo.byId(productId);
    if (!product) throw new Error(\`unknown product \${productId}\`);

    const totalCents = product.priceCents * qty;
    const charge = await payments.charge(totalCents);
    return ordersRepo.insert({ productId, qty, totalCents, chargeId: charge.id });
  },
};`,
        },
        {
          nodeId: "payment-adapter",
          rationale: "Stripe already expects minor units; pass cents through.",
          after: `import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export const payments = {
  async charge(amountCents: number) {
    if (!Number.isInteger(amountCents)) throw new Error("amount must be integer cents");
    return stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      confirm: true,
    });
  },
};`,
        },
        {
          nodeId: "catalog-cache",
          rationale: "Version the key so stale dollar snapshots are never read.",
          after: `import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);
const KEY = "catalog:v2-cents";
const TTL_SECONDS = 300;

export const catalogCache = {
  async get() {
    const raw = await redis.get(KEY);
    return raw ? JSON.parse(raw) : null;
  },
  async set(products: unknown) {
    await redis.set(KEY, JSON.stringify(products), "EX", TTL_SECONDS);
  },
};`,
        },
        {
          nodeId: "storefront",
          rationale: "Format cents for display at the edge.",
          after: `import { api } from "@/lib/client";

type Product = { id: string; name: string; priceCents: number };

const formatUsd = (cents: number) => (cents / 100).toFixed(2);

export default async function StorefrontPage() {
  const products: Product[] = await api.get("/api/products");
  return (
    <ProductGrid>
      {products.map((p) => (
        <ProductCard key={p.id} name={p.name} price={formatUsd(p.priceCents)}
          onAdd={() => api.post("/api/orders", { productId: p.id, qty: 1 })} />
      ))}
    </ProductGrid>
  );
}`,
        },
      ],
    },
  ],
};
