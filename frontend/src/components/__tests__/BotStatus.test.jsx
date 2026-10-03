import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BotStatus from "../BotStatus";
import { TradingStatusProvider } from "../../hooks/useTradingStatus";
import {
  API,
  getSettings,
  getBotStatus,
  getMetrics,
  updateSettings,
} from "../../services/api";
import { snapshot } from "../../testUtils/workspaceFixture";
jest.mock("../../services/api", () => ({
  API: { get: jest.fn() },
  getSettings: jest.fn(),
  getBotStatus: jest.fn(),
  getMetrics: jest.fn(),
  updateSettings: jest.fn(),
  stopBot: jest.fn(),
}));
const saved = {
  flashbotsDefault: false,
  pollingInterval: 60,
  gasPriceCeiling: 50,
  slippageBips: 30,
  minBorrowAmount: 1,
  simulationInputAmount: 1000,
  botActive: true,
};
beforeEach(() => {
  jest.clearAllMocks();
  API.get.mockResolvedValue({ data: snapshot() });
  getSettings.mockResolvedValue(saved);
  getBotStatus.mockResolvedValue({});
  getMetrics.mockResolvedValue([]);
  updateSettings.mockImplementation(async (values) => ({
    settings: { ...values, botActive: true },
  }));
});
test("settings use supported fields and preserve unrelated saved settings", async () => {
  render(
    <TradingStatusProvider>
      <BotStatus />
    </TradingStatusProvider>
  );
  const gas = await screen.findByLabelText("Gas price ceiling");
  fireEvent.change(gas, { target: { value: "70" } });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(updateSettings).toHaveBeenCalledWith({
      flashbotsDefault: false,
      pollingInterval: 60,
      gasPriceCeiling: 70,
      slippageBips: 30,
      minBorrowAmount: 1,
      simulationInputAmount: 1000,
    })
  );
  expect(
    await screen.findByText(
      "Settings saved. Configured production ceilings still apply."
    )
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Gas price ceiling")).toHaveValue(70);
});
test("missing service reports are displayed as unknown instead of healthy", async () => {
  render(
    <TradingStatusProvider>
      <BotStatus />
    </TradingStatusProvider>
  );
  await screen.findByLabelText("Gas price ceiling");
  expect(screen.getByText("Database: unknown")).toBeInTheDocument();
  expect(screen.getByText("ML service: unknown")).toBeInTheDocument();
});
