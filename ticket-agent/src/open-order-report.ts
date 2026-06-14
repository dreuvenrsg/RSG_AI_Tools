import type {
  FulcrumItemDetails,
  FulcrumSalesOrder,
  FulcrumShipment,
  FulcrumShipmentLineItem,
  OpenOrderReportParseResult,
  OpenOrderReportResult,
  OpenOrderReportRow,
  OpenOrderReportRowEnrichment,
  TicketAttachment,
  TicketContext,
} from "./types";
import {
  findSalesOrdersByPO,
  generateTrackingUrl,
  getItemById,
  listShipmentLineItems,
  listShipmentsForSalesOrder,
} from "./fulcrum";
import {
  downloadTicketAttachment,
  findLatestAttachment,
} from "./zendesk";

const REQUIRED_HEADERS = [
  "Purchase Order Number",
  "Line Number",
  "Item Number",
  "Quantity Open",
  "Request Date",
  "Promised Delivery",
];

type ShipmentWithItem = {
  shipment: FulcrumShipment;
  lineItem: FulcrumShipmentLineItem;
  item: FulcrumItemDetails | null;
};

type SalesOrderDataset = {
  salesOrder: FulcrumSalesOrder;
  lines: ShipmentWithItem[];
};

function isCsvAttachment(attachment: TicketAttachment): boolean {
  return /\.csv$/i.test(attachment.filename)
    || attachment.content_type.includes("csv")
    || attachment.content_type === "application/octet-stream";
}

export function findOpenOrderReportAttachment(
  ticketContext: TicketContext
): TicketAttachment | null {
  return findLatestAttachment(ticketContext, (attachment) => isCsvAttachment(attachment));
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentValue = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        currentValue += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(currentValue);
      currentValue = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        i++;
      }
      currentRow.push(currentValue);
      rows.push(currentRow);
      currentRow = [];
      currentValue = "";
      continue;
    }

    currentValue += char;
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }

  return rows.filter((row) => row.some((value) => value !== ""));
}

function serializeCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const safe = value ?? "";
          if (/[",\n\r]/.test(safe)) {
            return `"${safe.replace(/"/g, '""')}"`;
          }
          return safe;
        })
        .join(",")
    )
    .join("\n");
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function formatReportDate(value: string | null | undefined): string {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
}

