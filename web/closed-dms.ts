const KEY = "hivemind-closed-dms";

export function loadClosedDms(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function saveClosedDms(ids: string[]) {
  localStorage.setItem(KEY, JSON.stringify([...new Set(ids)]));
}
