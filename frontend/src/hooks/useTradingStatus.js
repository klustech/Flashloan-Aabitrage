import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { API } from "../services/api";
const Context = createContext(null);
const STATES = ["STOPPED", "PAPER", "LIVE_ARMED", "LIVE_RUNNING", "PAUSED"];
function usePollingStatus(enabled = true) {
  const [status, setStatus] = useState(null),
    [error, setError] = useState(""),
    [updatedAt, setUpdatedAt] = useState(0),
    [now, setNow] = useState(Date.now()),
    [loading, setLoading] = useState(true),
    [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false),
    inFlight = useRef(null);
  const refresh = useCallback((options) => {
    if (options?.afterCurrent && inFlight.current)
      return inFlight.current.then(() => refresh());
    if (inFlight.current) return inFlight.current;
    if (mounted.current) setRefreshing(true);
    inFlight.current = (async () => {
      try {
        const response = await Promise.resolve().then(() =>
          API.get("/api/trading")
        );
        if (!STATES.includes(response?.data?.trading?.state))
          throw new Error("Trading status unavailable");
        if (mounted.current) {
          setStatus(response.data);
          setUpdatedAt(Date.now());
          setNow(Date.now());
          setError("");
        }
        return response.data;
      } catch (e) {
        if (mounted.current)
          setError(
            e.response?.data?.error ||
              e.message ||
              "Unable to reach trading API"
          );
        return null;
      } finally {
        if (mounted.current) {
          setLoading(false);
          setRefreshing(false);
        }
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    mounted.current = true;
    refresh();
    const polling = setInterval(refresh, 15000),
      clock = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      mounted.current = false;
      clearInterval(polling);
      clearInterval(clock);
    };
  }, [enabled, refresh]);
  return {
    status,
    error,
    loading,
    refreshing,
    updatedAt,
    refresh,
    stale: Boolean(error) || !updatedAt || now - updatedAt > 45000,
  };
}
export function TradingStatusProvider({ children }) {
  const value = usePollingStatus();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useTradingStatus() {
  const shared = useContext(Context),
    local = usePollingStatus(!shared);
  return shared || local;
}
