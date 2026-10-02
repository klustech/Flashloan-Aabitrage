import React from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Navigate, useLocation } from "react-router-dom";

const ProtectedRoute = ({ children, roles = [] }) => {
  const { isLoading, isAuthenticated, user } = useAuth0();
  const location = useLocation();

  const fromState = {
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
  };

  if (process.env.REACT_APP_PRIVATE_DASHBOARD === "true") return children;

  if (isLoading) return <div>Loading...</div>;
  if (!isAuthenticated)
    return <Navigate to="/login" replace state={{ from: fromState }} />;

  if (roles.length > 0) {
    const claimNS =
      process.env.REACT_APP_AUTH0_CLAIM_NAMESPACE ||
      "https://flashloan-arb.com/roles";
    const userRoles = user?.[claimNS] || [];
    const hasRole = roles.some((role) => userRoles.includes(role));
    if (!hasRole) return <Navigate to="/unauthorized" replace />;
  }

  return children;
};

export default ProtectedRoute;

