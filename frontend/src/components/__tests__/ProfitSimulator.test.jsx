import { render, screen, fireEvent } from "@testing-library/react";
import ProfitSimulator from "../ProfitSimulator";
import { simulateArbitrage } from "../../services/api";
jest.mock("../../services/api", () => ({ simulateArbitrage: jest.fn() }));
test("manual scenarios remain clearly illustrative and use valid token addresses", async () => {
  simulateArbitrage.mockResolvedValue({
    illustrative: true,
    executable: false,
    simulation: {
      borrowAmount: 1000,
      borrowToken: "DAI",
      expectedReturn: 990,
      netProfit: "-20",
      gasCost: "0.001",
      grossProfit: -10,
      hops: [],
    },
  });
  render(<ProfitSimulator />);
  fireEvent.click(
    screen.getByRole("button", { name: "Run illustrative simulation" })
  );
  expect(
    await screen.findByText("ILLUSTRATIVE · NOT EXECUTABLE")
  ).toBeInTheDocument();
  const payload = simulateArbitrage.mock.calls[0][0];
  expect(payload.route[0].tokenInAddress).toBe(
    "0x6B175474E89094C44Da98b954EedeAC495271d0F"
  );
  expect(payload.route[1].tokenOut).toBe("DAI");
  fireEvent.change(screen.getByLabelText("Borrow amount"), {
    target: { value: "500" },
  });
  expect(
    screen.getByText("Inputs changed. Run again to update these results.")
  ).toBeInTheDocument();
});
test("invalid amounts never request a manual simulation", () => {
  simulateArbitrage.mockClear();
  render(<ProfitSimulator />);
  fireEvent.change(screen.getByLabelText("Borrow amount"), {
    target: { value: "0" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Run illustrative simulation" })
  );
  expect(
    screen.getByText("Enter a positive borrow amount.")
  ).toBeInTheDocument();
  expect(simulateArbitrage).not.toHaveBeenCalled();
});