function normalizeToken(value: string | null | undefined): string {
  return (value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function itemIdentifiers(item: FulcrumItemDetails | null, customerId: string): string[] {
  if (!item) return [];

  const identifiers = [item.number];
  const customerDetails = item.customerDetails || [];
  for (const detail of customerDetails) {
    if (detail.customerId !== customerId) continue;
    if (detail.customerItemNumber) identifiers.push(detail.customerItemNumber);
    if (detail.customerItemName) identifiers.push(detail.customerItemName);
  }

  return identifiers
    .flatMap((value) => value.split("/"))
    .map((value) => value.trim())
    .filter(Boolean);
}

function matchesRowItem(
  row: OpenOrderReportRow,
  item: FulcrumItemDetails | null,
  customerId: string
): boolean {
  const normalizedRowItem = normalizeToken(row.itemNumber);
  if (!normalizedRowItem) return false;

  return itemIdentifiers(item, customerId).some((identifier) => {
    const normalizedIdentifier = normalizeToken(identifier);
    return normalizedIdentifier === normalizedRowItem
      || normalizedIdentifier.includes(normalizedRowItem)
      || normalizedRowItem.includes(normalizedIdentifier);
  });
}

function chooseBestCandidate(
  row: OpenOrderReportRow,
  salesOrder: FulcrumSalesOrder,
  candidates: ShipmentWithItem[]
): ShipmentWithItem | null {
  if (candidates.length === 0) return null;

  const rowQuantity = row.quantityOpen;

  const scored = candidates.map((candidate) => {
    const quantity = candidate.shipment.status === "shipped"
      ? candidate.lineItem.quantityShipped
      : candidate.lineItem.quantityToShip;
    const quantityDelta = rowQuantity == null ? 1000 : Math.abs(quantity - rowQuantity);
    const statusScore = candidate.shipment.status === "shipped" ? 1000 : 500;
    const exactQuantityScore = quantityDelta === 0 ? 250 : Math.max(0, 100 - quantityDelta);
    const shippedDateScore = candidate.shipment.shippedDate
      ? new Date(candidate.shipment.shippedDate).getTime() / 1_000_000_000
      : 0;
    const shipByDateScore = candidate.shipment.shipByDate
      ? -new Date(candidate.shipment.shipByDate).getTime() / 1_000_000_000
      : 0;

    return {
      candidate,
      score: statusScore + exactQuantityScore + shippedDateScore + shipByDateScore,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.candidate ?? null;
}

function buildRowEnrichment(
  row: OpenOrderReportRow,
  salesOrder: FulcrumSalesOrder | null,
  candidates: ShipmentWithItem[]
): OpenOrderReportRowEnrichment {
  if (!salesOrder) {
    return {
      row,
      salesOrder: null,
      shipment: null,
      shipmentLineItem: null,
      item: null,
      promiseOrShipDate: row.promisedDelivery,
      trackingNumber: null,
      trackingUrl: null,
      warning: `No Fulcrum sales order found for ${row.purchaseOrderNumber}`,
    };
  }

  const best = chooseBestCandidate(row, salesOrder, candidates);
  if (!best) {
    return {
      row,
      salesOrder,
      shipment: null,
      shipmentLineItem: null,
      item: null,
      promiseOrShipDate: salesOrder.deliveryDueDate || row.promisedDelivery,
      trackingNumber: null,
      trackingUrl: null,
      warning: `No shipment line matched item ${row.itemNumber}`,
    };
  }

  const normalizedTracking = best.shipment.trackingNumber
    ? best.shipment.trackingNumber.replace(/\s+/g, "")
    : null;
  const promiseOrShipDate = best.shipment.status === "shipped"
    ? best.shipment.shippedDate || best.shipment.shipByDate || salesOrder.deliveryDueDate || row.promisedDelivery
    : best.shipment.shipByDate || salesOrder.deliveryDueDate || row.promisedDelivery;

  return {
    row,
    salesOrder,
    shipment: best.shipment,
    shipmentLineItem: best.lineItem,
    item: best.item,
    promiseOrShipDate,
    trackingNumber: normalizedTracking,
    trackingUrl: normalizedTracking
      ? generateTrackingUrl(normalizedTracking, best.shipment.carrier, best.shipment.shippingMethod)
      : null,
    warning: null,
  };
}

async function buildSalesOrderDataset(
  salesOrder: FulcrumSalesOrder
): Promise<SalesOrderDataset> {
  const shipments = await listShipmentsForSalesOrder(salesOrder.id, { includeAll: true });
  const lines: ShipmentWithItem[] = [];

  for (const shipment of shipments) {
    const shipmentLineItems = await listShipmentLineItems(shipment.id);
    const itemIds = [...new Set(
      shipmentLineItems
        .map((lineItem) => lineItem.itemId)
        .filter((itemId): itemId is string => Boolean(itemId))
    )];
    const items = await Promise.all(itemIds.map((itemId) => getItemById(itemId)));
    const itemMap = new Map(items.map((item) => [item.id, item]));

    for (const lineItem of shipmentLineItems) {
      lines.push({
        shipment,
        lineItem,
        item: lineItem.itemId ? itemMap.get(lineItem.itemId) ?? null : null,
      });
    }
  }

  return { salesOrder, lines };
}

export async function parseOpenOrderReportAttachment(
  attachment: TicketAttachment
): Promise<OpenOrderReportParseResult> {
  const download = await downloadTicketAttachment(attachment);
  const csvText = download.text;
  if (!csvText) {
    throw new Error(`Attachment ${attachment.filename} is not a text CSV file`);
  }

  const parsedRows = parseCsv(csvText);
  const headerIndex = parsedRows.findIndex((row) =>
    REQUIRED_HEADERS.every((header) => row.includes(header))
  );
  if (headerIndex === -1) {
    throw new Error(`Attachment ${attachment.filename} is not a supported open order report`);
  }

  const metadataRows = parsedRows.slice(0, headerIndex);
  const header = parsedRows[headerIndex];
  const rows = parsedRows
    .slice(headerIndex + 1)
    .filter((row) => row.some((value) => value.trim() !== ""))
    .map((values) => {
      const raw = Object.fromEntries(header.map((key, index) => [key, values[index] || ""]));
      return {
        purchaseOrderNumber: raw["Purchase Order Number"]?.trim() || "",
        orderType: raw["Or Ty"]?.trim() || "",
        lineNumber: raw["Line Number"]?.trim() || "",
        itemNumber: raw["Item Number"]?.trim() || "",
        description: raw["Description"]?.trim() || "",
        quantityOpen: parseNumber(raw["Quantity Open"]),
        unitCost: parseNumber(raw["Unit Cost"]),
        requestDate: parseDate(raw["Request Date"]),
        promisedDelivery: parseDate(raw["Promised Delivery"]),
        customerPo: raw["Customer PO"]?.trim() || null,
        poOrderDate: parseDate(raw["PO Order Date"]),
        raw,
      };
    });

  return {
    attachment,
    filename: attachment.filename,
    metadataRows,
    header,
    rows,
  };
}

export async function enrichOpenOrderReport(
  report: OpenOrderReportParseResult
): Promise<OpenOrderReportResult> {
  const uniquePurchaseOrders = [...new Set(report.rows.map((row) => row.purchaseOrderNumber).filter(Boolean))];
  const datasets = new Map<string, SalesOrderDataset | null>();
  const unmatchedPurchaseOrders: string[] = [];

  for (const purchaseOrderNumber of uniquePurchaseOrders) {
    const matches = await findSalesOrdersByPO(purchaseOrderNumber, { maxBatches: 30, batchSize: 200 });
    if (matches.length === 0) {
      datasets.set(purchaseOrderNumber, null);
      unmatchedPurchaseOrders.push(purchaseOrderNumber);
      continue;
    }

    const salesOrder = matches.sort((a, b) => new Date(b.createdUtc).getTime() - new Date(a.createdUtc).getTime())[0];
    datasets.set(purchaseOrderNumber, await buildSalesOrderDataset(salesOrder));
  }

  const enrichedRows = report.rows.map((row) => {
    const dataset = datasets.get(row.purchaseOrderNumber) ?? null;
    if (!dataset) {
      return buildRowEnrichment(row, null, []);
    }

    const candidates = dataset.lines.filter(({ item }) =>
      matchesRowItem(row, item, dataset.salesOrder.customerId)
    );
    return buildRowEnrichment(row, dataset.salesOrder, candidates);
  });

  const outputHeader = [...report.header];
  if (!outputHeader.includes("Promise / Ship Date")) outputHeader.push("Promise / Ship Date");
  if (!outputHeader.includes("Tracking Number")) outputHeader.push("Tracking Number");

  const outputRows = [
    ...report.metadataRows,
    outputHeader,
    ...enrichedRows.map((entry) =>
      outputHeader.map((column) => {
        if (column === "Promise / Ship Date") return formatReportDate(entry.promiseOrShipDate);
        if (column === "Tracking Number") return entry.trackingNumber || "";
        return entry.row.raw[column] || "";
      })
    ),
  ];

  return {
    report,
    rows: enrichedRows,
    generatedCsv: serializeCsv(outputRows),
    attachmentFilename: report.filename,
    unmatchedPurchaseOrders,
    unmatchedRows: enrichedRows.filter((row) => row.warning).length,
  };
}
