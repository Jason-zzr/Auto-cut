export async function trashSelection(projectId, entries) {
  const items = entries.map(({ tombstoneId, revision }) => ({ revision, tombstoneId }))
    .sort((a, b) => a.tombstoneId < b.tombstoneId ? -1 : a.tombstoneId > b.tombstoneId ? 1 : 0);
  const bytes = new TextEncoder().encode(`${JSON.stringify({ items, projectId })}\n`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return { items, digest: Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("") };
}
