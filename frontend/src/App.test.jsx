import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App.jsx";

jest.mock("axios", () => ({
  create: jest.fn(() => ({
    get: jest.fn(),
    post: jest.fn(),
  })),
  get: jest.fn(),
  post: jest.fn(),
  default: {},
}));

const mockLoginWithRedirect = jest.fn();

jest.mock("@auth0/auth0-react", () => ({
  useAuth0: jest.fn(),
}));

const { useAuth0 } = require("@auth0/auth0-react");

describe("App routing", () => {
  beforeEach(() => {
    mockLoginWithRedirect.mockClear();
  });

  it("directs unauthenticated users to the login experience", () => {
    useAuth0.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
      user: null,
      loginWithRedirect: mockLoginWithRedirect,
      error: null,
    });

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>
    );

    expect(
      screen.getByRole("heading", { name: /sign in to continue/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /log in with auth0/i })
    ).toBeInTheDocument();
    expect(screen.queryByText(/404 Not Found/i)).not.toBeInTheDocument();
  });
});
