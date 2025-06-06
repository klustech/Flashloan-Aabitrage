import React from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Navigate } from "react-router-dom";

const ProtectedRoute = ({ children, roles = [] }) => {
  const { isLoading, isAuthenticated, user } = useAuth0();

  if (isLoading) return <div>Loading...</div>;
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (roles.length > 0) {
    const userRoles = user?.["https://example.com/roles"] || [];
    const hasRole = roles.some((role) => userRoles.includes(role));
    if (!hasRole) return <Navigate to="/unauthorized" replace />;
  }

  return children;
};

export default ProtectedRoute;
