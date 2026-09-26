// A split image is one user job: preserve both halves once either half started.
export function cancellableItems(batch) {
  const startedGroups = new Set(batch.items.filter(item => item.splitGroupId && ["running", "completed", "failed"].includes(item.status)).map(item => item.splitGroupId));
  return batch.items.filter(item => item.status === "queued" && !startedGroups.has(item.splitGroupId));
}

export function cancelQueuedItems(batches, now = Date.now()) {
  const changed = [];
  let cancelledCount = 0;
  for (const batch of batches) {
    const pending = cancellableItems(batch);
    if (!pending.length) continue;
    cancelledCount += new Set(pending.map(item => item.splitGroupId || item.id)).size;
    for (const item of pending) {
      item.status = "cancelled";
      item.phaseLabel = "시작 전 중단됨";
      item.progress = 0;
      item.error = null;
      item.buffer = null;
    }
    batch.updatedAt = now;
    changed.push(batch);
  }
  return { changed, cancelledCount };
}

export function batchCompletionStatus(items) {
  if (items.some(item => item.status === "running" || item.status === "queued")) return "running";
  if (items.some(item => item.status === "failed")) return "completed_with_errors";
  if (items.every(item => item.status === "cancelled")) return "cancelled";
  return items.some(item => item.status === "cancelled") ? "completed_with_cancellations" : "completed";
}
