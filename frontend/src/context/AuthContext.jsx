/**
 * Authentication Context for Flash Loan Arbitrage Dashboard
 * Supports both Auth0 and simple API key authentication
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { setAuthTokenProvider, setUnauthorizedHandler } from "../services/api";

// Check if Auth0 is configured
const AUTH0_DOMAIN = process.env.REACT_APP_AUTH0_DOMAIN;
const AUTH0_CLIENT_ID = process.env.REACT_APP_AUTH0_CLIENT_ID;
const AUTH0_AUDIENCE = process.env.REACT_APP_AUTH0_AUDIENCE;
const AUTH0_ENABLED = AUTH0_DOMAIN && AUTH0_CLIENT_ID;

// Auth0 dynamic import (only if configured)
let useAuth0 = null;
if (AUTH0_ENABLED) {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const auth0Module = require("@auth0/auth0-react");
    useAuth0 = auth0Module.useAuth0;
  } catch (e) {
    console.warn("Auth0 SDK not installed. Using API key authentication.");
  }
}

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

/**
 * Auth0 Authentication Provider
 */
const Auth0AuthProvider = ({ children }) => {
  const {
    isAuthenticated,
    isLoading,
    user,
    loginWithRedirect,
    logout,
    getAccessTokenSilently,
    error,
  } = useAuth0();

  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setInitialized(true);
    }
  }, [isLoading]);

  // Set up API token provider
  useEffect(() => {
    if (isAuthenticated) {
      setAuthTokenProvider(async () => {
        try {
          return await getAccessTokenSilently({
            audience: AUTH0_AUDIENCE,
          });
        } catch (err) {
          console.error("Failed to get access token:", err);
          return null;
        }
      });
    } else {
      setAuthTokenProvider(null);
    }
  }, [isAuthenticated, getAccessTokenSilently]);

  // Handle unauthorized responses
  useEffect(() => {
    setUnauthorizedHandler((error) => {
      console.warn("Unauthorized request:", error);
      // Optionally redirect to login
      if (isAuthenticated) {
        // Token may have expired, try to refresh
        getAccessTokenSilently().catch(() => {
          loginWithRedirect();
        });
      }
    });
  }, [isAuthenticated, getAccessTokenSilently, loginWithRedirect]);

  const handleLogin = useCallback(() => {
    loginWithRedirect({
      appState: { returnTo: window.location.pathname },
    });
  }, [loginWithRedirect]);

  const handleLogout = useCallback(() => {
    setAuthTokenProvider(null);
    logout({
      returnTo: window.location.origin,
    });
  }, [logout]);

  const value = {
    isAuthenticated,
    isLoading: !initialized || isLoading,
    user,
    error,
    login: handleLogin,
    logout: handleLogout,
    getToken: getAccessTokenSilently,
    authMethod: "auth0",
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/**
 * API Key Authentication Provider (fallback when Auth0 is not configured)
 */
const ApiKeyAuthProvider = ({ children }) => {
  const [apiKey, setApiKey] = useState(() => {
    return localStorage.getItem("arb_api_key") || process.env.REACT_APP_API_KEY || "";
  });
  const [isAuthenticated, setIsAuthenticated] = useState(!!apiKey);

  useEffect(() => {
    if (apiKey) {
      localStorage.setItem("arb_api_key", apiKey);
      setIsAuthenticated(true);
    } else {
      localStorage.removeItem("arb_api_key");
      setIsAuthenticated(false);
    }
  }, [apiKey]);

  // Handle unauthorized responses
  useEffect(() => {
    setUnauthorizedHandler((error) => {
      console.warn("Unauthorized request:", error);
      // Clear stored API key on 401
      setApiKey("");
      setIsAuthenticated(false);
    });
  }, []);

  const login = useCallback((key) => {
    setApiKey(key);
  }, []);

  const logout = useCallback(() => {
    setApiKey("");
    setIsAuthenticated(false);
  }, []);

  const getToken = useCallback(async () => {
    return apiKey;
  }, [apiKey]);

  const value = {
    isAuthenticated,
    isLoading: false,
    user: isAuthenticated ? { email: "api-user" } : null,
    error: null,
    login,
    logout,
    getToken,
    apiKey,
    setApiKey,
    authMethod: "api_key",
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/**
 * Main Auth Provider - automatically selects based on configuration
 */
export const AuthProvider = ({ children }) => {
  if (AUTH0_ENABLED && useAuth0) {
    return <Auth0AuthProvider>{children}</Auth0AuthProvider>;
  }
  return <ApiKeyAuthProvider>{children}</ApiKeyAuthProvider>;
};

/**
 * HOC for protecting routes
 */
export const withAuth = (Component) => {
  return function AuthenticatedComponent(props) {
    const { isAuthenticated, isLoading, login } = useAuth();

    if (isLoading) {
      return (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
          Loading...
        </div>
      );
    }

    if (!isAuthenticated) {
      return (
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", height: "100vh" }}>
          <h2>Authentication Required</h2>
          <p>Please log in to access the dashboard.</p>
          <button onClick={login} style={{ padding: "10px 20px", fontSize: "16px" }}>
            Login
          </button>
        </div>
      );
    }

    return <Component {...props} />;
  };
};

/**
 * Login Form Component for API Key authentication
 */
export const ApiKeyLoginForm = ({ onSuccess }) => {
  const { login, authMethod } = useAuth();
  const [inputKey, setInputKey] = useState("");
  const [error, setError] = useState("");

  if (authMethod !== "api_key") {
    return null;
  }

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!inputKey.trim()) {
      setError("API key is required");
      return;
    }
    login(inputKey.trim());
    if (onSuccess) onSuccess();
  };

  return (
    <form onSubmit={handleSubmit}>
      <div style={{ marginBottom: "10px" }}>
        <label htmlFor="apiKey" style={{ display: "block", marginBottom: "5px" }}>
          API Key
        </label>
        <input
          id="apiKey"
          type="password"
          value={inputKey}
          onChange={(e) => setInputKey(e.target.value)}
          placeholder="Enter your API key"
          style={{ width: "100%", padding: "8px", fontSize: "14px" }}
        />
      </div>
      {error && (
        <div style={{ color: "red", marginBottom: "10px" }}>{error}</div>
      )}
      <button type="submit" style={{ padding: "10px 20px", fontSize: "14px" }}>
        Authenticate
      </button>
    </form>
  );
};

export default AuthProvider;
