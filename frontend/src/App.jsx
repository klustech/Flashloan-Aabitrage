import React from "react";
import { Routes, Route } from "react-router-dom";
import ProtectedRoute from "./components/ProtectedRoute";
import Dashboard from "./components/Dashboard";
import Login from "./components/Login";

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
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
            <div>Admin Page (Admin only)</div>
          </ProtectedRoute>
        }
      />
      <Route path="/unauthorized" element={<div>Unauthorized</div>} />
      <Route path="*" element={<div>404 Not Found</div>} />
    </Routes>
  );
}

export default App;
