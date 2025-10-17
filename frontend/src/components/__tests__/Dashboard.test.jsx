import { render, screen } from "@testing-library/react";
import Dashboard from "../Dashboard";
import { getMetrics } from "../../services/api";

jest.mock("../../services/api", () => ({
  getMetrics: jest.fn(),
}));

describe("Dashboard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders metrics returned from Prometheus without throwing", async () => {
    getMetrics.mockResolvedValue([
      { name: "avg_profit_dai", values: [{ value: "123.456" }] },
      { name: "avg_latency_ms", values: [{ value: "78.9" }] },
      { name: "arb_attempts_total", values: [{ value: "42" }] },
    ]);

    render(<Dashboard />);

    expect(await screen.findByText("123.46")).toBeTruthy();
    expect(await screen.findByText("79 ms")).toBeTruthy();
    expect(await screen.findByText("42")).toBeTruthy();
  });

  it("falls back to dash when metrics cannot be parsed", async () => {
    getMetrics.mockResolvedValue([
      { name: "avg_profit_dai", values: [{ value: "not-a-number" }] },
      { name: "avg_latency_ms", values: [{ value: null }] },
      { name: "arb_attempts_total", values: [{ value: "NaN" }] },
    ]);

    render(<Dashboard />);

    const hyphenValues = await screen.findAllByText("-");
    expect(hyphenValues).toHaveLength(3);
  });
});
