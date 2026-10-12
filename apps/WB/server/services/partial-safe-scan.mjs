function nonNegativeInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function itemQuantity(item) {
  return nonNegativeInteger(item?.quantity ?? item?.requiredQty ?? item?.required_qty);
}

function itemScannedQuantity(item) {
  return nonNegativeInteger(item?.scannedQty ?? item?.scanned_qty ?? item?.pickedQty ?? item?.picked_qty);
}

export function getPartialSafeOrderState(items, isBundle) {
  const rows = Array.isArray(items) ? items : [];
  const bundleItems = [];
  const individualItems = [];
  let pendingBundleUnits = 0;
  let pendingIndividualUnits = 0;

  for (const item of rows) {
    const quantity = itemQuantity(item);
    const scannedQuantity = Math.min(quantity, itemScannedQuantity(item));
    const remaining = Math.max(0, quantity - scannedQuantity);
    const entry = { item, quantity, scannedQuantity, remaining };
    if (isBundle(item)) {
      bundleItems.push(entry);
      pendingBundleUnits += remaining;
    } else {
      individualItems.push(entry);
      pendingIndividualUnits += remaining;
    }
  }

  return {
    hasBundle: bundleItems.length > 0,
    bundleItems,
    individualItems,
    pendingBundleUnits,
    pendingIndividualUnits,
    // At the order-packing stage one bundle makes the whole order manual.
    // The marketplace order label is still verified separately.
    canManualComplete: bundleItems.length > 0,
  };
}
