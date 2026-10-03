import React, { useCallback, useEffect, useMemo } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Alert, Box, Button, Chip, Typography } from "@mui/material";
import {
  LoginRounded,
  StackedLineChartOutlined,
  ShieldOutlined,
} from "@mui/icons-material";
import { Panel } from "../ui/Primitives";
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
    <Box
      sx={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        p: 3,
        background:
          "radial-gradient(ellipse at 20% 30%, #7ce9bf08, transparent 60%)",
      }}
    >
      <Box
        sx={{
          width: "100%",
          maxWidth: 880,
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
          gap: 5,
          alignItems: "center",
        }}
      >
        <Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 5 }}>
            <StackedLineChartOutlined
              sx={{ color: "primary.main", fontSize: 35 }}
            />
            <Typography variant="h6">Kluster Arbitrage</Typography>
          </Box>
          <Chip
            label="PRIVATE OPERATOR WORKSPACE"
            variant="outlined"
            color="primary"
          />
          <Typography variant="h4" sx={{ mt: 3, mb: 2 }}>
            A clearer view of every opportunity.
          </Typography>
          <Typography color="text.secondary">
            Monitor the scanner, inspect exact routes and review each execution
            from one focused workspace.
          </Typography>
          <Box
            sx={{
              display: "flex",
              gap: 1,
              mt: 4,
              alignItems: "center",
              color: "text.secondary",
            }}
          >
            <ShieldOutlined sx={{ fontSize: 18 }} />
            <Typography variant="caption">
              Authenticated access · Ethereum · Private execution
            </Typography>
          </Box>
        </Box>
        <Panel>
          <Typography component="h1" variant="h5">
            Sign in to continue
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 1.5, mb: 3 }}
          >
            Authenticate with your operator account to open the trading
            workspace.
          </Typography>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error.message}
            </Alert>
          )}
          <Button
            fullWidth
            variant="contained"
            size="large"
            startIcon={<LoginRounded />}
            onClick={handleLogin}
            disabled={isLoading}
          >
            {isLoading ? "Loading…" : "Log in with Auth0"}
          </Button>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mt: 2.5 }}
          >
            Your role and trading readiness are checked independently.
          </Typography>
        </Panel>
      </Box>
    </Box>
  );
};

export default Login;
