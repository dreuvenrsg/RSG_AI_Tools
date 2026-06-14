// src/s3.ts
// ⚠️ IMPORTANT: This Lambda MUST be deployed in the SAME AWS REGION as the S3 bucket
// containing the Fulcrum catalog file. Cross-region S3 can cause timeouts or IAM failures.

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import fs from "node:fs/promises";
import type { FulcrumCatalog, FulcrumItem, FulcrumCustomer } from "./types";

const s3 = new S3Client({});

// Small helper to turn S3 Body stream into string
function streamToString(stream: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    (stream as Readable)
      .on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * Loads Fulcrum catalog JSON from either a local file (FULCRUM_ITEMS_PATH)
 * or S3 (FULCRUM_ITEMS_BUCKET + FULCRUM_ITEMS_KEY).
 *
 * The return shape is normalized so both SellableItems and Customers blocks
 * are always present with safe defaults, even if the source file uses legacy keys.
 *
 * Supported input shapes:
 * - { SellableItems, Customers }
 * - { SellableItems, ActiveCustomers }
 * - { Items, Customers }
 * - { Items, ActiveCustomers }
 */
export async function fetchFulcrumData(): Promise<FulcrumCatalog> {
  const localPath = process.env.FULCRUM_ITEMS_PATH;
  const bucket = process.env.FULCRUM_ITEMS_BUCKET;
  const key = process.env.FULCRUM_ITEMS_KEY || "items.json";

  let rawText: string;
  if (localPath) {
    console.log(`[catalog] loading local file: ${localPath}`);
    rawText = await fs.readFile(localPath, "utf8");
  } else {
    if (!bucket) throw new Error("FULCRUM_ITEMS_BUCKET not set");
    console.log(`[catalog] fetching s3://${bucket}/${key}`);
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    rawText = await streamToString(obj.Body as any);
  }

  const raw = JSON.parse(rawText) ?? {};

  // Accept legacy keys and normalize
  const srcItems = raw.SellableItems ?? raw.Items ?? {};
  const srcCustomers = raw.Customers ?? raw.ActiveCustomers ?? {};

  const itemsByNumber: Record<string, FulcrumItem> = srcItems.itemsByNumber ?? {};
  const customersByName: Record<string, FulcrumCustomer> = srcCustomers.customersByName ?? {};

  const catalog: FulcrumCatalog = {
    lastSyncedAt: raw.lastSyncedAt ?? new Date().toISOString(),
    SellableItems: {
      itemCount:
        typeof srcItems.itemCount === "number"
          ? srcItems.itemCount
          : Object.keys(itemsByNumber).length,
      itemsByNumber,
    },
    Customers: {
      customerCount:
        typeof srcCustomers.customerCount === "number"
          ? srcCustomers.customerCount
          : Object.keys(customersByName).length,
      customersByName,
    },
  };

  console.log(
    `[catalog] ready: ${catalog.Customers.customerCount} customers, ${catalog.SellableItems.itemCount} items`
  );

  return catalog;
}
