import React, { useEffect } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import ProtectedRoute from "./components/ProtectedRoute";
import Dashboard from "./components/Dashboard";
import Login from "./components/Login";
import { Box, Button, Typography } from "@mui/material";
import { setAuthTokenProvider, setUnauthorizedHandler } from "./services/api";

function StatusPage({ title, description }) {
  return (
    <Box
      sx={{ minHeight: "100vh", display: "grid", placeItems: "center", p: 3 }}
    >
      <Box sx={{ textAlign: "center", maxWidth: 450 }}>
        <Typography variant="overline" color="primary">
          KLUSTER ARBITRAGE
        </Typography>
        <Typography component="h1" variant="h4" sx={{ mt: 2 }}>
          {title}
        </Typography>
        <Typography color="text.secondary" sx={{ my: 3 }}>
          {description}
        </Typography>
        <Button variant="outlined" href="/">
          Return to workspace
        </Button>
      </Box>
    </Box>
  );
}

function App() {
  const location = useLocation();
  const {
    getAccessTokenSilently,
    loginWithRedirect,
    isAuthenticated,
    isLoading,
  } = useAuth0();
  const audience = process.env.REACT_APP_AUTH0_AUDIENCE;
  const scope = process.env.REACT_APP_AUTH0_SCOPE || "openid profile email";

  useEffect(() => {
    if (typeof getAccessTokenSilently !== "function") {
      setAuthTokenProvider(null);
      return () => setAuthTokenProvider(null);
    }

    const provider = async () => {
      if (!isAuthenticated) return null;
      try {
        const params = audience
          ? { authorizationParams: { audience, scope } }
          : undefined;
        return await getAccessTokenSilently(params);
      } catch (error) {
        console.warn("getAccessTokenSilently failed", error);
        return null;
      }
    };

    setAuthTokenProvider(provider);
    return () => setAuthTokenProvider(null);
  }, [audience, getAccessTokenSilently, isAuthenticated, scope]);

  useEffect(() => {
    if (
      process.env.REACT_APP_PRIVATE_DASHBOARD === "true" ||
      typeof loginWithRedirect !== "function"
    ) {
      setUnauthorizedHandler(null);
      return () => setUnauthorizedHandler(null);
    }

    let redirecting = false;
    const handler = () => {
      if (redirecting || isLoading || location.pathname === "/login") {
        return;
      }
      redirecting = true;
      const returnTo = `${location.pathname}${location.search}${location.hash}`;
      loginWithRedirect({ appState: { returnTo } }).catch((err) => {
        console.error("Redirect to login failed", err);
        redirecting = false;
      });
    };

    setUnauthorizedHandler(handler);
    return () => setUnauthorizedHandler(null);
  }, [
    isLoading,
    location.hash,
    location.pathname,
    location.search,
    loginWithRedirect,
  ]);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute roles={["user", "admin"]}>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute roles={["user", "admin"]}>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin"
        element={
          <ProtectedRoute roles={["admin"]}>
            <Dashboard adminMode={true} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/unauthorized"
        element={
          <StatusPage
            title="Access restricted"
            description="Your account does not have permission to open this workspace."
          />
        }
      />
      <Route
        path="*"
        element={
          <StatusPage
            title="Page not found"
            description="This address is not part of the operator workspace."
          />
        }
      />
    </Routes>
  );
}

export default App;
