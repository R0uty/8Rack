import { useCallback, useEffect, useRef, useState } from "react";

const BASE_TITLE = "8Rack";
const NOTIFY_KEY = "8rack.notifyOnAttention";

function readNotifyPref(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Runs take minutes, so the tab title carries how many items need a human ("(2) 8Rack"), and -
 * once the user opts in - a browser notification fires when that number goes up while the tab is in
 * the background.
 */
export function useAttentionAlerts(count: number, missionName: string | undefined) {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [enabled, setEnabled] = useState(() => supported && readNotifyPref() && Notification.permission === "granted");
  const previous = useRef(count);

  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  }, [count]);
  useEffect(() => () => void (document.title = BASE_TITLE), []);

  useEffect(() => {
    const grew = count > previous.current;
    previous.current = count;
    if (!grew || !enabled || !document.hidden) return;
    try {
      new Notification("8Rack needs you", {
        body: `${missionName ?? "A mission"}: ${count} item${count === 1 ? "" : "s"} waiting on you.`,
        tag: "8rack-attention",
      });
    } catch {
      // Some browsers only allow notifications from a service worker - the title still shows it.
    }
  }, [count, enabled, missionName]);

  const toggle = useCallback(async () => {
    if (!supported) return;
    const next = !enabled && (Notification.permission === "granted" || (await Notification.requestPermission()) === "granted");
    setEnabled(next);
    try {
      localStorage.setItem(NOTIFY_KEY, next ? "1" : "0");
    } catch {
      // Remembering the choice is a convenience only.
    }
  }, [enabled, supported]);

  return { supported, enabled, toggle };
}
