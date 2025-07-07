// frontend/src/index.jsx

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { Auth0Provider } from "@auth0/auth0-react";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import "./index.css";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#FFD700" },
    background: { default: "#000", paper: "#111" },
  },
});

const container = document.getElementById("root");
const root = createRoot(container);

root.render(
  <Auth0Provider
    domain={process.env.REACT_APP_AUTH0_DOMAIN}
    clientId={process.env.REACT_APP_AUTH0_CLIENT_ID}
    authorizationParams={{ redirect_uri: window.location.origin }}
    audience={process.env.REACT_APP_AUTH0_AUDIENCE}
    scope="openid profile email"
  >
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </Auth0Provider>
);
