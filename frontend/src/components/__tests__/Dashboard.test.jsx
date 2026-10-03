import {
  render,
  screen,
  within,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import Dashboard from "../Dashboard";
import {
  API,
  getMLStats,
  getSettings,
  getBotStatus,
  getMetrics,
} from "../../services/api";
import { snapshot } from "../../testUtils/workspaceFixture";
jest.mock("../../services/api", () => ({
  API: { get: jest.fn(), post: jest.fn() },
  getMLStats: jest.fn(),
  getSettings: jest.fn(),
  getBotStatus: jest.fn(),
  getMetrics: jest.fn(),
  updateSettings: jest.fn(),
  stopBot: jest.fn(),
  getOpportunities: jest.fn(),
  simulateArbitrage: jest.fn(),
}));
class Socket {
  close() {}
}
beforeEach(() => {
  jest.clearAllMocks();
  global.WebSocket = Socket;
  API.get.mockResolvedValue({ data: snapshot() });
  getMLStats.mockResolvedValue({ available: false });
  getSettings.mockResolvedValue({
    flashbotsDefault: false,
    pollingInterval: 60,
    gasPriceCeiling: 50,
    slippageBips: 30,
    minBorrowAmount: 1,
    simulationInputAmount: 1000,
    botActive: false,
  });
  getBotStatus.mockResolvedValue({});
  getMetrics.mockResolvedValue([]);
});
test("overview uses production accounting and excludes PAPER estimates from realized profit", async () => {
  render(<Dashboard />);
  expect(await screen.findByText("497.1")).toBeInTheDocument();
  expect(
    screen.getByText("Realized net profit").closest(".MuiPaper-root")
  ).toHaveTextContent("0DAI");
  expect(
    screen.getByText("PAPER simulations").closest(".MuiPaper-root")
  ).toHaveTextContent("1");
  expect(
    screen.getByText("Your realized history starts here")
  ).toBeInTheDocument();
  expect(
    screen.getAllByText("Cached pools")[0].closest(".MuiPaper-root")
  ).toHaveTextContent("77");
  expect(
    screen.getByText("Last scan latency").closest(".MuiPaper-root")
  ).toHaveTextContent("240");
});
test("navigation opens ledger, filters records and exposes token-precise details with unsigned bundle status", async () => {
  render(<Dashboard />);
  await screen.findByText("497.1");
  const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
  fireEvent.click(within(nav).getByRole("button", { name: "Executions" }));
  fireEvent.click(
    screen.getByRole("button", { name: "View execution paper-one" })
  );
  expect(await screen.findByText("Trade details")).toBeInTheDocument();
  expect(screen.getByText("Unsigned PAPER — not run")).toBeInTheDocument();
  expect(
    screen.getByText("Flash-loan premium").parentElement
  ).toHaveTextContent("0.9");
  fireEvent.click(screen.getByRole("button", { name: "Close trade details" }));
  fireEvent.change(screen.getByLabelText("Search executions"), {
    target: { value: "no match" },
  });
  expect(screen.getByText("No matching executions")).toBeInTheDocument();
});
test("all workspace pages remain reachable and optional ML absence has an honest empty state", async () => {
  render(<Dashboard />);
  await screen.findByText("497.1");
  const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
  fireEvent.click(within(nav).getByRole("button", { name: "Route explorer" }));
  expect(await screen.findByText("Production routes")).toBeInTheDocument();
  fireEvent.click(within(nav).getByRole("button", { name: "Opportunities" }));
  expect(screen.getByText("Production opportunities")).toBeInTheDocument();
  fireEvent.click(within(nav).getByRole("button", { name: "Simulator" }));
  expect(screen.getByText("Build a route to get started")).toBeInTheDocument();
  fireEvent.click(within(nav).getByRole("button", { name: "ML analytics" }));
  expect(await screen.findByText("No model results yet")).toBeInTheDocument();
  fireEvent.click(
    within(nav).getByRole("button", { name: "System & settings" })
  );
  expect(await screen.findByLabelText("Gas price ceiling")).toHaveValue(50);
});
test("shared dashboard status polling is not duplicated by mounted production panels", async () => {
  render(<Dashboard />);
  await screen.findByText("497.1");
  await waitFor(() => expect(API.get).toHaveBeenCalledTimes(1));
  expect(API.get).toHaveBeenCalledWith("/api/trading");
});
test("failed initial connection never displays invented balances or enables live controls", async () => {
  API.get.mockRejectedValue(new Error("API offline"));
  render(<Dashboard />);
  expect(await screen.findByText("API offline")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "PAPER" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "GO LIVE" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Emergency pause" })).toBeEnabled();
  expect(
    screen.getByText("Realized net profit").closest(".MuiPaper-root")
  ).toHaveTextContent("—");
});
test("six-decimal settled accounting stays in its token and chart excludes PAPER records", async () => {
  const state = snapshot();
  const address = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  state.summary.tokens = {
    [address]: {
      borrowToken: address,
      token: { symbol: "USDC", decimals: 6 },
      realizedNet: "-1250000",
    },
  };
  state.executions = [
    {
      ...state.executions[0],
      id: "live-six",
      borrowToken: address,
      token: { symbol: "USDC", decimals: 6 },
      mode: "LIVE",
      status: "REVERTED",
      realizedNetProfit: "-1250000",
      actualGasCostNative: "5000000000000000",
      economics: { expectedNetProfit: "2500000" },
    },
    ...state.executions,
  ];
  API.get.mockResolvedValue({ data: state });
  render(<Dashboard />);
  expect(
    await screen.findByRole("img", {
      name: "Cumulative realized net profit −1.25 USDC",
    })
  ).toBeInTheDocument();
  const metric = screen
    .getByText("Realized net profit")
    .closest(".MuiPaper-root");
  expect(metric).toHaveTextContent("−1.25USDC");
  expect(metric).not.toHaveTextContent("DAI");
  expect(screen.getByText("1 settled")).toBeInTheDocument();
});
