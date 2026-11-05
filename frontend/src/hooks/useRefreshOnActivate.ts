import { useEffect, useRef } from "react";

/** Views stay mounted across nav switches (see App.tsx), so without this one would keep showing
 * whatever it last fetched - e.g. Work Orders still "waiting approval" after approving on Factory. */
export function useRefreshOnActivate(active: boolean, refresh: () => unknown) {
  const wasActive = useRef(active);
  const latestRefresh = useRef(refresh);

  useEffect(() => {
    latestRefresh.current = refresh;
  });

  useEffect(() => {
    if (active && !wasActive.current) latestRefresh.current();
    wasActive.current = active;
  }, [active]);
}
