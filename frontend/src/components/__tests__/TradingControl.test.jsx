import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import TradingControl from "../TradingControl";
import { API } from "../../services/api";
import { snapshot } from "../../testUtils/workspaceFixture";
jest.mock("../../services/api", () => ({
  API: { get: jest.fn(), post: jest.fn() },
}));
beforeEach(() => {
  jest.clearAllMocks();
  API.get.mockResolvedValue({ data: snapshot() });
  API.post.mockResolvedValue({ data: {} });
});
test("PAPER cannot enable GO LIVE without backend arming", async () => {
  render(<TradingControl />);
  await screen.findByText(/No trade signing or submission/);
  expect(screen.getByRole("button", { name: "GO LIVE" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Arm live trading" })
  ).toBeEnabled();
});
test("arming rejection remains visible and live submission stays disabled", async () => {
  API.post.mockRejectedValue({
    response: { data: { error: "Seven-day paper burn-in incomplete" } },
  });
  render(<TradingControl />);
  await screen.findByText(/No trade signing or submission/);
  fireEvent.click(screen.getByRole("button", { name: "Arm live trading" }));
  expect(
    await screen.findByText("Seven-day paper burn-in incomplete")
  ).toBeInTheDocument();
  expect(API.post).toHaveBeenCalledWith("/api/trading/arm");
  expect(screen.getByRole("button", { name: "GO LIVE" })).toBeDisabled();
});
test("live button requires a nonexpired armed backend snapshot", async () => {
  API.get.mockResolvedValue({ data: snapshot("LIVE_ARMED") });
  render(<TradingControl />);
  expect(await screen.findByText(/Armed for/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "GO LIVE" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "GO LIVE" }));
  await waitFor(() =>
    expect(API.post).toHaveBeenCalledWith("/api/trading/live")
  );
});
test("expired armed state cannot submit LIVE", async () => {
  const data = snapshot("LIVE_ARMED");
  data.trading.armedUntil = Date.now() - 1;
  API.get.mockResolvedValue({ data });
  render(<TradingControl />);
  await screen.findByText("LIVE_ARMED");
  expect(screen.getByRole("button", { name: "GO LIVE" })).toBeDisabled();
});
test("readiness inspection uses the read endpoint without changing trading mode", async () => {
  API.get.mockImplementation((url) =>
    Promise.resolve({
      data: url.endsWith("readiness")
        ? { ready: false, errors: ["Contract code hash mismatch"] }
        : snapshot(),
    })
  );
  render(<TradingControl />);
  await screen.findByText(/No trade signing or submission/);
  fireEvent.click(screen.getByRole("button", { name: "Live readiness" }));
  expect(
    await screen.findByText("Contract code hash mismatch")
  ).toBeInTheDocument();
  expect(API.post).not.toHaveBeenCalled();
});
