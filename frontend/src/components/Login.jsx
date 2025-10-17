import React, { useCallback, useEffect, useMemo } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { useLocation, useNavigate } from "react-router-dom";

const Login = () => {
  const { loginWithRedirect, isAuthenticated, isLoading, error } = useAuth0();
  const location = useLocation();
  const navigate = useNavigate();

  const returnTo = useMemo(() => {
    const fromState = location.state?.from;
    if (!fromState) return "/";
    const { pathname = "", search = "", hash = "" } = fromState;
    return `${pathname}${search}${hash}` || "/";
  }, [location.state]);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate(returnTo, { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate, returnTo]);

  const handleLogin = useCallback(() => {
    loginWithRedirect({ appState: { returnTo } });
  }, [loginWithRedirect, returnTo]);

  return (
    <div style={{ textAlign: "center", padding: "2rem" }}>
      <h1>Sign in to continue</h1>
      <p>You need to authenticate with Auth0 to access this page.</p>
      {error && (
        <p role="alert" style={{ color: "#ff6b6b" }}>
          {error.message}
        </p>
      )}
      <button type="button" onClick={handleLogin} disabled={isLoading}>
        {isLoading ? "Loading..." : "Log in with Auth0"}
      </button>
    </div>
  );
};

export default Login;
