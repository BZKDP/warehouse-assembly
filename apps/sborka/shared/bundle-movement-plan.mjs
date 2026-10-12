export function buildBundleMovementPlan(bundleQuantity, componentRows = []) {
  const multiplier = Math.max(1, Number(bundleQuantity || 1));
  const merged = new Map();
  for (const row of Array.isArray(componentRows) ? componentRows : []) {
    const productId = Number(row?.component_id ?? row?.productId ?? row?.id ?? 0);
    const componentQuantity = Number(row?.quantity || 0);
    if (!Number.isInteger(productId) || productId <= 0 || !Number.isFinite(componentQuantity) || componentQuantity <= 0) continue;
    const current = merged.get(productId) || {
      productId,
      article: row?.article || null,
      name: row?.name || null,
      quantity: 0,
    };
    current.quantity += componentQuantity * multiplier;
    merged.set(productId, current);
  }
  return [...merged.values()].sort((left, right) => left.productId - right.productId);
}
