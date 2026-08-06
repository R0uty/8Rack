import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "8rack:bookmarked-executions";

function loadBookmarks(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

/** Bookmarking an execution is a personal UI preference, not project data — persisted to
 * localStorage (like Settings/theme), not the backend, so it stays put across a reload without
 * needing any server-side changes. */
export function useBookmarks() {
  const [bookmarked, setBookmarked] = useState<Set<string>>(loadBookmarks);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...bookmarked]));
  }, [bookmarked]);

  const toggle = useCallback((id: string) => {
    setBookmarked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isBookmarked = useCallback((id: string) => bookmarked.has(id), [bookmarked]);

  return { bookmarked, toggle, isBookmarked };
}
